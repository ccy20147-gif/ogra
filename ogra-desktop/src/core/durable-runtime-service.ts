/**
 * Sequence 1A Milestone 0 — DurableRuntimeService.
 *
 * Core-owned service that owns the durable runtime kernel:
 * - run_frames
 * - run_effects
 * - effect_receipts
 * - effect_approval_bindings
 * - approval_consumptions
 * - repair_transactions
 * - repair_steps
 * - recovery_leases
 * - audit_edges
 * - tool_descriptors / tool_versions / workspace_tool_bindings
 *
 * Invariants enforced here (all fail-closed with OgraError):
 * - Frame status transitions follow FRAME_TRANSITIONS exactly.
 * - Effect state transitions follow EFFECT_TRANSITIONS exactly.
 *   `unknown -> in_flight` additionally requires the holder to
 *   have an active recovery lease AND a new attempt number.
 * - The same idempotency_key_hash MUST NOT bind to two different
 *   owner frames (enforced by the SQLite UNIQUE partial index).
 * - The same idempotency_key_hash MUST NOT bind to a different
 *   payload_fingerprint (enforced at the service layer).
 * - Receipt appends use (effect_id, attempt_no) as the dedup key;
 *   re-issuing with the same key fails closed.
 * - Repair verifiers check sibling-overreach, dependency order,
 *   target subtree revision drift, and authorized revisions
 *   before a repair is accepted.
 * - Recovery leases use SQLite CAS: only the holder_id can
 *   renew or release, and the lease_version must match.
 * - All state changes are committed in the SAME SQLite transaction
 *   as their associated run_event.
 * - The raw idempotency key, raw payload, and raw provider
 *   response NEVER enter run_events or any normal SQLite column;
 *   only hashes / refs / versions are persisted.
 *
 * Out of scope for Milestone 0: actual adapter invocation,
 * ingress review, crash recovery execution, Agent Group, MCP.
 */

import * as crypto from 'crypto';
import { OgraError, OgraErrorCode } from '../shared/errors';
import {
  composeV2Envelope,
  envelopeV1Hash,
  envelopeV2Hash,
  GENESIS_HASH,
  HASH_ENVELOPE_VERSION_V1,
  HASH_ENVELOPE_VERSION_V2,
  payloadHash,
} from './audit-envelope';
import { canonicalJSON } from './audit-envelope';
import {
  AuditEdge,
  AuditEdgeDrift,
  AuditEdgeFromKind,
  AuditEdgeToKind,
  CreateFrameRequest,
  EffectReceipt,
  EffectState,
  EFFECT_TRANSITIONS,
  EffectTransitionRequest,
  FrameStatus,
  FRAME_TRANSITIONS,
  FrameTransitionRequest,
  LeaseAcquireRequest,
  LeaseReleaseRequest,
  LeaseRenewRequest,
  PlannedEffectRequest,
  ReceiptAppendRequest,
  RecoveryLease,
  RepairCommitAuthority,
  RepairCreateRequest,
  RepairStatus,
  RepairTransaction,
  RunEffect,
  RunFrame,
} from './durable-runtime-types';
import { OgraDatabase } from './database';
import type { EncryptedCapsuleStore, OpenCapsule } from './capsule-store';
import type { RecoveryConditionChecker } from './recovery-service';

/** Generic sqlite3-style row returned by db.getDB().prepare(...).get()/.all(). */
type SqliteRow = Record<string, unknown>;

/**
 * Identity type for the run_events v2 envelope audit fields that
 * DurableRuntimeService persists alongside a state transition.
 * We deliberately do NOT carry any sensitive payload here.
 */
export interface StateTransitionEventMeta {
  runId: string;
  workspaceId: string | null;
  eventType: string;
  eventPayload: Record<string, unknown>;
  policyVersionHash?: string | null;
  redactionRuleVersion?: string | null;
  /** Optional lineage fields required by plan 10 §6. */
  frameId?: string | null;
  effectId?: string | null;
  repairTransactionId?: string | null;
  causedByEventId?: string | null;
  idempotencyKeyHash?: string | null;
  externalReceiptHash?: string | null;
  targetSubtreeRevision?: number | null;
}

export class DurableRuntimeService {
  /**
   * The protocol attaches the workspace-keyed capsule verifier at startup.
   * It deliberately lives behind a narrow setter to keep the M0 runtime
   * usable by legacy projection tests, while M1 content-addressed capsule
   * evidence is never accepted without an AEAD verification capability.
   */
  private capsuleStore: EncryptedCapsuleStore | null = null;
  private repairConditionChecker: RecoveryConditionChecker | null = null;

  constructor(
    private readonly db: OgraDatabase,
    /** Caller supplies policy version hash so the runtime never
     *  invents one; it MUST be the active policy at the time of
     *  the state transition. */
    private readonly getPolicyVersionHash: () => string,
    /** Default redaction rule version. */
    private readonly getRedactionRuleVersion: () => string = () => 'r1.0.0',
  ) {}

  /** Convenience accessor for tests / future wiring. */
  getDatabase(): OgraDatabase {
    return this.db;
  }

  /** Current redaction authority for protocol evidence. OgraCore supplies
   * this from RedactionService; the constructor default remains solely for
   * legacy M0 fixtures that do not construct a Core. */
  getCurrentRedactionRuleVersion(): string {
    return this.getRedactionRuleVersion();
  }

  attachCapsuleStore(capsuleStore: EncryptedCapsuleStore): void {
    this.capsuleStore = capsuleStore;
  }

  /** Production installs the same current policy/route gate used by recovery.
   * The legacy synchronous repair API then fails closed for M1 effects rather
   * than silently skipping an async policy evaluation. */
  attachRepairConditionChecker(checker: RecoveryConditionChecker): void {
    this.repairConditionChecker = checker;
  }

  /* ============================================================
   * Frames
   * ============================================================ */

  createRootFrame(req: { runId: string; inputHash?: string | null }): RunFrame {
    const id = `frame_${crypto.randomBytes(6).toString('hex')}`;
    const now = new Date().toISOString();
    return this.transactionalAppend({
      meta: {
        runId: req.runId,
        workspaceId: null,
        eventType: 'frame_created',
        eventPayload: { frameId: id, frameKind: 'root', inputHash: req.inputHash ?? null },
        frameId: id,
      },
      body: (eventId) => {
        const insert = this.db.getDB().prepare(`
          INSERT INTO run_frames (id, run_id, parent_frame_id, run_step_id,
            frame_kind, status, path_json, node_revision, subtree_revision,
            input_hash, output_hash, created_event_id, created_at, updated_at)
          VALUES (?, ?, NULL, NULL, 'root', 'pending', '[]', 1, 1, ?, NULL, ?, ?, ?)
        `);
        insert.run(id, req.runId, req.inputHash ?? null, eventId, now, now);
        return this.readFrame(id);
      },
    });
  }

