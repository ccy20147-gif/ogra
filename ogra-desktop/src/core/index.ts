import { RecoveryService } from './recovery-service';
import { RecoveryApprovalService } from './recovery-approval-service';
import { IngressReviewService } from './ingress-review-service';
import { IndependentIngressReviewer } from './independent-ingress-reviewer';
import { DefaultRecoveryConditionChecker } from './recovery-condition-checker';
import { OgraSecretBroker } from './secret-broker';
import { DatabaseService } from './database-service';
import { WorkspaceService } from './workspace-service';
import { PathValidator } from './path-validator';
import { KnowledgeService } from '../edge/knowledge-service';
import { RagEngine } from '../edge/rag-engine';
import { RunService, AdapterResolver, ResolvedAdapter } from './run-service';
import { RouteService } from './route-service';
import { AuditService } from './audit-service';
import { PolicyService } from './policy-service';
import { ProviderService } from './provider-service';
import { DataSafetyService } from './data-safety-service';
import { GovernanceService } from './governance-service';
import { InternalAgentAdapter } from '../edge/internal-agent-adapter';
import { DurableRuntimeService } from './durable-runtime-service';
import { EncryptedCapsuleStore, OgraSecretBrokerKeyProvider } from './capsule-store';
import { EffectProtocolService } from './effect-protocol-service';
import { RedactionService } from './redaction-service';
import { BaseModelAdapter } from './model-adapter';
import { OllamaAdapter, OpenAICompatibleAdapter } from '../edge/model-adapters';
import { OgraError, OgraErrorCode } from '../shared/errors';
import { DataClassification, RouteDecisionType } from '../shared/types';
import * as crypto from 'crypto';
// Sequence 1C Milestone 1 — Action Ledger + ProgressGuard + Tool Broker T1/T2.
import { ActionLedgerService } from './action-ledger';
import { ProgressGuard, ProgressGuardConfig } from './progress-guard';
import { ToolRegistry } from './tool-registry';
import {
  ToolHost, buildKnowledgeSearchDescriptor, KNOWLEDGE_SEARCH_LOGICAL_NAME,
  MAX_KNOWLEDGE_SEARCH_KB_IDS,
} from './knowledge-search-adapter';
import { CapabilityGateway } from './capability-gateway';
import { RagKnowledgeQueryAdapter } from './rag-knowledge-port';
import { canonicalToolIdFor } from './tool-broker-types';
import { ToolTerminalProjectionService } from './tool-terminal-projection';
import { ToolTraceResponse } from '../shared/ipc-channels';

export interface OgraCoreConfig {
  appDataDir: string;
  secretBroker: OgraSecretBroker;
  isDev: boolean;
  /**
   * Optional override used by tests to plug in a deterministic adapter.
   * Production must NOT pass this — Core will resolve the configured
   * Ollama / OpenAI-compatible adapter through ProviderService.
   */
  defaultAdapter?: BaseModelAdapter;
  /**
   * Core-owned ProgressGuard configuration. This is useful for deterministic
   * integration tests and future workspace policy wiring; renderer and agent
   * callers never control it per invocation.
   */
  progressGuardConfig?: ProgressGuardConfig;
}

/**
 * Ogra Core — the central application service layer.
 *
 * Sequence 0 invariants:
 *  - RunService always sees a real DatabaseService. Persistence is never
 *    optional in production.
 *  - RunService always sees a real InternalAgentAdapter (the canonical
 *    Plan + ReAct engine) plus a real AdapterResolver (production wires
 *    the configured Ollama / OpenAI-compatible adapter; tests inject
 *    a deterministic adapter).
 *  - There is no synthetic "model completion" in the production path:
 *    if no real adapter or registered model is available, the run is
 *    blocked with `NO_ACCEPTABLE_MODEL`, not silently faked.
 *  - The model name sent to /api/chat is the canonical `models.name`
 *    that the registry declared, never a derived string. OllamaAdapter
 *    validates it against the registry before the HTTP call.
 */
