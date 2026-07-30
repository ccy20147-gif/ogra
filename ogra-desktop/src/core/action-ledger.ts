/**
 * Sequence 1C Milestone 1 — Action Ledger.
 *
 * Append-only log of executable actions. Paired 1:1 with the
 * `ledger_record` v2 audit event written in the same SQLite
 * transaction via `DurableRuntimeService.transactionalAppend`.
 *
 * The ledger is the producer of truth for any code path that wants
 * to claim "executable action performed" — tool invocations, agent
 * steps, ingress review decisions, approval records, recovery
 * decisions, progress-guard decisions and explicit ledger entries.
 *
 * Sanitization invariant (plan 10 §3.2 + plan 11 §11):
 *   - payload_digest MUST be a 64-char hex sha256 (enforced).
 *   - outcome_summary MUST be in ALLOWED_OUTCOME_REASONS or null.
 *   - action_target MUST match `^[a-z]+:[a-z0-9_\-:.]+$` (enforced).
 *   - actionType and sourceKind MUST be in their closed sets.
 *   - The ledger never sees raw payload / secret / idempotency key
 *     / response body / chain-of-thought. Only the producer (the
 *     capability path) has those bytes; this service stores only
 *     their digest.
 *
 * Renderer / audit packet / data-safety exports consume
 * `projectionForRun` which keeps the same shape. Raw `listForRun` is
 * restricted to Core-side callers (effects, recovery, governance).
 */
import * as crypto from 'crypto';
import { OgraDatabase } from './database';
import { DurableRuntimeService } from './durable-runtime-service';
import { canonicalJSON } from './audit-envelope';
import { OgraError, OgraErrorCode } from '../shared/errors';

export type ActionType =
  | 'tool_call'
  | 'agent_step'
  | 'ingress_review'
  | 'approval_record'
  | 'recovery_decision'
  | 'guard_decision'
  | 'ledger_record';

export type ActionSourceKind =
  | 'production'
  | 'recovery'
  | 'admin'
  | 'system';

const ACTION_TYPES: ReadonlySet<ActionType> = new Set<ActionType>([
  'tool_call', 'agent_step', 'ingress_review',
  'approval_record', 'recovery_decision', 'guard_decision',
  'ledger_record',
]);

const SOURCE_KINDS: ReadonlySet<ActionSourceKind> = new Set<ActionSourceKind>([
  'production', 'recovery', 'admin', 'system',
]);

/**
 * Closed-set of allowed outcome summaries. Raw free-text is
 * rejected before it can ever touch the audit packet. The single
 * `closed_set_violation` value is the universal fallback for
 * sanitized reasons.
 */
export const ALLOWED_OUTCOME_REASONS: ReadonlySet<string> = new Set<string>([
  // tool_call
  'tool_invocation_prepared',
  'tool_invocation_committed',
  'tool_invocation_accepted',
  'tool_invocation_quarantined',
  'tool_invocation_rejected',
  'tool_invocation_unknown',
  // agent_step
  'agent_step_planned',
  'agent_step_committed',
  'agent_step_failed',
  // ingress_review
  'ingress_accepted',
  'ingress_quarantined',
  'ingress_rejected',
  'ingress_unknown',
  // approval_record
  'approval_recorded',
  'approval_revoked_for_recovery',
  // recovery_decision
  'recovery_decided',
  // guard_decision
  'guard_budget_exhausted_action_count',
  'guard_budget_exhausted_steps',
  'guard_loop_detected',
  'guard_stagnation_detected',
  'guard_unknown_action',
  // ledger_record
  'ledger_recorded',
  // universal
  'closed_set_violation',
]);

const ACTION_TARGET_RE = /^[a-z]+:[a-z0-9_\-:.]+$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;

function assertSafeDigest(digest: string): void {
  if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) {
    throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
      `action ledger payload_digest MUST be a 64-char hex sha256; got '${typeof digest}'`);
  }
}

function assertSafeActionTarget(target: string): void {
  if (typeof target !== 'string' || !ACTION_TARGET_RE.test(target)) {
    throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
      `action ledger action_target MUST match ${ACTION_TARGET_RE}; got '${typeof target}'`);
  }
}