  createChildFrame(req: CreateFrameRequest): RunFrame {
    if (!req.parentFrameId) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'createChildFrame requires parentFrameId');
    }
    const parent = this.readFrame(req.parentFrameId);
    if (parent.runId !== req.runId) {
      throw new OgraError(OgraErrorCode.EFFECT_OWNER_MISMATCH,
        'child frame runId does not match parent frame runId');
    }
    const id = `frame_${crypto.randomBytes(6).toString('hex')}`;
    const now = new Date().toISOString();
    const path = [...parent.path, parent.id];
    return this.transactionalAppend({
      meta: {
        runId: req.runId,
        workspaceId: null,
        eventType: 'frame_created',
        eventPayload: {
          frameId: id, frameKind: req.frameKind, parentFrameId: req.parentFrameId,
          runStepId: req.runStepId ?? null, inputHash: req.inputHash ?? null,
        },
        frameId: id,
      },
      body: (eventId) => {
        const insert = this.db.getDB().prepare(`
          INSERT INTO run_frames (id, run_id, parent_frame_id, run_step_id,
            frame_kind, status, path_json, node_revision, subtree_revision,
            input_hash, output_hash, created_event_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'pending', ?, 1, 1, ?, NULL, ?, ?, ?)
        `);
        insert.run(
          id, req.runId, req.parentFrameId, req.runStepId ?? null,
          req.frameKind, JSON.stringify(path),
          req.inputHash ?? null, eventId, now, now,
        );
        // Bump parent subtree_revision so existing repair plans
        // targeting the old revision become invalid.
        this.db.getDB().prepare(
          'UPDATE run_frames SET subtree_revision = subtree_revision + 1, updated_at = ? WHERE id = ?',
        ).run(now, req.parentFrameId);
        return this.readFrame(id);
      },
    });
  }

  readFrame(frameId: string): RunFrame {
    const row = this.db.getDB().prepare(
      'SELECT * FROM run_frames WHERE id = ?',
    ).get(frameId) as SqliteRow | undefined;
    if (!row) {
      throw new OgraError(OgraErrorCode.FRAME_NOT_FOUND,
        `frame ${frameId} not found`);
    }
    return this.rowToFrame(row);
  }

  /**
   * Transition a frame to `nextStatus`. The transition must appear
   * in FRAME_TRANSITIONS[current -> next]; the optional
   * `expectedStatus` adds a CAS that fails closed if another writer
   * has moved the frame.
   */
  transitionFrame(req: FrameTransitionRequest): RunFrame {
    // Resolve runId from the frame so the audit event is bound
    // to the right run, even when the caller doesn't supply it.
    const existing = this.db.getDB().prepare(
      'SELECT run_id FROM run_frames WHERE id = ?',
    ).get(req.frameId) as { run_id: string } | undefined;
    if (!existing) {
      throw new OgraError(OgraErrorCode.FRAME_NOT_FOUND,
        `frame ${req.frameId} not found`);
    }
    return this.transactionalAppend({
      meta: {
        runId: existing.run_id,
        workspaceId: null,
        eventType: 'frame_transition',
        eventPayload: {
          frameId: req.frameId, nextStatus: req.nextStatus,
          outputHash: req.outputHash ?? null,
        },
        frameId: req.frameId,
      },
      body: (eventId) => {
        const row = this.db.getDB().prepare(
          'SELECT * FROM run_frames WHERE id = ?',
        ).get(req.frameId) as SqliteRow | undefined;
        if (!row) {
          throw new OgraError(OgraErrorCode.FRAME_NOT_FOUND,
            `frame ${req.frameId} not found`);
        }
        const currentStatus = row['status'] as FrameStatus;
        const allowed = FRAME_TRANSITIONS[currentStatus] ?? [];
        if (!allowed.includes(req.nextStatus)) {
          throw new OgraError(OgraErrorCode.FRAME_INVALID_TRANSITION,
            `frame ${req.frameId}: ${currentStatus} -> ${req.nextStatus} is not allowed`);
        }
        if (req.expectedStatus !== null && req.expectedStatus !== undefined
          && req.expectedStatus !== currentStatus) {
          throw new OgraError(OgraErrorCode.REVISION_CONFLICT,
            `frame ${req.frameId}: expected ${req.expectedStatus} but was ${currentStatus}`);
        }
        const now = new Date().toISOString();
        this.db.getDB().prepare(`
          UPDATE run_frames SET status = ?, output_hash = COALESCE(?, output_hash),
            subtree_revision = subtree_revision + 1,
            updated_at = ? WHERE id = ?
        `).run(req.nextStatus, req.outputHash ?? null, now, req.frameId);
        if (['completed', 'failed', 'cancelled'].includes(req.nextStatus)) {
          this.db.getDB().prepare('UPDATE run_frames SET terminal_event_id = ? WHERE id = ?')
            .run(eventId, req.frameId);
        }
        return this.readFrame(req.frameId);
      },
    });
  }

  /** Lookup the root frame for a run (frame with parent_frame_id NULL). */
  rootFrameForRun(runId: string): RunFrame | null {
    const row = this.db.getDB().prepare(
      'SELECT * FROM run_frames WHERE run_id = ? AND parent_frame_id IS NULL',
    ).get(runId) as SqliteRow | undefined;
    return row ? this.rowToFrame(row) : null;
  }

  /** Whether `candidateId` is `targetId` itself OR an ancestor. */
  isInSubtree(candidateId: string, targetId: string): boolean {
    let cur: string | null = candidateId;
    while (cur) {
      if (cur === targetId) return true;
      const row = this.db.getDB().prepare(
        'SELECT parent_frame_id FROM run_frames WHERE id = ?',
      ).get(cur) as { parent_frame_id: string | null } | undefined;
      if (!row) return false;
      cur = row.parent_frame_id;
    }
    return false;
  }

  /* ============================================================
   * Effects
   * ============================================================ */

  /**
   * Create a planned effect under `ownerFrameId`. The DB enforces
   * one (idempotency_key_hash, owner_frame_id) row; if a caller
   * tries to reuse the same idempotency key for a different owner
   * frame or payload_fingerprint, the service throws
   * EFFECT_IDEMPOTENCY_REUSED / EFFECT_PAYLOAD_FINGERPRINT_CHANGED.
   */
  planEffect(req: PlannedEffectRequest): RunEffect {
    if (!req.idempotencyKeyHash) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'planEffect requires idempotencyKeyHash');
    }
    if (!req.payloadFingerprint) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'planEffect requires payloadFingerprint');
    }
    // Verify owner frame belongs to the same run BEFORE inserting.
    const owner = this.readFrame(req.ownerFrameId);
    if (owner.runId !== req.runId) {
      throw new OgraError(OgraErrorCode.EFFECT_OWNER_MISMATCH,
        'planEffect: owner frame runId mismatch');
    }
    // Enforce: same idempotency_key_hash + different owner frame
    // is rejected at the service layer (the DB UNIQUE index is the
    // last line of defense, but we want a clean error here).
    const dup = this.db.getDB().prepare(
      'SELECT * FROM run_effects WHERE idempotency_key_hash = ? LIMIT 1',
    ).get(req.idempotencyKeyHash) as SqliteRow | undefined;
    if (dup) {
      if (dup['owner_frame_id'] !== req.ownerFrameId) {
        throw new OgraError(OgraErrorCode.EFFECT_IDEMPOTENCY_REUSED,
          `idempotency key hash reused across owner frames: ${req.idempotencyKeyHash}`);
      }
      if (dup['payload_fingerprint'] !== req.payloadFingerprint) {
        throw new OgraError(OgraErrorCode.EFFECT_PAYLOAD_FINGERPRINT_CHANGED,
          `idempotency key hash reused with different payload_fingerprint`);
      }
    }
    const id = `effect_${crypto.randomBytes(6).toString('hex')}`;
    const now = new Date().toISOString();
    return this.transactionalAppend({
      meta: {
        runId: req.runId,
        workspaceId: null,
        eventType: 'effect_planned',
        eventPayload: {
          effectId: id,
          effectType: req.effectType,
          adapterKind: req.adapterKind,
          ownerFrameId: req.ownerFrameId,
          payloadFingerprint: req.payloadFingerprint,
          callbackCapsuleHash: req.callbackCapsuleHash,
          idempotencyKeyHash: req.idempotencyKeyHash,
        },
        frameId: req.ownerFrameId,
        effectId: id,
        idempotencyKeyHash: req.idempotencyKeyHash,
      },
      body: (eventId) => {
        try {
          this.db.getDB().prepare(`
            INSERT INTO run_effects (id, run_id, owner_frame_id, effect_type,
              adapter_kind, payload_fingerprint, callback_capsule_ref,
              callback_capsule_hash, callback_capsule_format_version,
              idempotency_key_ref, idempotency_key_hash, state,
              allowed_repair_actions_json, dependency_effect_ids_json,
              effect_revision, route_decision_id, policy_evaluation_id,
              created_event_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned',
              ?, ?, 1, ?, ?, ?, ?, ?)
          `).run(
            id, req.runId, req.ownerFrameId, req.effectType,
            req.adapterKind, req.payloadFingerprint,
            req.callbackCapsuleRef, req.callbackCapsuleHash,
            req.callbackCapsuleFormatVersion,
            req.idempotencyKeyRef, req.idempotencyKeyHash,
            JSON.stringify(req.allowedRepairActions),
            JSON.stringify(req.dependencyEffectIds),
            req.routeDecisionId ?? null, req.policyEvaluationId ?? null,
            eventId, now, now,
          );
        } catch (err) {
          if (String((err as Error)?.message).includes('UNIQUE')) {
            throw new OgraError(OgraErrorCode.EFFECT_IDEMPOTENCY_REUSED,
              `idempotency key hash already used: ${req.idempotencyKeyHash}`);
          }
          throw err;
        }
        // Attach owner_frame -> effect edge.
        this.appendEdge({
          runId: req.runId,
          fromKind: 'frame',
          fromId: req.ownerFrameId,
          relation: 'owns_effect',
          toKind: 'effect',
          toId: id,
          sourceEventId: eventId,
        });
        return this.readEffect(id);
      },
    });
  }

  readEffect(effectId: string): RunEffect {
    const row = this.db.getDB().prepare(
      'SELECT * FROM run_effects WHERE id = ?',
    ).get(effectId) as SqliteRow | undefined;
    if (!row) {
      throw new OgraError(OgraErrorCode.EFFECT_NOT_FOUND,
        `effect ${effectId} not found`);
    }
    return this.rowToEffect(row);
  }

  /**
   * Transition an effect with revision CAS. State must appear in
   * EFFECT_TRANSITIONS[currentState -> nextState]. `unknown ->
   * in_flight` additionally requires the caller to hold the active
   * recovery lease and supply a new attempt number.
   */
  transitionEffect(
    req: EffectTransitionRequest & {
      leaseHolder?: string | null;
      nextAttemptNo?: number | null;
    },
  ): RunEffect {
    const current = this.readEffect(req.effectId);
    if (current.effectRevision !== req.expectedRevision) {
      throw new OgraError(OgraErrorCode.REVISION_CONFLICT,
        `effect ${req.effectId}: expected revision ${req.expectedRevision} but was ${current.effectRevision}`);
    }
    if (current.state !== req.expectedState) {
      throw new OgraError(OgraErrorCode.EFFECT_INVALID_TRANSITION,
        `effect ${req.effectId}: expected state ${req.expectedState} but was ${current.state}`);
    }
    const allowed = EFFECT_TRANSITIONS[current.state] ?? [];
    if (!allowed.includes(req.nextState)) {
      throw new OgraError(OgraErrorCode.EFFECT_INVALID_TRANSITION,
        `effect ${req.effectId}: ${current.state} -> ${req.nextState} is not allowed`);
    }
    // Callback intent is security-sensitive protocol work: it binds a sealed
    // capsule, approval consumption, audit event and state CAS atomically.
    // Generic runtime transitions must never manufacture an invocation.
    if (req.nextState === 'in_flight'
        && (current.state === 'planned' || current.state === 'unknown')) {
      throw new OgraError(OgraErrorCode.EFFECT_INVALID_TRANSITION,
        `${current.state} -> in_flight is reserved for EffectProtocolService`);
    }
    // unknown -> in_flight gate.
    if (current.state === 'unknown' && req.nextState === 'in_flight') {
      if (!req.leaseHolder || req.nextAttemptNo === null) {
        throw new OgraError(OgraErrorCode.LEASE_NOT_HELD,
          'unknown -> in_flight requires leaseHolder + nextAttemptNo');
      }
      const lease = this.readLease(current.runId);
      if (lease.holderId !== req.leaseHolder) {
        throw new OgraError(OgraErrorCode.LEASE_NOT_HELD,
          'lease not held by caller');
      }
      if (this.leaseExpired(lease)) {
        throw new OgraError(OgraErrorCode.LEASE_TAKEN_OVER,
          'lease has expired and may have been taken over');
      }
    }
    return this.transactionalAppend({
      meta: {
        runId: current.runId,
        workspaceId: null,
        eventType: 'effect_transition',
        eventPayload: {
          effectId: current.id,
          fromState: current.state,
          toState: req.nextState,
          revision: current.effectRevision,
          nextAttemptNo: req.nextAttemptNo ?? null,
        },
        effectId: current.id,
      },
      body: (eventId) => {
        const now = new Date().toISOString();
        const updateRes = this.db.getDB().prepare(`
          UPDATE run_effects SET state = ?, effect_revision = effect_revision + 1,
            updated_at = ? WHERE id = ? AND effect_revision = ?
        `).run(req.nextState, now, current.id, current.effectRevision);
        if (updateRes.changes === 0) {
          throw new OgraError(OgraErrorCode.REVISION_CONFLICT,
            `effect ${current.id}: revision CAS lost`);
        }
        if (['quarantined', 'compensated', 'failed', 'cancelled_before_send'].includes(req.nextState)) {
          this.db.getDB().prepare('UPDATE run_effects SET terminal_event_id = ? WHERE id = ?')
            .run(eventId, current.id);
        }
        return this.readEffect(current.id);
      },
    });
  }

  /** Forbid effects outside the target frame's subtree (or without explicit authorization). */
  assertEffectInSubtree(
    effectId: string,
    targetFrameId: string,
    authorizedFrameIds: string[],
  ): void {
    const effect = this.readEffect(effectId);
    if (this.isInSubtree(effect.ownerFrameId, targetFrameId)) return;
    if (authorizedFrameIds.includes(effect.ownerFrameId)) return;
    throw new OgraError(OgraErrorCode.REPAIR_SIBLING_OVERREACH,
      `effect ${effectId} is outside target frame subtree and not explicitly authorized`);
  }

  /* ============================================================
   * Receipts
   * ============================================================ */

  appendReceipt(req: ReceiptAppendRequest): EffectReceipt {
    const effect = this.readEffect(req.effectId);
    // Verify the effect can accept a receipt (i.e. it is in_flight
    // or unknown, and the attempt_no is greater than the highest
    // existing attempt_no).
    const existing = this.db.getDB().prepare(
      'SELECT MAX(attempt_no) as max FROM effect_receipts WHERE effect_id = ?',
    ).get(req.effectId) as { max: number | null };
    if (existing.max !== null && req.attemptNo <= existing.max) {
      throw new OgraError(OgraErrorCode.RECEIPT_DUPLICATE,
        `effect ${req.effectId} already has a receipt for attempt_no=${req.attemptNo}`);
    }
    const id = `rcp_${crypto.randomBytes(6).toString('hex')}`;
    const now = new Date().toISOString();
    const receiptHash = crypto.createHash('sha256').update(canonicalJSON({
      effectId: req.effectId,
      attemptNo: req.attemptNo,
      requestHash: req.requestHash,
      responseHash: req.responseHash,
      applicationStatus: req.applicationStatus,
      providerStatus: req.providerStatus,
    })).digest('hex');
    return this.transactionalAppend({
      meta: {
        runId: effect.runId,
        workspaceId: null,
        eventType: 'receipt_appended',
        eventPayload: {
          effectId: effect.id,
          attemptNo: req.attemptNo,
          applicationStatus: req.applicationStatus,
          receiptHash,
        },
        effectId: effect.id,
        externalReceiptHash: req.responseHash,
      },
      body: (eventId) => {
        try {
          this.db.getDB().prepare(`
            INSERT INTO effect_receipts (id, effect_id, attempt_no,
              request_id, request_hash, response_hash, result_capsule_ref,
              result_capsule_hash, result_capsule_format_version,
              provider_status, application_status, receipt_hash,
              received_at, event_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            id, req.effectId, req.attemptNo,
            req.requestId, req.requestHash, req.responseHash,
            req.resultCapsuleRef, req.resultCapsuleHash,
            req.resultCapsuleFormatVersion,
            req.providerStatus, req.applicationStatus, receiptHash, now, eventId,
          );
        } catch (err) {
          if (String((err as Error)?.message).includes('UNIQUE')) {
            throw new OgraError(OgraErrorCode.RECEIPT_DUPLICATE,
              `effect ${req.effectId}: attempt_no=${req.attemptNo} already has a receipt`);
          }
          throw err;
        }
        this.appendEdge({
          runId: effect.runId,
          fromKind: 'effect',
          fromId: effect.id,
          relation: 'has_receipt',
          toKind: 'receipt',
          toId: id,
          sourceEventId: eventId,
        });
        const row = this.db.getDB().prepare(
          'SELECT * FROM effect_receipts WHERE id = ?',
        ).get(id) as SqliteRow;
        return this.rowToReceipt(row);
      },
    });
  }

  readReceipt(effectId: string, attemptNo: number): EffectReceipt | null {
    const row = this.db.getDB().prepare(
      'SELECT * FROM effect_receipts WHERE effect_id = ? AND attempt_no = ?',
    ).get(effectId, attemptNo) as SqliteRow | undefined;
    return row ? this.rowToReceipt(row) : null;
  }

  /* ============================================================
   * Approval bindings
   * ============================================================ */

  recordApprovalBinding(req: {
    effectId: string;
    callbackAttemptNo: number;
    approvalId: string;
    approvalRevision: number;
    bindingKind: 'initial' | 'recovery_retry';
  }): { id: string } {
    const effect = this.readEffect(req.effectId);
    const id = `bind_${crypto.randomBytes(6).toString('hex')}`;
    return this.transactionalAppend({
      meta: {
        runId: effect.runId, workspaceId: null, eventType: 'approval_binding_created',
        eventPayload: { effectId: effect.id, approvalId: req.approvalId, callbackAttemptNo: req.callbackAttemptNo },
        effectId: effect.id,
      },
      body: (eventId) => {
      try {
        this.db.getDB().prepare(`
          INSERT INTO effect_approval_bindings (id, effect_id,
            callback_attempt_no, approval_id, approval_revision,
            binding_kind, created_event_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(id, req.effectId, req.callbackAttemptNo, req.approvalId,
          req.approvalRevision, req.bindingKind, eventId);
      } catch (err) {
        if (String((err as Error)?.message).includes('UNIQUE')) {
          throw new OgraError(OgraErrorCode.REVISION_CONFLICT,
            `effect ${req.effectId} already has a binding for attempt_no=${req.callbackAttemptNo}`);
        }
        throw err;
      }
      this.appendEdge({
        runId: effect.runId,
        fromKind: 'effect',
        fromId: effect.id,
        relation: 'bound_to_approval',
        toKind: 'approval',
        toId: req.approvalId,
        sourceEventId: eventId,
      });
        return { id };
      },
    });
  }

  /* ============================================================
   * Repair
   * ============================================================ */

  createRepair(req: RepairCreateRequest): RepairTransaction {
    if (this.repairConditionChecker && this.hasM1RepairEvidence(req)) {
      throw new OgraError(OgraErrorCode.REPAIR_INVALID,
        'M1 repair requires createRepairWithCurrentConditions()');
    }
    return this.createRepairInternal(req);
  }

  async createRepairWithCurrentConditions(req: RepairCreateRequest): Promise<RepairTransaction> {
    if (!this.repairConditionChecker) {
      throw new OgraError(OgraErrorCode.REPAIR_INVALID,
        'M1 repair current policy/route verifier is not configured');
    }
    for (const step of req.proposedPlan) {
      const effect = this.readEffect(step.effectId);
      const result = await this.repairConditionChecker.check({
        effect,
        approvalId: effect.currentApprovalId,
        policyVersionHash: effect.policyVersionHash,
        routeDecisionId: effect.routeDecisionId,
        payloadFingerprint: effect.payloadFingerprint,
        scopeHash: effect.scopeHash,
      });
      if (!result.ok) {
        throw new OgraError(OgraErrorCode.REPAIR_INVALID,
          `effect ${effect.id} current policy/route check failed: ${result.reason ?? 'unknown'}`);
      }
    }
    return this.createRepairInternal(req);
  }

  private hasM1RepairEvidence(req: RepairCreateRequest): boolean {
    return req.proposedPlan.some(step => {
      const effect = this.readEffect(step.effectId);
      return !!(effect.routeDecisionId || effect.policyVersionHash || effect.capsuleFingerprint);
    });
  }

  private createRepairInternal(req: RepairCreateRequest): RepairTransaction {
    const target = this.readFrame(req.targetFrameId);
    if (target.runId !== req.runId) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'repair target frame belongs to a different run');
    }
    // Verify sibling-overreach and authorized revisions BEFORE
    // persisting.
    this.verifyRepairInvariants(req, target);
    const id = `repair_${crypto.randomBytes(6).toString('hex')}`;
    const now = new Date().toISOString();
    return this.transactionalAppend({
      meta: {
        runId: req.runId,
        workspaceId: null,
        eventType: 'repair_created',
        eventPayload: {
          repairTransactionId: id,
          targetFrameId: req.targetFrameId,
          targetSubtreeRevision: req.expectedSubtreeRevision,
          proposedStepCount: req.proposedPlan.length,
        },
        repairTransactionId: id,
        frameId: req.targetFrameId,
        targetSubtreeRevision: req.expectedSubtreeRevision,
      },
      body: (eventId) => {
        this.db.getDB().prepare(`
          INSERT INTO repair_transactions (id, run_id, target_frame_id,
            target_subtree_revision, authorized_effect_revisions_json,
            proposed_plan_json, verification_result_json, status, created_event_id,
            created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
        `).run(
          id, req.runId, req.targetFrameId,
          req.expectedSubtreeRevision,
          JSON.stringify(req.authorizedEffectRevisions),
          JSON.stringify(req.proposedPlan),
          JSON.stringify({ crossFrameApprovalIds: req.crossFrameApprovalIds ?? {} }),
          eventId,
          now, now,
        );
        for (const step of req.proposedPlan) {
          const approvalId = req.crossFrameApprovalIds?.[step.effectId];
          if (!approvalId) continue;
          this.db.getDB().prepare(`
            INSERT INTO repair_cross_frame_authorizations (id, repair_transaction_id,
              run_id, target_frame_id, effect_id, effect_revision, approval_id,
              created_event_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            `rcfa_${crypto.randomBytes(6).toString('hex')}`, id, req.runId,
            req.targetFrameId, step.effectId, step.expectedEffectRevision,
            approvalId, eventId,
          );
        }
        for (let i = 0; i < req.proposedPlan.length; i++) {
          this.db.getDB().prepare(`
            INSERT INTO repair_steps (id, repair_transaction_id,
              step_index, effect_id, action, status)
            VALUES (?, ?, ?, ?, ?, 'pending')
          `).run(`rs_${crypto.randomBytes(6).toString('hex')}`,
            id, i, req.proposedPlan[i].effectId,
            req.proposedPlan[i].action);
        }
        this.appendEdge({
          runId: req.runId,
          fromKind: 'frame',
          fromId: req.targetFrameId,
          relation: 'has_repair',
          toKind: 'repair',
          toId: id,
          sourceEventId: eventId,
        });
        const row = this.db.getDB().prepare(
          'SELECT * FROM repair_transactions WHERE id = ?',
        ).get(id) as SqliteRow;
        return this.rowToRepair(row);
      },
    });
  }

  private verifyRepairInvariants(
    req: RepairCreateRequest,
    target: RunFrame,
  ): void {
    // (a) target frame must still be at the snapshotted subtree revision
    const current = this.readFrame(req.targetFrameId);
    if (current.subtreeRevision !== req.expectedSubtreeRevision) {
      throw new OgraError(OgraErrorCode.REPAIR_SUBTREE_REVISION_DRIFT,
        `repair target subtree_revision drifted: expected ${req.expectedSubtreeRevision} but was ${current.subtreeRevision}`);
    }
    // (b) each effect must exist and appear at most once in the plan
    const seen = new Set<string>();
    for (const step of req.proposedPlan) {
      if (seen.has(step.effectId)) {
        throw new OgraError(OgraErrorCode.REPAIR_INVALID,
          `effect ${step.effectId} appears more than once in the repair plan`);
      }
      seen.add(step.effectId);
      const effect = this.readEffect(step.effectId);
      if (effect.runId !== req.runId) {
        throw new OgraError(OgraErrorCode.EFFECT_OWNER_MISMATCH,
          `effect ${effect.id} belongs to a different run`);
      }
      // (c) sibling overreach: a request-local list is never authority. An
      // out-of-subtree effect needs an approved, exact-scope durable approval
      // that will be copied into repair_cross_frame_authorizations with the
      // generated repair id in the same event transaction.
      if (!this.isInSubtree(effect.ownerFrameId, target.id)) {
        if ((req.authorizedCrossFrameEffectIds ?? []).includes(effect.id)) {
          throw new OgraError(OgraErrorCode.REPAIR_INVALID,
            `effect ${effect.id} cross-frame ids are not durable authority`);
        }
        this.verifyCrossFrameApproval(
          req.crossFrameApprovalIds?.[effect.id] ?? null,
          req.runId, target.id, effect, step.expectedEffectRevision,
        );
      }
      // (d) revision snapshot must match effect's current revision
      if (req.authorizedEffectRevisions[effect.id] !== step.expectedEffectRevision
          || effect.effectRevision !== step.expectedEffectRevision) {
        throw new OgraError(OgraErrorCode.REPAIR_INVALID,
          `effect ${effect.id} revision drift: expected ${step.expectedEffectRevision} but was ${effect.effectRevision}`);
      }
      if (!effect.allowedRepairActions.includes(step.action)
          || !this.isRepairActionAllowedInState(step.action, effect.state)) {
        throw new OgraError(OgraErrorCode.REPAIR_INVALID,
          `repair action ${step.action} is not permitted for effect ${effect.id} in ${effect.state}`);
      }
      this.verifyRepairEffectEvidence(effect);
    }
    // (e) dependencies must appear before dependents in the plan
    const stepIndexByEffect = new Map<string, number>();
    req.proposedPlan.forEach((step, i) => stepIndexByEffect.set(step.effectId, i));
    for (const step of req.proposedPlan) {
      const effect = this.readEffect(step.effectId);
      for (const depId of effect.dependencyEffectIds) {
        const depIdx = stepIndexByEffect.get(depId);
        if (depIdx === undefined) {
          throw new OgraError(OgraErrorCode.REPAIR_INVALID,
            `effect ${effect.id} depends on ${depId} which is not in the plan`);
        }
        if (depIdx >= stepIndexByEffect.get(effect.id)!) {
          throw new OgraError(OgraErrorCode.REPAIR_DEPENDENCY_REVERSED,
            `effect ${effect.id} (step ${stepIndexByEffect.get(effect.id)}) depends on ${depId} which appears AFTER it`);
        }
      }
    }
  }

  private verifyCrossFrameApproval(
    approvalId: string | null, runId: string, targetFrameId: string,
    effect: RunEffect, expectedEffectRevision: number,
  ): void {
    if (!approvalId) {
      throw new OgraError(OgraErrorCode.REPAIR_SIBLING_OVERREACH,
        `effect ${effect.id} is outside target frame subtree ${targetFrameId}`);
    }
    const approval = this.db.getDB().prepare(`
      SELECT run_id, approval_type, decision, expires_at, effect_id,
             effect_revision, requested_scope_json, payload_fingerprint,
             scope_hash, policy_version_hash
        FROM approvals WHERE id = ?
    `).get(approvalId) as {
      run_id: string | null; approval_type: string; decision: string;
      expires_at: string | null; effect_id: string | null;
      effect_revision: number | null; requested_scope_json: string | null;
      payload_fingerprint: string | null; scope_hash: string | null;
      policy_version_hash: string | null;
    } | undefined;
    let scope: Record<string, unknown> | null = null;
    try { scope = approval?.requested_scope_json ? JSON.parse(approval.requested_scope_json) : null; } catch { /* fail below */ }
    if (!approval || approval.decision !== 'approved'
        || approval.approval_type !== 'repair_cross_frame'
        || (approval.expires_at && approval.expires_at <= new Date().toISOString())
        || approval.run_id !== runId || approval.effect_id !== effect.id
        || approval.effect_revision !== expectedEffectRevision
        || approval.payload_fingerprint !== effect.payloadFingerprint
        || approval.scope_hash !== effect.scopeHash
        || approval.policy_version_hash !== effect.policyVersionHash
        || !scope || scope.runId !== runId || scope.targetFrameId !== targetFrameId
        || scope.effectId !== effect.id || scope.effectRevision !== expectedEffectRevision) {
      throw new OgraError(OgraErrorCode.REPAIR_INVALID,
        `effect ${effect.id} cross-frame approval is missing, stale, or out of scope`);
    }
  }

  private isRepairActionAllowedInState(action: string, state: EffectState): boolean {
    switch (action) {
      case 'retry': return state === 'planned' || state === 'unknown' || state === 'failed';
      case 'compensate': return state === 'committed';
      case 'amend': return state === 'planned' || state === 'unknown';
      case 'reconcile': return state === 'in_flight' || state === 'unknown' || state === 'received';
      case 'preserve': return !['compensated', 'cancelled_before_send'].includes(state);
      case 'escalate': return true;
      default: return false;
    }
  }

  /** Repair is a durable authorization boundary, not a graph edit. */
  private verifyRepairEffectEvidence(effect: RunEffect): void {
    if (!effect.callbackCapsuleRef || !effect.callbackCapsuleHash
        || !effect.callbackCapsuleFormatVersion || !effect.idempotencyKeyRef
        || !effect.idempotencyKeyHash) {
      throw new OgraError(OgraErrorCode.REPAIR_INVALID,
        `effect ${effect.id} is missing callback capsule or idempotency evidence`);
    }
    // Real M1 capsule refs are content-addressed SHA-256 values.  Opaque
    // legacy projections have no immutable, decryptable provenance and must
    // never be accepted once the M1 capsule authority is wired.  The sole
    // compatibility boundary is an M0-only runtime without a capsule store;
    // it cannot execute M1 recovery and therefore cannot use this as an
    // externally visible retry path.
    const hasContentAddressedRef = /^[a-f0-9]{64}$/i.test(effect.callbackCapsuleRef);
    if (!hasContentAddressedRef && this.capsuleStore) {
      throw new OgraError(OgraErrorCode.REPAIR_INVALID,
        `effect ${effect.id} has opaque legacy callback provenance; M1 repair is prohibited`);
    }
    if (hasContentAddressedRef) {
      if (!this.capsuleStore) {
        throw new OgraError(OgraErrorCode.REPAIR_INVALID,
          `effect ${effect.id} sealed callback cannot be verified without a capsule store`);
      }
      let opened: OpenCapsule<{
        egressPayloadFingerprint?: unknown;
        idempotencyKeyHash?: unknown;
        idempotencyKey?: unknown;
      }>;
      try {
        opened = this.capsuleStore.open(effect.callbackCapsuleRef);
      } catch {
        throw new OgraError(OgraErrorCode.REPAIR_INVALID,
          `effect ${effect.id} callback capsule cannot be authenticated`);
      }
      const expectedCapsuleFingerprint = effect.capsuleFingerprint ?? effect.payloadFingerprint;
      const idempotencyKey = opened.payload?.idempotencyKey;
      const recomputedIdempotencyHash = typeof idempotencyKey === 'string'
        ? crypto.createHash('sha256').update(idempotencyKey).digest('hex')
        : null;
      const canonicalCallbackFingerprint = crypto.createHash('sha256')
        .update(canonicalJSON(opened.payload)).digest('hex');
      if (opened.verifiedHash !== effect.callbackCapsuleHash
          || opened.binding.capsuleKind !== 'callback'
          || opened.binding.formatVersion !== effect.callbackCapsuleFormatVersion
          || opened.binding.runId !== effect.runId
          || opened.binding.effectId !== effect.id
          || opened.binding.adapterKind !== effect.adapterKind
          || opened.binding.payloadFingerprint !== expectedCapsuleFingerprint
          || canonicalCallbackFingerprint !== expectedCapsuleFingerprint
          || opened.payload?.egressPayloadFingerprint !== effect.payloadFingerprint
          || opened.payload?.idempotencyKeyHash !== effect.idempotencyKeyHash
          || recomputedIdempotencyHash !== effect.idempotencyKeyHash
          || effect.idempotencyKeyRef !== effect.callbackCapsuleRef) {
        throw new OgraError(OgraErrorCode.REPAIR_INVALID,
          `effect ${effect.id} callback capsule/idempotency evidence is not intact`);
      }
      // A real M1 sealed effect has no legitimate unscoped repair path.
      // Keep the M0 projection compatibility below, but require current
      // route/policy evidence before a content-addressed callback can enter
      // a repair transaction.
      if (!effect.routeDecisionId || !effect.policyVersionHash) {
        throw new OgraError(OgraErrorCode.REPAIR_INVALID,
          `effect ${effect.id} is missing route or policy evidence`);
      }
    }
    let routeKind: string | null = null;
    if (effect.routeDecisionId) {
      const route = this.db.getDB().prepare(
        'SELECT route FROM route_decisions WHERE id = ? AND run_id = ?',
      ).get(effect.routeDecisionId, effect.runId) as { route: string } | undefined;
      if (!route || route.route === 'blocked') {
        throw new OgraError(OgraErrorCode.REPAIR_INVALID,
          `effect ${effect.id} route is missing or blocked`);
      }
      routeKind = route.route;
    }
    if (effect.currentApprovalId) {
      const approval = this.db.getDB().prepare(
        `SELECT decision, expires_at, payload_fingerprint, scope_hash, policy_version_hash
           FROM approvals WHERE id = ?`,
      ).get(effect.currentApprovalId) as {
        decision: string; expires_at: string | null; payload_fingerprint: string | null;
        scope_hash: string | null; policy_version_hash: string | null;
      } | undefined;
      if (!approval || approval.decision !== 'approved'
          || (approval.expires_at && approval.expires_at <= new Date().toISOString())
          || approval.payload_fingerprint !== effect.payloadFingerprint
          || approval.scope_hash !== effect.scopeHash
          || approval.policy_version_hash !== effect.policyVersionHash) {
        throw new OgraError(OgraErrorCode.REPAIR_INVALID,
          `effect ${effect.id} approval evidence is stale or mismatched`);
      }
    }
    if (effect.policyVersionHash && effect.policyVersionHash !== this.getPolicyVersionHash()) {
      throw new OgraError(OgraErrorCode.REPAIR_INVALID,
        `effect ${effect.id} policy version is stale`);
    }
    if (routeKind === 'redact_then_egress' && (!effect.redactionRuleVersion
        || effect.redactionRuleVersion !== this.getRedactionRuleVersion())) {
      throw new OgraError(OgraErrorCode.REPAIR_INVALID,
        `effect ${effect.id} redaction rule version is stale or missing`);
    }
  }

  setRepairStatus(
    repairId: string,
    next: RepairStatus,
    rejectionReason?: string,
    commitAuthority?: RepairCommitAuthority,
  ): RepairTransaction {
    if (next === 'committed' && this.repairConditionChecker) {
      throw new OgraError(OgraErrorCode.REPAIR_INVALID,
        'M1 repair commit requires setRepairStatusWithCurrentConditions()');
    }
    return this.setRepairStatusInternal(repairId, next, rejectionReason, commitAuthority);
  }

  async setRepairStatusWithCurrentConditions(
    repairId: string,
    next: RepairStatus,
    commitAuthority: RepairCommitAuthority,
    rejectionReason?: string,
  ): Promise<RepairTransaction> {
    if (next !== 'committed') {
      return this.setRepairStatusInternal(repairId, next, rejectionReason, commitAuthority);
    }
    if (!this.repairConditionChecker) {
      throw new OgraError(OgraErrorCode.REPAIR_INVALID,
        'M1 repair current policy/route verifier is not configured');
    }
    const row = this.db.getDB().prepare(
      'SELECT proposed_plan_json FROM repair_transactions WHERE id = ?',
    ).get(repairId) as { proposed_plan_json: string } | undefined;
    if (!row) throw new OgraError(OgraErrorCode.REPAIR_NOT_FOUND, `repair ${repairId} not found`);
    const steps = JSON.parse(row.proposed_plan_json || '[]') as Array<{ effectId: string }>;
    for (const step of steps) {
      const effect = this.readEffect(step.effectId);
      const result = await this.repairConditionChecker.check({
        effect, approvalId: effect.currentApprovalId,
        policyVersionHash: effect.policyVersionHash,
        routeDecisionId: effect.routeDecisionId,
        payloadFingerprint: effect.payloadFingerprint, scopeHash: effect.scopeHash,
      });
      if (!result.ok) {
        throw new OgraError(OgraErrorCode.REPAIR_INVALID,
          `effect ${effect.id} current policy/route check failed: ${result.reason ?? 'unknown'}`);
      }
    }
    return this.setRepairStatusInternal(repairId, next, rejectionReason, commitAuthority);
  }

  private setRepairStatusInternal(
    repairId: string,
    next: RepairStatus,
    rejectionReason?: string,
    commitAuthority?: RepairCommitAuthority,
  ): RepairTransaction {
    const row = this.db.getDB().prepare(
      'SELECT * FROM repair_transactions WHERE id = ?',
    ).get(repairId) as SqliteRow | undefined;
    if (!row) {
      throw new OgraError(OgraErrorCode.REPAIR_NOT_FOUND,
        `repair ${repairId} not found`);
    }
    const current = row['status'] as RepairStatus;
    const allowed: Record<RepairStatus, RepairStatus[]> = {
      open: ['accepted', 'rejected', 'aborted'],
      accepted: ['committed', 'aborted', 'rejected'],
      rejected: [],
      committed: [],
      aborted: [],
    };
    if (!allowed[current].includes(next)) {
      throw new OgraError(OgraErrorCode.REPAIR_INVALID,
        `repair ${repairId}: ${current} -> ${next} is not allowed`);
    }
    if (next === 'committed') {
      const target = this.readFrame(row['target_frame_id'] as string);
      this.verifyRepairInvariants({
        runId: row['run_id'] as string,
        targetFrameId: target.id,
        expectedSubtreeRevision: row['target_subtree_revision'] as number,
        authorizedEffectRevisions: JSON.parse(
          (row['authorized_effect_revisions_json'] as string) || '{}',
        ) as Record<string, number>,
        crossFrameApprovalIds: this.crossFrameApprovalIdsForRepair(repairId),
        proposedPlan: JSON.parse((row['proposed_plan_json'] as string) || '[]'),
      }, target);
      if (!commitAuthority) {
        throw new OgraError(OgraErrorCode.LEASE_NOT_HELD,
          `repair ${repairId} commit requires captured recovery lease authority`);
      }
    }
    return this.transactionalAppend({
      meta: {
        runId: row['run_id'] as string,
        workspaceId: this.workspaceIdForRun(row['run_id'] as string),
        eventType: 'repair_status_changed',
        eventPayload: { repairTransactionId: repairId, fromStatus: current, toStatus: next },
        repairTransactionId: repairId,
        frameId: row['target_frame_id'] as string,
      },
      body: (eventId) => {
      if (next === 'committed') {
        // Re-read and re-validate inside the transaction.  A pre-transaction
        // check is useful for diagnostics, but is not authorization: the
        // lease or subtree could change between it and this status CAS.
        this.assertActiveRepairLease(
          row['run_id'] as string,
          commitAuthority!.holderId,
          commitAuthority!.expectedLeaseVersion,
        );
        const target = this.readFrame(row['target_frame_id'] as string);
        this.verifyRepairInvariants({
          runId: row['run_id'] as string,
          targetFrameId: target.id,
          expectedSubtreeRevision: row['target_subtree_revision'] as number,
          authorizedEffectRevisions: JSON.parse(
            (row['authorized_effect_revisions_json'] as string) || '{}',
          ) as Record<string, number>,
          crossFrameApprovalIds: this.crossFrameApprovalIdsForRepair(repairId),
          proposedPlan: JSON.parse((row['proposed_plan_json'] as string) || '[]'),
        }, target);
      }
      const now = new Date().toISOString();
      const statusCas = this.db.getDB().prepare(`
        UPDATE repair_transactions SET status = ?, rejection_reason = ?, updated_at = ?
          WHERE id = ? AND status = ?
      `).run(next, rejectionReason ?? null, now, repairId, current);
      if (statusCas.changes !== 1) {
        throw new OgraError(OgraErrorCode.REVISION_CONFLICT,
          `repair ${repairId} status CAS lost`);
      }
      if (['rejected', 'committed', 'aborted'].includes(next)) {
        this.db.getDB().prepare(
          'UPDATE repair_transactions SET terminal_event_id = ? WHERE id = ?',
        ).run(eventId, repairId);
      }
      return this.readRepair(repairId);
      },
    });
  }

  private assertActiveRepairLease(
    runId: string, holderId: string, expectedLeaseVersion: number,
  ): void {
    const row = this.db.getDB().prepare(`
      SELECT 1 FROM recovery_leases WHERE run_id = ? AND holder_id = ?
        AND lease_version = ? AND released_at IS NULL AND expires_at > ?
    `).get(runId, holderId, expectedLeaseVersion, new Date().toISOString());
    if (!row) {
      throw new OgraError(OgraErrorCode.LEASE_NOT_HELD,
        `repair commit lease is not actively held by ${holderId}`);
    }
  }

  private crossFrameApprovalIdsForRepair(repairId: string): Record<string, string> {
    const rows = this.db.getDB().prepare(`
      SELECT effect_id, approval_id FROM repair_cross_frame_authorizations
       WHERE repair_transaction_id = ?
    `).all(repairId) as Array<{ effect_id: string; approval_id: string }>;
    return Object.fromEntries(rows.map(row => [row.effect_id, row.approval_id]));
  }

  readRepair(repairId: string): RepairTransaction {
    const row = this.db.getDB().prepare(
      'SELECT * FROM repair_transactions WHERE id = ?',
    ).get(repairId) as SqliteRow | undefined;
    if (!row) {
      throw new OgraError(OgraErrorCode.REPAIR_NOT_FOUND,
        `repair ${repairId} not found`);
    }
    return this.rowToRepair(row);
  }

  /* ============================================================
   * Recovery Lease (single local holder, SQLite CAS)
   * ============================================================ */

  acquireLease(req: LeaseAcquireRequest): RecoveryLease {
    if (!req.holderId) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'acquireLease requires holderId');
    }
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + Math.max(1, req.ttlMs)).toISOString();
    return this.transactionalAppend({
      meta: {
        runId: req.runId,
        workspaceId: this.workspaceIdForRun(req.runId),
        eventType: 'recovery_lease_acquired',
        eventPayload: { holderId: req.holderId, expiresAt: expires },
      },
      body: (eventId) => {
      const existing = this.db.getDB().prepare(
        'SELECT * FROM recovery_leases WHERE run_id = ?',
      ).get(req.runId) as SqliteRow | undefined;
      if (existing) {
        // Active lease held by someone else: refuse.
        if (!existing['released_at']) {
          const isExpired = new Date(existing['expires_at'] as string).getTime() <= Date.now();
          if (!isExpired) {
            throw new OgraError(OgraErrorCode.LEASE_VERSION_CONFLICT,
              `lease for run ${req.runId} is held by ${existing['holder_id']}`);
          }
          // Expired — take over by replacing the row.
          this.db.getDB().prepare(`
            UPDATE recovery_leases SET holder_id = ?, lease_version = lease_version + 1,
              acquired_at = ?, expires_at = ?, renewed_at = ?, released_at = NULL,
              last_event_id = ?
              WHERE run_id = ?
          `).run(req.holderId, now, expires, now, eventId, req.runId);
          const after = this.db.getDB().prepare(
            'SELECT * FROM recovery_leases WHERE run_id = ?',
          ).get(req.runId) as SqliteRow;
          return this.rowToLease(after);
        }
        // Released lease: bump version, write fresh row.
        this.db.getDB().prepare(`
          UPDATE recovery_leases SET holder_id = ?, lease_version = lease_version + 1,
            acquired_at = ?, expires_at = ?, renewed_at = ?, released_at = NULL,
            last_event_id = ?
            WHERE run_id = ?
        `).run(req.holderId, now, expires, now, eventId, req.runId);
        const after = this.db.getDB().prepare(
          'SELECT * FROM recovery_leases WHERE run_id = ?',
        ).get(req.runId) as SqliteRow;
        return this.rowToLease(after);
      }
      this.db.getDB().prepare(`
        INSERT INTO recovery_leases (run_id, holder_id, lease_version,
          acquired_at, expires_at, renewed_at, last_event_id)
        VALUES (?, ?, 1, ?, ?, ?, ?)
      `).run(req.runId, req.holderId, now, expires, now, eventId);
      const after = this.db.getDB().prepare(
        'SELECT * FROM recovery_leases WHERE run_id = ?',
      ).get(req.runId) as SqliteRow;
      return this.rowToLease(after);
      },
    });
  }

  renewLease(req: LeaseRenewRequest): RecoveryLease {
    return this.transactionalAppend({
      meta: {
        runId: req.runId,
        workspaceId: this.workspaceIdForRun(req.runId),
        eventType: 'recovery_lease_renewed',
        eventPayload: { holderId: req.holderId, expectedLeaseVersion: req.expectedLeaseVersion },
      },
      body: (eventId) => {
      const existing = this.db.getDB().prepare(
        'SELECT * FROM recovery_leases WHERE run_id = ?',
      ).get(req.runId) as SqliteRow | undefined;
      if (!existing) {
        throw new OgraError(OgraErrorCode.LEASE_NOT_HELD,
          `no lease for run ${req.runId}`);
      }
      if (existing['holder_id'] !== req.holderId) {
        throw new OgraError(OgraErrorCode.LEASE_NOT_HELD,
          `lease held by a different holder`);
      }
      if ((existing['lease_version'] as number) !== req.expectedLeaseVersion) {
        throw new OgraError(OgraErrorCode.LEASE_VERSION_CONFLICT,
          `lease_version CAS lost: expected ${req.expectedLeaseVersion} but was ${existing['lease_version']}`);
      }
      if (existing['released_at']) {
        throw new OgraError(OgraErrorCode.LEASE_NOT_HELD,
          'lease has been released');
      }
      if (new Date(existing['expires_at'] as string).getTime() <= Date.now()) {
        throw new OgraError(OgraErrorCode.LEASE_TAKEN_OVER,
          'lease expired; may have been taken over');
      }
      const now = new Date().toISOString();
      const expires = new Date(Date.now() + Math.max(1, req.ttlMs)).toISOString();
      const renewRes = this.db.getDB().prepare(`
        UPDATE recovery_leases SET lease_version = lease_version + 1,
          expires_at = ?, renewed_at = ?, last_event_id = ?
          WHERE run_id = ? AND lease_version = ?
      `).run(expires, now, eventId, req.runId, req.expectedLeaseVersion);
      if (renewRes.changes === 0) {
        throw new OgraError(OgraErrorCode.LEASE_VERSION_CONFLICT,
          'lease renew CAS lost');
      }
      const after = this.db.getDB().prepare(
        'SELECT * FROM recovery_leases WHERE run_id = ?',
      ).get(req.runId) as SqliteRow;
      return this.rowToLease(after);
      },
    });
  }

  releaseLease(req: LeaseReleaseRequest): void {
    const existing = this.db.getDB().prepare(
        'SELECT * FROM recovery_leases WHERE run_id = ?',
      ).get(req.runId) as SqliteRow | undefined;
    if (!existing || existing['holder_id'] !== req.holderId) return;
    this.transactionalAppend({
      meta: {
        runId: req.runId,
        workspaceId: this.workspaceIdForRun(req.runId),
        eventType: 'recovery_lease_released',
        eventPayload: { holderId: req.holderId, expectedLeaseVersion: req.expectedLeaseVersion },
      },
      body: (eventId) => {
      const current = this.db.getDB().prepare(
        'SELECT * FROM recovery_leases WHERE run_id = ?',
      ).get(req.runId) as SqliteRow | undefined;
      if (!current || current['holder_id'] !== req.holderId) {
        throw new OgraError(OgraErrorCode.LEASE_NOT_HELD, 'lease is no longer held by caller');
      }
      if ((current['lease_version'] as number) !== req.expectedLeaseVersion) {
        throw new OgraError(OgraErrorCode.LEASE_VERSION_CONFLICT,
          'release CAS lost');
      }
      const now = new Date().toISOString();
      this.db.getDB().prepare(`
        UPDATE recovery_leases SET released_at = ?, lease_version = lease_version + 1,
          last_event_id = ?
          WHERE run_id = ? AND lease_version = ?
      `).run(now, eventId, req.runId, req.expectedLeaseVersion);
      },
    });
  }

  readLease(runId: string): RecoveryLease {
    const row = this.db.getDB().prepare(
      'SELECT * FROM recovery_leases WHERE run_id = ?',
    ).get(runId) as SqliteRow | undefined;
    if (!row) {
      throw new OgraError(OgraErrorCode.LEASE_NOT_HELD,
        `no lease for run ${runId}`);
    }
    return this.rowToLease(row);
  }

  leaseExpired(lease: RecoveryLease): boolean {
    if (lease.releasedAt) return true;
    return new Date(lease.expiresAt).getTime() <= Date.now();
  }

  /* ============================================================
   * Audit Edges
   * ============================================================ */

  appendEdge(req: {
    runId: string;
    fromKind: AuditEdgeFromKind;
    fromId: string;
    relation: string;
    toKind: AuditEdgeToKind;
    toId: string;
    sourceEventId: string | null;
  }): void {
    try {
      this.db.getDB().prepare(`
        INSERT INTO audit_edges (id, run_id, from_kind, from_id, relation,
          to_kind, to_id, source_event_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(`edge_${crypto.randomBytes(6).toString('hex')}`,
        req.runId, req.fromKind, req.fromId, req.relation,
        req.toKind, req.toId, req.sourceEventId);
    } catch (err) {
      // UNIQUE means an identical edge already exists; ignore.
      if (!String((err as Error)?.message).includes('UNIQUE')) {
        throw err;
      }
    }
  }

  /**
   * Walk the authoritative state for a run and verify that every
   * expected edge is present in `audit_edges`. Drift is reported
   * as AuditEdgeDrift; the caller decides whether to fail closed.
   */
  verifyAuditEdgesForRun(runId: string): AuditEdgeDrift {
    const expected: AuditEdge[] = [];
    // frame -> owns_effect
    const effects = this.db.getDB().prepare(
      'SELECT id, owner_frame_id, created_event_id FROM run_effects WHERE run_id = ?',
    ).all(runId) as Array<{ id: string; owner_frame_id: string; created_event_id: string | null }>;
    for (const e of effects) {
      expected.push({
        id: 'expected', runId, fromKind: 'frame', fromId: e.owner_frame_id,
        relation: 'owns_effect', toKind: 'effect', toId: e.id,
        sourceEventId: e.created_event_id, createdAt: '',
      });
    }
    // frame -> has_repair
    const repairs = this.db.getDB().prepare(
      'SELECT id, target_frame_id, created_event_id FROM repair_transactions WHERE run_id = ?',
    ).all(runId) as Array<{ id: string; target_frame_id: string; created_event_id: string | null }>;
    for (const r of repairs) {
      expected.push({
        id: 'expected', runId, fromKind: 'frame', fromId: r.target_frame_id,
        relation: 'has_repair', toKind: 'repair', toId: r.id,
        sourceEventId: r.created_event_id, createdAt: '',
      });
    }
    // effect -> has_receipt
    const receipts = this.db.getDB().prepare(`
      SELECT er.id, er.effect_id, er.event_id FROM effect_receipts er
      JOIN run_effects re ON re.id = er.effect_id
      WHERE re.run_id = ?
    `).all(runId) as Array<{ id: string; effect_id: string; event_id: string | null }>;
    for (const r of receipts) {
      expected.push({
        id: 'expected', runId, fromKind: 'effect', fromId: r.effect_id,
        relation: 'has_receipt', toKind: 'receipt', toId: r.id,
        sourceEventId: r.event_id, createdAt: '',
      });
    }
    // Compare against actual.
    const actualRows = this.db.getDB().prepare(
      'SELECT * FROM audit_edges WHERE run_id = ?',
    ).all(runId) as SqliteRow[];
    const actual = actualRows.map(r => this.rowToEdge(r));
    const missing = expected.filter(exp => !actual.some(a =>
      a.fromKind === exp.fromKind && a.fromId === exp.fromId
      && a.relation === exp.relation && a.toKind === exp.toKind
      && a.toId === exp.toId));
    // Extra edges: anything in `actual` that is not in `expected`.
    const extra = actual.filter(a => !expected.some(exp =>
      exp.fromKind === a.fromKind && exp.fromId === a.fromId
      && exp.relation === a.relation && exp.toKind === a.toKind
      && exp.toId === a.toId));
    return {
      missing,
      extra,
      reason: missing.length > 0 ? 'missing_edges' : (extra.length > 0 ? 'extra_edges' : 'ok'),
    };
  }

  rebuildAuditEdgesForRun(runId: string): { inserted: number } {
    // Drop and rebuild from authoritative state.
    this.db.getDB().prepare('DELETE FROM audit_edges WHERE run_id = ?').run(runId);
    let inserted = 0;
    const effects = this.db.getDB().prepare(
      'SELECT id, owner_frame_id, created_event_id FROM run_effects WHERE run_id = ?',
    ).all(runId) as Array<{ id: string; owner_frame_id: string; created_event_id: string | null }>;
    for (const e of effects) {
      this.appendEdge({
        runId, fromKind: 'frame', fromId: e.owner_frame_id,
        relation: 'owns_effect', toKind: 'effect', toId: e.id,
        sourceEventId: e.created_event_id,
      });
      inserted++;
    }
    const repairs = this.db.getDB().prepare(
      'SELECT id, target_frame_id, created_event_id FROM repair_transactions WHERE run_id = ?',
    ).all(runId) as Array<{ id: string; target_frame_id: string; created_event_id: string | null }>;
    for (const r of repairs) {
      this.appendEdge({
        runId, fromKind: 'frame', fromId: r.target_frame_id,
        relation: 'has_repair', toKind: 'repair', toId: r.id,
        sourceEventId: r.created_event_id,
      });
      inserted++;
    }
    const receipts = this.db.getDB().prepare(`
      SELECT er.id, er.effect_id, er.event_id FROM effect_receipts er
      JOIN run_effects re ON re.id = er.effect_id
      WHERE re.run_id = ?
    `).all(runId) as Array<{ id: string; effect_id: string; event_id: string | null }>;
    for (const r of receipts) {
      this.appendEdge({
        runId, fromKind: 'effect', fromId: r.effect_id,
        relation: 'has_receipt', toKind: 'receipt', toId: r.id,
        sourceEventId: r.event_id,
      });
      inserted++;
    }
    return { inserted };
  }

  /* ============================================================
   * Audit envelope v2 append (with hash chain integrity)
   * ============================================================ */

  /**
   * Append a v2 envelope audit event in the SAME SQLite transaction
   * as the supplied body. The body receives the freshly-computed
   * event_id so it can reference the audit row.
   */
  transactionalAppend<T>(args: {
    meta: StateTransitionEventMeta;
    body: (eventId: string) => T;
  }): T {
    if (!args.meta.runId) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'transactionalAppend requires runId');
    }
    return this.db.getDB().transaction(() => {
      // Find last event hash for this run.
      const prevRow = this.db.getDB().prepare(
        'SELECT event_hash, hash_envelope_version FROM run_events WHERE run_id = ? ORDER BY sequence DESC LIMIT 1',
      ).get(args.meta.runId) as { event_hash: string; hash_envelope_version: string | null } | undefined;
      const previousHash = prevRow?.event_hash ?? GENESIS_HASH;
      const sequence = (this.db.getDB().prepare(
        'SELECT MAX(sequence) as s FROM run_events WHERE run_id = ?',
      ).get(args.meta.runId) as { s: number | null }).s ?? 0;
      const id = `evt_${Date.now()}_${sequence + 1}_${crypto.randomBytes(4).toString('hex')}`;
      // Generate createdAt ONCE and use it both for the envelope
      // hash and for the SQL row, so the verifier's recomputed
      // hash matches the producer's.
      const createdAt = new Date().toISOString();
      const composed = composeV2Envelope({
        id, runId: args.meta.runId, workspaceId: args.meta.workspaceId,
        sequence: sequence + 1, eventType: args.meta.eventType,
        eventPayload: args.meta.eventPayload,
        policyVersionHash: args.meta.policyVersionHash ?? this.getPolicyVersionHash(),
        redactionRuleVersion: args.meta.redactionRuleVersion ?? this.getRedactionRuleVersion(),
        previousHash, createdAt,
      });
      this.db.getDB().prepare(`
        INSERT INTO run_events (id, run_id, workspace_id, sequence, event_type,
          event_payload_json, payload_hash, previous_hash, event_hash,
          hash_envelope_version, policy_version_hash, redaction_rule_version,
          frame_id, effect_id, repair_transaction_id, caused_by_event_id,
          idempotency_key_hash, external_receipt_hash,
          target_subtree_revision, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, args.meta.runId, args.meta.workspaceId,
        sequence + 1, args.meta.eventType,
        composed.eventPayloadJson, composed.payloadHash,
        previousHash, composed.eventHash,
        composed.envelopeVersion,
        args.meta.policyVersionHash ?? this.getPolicyVersionHash(),
        args.meta.redactionRuleVersion ?? this.getRedactionRuleVersion(),
        args.meta.frameId ?? null,
        args.meta.effectId ?? null,
        args.meta.repairTransactionId ?? null,
        args.meta.causedByEventId ?? null,
        args.meta.idempotencyKeyHash ?? null,
        args.meta.externalReceiptHash ?? null,
        args.meta.targetSubtreeRevision ?? null,
        createdAt,
      );
      const out = args.body(id);
      // After body, write terminal_event_id on the parent frame/effect
      // if this event represents a terminal transition. We do not
      // know that generically, so we leave it to the caller.
      return out;
    })();
  }

  /**
   * Verify the canonical envelope chain for a run. New events
   * use v2 (plan 02 §3.3); legacy events retain their v1 hash
   * and are verified exactly as they were written.
   */
  verifyAuditChain(runId: string): {
    ok: boolean;
    envelopeVersions: Record<string, number>;
    brokenAt?: { sequence: number; eventId: string; reason: string };
  } {
    // Sequence numbers are only unique within a run. Verification
    // therefore walks this run's chain and its v2 envelope, rather
    // than treating another ordinary run with the same sequence
    // numbers as evidence of tampering. Moving a v2 event into a
    // different run changes its signed run_id and fails its envelope;
    // moving one out leaves a sequence/previous-hash discontinuity.
    const rows = this.db.getDB().prepare(
      'SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence ASC',
    ).all(runId) as SqliteRow[];
    if (rows.length === 0) {
      return {
        ok: false, envelopeVersions: {},
        brokenAt: { sequence: 0, eventId: '',
          reason: `no events found for run ${runId}` },
      };
    }
    let prevHash = GENESIS_HASH;
    const versionCounts: Record<string, number> = {};
    for (const r of rows) {
      // Each event must still belong to the queried run.
      if ((r['run_id'] as string) !== runId) {
        return {
          ok: false, envelopeVersions: versionCounts,
          brokenAt: { sequence: r['sequence'] as number, eventId: r['id'] as string,
            reason: 'event run_id does not match the queried run (cross-run spoofing)' },
        };
      }
      const version = (r['hash_envelope_version'] as string) ?? HASH_ENVELOPE_VERSION_V1;
      versionCounts[version] = (versionCounts[version] ?? 0) + 1;
      if ((r['previous_hash'] as string) !== prevHash) {
        return {
          ok: false, envelopeVersions: versionCounts,
          brokenAt: { sequence: r['sequence'] as number, eventId: r['id'] as string,
            reason: 'previous_hash mismatch' },
        };
      }
      if (version === HASH_ENVELOPE_VERSION_V2) {
        let canonicalPayload: string;
        try {
          canonicalPayload = canonicalJSON(JSON.parse(r['event_payload_json'] as string));
        } catch {
          return {
            ok: false, envelopeVersions: versionCounts,
            brokenAt: { sequence: r['sequence'] as number, eventId: r['id'] as string,
              reason: 'v2 event_payload_json is invalid JSON' },
          };
        }
        if (canonicalPayload !== r['event_payload_json']) {
          return {
            ok: false, envelopeVersions: versionCounts,
            brokenAt: { sequence: r['sequence'] as number, eventId: r['id'] as string,
              reason: 'v2 event_payload_json is not canonical' },
          };
        }
        const expectedPayloadHash = payloadHash(JSON.parse(canonicalPayload));
        if (expectedPayloadHash !== r['payload_hash']) {
          return {
            ok: false, envelopeVersions: versionCounts,
            brokenAt: { sequence: r['sequence'] as number, eventId: r['id'] as string,
              reason: 'v2 payload_hash mismatch' },
          };
        }
        const recomputed = envelopeV2Hash({
          id: r['id'] as string,
          runId: r['run_id'] as string,
          workspaceId: (r['workspace_id'] as string | null) ?? null,
          sequence: r['sequence'] as number,
          eventType: r['event_type'] as string,
          eventPayloadJson: (r['event_payload_json'] as string | null) ?? '{}',
          payloadHash: (r['payload_hash'] as string | null) ?? null,
          policyVersionHash: (r['policy_version_hash'] as string | null) ?? null,
          redactionRuleVersion: (r['redaction_rule_version'] as string | null) ?? null,
          createdAt: r['created_at'] as string,
          previousHash: prevHash,
        });
        if (recomputed !== (r['event_hash'] as string)) {
          return {
            ok: false, envelopeVersions: versionCounts,
            brokenAt: { sequence: r['sequence'] as number, eventId: r['id'] as string,
              reason: 'v2 envelope hash mismatch (envelope field tamper or payload tamper)' },
          };
        }
      } else if (version === HASH_ENVELOPE_VERSION_V1) {
        const recomputed = envelopeV1Hash(
          r['event_payload_json'] as string,
          prevHash,
        );
        if (recomputed !== (r['event_hash'] as string)) {
          return {
            ok: false, envelopeVersions: versionCounts,
            brokenAt: { sequence: r['sequence'] as number, eventId: r['id'] as string,
              reason: 'v1 envelope hash mismatch' },
          };
        }
      } else {
        return {
          ok: false, envelopeVersions: versionCounts,
          brokenAt: { sequence: r['sequence'] as number, eventId: r['id'] as string,
            reason: `unknown hash_envelope_version: ${version}` },
        };
      }
      prevHash = r['event_hash'] as string;
    }
    return { ok: true, envelopeVersions: versionCounts };
  }

  /** Helper for tests / Milestone 1 callers: force a v1 (legacy) event. */
  appendLegacyV1Event(args: {
    runId: string;
    workspaceId: string | null;
    eventType: string;
    eventPayload: Record<string, unknown>;
    policyVersionHash?: string | null;
    redactionRuleVersion?: string | null;
  }): { id: string } {
    return this.db.getDB().transaction(() => {
      const prevRow = this.db.getDB().prepare(
        'SELECT event_hash FROM run_events WHERE run_id = ? ORDER BY sequence DESC LIMIT 1',
      ).get(args.runId) as { event_hash: string } | undefined;
      const previousHash = prevRow?.event_hash ?? GENESIS_HASH;
      const sequence = (this.db.getDB().prepare(
        'SELECT MAX(sequence) as s FROM run_events WHERE run_id = ?',
      ).get(args.runId) as { s: number | null }).s ?? 0;
      const id = `evt_${Date.now()}_${sequence + 1}_${crypto.randomBytes(4).toString('hex')}`;
      const payloadJson = canonicalJSON(args.eventPayload);
      const ph = crypto.createHash('sha256').update(payloadJson).digest('hex');
      const eh = envelopeV1Hash(payloadJson, previousHash);
      this.db.getDB().prepare(`
        INSERT INTO run_events (id, run_id, workspace_id, sequence, event_type,
          event_payload_json, payload_hash, previous_hash, event_hash,
          hash_envelope_version, policy_version_hash, redaction_rule_version,
          created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, args.runId, args.workspaceId,
        sequence + 1, args.eventType,
        payloadJson, ph, previousHash, eh,
        HASH_ENVELOPE_VERSION_V1,
        args.policyVersionHash ?? null,
        args.redactionRuleVersion ?? null,
        new Date().toISOString(),
      );
      return { id };
    })();
  }

  /* ============================================================
   * Row → domain mappers
   * ============================================================ */

  private rowToFrame(row: SqliteRow): RunFrame {
    return {
      id: row['id'] as string,
      runId: row['run_id'] as string,
      parentFrameId: (row['parent_frame_id'] as string | null) ?? null,
      runStepId: (row['run_step_id'] as string | null) ?? null,
      frameKind: row['frame_kind'] as RunFrame['frameKind'],
      status: row['status'] as FrameStatus,
      path: JSON.parse((row['path_json'] as string) || '[]'),
      nodeRevision: row['node_revision'] as number,
      subtreeRevision: row['subtree_revision'] as number,
      inputHash: (row['input_hash'] as string | null) ?? null,
      outputHash: (row['output_hash'] as string | null) ?? null,
      createdEventId: (row['created_event_id'] as string | null) ?? null,
      terminalEventId: (row['terminal_event_id'] as string | null) ?? null,
      createdAt: row['created_at'] as string,
      updatedAt: row['updated_at'] as string,
    };
  }

  private rowToEffect(row: SqliteRow): RunEffect {
    return {
      id: row['id'] as string,
      runId: row['run_id'] as string,
      ownerFrameId: row['owner_frame_id'] as string,
      effectType: row['effect_type'] as string,
      adapterKind: row['adapter_kind'] as string,
      payloadFingerprint: row['payload_fingerprint'] as string,
      // Series 1B M1 round 5: separated from the redactor's
      // egress hash; set when the protocol seals the capsule.
      capsuleFingerprint: (row['capsule_fingerprint'] as string | null) ?? null,
      // Round 6: snapshot of approval binding fields captured
      // at prepare-time.
      policyVersionHash: (row['policy_version_hash'] as string | null) ?? null,
      scopeHash: (row['scope_hash'] as string | null) ?? null,
      redactionRuleVersion: (row['redaction_rule_version'] as string | null) ?? null,
      callbackCapsuleRef: (row['callback_capsule_ref'] as string | null) ?? null,
      callbackCapsuleHash: (row['callback_capsule_hash'] as string | null) ?? null,
      callbackCapsuleFormatVersion: (row['callback_capsule_format_version'] as string | null) ?? null,
      idempotencyKeyRef: (row['idempotency_key_ref'] as string | null) ?? null,
      idempotencyKeyHash: (row['idempotency_key_hash'] as string | null) ?? null,
      state: row['state'] as EffectState,
      allowedRepairActions: JSON.parse((row['allowed_repair_actions_json'] as string) || '[]'),
      dependencyEffectIds: JSON.parse((row['dependency_effect_ids_json'] as string) || '[]'),
      effectRevision: row['effect_revision'] as number,
      routeDecisionId: (row['route_decision_id'] as string | null) ?? null,
      policyEvaluationId: (row['policy_evaluation_id'] as string | null) ?? null,
      currentApprovalId: (row['current_approval_id'] as string | null) ?? null,
      egressRecordId: (row['egress_record_id'] as string | null) ?? null,
      ingressFindingId: (row['ingress_finding_id'] as string | null) ?? null,
      externalRequestId: (row['external_request_id'] as string | null) ?? null,
      authoritativeReceiptId: (row['authoritative_receipt_id'] as string | null) ?? null,
      externalReceiptHash: (row['external_receipt_hash'] as string | null) ?? null,
      createdEventId: (row['created_event_id'] as string | null) ?? null,
      terminalEventId: (row['terminal_event_id'] as string | null) ?? null,
      createdAt: row['created_at'] as string,
      updatedAt: row['updated_at'] as string,
    };
  }

  private rowToReceipt(row: SqliteRow): EffectReceipt {
    return {
      id: row['id'] as string,
      effectId: row['effect_id'] as string,
      attemptNo: row['attempt_no'] as number,
      requestId: (row['request_id'] as string | null) ?? null,
      requestHash: (row['request_hash'] as string | null) ?? null,
      responseHash: (row['response_hash'] as string | null) ?? null,
      resultCapsuleRef: (row['result_capsule_ref'] as string | null) ?? null,
      resultCapsuleHash: (row['result_capsule_hash'] as string | null) ?? null,
      resultCapsuleFormatVersion: (row['result_capsule_format_version'] as string | null) ?? null,
      providerStatus: (row['provider_status'] as string | null) ?? null,
      applicationStatus: row['application_status'] as EffectReceipt['applicationStatus'],
      receiptHash: row['receipt_hash'] as string,
      receivedAt: row['received_at'] as string,
      eventId: (row['event_id'] as string | null) ?? null,
    };
  }

  private rowToRepair(row: SqliteRow): RepairTransaction {
    return {
      id: row['id'] as string,
      runId: row['run_id'] as string,
      targetFrameId: row['target_frame_id'] as string,
      targetSubtreeRevision: row['target_subtree_revision'] as number,
      authorizedEffectRevisions: JSON.parse(
        (row['authorized_effect_revisions_json'] as string) || '{}',
      ),
      authorizedCrossFrameEffectIds: (JSON.parse(
        (row['verification_result_json'] as string) || '{}',
      ) as { authorizedCrossFrameEffectIds?: string[] }).authorizedCrossFrameEffectIds ?? [],
      proposedPlan: JSON.parse((row['proposed_plan_json'] as string) || '[]'),
      verificationResult: JSON.parse(
        (row['verification_result_json'] as string) || '{}',
      ),
      status: row['status'] as RepairStatus,
      rejectionReason: (row['rejection_reason'] as string | null) ?? null,
      createdEventId: (row['created_event_id'] as string | null) ?? null,
      terminalEventId: (row['terminal_event_id'] as string | null) ?? null,
      createdAt: row['created_at'] as string,
      updatedAt: row['updated_at'] as string,
    };
  }

  private rowToLease(row: SqliteRow): RecoveryLease {
    return {
      runId: row['run_id'] as string,
      holderId: row['holder_id'] as string,
      leaseVersion: row['lease_version'] as number,
      acquiredAt: row['acquired_at'] as string,
      expiresAt: row['expires_at'] as string,
      renewedAt: row['renewed_at'] as string,
      releasedAt: (row['released_at'] as string | null) ?? null,
      lastEventId: (row['last_event_id'] as string | null) ?? null,
    };
  }

  private workspaceIdForRun(runId: string): string | null {
    const row = this.db.getDB().prepare(
      'SELECT workspace_id FROM agent_runs WHERE id = ?',
    ).get(runId) as { workspace_id: string } | undefined;
    if (!row) {
      throw new OgraError(OgraErrorCode.RUN_NOT_FOUND, `run ${runId} not found`);
    }
    return row.workspace_id;
  }

  private rowToEdge(row: SqliteRow): AuditEdge {
    return {
      id: row['id'] as string,
      runId: row['run_id'] as string,
      fromKind: row['from_kind'] as AuditEdgeFromKind,
      fromId: row['from_id'] as string,
      relation: row['relation'] as string,
      toKind: row['to_kind'] as AuditEdgeToKind,
      toId: row['to_id'] as string,
      sourceEventId: (row['source_event_id'] as string | null) ?? null,
      createdAt: row['created_at'] as string,
    };
  }
}

/** Re-export hash helpers so consumers don't need a second import. */
export {
  envelopeV1Hash,
  envelopeV2Hash,
  GENESIS_HASH,
  HASH_ENVELOPE_VERSION_V1,
  HASH_ENVELOPE_VERSION_V2,
  payloadHash,
};