export class OgraCore {
  public readonly databaseService: DatabaseService;
  public readonly workspaceService: WorkspaceService;
  public readonly pathValidator: PathValidator;
  public readonly knowledgeService: KnowledgeService;
  public readonly ragEngine: RagEngine;
  public readonly runService: RunService;
  public readonly routeService: RouteService;
  public readonly auditService: AuditService;
  public readonly policyService: PolicyService;
  public readonly providerService: ProviderService;
  // Round 7: M1 recovery kernel + condition gate, wired into
  // the production recovery entry point so every crash-recovery
  // path goes through policy/route re-evaluation.
  public readonly recoveryService: RecoveryService;
  public readonly recoveryConditionChecker: DefaultRecoveryConditionChecker;
  // Round-8a (M2): ingress review + recovery approval services.
  // IngressReviewService.finalizeIngressDecision() is the
  // single entry point that moves an effect from
  // received → committed|quarantined|failed with the
  // reviewer-driven outcome, payload digest, and audit edges
  // all in one SQLite transaction.
  /** Internal finalizer; only the isolated reviewer receives its capability. */
  private readonly ingressReviewService: IngressReviewService;
  // M2 — the IndependentIngressReviewer is the SOLE entry
  // point for both the agent's production path and the
  // recovery's received/unknown finalize path. The agent /
  // recovery MUST NOT call ingressReviewService directly.
  // This indirection enforces that the verdict comes from a
  // policy that does NOT trust the producer's claimed
  // payload / outcome.
  public readonly independentIngressReviewer: IndependentIngressReviewer;
  /** Legacy recovery-approval ledger is deliberately not a public Core authority. */
  private readonly recoveryApprovalService: RecoveryApprovalService;
  public readonly dataSafetyService: DataSafetyService;
  /**
   * Sequence 1B Milestone 1 — durable effect kernel. The agent
   * uses these for `prepare -> casToInFlight -> recordReceipt |
   * recordUnknownOutcome -> commitToTerminal`. Constructed before
   * the agent so it can be wired in immediately.
   */
  public readonly durableRuntime: DurableRuntimeService;
  public readonly capsuleStore: EncryptedCapsuleStore;
  public readonly effectProtocol: EffectProtocolService;
  public readonly governanceService: GovernanceService;
  public readonly internalAgent: InternalAgentAdapter;
  public readonly redactionService: RedactionService;
  // Sequence 1C Milestone 1 — Action Ledger + ProgressGuard + Tool Broker.
  public readonly actionLedger: ActionLedgerService;
  public readonly progressGuard: ProgressGuard;
  public readonly toolRegistry: ToolRegistry;
  /** Shared terminal projection authority for live tool calls and recovery. */
  public readonly toolTerminalProjection: ToolTerminalProjectionService;
  /**
   * The ToolHost is built lazily so OgraCore construction does
   * not depend on a workspace existing. Once the caller invokes
   * `ensureKnowledgeSearchBinding(workspaceId, …)` the host is
   * bound to that workspace + KB list. Calling host-bound code
   * before any binding exists is a fail-closed PERMISSION_DENIED
   * — not a Core-construction crash.
   *
   * P0#1 fix: tool hosts are keyed by workspaceId in a Map. A
   * single-instance cache was unsafe: ensureKnowledgeSearchBinding(A)
   * followed by ensureKnowledgeSearchBinding(B) would silently
   * rebind the host to B's scope, so an A-owned run could end
   * up dispatching through B's KB scope. Per-workspace keying
   * eliminates the race.
   */
  private _toolHostsByWorkspace: Map<string, {
    host: ToolHost;
    workspaceId: string;
    enabledKnowledgeBaseIds: string[];
  }> = new Map();
  public readonly capabilityGateway: CapabilityGateway;
  /**
   * Holder id used for tool-broker leases. A single Core-wide id
   * keeps the lease table simple; the run-level CAS still
   * enforces ownership.
   */
  private readonly leaseHolderId: string;

  private readonly config: OgraCoreConfig;
  private initialized = false;