function assertSafeOutcome(reason: string | null | undefined, fallback: string): string | null {
  if (reason === null || reason === undefined) return null;
  if (typeof reason !== 'string') {
    return fallback;
  }
  return ALLOWED_OUTCOME_REASONS.has(reason) ? reason : fallback;
}

export interface RecordActionInput {
  runId: string;
  workspaceId: string;
  frameId: string;
  effectId?: string | null;
  attemptNo?: number | null;
  actionType: ActionType;
  actionTarget: string;
  sourceKind: ActionSourceKind;
  payloadDigest: string;
  policyVersionHash?: string | null;
  scopeHash?: string | null;
  approvalId?: string | null;
  recoveryApprovalId?: string | null;
  leaseHolderId?: string | null;
  leaseVersion?: number | null;
  ruleVersion: string;
  outcomeSummary?: string | null;
  asOf?: string;
}

export interface RecordActionResult {
  id: string;
  sequenceNo: number;
  l1EventId: string;
}

export interface ActionLedgerEntry {
  id: string;
  runId: string;
  workspaceId: string | null;
  frameId: string;
  effectId: string | null;
  attemptNo: number | null;
  sequenceNo: number;
  actionType: ActionType;
  actionTarget: string;
  sourceKind: ActionSourceKind;
  payloadDigest: string;
  policyVersionHash: string | null;
  scopeHash: string | null;
  approvalId: string | null;
  recoveryApprovalId: string | null;
  leaseHolderId: string | null;
  leaseVersion: number | null;
  ruleVersion: string;
  outcomeSummary: string | null;
  l1EventId: string;
  createdAt: string;
}

/**
 * ActionLedgerService.
 *
 * The service never carries raw payload / secret / idempotency-key
 * / response-body text. Every recordAction call is paired with a
 * run_event row in a single SQLite transaction; the audit chain and
 * the ledger row can never disagree.
 */
export class ActionLedgerService {
  constructor(
    private readonly odb: OgraDatabase,
    private readonly runtime: DurableRuntimeService,
  ) {}

