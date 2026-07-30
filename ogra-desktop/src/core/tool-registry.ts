/**
 * Sequence 1C Milestone 1 — Tool Registry.
 *
 * Core-authoritative store of tool descriptors / versions /
 * workspace bindings. All mutating writes go through
 * `DurableRuntimeService.transactionalAppend` so descriptor /
 * version / binding changes produce an L1 v2 audit event atomically.
 *
 * The registry NEVER carries tool output. Tool output is the
 * concern of result capsules + ingress review. The registry's role
 * is configuration authority (plan 11 §6) only.
 */
import * as crypto from 'crypto';
import { OgraDatabase } from './database';
import { DurableRuntimeService } from './durable-runtime-service';
import {
  ToolDescriptor, ToolVersionDescriptor, WorkspaceToolBinding,
  ToolSourceKind, ToolTransport, ToolEffectClass, ToolRiskTier,
  ToolVersionStatus, ToolDescriptorLifecycle, ToolApprovalMode,
  canonicalToolIdFor,
} from './tool-broker-types';
import { OgraError, OgraErrorCode } from '../shared/errors';
import { canonicalJSON } from './audit-envelope';

export interface UpsertToolVersionInput {
  sourceKind: ToolSourceKind;
  sourceRef: string;
  logicalName: string;
  owner: string;
  sourceVersion: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  effectClass: ToolEffectClass;
  permissions: Record<string, unknown>;
  recoveryCapabilities: Record<string, unknown>;
  provenance: Record<string, unknown>;
  transport: ToolTransport;
  riskTier: ToolRiskTier;
}

export interface UpsertToolVersionResult {
  descriptorId: string;
  descriptorHash: string;
  toolVersionId: string;
  inputSchemaHash: string;
  outputSchemaHash: string | null;
  status: ToolVersionStatus;
}

export interface BindWorkspaceVersionInput {
  workspaceId: string;
  toolVersionId: string;
  approvalMode: ToolApprovalMode;
  constraints: Record<string, unknown>;
  policyId?: string | null;
  /**
   * Optional explicit binding id (used by the seed function in
   * tests / OgraCore init to keep deterministic ids across
   * sessions). When omitted the registry generates a fresh one.
   */
  bindingId?: string;
  /**
   * Stable identity for a sequence of immutable binding revisions. Omitted
   * callers get a deterministic identity per workspace/version; callers that
   * change policy or constraints must provide the same logical id and a new
   * concrete binding id.
   */
  logicalBindingId?: string;
  /**
   * Atomically make the new immutable revision the only enabled revision in
   * its logical lineage. Older rows remain intact for audit/recovery, but can
   * no longer authorize a new or previously prepared dispatch.
   */
  supersedePriorRevisions?: boolean;
}

const MAX_SCHEMA_BYTES = 128 * 1024;
const MAX_SCHEMA_DEPTH = 8;
const MAX_SCHEMA_PROPERTIES = 128;
const MAX_SCHEMA_ENUM_VALUES = 64;
const MAX_SCHEMA_PATTERN_LENGTH = 256;

/** This bounded T1 dialect deliberately excludes regex features whose cost is
 * hard to reason about in a synchronous callback gate. */
function assertSafeSchemaPattern(pattern: unknown, label: string, path: string): void {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > MAX_SCHEMA_PATTERN_LENGTH) {
    throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
      `${label}: ${path}.pattern must be a non-empty string <= ${MAX_SCHEMA_PATTERN_LENGTH}`);
  }
  // No lookaround/backreferences and no quantified group followed by another
  // quantifier: enough to keep this small audited dialect linear in practice.
  if (pattern.includes('(?') || /\\[1-9]/.test(pattern)
      || /\([^()]*[+*][^()]*\)[+*{]/.test(pattern)) {
    throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
      `${label}: ${path}.pattern uses an unsafe regex feature`);
  }
  try { new RegExp(pattern); } catch {
    throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
      `${label}: ${path}.pattern is not a valid regular expression`);
  }
}

/**
 * The T1 registry deliberately accepts only the small JSON Schema subset
 * executed by CapabilityGateway.validateToolArgs.  Persisting a schema with
 * ignored keywords would make review evidence claim stronger validation than
 * the callback actually performs, so unsupported dialect features fail
 * closed at registration time.
 */
