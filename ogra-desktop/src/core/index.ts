import { OgraSecretBroker } from './secret-broker';
import { DatabaseService } from './database-service';
import { WorkspaceService } from './workspace-service';
import { PathValidator } from './path-validator';
import { KnowledgeService } from '../edge/knowledge-service';
import { RagEngine } from '../edge/rag-engine';
import { RunService } from './run-service';
import { RouteService } from './route-service';
import { AuditService } from './audit-service';
import { PolicyService } from './policy-service';
import { ProviderService } from './provider-service';
import { DataSafetyService } from './data-safety-service';
import { GovernanceService } from './governance-service';

export interface OgraCoreConfig {
  appDataDir: string;
  secretBroker: OgraSecretBroker;
  isDev: boolean;
}

/**
 * Ogra Core — the central application service layer.
 *
 * Owns domain validation, transactional writes, and service coordination.
 * All services are initialized here and exposed to Main process handlers.
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

  private readonly config: OgraCoreConfig;
  private initialized = false;

  constructor(config: OgraCoreConfig) {
    this.config = config;
    this.databaseService = new DatabaseService(config.appDataDir);
    this.auditService = new AuditService(this.databaseService);
    this.pathValidator = new PathValidator();
    this.policyService = new PolicyService(this.auditService);
    this.routeService = new RouteService(this.policyService);
    this.workspaceService = new WorkspaceService(this.auditService, this.databaseService);
    this.providerService = new ProviderService(this.auditService);
    this.ragEngine = new RagEngine(this.databaseService);
    this.runService = new RunService(
      this.workspaceService,
      this.routeService,
      this.auditService,
      this.policyService,
      config,
    );
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