  constructor(config: OgraCoreConfig) {
    if (!config || !config.appDataDir || !config.secretBroker) {
      throw new OgraError(
        OgraErrorCode.INTERNAL_ERROR,
        'OgraCore requires appDataDir and secretBroker',
      );
    }
    this.config = config;
    this.databaseService = new DatabaseService(config.appDataDir);
    this.auditService = new AuditService(this.databaseService);
    this.pathValidator = new PathValidator();
    this.policyService = new PolicyService(this.auditService);
    this.routeService = new RouteService(this.policyService);
    this.workspaceService = new WorkspaceService(this.auditService, this.databaseService);
    this.providerService = new ProviderService(this.auditService);
    this.ragEngine = new RagEngine(this.databaseService);
    this.redactionService = new RedactionService(this.databaseService);

    // Sequence 1B Milestone 1 — wire the durable effect kernel.
    // The capsule store derives its per-workspace keys from the
    // OgraSecretBroker — no plaintext key is ever persisted.
    this.durableRuntime = new DurableRuntimeService(
      this.databaseService.getOgraDatabase(),
      () => this.policyService.getPolicyVersionHash(),
      () => this.redactionService.getCurrentRuleVersion(),
    );
    this.capsuleStore = new EncryptedCapsuleStore(
      this.databaseService.getOgraDatabase(),
      new OgraSecretBrokerKeyProvider(
        config.secretBroker.deriveWorkspaceKey('capsule.v1', '__default__'),
      ),
    );
    this.effectProtocol = new EffectProtocolService(
      this.databaseService.getOgraDatabase(),
      this.durableRuntime,
      this.capsuleStore,
    );

    // Round 7: build the recovery kernel + condition gate.
    // The gate re-evaluates policy + route against the current
    // policy_service / route_service on every retry, fail-closed
    // when (a) approval is revoked / expired / fingerprint / scope
    // / policy_version drift; or (b) the current policy no longer
    // permits the persisted route.
    this.recoveryConditionChecker = new DefaultRecoveryConditionChecker(
      this.databaseService.getOgraDatabase(),
      this.policyService,
      this.routeService,
      // Resolve only the route decision bound to the recovering effect.
      // A run can contain several route decisions; selecting its newest row
      // would let a later route authorize an earlier effect. Missing evidence
      // returns null and the checker fails closed.
      ({ runId, routeDecisionId }) => {
        const runRow = this.databaseService.getRawDB().prepare(`
          SELECT workspace_id, task
            FROM agent_runs WHERE id = ?
        `).get(runId) as
          { workspace_id: string; task: string } | undefined;
        const routeRow = this.databaseService.getRawDB().prepare(`
          SELECT data_classification, provider_id, model_id
            FROM route_decisions
            WHERE id = ? AND run_id = ?
        `).get(routeDecisionId, runId) as
          { data_classification: string; provider_id: string | null;
            model_id: string | null } | undefined;
        if (!runRow || !routeRow) return null;
        return {
          workspaceId: runRow.workspace_id,
          dataClassification: routeRow.data_classification as DataClassification,
          task: runRow.task,
          providerId: routeRow.provider_id,
          modelId: routeRow.model_id,
        };
      },
      () => this.redactionService.getCurrentRuleVersion(),
    );
    // Repair has the same policy/route/redaction authority boundary as
    // recovery. Its synchronous compatibility methods now fail closed for
    // M1 effects; Core-owned callers must await the checked API.
    this.durableRuntime.attachRepairConditionChecker(this.recoveryConditionChecker);
    // The checker is configured on the service itself, not merely supplied by
    // OgraCore.recover().  This keeps the production gate in force even when
    // another Core component holds recoveryService directly.
    this.toolTerminalProjection = new ToolTerminalProjectionService(
      this.databaseService.getOgraDatabase(), this.durableRuntime,
      this.capsuleStore,
    );
    this.recoveryService = new RecoveryService(
      this.databaseService.getOgraDatabase(),
      this.durableRuntime,
      this.capsuleStore,
      this.effectProtocol,
      this.recoveryConditionChecker,
      // placeholder; replaced after ingressReviewService is built
      undefined as any,
      this.toolTerminalProjection,
    );

    // Round-8a (M2): ingress review + recovery approval services.
    // IngressReviewService operates on verified result capsules.
    this.ingressReviewService = new IngressReviewService(
      this.databaseService.getOgraDatabase(),
      this.durableRuntime,
      this.capsuleStore,
    );
    // IndependentIngressReviewer is the SOLE entry point for
    // finalize; it composes the policy verdict with the
    // canonical finalize transaction. The agent + recovery
    // depend on this class (not on IngressReviewService
    // directly) so a producer cannot self-author its verdict.
    this.independentIngressReviewer = new IndependentIngressReviewer(
      this.databaseService.getOgraDatabase(),
      this.durableRuntime,
      this.capsuleStore,
      this.ingressReviewService,
      this.toolTerminalProjection,
    );
    // RecoveryApprovalService mints per-retry approvals.
    this.recoveryApprovalService = new RecoveryApprovalService(
      this.databaseService.getOgraDatabase(),
      this.durableRuntime,
    );
    // Wire the independent reviewer into RecoveryService now
    // that both are constructed. This is the M2 production
    // gate: recovery's received / unknown finalize paths go
    // through the reviewer, not directly to terminal state.
    (this.recoveryService as unknown as {
      independentIngressReviewer: IndependentIngressReviewer;
    }).independentIngressReviewer = this.independentIngressReviewer;

    this.internalAgent = new InternalAgentAdapter(
      this.databaseService,
      this.policyService,
      this.routeService,
      null,
      this.ragEngine,
      this.redactionService,
    );

    // Adapter resolver — production wires the registered ProviderService
    // and OgraSecretBroker; the only path that returns a real adapter.
    // There is no "synthetic completion" branch: if no real adapter can
    // be resolved, the run is blocked. Tests can override via config.
    const defaultAdapter = config.defaultAdapter;
    const resolveAdapter: AdapterResolver = async ({
      requestedProviderId,
      requestedModelId,
    }) => {
      if (defaultAdapter) {
        // Tests use the deterministic adapter exactly as injected.
        // We still need a canonical model name to satisfy the adapter
        // contract; allow the test to provide its own.
        return {
          adapter: defaultAdapter,
          modelInternalId: requestedModelId ?? 'test_model',
          modelName: requestedModelId ?? 'test_model',
          providerId: defaultAdapter.providerId,
        } satisfies ResolvedAdapter;
      }

      // 1. Resolve provider: explicit requested > first local > first cloud.
      const provider = requestedProviderId
        ? await this.providerService.getProvider(requestedProviderId).catch(() => null)
        : this.providerService.getLocalProviders()[0]
          ?? this.providerService.getCloudProviders()[0];

      if (!provider) {
        throw new OgraError(
          OgraErrorCode.NO_ACCEPTABLE_MODEL,
          'No configured model provider; configure one in Settings before running a task',
        );
      }
      if (!provider.enabled) {
        throw new OgraError(
          OgraErrorCode.NO_ACCEPTABLE_MODEL,
          `Provider ${provider.id} is disabled`,
        );
      }

      // 2. Resolve model name from the registry. The model name must
      //    match a row in `models` for this provider; we resolve
      //    explicit > first enabled.
      const { models } = await this.providerService.list();
      const enabledModels = models.filter(m => m.providerId === provider.id && m.enabled);
      const model = requestedModelId
        ? enabledModels.find(m => m.id === requestedModelId || m.name === requestedModelId)
        : enabledModels[0];
      if (!model) {
        throw new OgraError(
          OgraErrorCode.NO_ACCEPTABLE_MODEL,
          requestedModelId
            ? `Model "${requestedModelId}" is not registered for provider ${provider.id}`
            : `Provider ${provider.id} has no enabled models`,
        );
      }

      // 3. Construct the adapter. OllamaAdapter (and OpenAICompatible)
      //    both validate the model name against the registry themselves
      //    so any drift is caught before the HTTP call.
      if (provider.isLocal || provider.id === 'ollama_local' || provider.kind === 'ollama') {
        const adapter = new OllamaAdapter(
          provider.endpoint,
          model.name,
          config.secretBroker,
          this.auditService,
          this.providerService,
        );
        return {
          adapter,
          modelInternalId: model.id,
          modelName: model.name,
          providerId: provider.id,
        };
      }
      const adapter = new OpenAICompatibleAdapter(
        provider.id,
        provider.endpoint,
        model.name,
        config.secretBroker,
        false,
        this.auditService,
        this.providerService,
      );
      return {
        adapter,
        modelInternalId: model.id,
        modelName: model.name,
        providerId: provider.id,
      };
    };

    this.runService = new RunService(
      this.workspaceService,
      this.routeService,
      this.auditService,
      this.policyService,
      this.databaseService,
      this.providerService,
      config.secretBroker,
      config,
      this.ragEngine,
      resolveAdapter,
      this.internalAgent,
      this.redactionService,
    );

    // Wire the canonical RunService into InternalAgentAdapter so the
    // agent can read loadApproval(...) when checking approval-bound
    // redaction paths. InternalAgentAdapter must call bindRunService
    // because RunService cannot be passed at agent construction time
    // (it depends on the agent).
    this.internalAgent.bindRunService(this.runService);
    // Sequence 1B Milestone 1 — wire the durable effect kernel
    // into the agent so production model calls go through
    // prepare / casToInFlight / recordReceipt / commitToTerminal.
    this.internalAgent.bindKernel({
      runtime: this.durableRuntime,
      protocol: this.effectProtocol,
      independentIngressReviewer: this.independentIngressReviewer,
    });

    this.knowledgeService = new KnowledgeService(this.auditService, this.pathValidator, config, this.ragEngine, this.databaseService);
    this.dataSafetyService = new DataSafetyService(this.auditService, this.workspaceService, this.databaseService);
    this.governanceService = new GovernanceService(this.auditService);

    // Sequence 1C Milestone 1 — Action Ledger, ProgressGuard and
    // Tool Broker T1/T2 wiring. These services are constructed
    // AFTER the durable kernel so they can use its
    // transactionalAppend, the ingress reviewer, and the
    // effect protocol. They are constructed BEFORE initialize()
    // because the seed step below runs during initialize and
    // needs them.
    this.actionLedger = new ActionLedgerService(
      this.databaseService.getOgraDatabase(),
      this.durableRuntime,
    );
    this.progressGuard = new ProgressGuard(
      this.databaseService.getOgraDatabase(),
      this.durableRuntime,
      config.progressGuardConfig,
    );
    this.toolRegistry = new ToolRegistry(
      this.databaseService.getOgraDatabase(),
      this.durableRuntime,
    );
    this.leaseHolderId = `ogracore-tool-broker-${crypto.randomBytes(4).toString('hex')}`;
    this.capabilityGateway = new CapabilityGateway({
      odb: this.databaseService.getOgraDatabase(),
      runtime: this.durableRuntime,
      effectProtocol: this.effectProtocol,
      capsuleStore: this.capsuleStore,
      ingressReviewer: this.independentIngressReviewer,
      actionLedger: this.actionLedger,
      terminalProjection: this.toolTerminalProjection,
      toolRegistry: this.toolRegistry,
      // Lazy resolve with per-workspace keying (P0#1). The
      // resolver returns the ToolHost bound to the workspace
      // the caller is operating in. A workspace without a
      // bound ToolHost gets a fresh fail-closed host — the
      // dispatch() call then raises PERMISSION_DENIED with a
      // specific "not bound to this workspace" diagnostic.
      resolveToolHost: (workspaceId?: string) => this.getOrBuildToolHost(workspaceId),
      getLeaseHolderId: () => this.leaseHolderId,
      // P0#2 — Real policy / route evaluation in production.
      // The gateway persists a real `policy_evaluations` row
      // (computed from workspace default + tool effect_class +
      // binding policy), not a literal `decision: 'allow'`
      // stub. Production wires the real services; legacy
      // fixtures that omit these fields keep the legacy
      // semantics, so the M1 broker fixture stays green.
      policyService: this.policyService,
      routeService: this.routeService,
      // P0#4 — ProgressGuard threading. Every tool call
      // observes against the guard; an `ok=false` decision
      // aborts the dispatch fail-closed.
      progressGuard: this.progressGuard,
    });
    this.internalAgent.bindToolBroker(this.capabilityGateway);
  }

