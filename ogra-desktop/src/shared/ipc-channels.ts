import { DataClassification, WorkspaceType, RunStatus, RiskLevel, IndexingStatus } from './types';

/** Allowed IPC channel names */
export enum IpcChannel {
  // Workspace
  WorkspaceCreate = 'workspace:create',
  WorkspaceList = 'workspace:list',
  WorkspaceSelect = 'workspace:select',
  WorkspaceUpdateClassification = 'workspace:update-classification',

  // Folder import
  FolderImport = 'folder:import',
  FolderValidate = 'folder:validate',

  // Indexing
  IndexingStart = 'indexing:start',
  IndexingStatus = 'indexing:status',
  IndexingCancel = 'indexing:cancel',
  IndexingProgress = 'indexing:progress',

  // Chat / Run
  RunStart = 'run:start',
  RunStatus = 'run:status',
  RunCancel = 'run:cancel',
  RunResult = 'run:result',
  RunHistory = 'run:history',

  // Route Decision
  RouteDecisionFetch = 'route-decision:fetch',

  // Audit
  AuditEventFetch = 'audit:event-fetch',
  AuditExport = 'audit:export',
  AuditVerifier = 'audit:verify',

  // Data Safety Center
  DataSafetySummary = 'data-safety:summary',
  DataSafetyAssetMap = 'data-safety:asset-map',
  DataSafetyCloudCalls = 'data-safety:cloud-calls',

  // AI Governance
  GovernanceRunRisk = 'governance:run-risk',
  GovernanceIncidents = 'governance:incidents',
  GovernancePolicyEvaluations = 'governance:policy-evaluations',

  // Model / Provider
  ProviderList = 'provider:list',
  ProviderUpdate = 'provider:update',
  ProviderConnectTest = 'provider:connect-test',
  ModelList = 'model:list',

  // Secrets
  SecretCreate = 'secret:create',
  SecretUpdate = 'secret:update',
  SecretDelete = 'secret:delete',
  SecretList = 'secret:list',

  // Permissions
  PermissionRequest = 'permission:request',
  PermissionDecision = 'permission:decision',

  // Approvals
  ApprovalRequest = 'approval:request',
  ApprovalDecision = 'approval:decision',

  // Policy
  PolicyDryRun = 'policy:dry-run',
  PolicyList = 'policy:list',

  // Data Egress
  DataEgressSummary = 'data-egress:summary',

  // Knowledge
  KnowledgeBaseList = 'knowledge:base-list',
  KnowledgeFileBrowse = 'knowledge:file-browse',
  KnowledgeChunkInspect = 'knowledge:chunk-inspect',
  KnowledgeRetrievalTest = 'knowledge:retrieval-test',
  KnowledgeReindex = 'knowledge:reindex',
  KnowledgeWarnings = 'knowledge:warnings',
}

/** IPC channel allowlist for runtime enforcement */
export const ALLOWED_IPC_CHANNELS: readonly string[] = Object.values(IpcChannel);

// ---- Request / Response Types ----

export interface IpcResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface WorkspaceCreateRequest {
  name: string;
  type: WorkspaceType;
  defaultClassification: DataClassification;
}

export interface WorkspaceResponse {
  id: string;
  name: string;
  type: WorkspaceType;
  defaultClassification: DataClassification;
  createdAt: string;
  updatedAt: string;
}

export interface FolderImportRequest {
  workspaceId: string;
  folderPath: string;
  classification: DataClassification;
}

export interface FolderImportResponse {
  knowledgeBaseId: string;
  filesFound: number;
  filesSupported: number;
  filesSkipped: number;
  skippedReasons: string[];
}

export interface IndexingProgressEvent {
  knowledgeBaseId: string;
  status: IndexingStatus;
  filesDiscovered: number;
  filesIndexed: number;
  filesSkipped: number;
  chunksIndexed: number;
  warnings: string[];
  errors: string[];
  startedAt: string;
  completedAt?: string;
}

export interface RunStartRequest {
  workspaceId: string;
  task: string;
  knowledgeBaseIds?: string[];
  requestedModel?: string;
  requestedProvider?: string;
}

export interface RouteDecisionResponse {
  runId: string;
  route: string;
  dataClassification: DataClassification;
  highWaterSources: string[];
  reasons: string[];
  localSteps: string[];
  cloudSteps: string[];
  requiresUserApproval: boolean;
  approvalId?: string;
  policyEvaluationId?: string;
  providerId?: string;
  modelId?: string;
  cloudPayloadSummary?: string;
  cloudPayloadHash?: string;
  incidentIds: string[];
  auditEventId: string;
  createdAt: string;
}

export interface AuditEventResponse {
  id: string;
  runId: string;
  workspaceId: string;
  sequence: number;
  eventType: string;
  eventPayload: Record<string, unknown>;
  payloadHash?: string;
  previousHash: string;
  eventHash: string;
  policyVersionHash?: string;
  redactionRuleVersion?: string;
  createdAt: string;
}

export interface ModelCallRecord {
  id: string;
  runId: string;
  status: string;
  adapterKind: string;
  providerId: string;
  modelId: string;
  isCloud: boolean;
  promptHash?: string;
  requestPayloadHash?: string;
  uploadedPayloadHash?: string;
  redactionRuleVersion?: string;
  responseHash?: string;
  errorCode?: string;
  tokenUsage?: { prompt: number; completion: number; total: number };
  startedAt: string;
  completedAt?: string;
}

export interface DataSafetySummary {
  totalAssets: number;
  byClassification: Record<string, number>;
  knowledgeBases: Array<{
    id: string;
    name: string;
    classification: DataClassification;
    fileCount: number;
    indexedStatus: string;
  }>;
  recentAccess: Array<{
    documentId: string;
    fileName: string;
    classification: DataClassification;
    accessedAt: string;
  }>;
  recentCloudCalls: ModelCallRecord[];
  zeroCloudCallRuns: number;
}

export interface RunRiskSummary {
  runId: string;
  riskLevel: RiskLevel;
  riskReasons: string[];
  requiredApprovals: string[];
  approvalStatus: string;
  createdAt: string;
}

export interface ProviderConfig {
  id: string;
  kind: string;
  name: string;
  endpoint: string;
  isLocal: boolean;
  dataRetentionPolicy?: string;
  trainingOptOut?: boolean;
  region?: string;
  zeroDataRetentionSupported?: boolean;
  supportsStreaming: boolean;
  supportsToolCalling: boolean;
  enabled: boolean;
}

export interface SecretMetadata {
  id: string;
  providerId: string;
  displayName: string;
  maskedValue: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface SecretCreateRequest {
  providerId: string;
  value: string;
  displayName: string;
}

export interface ApprovalRequest {
  runId: string;
  approvalType: string;
  requestedScope: Record<string, unknown>;
  reason: string;
}

export interface ApprovalResponse {
  id: string;
  runId: string;
  approvalType: string;
  decision: string;
  decidedBy?: string;
  reason?: string;
  expiresAt?: string;
  createdAt: string;
  decidedAt?: string;
}