function assertSupportedToolSchema(schema: Record<string, unknown>, label: string): void {
  const serialized = canonicalJSON(schema);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SCHEMA_BYTES) {
    throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
      `${label}: schema exceeds ${MAX_SCHEMA_BYTES} bytes`);
  }

  const walk = (value: unknown, path: string, depth: number): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        `${label}: ${path} must be an object schema`);
    }
    if (depth > MAX_SCHEMA_DEPTH) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        `${label}: ${path} exceeds maximum schema depth`);
    }
    const node = value as Record<string, unknown>;
    const type = node.type;
    if (typeof type !== 'string'
        || !['object', 'string', 'integer', 'number', 'boolean', 'array'].includes(type)) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
          `${label}: ${path}.type must be a supported scalar or container type`);
    }
    // CapabilityGateway's input validator intentionally supports a smaller
    // execution subset than the output snapshot language.  Do not register
    // input semantics that the callback cannot prove it enforced.
    if (label === 'inputSchema') {
      if (depth === 0 && type !== 'object') {
        throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
          'inputSchema: root type must be object');
      }
      if (depth > 0 && !['string', 'integer', 'array'].includes(type)) {
        throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
          `inputSchema: ${path}.type is not implemented by the invocation validator`);
      }
      if (node.const !== undefined || node.minItems !== undefined) {
        throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
          `inputSchema: ${path} uses a constraint not implemented by the invocation validator`);
      }
    }
    const allowedByType: Record<string, ReadonlySet<string>> = {
      object: new Set(['type', 'required', 'additionalProperties', 'properties']),
      string: new Set(['type', 'minLength', 'maxLength', 'maxBytes', 'enum', 'pattern', 'const']),
      integer: new Set(['type', 'minimum', 'maximum', 'const']),
      number: new Set(['type', 'minimum', 'maximum', 'const']),
      boolean: new Set(['type', 'const']),
      array: new Set(['type', 'items', 'minItems', 'maxItems']),
    };
    for (const key of Object.keys(node)) {
      if (!allowedByType[type].has(key)) {
        throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
          `${label}: ${path}.${key} is not supported by the T1 schema dialect`);
      }
    }
    if (node.pattern !== undefined) assertSafeSchemaPattern(node.pattern, label, path);
    if (type === 'object') {
      if (node.additionalProperties !== undefined && node.additionalProperties !== false) {
        throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
          `${label}: ${path}.additionalProperties must be false when supplied`);
      }
      if (node.required !== undefined
          && (!Array.isArray(node.required) || node.required.length > MAX_SCHEMA_PROPERTIES
              || node.required.some((entry) => typeof entry !== 'string'))) {
        throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
          `${label}: ${path}.required must be a bounded string array`);
      }
      if (node.properties !== undefined) {
        if (!node.properties || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
          throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
            `${label}: ${path}.properties must be an object`);
        }
        const properties = node.properties as Record<string, unknown>;
        const entries = Object.entries(properties);
        if (entries.length > MAX_SCHEMA_PROPERTIES) {
          throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
            `${label}: ${path}.properties exceeds ${MAX_SCHEMA_PROPERTIES}`);
        }
        for (const [key, child] of entries) walk(child, `${path}.properties.${key}`, depth + 1);
      }
    }
    if (type === 'array') {
      if (node.items === undefined) {
        throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
          `${label}: ${path}.items is required for arrays`);
      }
      walk(node.items, `${path}.items`, depth + 1);
      if (label === 'inputSchema'
          && (node.items as Record<string, unknown>).type !== 'string') {
        throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
          `inputSchema: ${path}.items must be a string schema`);
      }
    }
    for (const key of ['minLength', 'maxLength', 'maxBytes', 'minimum', 'maximum', 'minItems', 'maxItems'] as const) {
      if (node[key] !== undefined && (typeof node[key] !== 'number'
          || !Number.isFinite(node[key] as number) || (node[key] as number) < 0)) {
        throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
          `${label}: ${path}.${key} must be a non-negative finite number`);
      }
    }
    if (typeof node.minLength === 'number' && typeof node.maxLength === 'number'
        && node.minLength > node.maxLength) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        `${label}: ${path}.minLength cannot exceed maxLength`);
    }
    if (typeof node.minimum === 'number' && typeof node.maximum === 'number'
        && node.minimum > node.maximum) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        `${label}: ${path}.minimum cannot exceed maximum`);
    }
    if (typeof node.minItems === 'number' && typeof node.maxItems === 'number'
        && node.minItems > node.maxItems) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        `${label}: ${path}.minItems cannot exceed maxItems`);
    }
    if (node.enum !== undefined
        && (!Array.isArray(node.enum) || node.enum.length > MAX_SCHEMA_ENUM_VALUES
            || node.enum.some((entry) => typeof entry !== 'string'))) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        `${label}: ${path}.enum must be a bounded string array`);
    }
  };
  walk(schema, '$', 0);
}

/**
 * ToolRegistry — Core-authoritative store of immutable tool
 * descriptors / versions / workspace bindings. Tool descriptor
 * payloads are immutable; changes create a new pending version.
 */
export class ToolRegistry {
  constructor(
    private readonly odb: OgraDatabase,
    private readonly runtime: DurableRuntimeService,
  ) {}