  /**
   * Get-or-build a ToolHost for one workspaceId. Per-workspace
   * keying (P0#1) means each binding lives in its own slot of
   * `_toolHostsByWorkspace`. A workspaceId not yet present gets
   * a placeholder host whose `dispatch()` raises PERMISSION_DENIED
   * with the canonical "not bound to this workspace" message;
   * the production path always pairs this with `ensureKnowledgeSearchBinding`
   * before `invokePrepared`, so the placeholder is the
   * contract-violation diagnostic surface.
   */
  private getOrBuildToolHost(workspaceId?: string): ToolHost {
   // Fall back to a shared placeholder host if a caller
   // didn't supply a workspaceId; production paths always
   // supply one.
   const wsid = workspaceId ?? '__t1_unbound__';
   const cached = this._toolHostsByWorkspace.get(wsid);
   if (cached) return cached.host;
   const placeholder = new ToolHost(
     new RagKnowledgeQueryAdapter({
       ragEngine: this.ragEngine,
       databaseService: this.databaseService,
     }),
     { knowledgeSearch: {
       workspaceId: wsid,
       enabledKnowledgeBaseIds: [],
       maxSnippetBytes: 4096,
     } },
   );
   this._toolHostsByWorkspace.set(wsid, {
     host: placeholder,
     workspaceId: wsid,
     enabledKnowledgeBaseIds: [],
   });
   return placeholder;
 }

