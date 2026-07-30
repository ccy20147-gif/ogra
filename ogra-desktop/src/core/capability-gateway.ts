/**
 * Sequence 1C Milestone 1 — CapabilityGateway (plan 11 §7).
 *
 * Core-owned narrow surface for tool invocation. Renderer / Agent /
 * Pipeline never have a raw invoke API; they can only propose
 * `{toolId, arguments}` and Core drives the full prepared path.
 *
 *   1. listEnabledTools(workspaceId)
 *   2. prepareInvocation({workspaceId, runId, ownerFrameId,
 *                          toolId, arguments})
 *   3. invokePrepared({workspaceId, runId, ownerFrameId,
 *                        effectId, holderId, arguments})
 *   4. reconcileInvocation({workspaceId, effectId})
 *
 * The flow binds every layer from plan 10 + plan 11 + plan 03:
 *   - canonical arguments + sha256(payload) → payloadFingerprint;
 *     caller-supplied `workspaceId` is REJECTED at the schema gate.
 *   - prepare() creates an owned plan-10 effect (a stable id derived
 *     from the idempotency key hash). It appends a paired L1 event.
 *   - acquireLease → casToInFlight (planned → in_flight).
 *   - Tool Host dispatch is scoped to Core-injected workspace + KBs.
 *     Tool Host NEVER opens SQLite.
 *   - recordReceipt() writes the result capsule and transitions
 *     `in_flight → received` inside one transaction; receipt id is
 *     authoritative.
 *   - `IndependentIngressReviewer.reviewAndFinalize()` runs the
 *     detached review subprocess, validates its closed-set verdict,
 *     then atomically commits (or quarantines / rejects) the effect
 *     with payload digest, ingress finding, audit edges, and a
 *     recovery_decisions row — all in one transaction.
 *   - Action Ledger records the entry in the same SQLite transaction
 *     as the `tool_invocation_committed` (or quarantined / rejected)
 *     audit event.
 *   - reconcileInvocation() returns refs + closed-set sanitized
 *     fields. Raw arguments / response / secrets never cross.
 */
import * as crypto from 'crypto';
import { OgraDatabase } from './database';
import { DurableRuntimeService } from './durable-runtime-service';
import { EffectProtocolService } from './effect-protocol-service';
import { IndependentIngressReviewer } from './independent-ingress-reviewer';
import { ActionLedgerService } from './action-ledger';
import { ToolRegistry } from './tool-registry';
import { ProgressGuard } from './progress-guard';
import {
  ToolDescriptor, ToolVersionDescriptor, WorkspaceToolBinding,
  canonicalToolIdFor,
  isTrustedToolExecutionCapability,
} from './tool-broker-types';
import {
  ToolHost, KnowledgeQueryPort, KnowledgeSearchInput,
  KnowledgeSearchResult, KNOWLEDGE_SEARCH_INPUT_SCHEMA,
  verifyKnowledgeSearchResultAuthority, MAX_KNOWLEDGE_SEARCH_KB_IDS,
} from './knowledge-search-adapter';
import { canonicalJSON } from './audit-envelope';
import { OgraError, OgraErrorCode } from '../shared/errors';
import { ALLOWED_OUTCOME_REASONS } from './action-ledger';
import { ToolTerminalProjectionService } from './tool-terminal-projection';
import { validateToolArgs, validateToolOutput } from './tool-schema-validation';
import { EncryptedCapsuleStore } from './capsule-store';
import type {
  PolicyService, PolicyEvaluationInput, PolicyEvaluationResult,
} from './policy-service';
import type { RouteService } from './route-service';
import { DataClassification, RouteDecisionType } from '../shared/types';
import {
  AgentPermissions, hashAgentManifest, parseAgentManifest,
} from './agent-manifest-authorization';

export interface PrepareInvocationInput {
  runId: string;
  workspaceId: string;
  ownerFrameId: string;
  /** Opaque id derived from the enabled descriptor/version identity. */
  toolId: string;
  arguments: unknown;
  routeDecisionId?: string;
  policyEvaluationId?: string;
  /** Optional lease TTL for the recovery lease acquired during the
   *  dispatch. Default 5 min. */
  leaseTtlMs?: number;
}

export interface CapabilityGatewayDeps {
  odb: OgraDatabase;
  runtime: DurableRuntimeService;
  effectProtocol: EffectProtocolService;
  /** Core-owned authenticated storage for result capsules. It is used only
   * to return an accepted built-in result to the InternalAgent plan; it is
   * never exposed through renderer IPC or a generic invocation API. */
  capsuleStore: EncryptedCapsuleStore;
  ingressReviewer: IndependentIngressReviewer;
  actionLedger: ActionLedgerService;
  terminalProjection: ToolTerminalProjectionService;
  toolRegistry: ToolRegistry;
  /** Lazily-resolved ToolHost. The Core may rebuild the ToolHost
   *  after `ensureKnowledgeSearchBinding` so that workspace + KB
   *  scopes are set; the gateway picks up the latest one on
   *  each invocation, never a captured reference.
   *
   *  P0#1 fix: the resolver is keyed by workspaceId. Concurrent
   *  invocations against different workspaces each get their
   *  own pre-bound ToolHost; a workspaceId that has not been
   *  bound to a tool returns a fail-closed placeholder whose
   *  dispatch raises PERMISSION_DENIED.
   *
   *  The legacy `() => ToolHost` zero-arg signature stays
   *  available for tests + tool-registry code; the runtime path
   *  uses the workspaceId-aware signature. */
  resolveToolHost: (workspaceId?: string) => ToolHost;
  getLeaseHolderId: () => string;
  /** Core policy authority. Tool calls never synthesize a decision. */
  policyService: PolicyService;
  /** Core route authority. Tool calls never synthesize a route. */
  routeService: RouteService;
  /** Optional ProgressGuard (P0#4). When supplied,
   *  `invokePrepared` observes each tool call; an `ok=false`
   *  decision aborts the dispatch fail-closed with a guard
   *  reason code. */
  progressGuard?: ProgressGuard;
}

export interface PrepareInvocationResult {
  effectId: string;
  toolId: string;
  toolVersionId: string;
  workspaceBindingId: string;
  inputHash: string;
  payloadFingerprint: string;
  attemptNo: number;
  /** Opaque per-run lease holder id; the call site must hand it
   *  back to `invokePrepared` together with the effect id. */
  holderId: string;
}

export type InvocationIngressOutcome =
  'accepted' | 'quarantined' | 'rejected';

export interface InvokePreparedInput {
  workspaceId: string;
  effectId: string;
  /** Holder id returned from prepareInvocation. Must match
   *  the active lease holder for the run. */
  holderId: string;
  /**
   * Deprecated compatibility field. It is never used for dispatch after
   * prepare; the authenticated callback capsule is the sole callback input.
   */
  arguments?: unknown;
  /** Adapter-side idempotency key. Hash only is stored. */
  idempotencyKey: string;
}

export interface InvokePreparedResult {
  effectId: string;
  attemptNo: number;
  effectRevision: number;
  receiptId: string;
  resultCapsuleRef: string;
  resultPayloadDigest: string;
  ingressOutcome: InvocationIngressOutcome;
  ingressFindingId: string;
  ingressReviewDecisionId: string;
  actionLedgerId: string;
  /** Canonical sequence number in the action_ledger for this run. */
  actionSequenceNo: number;
  l1EventId: string;
  ruleVersion: string;
}

/** Result of the single T2 deterministic plan. This is Core-internal data:
 * `result` is the accepted bounded context source, not an audit/UI projection. */
export interface DeterministicKnowledgeSearchExecution {
  invocation: InvokePreparedResult;
  result: KnowledgeSearchResult;
}

export interface ReconcileInvocationResult {
  effectId: string;
  workspaceId: string;
  toolVersionId: string;
  workspaceBindingId: string;
  state: string;
  ingressOutcome: InvocationIngressOutcome | 'unknown';
  ingressFindingId: string | null;
  receiptId: string | null;
  resultCapsuleRef: string | null;
  resultPayloadDigest: string | null;
  observationId: string | null;
}

type EnabledToolBinding = NonNullable<ReturnType<ToolRegistry['resolveEnabledBinding']>>;

interface InvocationConditions {
  policyEvaluationId: string;
  routeDecisionId: string;
  policyVersionHash: string;
  highWaterMark: DataClassification;
  policy: PolicyEvaluationResult;
  route: RouteDecisionType;
}