  /**
   * Idempotent descriptor + version upsert. Descriptor rows are
   * keyed by `(source_kind, source_ref, logical_name)`. The version
   * row is keyed by `(descriptor_id, source_version)`. Existing versions are
   * immutable: an exact retry returns the prior row, but a changed contract
   * under the same source version fails closed. Callers must publish a new,
   * unambiguous sourceVersion for a changed contract.
   */
  async upsertToolVersion(input: UpsertToolVersionInput): Promise<UpsertToolVersionResult> {
    assertSupportedToolSchema(input.inputSchema, 'inputSchema');
    if (input.outputSchema) assertSupportedToolSchema(input.outputSchema, 'outputSchema');
    assertStableSourceVersion(input.sourceVersion);
    const descriptorHash = crypto.createHash('sha256').update(canonicalJSON({
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef,
      logicalName: input.logicalName,
      owner: input.owner,
    })).digest('hex');
    const inputSchemaHash = crypto.createHash('sha256')
      .update(canonicalJSON(input.inputSchema)).digest('hex');
    const outputSchemaHash = input.outputSchema
      ? crypto.createHash('sha256').update(canonicalJSON(input.outputSchema)).digest('hex')
      : null;

    return this.runtime.transactionalAppend<UpsertToolVersionResult>({
      meta: {
        runId: '',
        workspaceId: '',
        eventType: 'tool_version_upserted',
        eventPayload: {
          sourceKind: input.sourceKind,
          sourceRef: input.sourceRef,
          logicalName: input.logicalName,
          sourceVersion: input.sourceVersion,
          inputSchemaHash,
          outputSchemaHash,
        },
      },
      body: (_eventId) => {
        // Step 1: get-or-create descriptor row.
        let descriptor = this.odb.getDB().prepare(`
          SELECT id, source_kind, source_ref, logical_name, owner,
                 latest_version_id, lifecycle_state, created_at, updated_at
            FROM tool_descriptors
           WHERE source_kind = ? AND source_ref = ? AND logical_name = ?
        `).get(input.sourceKind, input.sourceRef, input.logicalName) as {
          id: string; source_kind: string; source_ref: string;
          logical_name: string; owner: string;
          latest_version_id: string | null; lifecycle_state: string;
          created_at: string; updated_at: string;
        } | undefined;
        let descriptorId: string;
        let descriptorStatus: ToolVersionStatus;
        if (!descriptor) {
          descriptorId = `tool_${crypto.randomBytes(6).toString('hex')}`;
          this.odb.getDB().prepare(`
            INSERT INTO tool_descriptors
              (id, source_kind, source_ref, logical_name, owner,
               latest_version_id, lifecycle_state, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, NULL, 'pending_review', ?, ?)
          `).run(descriptorId, input.sourceKind, input.sourceRef,
            input.logicalName, input.owner,
            new Date().toISOString(), new Date().toISOString());
          descriptorStatus = 'pending_review';
        } else {
          descriptorId = descriptor.id;
          if (descriptor.owner !== input.owner) {
            throw new OgraError(OgraErrorCode.TOOL_DESCRIPTOR_IMMUTABLE_CONFLICT,
              `tool descriptor ${descriptorId} owner differs for the same source identity`);
          }
          descriptorStatus = descriptor.lifecycle_state as ToolVersionStatus;
        }
        // Step 2: get-or-create version row.
        let toolVersion = this.odb.getDB().prepare(`
          SELECT id, descriptor_id, source_version, descriptor_hash,
                 input_schema_json, input_schema_hash, output_schema_json,
                 output_schema_hash, effect_class, permissions_json,
                 recovery_capabilities_json, provenance_json,
                 transport, risk_tier, status, created_at
            FROM tool_versions
           WHERE descriptor_id = ? AND source_version = ?
        `).get(descriptorId, input.sourceVersion) as {
          id: string; descriptor_id: string; source_version: string;
          descriptor_hash: string; input_schema_json: string;
          input_schema_hash: string; output_schema_json: string | null;
          output_schema_hash: string | null; effect_class: string;
          permissions_json: string; recovery_capabilities_json: string;
          provenance_json: string; transport: string;
          risk_tier: string; status: string; created_at: string;
        } | undefined;
        let toolVersionId: string;
        let createdVersion = false;
        let versionStatus: ToolVersionStatus;
        if (!toolVersion) {
          toolVersionId = `tver_${crypto.randomBytes(6).toString('hex')}`;
          this.odb.getDB().prepare(`
            INSERT INTO tool_versions
              (id, descriptor_id, source_version, descriptor_hash,
               input_schema_json, input_schema_hash,
               output_schema_json, output_schema_hash,
               effect_class, permissions_json, recovery_capabilities_json,
               provenance_json, transport, risk_tier, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?)
          `).run(
            toolVersionId, descriptorId, input.sourceVersion, descriptorHash,
            JSON.stringify(input.inputSchema), inputSchemaHash,
            input.outputSchema ? JSON.stringify(input.outputSchema) : null,
            outputSchemaHash,
            input.effectClass,
            JSON.stringify(input.permissions),
            JSON.stringify(input.recoveryCapabilities),
            JSON.stringify(input.provenance),
            input.transport, input.riskTier,
            new Date().toISOString(),
          );
          versionStatus = 'pending_review';
          createdVersion = true;
        } else {
          if (!isSameImmutableVersionContract(toolVersion, {
            descriptorHash,
            inputSchema: input.inputSchema,
            inputSchemaHash,
            outputSchema: input.outputSchema,
            outputSchemaHash,
            effectClass: input.effectClass,
            permissions: input.permissions,
            recoveryCapabilities: input.recoveryCapabilities,
            provenance: input.provenance,
            transport: input.transport,
            riskTier: input.riskTier,
          })) {
            throw new OgraError(OgraErrorCode.TOOL_VERSION_IMMUTABLE_CONFLICT,
              `tool version ${toolVersion.id} (${input.sourceVersion}) has a different immutable contract; publish a new sourceVersion`);
          }
          toolVersionId = toolVersion.id;
          versionStatus = toolVersion.status as ToolVersionStatus;
        }
        // Step 3: link latest_version_id.
        // The v2 envelope event written above already binds the
        // descriptor to the version through `transactionalAppend`'s
        // audit chain. We deliberately do NOT emit a synthetic
        // audit_edges row here because that table requires an
        // agent_runs row to back the FK, and a tool registry
        // upsert is a config event rather than a run-scoped event.
        // The pair remains queryable through tool_descriptors +
        // tool_versions + the L1 admin chain (`__admin__:tool_version_upserted`).
        // A retry of an older immutable version must not move the descriptor
        // read-model pointer backwards after a newer version was published.
        if (createdVersion || descriptor?.latest_version_id === null) {
          this.odb.getDB().prepare(
            'UPDATE tool_descriptors SET latest_version_id = ?, updated_at = ? WHERE id = ?',
          ).run(toolVersionId, new Date().toISOString(), descriptorId);
        }
        // Audit edge: omitted (see comment above). A future
        // migration can add a non-FK admin_edges view if needed.
        const _ = _eventId; // silence unused warning
        return {
          descriptorId,
          descriptorHash,
          toolVersionId,
          inputSchemaHash,
          outputSchemaHash,
          status: versionStatus,
        };
      },
    });
  }