  /**
   * Sequence 1C Milestone 1 — Seed the canonical built-in
   * read-only tool (knowledge.search v1) once per workspace. The
   * seed runs inside the durable runtime so a binding change is
   * a versioned event. Runs the first time OgraCore is asked for
   * a tool-broker operation, so test fixtures without any
   * workspace are unaffected.
   */
  async ensureKnowledgeSearchBinding(workspaceId: string, opts?: {
    enabledKnowledgeBaseIds?: string[];
    maxSnippetBytes?: number;
    approvalMode?: 'none' | 'allowlist' | 'each_call' | 'workflow_step' | 'administrative';
    policyId?: string | null;
  }): Promise<{
    descriptorId: string;
    toolVersionId: string;
    bindingId: string;
    toolId: string;
  }> {
    // Verify the workspace actually exists — fail closed on a
    // bogus caller.
    const row = this.databaseService.getRawDB().prepare(
      'SELECT id FROM workspaces WHERE id = ?',
    ).get(workspaceId) as { id: string } | undefined;
    if (!row) {
      throw new OgraError(OgraErrorCode.WORKSPACE_NOT_FOUND,
        `ensureKnowledgeSearchBinding: workspace ${workspaceId} not found`);
    }
    const existing = this.databaseService.getRawDB().prepare(`
      SELECT b.tool_version_id AS tool_version_id,
             b.id AS binding_id,
             b.binding_hash_version AS binding_hash_version,
             b.constraints_json AS constraints_json,
             b.approval_mode AS approval_mode,
             b.policy_id AS policy_id,
             v.descriptor_id AS descriptor_id,
             v.status AS version_status,
             d.lifecycle_state AS descriptor_lifecycle
        FROM workspace_tool_bindings b
        JOIN tool_versions v ON v.id = b.tool_version_id
        JOIN tool_descriptors d ON d.id = v.descriptor_id
       WHERE b.workspace_id = ?
         AND b.logical_binding_id = ?
         AND b.enabled = 1
         AND d.logical_name = ?
       ORDER BY b.revision DESC
       LIMIT 1
    `).get(
      workspaceId,
      `tbind_knowledge_search_${workspaceId}`,
      KNOWLEDGE_SEARCH_LOGICAL_NAME,
    ) as
      { tool_version_id: string; binding_id: string; descriptor_id: string;
        binding_hash_version: number; version_status: string;
        descriptor_lifecycle: string; constraints_json: string;
        approval_mode: 'none' | 'allowlist' | 'each_call' | 'workflow_step' | 'administrative';
        policy_id: string | null; } | undefined;
    let existingAuthority: {
      enabledKnowledgeBaseIds: string[];
      maxSnippetBytes: number;
    } | null = null;
    if (existing
        && existing.binding_hash_version === 2
        && existing.version_status === 'enabled'
        && existing.descriptor_lifecycle === 'enabled') {
      try {
        const constraints = JSON.parse(existing.constraints_json) as {
          enabledKnowledgeBaseIds?: unknown;
          maxSnippetBytes?: unknown;
        };
        if (!Array.isArray(constraints.enabledKnowledgeBaseIds)
            || constraints.enabledKnowledgeBaseIds.length > MAX_KNOWLEDGE_SEARCH_KB_IDS
            || constraints.enabledKnowledgeBaseIds.some((id) => typeof id !== 'string' || !id)
            || new Set(constraints.enabledKnowledgeBaseIds).size
              !== constraints.enabledKnowledgeBaseIds.length
            || !Number.isInteger(constraints.maxSnippetBytes)
            || (constraints.maxSnippetBytes as number) < 1
            || (constraints.maxSnippetBytes as number) > 4096) {
          throw new Error('invalid knowledge.search constraints');
        }
        existingAuthority = {
          enabledKnowledgeBaseIds: [...constraints.enabledKnowledgeBaseIds],
          maxSnippetBytes: constraints.maxSnippetBytes as number,
        };
      } catch {
        throw new OgraError(OgraErrorCode.DATABASE_ERROR,
          `ensureKnowledgeSearchBinding: persisted binding ${existing.binding_id} has invalid constraints`);
      }
    }

    if (opts?.maxSnippetBytes !== undefined
        && (!Number.isInteger(opts.maxSnippetBytes)
          || opts.maxSnippetBytes < 1 || opts.maxSnippetBytes > 4096)) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'ensureKnowledgeSearchBinding: maxSnippetBytes must be an integer from 1 to 4096');
    }
    if (opts?.enabledKnowledgeBaseIds
        && (opts.enabledKnowledgeBaseIds.length > MAX_KNOWLEDGE_SEARCH_KB_IDS
          || opts.enabledKnowledgeBaseIds.some(
      (id) => typeof id !== 'string' || id.length === 0,
    ))) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'ensureKnowledgeSearchBinding: enabledKnowledgeBaseIds must contain 1 to 32 non-empty strings');
    }

    const enabledKBs = [...new Set(
      opts?.enabledKnowledgeBaseIds
        ?? existingAuthority?.enabledKnowledgeBaseIds
        ?? [],
    )];
    const maxSnippetBytes = opts?.maxSnippetBytes
      ?? existingAuthority?.maxSnippetBytes
      ?? 4096;
    const approvalMode = opts?.approvalMode ?? existing?.approval_mode ?? 'none';
    const policyId = opts?.policyId !== undefined
      ? opts.policyId
      : existing?.policy_id ?? null;
    const sameKnowledgeBaseScope = existingAuthority !== null
      && existingAuthority.enabledKnowledgeBaseIds.length === enabledKBs.length
      && existingAuthority.enabledKnowledgeBaseIds.every((id) => enabledKBs.includes(id));
    const canReuseExisting = existing !== undefined
      && existingAuthority !== null
      && sameKnowledgeBaseScope
      && existingAuthority.maxSnippetBytes === maxSnippetBytes
      && existing.approval_mode === approvalMode
      && existing.policy_id === policyId;

    if (canReuseExisting && existing && existingAuthority) {
      const tuple = this.toolRegistry.getDescriptorAndVersion(existing.tool_version_id)!;
      this.installKnowledgeSearchHost(
        workspaceId,
        existingAuthority.enabledKnowledgeBaseIds,
        existingAuthority.maxSnippetBytes,
      );
      return {
        descriptorId: existing.descriptor_id,
        toolVersionId: existing.tool_version_id,
        bindingId: existing.binding_id,
        toolId: canonicalToolIdFor(tuple.descriptor, tuple.version),
      };
    }

    let descriptorId: string;
    let toolVersionId: string;
    if (existing && existingAuthority) {
      descriptorId = existing.descriptor_id;
      toolVersionId = existing.tool_version_id;
    } else {
      const desc = buildKnowledgeSearchDescriptor();
      const upsert = await this.toolRegistry.upsertToolVersion(desc);
      this.toolRegistry.setVersionStatus(upsert.toolVersionId, 'enabled');
      descriptorId = upsert.descriptorId;
      toolVersionId = upsert.toolVersionId;
    }
    const binding = this.toolRegistry.bindWorkspaceVersion({
      workspaceId,
      toolVersionId,
      approvalMode,
      constraints: {
        enabledKnowledgeBaseIds: enabledKBs,
        maxSnippetBytes,
      },
      policyId,
      logicalBindingId: `tbind_knowledge_search_${workspaceId}`,
      supersedePriorRevisions: true,
    });
    // Bind (or rebind) the ToolHost for THIS workspace to the
    // KBs so dispatch() becomes legitimate. Tests that drive the
    // broker through Core.run path will fail-closed
    // PERMISSION_DENIED until this is called. P0#1 fix: each
    // workspace gets its own ToolHost entry; no global rebind.
    this.installKnowledgeSearchHost(workspaceId, enabledKBs, maxSnippetBytes);
    const tuple = this.toolRegistry.getDescriptorAndVersion(toolVersionId)!;
    return {
      descriptorId,
      toolVersionId,
      bindingId: binding.id,
      toolId: canonicalToolIdFor(tuple.descriptor, tuple.version),
    };
  }

  private installKnowledgeSearchHost(
    workspaceId: string,
    enabledKnowledgeBaseIds: string[],
    maxSnippetBytes: number,
  ): void {
    const host = new ToolHost(
      new RagKnowledgeQueryAdapter({
        ragEngine: this.ragEngine,
        databaseService: this.databaseService,
      }),
      { knowledgeSearch: {
        workspaceId,
        enabledKnowledgeBaseIds: [...enabledKnowledgeBaseIds],
        maxSnippetBytes,
      } },
    );
    this._toolHostsByWorkspace.set(workspaceId, {
      host, workspaceId,
      enabledKnowledgeBaseIds: [...enabledKnowledgeBaseIds],
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    // Initialize database (migrations, schema creation)
    this.databaseService.initialize();
    this.initialized = true;
  }

  /**
   * Series 1B Milestone 1 Round 7: production recovery entry
   * point. Wraps `RecoveryService.recover()` and ALWAYS injects
   * the OgraCore-wired condition checker (policy + route
   * revalidation). Tests can still pass `conditionChecker:
   * undefined` to bypass, but the production path is fail-closed.
   *
   * The wrapping matches the contract callers expect: input
   * fields other than `conditionChecker` are passed through verbatim. The
   * service also owns this same configured checker, so direct service calls
   * cannot bypass the gate either.
   */
  async recover(input: Parameters<RecoveryService['recover']>[0]):
    ReturnType<RecoveryService['recover']> {
    const merged = {
      ...input,
      // Round 7: default to the OgraCore-wired checker. Test
      // callers that explicitly pass `conditionChecker` will
      // be overridden here — that is intentional, because the
      // production path must not be silently weakened. Tests
      // that need a custom checker should use RecoveryService
      // directly.
      conditionChecker: this.recoveryConditionChecker,
    };
    return this.recoveryService.recover(merged);
  }

  /**
   * Sequence 1B Milestone 2 — return a sanitized snapshot of
   * every effect in the run. The shape carries ONLY refs /
   * hashes / state names + sanitized reason codes — NEVER
   * raw payload bytes, secrets, or response bodies. The
   * renderer (and any other consumer) is responsible for
   * passing this array through a closed-set renderer; the
   * closed-set is enforced in
   * `src/renderer/components/EffectStateBadge.tsx`.
   */
  effectStatusList(runId: string): Array<{
    effectId: string;
    state: string;
    sanitizedReasonCode: string | null;
    awaitingApproval: boolean;
    recoveryDecision: { decisionCode: string; sanitizedReason: string | null } | null;
  }> {
    if (!runId) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'effectStatusList: runId is required');
    }
    // Read every effect row + the most recent recovery_decisions
    // row for each. The result carries no payload fields.
    // Note: recovery_decisions has no sanitized_reason_code
    // column — the sanitized reason lives on the
    // ingress_review_decisions / ingress_findings rows.
    // We use incident_kind (always present in
    // recovery_decisions) as the surfaced reason, falling
    // back to e.interrupted_reason_code.
    const db = this.databaseService.getRawDB();
    const effectRows = db.prepare(`
      SELECT e.id AS effect_id, e.state AS state,
             COALESCE(rr.incident_kind, e.interrupted_reason_code)
               AS sanitized_reason_code,
             CASE WHEN e.state IN ('planned', 'unknown', 'awaiting_callback_verification')
                       AND e.current_approval_id IS NOT NULL
                  THEN 1 ELSE 0 END
               AS awaiting_approval,
             rr.decision_code AS recovery_decision_code,
             rr.final_state AS recovery_final_state
        FROM run_effects e
        LEFT JOIN recovery_decisions rr
          ON rr.effect_id = e.id
         AND rr.created_at = (
           SELECT MAX(created_at) FROM recovery_decisions
            WHERE effect_id = e.id
         )
       WHERE e.run_id = ?
       ORDER BY e.created_at
    `).all(runId) as Array<{
      effect_id: string; state: string; sanitized_reason_code: string | null;
      awaiting_approval: number; recovery_decision_code: string | null;
      recovery_final_state: string | null;
    }>;
    return effectRows.map((row) => ({
      effectId: row.effect_id,
      state: row.state,
      sanitizedReasonCode: row.sanitized_reason_code ?? null,
      awaitingApproval: row.awaiting_approval === 1,
      recoveryDecision: row.recovery_decision_code
        ? { decisionCode: row.recovery_decision_code,
            sanitizedReason: null }
        : null,
    }));
  }

  /**
   * Plan 11 T2 renderer/governance projection for one run's Tool Broker
   * evidence. The requested workspace is verified against `agent_runs`
   * before any invocation row is read. This query deliberately projects
   * immutable refs and closed-set outcomes only: raw tool arguments,
   * results, payload digests, secret material, and capsule references do not
   * cross this Core boundary.
   */
  toolTraceForRun(args: { workspaceId: string; runId: string }): ToolTraceResponse {
    if (!args.workspaceId || !args.runId) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'toolTraceForRun: workspaceId and runId are required');
    }
    const db = this.databaseService.getRawDB();
    const run = db.prepare(
      'SELECT workspace_id FROM agent_runs WHERE id = ?',
    ).get(args.runId) as { workspace_id: string } | undefined;
    if (!run) {
      throw new OgraError(OgraErrorCode.RUN_NOT_FOUND,
        `toolTraceForRun: run ${args.runId} was not found`);
    }
    if (run.workspace_id !== args.workspaceId) {
      throw new OgraError(OgraErrorCode.WORKSPACE_MISMATCH,
        `toolTraceForRun: run ${args.runId} does not belong to workspace ${args.workspaceId}`);
    }

    const rows = db.prepare(`
      SELECT e.id AS effect_id, e.state AS effect_state, e.created_at AS created_at,
             v.id AS tool_version_id, v.source_version AS source_version,
             b.id AS workspace_binding_id, b.revision AS binding_revision,
             r.id AS receipt_id,
             ti.ingress_finding_id AS ingress_finding_id,
             ird.outcome AS ingress_outcome,
             o.id AS observation_id, o.created_event_id AS observation_event_id,
             al.id AS action_ledger_id, al.l1_event_id AS action_ledger_event_id,
             al.sequence_no AS action_sequence_no
        FROM tool_invocations ti
        JOIN run_effects e ON e.id = ti.effect_id AND e.run_id = ?
        JOIN tool_versions v ON v.id = ti.tool_version_id
        JOIN workspace_tool_bindings b
          ON b.id = ti.workspace_binding_id AND b.workspace_id = ?
        LEFT JOIN effect_receipts r
          ON r.id = e.authoritative_receipt_id AND r.effect_id = e.id
        LEFT JOIN ingress_findings iff ON iff.id = ti.ingress_finding_id
        LEFT JOIN ingress_review_decisions ird
          ON ird.ingress_finding_id = iff.id
        LEFT JOIN tool_observations o ON o.effect_id = e.id AND o.run_id = e.run_id
        LEFT JOIN action_ledger al ON al.id = (
          SELECT id FROM action_ledger
           WHERE effect_id = e.id AND run_id = e.run_id
           ORDER BY sequence_no DESC LIMIT 1
        )
       ORDER BY e.created_at ASC
    `).all(args.runId, args.workspaceId) as Array<{
      effect_id: string; effect_state: string; created_at: string;
      tool_version_id: string; source_version: string;
      workspace_binding_id: string; binding_revision: number;
      receipt_id: string | null; ingress_finding_id: string | null;
      ingress_outcome: string | null; observation_id: string | null;
      observation_event_id: string | null; action_ledger_id: string | null;
      action_ledger_event_id: string | null; action_sequence_no: number | null;
    }>;
    const allowedOutcomes = new Set(['accepted', 'quarantined', 'rejected']);
    return {
      workspaceId: args.workspaceId,
      runId: args.runId,
      invocations: rows.map((row) => ({
        effectId: row.effect_id,
        effectState: row.effect_state,
        toolVersionId: row.tool_version_id,
        sourceVersion: row.source_version,
        workspaceBindingId: row.workspace_binding_id,
        bindingRevision: row.binding_revision,
        receiptId: row.receipt_id,
        ingressOutcome: allowedOutcomes.has(row.ingress_outcome ?? '')
          ? row.ingress_outcome as 'accepted' | 'quarantined' | 'rejected'
          : 'unknown',
        ingressFindingId: row.ingress_finding_id,
        observationId: row.observation_id,
        observationEventId: row.observation_event_id,
        actionLedgerId: row.action_ledger_id,
        actionLedgerEventId: row.action_ledger_event_id,
        actionSequenceNo: row.action_sequence_no,
        createdAt: row.created_at,
      })),
    };
  }

  /**
   * Restricted quarantine projection. This deliberately does not expose the
   * sealed capsule reference or content: callers receive only the incident
   * summary needed to show a risk notification/sandbox placeholder.
   */
  quarantineRead(quarantineId: string): {
    id: string;
    runId: string;
    ingressFindingId: string;
    summary: string;
    classification: string;
    status: string;
    userCanView: boolean;
    createdAt: string;
  } {
    if (!quarantineId) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'quarantineRead: quarantine id is required');
    }
    const row = this.databaseService.getRawDB().prepare(`
      SELECT id, run_id, ingress_finding_id, summary, classification,
             status, user_can_view, created_at
        FROM quarantine_contents WHERE id = ?
    `).get(quarantineId) as {
      id: string; run_id: string; ingress_finding_id: string; summary: string;
      classification: string; status: string; user_can_view: number; created_at: string;
    } | undefined;
    if (!row) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'quarantineRead: quarantine content was not found');
    }
    return {
      id: row.id, runId: row.run_id, ingressFindingId: row.ingress_finding_id,
      summary: row.summary, classification: row.classification, status: row.status,
      userCanView: row.user_can_view === 1, createdAt: row.created_at,
    };
  }

  /**
   * Create the only approval type that may authorize a second physical
   * callback after an effect became unknown.  It is deliberately a Core API,
   * not a generic recovery SQL helper: the effect revision, payload, scope,
   * active policy, and persisted route are all checked before any approval
   * can be presented to a user.
   */
  async requestRecoveryApproval(input: {
    runId: string;
    workspaceId: string;
    effectId: string;
    requestedScope: Record<string, unknown>;
    expiresAt?: string;
    reason?: string;
  }): Promise<{ id: string; status: 'pending'; scopeHash: string; effectRevision: number }> {
    if (!input.runId || !input.workspaceId || !input.effectId
        || !input.requestedScope || typeof input.requestedScope !== 'object') {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'runId, workspaceId, effectId, and requestedScope are required');
    }
    const db = this.databaseService.getRawDB();
    const run = db.prepare('SELECT id, workspace_id FROM agent_runs WHERE id = ?')
      .get(input.runId) as { id: string; workspace_id: string } | undefined;
    if (!run) {
      throw new OgraError(OgraErrorCode.RUN_NOT_FOUND,
        'Recovery approval run was not found');
    }
    if (run.workspace_id !== input.workspaceId) {
      throw new OgraError(OgraErrorCode.WORKSPACE_MISMATCH,
        'Recovery approval workspace does not own the run');
    }

    const effect = this.durableRuntime.readEffect(input.effectId);
    if (effect.runId !== input.runId) {
      throw new OgraError(OgraErrorCode.EFFECT_OWNER_MISMATCH,
        'Recovery approval effect does not belong to the run');
    }
    if (effect.state !== 'unknown') {
      throw new OgraError(OgraErrorCode.EFFECT_INVALID_TRANSITION,
        `Recovery approval requires an unknown effect (was ${effect.state})`);
    }
    if (!effect.payloadFingerprint || !effect.scopeHash || !effect.policyVersionHash
        || !effect.routeDecisionId) {
      throw new OgraError(OgraErrorCode.APPROVAL_REQUIRED,
        'Recovery approval requires complete persisted effect bindings');
    }
    const scopeJson = JSON.stringify(input.requestedScope);
    const scopeHash = crypto.createHash('sha256').update(scopeJson).digest('hex');
    if (scopeHash !== effect.scopeHash) {
      throw new OgraError(OgraErrorCode.APPROVAL_REQUIRED,
        'Recovery approval scope does not match the effect binding');
    }
    const currentPolicyVersion = this.policyService.getPolicyVersionHash();
    if (currentPolicyVersion !== effect.policyVersionHash) {
      throw new OgraError(OgraErrorCode.POLICY_BLOCKED,
        'Recovery approval cannot be issued against a stale policy version');
    }
    if (input.expiresAt && input.expiresAt <= new Date().toISOString()) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'Recovery approval expiry must be in the future');
    }

    const route = db.prepare(`
      SELECT id, run_id, route, data_classification, provider_id, model_id,
             high_water_sources_json
        FROM route_decisions WHERE id = ? AND run_id = ?
    `).get(effect.routeDecisionId, input.runId) as {
      id: string; run_id: string; route: string; data_classification: string;
      provider_id: string | null; model_id: string | null;
      high_water_sources_json: string | null;
    } | undefined;
    if (!route || route.route === RouteDecisionType.Blocked) {
      throw new OgraError(OgraErrorCode.ROUTE_BLOCKED,
        'Recovery approval route is missing or blocked');
    }
    let highWaterSources: Array<{ sourceType: string; sourceId: string; classification: string }> | undefined;
    if (route.high_water_sources_json) {
      try {
        const parsed = JSON.parse(route.high_water_sources_json);
        if (!Array.isArray(parsed)) throw new Error('invalid high-water sources');
        highWaterSources = parsed;
      } catch {
        throw new OgraError(OgraErrorCode.ROUTE_BLOCKED,
          'Recovery approval route has invalid high-water evidence');
      }
    }
    const isCloudRoute = route.route === RouteDecisionType.Cloud
      || route.route === RouteDecisionType.Hybrid
      || route.route === RouteDecisionType.Redact_Then_Egress;
    const currentRoute = await this.routeService.evaluateRoute({
      workspaceId: input.workspaceId,
      dataClassification: route.data_classification as DataClassification,
      providerId: route.provider_id ?? undefined,
      modelId: route.model_id ?? undefined,
      requestedCompute: isCloudRoute ? 'cloud' : 'local',
      requiresCloud: isCloudRoute,
      hasUserApproval: true,
      highWaterSources,
    });
    if (currentRoute.route !== route.route) {
      throw new OgraError(OgraErrorCode.POLICY_BLOCKED,
        `Recovery approval route drift: persisted=${route.route} current=${currentRoute.route}`);
    }

    const id = `apr_recovery_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    // A recovery retry needs an explicit human/Core approval decision. This
    // records a standard pending approval bound to this exact effect revision;
    // it does not mint a usable rap_* capability and cannot invoke a retry.
    // Once approved, EffectProtocolService consumes this row atomically with
    // callback intent under the recovery lease.
    this.durableRuntime.transactionalAppend({
      meta: {
        runId: input.runId,
        workspaceId: input.workspaceId,
        eventType: 'recovery_approval_requested',
        eventPayload: {
          effectId: effect.id,
          effectRevision: effect.effectRevision,
          approvalType: 'recovery_retry',
          scopeHash,
          payloadFingerprint: effect.payloadFingerprint,
          policyVersionHash: currentPolicyVersion,
          expiresAt: input.expiresAt ?? null,
        },
        effectId: effect.id,
        policyVersionHash: currentPolicyVersion,
      },
      body: (eventId) => {
        const insert = db.prepare(`
          INSERT INTO approvals
            (id, run_id, workspace_id, approval_type, requested_scope_json,
             scope_hash, payload_fingerprint, policy_version_hash,
             redaction_rule_version, expires_at, decision, created_at,
             use_limit, uses_consumed, effect_id, effect_revision, reason)
          VALUES (?, ?, ?, 'recovery_retry', ?, ?, ?, ?, ?, ?, 'pending',
                  ?, 1, 0, ?, ?, ?)
        `).run(
          id, input.runId, input.workspaceId, scopeJson, scopeHash,
          effect.payloadFingerprint, currentPolicyVersion,
          effect.redactionRuleVersion, input.expiresAt ?? null, now,
          effect.id, effect.effectRevision, input.reason ?? null,
        );
        if (insert.changes !== 1) {
          throw new OgraError(OgraErrorCode.REVISION_CONFLICT,
            'Recovery approval request insert lost');
        }
        this.durableRuntime.appendEdge({
          runId: input.runId,
          fromKind: 'effect', fromId: effect.id,
          relation: 'recovery_approval_requested',
          toKind: 'approval', toId: id,
          sourceEventId: eventId,
        });
        return { id };
      },
    });
    return {
      id,
      status: 'pending',
      scopeHash,
      effectRevision: effect.effectRevision,
    };
  }

  shutdown(): void {
    // Cleanup resources — close DB connection, release locks
    this.databaseService.close();
    this.initialized = false;
  }
}