interface RunAgentAuthorization {
  agentId: string;
  manifestJson: string;
  manifestHash: string;
  permissions: AgentPermissions;
}

/**
 * Convert a caller proposal into inert JSON data before it is validated,
 * fingerprinted, or sealed. Accessors/prototypes are executable authority
 * crossing the Core boundary, so reject them rather than letting canonical
 * JSON invoke a getter while preparing an effect.
 */
export function cloneJsonData(
  value: unknown,
  path = '$',
  depth = 0,
  subject = 'tool arguments',
): unknown {
  if (depth > 16) throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
    `${subject} exceed maximum JSON depth at ${path}`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
      `${subject} contain non-finite number at ${path}`);
    return value;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        `${subject} cannot use an array subclass (${path})`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Object.keys(descriptors)) {
      // `length` is the standard non-enumerable array data property, not
      // caller-controlled metadata. All other own properties must be dense,
      // enumerable indexed data values.
      if (key === 'length') continue;
      if (!/^(0|[1-9][0-9]*)$/.test(key) || !('value' in descriptors[key]!) || !descriptors[key]!.enumerable) {
        throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
          `${subject} cannot contain array accessors or properties (${path}.${key})`);
      }
    }
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !('value' in descriptor)) {
        throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
          `${subject} cannot contain sparse arrays (${path}[${index}])`);
      }
      return cloneJsonData(descriptor.value, `${path}[${index}]`, depth + 1, subject);
    });
  }
  if (!value || typeof value !== 'object'
      || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
      `${subject} must contain only plain JSON data (${path})`);
  }
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor) || !descriptor.enumerable) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        `${subject} cannot contain accessors or hidden properties (${path}.${key})`);
    }
    out[key] = cloneJsonData(descriptor.value, `${path}.${key}`, depth + 1, subject);
  }
  return out;
}

/**
 * Strict, conservative schema validator. Production may swap in Ajv
 * later; this slice keeps the validator local so a future switch is
 * opaque to the gate. Unknown fields and depth-blowing inputs are
 * rejected before the policy layer sees them.
 */
export { validateToolArgs, validateToolOutput } from './tool-schema-validation';

/**
 * CapabilityGateway. The Renderer / Agent / Pipeline path is:
 *   1. `listEnabledTools` to discover.
 *   2. `prepareInvocation` to create a plan-10 effect, lock policy /
 *      scope / approval lineage, and acquire a recovery lease.
 *   3. `invokePrepared` to dispatch the Tool Host under the lease,
 *      seal the result capsule, append the receipt, run ingress
 *      review through `IndependentIngressReviewer`, and write the
 *      Action Ledger + audit chain entry.
 *   4. `reconcileInvocation` to read the persisted state + verdict.
 */
export class CapabilityGateway {
  private readonly odb: OgraDatabase;
  private readonly runtime: DurableRuntimeService;
  private readonly effectProtocol: EffectProtocolService;
  private readonly capsuleStore: EncryptedCapsuleStore;
  private readonly ingressReviewer: IndependentIngressReviewer;
  private readonly actionLedger: ActionLedgerService;
  private readonly terminalProjection: ToolTerminalProjectionService;
  private readonly toolRegistry: ToolRegistry;
  private readonly resolveToolHost: (workspaceId?: string) => ToolHost;
  private readonly getLeaseHolderId: () => string;
  private readonly policyService: PolicyService;
  private readonly routeService: RouteService;
  private readonly progressGuard: ProgressGuard | undefined;

  constructor(deps: CapabilityGatewayDeps) {
    this.odb = deps.odb;
    this.runtime = deps.runtime;
    this.effectProtocol = deps.effectProtocol;
    this.capsuleStore = deps.capsuleStore;
    this.ingressReviewer = deps.ingressReviewer;
    this.actionLedger = deps.actionLedger;
    this.terminalProjection = deps.terminalProjection;
    this.toolRegistry = deps.toolRegistry;
    this.resolveToolHost = deps.resolveToolHost;
    this.getLeaseHolderId = deps.getLeaseHolderId;
    this.policyService = deps.policyService;
    this.routeService = deps.routeService;
    this.progressGuard = deps.progressGuard;
  }

  /**
   * Phase 0: list every enabled tool for the workspace.
   */
  listEnabledTools(workspaceId: string): Array<{
    descriptor: ToolDescriptor;
    version: ToolVersionDescriptor;
    binding: WorkspaceToolBinding;
  }> {
    return this.toolRegistry.listEnabledToolsForWorkspace(workspaceId);
  }

