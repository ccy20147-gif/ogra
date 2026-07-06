/** Data classification levels */
export enum DataClassification {
  Public = 'Public',
  Internal = 'Internal',
  Confidential = 'Confidential',
  Restricted = 'Restricted',
}

/** Workspace types */
export enum WorkspaceType {
  Personal = 'personal',
  Project = 'project',
  Company = 'company',
}

/** Route decision values */
export enum RouteDecisionType {
  Local = 'local',
  Cloud = 'cloud',
  Hybrid = 'hybrid',
  Blocked = 'blocked',
}

/** Indexing job status */
export enum IndexingStatus {
  Queued = 'queued',
  Running = 'running',
  Succeeded = 'succeeded',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

/** Run status */
export enum RunStatus {
  Created = 'created',
  PolicyPrecheck = 'policy_precheck',
  Retrieval = 'retrieval',
  ContextPolicy = 'context_policy',
  RouteDecision = 'route_decision',
  RiskClassified = 'risk_classified',
  AwaitingApproval = 'awaiting_approval',
  RedactionPreview = 'redaction_preview',
  ModelInvocation = 'model_invocation',
  Completed = 'completed',
  Failed = 'failed',
  Cancelled = 'cancelled',
  Blocked = 'blocked',
}

/** Agent adapter kinds — only implemented adapters are listed here.
 *  Codex, ClaudeCode, and Hermes adapters are planned for future releases. */
export enum AdapterKind {
  Internal = 'internal',
  Ollama = 'ollama',
  OpenAICompatible = 'openai_compatible',
  LocalCommand = 'local_command',
  Aider = 'aider',
  OpenInterpreter = 'open_interpreter',
  A2A = 'a2a',
}

/** Risk levels */
export enum RiskLevel {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  Blocked = 'blocked',
}

/** Incident types */
export enum IncidentType {
  PolicyBlock = 'policy_block',
  CloudCallDenied = 'cloud_call_denied',
  PromptInjectionWarning = 'prompt_injection_warning',
  ToolDenied = 'tool_denied',
  PermissionDenied = 'permission_denied',
  UnauthorizedAccess = 'unauthorized_access',
  MemoryWriteRejected = 'memory_write_rejected',
  ExternalAgentUntrusted = 'external_agent_untrusted',
}

/** Approval decision */
export enum ApprovalDecision {
  Pending = 'pending',
  Approved = 'approved',
  Denied = 'denied',
  Expired = 'expired',
}

/** Pipeline execution status */
export enum PipelineStatus {
  Created = 'created',
  Running = 'running',
  Paused = 'paused',
  Cancelled = 'cancelled',
  Completed = 'completed',
  Failed = 'failed',
}

/** Agent group execution mode — Pipeline is implemented in Alpha;
 *  Parallel and Debate are planned for Beta. */
export enum AgentGroupMode {
  Pipeline = 'pipeline',
  Parallel = 'parallel',
  Debate = 'debate',
}

/** Memory types */
export enum MemoryType {
  Episodic = 'episodic',
  Semantic = 'semantic',
  Procedural = 'procedural',
}

/** Audit levels for local agent adapters */
export enum AuditLevel {
  Level1 = 1, // process start/stop, transcripts, hashes
  Level2 = 2, // declared file access, tool requests
  Level3 = 3, // structured tool trace, artifacts
}

/** Provider kind */
export enum ProviderKind {
  Ollama = 'ollama',
  OpenAICompatible = 'openai_compatible',
  Internal = 'internal',
  LocalCommand = 'local_command',
  A2A = 'a2a',
}

/** Event types for run_events */
export enum RunEventType {
  RunCreated = 'run_created',
  WorkspaceCreated = 'workspace_created',
  PolicyPrecheck = 'policy_precheck',
  RetrievalStarted = 'retrieval_started',
  RetrievalCompleted = 'retrieval_completed',
  ContextPolicyCheck = 'context_policy_check',
  RouteDecision = 'route_decision',
  RiskClassification = 'risk_classification',
  RedactionPreview = 'redaction_preview',
  ApprovalRequested = 'approval_requested',
  ApprovalDecision = 'approval_decision',
  ModelCallStarted = 'model_call_started',
  ModelCallCompleted = 'model_call_completed',
  CloudCallLedgerUpdated = 'cloud_call_ledger_updated',
  FinalOutput = 'final_output',
  AuditComplete = 'audit_complete',
  RunCancelled = 'run_cancelled',
  RunFailed = 'run_failed',
  RunBlocked = 'run_blocked',
  DocumentAccessed = 'document_accessed',
  ToolInvoked = 'tool_invoked',
  MemoryAccessed = 'memory_accessed',
  MemoryWritten = 'memory_written',
  SecretUsed = 'secret_used',
  ExportStarted = 'export_started',
  ExportCompleted = 'export_completed',
  AuditViewAccessed = 'audit_view_accessed',
  PolicyEvaluation = 'policy_evaluation',
  IncidentCreated = 'incident_created',
  PromptInjectionWarning = 'prompt_injection_warning',
  KnowledgeBaseReindexed = 'knowledge_base_reindexed',
}
