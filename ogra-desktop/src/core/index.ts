import { RecoveryService } from './recovery-service';
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
    this.recoveryService = new RecoveryService(
      this.databaseService.getOgraDatabase(),
      this.durableRuntime,
      this.capsuleStore,
      this.effectProtocol,
      this.recoveryConditionChecker,
    );

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
    });

    this.knowledgeService = new KnowledgeService(this.auditService, this.pathValidator, config, this.ragEngine, this.databaseService);
    this.dataSafetyService = new DataSafetyService(this.auditService, this.workspaceService, this.databaseService);
    this.governanceService = new GovernanceService(this.auditService);
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
    this.durableRuntime.transactionalAppend({
      meta: {
        runId: input.runId,
        workspaceId: input.workspaceId,
        eventType: 'recovery_approval_requested',
        eventPayload: {
          approvalId: id,
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
        const inserted = db.prepare(`
          INSERT INTO approvals (id, run_id, workspace_id, approval_type,
            requested_scope_json, scope_hash, payload_fingerprint,
            policy_version_hash, effect_id, effect_revision, expires_at,
            decision, created_at, reason)
          SELECT ?, ?, ?, 'recovery_retry', ?, ?, ?, ?, ?, effect_revision,
                 ?, 'pending', ?, ?
            FROM run_effects
           WHERE id = ? AND run_id = ? AND state = 'unknown'
             AND effect_revision = ? AND payload_fingerprint = ?
             AND scope_hash = ? AND policy_version_hash = ?
        `).run(
          id, input.runId, input.workspaceId, scopeJson, scopeHash,
          effect.payloadFingerprint, currentPolicyVersion, effect.id,
          input.expiresAt ?? null, now, input.reason ?? null,
          effect.id, input.runId, effect.effectRevision,
          effect.payloadFingerprint, scopeHash, currentPolicyVersion,
        );
        if (inserted.changes !== 1) {
          throw new OgraError(OgraErrorCode.REVISION_CONFLICT,
            `Recovery approval effect ${effect.id} changed while requesting authority`);
        }
        this.durableRuntime.appendEdge({
          runId: input.runId,
          fromKind: 'effect', fromId: effect.id,
          relation: 'recovery_approval_requested',
          toKind: 'approval', toId: id, sourceEventId: eventId,
        });
      },
    });
    return { id, status: 'pending', scopeHash, effectRevision: effect.effectRevision };
  }

  shutdown(): void {
    // Cleanup resources — close DB connection, release locks
    this.databaseService.close();
    this.initialized = false;
  }
}