  /**
   * Mark a tool version as enabled / revoked / stale. Status
   * changes are version-scoped and only affect future invocations
   * of this exact version. Existing in-flight invocations keep
   * their pinned version.
   */
  setVersionStatus(toolVersionId: string, status: ToolVersionStatus): void {
    const valid: ReadonlySet<ToolVersionStatus> = new Set(
      ['discovered', 'pending_review', 'enabled', 'stale', 'revoked']);
    if (!valid.has(status)) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        `setVersionStatus: status=${status} is not in the closed set`);
    }
    // Atomic: flip the tool_versions.status + the
    // tool_descriptors.lifecycle_state together inside the same
    // audit-event transaction. Both columns drive
    // `resolveEnabledBinding`'s gate; drifting between them is a
    // P1 risk.
    this.runtime.transactionalAppend({
      meta: {
        runId: '', workspaceId: '',
        eventType: 'tool_version_status_changed',
        eventPayload: {
          toolVersionId, status,
          lifecycle: status === 'enabled' ? 'enabled' : (
            status === 'revoked' ? 'revoked' : 'pending_review'),
        },
      },
      body: (_eventId) => {
        const upRes = this.odb.getDB().prepare(
          'UPDATE tool_versions SET status = ? WHERE id = ?',
        ).run(status, toolVersionId);
        if (upRes.changes !== 1) {
          throw new OgraError(OgraErrorCode.TOOL_VERSION_NOT_FOUND,
            `setVersionStatus: tool_version ${toolVersionId} not found`);
        }
        // Mirror the status onto the descriptor's lifecycle so
        // `resolveEnabledBinding` continues to gate correctly.
        const lifecycle = status === 'enabled' ? 'enabled'
          : status === 'revoked' ? 'revoked'
          : status === 'stale' ? 'stale'
          : 'pending_review';
        this.odb.getDB().prepare(`
          UPDATE tool_descriptors
             SET lifecycle_state = ?, updated_at = ?
           WHERE id = (SELECT descriptor_id FROM tool_versions
                        WHERE id = ?)
        `).run(lifecycle, new Date().toISOString(), toolVersionId);
        return toolVersionId;
      },
    });
  }

  /**
   * Bind a tool version to a workspace under the given
   * approval_mode. The binding row gets a hash over
   * (workspace_id, tool_version_id, policy_id, approval_mode, constraints).
   * Existing bindings remain queryable; new bindings are immutable
   * revisions (plan 11 §6).
   */
  bindWorkspaceVersion(input: BindWorkspaceVersionInput): WorkspaceToolBinding {
    const bindingHash = crypto.createHash('sha256').update(canonicalJSON({
      workspaceId: input.workspaceId,
      toolVersionId: input.toolVersionId,
      policyId: input.policyId ?? null,
      approvalMode: input.approvalMode,
      constraints: input.constraints,
    })).digest('hex');
    const id = input.bindingId
      ?? `tbind_${crypto.randomBytes(6).toString('hex')}`;
    const now = new Date().toISOString();
    const logicalBindingId = input.logicalBindingId
      ?? input.bindingId
      ?? `lbinding_${input.workspaceId}_${input.toolVersionId}`;
    // Idempotence and immutable-conflict checks happen before appending an
    // event. A retry must not create a misleading "binding_created" L1 event
    // when it did not create a concrete binding row.
    const priorById = this.odb.getDB().prepare(`
      SELECT id, logical_binding_id, workspace_id, tool_version_id,
             revision, parent_binding_id, binding_hash,
             binding_hash_version, policy_id, approval_mode, constraints_json
        FROM workspace_tool_bindings WHERE id = ?
    `).get(id) as BindingRow | undefined;
    const sameInput = {
      workspaceId: input.workspaceId,
      toolVersionId: input.toolVersionId,
      logicalBindingId,
      bindingHash,
      policyId: input.policyId ?? null,
      approvalMode: input.approvalMode,
      constraints: input.constraints,
    };
    if (priorById) {
      if (isSameImmutableBinding(priorById, sameInput)) {
        return this.toStoredBindingRow(priorById);
      }
      throw new OgraError(OgraErrorCode.TOOL_BINDING_IMMUTABLE_CONFLICT,
        `workspace tool binding ${id} is immutable; create a new binding revision`);
    }
    const priorLatest = this.odb.getDB().prepare(`
      SELECT id, logical_binding_id, workspace_id, tool_version_id,
             revision, parent_binding_id, binding_hash,
             binding_hash_version, policy_id, approval_mode, constraints_json
        FROM workspace_tool_bindings
       WHERE workspace_id = ? AND logical_binding_id = ?
       ORDER BY revision DESC LIMIT 1
    `).get(input.workspaceId, logicalBindingId) as BindingRow | undefined;
    if (priorLatest && isSameImmutableBinding(priorLatest, sameInput)) {
      return this.toStoredBindingRow(priorLatest);
    }
    // Wrap the binding INSERT + descriptor lifecycle UPDATE in
    // a transactionalAppend so the write is *atomic* with an L1
    // audit event. Plan 11 §6 mandates that any binding change
    // append an audit event; the canonical "audit-evading
    // mutation" is a direct SQL write without one.
    const persistedBindingId = this.runtime.transactionalAppend<string>({
      meta: {
        runId: '',
        workspaceId: '',
        eventType: 'workspace_tool_binding_created',
        eventPayload: {
          workspaceId: input.workspaceId,
          toolVersionId: input.toolVersionId,
          approvalMode: input.approvalMode,
          bindingHash,
          logicalBindingId,
          supersedesPriorRevisions: input.supersedePriorRevisions === true,
        },
      },
      body: (_eventId) => {
        const existingById = this.odb.getDB().prepare(`
          SELECT id, logical_binding_id, workspace_id, tool_version_id,
                 revision, parent_binding_id, binding_hash,
                 binding_hash_version, policy_id, approval_mode,
                 constraints_json
            FROM workspace_tool_bindings
           WHERE id = ?
        `).get(id) as BindingRow | undefined;
        if (existingById) {
          if (isSameImmutableBinding(existingById, {
            workspaceId: input.workspaceId,
            toolVersionId: input.toolVersionId,
            logicalBindingId,
            bindingHash,
            policyId: input.policyId ?? null,
            approvalMode: input.approvalMode,
            constraints: input.constraints,
          })) {
            return existingById.id;
          }
          throw new OgraError(OgraErrorCode.TOOL_BINDING_IMMUTABLE_CONFLICT,
            `workspace tool binding ${id} is immutable; create a new binding revision`);
        }

        const latest = this.odb.getDB().prepare(`
          SELECT id, logical_binding_id, workspace_id, tool_version_id,
                 revision, parent_binding_id, binding_hash,
                 binding_hash_version, policy_id, approval_mode,
                 constraints_json
            FROM workspace_tool_bindings
           WHERE workspace_id = ? AND logical_binding_id = ?
           ORDER BY revision DESC
           LIMIT 1
        `).get(input.workspaceId, logicalBindingId) as BindingRow | undefined;
        if (latest && isSameImmutableBinding(latest, {
          workspaceId: input.workspaceId,
          toolVersionId: input.toolVersionId,
          logicalBindingId,
          bindingHash,
          policyId: input.policyId ?? null,
          approvalMode: input.approvalMode,
          constraints: input.constraints,
        })) {
          // Idempotent retry. Do not create a second concrete row or mutate
          // the first one merely because the caller generated a new id.
          return latest.id;
        }
        const revision = (latest?.revision ?? 0) + 1;
        const parentBindingId = latest?.id ?? null;
        // Plan 11 §7.10 says schema review/binding is a separate
        // effect; we deliberately do NOT auto-flip the descriptor
        // lifecycle here. A subsequent `setVersionStatus` call
        // (already a separate operation) must mark it `enabled`
        // before any dispatch. The T1/T2 read-only slice keeps the
        // pre-existing call site ordering intact: bind, then
        // setStatus('enabled').
        this.odb.getDB().prepare(`
          INSERT INTO workspace_tool_bindings
            (id, logical_binding_id, parent_binding_id, workspace_id,
             tool_version_id, revision, enabled, binding_hash,
             binding_hash_version, policy_id, approval_mode, constraints_json,
             created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, ?, 2, ?, ?, ?, ?, ?)
        `).run(
          id, logicalBindingId, parentBindingId, input.workspaceId,
          input.toolVersionId, revision, bindingHash,
          input.policyId ?? null, input.approvalMode,
          JSON.stringify(input.constraints),
          now, now,
        );
        if (input.supersedePriorRevisions === true) {
          this.odb.getDB().prepare(`
            UPDATE workspace_tool_bindings
               SET enabled = 0, updated_at = ?
             WHERE workspace_id = ? AND logical_binding_id = ? AND id <> ?
          `).run(now, input.workspaceId, logicalBindingId, id);
        }
        return id;
      },
    });
    const row = this.odb.getDB().prepare(`
      SELECT id, workspace_id, tool_version_id, enabled, binding_hash,
             policy_id, approval_mode, constraints_json
        FROM workspace_tool_bindings WHERE id = ?
    `).get(persistedBindingId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new OgraError(OgraErrorCode.DATABASE_ERROR,
        `workspace tool binding ${persistedBindingId} was not persisted`);
    }
    return this.toBindingRow({
      binding_id: row.id,
      workspace_id: row.workspace_id,
      tool_version_id: row.tool_version_id,
      enabled: row.enabled,
      binding_hash: row.binding_hash,
      policy_id: row.policy_id,
      approval_mode: row.approval_mode,
      constraints_json: row.constraints_json,
    });
  }

  /**
   * Resolve an enabled binding + version for a workspace + tool
   * version id. Returns null if either is missing, disabled,
   * revoked, or stale. The returned tuple is immutable per plan 11
   * §6 — a binding/version/status change does NOT mutate a
   * returned descriptor's hash.
   */
  resolveEnabledBinding(args: {
    workspaceId: string;
    toolVersionId: string;
  }): {
    binding: WorkspaceToolBinding;
    version: ToolVersionDescriptor;
    descriptor: ToolDescriptor;
  } | null {
    const rows = this.odb.getDB().prepare(`
      SELECT b.id AS binding_id, b.workspace_id AS workspace_id,
             b.tool_version_id AS tool_version_id, b.enabled AS enabled,
             b.binding_hash AS binding_hash, b.policy_id AS policy_id,
             b.approval_mode AS approval_mode,
             b.constraints_json AS constraints_json,
             v.id AS v_id, v.descriptor_id AS v_descriptor_id,
             v.source_version AS v_source_version,
             v.descriptor_hash AS v_descriptor_hash,
             v.input_schema_json AS v_input_schema_json,
             v.input_schema_hash AS v_input_schema_hash,
             v.output_schema_json AS v_output_schema_json,
             v.output_schema_hash AS v_output_schema_hash,
             v.effect_class AS v_effect_class,
             v.permissions_json AS v_permissions_json,
             v.recovery_capabilities_json AS v_recovery_capabilities_json,
             v.provenance_json AS v_provenance_json,
             v.transport AS v_transport,
             v.risk_tier AS v_risk_tier,
             v.status AS v_status, v.created_at AS v_created_at,
             d.id AS d_id, d.source_kind AS d_source_kind,
             d.source_ref AS d_source_ref, d.logical_name AS d_logical_name,
             d.owner AS d_owner, d.latest_version_id AS d_latest_version_id,
             d.lifecycle_state AS d_lifecycle_state
        FROM workspace_tool_bindings b
        JOIN tool_versions v ON v.id = b.tool_version_id
        JOIN tool_descriptors d ON d.id = v.descriptor_id
       WHERE b.workspace_id = ? AND b.tool_version_id = ?
         AND b.enabled = 1 AND b.binding_hash_version = 2
         AND v.status = 'enabled'
       LIMIT 2
    `).all(args.workspaceId, args.toolVersionId) as Array<Record<string, unknown>>;
    // A canonical ToolId identifies a descriptor/version, not a concrete
    // binding. Ambiguous enabled bindings must fail closed rather than use an
    // unspecified SQLite row and thereby pick arbitrary constraints/policy.
    if (rows.length !== 1) return null;
    const row = rows[0];
    return {
      binding: this.toBindingRow(row),
      version: this.toVersionRow(row),
      descriptor: this.toDescriptorRow(row),
    };
  }

  /**
   * Resolve an invocation proposal by its opaque canonical ToolId. The public
   * gateway API intentionally does not accept a raw version id: version ids
   * are storage implementation details and cannot authorize a callback.
   */
  resolveEnabledBindingForCanonicalToolId(args: {
    workspaceId: string;
    toolId: string;
  }): {
    binding: WorkspaceToolBinding;
    version: ToolVersionDescriptor;
    descriptor: ToolDescriptor;
  } | null {
    const matches = this.listEnabledToolsForWorkspace(args.workspaceId).filter(
      (candidate) => canonicalToolIdFor(candidate.descriptor, candidate.version) === args.toolId,
    );
    return matches.length === 1 ? matches[0] : null;
  }

  /**
   * List every enabled tool (descriptor + version + binding) for
   * a workspace. Used by `listEnabledTools` so the renderer can
   * surface an explainable inventory.
   */
  listEnabledToolsForWorkspace(workspaceId: string): Array<{
    descriptor: ToolDescriptor;
    version: ToolVersionDescriptor;
    binding: WorkspaceToolBinding;
  }> {
    const rows = this.odb.getDB().prepare(`
      SELECT b.id AS binding_id, b.workspace_id AS workspace_id,
             b.tool_version_id AS tool_version_id, b.enabled AS enabled,
             b.binding_hash AS binding_hash, b.policy_id AS policy_id,
             b.approval_mode AS approval_mode,
             b.constraints_json AS constraints_json,
             v.id AS v_id, v.descriptor_id AS v_descriptor_id,
             v.source_version AS v_source_version,
             v.descriptor_hash AS v_descriptor_hash,
             v.input_schema_json AS v_input_schema_json,
             v.input_schema_hash AS v_input_schema_hash,
             v.output_schema_json AS v_output_schema_json,
             v.output_schema_hash AS v_output_schema_hash,
             v.effect_class AS v_effect_class,
             v.permissions_json AS v_permissions_json,
             v.recovery_capabilities_json AS v_recovery_capabilities_json,
             v.provenance_json AS v_provenance_json,
             v.transport AS v_transport,
             v.risk_tier AS v_risk_tier,
             v.status AS v_status,
             d.id AS d_id, d.source_kind AS d_source_kind,
             d.source_ref AS d_source_ref, d.logical_name AS d_logical_name,
             d.owner AS d_owner, d.latest_version_id AS d_latest_version_id,
             d.lifecycle_state AS d_lifecycle_state
        FROM workspace_tool_bindings b
        JOIN tool_versions v ON v.id = b.tool_version_id
        JOIN tool_descriptors d ON d.id = v.descriptor_id
       WHERE b.workspace_id = ? AND b.enabled = 1
         AND b.binding_hash_version = 2 AND v.status = 'enabled'
    `).all(workspaceId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      binding: this.toBindingRow(row),
      version: this.toVersionRow(row),
      descriptor: this.toDescriptorRow(row),
    }));
  }

  /**
   * Get the source_version + descriptor.hash + version.hash for
   * one tool version id. Used by tests / audit packets. Returns
   * null when the row is missing.
   */
  getDescriptorAndVersion(toolVersionId: string): {
    descriptor: ToolDescriptor;
    version: ToolVersionDescriptor;
  } | null {
    const row = this.odb.getDB().prepare(`
      SELECT v.id AS v_id, v.descriptor_id AS v_descriptor_id,
             v.source_version AS v_source_version,
             v.descriptor_hash AS v_descriptor_hash,
             v.input_schema_json AS v_input_schema_json,
             v.input_schema_hash AS v_input_schema_hash,
             v.output_schema_json AS v_output_schema_json,
             v.output_schema_hash AS v_output_schema_hash,
             v.effect_class AS v_effect_class,
             v.permissions_json AS v_permissions_json,
             v.recovery_capabilities_json AS v_recovery_capabilities_json,
             v.provenance_json AS v_provenance_json,
             v.transport AS v_transport, v.risk_tier AS v_risk_tier,
             v.status AS v_status,
             d.id AS d_id, d.source_kind AS d_source_kind,
             d.source_ref AS d_source_ref, d.logical_name AS d_logical_name,
             d.owner AS d_owner, d.latest_version_id AS d_latest_version_id,
             d.lifecycle_state AS d_lifecycle_state
        FROM tool_versions v
        JOIN tool_descriptors d ON d.id = v.descriptor_id
       WHERE v.id = ?
    `).get(toolVersionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      version: this.toVersionRow(row),
      descriptor: this.toDescriptorRow(row),
    };
  }

  private toVersionRow(row: Record<string, unknown>): ToolVersionDescriptor {
    return {
      id: row.v_id as string,
      descriptorId: row.v_descriptor_id as string,
      sourceVersion: row.v_source_version as string,
      descriptorHash: row.v_descriptor_hash as string,
      inputSchema: JSON.parse(row.v_input_schema_json as string),
      inputSchemaHash: row.v_input_schema_hash as string,
      outputSchema: row.v_output_schema_json
        ? JSON.parse(row.v_output_schema_json as string)
        : undefined,
      outputSchemaHash: (row.v_output_schema_hash as string | null) ?? undefined,
      effectClass: row.v_effect_class as ToolVersionDescriptor['effectClass'],
      permissions: JSON.parse(row.v_permissions_json as string),
      recoveryCapabilities: JSON.parse(row.v_recovery_capabilities_json as string),
      provenance: JSON.parse(row.v_provenance_json as string),
      transport: row.v_transport as ToolTransport,
      riskTier: row.v_risk_tier as ToolRiskTier,
      status: row.v_status as ToolVersionStatus,
    };
  }

  private toDescriptorRow(row: Record<string, unknown>): ToolDescriptor {
    return {
      id: row.d_id as string,
      sourceKind: row.d_source_kind as ToolSourceKind,
      sourceRef: row.d_source_ref as string,
      logicalName: row.d_logical_name as string,
      owner: row.d_owner as string,
      latestVersionId: (row.d_latest_version_id as string | null),
      lifecycleState: row.d_lifecycle_state as ToolDescriptorLifecycle,
    };
  }

  private toBindingRow(row: Record<string, unknown>): WorkspaceToolBinding {
    return {
      id: row.binding_id as string,
      workspaceId: row.workspace_id as string,
      toolVersionId: row.tool_version_id as string,
      enabled: (row.enabled as number) === 1,
      bindingHash: row.binding_hash as string,
      policyId: (row.policy_id as string | null),
      approvalMode: row.approval_mode as ToolApprovalMode,
      constraints: JSON.parse(row.constraints_json as string),
    };
  }

  private toStoredBindingRow(row: BindingRow): WorkspaceToolBinding {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      toolVersionId: row.tool_version_id,
      enabled: true,
      bindingHash: row.binding_hash,
      policyId: row.policy_id,
      approvalMode: row.approval_mode as ToolApprovalMode,
      constraints: JSON.parse(row.constraints_json),
    };
  }
}

