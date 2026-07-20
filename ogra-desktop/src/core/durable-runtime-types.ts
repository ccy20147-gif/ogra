/**
 * Sequence 1A Milestone 0 — durable runtime types.
 *
 * Strictly typed state machines for run_frames, run_effects,
 * repair_transactions, and recovery_leases. The Milestone 0
 * contract here defines what the Core-owned DurableRuntimeService
 * is allowed to persist and what it MUST reject.
 *
 * Out of scope for Milestone 0: physical adapters, real MCP
 * transport, recovery callback execution, ingress review
 * implementation, memory projection. Milestone 1 wires
 * InternalAgentAdapter to these primitives.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { DataClassification } from '../shared/types';

/* ============================================================
 * Frames
 * ============================================================ */

export type FrameKind =
  | 'root'
  | 'plan_step'
  | 'react'
  | 'repair'
  | 'synthesis';

export type FrameStatus =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Allowed frame status transitions. Terminal states are absorbing. */
export const FRAME_TRANSITIONS: Record<FrameStatus, FrameStatus[]> = {
  pending: ['running', 'awaiting_approval', 'cancelled', 'failed'],
  running: ['awaiting_approval', 'completed', 'failed', 'cancelled'],
  awaiting_approval: ['running', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export interface RunFrame {
  id: string;
  runId: string;
  parentFrameId: string | null;
  runStepId: string | null;
  frameKind: FrameKind;
  status: FrameStatus;
  path: string[];
  nodeRevision: number;
  subtreeRevision: number;
  inputHash: string | null;
  outputHash: string | null;
  createdEventId: string | null;
  terminalEventId: string | null;
  createdAt: string;
  updatedAt: string;
}

/* ============================================================
 * Effects
 * ============================================================ */

export type EffectState =
  | 'planned'
  | 'in_flight'
  | 'unknown'
  | 'received'
  | 'committed'
  | 'quarantined'
  | 'compensating'
  | 'compensated'
  | 'failed'
  | 'cancelled_before_send';

/**
 * Plan 10 §3.2 — allowed effect transitions. Every `unknown`
 * transition requires a recovery lease + typed reconciliation;
 * `unknown -> in_flight` additionally requires verified idempotent
 * retry + a new attempt number.
 */
export const EFFECT_TRANSITIONS: Record<EffectState, EffectState[]> = {
  planned: ['in_flight', 'cancelled_before_send', 'failed'],
  in_flight: ['received', 'unknown', 'failed'],
  received: ['committed', 'quarantined', 'failed'],
  unknown: ['received', 'committed', 'quarantined', 'failed', 'in_flight'],
  committed: ['compensating'],
  compensating: ['compensated', 'failed', 'unknown'],
  quarantined: [],
  compensated: [],
  failed: [],
  cancelled_before_send: [],
};

export interface RunEffect {
  id: string;
  runId: string;
  ownerFrameId: string;
  effectType: string;
  adapterKind: string;
  payloadFingerprint: string;
  callbackCapsuleRef: string | null;
  callbackCapsuleHash: string | null;
  callbackCapsuleFormatVersion: string | null;
  idempotencyKeyRef: string | null;
  idempotencyKeyHash: string | null;
  state: EffectState;
  allowedRepairActions: string[];
  dependencyEffectIds: string[];
  effectRevision: number;
  routeDecisionId: string | null;
  policyEvaluationId: string | null;
  currentApprovalId: string | null;
  egressRecordId: string | null;
  ingressFindingId: string | null;
  externalRequestId: string | null;
  authoritativeReceiptId: string | null;
  externalReceiptHash: string | null;
  createdEventId: string | null;
  terminalEventId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RepairAction =
  | 'retry'
  | 'compensate'
  | 'preserve'
  | 'amend'
  | 'reconcile'
  | 'escalate';

export interface PlannedEffectRequest {
  runId: string;
  ownerFrameId: string;
  effectType: string;
  adapterKind: string;
  payloadFingerprint: string;
  /** Hash of the sealed callback capsule (the raw payload is NEVER
   *  stored in the DB; only the content-addressed ref + hash are
   *  persisted, per plan 10 §3.2.1). */
  callbackCapsuleHash: string;
  callbackCapsuleRef: string;
  callbackCapsuleFormatVersion: string;
  /** Hash of the idempotency key. The raw key is stored ONLY in
   *  the sealed callback capsule, not in run_effects. The hash
   *  alone is the dedup discriminator. */
  idempotencyKeyHash: string;
  idempotencyKeyRef: string;
  allowedRepairActions: RepairAction[];
  dependencyEffectIds: string[];
  routeDecisionId?: string | null;
  policyEvaluationId?: string | null;
  classification: DataClassification;
}

/* ============================================================
 * Receipts
 * ============================================================ */

export type ApplicationStatus = 'not_applied' | 'applied' | 'unknown';

export interface EffectReceipt {
  id: string;
  effectId: string;
  attemptNo: number;
  requestId: string | null;
  requestHash: string | null;
  responseHash: string | null;
  resultCapsuleRef: string | null;
  resultCapsuleHash: string | null;
  resultCapsuleFormatVersion: string | null;
  providerStatus: string | null;
  applicationStatus: ApplicationStatus;
  receiptHash: string;
  receivedAt: string;
  eventId: string | null;
}

export interface ReceiptAppendRequest {
  effectId: string;
  attemptNo: number;
  requestId: string | null;
  requestHash: string | null;
  responseHash: string | null;
  resultCapsuleRef: string | null;
  resultCapsuleHash: string | null;
  resultCapsuleFormatVersion: string | null;
  providerStatus: string | null;
  applicationStatus: ApplicationStatus;
}

/* ============================================================
 * Approval bindings (per-attempt immutable)
 * ============================================================ */

export type ApprovalBindingKind = 'initial' | 'recovery_retry';

export interface EffectApprovalBinding {
  id: string;
  effectId: string;
  callbackAttemptNo: number;
  approvalId: string;
  approvalRevision: number;
  bindingKind: ApprovalBindingKind;
  createdEventId: string | null;
}

/* ============================================================
 * Repair
 * ============================================================ */

export type RepairStatus =
  | 'open'
  | 'accepted'
  | 'rejected'
  | 'committed'
  | 'aborted';

export interface RepairStepProposal {
  effectId: string;
  /** Expected revision snapshot used by the verifier. */
  expectedEffectRevision: number;
  action: RepairAction;
}

export interface RepairTransaction {
  id: string;
  runId: string;
  targetFrameId: string;
  targetSubtreeRevision: number;
  authorizedEffectRevisions: number[];
  proposedPlan: RepairStepProposal[];
  verificationResult: Record<string, unknown>;
  status: RepairStatus;
  rejectionReason: string | null;
  createdEventId: string | null;
  terminalEventId: string | null;
  createdAt: string;
  updatedAt: string;
}

/* ============================================================
 * Recovery Lease (single local holder)
 * ============================================================ */

export interface RecoveryLease {
  runId: string;
  holderId: string;
  leaseVersion: number;
  acquiredAt: string;
  expiresAt: string;
  renewedAt: string;
  releasedAt: string | null;
  lastEventId: string | null;
}

/* ============================================================
 * Audit Edges
 * ============================================================ */

export type AuditEdgeFromKind =
  | 'run'
  | 'frame'
  | 'effect'
  | 'repair'
  | 'memory'
  | 'event';

export type AuditEdgeToKind =
  | 'run'
  | 'frame'
  | 'effect'
  | 'repair'
  | 'route'
  | 'policy'
  | 'approval'
  | 'egress'
  | 'ingress'
  | 'receipt'
  | 'memory'
  | 'event';

export interface AuditEdge {
  id: string;
  runId: string;
  fromKind: AuditEdgeFromKind;
  fromId: string;
  relation: string;
  toKind: AuditEdgeToKind;
  toId: string;
  sourceEventId: string | null;
  createdAt: string;
}

export interface AuditEdgeDrift {
  missing: AuditEdge[];
  extra: AuditEdge[];
  reason: string;
}

/* ============================================================
 * Tool Broker contracts (plan 11 §5/§6) — T1 boundary only.
 * ============================================================ */

export type ToolSourceKind = 'builtin' | 'skill' | 'mcp';
export type ToolTransport =
  | 'in_process'
  | 'isolated_worker'
  | 'mcp_stdio'
  | 'mcp_http';
export type ToolEffectClass =
  | 'read_only'
  | 'local_mutation'
  | 'external_mutation';
export type ToolLifecycleState =
  | 'discovered'
  | 'pending_review'
  | 'enabled'
  | 'stale'
  | 'revoked';
export type ApprovalMode =
  | 'none'
  | 'allowlist'
  | 'each_call'
  | 'workflow_step'
  | 'administrative';
export type RiskTier = 'low' | 'medium' | 'high' | 'blocked';

export interface ToolDescriptorVersion {
  id: string;
  descriptorId: string;
  logicalName: string;
  sourceKind: ToolSourceKind;
  sourceRef: string;
  owner: string;
  sourceVersion: string;
  transport: ToolTransport;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  effectClass: ToolEffectClass;
  permissions: Record<string, unknown>;
  dataCompatibility: Record<string, unknown>;
  riskTier: RiskTier;
  recoveryCapabilities: RecoveryCapabilities;
  provenance: Record<string, unknown>;
  descriptorHash: string;
  inputSchemaHash: string;
  outputSchemaHash?: string;
}

export interface ToolDescriptor {
  id: string;
  sourceKind: ToolSourceKind;
  sourceRef: string;
  logicalName: string;
  owner: string;
  latestVersionId: string | null;
  lifecycleState: ToolLifecycleState;
  createdAt: string;
  updatedAt: string;
}

export interface ToolVersion {
  id: string;
  descriptorId: string;
  sourceVersion: string;
  descriptorHash: string;
  inputSchemaJson: string;
  inputSchemaHash: string;
  outputSchemaJson: string | null;
  outputSchemaHash: string | null;
  effectClass: ToolEffectClass;
  permissionsJson: string;
  dataCompatibilityJson: string;
  recoveryCapabilitiesJson: string;
  provenanceJson: string;
  status: ToolLifecycleState;
  createdAt: string;
}

export interface WorkspaceToolBinding {
  id: string;
  logicalBindingId: string;
  parentBindingId: string | null;
  workspaceId: string;
  toolVersionId: string;
  revision: number;
  bindingHash: string;
  enabled: boolean;
  policyId: string | null;
  approvalMode: ApprovalMode;
  constraintsJson: string;
  authBindingId: string | null;
  createdAt: string;
  updatedAt: string;
}

/* ============================================================
 * Adapter recovery capabilities (plan 10 §5)
 * ============================================================ */

export type RetryCostRisk = 'low' | 'medium' | 'high';
export type DuplicateEffectRisk = 'low' | 'medium' | 'high';
export type AuditLevel = 'none' | 'summary' | 'full';

export interface RecoveryCapabilities {
  supportsIdempotencyKey: boolean;
  supportsOutcomeQuery: boolean;
  supportsCancel: boolean;
  supportsCompensation: boolean;
  compensationIsLossless: boolean;
  retryCostRisk: RetryCostRisk;
  duplicateEffectRisk: DuplicateEffectRisk;
  auditLevel: AuditLevel;
}

/* ============================================================
 * Service I/O contracts
 * ============================================================ */

export interface CreateFrameRequest {
  runId: string;
  parentFrameId?: string | null;
  runStepId?: string | null;
  frameKind: FrameKind;
  inputHash?: string | null;
}

export interface FrameTransitionRequest {
  frameId: string;
  expectedStatus?: FrameStatus | null;
  nextStatus: FrameStatus;
  outputHash?: string | null;
}

export interface EffectTransitionRequest {
  effectId: string;
  expectedRevision: number;
  expectedState: EffectState;
  nextState: EffectState;
  receiptHash?: string | null;
}

export interface ApproveApprovalBindingRequest {
  effectId: string;
  callbackAttemptNo: number;
  approvalId: string;
  approvalRevision: number;
  bindingKind: ApprovalBindingKind;
}

export interface RepairCreateRequest {
  runId: string;
  targetFrameId: string;
  expectedSubtreeRevision: number;
  authorizedEffectRevisions: number[];
  proposedPlan: RepairStepProposal[];
}

export interface LeaseAcquireRequest {
  runId: string;
  holderId: string;
  ttlMs: number;
}

export interface LeaseRenewRequest {
  runId: string;
  holderId: string;
  expectedLeaseVersion: number;
  ttlMs: number;
}

export interface LeaseReleaseRequest {
  runId: string;
  holderId: string;
  expectedLeaseVersion: number;
}

/* ============================================================
 * Mock effect adapter contract (test only — Milestone 0)
 * ============================================================ */

export interface MockEffectAdapterCallbacks {
  /** Attempt counter — must equal the number of physical callbacks. */
  attempts: number;
  /** Counter of *physical* applications — must equal attempts for
   *  an idempotent adapter; must be 0 for an unknown-outcome
   *  adapter even when attempts > 0. */
  physicalApplications: number;
  /** History of every recorded attempt, with its `attemptNo`. */
  attemptHistory: Array<{ attemptNo: number; payloadHash: string }>;
}
