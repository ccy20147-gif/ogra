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
import { RedactionService } from './redaction-service';
import { BaseModelAdapter } from './model-adapter';
import { OllamaAdapter, OpenAICompatibleAdapter } from '../edge/model-adapters';
import { OgraError, OgraErrorCode } from '../shared/errors';

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
  public readonly dataSafetyService: DataSafetyService;
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

  shutdown(): void {
    // Cleanup resources — close DB connection, release locks
    this.databaseService.close();
    this.initialized = false;
  }
}