type ExistingToolVersion = {
  id: string; descriptor_id: string; source_version: string;
  descriptor_hash: string; input_schema_json: string;
  input_schema_hash: string; output_schema_json: string | null;
  output_schema_hash: string | null; effect_class: string;
  permissions_json: string; recovery_capabilities_json: string;
  provenance_json: string; transport: string; risk_tier: string;
  status: string; created_at: string;
};

type BindingRow = {
  id: string; logical_binding_id: string; workspace_id: string;
  tool_version_id: string; revision: number; parent_binding_id: string | null;
  binding_hash: string; binding_hash_version: number; policy_id: string | null;
  approval_mode: string; constraints_json: string;
};

function assertStableSourceVersion(sourceVersion: string): void {
  if (typeof sourceVersion !== 'string'
      || sourceVersion.length === 0 || sourceVersion.length > 256
      || sourceVersion.trim() !== sourceVersion || /[\u0000-\u001f\u007f]/.test(sourceVersion)) {
    throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
      'sourceVersion must be a non-empty, trimmed, control-character-free stable identity');
  }
}

function isSameImmutableVersionContract(
  existing: ExistingToolVersion,
  input: {
    descriptorHash: string; inputSchema: Record<string, unknown>;
    inputSchemaHash: string; outputSchema?: Record<string, unknown>;
    outputSchemaHash: string | null; effectClass: ToolEffectClass;
    permissions: Record<string, unknown>; recoveryCapabilities: Record<string, unknown>;
    provenance: Record<string, unknown>; transport: ToolTransport; riskTier: ToolRiskTier;
  },
): boolean {
  try {
    return existing.descriptor_hash === input.descriptorHash
      && existing.input_schema_hash === input.inputSchemaHash
      && existing.output_schema_hash === input.outputSchemaHash
      && existing.effect_class === input.effectClass
      && existing.transport === input.transport
      && existing.risk_tier === input.riskTier
      && canonicalJSON(JSON.parse(existing.input_schema_json)) === canonicalJSON(input.inputSchema)
      && canonicalJSON(existing.output_schema_json ? JSON.parse(existing.output_schema_json) : null)
        === canonicalJSON(input.outputSchema ?? null)
      && canonicalJSON(JSON.parse(existing.permissions_json)) === canonicalJSON(input.permissions)
      && canonicalJSON(JSON.parse(existing.recovery_capabilities_json))
        === canonicalJSON(input.recoveryCapabilities)
      && canonicalJSON(JSON.parse(existing.provenance_json)) === canonicalJSON(input.provenance);
  } catch {
    // A corrupt stored contract must never be treated as a valid idempotent
    // retry; the caller must not dispatch against ambiguous evidence.
    return false;
  }
}

function isSameImmutableBinding(
  existing: BindingRow,
  input: {
    workspaceId: string; toolVersionId: string; logicalBindingId: string;
    bindingHash: string; policyId: string | null; approvalMode: ToolApprovalMode;
    constraints: Record<string, unknown>;
  },
): boolean {
  try {
    return existing.binding_hash_version === 2
      && existing.workspace_id === input.workspaceId
      && existing.tool_version_id === input.toolVersionId
      && existing.logical_binding_id === input.logicalBindingId
      && existing.binding_hash === input.bindingHash
      && existing.policy_id === input.policyId
      && existing.approval_mode === input.approvalMode
      && canonicalJSON(JSON.parse(existing.constraints_json)) === canonicalJSON(input.constraints);
  } catch {
    return false;
  }
}
