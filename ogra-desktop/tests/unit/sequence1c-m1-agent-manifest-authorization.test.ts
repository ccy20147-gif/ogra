/** Sequence 1C M1 — Core-owned agent manifest authorization. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { OgraCore } from '../../src/core';
import { OgraSecretBroker } from '../../src/core/secret-broker';
import { OgraErrorCode } from '../../src/shared/errors';
import { buildInternalAgentManifest } from '../../src/core/agent-manifest-authorization';

interface Fixture {
  dir: string;
  core: OgraCore;
  workspaceA: string;
  workspaceB: string;
  toolId: string;
  cleanup: () => void;
}

function now(): string { return new Date().toISOString(); }

async function wireFixture(): Promise<Fixture> {
  const dir = path.join(os.tmpdir(), `s1c-manifest-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(dir, { recursive: true });
  const core = new OgraCore({ appDataDir: dir, secretBroker: new OgraSecretBroker(dir), isDev: true });
  await core.initialize();
  const db = core.databaseService.getRawDB();
  const workspaceA = `ws_a_${crypto.randomBytes(4).toString('hex')}`;
  const workspaceB = `ws_b_${crypto.randomBytes(4).toString('hex')}`;
  let toolId: string | undefined;
  for (const workspaceId of [workspaceA, workspaceB]) {
    db.prepare(`
      INSERT INTO workspaces (id, name, type, default_data_classification, created_at, updated_at, workspace_tag)
      VALUES (?, 'manifest test', 'personal', 'Internal', ?, ?, hex(randomblob(16)))
    `).run(workspaceId, now(), now());
    const kbId = `kb_${crypto.randomBytes(4).toString('hex')}`;
    db.prepare(`
      INSERT INTO knowledge_bases (id, workspace_id, name, root_path, classification, indexing_status, created_at, updated_at)
      VALUES (?, ?, 'manifest kb', '/tmp/manifest-kb', 'Internal', 'succeeded', ?, ?)
    `).run(kbId, workspaceId, now(), now());
    const seeded = await core.ensureKnowledgeSearchBinding(workspaceId, {
      enabledKnowledgeBaseIds: [kbId], approvalMode: 'none',
    });
    if (workspaceId === workspaceA) toolId = seeded.toolId;
  }
  if (!toolId) throw new Error('fixture did not seed workspace A');
  return {
    dir, core, workspaceA, workspaceB, toolId,
    cleanup: () => {
      try { core.shutdown(); } catch {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

function createRun(fx: Fixture, workspaceId = fx.workspaceA, viaCore = true): {
  runId: string; frameId: string;
} {
  const runId = `run_${crypto.randomBytes(4).toString('hex')}`;
  if (viaCore) {
    fx.core.databaseService.storeRun({
      id: runId, workspaceId, task: 'manifest authorization', status: 'created', startedAt: now(),
    });
  } else {
    fx.core.databaseService.getRawDB().prepare(`
      INSERT INTO agent_runs (id, workspace_id, task, status, started_at)
      VALUES (?, ?, 'manifest authorization', 'created', ?)
    `).run(runId, workspaceId, now());
  }
  const root = fx.core.durableRuntime.createRootFrame({ runId });
  const child = fx.core.durableRuntime.createChildFrame({
    runId, parentFrameId: root.id, frameKind: 'plan_step',
  });
  return { runId, frameId: child.id };
}

describe('Sequence 1C M1 — manifest authorization fails closed', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await wireFixture(); });
  afterEach(() => { fx?.cleanup(); });

  async function expectPrepareDenied(runId: string, frameId: string): Promise<void> {
    await expect(fx.core.capabilityGateway.prepareInvocation({
      runId, workspaceId: fx.workspaceA, ownerFrameId: frameId,
      toolId: fx.toolId, arguments: { query: 'authorization gate' },
    })).rejects.toMatchObject({ code: OgraErrorCode.PERMISSION_DENIED });
    const db = fx.core.databaseService.getRawDB();
    expect((db.prepare('SELECT COUNT(*) AS count FROM run_effects WHERE run_id = ?')
      .get(runId) as { count: number }).count).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS count FROM recovery_leases WHERE run_id = ?')
      .get(runId) as { count: number }).count).toBe(0);
  }

  it('denies a legacy run with no manifest before it creates an effect or lease', async () => {
    const run = createRun(fx, fx.workspaceA, false);
    await expectPrepareDenied(run.runId, run.frameId);
  });

  it('denies an empty manifest even when its snapshot hash is internally consistent', async () => {
    const run = createRun(fx);
    const manifest = '{}';
    const digest = crypto.createHash('sha256').update(manifest).digest('hex');
    fx.core.databaseService.getRawDB().prepare(`
      UPDATE agent_runs SET agent_manifest_json = ?, agent_manifest_hash = ? WHERE id = ?
    `).run(manifest, digest, run.runId);
    await expectPrepareDenied(run.runId, run.frameId);
  });

  it('denies a manifest snapshot whose hash has been tampered', async () => {
    const run = createRun(fx);
    fx.core.databaseService.getRawDB().prepare(`
      UPDATE agent_runs SET agent_manifest_hash = ? WHERE id = ?
    `).run('0'.repeat(64), run.runId);
    await expectPrepareDenied(run.runId, run.frameId);
  });

  it('denies an enabled InternalAgent snapshot without the requested canonical ToolId', async () => {
    const run = createRun(fx);
    const manifest = buildInternalAgentManifest([]);
    fx.core.databaseService.getRawDB().prepare(`
      UPDATE agent_runs SET agent_manifest_json = ?, agent_manifest_hash = ? WHERE id = ?
    `).run(manifest.manifestJson, manifest.manifestHash, run.runId);
    await expectPrepareDenied(run.runId, run.frameId);
  });

  it('denies a run whose manifest agent belongs to another workspace', async () => {
    const runA = createRun(fx, fx.workspaceA);
    const runB = createRun(fx, fx.workspaceB);
    const otherAgent = fx.core.databaseService.getRawDB().prepare(
      'SELECT agent_id FROM agent_runs WHERE id = ?',
    ).get(runB.runId) as { agent_id: string };
    fx.core.databaseService.getRawDB().prepare(
      'UPDATE agent_runs SET agent_id = ? WHERE id = ?',
    ).run(otherAgent.agent_id, runA.runId);
    await expectPrepareDenied(runA.runId, runA.frameId);
  });

  it('allows the Core-created, enabled InternalAgent snapshot through prepare and invoke', async () => {
    const run = createRun(fx);
    const prep = await fx.core.capabilityGateway.prepareInvocation({
      runId: run.runId, workspaceId: fx.workspaceA, ownerFrameId: run.frameId,
      toolId: fx.toolId, arguments: { query: 'happy path' },
    });
    const row = fx.core.databaseService.getRawDB().prepare(`
      SELECT r.agent_manifest_hash, a.enabled
        FROM agent_runs r JOIN agents a ON a.id = r.agent_id
       WHERE r.id = ? AND a.workspace_id = r.workspace_id
    `).get(run.runId) as { agent_manifest_hash: string; enabled: number };
    expect(row.agent_manifest_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.enabled).toBe(1);
    const result = await fx.core.capabilityGateway.invokePrepared({
      workspaceId: fx.workspaceA, effectId: prep.effectId, holderId: prep.holderId,
      idempotencyKey: `idem-${prep.effectId}`,
    });
    expect(result.ingressOutcome).toBe('accepted');
  });

  it('rechecks agent enablement after prepare and blocks callback with zero receipt', async () => {
    const run = createRun(fx);
    const prep = await fx.core.capabilityGateway.prepareInvocation({
      runId: run.runId, workspaceId: fx.workspaceA, ownerFrameId: run.frameId,
      toolId: fx.toolId, arguments: { query: 'callback drift' },
    });
    const db = fx.core.databaseService.getRawDB();
    db.prepare(`
      UPDATE agents SET enabled = 0
       WHERE id = (SELECT agent_id FROM agent_runs WHERE id = ?)
    `).run(run.runId);
    await expect(fx.core.capabilityGateway.invokePrepared({
      workspaceId: fx.workspaceA, effectId: prep.effectId, holderId: prep.holderId,
      idempotencyKey: `idem-${prep.effectId}`,
    })).rejects.toMatchObject({ code: OgraErrorCode.PERMISSION_DENIED });
    expect((db.prepare('SELECT COUNT(*) AS count FROM effect_receipts WHERE effect_id = ?')
      .get(prep.effectId) as { count: number }).count).toBe(0);
  });

  it('rechecks agent authorization after the async policy gate before callback CAS', async () => {
    const run = createRun(fx);
    const prep = await fx.core.capabilityGateway.prepareInvocation({
      runId: run.runId, workspaceId: fx.workspaceA, ownerFrameId: run.frameId,
      toolId: fx.toolId, arguments: { query: 'async authorization drift' },
    });
    const originalEvaluate = fx.core.policyService.evaluate.bind(fx.core.policyService);
    let entered!: () => void;
    let release!: () => void;
    const policyEntered = new Promise<void>((resolve) => { entered = resolve; });
    const releasePolicy = new Promise<void>((resolve) => { release = resolve; });
    const policySpy = vi.spyOn(fx.core.policyService, 'evaluate').mockImplementation(async (input) => {
      entered();
      await releasePolicy;
      return originalEvaluate(input);
    });
    const invocation = fx.core.capabilityGateway.invokePrepared({
      workspaceId: fx.workspaceA, effectId: prep.effectId, holderId: prep.holderId,
      idempotencyKey: `idem-${prep.effectId}`,
    });
    await policyEntered;
    const db = fx.core.databaseService.getRawDB();
    db.prepare(`
      UPDATE agents SET enabled = 0
       WHERE id = (SELECT agent_id FROM agent_runs WHERE id = ?)
    `).run(run.runId);
    release();
    await expect(invocation).rejects.toMatchObject({ code: OgraErrorCode.PERMISSION_DENIED });
    policySpy.mockRestore();
    expect((db.prepare('SELECT COUNT(*) AS count FROM effect_receipts WHERE effect_id = ?')
      .get(prep.effectId) as { count: number }).count).toBe(0);
    expect((db.prepare('SELECT state FROM run_effects WHERE id = ?')
      .get(prep.effectId) as { state: string }).state).toBe('planned');
  });
});