  /**
   * Execute the one bounded T2 plan. The caller cannot choose a ToolId,
   * descriptor/version, binding, route, policy, lease holder, or approval.
   * Core resolves the unique enabled built-in knowledge.search binding and
   * only returns the result after the receipt has passed independent ingress.
   */
  async executeDeterministicKnowledgeSearch(input: {
    runId: string;
    workspaceId: string;
    ownerFrameId: string;
    query: string;
    topK: number;
    /** A caller may narrow the Core-bound KB scope, never expand it. */
    knowledgeBaseIds?: string[];
  }): Promise<DeterministicKnowledgeSearchExecution> {
    if (!input.runId || !input.workspaceId || !input.ownerFrameId
        || typeof input.query !== 'string' || input.query.length === 0
        || !Number.isInteger(input.topK) || input.topK < 1 || input.topK > 20) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'deterministic knowledge-search plan has invalid Core inputs');
    }
    if (input.knowledgeBaseIds !== undefined
        && (!Array.isArray(input.knowledgeBaseIds)
          || input.knowledgeBaseIds.some((id) => typeof id !== 'string' || !id)
          || input.knowledgeBaseIds.length > MAX_KNOWLEDGE_SEARCH_KB_IDS)) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'deterministic knowledge-search plan has an invalid knowledge-base scope');
    }
    const candidates = this.listEnabledTools(input.workspaceId).filter((entry) =>
      entry.descriptor.logicalName === 'knowledge.search'
      && isTrustedToolExecutionCapability(entry.descriptor, entry.version),
    );
    // Multiple simultaneously-enabled built-in versions would make a
    // deterministic plan ambiguous. Do not guess a latest version.
    if (candidates.length !== 1) {
      throw new OgraError(OgraErrorCode.TOOL_BINDING_NOT_FOUND,
        'deterministic knowledge-search plan requires exactly one enabled binding');
    }
    const candidate = candidates[0];
    if (!candidate.version.outputSchema) {
      throw new OgraError(OgraErrorCode.TOOL_BINDING_DISABLED,
        'deterministic knowledge-search binding has no pinned output schema');
    }
    const toolId = canonicalToolIdFor(candidate.descriptor, candidate.version);
    const prepared = await this.prepareInvocation({
      runId: input.runId,
      workspaceId: input.workspaceId,
      ownerFrameId: input.ownerFrameId,
      toolId,
      arguments: {
        query: input.query,
        topK: input.topK,
        ...(input.knowledgeBaseIds ? { knowledgeBaseIds: input.knowledgeBaseIds } : {}),
      },
    });
    const invocation = await this.invokePrepared({
      workspaceId: input.workspaceId,
      effectId: prepared.effectId,
      holderId: prepared.holderId,
      idempotencyKey: `agent-tool-${prepared.effectId}`,
    });
    if (invocation.ingressOutcome !== 'accepted' || !invocation.receiptId) {
      throw new OgraError(OgraErrorCode.INGRESS_REVIEW_DENIED,
        'deterministic knowledge-search result was not accepted');
    }

    const receipt = this.odb.getDB().prepare(`
      SELECT attempt_no, result_capsule_ref, result_capsule_hash,
             result_capsule_format_version
        FROM effect_receipts
       WHERE id = ? AND effect_id = ?
    `).get(invocation.receiptId, invocation.effectId) as {
      attempt_no: number;
      result_capsule_ref: string | null;
      result_capsule_hash: string | null;
      result_capsule_format_version: string | null;
    } | undefined;
    if (!receipt) {
      throw new OgraError(OgraErrorCode.RECEIPT_NOT_FOUND,
        'deterministic knowledge-search receipt is unavailable');
    }
    const opened = this.capsuleStore.openResultForReceipt<{ result: unknown }>({
      workspaceId: input.workspaceId,
      effectId: invocation.effectId,
      receiptId: invocation.receiptId,
      attemptNo: receipt.attempt_no,
      resultCapsuleRef: receipt.result_capsule_ref,
      resultCapsuleHash: receipt.result_capsule_hash,
      resultCapsuleFormatVersion: receipt.result_capsule_format_version,
    });
    const result = opened.payload?.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new OgraError(OgraErrorCode.CAPSULE_INVALID,
        'deterministic knowledge-search receipt has no result object');
    }
    validateToolOutput(candidate.version.outputSchema, result);
    return { invocation, result: result as KnowledgeSearchResult };
  }

  /**
   * Derive policy inputs exclusively from Core-owned records.  In particular,
   * a proposed invocation cannot select its workspace classification, KB
   * scope, requested compute, or route.  This is deliberately async because
   * PolicyService and RouteService are the production authorities.
   */
  private async evaluateInvocationConditions(args: {
    runId: string;
    workspaceId: string;
    inputHash: string;
    resolved: EnabledToolBinding;
    agentAuthorization: RunAgentAuthorization;
    persist: boolean;
  }): Promise<InvocationConditions> {
    const workspace = this.odb.getDB().prepare(
      'SELECT default_data_classification FROM workspaces WHERE id = ?',
    ).get(args.workspaceId) as { default_data_classification: string } | undefined;
    if (!workspace) {
      throw new OgraError(OgraErrorCode.WORKSPACE_MISMATCH,
        `tool policy evaluation: workspace ${args.workspaceId} not found`);
    }

    const validClassifications = new Set<string>(Object.values(DataClassification));
    if (!validClassifications.has(workspace.default_data_classification)) {
      throw new OgraError(OgraErrorCode.POLICY_BLOCKED,
        'tool policy evaluation: workspace classification is invalid');
    }
    const workspaceClassification = workspace.default_data_classification as DataClassification;
    const configuredKbIds = args.resolved.binding.constraints.enabledKnowledgeBaseIds;
    if (!Array.isArray(configuredKbIds)
        || configuredKbIds.length === 0
        || configuredKbIds.length > MAX_KNOWLEDGE_SEARCH_KB_IDS
        || new Set(configuredKbIds).size !== configuredKbIds.length
        || configuredKbIds.some((id) => typeof id !== 'string' || !id)) {
      throw new OgraError(OgraErrorCode.PERMISSION_DENIED,
        'tool policy evaluation: binding has no valid knowledge-base scope');
    }
    const kbIds = [...new Set(configuredKbIds)];
    const placeholders = kbIds.map(() => '?').join(',');
    const kbRows = this.odb.getDB().prepare(`
      SELECT id, classification FROM knowledge_bases
       WHERE workspace_id = ? AND id IN (${placeholders})
    `).all(args.workspaceId, ...kbIds) as Array<{ id: string; classification: string }>;
    if (kbRows.length !== kbIds.length
        || kbRows.some((row) => !validClassifications.has(row.classification))) {
      throw new OgraError(OgraErrorCode.PERMISSION_DENIED,
        'tool policy evaluation: binding knowledge-base scope is invalid for workspace');
    }

    const rank: Record<DataClassification, number> = {
      [DataClassification.Public]: 0,
      [DataClassification.Internal]: 1,
      [DataClassification.Confidential]: 2,
      [DataClassification.Restricted]: 3,
    };
    const documentRows = this.odb.getDB().prepare(`
      SELECT id, classification FROM documents
       WHERE workspace_id = ? AND knowledge_base_id IN (${placeholders})
    `).all(args.workspaceId, ...kbIds) as Array<{ id: string; classification: string }>;
    const chunkRows = this.odb.getDB().prepare(`
      SELECT dc.id, dc.classification_snapshot AS classification
        FROM document_chunks dc
        JOIN documents d ON d.id = dc.document_id
       WHERE dc.workspace_id = ? AND d.workspace_id = ?
         AND d.knowledge_base_id IN (${placeholders})
    `).all(args.workspaceId, args.workspaceId, ...kbIds) as Array<{
      id: string; classification: string;
    }>;
    if (documentRows.some((row) => !validClassifications.has(row.classification))
        || chunkRows.some((row) => !validClassifications.has(row.classification))) {
      throw new OgraError(OgraErrorCode.POLICY_BLOCKED,
        'tool policy evaluation: bound document or chunk classification is invalid');
    }

    const baseHighWaterMark = kbRows.reduce<DataClassification>(
      (current, row) => {
        const candidate = row.classification as DataClassification;
        return rank[candidate] > rank[current] ? candidate : current;
      },
      workspaceClassification,
    );
    const highWaterMark = [...documentRows, ...chunkRows].reduce<DataClassification>(
      (current, row) => {
        const candidate = row.classification as DataClassification;
        return rank[candidate] > rank[current] ? candidate : current;
      },
      baseHighWaterMark,
    );
    const highWaterSources = [
      { sourceType: 'workspace', sourceId: args.workspaceId, classification: workspaceClassification },
      ...kbRows.map((row) => ({
        sourceType: 'knowledge_base', sourceId: row.id,
        classification: row.classification,
      })),
      // Documents and chunks can raise the bound above their KB. Persist only
      // these elevating sources so high-water evidence remains useful even for
      // large local indexes, while the complete scope is still validated above.
      ...documentRows.filter((row) => rank[row.classification as DataClassification]
        > rank[baseHighWaterMark]).map((row) => ({
        sourceType: 'document', sourceId: row.id, classification: row.classification,
      })),
      ...chunkRows.filter((row) => rank[row.classification as DataClassification]
        > rank[baseHighWaterMark]).map((row) => ({
        sourceType: 'document_chunk', sourceId: row.id, classification: row.classification,
      })),
    ];
    // Transport is immutable version evidence. Only the HTTP MCP transport
    // requests cloud compute; in-process, worker, and stdio tools remain
    // local. The agent cannot override this classification.
    const requestsCloud = args.resolved.version.transport === 'mcp_http';
    const policyInput: PolicyEvaluationInput = {
      workspaceId: args.workspaceId,
      workspaceDefaultClassification: workspaceClassification,
      dataClassification: highWaterMark,
      knowledgeBaseClassification: highWaterMark,
      requestedCompute: requestsCloud ? 'cloud' : 'local',
      requiresCloud: requestsCloud,
      requestedOperation: 'tool.invoke',
      // Policy/approval authority binds the pinned source+descriptor+version
      // identity, not a display name that another source could reuse.
      requestedTools: [canonicalToolIdFor(
        args.resolved.descriptor, args.resolved.version,
      )],
      agentId: args.agentAuthorization.agentId,
      agentManifest: args.agentAuthorization.manifestJson,
      agentPermissions: args.agentAuthorization.permissions,
    };
    const policyVersionHash = this.policyService.getPolicyVersionHash();
    const policy = await this.policyService.evaluate(policyInput);
    const routeRecord = await this.routeService.evaluateRoute({
      ...policyInput,
      highWaterSources,
    });
    // A policy mutation while either authority was resolving is a race. Do
    // not bind an effect to a result whose policy version we cannot name.
    if (policyVersionHash !== this.policyService.getPolicyVersionHash()) {
      throw new OgraError(OgraErrorCode.POLICY_BLOCKED,
        'tool policy evaluation: policy changed during evaluation');
    }

    const identity = crypto.createHash('sha256').update(canonicalJSON({
      runId: args.runId,
      workspaceId: args.workspaceId,
      bindingId: args.resolved.binding.id,
      bindingHash: args.resolved.binding.bindingHash,
      toolVersionId: args.resolved.version.id,
      descriptorHash: args.resolved.version.descriptorHash,
      agentId: args.agentAuthorization.agentId,
      agentManifestHash: args.agentAuthorization.manifestHash,
      inputHash: args.inputHash,
      policyVersionHash,
      highWaterMark,
      requestedCompute: policyInput.requestedCompute,
    })).digest('hex').slice(0, 24);
    const policyEvaluationId = `pe_tool_${identity}`;
    const routeDecisionId = `rd_tool_${identity}`;

    if (args.persist) {
      this.odb.getDB().prepare(`
        INSERT OR IGNORE INTO policy_evaluations
          (id, run_id, policy_id, input_snapshot_json,
           result_json, matched_rules_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        policyEvaluationId,
        args.runId,
        args.resolved.binding.policyId ?? 'tool_binding_policy',
        JSON.stringify({
          toolVersionId: args.resolved.version.id,
          workspaceId: args.workspaceId,
          bindingId: args.resolved.binding.id,
          bindingHash: args.resolved.binding.bindingHash,
          canonicalToolId: canonicalToolIdFor(
            args.resolved.descriptor, args.resolved.version,
          ),
          agentId: args.agentAuthorization.agentId,
          agentManifestHash: args.agentAuthorization.manifestHash,
          requestedTools: policyInput.requestedTools,
          inputHash: args.inputHash,
          highWaterSources,
          requestedCompute: policyInput.requestedCompute,
        }),
        JSON.stringify({ ...policy, highWaterMark, policyVersionHash }),
        JSON.stringify(policy.matchedRules),
        new Date().toISOString(),
      );
      this.odb.getDB().prepare(`
        INSERT OR IGNORE INTO route_decisions
          (id, run_id, route, data_classification, high_water_sources_json,
           reason_json, local_steps_json, cloud_steps_json,
           requires_user_approval, approval_id, policy_evaluation_id,
           provider_id, model_id, cloud_payload_hash, incident_ids_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, '[]', ?)
      `).run(
        routeDecisionId, args.runId, routeRecord.route, highWaterMark,
        JSON.stringify(highWaterSources), JSON.stringify(routeRecord.reasons),
        JSON.stringify(routeRecord.localSteps), JSON.stringify(routeRecord.cloudSteps),
        routeRecord.requiresUserApproval ? 1 : 0, policyEvaluationId,
        new Date().toISOString(),
      );
    }

    if (policy.decision !== 'allow' && policy.decision !== 'local_only') {
      throw new OgraError(OgraErrorCode.POLICY_BLOCKED,
        `tool policy evaluation denied callback: ${policy.reasons.join('; ')}`);
    }
    if (routeRecord.route !== RouteDecisionType.Local) {
      throw new OgraError(OgraErrorCode.ROUTE_BLOCKED,
        `tool route evaluation denied callback: route=${routeRecord.route}`);
    }
    return {
      policyEvaluationId,
      routeDecisionId,
      policyVersionHash,
      highWaterMark,
      policy,
      route: routeRecord.route as RouteDecisionType,
    };
  }

  /**
   * Resolve the run's persisted agent snapshot through the enabled agent row.
   * The caller never supplies either record. This check occurs before lease
   * acquisition/effect creation and is repeated before physical dispatch.
   */
  private loadRunAgentAuthorization(input: {
    runId: string;
    workspaceId: string;
    canonicalToolId: string;
  }): RunAgentAuthorization {
    const row = this.odb.getDB().prepare(`
      SELECT r.workspace_id, r.agent_id, r.agent_manifest_json,
             r.agent_manifest_hash, a.workspace_id AS agent_workspace_id,
             a.enabled AS agent_enabled
        FROM agent_runs r
        LEFT JOIN agents a ON a.id = r.agent_id
       WHERE r.id = ?
    `).get(input.runId) as {
      workspace_id: string; agent_id: string | null;
      agent_manifest_json: string | null; agent_manifest_hash: string | null;
      agent_workspace_id: string | null; agent_enabled: number | null;
    } | undefined;
    if (!row) {
      throw new OgraError(OgraErrorCode.RUN_NOT_FOUND,
        `tool agent authorization: run ${input.runId} not found`);
    }
    if (row.workspace_id !== input.workspaceId) {
      throw new OgraError(OgraErrorCode.WORKSPACE_MISMATCH,
        'tool agent authorization: run does not belong to requested workspace');
    }
    if (!row.agent_id || !row.agent_manifest_json || !row.agent_manifest_hash
        || row.agent_workspace_id !== input.workspaceId || row.agent_enabled !== 1) {
      throw new OgraError(OgraErrorCode.PERMISSION_DENIED,
        'tool agent authorization: run has no enabled workspace agent manifest');
    }
    if (hashAgentManifest(row.agent_manifest_json) !== row.agent_manifest_hash) {
      throw new OgraError(OgraErrorCode.PERMISSION_DENIED,
        'tool agent authorization: manifest snapshot hash mismatch');
    }
    const manifest = parseAgentManifest(row.agent_manifest_json);
    if (!manifest || manifest.canonicalToolIds.length === 0
        || !manifest.canonicalToolIds.includes(input.canonicalToolId)) {
      throw new OgraError(OgraErrorCode.PERMISSION_DENIED,
        'tool agent authorization: manifest does not authorize requested canonical ToolId');
    }
    return {
      agentId: row.agent_id,
      manifestJson: row.agent_manifest_json,
      manifestHash: row.agent_manifest_hash,
      permissions: manifest.permissions,
    };
  }

  /**
   * Phase 1: prepare the invocation — create a plan-10 effect
   * row + acquire a recovery lease. No callback yet. The caller
   * sees only the effect id, holder id, and the input hash.
   */
  async prepareInvocation(input: PrepareInvocationInput): Promise<PrepareInvocationResult> {
    try {
      return await this.prepareInvocationInternal(input);
    } catch (err) {
      const code = err instanceof OgraError ? err.code : OgraErrorCode.INTERNAL_ERROR;
      const safeMessage = code === OgraErrorCode.PERMISSION_DENIED
        ? 'CapabilityGateway prepare failed: caller-supplied workspaceId is not honored or permission denied'
        : code === OgraErrorCode.TOOL_BINDING_NOT_FOUND
          ? 'CapabilityGateway prepare failed: no enabled binding'
          : 'CapabilityGateway prepare failed';
      throw new OgraError(code, safeMessage, {
        stage: 'prepare_invocation', causeCode: code,
      });
    }
  }

  private async prepareInvocationInternal(
    input: PrepareInvocationInput,
  ): Promise<PrepareInvocationResult> {
    if (!input.runId || !input.workspaceId || !input.ownerFrameId
        || !input.toolId) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'prepareInvocation: runId, workspaceId, ownerFrameId, toolId are required');
    }
    // P0#1 — Workspace authority: the caller-supplied
    // `workspaceId` MUST equal the workspace that owns the run.
    // Without this check the agent can present workspaceB's run
    // with workspaceA's workspaceId and end up routing the
    // retrieval against A's KBs. Plan 11 §4 ("Core injects
    // workspace") is enforced here: we resolve the run's real
    // workspace from `agent_runs.workspace_id` and refuse the
    // prepare on mismatch.
    // Make the proposal inert before any schema/key iteration. The sealed
    // callback command must never preserve a caller-owned prototype/getter.
    const preparedArguments = cloneJsonData(input.arguments);
    if (!preparedArguments || typeof preparedArguments !== 'object'
        || Array.isArray(preparedArguments)) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'prepareInvocation: tool arguments must be a JSON object');
    }
    const runRow = this.odb.getDB().prepare(
      'SELECT workspace_id AS workspace_id FROM agent_runs WHERE id = ?',
    ).get(input.runId) as { workspace_id: string } | undefined;
    if (!runRow) {
      throw new OgraError(OgraErrorCode.RUN_NOT_FOUND,
        `prepareInvocation: run ${input.runId} not found`);
    }
    if (runRow.workspace_id !== input.workspaceId) {
      throw new OgraError(OgraErrorCode.WORKSPACE_MISMATCH,
        `prepareInvocation: caller-supplied workspaceId=${input.workspaceId} does not match agent_runs.workspace_id=${runRow.workspace_id} for run=${input.runId}`);
    }
    const resolved = this.toolRegistry.resolveEnabledBindingForCanonicalToolId({
      workspaceId: input.workspaceId,
      toolId: input.toolId,
    });
    if (!resolved) {
      throw new OgraError(OgraErrorCode.TOOL_BINDING_NOT_FOUND,
        `prepareInvocation: no enabled binding for canonical tool in workspace=${input.workspaceId}`);
    }
    if (!isTrustedToolExecutionCapability(resolved.descriptor, resolved.version)) {
      throw new OgraError(OgraErrorCode.PERMISSION_DENIED,
        `prepareInvocation: tool closed-set violation on canonical identity for ${resolved.descriptor.id}`);
    }
    const agentAuthorization = this.loadRunAgentAuthorization({
      runId: input.runId,
      workspaceId: input.workspaceId,
      canonicalToolId: canonicalToolIdFor(resolved.descriptor, resolved.version),
    });
    // The schema gate uses additionalProperties=false to keep
    // callers from smuggling extra fields. Caller-supplied
    // workspaceId is REJECTED at the value gate (below) — even
    // though it isn't in the schema, we want to defensively
    // accept + reject it so the audit packet records the attempt.
    if (resolved.version.inputSchema && typeof resolved.version.inputSchema === 'object') {
      const schemaObj = resolved.version.inputSchema as Record<string, unknown>;
      // If the schema does not declare `workspaceId`, the strict
      // gate would reject the field before we can reject it
      // semantically. Strip it for the validation pass only.
      const stripped = (() => {
        if (!('workspaceId' in (preparedArguments as Record<string, unknown>))) {
          return preparedArguments;
        }
        const copy = { ...(preparedArguments as Record<string, unknown>) };
        delete (copy as Record<string, unknown>).workspaceId;
        return copy;
      })();
      try {
        validateToolArgs(schemaObj, stripped);
      } catch (err) {
        throw err;
      }
    }
    const a = preparedArguments as Record<string, unknown>;
    if (a.workspaceId !== undefined) {
      throw new OgraError(OgraErrorCode.PERMISSION_DENIED,
        'prepareInvocation: caller-supplied workspaceId is not honored');
    }
    // Schema Hash byte equality —> canonical hash from the
    // producer's exact `arguments` JSON.
    const inputHash = crypto.createHash('sha256')
      .update(canonicalJSON(preparedArguments)).digest('hex');

    // Route and policy IDs are authority records created by Core. Rejecting
    // them before acquiring a lease prevents an invalid proposal from
    // perturbing durable run ownership.
    if (input.routeDecisionId !== undefined || input.policyEvaluationId !== undefined) {
      throw new OgraError(OgraErrorCode.PERMISSION_DENIED,
        'prepareInvocation: callers cannot provide route or policy authority');
    }

    // Acquire the recovery lease first; the run may already hold
    // a lease from an earlier step. acquireLease is monotonic +
    // idempotent — a second call renews.
    const holderId = this.getLeaseHolderId();
    const lease = this.runtime.acquireLease({
      runId: input.runId,
      holderId,
      ttlMs: input.leaseTtlMs ?? 5 * 60 * 1000,
    });

    // Policy and route authority are Core-owned. The gateway derives every
    // input from persisted workspace/binding/descriptor evidence, then calls
    // the real asynchronous services.
    let conditions: InvocationConditions;
    try {
      conditions = await this.evaluateInvocationConditions({
        runId: input.runId,
        workspaceId: input.workspaceId,
        inputHash,
        resolved,
        agentAuthorization,
        persist: true,
      });
    } catch (err) {
      try {
        this.runtime.releaseLease({
          runId: input.runId, holderId,
          expectedLeaseVersion: lease.leaseVersion,
        });
      } catch { /* preserve the policy failure */ }
      throw err;
    }

    let prepared: {
      effectId: string;
      attemptNo: number;
      callbackCapsuleRef: string;
      callbackCapsuleHash: string;
      callbackCapsuleFormatVersion: string;
      idempotencyKeyHash: string;
    };
    const tinvId = `tinv_${crypto.randomBytes(6).toString('hex')}`;
    try {
      prepared = this.effectProtocol.prepare({
        runId: input.runId,
        ownerFrameId: input.ownerFrameId,
        effectType: 'tool.knowledge.search',
        adapterKind: 'tool-broker',
        adapterVersion: '1c-m1',
        payload: preparedArguments,
        payloadFingerprint: inputHash,
        idempotencyKey: `tool-${resolved.binding.id}-${inputHash}`,
        scopeHash: `scope-${resolved.binding.id}`,
        routeDecisionId: conditions.routeDecisionId,
        policyEvaluationId: conditions.policyEvaluationId,
        policyVersionHash: conditions.policyVersionHash,
        redactionRuleVersion: this.runtime.getCurrentRedactionRuleVersion(),
        classification: conditions.highWaterMark,
        recoveryCapabilities: {
          // Carry the immutable version contract into the sealed callback;
          // recovery must not infer or synthesize these authorities.
          supportsIdempotencyKey:
            resolved.version.recoveryCapabilities.supportsIdempotencyKey === true,
          supportsOutcomeQuery:
            resolved.version.recoveryCapabilities.supportsOutcomeQuery === true,
          supportsCompensation:
            resolved.version.recoveryCapabilities.supportsCompensation === true,
        },
        // The projection is part of prepare's L0/L1 transaction.  A planned
        // effect without its pinned tool version/binding is not recoverable,
        // so this must never be an after-prepare write.
        postPrepareBody: (effect) => {
          this.odb.getDB().prepare(`
            INSERT OR IGNORE INTO tool_invocations
              (id, effect_id, tool_version_id, workspace_binding_id,
               input_hash, policy_evaluation_id, current_approval_id,
               ingress_finding_id, started_at,
               prepared_descriptor_hash, prepared_input_schema_hash,
               prepared_binding_hash, prepared_canonical_tool_id,
               prepared_output_schema_json, prepared_output_schema_hash)
            VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            tinvId, effect.effectId,
            resolved.version.id, resolved.binding.id,
            inputHash, conditions.policyEvaluationId,
            new Date().toISOString(),
            resolved.version.descriptorHash,
            resolved.version.inputSchemaHash,
            resolved.binding.bindingHash,
            canonicalToolIdFor(resolved.descriptor, resolved.version),
            resolved.version.outputSchema
              ? canonicalJSON(resolved.version.outputSchema) : null,
            resolved.version.outputSchema
              ? crypto.createHash('sha256').update(canonicalJSON(resolved.version.outputSchema)).digest('hex')
              : null,
          );
          const pinned = this.odb.getDB().prepare(
            'SELECT tool_version_id, workspace_binding_id, input_hash, policy_evaluation_id FROM tool_invocations WHERE effect_id = ?',
          ).get(effect.effectId) as {
            tool_version_id: string; workspace_binding_id: string;
            input_hash: string; policy_evaluation_id: string;
          } | undefined;
          if (!pinned
              || pinned.tool_version_id !== resolved.version.id
              || pinned.workspace_binding_id !== resolved.binding.id
              || pinned.input_hash !== inputHash
              || pinned.policy_evaluation_id !== conditions.policyEvaluationId) {
            throw new OgraError(OgraErrorCode.TOOL_BINDING_DISABLED,
              'prepareInvocation: existing tool invocation projection does not match the prepared binding');
          }
        },
      });
    } catch (err) {
      // A prepare failure must release any lease we just took.
      // If the release CAS lost (a competing recovery took over,
      // or the lease TTL expired and was renewed by another
      // holder) we MUST surface this — the swallowed-error path
      // was the P0 finding from the 1C/M1 sub-agent review
      // (lease leak under contention). We append an L1 event so
      // the operational state is auditable, and re-throw a
      // single canonical error.
      let releaseFailedCode: OgraErrorCode | null = null;
      try {
        this.runtime.releaseLease({
          runId: input.runId,
          holderId,
          expectedLeaseVersion: lease.leaseVersion,
        });
      } catch (releaseErr) {
        releaseFailedCode = releaseErr instanceof OgraError
          ? releaseErr.code : OgraErrorCode.INTERNAL_ERROR;
      }
      // Best-effort audit row for a release failure. Uses the
      // canonical `incidents` schema columns (`incident_type`,
      // `severity`, `summary`) — the previous Round-2 review
      // caught that the original INSERT referenced
      // non-existent columns `kind` / `message` and the catch
      // here was silently dropping the diagnostic, so the
      // fix must align with database.ts `incidents` schema.
      // The incident row is best-effort. Only stable codes cross this
      // boundary; provider, SQL, payload, and query text are discarded.
      let incidentWriteErrorCode: OgraErrorCode | null = null;
      const prepareFailureCode = err instanceof OgraError
        ? err.code : OgraErrorCode.INTERNAL_ERROR;
      try {
        this.odb.getDB().prepare(`
          INSERT INTO incidents
            (id, workspace_id, run_id, incident_type,
             severity, summary, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          `inc_${crypto.randomBytes(6).toString('hex')}`,
          input.workspaceId,
          input.runId,
          'lease_release_failed',
          'high',
          `capability_prepare_failed;prepare_code=${prepareFailureCode};` +
            `lease_release=${releaseFailedCode ? 'failed' : 'released'};` +
            `lease_release_code=${releaseFailedCode ?? 'NONE'}`,
          new Date().toISOString(),
        );
      } catch (incidentErr) {
        // Preserve the failure signal as a stable code without retaining the
        // database exception text.
        incidentWriteErrorCode = incidentErr instanceof OgraError
          ? incidentErr.code : OgraErrorCode.DATABASE_ERROR;
      }
      // Surface stable cleanup signals while keeping raw exception text out
      // of callers, IPC projections, logs, and durable incident summaries.
      if (incidentWriteErrorCode || releaseFailedCode) {
        throw new OgraError(
          OgraErrorCode.INTERNAL_ERROR,
          'CapabilityGateway prepare cleanup failed',
          {
            stage: 'prepare_cleanup',
            prepareFailureCode,
            releaseFailureCode: releaseFailedCode,
            incidentWriteFailureCode: incidentWriteErrorCode,
          },
        );
      }
      throw new OgraError(prepareFailureCode,
        'CapabilityGateway effect preparation failed', {
          stage: 'effect_prepare', causeCode: prepareFailureCode,
        });
    }
    return {
      effectId: prepared.effectId,
      toolId: input.toolId,
      toolVersionId: resolved.version.id,
      workspaceBindingId: resolved.binding.id,
      inputHash,
      payloadFingerprint: inputHash,
      attemptNo: prepared.attemptNo,
      holderId,
    };
  }

  /**
   * Phase 2: invoke a prepared effect under the lease. Drives the
   * effect through `planned → in_flight → received → terminal`
   * using the canonical EffectProtocolService + ingress reviewer.
   *
   * The action ledger entry (tool_call) and a paired L1 event are
   * written in the same SQLite transaction as the terminal commit
   * via `IngressReviewService.finalizeIngressDecision` (called by
   * the IndependentIngressReviewer). We additionally call
   * `actionLedger.recordAction` AFTER terminal commit so the
   * ledger row carries the produced finding / decision ids.
   */
  async invokePrepared(input: InvokePreparedInput): Promise<InvokePreparedResult> {
    if (!input.workspaceId || !input.effectId || !input.holderId) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'invokePrepared: workspaceId, effectId, holderId are required');
    }
    // Look up the prepared effect + binding + workspace. The
    // tool_invocations row is created at prepare time so the
    // join path is durable across failures.
    const row = this.odb.getDB().prepare(`
      SELECT e.id AS effect_id, e.run_id AS run_id,
             e.owner_frame_id AS owner_frame_id,
             e.state AS state, e.effect_revision AS effect_revision,
             e.payload_fingerprint AS effect_payload_fingerprint,
             e.policy_version_hash AS effect_policy_version_hash,
             e.route_decision_id AS route_decision_id,
             e.policy_evaluation_id AS policy_evaluation_id,
             ti.tool_version_id AS tool_version_id,
             ti.workspace_binding_id AS binding_id,
             ti.prepared_descriptor_hash AS prepared_descriptor_hash,
             ti.prepared_input_schema_hash AS prepared_input_schema_hash,
             ti.prepared_binding_hash AS prepared_binding_hash,
             ti.prepared_canonical_tool_id AS prepared_canonical_tool_id,
             ti.prepared_output_schema_json AS prepared_output_schema_json,
             ti.prepared_output_schema_hash AS prepared_output_schema_hash,
             v.status AS version_status,
             v.input_schema_json AS input_schema_json,
             v.effect_class AS effect_class,
             v.transport AS transport,
             v.risk_tier AS risk_tier,
             d.lifecycle_state AS descriptor_lifecycle,
             b.workspace_id AS workspace_id,
             b.enabled AS binding_enabled,
             b.approval_mode AS approval_mode,
             b.binding_hash AS binding_hash,
             b.id AS b_id
        FROM run_effects e
        JOIN tool_invocations ti ON ti.effect_id = e.id
        JOIN tool_versions v ON v.id = ti.tool_version_id
        JOIN tool_descriptors d ON d.id = v.descriptor_id
        JOIN workspace_tool_bindings b ON b.id = ti.workspace_binding_id
        JOIN agent_runs ar ON ar.id = e.run_id
       WHERE e.id = ? AND b.workspace_id = ?
         AND ar.workspace_id = b.workspace_id
    `).get(input.effectId, input.workspaceId) as Record<string, unknown> | undefined;

    if (!row) {
      throw new OgraError(OgraErrorCode.TOOL_BINDING_NOT_FOUND,
        `invokePrepared: prepared effect ${input.effectId} / binding row not found for workspace ${input.workspaceId}`);
    }
    if ((row.version_status as string) !== 'enabled'
        || (row.descriptor_lifecycle as string) !== 'enabled'
        || (row.binding_enabled as number) !== 1) {
      throw new OgraError(OgraErrorCode.TOOL_BINDING_DISABLED,
        `invokePrepared: tool version / descriptor / binding not enabled (version=${row.version_status} lifecycle=${row.descriptor_lifecycle} enabled=${row.binding_enabled})`);
    }
    if ((row.approval_mode as string) !== 'none') {
      throw new OgraError(OgraErrorCode.APPROVAL_REQUIRED,
        `invokePrepared: tool requires approval_mode=${row.approval_mode}; this slice only supports approval_mode=none`);
    }
    if ((row.state as string) !== 'planned') {
      throw new OgraError(OgraErrorCode.EFFECT_INVALID_TRANSITION,
        `invokePrepared: effect ${input.effectId} state=${row.state} (expected planned)`);
    }

    // No second proposal object is an authority after prepare. The durable
    // payload fingerprint is sufficient for pre-CAS policy evidence; the
    // authenticated callback plaintext is opened by casToInFlight and is the
    // only value eventually handed to ToolHost.
    const inputHash = row.effect_payload_fingerprint as string;

    // Immediately before callback, re-resolve the immutable version/binding
    // and call the live policy + route authorities. Any current policy,
    // route, binding, schema, or workspace drift leaves the effect planned
    // and performs zero physical dispatch.
    const currentBinding = this.toolRegistry.resolveEnabledBinding({
      workspaceId: input.workspaceId,
      toolVersionId: row.tool_version_id as string,
    });
    if (!currentBinding
        || currentBinding.binding.id !== row.binding_id
        || !isTrustedToolExecutionCapability(currentBinding.descriptor, currentBinding.version)) {
      throw new OgraError(OgraErrorCode.TOOL_BINDING_DISABLED,
        'invokePrepared: current binding/version no longer matches prepared effect');
    }
    const currentAgentAuthorization = this.loadRunAgentAuthorization({
      runId: row.run_id as string,
      workspaceId: input.workspaceId,
      canonicalToolId: canonicalToolIdFor(currentBinding.descriptor, currentBinding.version),
    });
    const currentConditions = await this.evaluateInvocationConditions({
      runId: row.run_id as string,
      workspaceId: input.workspaceId,
      inputHash,
      resolved: currentBinding,
      agentAuthorization: currentAgentAuthorization,
      persist: false,
    });
    if (currentConditions.policyVersionHash !== (row.effect_policy_version_hash as string)
        || currentConditions.routeDecisionId !== (row.route_decision_id as string)
        || currentConditions.policyEvaluationId !== (row.policy_evaluation_id as string)) {
      throw new OgraError(OgraErrorCode.POLICY_BLOCKED,
        'invokePrepared: current policy, route, or binding differs from prepared effect');
    }

    // Policy/route evaluation is async. Re-read the binding afterwards so the
    // immutable comparison is the final non-async gate before CAS/dispatch,
    // rather than a stale object retained across that await.
    const callbackBinding = this.toolRegistry.resolveEnabledBinding({
      workspaceId: input.workspaceId,
      toolVersionId: row.tool_version_id as string,
    });
    if (!callbackBinding
        || callbackBinding.binding.id !== row.binding_id
        || !isTrustedToolExecutionCapability(
          callbackBinding.descriptor, callbackBinding.version,
        )) {
      throw new OgraError(OgraErrorCode.TOOL_BINDING_DISABLED,
        'invokePrepared: current binding/version changed during callback precondition evaluation');
    }
    // This is the final non-async gate before CAS/dispatch. The values below
    // were snapshotted when prepare created the owned effect; any descriptor,
    // schema, binding, or canonical identity drift leaves it planned.
    const currentCanonicalToolId = canonicalToolIdFor(
      callbackBinding.descriptor, callbackBinding.version,
    );
    if (row.prepared_descriptor_hash !== callbackBinding.version.descriptorHash
        || row.prepared_input_schema_hash !== callbackBinding.version.inputSchemaHash
        || row.prepared_binding_hash !== callbackBinding.binding.bindingHash
        || row.prepared_canonical_tool_id !== currentCanonicalToolId) {
      throw new OgraError(OgraErrorCode.TOOL_BINDING_DISABLED,
        'invokePrepared: prepared immutable descriptor, schema, binding, or canonical identity drifted');
    }
    const currentOutputSchema = callbackBinding.version.outputSchema
      ? canonicalJSON(callbackBinding.version.outputSchema) : null;
    const currentOutputSchemaHash = currentOutputSchema
      ? crypto.createHash('sha256').update(currentOutputSchema).digest('hex') : null;
    if (row.prepared_output_schema_json !== currentOutputSchema
        || row.prepared_output_schema_hash !== currentOutputSchemaHash) {
      throw new OgraError(OgraErrorCode.TOOL_BINDING_DISABLED,
        'invokePrepared: prepared output schema drifted');
    }

    // `evaluateInvocationConditions` awaits the policy and route authorities.
    // Re-read the Core-owned agent snapshot after that await and immediately
    // before CAS so disabling/rebinding an agent during evaluation cannot race
    // into a physical callback. The policy result is only valid for this exact
    // persisted run-agent identity and immutable manifest hash.
    const callbackAgentAuthorization = this.loadRunAgentAuthorization({
      runId: row.run_id as string,
      workspaceId: input.workspaceId,
      canonicalToolId: currentCanonicalToolId,
    });
    if (callbackAgentAuthorization.agentId !== currentAgentAuthorization.agentId
        || callbackAgentAuthorization.manifestHash
          !== currentAgentAuthorization.manifestHash) {
      throw new OgraError(OgraErrorCode.PERMISSION_DENIED,
        'invokePrepared: agent authorization changed during callback precondition evaluation');
    }

    // CAS to in_flight. leaseVersion is the version we acquired
    // at prepare-time — the lease was issued before prepare()
    // returned and the same holder must own the in_flight CAS.
    const lease = this.runtime.readLease(row.run_id as string);
    if (lease.holderId !== input.holderId || lease.releasedAt !== null) {
      throw new OgraError(OgraErrorCode.LEASE_NOT_HELD,
        `invokePrepared: lease not held by ${input.holderId}`);
    }
    //
    // P0#4 fix: every tool call observes against the
    // ProgressGuard BEFORE the dispatched effect transitions
    // to `in_flight`. The guard's `ok=false` decision aborts
    // the dispatch fail-closed (the effect stays in `planned`
    // and the lease is released). This is the canonical
    // fail-closed posture that prevents an agent-loop /
    // budget exhaustion from succeeding silently.
    //
    // When no ProgressGuard is wired (legacy fixture) the
    // observation step is a no-op so the M1 broker test stays
    // green.
    if (this.progressGuard) {
      const obs = this.progressGuard.observe({
        runId: row.run_id as string,
        workspaceId: input.workspaceId,
        frameId: row.owner_frame_id as string,
        actionTarget: `tool:${canonicalToolIdFor(callbackBinding.descriptor, callbackBinding.version)}`,
        progressDelta: 1,
      });
      if (!obs.ok) {
        // Best-effort: release the lease so subsequent
        // observations on the run are not blocked by a
        // stale-holder check.
        try {
          this.runtime.releaseLease({
            runId: row.run_id as string,
            holderId: input.holderId,
            expectedLeaseVersion: lease.leaseVersion,
          });
        } catch {
          // ignore — the guard termination is the canonical
          // outcome here; a stale lease isn't catastrophic.
        }
        throw new OgraError(
          OgraErrorCode.INTERNAL_ERROR,
          `invokePrepared: ProgressGuard refused dispatch (reason=${obs.reasonCode ?? 'unspecified'} detail=${obs.detail ?? ''})`,
        );
      }
    }
    const cas = this.effectProtocol.casToInFlight({
      effectId: input.effectId,
      expectedRevision: row.effect_revision as number,
      expectedAttemptNo: 1,
      leaseHolder: input.holderId,
      approvalId: null,
      expectedState: 'planned',
      expectedLeaseVersion: lease.leaseVersion,
    });
    if (cas.state !== 'in_flight') {
      throw new OgraError(OgraErrorCode.REVISION_CONFLICT,
        `invokePrepared: casToInFlight did not transition effect ${input.effectId}`);
    }

    const callbackCommand = cas.callbackPayload;
    if (!callbackCommand || typeof callbackCommand !== 'object'
        || Array.isArray(callbackCommand)
        || !Object.prototype.hasOwnProperty.call(callbackCommand, 'payload')) {
      throw new OgraError(OgraErrorCode.CAPSULE_INVALID,
        'invokePrepared: verified callback command has no payload');
    }
    const sealedArguments = cloneJsonData(
      (callbackCommand as Record<string, unknown>).payload,
    );
    if (!sealedArguments || typeof sealedArguments !== 'object' || Array.isArray(sealedArguments)) {
      throw new OgraError(OgraErrorCode.CAPSULE_INVALID,
        'invokePrepared: verified callback payload is not an argument object');
    }
    const sealedInputHash = crypto.createHash('sha256')
      .update(canonicalJSON(sealedArguments)).digest('hex');
    if (sealedInputHash !== inputHash) {
      throw new OgraError(OgraErrorCode.EFFECT_PAYLOAD_FINGERPRINT_CHANGED,
        'invokePrepared: sealed callback payload does not match prepared fingerprint');
    }
    validateToolArgs(callbackBinding.version.inputSchema, sealedArguments);

    // Dispatch the Tool Host. The host returns refs / hashes —
    // never raw secrets / response / arguments. We pass the
    // authenticated sealed callback payload, never a second caller proposal.
    // P0#1: pass
    // the input workspaceId so the per-workspace-keyed host
    // (from `_toolHostsByWorkspace`) is the one that dispatches
    // — an attacker who forges an `effectId` against a
    // different workspace CANNOT ride another workspace's
    // host because the effect join above already verified
    // (workspace_id == input.workspaceId).
    const canonicalToolId = canonicalToolIdFor(
      callbackBinding.descriptor, callbackBinding.version,
    );
    const dispatchedResult: KnowledgeSearchResult = await this.resolveToolHost(input.workspaceId).dispatch({
      toolId: canonicalToolId,
      arguments: sealedArguments,
      descriptor: callbackBinding.descriptor,
      version: callbackBinding.version,
      workspaceId: input.workspaceId,
    }, {
      // Execution identity is Core-owned metadata, intentionally kept out of
      // agent arguments, version schemas, and the sealed callback payload.
      runId: row.run_id as string,
    });

    let result: KnowledgeSearchResult;
    try {
      const inertResult = cloneJsonData(dispatchedResult, '$', 0, 'tool output');
      if (!inertResult || typeof inertResult !== 'object' || Array.isArray(inertResult)) {
        throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
          'tool output must be a JSON object');
      }
      result = inertResult as KnowledgeSearchResult;
      if (row.prepared_output_schema_json) {
        validateToolOutput(JSON.parse(row.prepared_output_schema_json as string), result);
        verifyKnowledgeSearchResultAuthority({
          result,
          arguments: sealedArguments as KnowledgeSearchInput,
          expectedWorkspaceId: input.workspaceId,
          binding: {
            workspaceId: callbackBinding.binding.workspaceId,
            toolVersionId: callbackBinding.binding.toolVersionId,
            preparedToolVersionId: row.tool_version_id as string,
            bindingHash: callbackBinding.binding.bindingHash,
            preparedBindingHash: row.prepared_binding_hash as string,
            policyId: callbackBinding.binding.policyId,
            approvalMode: callbackBinding.binding.approvalMode,
            constraints: callbackBinding.binding.constraints,
          },
          lookupHitAuthority: (hit) => this.odb.getDB().prepare(`
            SELECT c.classification_snapshot AS classification
              FROM document_chunks c
              JOIN documents d ON d.id = c.document_id
              JOIN knowledge_bases kb ON kb.id = d.knowledge_base_id
             WHERE c.id = ? AND d.id = ? AND c.workspace_id = ?
               AND d.workspace_id = ? AND kb.workspace_id = ? AND kb.id = ?
          `).get(
            hit.chunkId, hit.documentId, input.workspaceId, input.workspaceId,
            input.workspaceId, hit.knowledgeBaseId,
          ) as { classification: DataClassification } | undefined ?? null,
        });
      }
    } catch (err) {
      // Dispatch happened, but no result satisfying the pinned contract may
      // be sealed as a receipt. Preserve that uncertainty durably for
      // recovery instead of leaving an unexplained in-flight effect.
      this.effectProtocol.recordUnknownOutcome({
        effectId: input.effectId, attemptNo: 1,
        providerStatus: 'invalid_output_schema', resolvedOutcome: null,
      });
      throw err;
    }

    // Sealing the result: plan 10 expects `recordReceipt` to be
    // called with the raw result body so the protocol seals it
    // inside the result capsule. We pass the bounded
    // KnowledgeSearchResult as-is — it is the canonical,
    // already-sanitized payload (snippets are bounded, hashes
    // are computed by the adapter).
    const receipt = this.effectProtocol.recordReceipt({
      effectId: input.effectId,
      attemptNo: 1,
      requestId: `tool-request-${input.effectId}`,
      requestHash: inputHash,
      result: result,
      applicationStatus: 'applied',
      providerStatus: 'ok',
    });

    // `tool_invocations` is pinned to the receipt at prepare time.
    // Its terminal projection (finding + completed_at) is written
    // only by the ingress finalizer's post-commit body below, so a
    // crash while dispatch is in flight cannot claim completion.


    // IndependentIngressReviewer runs the closed-set policy and
    // hands the verdict to the production IngressReviewService
    // finalizer, which moves the effect from `received` to
    // committed / quarantined / failed in one SQLite transaction
    // with payload digest, audit edges, and a recovery
    // decision row. The terminal L1 event + (accepted |
    // quarantined | rejected) audit edge are returned; we use
    // them below.
    // P0#3 fix: terminal commit + action-ledger row MUST be
    // in the SAME SQLite transaction. The previous code
    // wrapped the post-finalize writes in a SECOND
    // `db.transaction` block that ran AFTER the finalizer
    // had already committed — a crash between the two
    // transactions would leave a `committed` effect with no
    // paired tool_call ledger row.
    //
    // The reviewer owns creation of the ToolTerminalProjectionService hook;
    // callers cannot supply or substitute terminal writes through this API.
    const finalized = this.ingressReviewer.reviewAndFinalize({
      effectId: input.effectId,
      runId: row.run_id as string,
      workspaceId: input.workspaceId,
      receiptId: receipt.receiptId,
      attemptNo: 1,
      payloadDigest: receipt.resultPayloadDigest,
      source: 'agent',
      ruleVersion: 's1c-m1',
      leaseHolderId: input.holderId,
      leaseVersion: lease.leaseVersion,
    });
    // After-fix invariant: the `finalized` snapshot already
    // includes the post-commit callback's writes — they live
    // in the same SQLite transaction. The TypeScript
    // narrowing may complain about `ledgerId` being
    // uninitialized, so we assert the structural contract
    // here. A `finalized` return without a ledger row means
    // the postCommitBody threw — that exception is the only
    // way `reviewAndFinalize` returns without finishing, so
    // control flow guarantees `ledgerId` is set.
    const terminalProjection = finalized.toolProjection;
    if (!terminalProjection) {
      // Should be unreachable: postCommitBody always
      // assigns both. Belt-and-braces assertion for
      // strict mode / non-null checkers.
      throw new OgraError(OgraErrorCode.INTERNAL_ERROR,
        `invokePrepared: postCommitBody did not populate ledgerId (review=${finalized.outcome})`);
    }
    const ingressOutcome = finalized.outcome as InvocationIngressOutcome;

    const outcome: InvokePreparedResult = {
      effectId: input.effectId,
      attemptNo: 1,
      effectRevision: finalized.effectId === input.effectId
        ? (this.odb.getDB().prepare(
            'SELECT effect_revision AS r FROM run_effects WHERE id = ?',
          ).get(input.effectId) as { r: number }).r
        : 0,
      receiptId: receipt.receiptId,
      resultCapsuleRef: receipt.resultCapsuleRef,
      resultPayloadDigest: receipt.resultPayloadDigest,
      ingressOutcome,
      ingressFindingId: finalized.findingId,
      ingressReviewDecisionId: finalized.reviewDecisionId,
      actionLedgerId: terminalProjection.actionLedgerId,
      actionSequenceNo: terminalProjection.actionSequenceNo,
      l1EventId: finalized.outcomeEventId,
      ruleVersion: 's1c-m1',
    };
    // Release the recovery lease so subsequent observations on
    // the run are not blocked by a stale-holder check. The
    // outcome is already durable.
    try {
      this.runtime.releaseLease({
        runId: row.run_id as string,
        holderId: input.holderId,
        expectedLeaseVersion: lease.leaseVersion,
      });
    } catch {
      // ignore — release failures do not invalidate the durable outcome
    }
    return outcome;
  }

  /**
   * Phase 3: read the persisted state for one invocation. Returns
   * closed-set sanitized fields only.
   */
  reconcileInvocation(args: { workspaceId: string; effectId: string }):
    ReconcileInvocationResult {
    const row = this.odb.getDB().prepare(`
      SELECT e.id AS effect_id, e.state AS state,
             ti.tool_version_id AS tool_version_id,
             ti.workspace_binding_id AS workspace_binding_id,
             ti.ingress_finding_id AS ingress_finding_id,
             r.id AS receipt_id,
             r.result_capsule_ref AS result_capsule_ref,
             o.id AS observation_id,
             ird.outcome AS outcome
        FROM run_effects e
        LEFT JOIN tool_invocations ti ON ti.effect_id = e.id
        LEFT JOIN effect_receipts r
          ON r.id = e.authoritative_receipt_id AND r.effect_id = e.id
        LEFT JOIN ingress_findings iff ON iff.id = ti.ingress_finding_id
        LEFT JOIN ingress_review_decisions ird
          ON ird.ingress_finding_id = iff.id
        LEFT JOIN tool_observations o ON o.effect_id = e.id
       WHERE e.id = ? AND ti.workspace_binding_id IN (
         SELECT id FROM workspace_tool_bindings WHERE workspace_id = ?
       )
    `).get(args.effectId, args.workspaceId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new OgraError(OgraErrorCode.EFFECT_NOT_FOUND,
        `reconcileInvocation: effect ${args.effectId} not found in workspace ${args.workspaceId}`);
    }
    // The protocol-level accepted / quarantined / rejected edge
    // flows through ingress_findings.outcome where it's populated
    // by IngressReviewService.finalizeIngressDecision. We map
    // missing → 'unknown' so the renderer never sees a synthetic
    // success.
    const outcome = (row.outcome as string | undefined) ?? 'unknown';
    return {
      effectId: row.effect_id as string,
      workspaceId: args.workspaceId,
      toolVersionId: (row.tool_version_id as string) ?? '',
      workspaceBindingId: (row.workspace_binding_id as string) ?? '',
      state: row.state as string,
      ingressOutcome: outcome as InvocationIngressOutcome | 'unknown',
      ingressFindingId: (row.ingress_finding_id as string) ?? null,
      receiptId: (row.receipt_id as string) ?? null,
      resultCapsuleRef: (row.result_capsule_ref as string) ?? null,
      resultPayloadDigest: null,
      observationId: (row.observation_id as string) ?? null,
    };
  }
}

/**
 * Derive a ToolId only from a pinned descriptor/version. Display names are
 * intentionally unavailable here, so callers cannot use them as authority.
 */
export function knowledgeSearchToolId(
  descriptor: ToolDescriptor,
  version: ToolVersionDescriptor,
): string {
  return canonicalToolIdFor(descriptor, version);
}

// Re-export to silence the no-unused warning on the helper import.
export type { KnowledgeSearchInput, KnowledgeQueryPort };
// Closed-set type guard used to validate producer-supplied
// outcome strings before they touch the audit packet.
export function isAllowedOutcome(reason: string): boolean {
  return ALLOWED_OUTCOME_REASONS.has(reason);
}