  /**
   * Record an action. Atomically writes a paired L1 v2 audit event
   * (`event_type = ledger_record`) plus the ledger row in the same
   * SQLite transaction. The audit-edge from frame → ledger event is
   * also written inside the transaction.
   *
   * The action_target regex and digest regex are checked here,
   * BEFORE we open the transaction, so a malformed caller never
   * gets a partially-written ledger row + half of an L1 event.
   */
  recordAction(input: RecordActionInput): RecordActionResult {
    if (!ACTION_TYPES.has(input.actionType)) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        `recordAction: actionType=${input.actionType} is not in the closed set`);
    }
    if (!SOURCE_KINDS.has(input.sourceKind)) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        `recordAction: sourceKind=${input.sourceKind} is not in the closed set`);
    }
    if (!input.runId || !input.workspaceId || !input.frameId) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'recordAction: runId, workspaceId, frameId are required');
    }
    assertSafeDigest(input.payloadDigest);
    assertSafeActionTarget(input.actionTarget);
    if (!input.ruleVersion) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'recordAction: ruleVersion is required');
    }
    // closed-set enforcement — raw free text falls back to a
    // neutral sanitized reason code so attackers cannot smuggle
    // raw text through the audit packet. The default fallback
    // for ledger_record is `closed_set_violation`; tool call
    // paths propagate the producer's reason.
    const outcome = assertSafeOutcome(input.outcomeSummary, 'closed_set_violation');

    const id = `act_${crypto.randomBytes(6).toString('hex')}`;
    return this.runtime.transactionalAppend<RecordActionResult>({
      meta: {
        runId: input.runId,
        workspaceId: input.workspaceId,
        eventType: 'ledger_record',
        eventPayload: {
          actionType: input.actionType,
          actionTarget: input.actionTarget,
          payloadDigest: input.payloadDigest,
          outcomeSummary: outcome,
          sourceKind: input.sourceKind,
        },
        frameId: input.frameId,
        effectId: input.effectId ?? null,
      },
      body: (eventId) => {
        const seqRow = this.odb.getDB().prepare(
          'SELECT COALESCE(MAX(sequence_no), 0) AS s FROM action_ledger WHERE run_id = ?',
        ).get(input.runId) as { s: number };
        const sequenceNo = (seqRow.s as number) + 1;
        this.odb.getDB().prepare(`
          INSERT INTO action_ledger
            (id, run_id, frame_id, effect_id, attempt_no,
             sequence_no, action_type, action_target,
             source_kind, payload_digest,
             policy_version_hash, scope_hash,
             approval_id, recovery_approval_id,
             lease_holder_id, lease_version,
             rule_version, outcome_summary, l1_event_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, input.runId, input.frameId,
          input.effectId ?? null,
          input.attemptNo ?? null,
          sequenceNo,
          input.actionType,
          input.actionTarget,
          input.sourceKind,
          input.payloadDigest,
          input.policyVersionHash ?? null,
          input.scopeHash ?? null,
          input.approvalId ?? null,
          input.recoveryApprovalId ?? null,
          input.leaseHolderId ?? null,
          input.leaseVersion ?? null,
          input.ruleVersion,
          outcome,
          eventId,
        );
        // Frame → ledger-row audit edge.
        this.odb.getDB().prepare(`
          INSERT INTO audit_edges
            (id, run_id, from_kind, from_id, relation, to_kind, to_id,
             source_event_id, created_at)
          VALUES (?, ?, 'frame', ?, 'has_action_ledger', 'event', ?, ?, ?)
        `).run(
          `edg_${crypto.randomBytes(6).toString('hex')}`,
          input.runId, input.frameId, eventId, eventId,
          input.asOf ?? new Date().toISOString(),
        );
        return { id, sequenceNo, l1EventId: eventId };
      },
    });
  }

  /**
   * Read the ledger for one run. Returns sanitized fields only —
   * never raw payload / secret / response body. Used by Core for
   * IPC projections and by recovery / audit packets to walk
   * forward / backward. The renderer / UI never calls this
   * directly; it goes through `projectionForRun`.
   */
  listForRun(runId: string, opts?: { limit?: number; offset?: number }): ActionLedgerEntry[] {
    const limit = Math.max(0, Math.min(10000, opts?.limit ?? 1000));
    const offset = Math.max(0, opts?.offset ?? 0);
    const rows = this.odb.getDB().prepare(`
      SELECT a.id, a.run_id, a.frame_id, a.effect_id, a.attempt_no,
             a.sequence_no, a.action_type, a.action_target,
             a.source_kind, a.payload_digest,
             a.policy_version_hash, a.scope_hash,
             a.approval_id, a.recovery_approval_id,
             a.lease_holder_id, a.lease_version,
             a.rule_version, a.outcome_summary, a.l1_event_id, a.created_at,
             ev.workspace_id AS workspace_id
        FROM action_ledger a
        JOIN run_events ev ON ev.id = a.l1_event_id
       WHERE a.run_id = ?
       ORDER BY a.sequence_no ASC
       LIMIT ? OFFSET ?
    `).all(runId, limit, offset) as Array<{
      id: string; run_id: string; workspace_id: string | null;
      frame_id: string; effect_id: string | null; attempt_no: number | null;
      sequence_no: number; action_type: ActionType; action_target: string;
      source_kind: ActionSourceKind; payload_digest: string;
      policy_version_hash: string | null; scope_hash: string | null;
      approval_id: string | null; recovery_approval_id: string | null;
      lease_holder_id: string | null; lease_version: number | null;
      rule_version: string; outcome_summary: string | null;
      l1_event_id: string; created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      workspaceId: row.workspace_id,
      frameId: row.frame_id,
      effectId: row.effect_id,
      attemptNo: row.attempt_no,
      sequenceNo: row.sequence_no,
      actionType: row.action_type,
      actionTarget: row.action_target,
      sourceKind: row.source_kind,
      payloadDigest: row.payload_digest,
      policyVersionHash: row.policy_version_hash,
      scopeHash: row.scope_hash,
      approvalId: row.approval_id,
      recoveryApprovalId: row.recovery_approval_id,
      leaseHolderId: row.lease_holder_id,
      leaseVersion: row.lease_version,
      ruleVersion: row.rule_version,
      outcomeSummary: row.outcome_summary,
      l1EventId: row.l1_event_id,
      createdAt: row.created_at,
    }));
  }

  /**
   * Renderer / audit-export projection: every closed-set field
   * passes through here unchanged. The renderer NEVER reads raw
   * SQLite, so the projection shape is what reaches UI strings.
   */
  projectionForRun(runId: string): Array<{
    id: string;
    runId: string;
    frameId: string;
    effectId: string | null;
    sequenceNo: number;
    actionType: ActionType;
    actionTarget: string;
    sourceKind: ActionSourceKind;
    payloadDigest: string;
    outcomeSummary: string | null;
    ruleVersion: string;
    createdAt: string;
  }> {
    return this.listForRun(runId).map((e) => ({
      id: e.id,
      runId: e.runId,
      frameId: e.frameId,
      effectId: e.effectId,
      sequenceNo: e.sequenceNo,
      actionType: e.actionType,
      actionTarget: e.actionTarget,
      sourceKind: e.sourceKind,
      payloadDigest: e.payloadDigest,
      outcomeSummary: e.outcomeSummary,
      ruleVersion: e.ruleVersion,
      createdAt: e.createdAt,
    }));
  }

  /**
   * Last ledger entry for a run, or null. Used by recovery to
   * decide "is the run still actively mutating" and by IPC handlers
   * to expose "what just happened".
   */
  lastForRun(runId: string): ActionLedgerEntry | null {
    const row = this.odb.getDB().prepare(`
      SELECT a.id, a.run_id, a.frame_id, a.effect_id, a.attempt_no,
             a.sequence_no, a.action_type, a.action_target,
             a.source_kind, a.payload_digest,
             a.policy_version_hash, a.scope_hash,
             a.approval_id, a.recovery_approval_id,
             a.lease_holder_id, a.lease_version,
             a.rule_version, a.outcome_summary, a.l1_event_id, a.created_at,
             ev.workspace_id AS workspace_id
        FROM action_ledger a
        JOIN run_events ev ON ev.id = a.l1_event_id
       WHERE a.run_id = ?
       ORDER BY a.sequence_no DESC
       LIMIT 1
    `).get(runId) as {
      id: string; run_id: string; workspace_id: string | null;
      frame_id: string; effect_id: string | null; attempt_no: number | null;
      sequence_no: number; action_type: ActionType; action_target: string;
      source_kind: ActionSourceKind; payload_digest: string;
      policy_version_hash: string | null; scope_hash: string | null;
      approval_id: string | null; recovery_approval_id: string | null;
      lease_holder_id: string | null; lease_version: number | null;
      rule_version: string; outcome_summary: string | null;
      l1_event_id: string; created_at: string;
    } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      runId: row.run_id,
      workspaceId: row.workspace_id,
      frameId: row.frame_id,
      effectId: row.effect_id,
      attemptNo: row.attempt_no,
      sequenceNo: row.sequence_no,
      actionType: row.action_type,
      actionTarget: row.action_target,
      sourceKind: row.source_kind,
      payloadDigest: row.payload_digest,
      policyVersionHash: row.policy_version_hash,
      scopeHash: row.scope_hash,
      approvalId: row.approval_id,
      recoveryApprovalId: row.recovery_approval_id,
      leaseHolderId: row.lease_holder_id,
      leaseVersion: row.lease_version,
      ruleVersion: row.rule_version,
      outcomeSummary: row.outcome_summary,
      l1EventId: row.l1_event_id,
      createdAt: row.created_at,
    };
  }

  /**
   * Hash helper. Public so callers can compute the canonical
   * payload digest without re-implementing canonicalization.
   */
  static hashPayload(payload: unknown): string {
    return crypto.createHash('sha256')
      .update(canonicalJSON(payload))
      .digest('hex');
  }
}
