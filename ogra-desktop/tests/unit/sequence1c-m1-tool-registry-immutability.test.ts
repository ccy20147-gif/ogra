import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { OgraCore } from '../../src/core';
import { OgraSecretBroker } from '../../src/core/secret-broker';
import { OgraErrorCode } from '../../src/shared/errors';
import { canonicalJSON } from '../../src/core/audit-envelope';
import { UpsertToolVersionInput } from '../../src/core/tool-registry';
import { canonicalToolIdFor } from '../../src/core/tool-broker-types';

function tmpDir(): string {
  return path.join(os.tmpdir(), `s1c-registry-${crypto.randomBytes(5).toString('hex')}`);
}

function descriptor(overrides: Partial<UpsertToolVersionInput> = {}): UpsertToolVersionInput {
  return {
    sourceKind: 'builtin',
    sourceRef: 'core:registry-test',
    logicalName: 'registry.test',
    owner: 'ogra-core',
    sourceVersion: '1.0.0',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    effectClass: 'read_only',
    permissions: { filesystem: false },
    recoveryCapabilities: { queryOutcome: false },
    provenance: { reviewed: true },
    transport: 'in_process',
    riskTier: 'low',
    ...overrides,
  };
}

describe('Sequence 1C M1 - ToolRegistry immutable contracts', () => {
  let core: OgraCore;
  let dir: string;
  let workspaceId: string;

  beforeEach(async () => {
    dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    core = new OgraCore({
      appDataDir: dir,
      secretBroker: new OgraSecretBroker(dir),
      isDev: true,
    });
    await core.initialize();
    workspaceId = `ws_${crypto.randomBytes(5).toString('hex')}`;
    const now = new Date().toISOString();
    core.databaseService.getRawDB().prepare(`
      INSERT INTO workspaces
        (id, name, type, default_data_classification, created_at, updated_at, workspace_tag)
      VALUES (?, 'registry test', 'personal', 'Internal', ?, ?, ?)
    `).run(workspaceId, now, now, crypto.randomBytes(16).toString('hex'));
  });

  afterEach(() => {
    core?.databaseService.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('only treats byte-equivalent contracts as an idempotent source-version retry', async () => {
    const first = await core.toolRegistry.upsertToolVersion(descriptor());
    const retry = await core.toolRegistry.upsertToolVersion(descriptor({
      inputSchema: { properties: { query: { type: 'string' } }, type: 'object' },
    }));
    expect(retry.toolVersionId).toBe(first.toolVersionId);

    await expect(core.toolRegistry.upsertToolVersion(descriptor({
      inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 20 } } },
    }))).rejects.toMatchObject({ code: OgraErrorCode.TOOL_VERSION_IMMUTABLE_CONFLICT });
    await expect(core.toolRegistry.upsertToolVersion(descriptor({
      transport: 'isolated_worker',
    }))).rejects.toMatchObject({ code: OgraErrorCode.TOOL_VERSION_IMMUTABLE_CONFLICT });

    const count = core.databaseService.getRawDB().prepare(
      'SELECT COUNT(*) AS count FROM tool_versions WHERE descriptor_id = ?',
    ).get(first.descriptorId) as { count: number };
    expect(count.count).toBe(1);
  });

  it('rejects ambiguous source identities and owner replacement for a descriptor', async () => {
    await expect(core.toolRegistry.upsertToolVersion(descriptor({ sourceVersion: ' 1.0.0' })))
      .rejects.toMatchObject({ code: OgraErrorCode.INVALID_ARGUMENT });

    await core.toolRegistry.upsertToolVersion(descriptor());
    await expect(core.toolRegistry.upsertToolVersion(descriptor({ owner: 'attacker' })))
      .rejects.toMatchObject({ code: OgraErrorCode.TOOL_DESCRIPTOR_IMMUTABLE_CONFLICT });
  });

  it('rejects unsupported schema dialect features before they become an enabled version', async () => {
    await expect(core.toolRegistry.upsertToolVersion(descriptor({
      sourceVersion: 'schema-ref',
      inputSchema: { type: 'object', properties: {}, $ref: 'https://attacker.invalid/schema' },
    }))).rejects.toMatchObject({ code: OgraErrorCode.INVALID_ARGUMENT });
    await expect(core.toolRegistry.upsertToolVersion(descriptor({
      sourceVersion: 'schema-unsafe-regex',
      inputSchema: {
        type: 'object', properties: {
          query: { type: 'string', pattern: '^(a+)+$' },
        },
      },
    }))).rejects.toMatchObject({ code: OgraErrorCode.INVALID_ARGUMENT });
    await expect(core.toolRegistry.upsertToolVersion(descriptor({
      sourceVersion: 'schema-unimplemented-input',
      inputSchema: { type: 'object', properties: { enabled: { type: 'boolean' } } },
    }))).rejects.toMatchObject({ code: OgraErrorCode.INVALID_ARGUMENT });
    await expect(core.toolRegistry.upsertToolVersion(descriptor({
      sourceVersion: 'schema-combinator',
      inputSchema: {
        type: 'object', properties: {
          query: { type: 'string', oneOf: [{ type: 'string' }] },
        },
      },
    }))).rejects.toMatchObject({ code: OgraErrorCode.INVALID_ARGUMENT });
    const count = core.databaseService.getRawDB().prepare(
      'SELECT COUNT(*) AS count FROM tool_versions',
    ).get() as { count: number };
    expect(count.count).toBe(0);
  });

  it('does not regress latest_version_id when an older immutable version is retried', async () => {
    const v1 = await core.toolRegistry.upsertToolVersion(descriptor({ sourceVersion: '1.0.0' }));
    const v2 = await core.toolRegistry.upsertToolVersion(descriptor({ sourceVersion: '2.0.0' }));
    const beforeRetry = core.databaseService.getRawDB().prepare(
      'SELECT latest_version_id FROM tool_descriptors WHERE id = ?',
    ).get(v1.descriptorId) as { latest_version_id: string };
    expect(beforeRetry.latest_version_id).toBe(v2.toolVersionId);

    await core.toolRegistry.upsertToolVersion(descriptor({ sourceVersion: '1.0.0' }));
    const afterRetry = core.databaseService.getRawDB().prepare(
      'SELECT latest_version_id FROM tool_descriptors WHERE id = ?',
    ).get(v1.descriptorId) as { latest_version_id: string };
    expect(afterRetry.latest_version_id).toBe(v2.toolVersionId);
  });

  it('covers policyId in the binding hash and never rewrites a concrete binding', async () => {
    const version = await core.toolRegistry.upsertToolVersion(descriptor());
    const first = core.toolRegistry.bindWorkspaceVersion({
      workspaceId,
      toolVersionId: version.toolVersionId,
      approvalMode: 'none',
      policyId: 'policy_a',
      constraints: { maxResults: 5 },
      bindingId: 'bind_v1',
      logicalBindingId: 'knowledge-search',
    });
    const expectedHash = crypto.createHash('sha256').update(canonicalJSON({
      workspaceId,
      toolVersionId: version.toolVersionId,
      policyId: 'policy_a',
      approvalMode: 'none',
      constraints: { maxResults: 5 },
    })).digest('hex');
    expect(first.bindingHash).toBe(expectedHash);

    expect(() => core.toolRegistry.bindWorkspaceVersion({
      workspaceId,
      toolVersionId: version.toolVersionId,
      approvalMode: 'none',
      policyId: 'policy_b',
      constraints: { maxResults: 5 },
      bindingId: 'bind_v1',
      logicalBindingId: 'knowledge-search',
    })).toThrow(`[${OgraErrorCode.TOOL_BINDING_IMMUTABLE_CONFLICT}]`);

    const second = core.toolRegistry.bindWorkspaceVersion({
      workspaceId,
      toolVersionId: version.toolVersionId,
      approvalMode: 'none',
      policyId: 'policy_b',
      constraints: { maxResults: 5 },
      bindingId: 'bind_v2',
      logicalBindingId: 'knowledge-search',
    });
    expect(second.id).toBe('bind_v2');
    const rows = core.databaseService.getRawDB().prepare(`
      SELECT id, parent_binding_id, revision, binding_hash_version, policy_id
        FROM workspace_tool_bindings
       WHERE workspace_id = ? AND logical_binding_id = ?
       ORDER BY revision
    `).all(workspaceId, 'knowledge-search') as Array<{
      id: string; parent_binding_id: string | null; revision: number;
      binding_hash_version: number; policy_id: string | null;
    }>;
    expect(rows).toEqual([
      { id: 'bind_v1', parent_binding_id: null, revision: 1, binding_hash_version: 2, policy_id: 'policy_a' },
      { id: 'bind_v2', parent_binding_id: 'bind_v1', revision: 2, binding_hash_version: 2, policy_id: 'policy_b' },
    ]);
  });

  it('keeps legacy policy-unbound hashes inspectable but ineligible until a v2 revision exists', async () => {
    const version = await core.toolRegistry.upsertToolVersion(descriptor({ sourceVersion: '2.0.0' }));
    core.toolRegistry.setVersionStatus(version.toolVersionId, 'enabled');
    core.databaseService.getRawDB().prepare(`
      INSERT INTO workspace_tool_bindings
        (id, logical_binding_id, workspace_id, tool_version_id, revision,
         binding_hash, binding_hash_version, enabled, policy_id,
         approval_mode, constraints_json, created_at, updated_at)
      VALUES ('legacy_binding', 'knowledge-search', ?, ?, 1,
              'legacy-hash-without-policy', 1, 1, 'policy_a',
              'none', '{"maxResults":5}', datetime('now'), datetime('now'))
    `).run(workspaceId, version.toolVersionId);
    expect(core.toolRegistry.resolveEnabledBinding({
      workspaceId, toolVersionId: version.toolVersionId,
    })).toBeNull();

    const current = core.toolRegistry.bindWorkspaceVersion({
      workspaceId,
      toolVersionId: version.toolVersionId,
      approvalMode: 'none',
      policyId: 'policy_a',
      constraints: { maxResults: 5 },
      bindingId: 'current_binding',
      logicalBindingId: 'knowledge-search',
    });
    expect(current.id).toBe('current_binding');
    expect(core.toolRegistry.resolveEnabledBinding({
      workspaceId, toolVersionId: version.toolVersionId,
    })?.binding.id).toBe('current_binding');
    const legacy = core.databaseService.getRawDB().prepare(`
      SELECT binding_hash, binding_hash_version FROM workspace_tool_bindings
       WHERE id = 'legacy_binding'
    `).get() as { binding_hash: string; binding_hash_version: number };
    expect(legacy).toEqual({ binding_hash: 'legacy-hash-without-policy', binding_hash_version: 1 });
  });

  it('fails closed instead of selecting an unspecified enabled binding for one workspace/version', async () => {
    const version = await core.toolRegistry.upsertToolVersion(descriptor({ sourceVersion: '3.0.0' }));
    core.toolRegistry.setVersionStatus(version.toolVersionId, 'enabled');
    core.toolRegistry.bindWorkspaceVersion({
      workspaceId, toolVersionId: version.toolVersionId,
      approvalMode: 'none', constraints: { maxResults: 5 },
      bindingId: 'ambiguous_a', logicalBindingId: 'binding-a',
    });
    core.toolRegistry.bindWorkspaceVersion({
      workspaceId, toolVersionId: version.toolVersionId,
      approvalMode: 'none', constraints: { maxResults: 10 },
      bindingId: 'ambiguous_b', logicalBindingId: 'binding-b',
    });

    expect(core.toolRegistry.resolveEnabledBinding({
      workspaceId, toolVersionId: version.toolVersionId,
    })).toBeNull();
    const tuple = core.toolRegistry.getDescriptorAndVersion(version.toolVersionId)!;
    expect(core.toolRegistry.resolveEnabledBindingForCanonicalToolId({
      workspaceId,
      toolId: canonicalToolIdFor(tuple.descriptor, tuple.version),
    })).toBeNull();
  });
});
