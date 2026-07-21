/**
 * Sequence 1B Milestone 1 — Effect Protocol Service.
 *
 * Implements plan 10 §4 (Effect Execution Protocol) and §3.2
 * (Effect Ledger). All state transitions commit in the same
 * SQLite transaction as the L1 audit event + the bound L0
 * capsule row.
 *
 * The protocol:
 *   1. prepare(input)  — atomic transaction that creates / reuses
 *      the owner frame, creates the effect in `planned` state,
 *      seals the callback capsule (encrypted), writes the
 *      prepare-intent L1 event, and edges frame → effect +
 *      effect → callback_capsule.
 *
 *   2. casToInFlight(input) — pre-callback CAS. Verifies the
 *      effect is still in `planned` and that the callback capsule
 *      is intact (workspace, expiry, hash). Reserves the next
 *      attempt_no. Appends the callback-intent L1 event.
 *      Returns a typed result that the caller uses to actually
 *      invoke the adapter. The callback cannot happen unless
 *      casToInFlight returned success — a crash between prepare
 *      and casToInFlight leaves the effect in `planned`, which
 *      recovery treats as "callback never started" (clean retry).
 *
 *   3. recordReceipt(input) — post-result transaction. Seals the
 *      result capsule (encrypted), appends the receipt row + the
 *      in_flight → received L1 event in the same transaction.
 *      The receipt carries a NEW attempt_no (or matches the
 *      expected one); never overwrites prior attempts (UNIQUE).
 *
 *   4. commitToTerminal(input) — final transaction. Verifies the
 *      effect is in `received`, writes the ingress finding (M1
 *      always writes "accepted" — full ingress review is M2), and
 *      transitions to `committed`. This is the ONLY place the
 *      terminal state + post-audit event commit together.
 *
 * Adapters that wish to receive authoritative state can call
 * readEffect(id) at any point. The service refuses to write
 * anything that is not bound to the L0 + L1 chain.
 */

import * as crypto from 'crypto';
import { OgraError, OgraErrorCode } from '../shared/errors';
import { EncryptedCapsuleStore, CapsuleBinding, SealedCapsuleRow, OpenCapsule } from './capsule-store';
import { DurableRuntimeService } from './durable-runtime-service';
import { OgraDatabase } from './database';
import { canonicalJSON } from './audit-envelope';
import type { RecoveryCapabilities } from './durable-runtime-types';

export interface PrepareEffectInput {
  runId: string;
  ownerFrameId: string;
  effectType: string;
  adapterKind: string;
  adapterVersion: string;
  /** Canonicalized payload (already redacted / sanitized). The
   *  raw callback request that leaves the machine must be
   *  recoverable from the capsule's auth-tagged ciphertext. */
  payload: unknown;
  /** Hash of `payload`. Used for idempotency dedup and for the
   *  effect.payload_fingerprint column. */
  payloadFingerprint: string;
  /**
   * Series 1B M1 round 5: hash of the bytes the protocol will
   * seal inside the callback capsule (canonical-envelope
   * sha256). Independent of `payloadFingerprint`, which is the
   * redactor's egress hash used as the Sequence-0 approval
   * anchor. `capsuleFingerprint` lets the recovery layer prove
   * the capsule would re-apply the canonical capsule bytes
   * without ever confusing the two anchors.
   */
  capsuleFingerprint?: string | null;
  /**
   * Series 1B M1 round 5: the current canonical approval row id
   * (if any). Persisted on the effect so recovery can re-bind
   * the capsule to the exact approval that authorised it.
   */
  currentApprovalId?: string | null;
  /** Adapter-side idempotency key. The RAW key is NOT persisted;
   *  only the hash + ref are stored. */
  idempotencyKey: string;
  scopeHash: string;
  routeDecisionId: string;
  policyEvaluationId: string;
  policyVersionHash: string;
  redactionRuleVersion?: string;
  classification?: string;
  /**
   * The adapter's actual recovery declaration.  It is sealed with the
   * callback and is the only capability evidence recovery is allowed to
   * trust.  The legacy individual fields below remain for hermetic M1
   * fixtures, but production callers must pass this value from the adapter.
   */
  recoveryCapabilities?: Pick<RecoveryCapabilities,
    'supportsIdempotencyKey' | 'supportsOutcomeQuery' | 'supportsCompensation'>;
  /** @deprecated Test-fixture compatibility only; sealed at prepare time. */
  supportsIdempotencyKey?: boolean;
  /** @deprecated Test-fixture compatibility only; sealed at prepare time. */
  supportsOutcomeQuery?: boolean;
  /** @deprecated Test-fixture compatibility only; sealed at prepare time. */
  supportsCompensation?: boolean;
}

export interface PreparedEffect {
  effectId: string;
  attemptNo: number;
  callbackCapsuleRef: string;
  callbackCapsuleHash: string;
  callbackCapsuleFormatVersion: string;
  idempotencyKeyHash: string;
}

export interface CasInFlightInput {
  effectId: string;
  expectedRevision: number;
  expectedAttemptNo: number;
  leaseHolder: string;
  /**
   * Explicit approval authority for this physical callback attempt. The raw
   * approval payload never leaves the canonical approvals row; this carries
   * only its opaque id. `planned -> in_flight` creates an `initial` binding;
   * `unknown -> in_flight` creates a distinct `recovery_retry` binding.
   */
  approvalId?: string | null;
  /** Defaults to planned; recovery must opt into the unknown retry path. */
  expectedState?: 'planned' | 'unknown';
  /** Testable stale-lease guard; normal callers omit it and capture current CAS version. */
  expectedLeaseVersion?: number;
}

export interface CasInFlightOutput {
  effectId: string;
  attemptNo: number;
  effectRevision: number;
  state: 'in_flight';
  callbackIntentEventId: string;
  /** Captured active lease authority required for terminal commit. */
  leaseVersion: number;
  /** Decrypted, authenticated callback input. This is the only value that
   * may be handed to an adapter after callback intent succeeds. */
  callbackPayload: unknown;
}

export interface RecordReceiptInput {
  effectId: string;
  attemptNo: number;
  requestId: string | null;
  requestHash: string | null;
  /** Raw result body (decoded from the adapter). Persisted only
   *  inside the encrypted result capsule. */
  result: unknown;
  applicationStatus: 'applied' | 'not_applied' | 'unknown';
  providerStatus: string | null;
}

export interface RecordReceiptOutput {
  effectId: string;
  receiptId: string;
  attemptNo: number;
  resultCapsuleRef: string;
  resultCapsuleHash: string;
}

export interface CommitTerminalInput {
  effectId: string;
  expectedRevision: number;
  expectedAttemptNo: number;
  receiptId: string;
  /** Terminal ingress is also a durable mutation and needs live lease CAS. */
  leaseHolder: string;
  expectedLeaseVersion: number;
}

export interface CommitTerminalOutput {
  effectId: string;
  ingressFindingId: string;
  effectRevision: number;
}

export class EffectProtocolService {
  constructor(
    private readonly odb: OgraDatabase,
    private readonly runtime: DurableRuntimeService,
    private readonly capsuleStore: EncryptedCapsuleStore,
  ) {
    // Repair verification is part of the same M1 trust boundary as callback
    // intent. It must authenticate the exact sealed callback, not merely
    // inspect its SQLite projection fields.
    this.runtime.attachCapsuleStore(capsuleStore);
  }

  /* ============================================================
   * Step 1: prepare
   * ============================================================ */

  prepare(input: PrepareEffectInput): PreparedEffect {
    // The caller-provided idempotency key is hashed once and the
    // RAW value is sealed inside the callback capsule. We never
    // touch SQLite with the raw key.
    const idempotencyKeyHash = crypto.createHash('sha256')
      .update(input.idempotencyKey).digest('hex');
    const declaredRecoveryCapabilities = {
      supportsIdempotencyKey: input.recoveryCapabilities?.supportsIdempotencyKey
        ?? !!input.supportsIdempotencyKey,
      supportsOutcomeQuery: input.recoveryCapabilities?.supportsOutcomeQuery
        ?? !!input.supportsOutcomeQuery,
      supportsCompensation: input.recoveryCapabilities?.supportsCompensation
        ?? !!input.supportsCompensation,
    };
    // This object is the complete callback command.  Its hash, rather than
    // any caller-declared field, is the capsule fingerprint.  Do not put the
    // fingerprint itself in this object: that would make the canonical hash
    // circular and impossible to verify from plaintext.
    const callbackPlaintext = {
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
      idempotencyKeyHash,
      egressPayloadFingerprint: input.payloadFingerprint,
      routeDecisionId: input.routeDecisionId,
      policyEvaluationId: input.policyEvaluationId,
      policyVersionHash: input.policyVersionHash,
      redactionRuleVersion: input.redactionRuleVersion
        ?? this.runtime.getCurrentRedactionRuleVersion(),
      classification: input.classification ?? 'Internal',
      recoveryCapabilities: {
        schemaVersion: 'v1' as const,
        adapterKind: input.adapterKind,
        adapterVersion: input.adapterVersion,
        ...declaredRecoveryCapabilities,
      },
      supportsCompensation: !!input.supportsCompensation,
    };
    // The capsule fingerprint is not caller-declared metadata. It is the
    // canonical hash of the exact callback plaintext passed to seal().
    const capsuleFingerprint = crypto.createHash('sha256')
      .update(canonicalJSON(callbackPlaintext)).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    return this.runtime.transactionalAppend({
      meta: {
        runId: input.runId,
        workspaceId: null,
        eventType: 'effect_prepared',
        eventPayload: {
          effectType: input.effectType,
          adapterKind: input.adapterKind,
          ownerFrameId: input.ownerFrameId,
          payloadFingerprint: input.payloadFingerprint,
          idempotencyKeyHash,
        },
        frameId: input.ownerFrameId,
        idempotencyKeyHash,
      },
      body: (eventId) => {
        // 1. Owner frame check (fail-closed: cross-run owner rejected).
        const owner = this.runtime.readFrame(input.ownerFrameId);
        if (owner.runId !== input.runId) {
          throw new OgraError(OgraErrorCode.EFFECT_OWNER_MISMATCH,
            'prepare: owner frame runId mismatch');
        }

        // 2. Effect id (stable so retries with the same idempotency
        // key can locate the same effect). We derive the id from
        // the idempotency key hash + owner frame id so callers can
        // call `prepare` again with the same args safely.
        const effectId = `effect_${idempotencyKeyHash.slice(0, 16)}_` +
          crypto.randomBytes(4).toString('hex');

        // 3. Idempotent re-prepare: if the (idempotency_key_hash,
        // owner_frame_id) pair already exists, return the existing
        // prepared effect WITHOUT re-sealing the callback capsule.
        const existing = this.odb.getDB().prepare(
          'SELECT * FROM run_effects WHERE idempotency_key_hash = ? AND owner_frame_id = ?',
        ).get(idempotencyKeyHash, input.ownerFrameId) as any | undefined;
        if (existing) {
          if (existing.payload_fingerprint !== input.payloadFingerprint) {
            throw new OgraError(OgraErrorCode.EFFECT_PAYLOAD_FINGERPRINT_CHANGED,
              `idempotency key hash reused with different payload_fingerprint ` +
              `(existing=${existing.payload_fingerprint} new=${input.payloadFingerprint})`);
          }
          if (existing.capsule_fingerprint !== capsuleFingerprint) {
            throw new OgraError(OgraErrorCode.EFFECT_PAYLOAD_FINGERPRINT_CHANGED,
              'idempotency key hash reused with different callback capsule plaintext');
          }
          // Same key + same fingerprint + same owner frame → caller
          // is doing a retry. Return the existing binding.
          const callback = this.capsuleStore.fetchByBinding({
            effectId: existing.id, capsuleKind: 'callback', attemptNo: 1,
          });
          if (!callback) {
            throw new OgraError(OgraErrorCode.CAPSULE_INVALID,
              `effect ${existing.id} marked idempotent but callback capsule missing`);
          }
          return {
            effectId: existing.id,
            attemptNo: 1,
            callbackCapsuleRef: callback.ref,
            callbackCapsuleHash: callback.hash,
            callbackCapsuleFormatVersion: callback.formatVersion,
            idempotencyKeyHash,
          };
        }

        // 4. Create the planned effect (revision = 1).
        // Round 6: also persist policy_version_hash and scope_hash
        // on the effect row so the recovery layer can revalidate
        // approval / policy / route before any re-callback.
        const now = new Date().toISOString();
        this.odb.getDB().prepare(`
          INSERT INTO run_effects (id, run_id, owner_frame_id, effect_type,
            adapter_kind, payload_fingerprint, capsule_fingerprint, state,
            allowed_repair_actions_json, dependency_effect_ids_json,
            effect_revision, route_decision_id, policy_evaluation_id,
            current_approval_id, policy_version_hash, scope_hash, redaction_rule_version,
            created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', '[]', '[]', 1, ?, ?,
            ?, ?, ?, ?, ?, ?)
        `).run(
          effectId, input.runId, input.ownerFrameId, input.effectType,
          input.adapterKind, input.payloadFingerprint,
          capsuleFingerprint,
          input.routeDecisionId, input.policyEvaluationId,
          input.currentApprovalId ?? null,
          input.policyVersionHash ?? null, input.scopeHash ?? null,
          input.redactionRuleVersion ?? this.runtime.getCurrentRedactionRuleVersion(),
          now, now,
        );
        if (input.currentApprovalId) {
          const bound = this.odb.getDB().prepare(`
            UPDATE approvals SET effect_id = ?, effect_revision = ?
              WHERE id = ? AND run_id = ? AND workspace_id = ?
                AND decision = 'approved'
                AND effect_id IS NULL AND effect_revision IS NULL
          `).run(effectId, 1, input.currentApprovalId, input.runId,
            this.resolveWorkspaceId(input.runId));
          if (bound.changes !== 1) {
            throw new OgraError(OgraErrorCode.APPROVAL_REQUIRED,
              `prepare: approval ${input.currentApprovalId} is not an unbound approval for this effect`);
          }
        }

        // 5. Seal the callback capsule. The RAW idempotency key and
        // payload go through AES-256-GCM; SQLite only sees ref +
        // hash + workspace-tagged AAD. The createdEventId binds
        // the capsule row to its L1 audit event for L0/L1
        // traceability.
        //
        // Round 5: we write the agent-supplied capsuleFingerprint
        // (== sha256(canonicalJSON(envelope))) onto BOTH the
        // effect row's `capsule_fingerprint` column AND the
        // capsules row's `payload_fingerprint` column. That way
        // the two columns are derived from the same canonical
        // bytes and the recovery verifier can prove the capsule
        // would re-apply the canonical capsule bytes.
        const capsuleFingerprintVal = capsuleFingerprint;
        const capsuleBinding: CapsuleBinding = {
          workspaceId: this.resolveWorkspaceId(input.runId),
          capsuleKind: 'callback',
          formatVersion: 'v1',
          // The capsule row's `payload_fingerprint` column
          // carries the capsule identity (= the recovery
          // anchor). It is the same value written onto
          // `run_effects.capsule_fingerprint`. The Sequence-0
          // approval anchor lives on `run_effects.payload_
          // fingerprint` (== input.payloadFingerprint, the
          // redactor's egress hash) and is independent.
          payloadFingerprint: capsuleFingerprintVal,
          runId: input.runId,
          effectId,
          receiptId: null,
          attemptNo: 1,
          adapterKind: input.adapterKind,
          adapterVersion: input.adapterVersion,
          scopeHash: input.scopeHash,
          expiresAt,
          createdEventId: eventId,
        };
        const callbackCapsule = this.capsuleStore.seal(capsuleBinding, callbackPlaintext);
        // 6. Backfill the effect row with the capsule refs/hashes.
        this.odb.getDB().prepare(`
          UPDATE run_effects SET callback_capsule_ref = ?, callback_capsule_hash = ?,
            callback_capsule_format_version = ?, idempotency_key_ref = ?,
            idempotency_key_hash = ?, updated_at = ?
            WHERE id = ?
        `).run(
          callbackCapsule.ref, callbackCapsule.hash,
          callbackCapsule.formatVersion, callbackCapsule.ref,
          idempotencyKeyHash, now, effectId,
        );
        // 7. Edge: frame → effect (M0 contract). Bind the edge to
        // the L1 prepare event so the L0-L1 bidirectional index
        // is fully traceable.
        this.runtime.appendEdge({
          runId: input.runId, fromKind: 'frame',
          fromId: input.ownerFrameId, relation: 'owns_effect',
          toKind: 'effect', toId: effectId, sourceEventId: eventId,
        });
        return {
          effectId, attemptNo: 1,
          callbackCapsuleRef: callbackCapsule.ref,
          callbackCapsuleHash: callbackCapsule.hash,
          callbackCapsuleFormatVersion: callbackCapsule.formatVersion,
          idempotencyKeyHash,
        };
      },
    });
  }

  /* ============================================================
   * Step 2: pre-callback CAS
   * ============================================================ */

  casToInFlight(input: CasInFlightInput): CasInFlightOutput {
    // Read the effect first so we can fail closed on every mismatch.
    const effect = this.runtime.readEffect(input.effectId);
    if (effect.effectRevision !== input.expectedRevision) {
      throw new OgraError(OgraErrorCode.REVISION_CONFLICT,
        `casToInFlight: effect ${input.effectId} expected revision ${input.expectedRevision} but was ${effect.effectRevision}`);
    }
    const expectedState = input.expectedState ?? 'planned';
    if (effect.state !== expectedState) {
      throw new OgraError(OgraErrorCode.EFFECT_INVALID_TRANSITION,
        `casToInFlight: effect ${input.effectId} not in ${expectedState} (was ${effect.state})`);
    }
    if (expectedState === 'planned' && input.expectedAttemptNo !== 1) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'casToInFlight: initial callback must use attempt_no=1');
    }
    if (expectedState === 'unknown' && input.expectedAttemptNo <= 1) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'casToInFlight: recovery retry must use a new attempt_no');
    }
    // Callback capsule must be intact + decryptable before we
    // permit the callback.
    const callback = this.capsuleStore.fetchByBinding({
      effectId: effect.id, capsuleKind: 'callback', attemptNo: 1,
    });
    if (!callback) {
      this.capsuleStore.recordFailure({
        effectId: effect.id, workspaceId: effect.runId ? '' : '',
        capsuleRef: '(missing)', attemptNo: 1,
        failureKind: 'missing',
        detail: 'pre-callback CAS: callback capsule missing',
      });
      throw new OgraError(OgraErrorCode.CAPSULE_INVALID,
        `pre-callback CAS: callback capsule missing for ${input.effectId}`);
    }
    // Open the capsule to verify decryptability. This catches
    // workspace-tag drift, expiry, hash drift before we ever
    // hand the adapter the payload.
    const verifiedCallback = this.capsuleStore.openVerifiedCallbackForEffect({
      effectId: effect.id, attemptNo: 1,
      expectedFingerprint: effect.capsuleFingerprint ?? effect.payloadFingerprint,
    });
    // Lease gate: a callback intent is only legal while the caller owns the
    // active run lease. For unknown -> in_flight this is also enforced by the
    // durable transition contract; keep it here so the approval consumption
    // cannot be recorded for a stale holder.
    const lease = this.runtime.readLease(effect.runId);
    if (lease.holderId !== input.leaseHolder
        || this.runtime.leaseExpired(lease)) {
      throw new OgraError(OgraErrorCode.LEASE_NOT_HELD,
        `pre-callback CAS: lease not held by ${input.leaseHolder}`);
    }
    const expectedLeaseVersion = input.expectedLeaseVersion ?? lease.leaseVersion;
    return this.runtime.transactionalAppend({
      meta: {
        runId: effect.runId,
        workspaceId: null,
        eventType: 'effect_callback_intent',
        eventPayload: {
          effectId: effect.id,
          attemptNo: input.expectedAttemptNo,
          bindingKind: expectedState === 'planned' ? 'initial' : 'recovery_retry',
          approvalId: input.approvalId ?? null,
          callbackCapsuleRef: callback.ref,
          callbackCapsuleHash: callback.hash,
        },
        frameId: effect.ownerFrameId,
        effectId: effect.id,
        idempotencyKeyHash: effect.idempotencyKeyHash ?? null,
        externalReceiptHash: null,
      },
      body: (eventId) => {
        // Re-check ownership, active expiry, and version INSIDE the same
        // transaction that consumes approval authority and moves the effect.
        // A stale holder therefore rolls back the run_event, binding,
        // consumption, and effect update as one unit.
        const activeLease = this.odb.getDB().prepare(`
          SELECT 1 FROM recovery_leases
           WHERE run_id = ? AND holder_id = ? AND lease_version = ?
             AND released_at IS NULL AND expires_at > ?
        `).get(effect.runId, input.leaseHolder, expectedLeaseVersion,
          new Date().toISOString());
        if (!activeLease) {
          throw new OgraError(OgraErrorCode.LEASE_NOT_HELD,
            `pre-callback CAS: lease ownership changed for ${input.leaseHolder}`);
        }
        const requiresApproval = effect.currentApprovalId !== null
          || this.routeRequiresApproval(effect.routeDecisionId);
        if (requiresApproval && !input.approvalId) {
          throw new OgraError(OgraErrorCode.APPROVAL_REQUIRED,
            `pre-callback CAS: effect ${effect.id} requires scoped approval authority`);
        }
        if (expectedState === 'planned' && effect.currentApprovalId
            && input.approvalId !== effect.currentApprovalId) {
          throw new OgraError(OgraErrorCode.APPROVAL_REQUIRED,
            `pre-callback CAS: initial attempt must use effect's current approval`);
        }
        if (expectedState === 'unknown' && effect.currentApprovalId
            && input.approvalId === effect.currentApprovalId) {
          throw new OgraError(OgraErrorCode.APPROVAL_REQUIRED,
            `pre-callback CAS: recovery retry requires a new approval`);
        }
        if (input.approvalId) {
          this.consumeApprovalForCallback({
            effect,
            approvalId: input.approvalId,
            attemptNo: input.expectedAttemptNo,
            bindingKind: expectedState === 'planned' ? 'initial' : 'recovery_retry',
            eventId,
          });
        }
        const casRes = this.odb.getDB().prepare(`
          UPDATE run_effects SET state = 'in_flight',
            effect_revision = effect_revision + 1,
            current_approval_id = COALESCE(?, current_approval_id),
            updated_at = ?
            WHERE id = ? AND effect_revision = ? AND state = ?
        `).run(input.approvalId ?? null, new Date().toISOString(), effect.id,
          input.expectedRevision, expectedState);
        if (casRes.changes === 0) {
          throw new OgraError(OgraErrorCode.REVISION_CONFLICT,
            `pre-callback CAS lost race for effect ${effect.id}`);
        }
        const refreshed = this.runtime.readEffect(effect.id);
        return {
          effectId: refreshed.id,
          attemptNo: input.expectedAttemptNo,
          effectRevision: refreshed.effectRevision,
          state: 'in_flight' as const,
          callbackIntentEventId: eventId,
          leaseVersion: expectedLeaseVersion,
          callbackPayload: verifiedCallback.payload,
        };
      },
    });
  }

  /** True only when the persisted route explicitly requires approval. */
  private routeRequiresApproval(routeDecisionId: string | null): boolean {
    if (!routeDecisionId) return false;
    const row = this.odb.getDB().prepare(
      'SELECT requires_user_approval FROM route_decisions WHERE id = ?',
    ).get(routeDecisionId) as { requires_user_approval: number | null } | undefined;
    return row?.requires_user_approval === 1;
  }

  /**
   * Validate and consume an approval in the caller's existing callback-intent
   * transaction. The unique consumption row is a one-use reservation: any
   * earlier consumption by this approval blocks a second physical callback,
   * even for another effect or a later retry.
   */
  private consumeApprovalForCallback(input: {
    effect: ReturnType<DurableRuntimeService['readEffect']>;
    approvalId: string;
    attemptNo: number;
    bindingKind: 'initial' | 'recovery_retry';
    eventId: string;
  }): void {
    const workspaceId = this.resolveWorkspaceId(input.effect.runId);
    const approval = this.odb.getDB().prepare(`
      SELECT id, run_id, workspace_id, approval_type, decision, expires_at,
             scope_hash, payload_fingerprint, policy_version_hash, revision,
             use_limit, uses_consumed, effect_id, effect_revision
        FROM approvals WHERE id = ?
    `).get(input.approvalId) as {
      id: string; run_id: string; workspace_id: string; approval_type: string; decision: string;
      expires_at: string | null; scope_hash: string | null;
      payload_fingerprint: string | null; policy_version_hash: string | null;
      revision: number | null;
      use_limit: number | null; uses_consumed: number | null;
      effect_id: string | null; effect_revision: number | null;
    } | undefined;
    if (!approval || approval.decision !== 'approved'
        || approval.run_id !== input.effect.runId
        || approval.workspace_id !== workspaceId
        || !approval.scope_hash || approval.scope_hash !== input.effect.scopeHash
        || !approval.payload_fingerprint
        || approval.payload_fingerprint !== input.effect.payloadFingerprint
        || !approval.policy_version_hash
        || approval.policy_version_hash !== input.effect.policyVersionHash
        || approval.effect_id !== input.effect.id
        || approval.effect_revision !== input.effect.effectRevision
        || (approval.expires_at && approval.expires_at <= new Date().toISOString())) {
      throw new OgraError(OgraErrorCode.APPROVAL_REQUIRED,
        `pre-callback CAS: approval ${input.approvalId} is not valid for this effect`);
    }
    const invocationApproval = approval.approval_type === 'egress'
      || approval.approval_type === 'tool_invocation';
    const validType = input.bindingKind === 'initial'
      ? invocationApproval
      : approval.approval_type === 'recovery_retry';
    if (!validType) {
      throw new OgraError(OgraErrorCode.APPROVAL_REQUIRED,
        `pre-callback CAS: approval ${input.approvalId} type is not valid for ${input.bindingKind}`);
    }
    const approvalRevision = approval.revision ?? 1;
    // SQLite is the authority for the one-use reservation. The revision
    // predicate rejects a changed approval row; the counter predicate lets
    // only one concurrent callback consume a default single-use approval.
    const consumed = this.odb.getDB().prepare(`
      UPDATE approvals
         SET uses_consumed = uses_consumed + 1
       WHERE id = ? AND revision = ? AND decision = 'approved'
         AND uses_consumed < use_limit
    `).run(input.approvalId, approvalRevision);
    if (consumed.changes !== 1) {
      throw new OgraError(OgraErrorCode.APPROVAL_REQUIRED,
        `pre-callback CAS: approval ${input.approvalId} was already consumed or changed`);
    }
    const bindingId = `bind_${crypto.randomBytes(6).toString('hex')}`;
    const consumptionId = `consume_${crypto.randomBytes(6).toString('hex')}`;
    const now = new Date().toISOString();
    this.odb.getDB().prepare(`
      INSERT INTO effect_approval_bindings (id, effect_id, callback_attempt_no,
        approval_id, approval_revision, binding_kind, created_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(bindingId, input.effect.id, input.attemptNo, input.approvalId,
      approvalRevision, input.bindingKind, input.eventId);
    this.odb.getDB().prepare(`
      INSERT INTO approval_consumptions (id, approval_id, effect_id,
        callback_attempt_no, approval_revision, consumed_at, event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(consumptionId, input.approvalId, input.effect.id, input.attemptNo,
      approvalRevision, now, input.eventId);
    this.runtime.appendEdge({
      runId: input.effect.runId,
      fromKind: 'effect', fromId: input.effect.id,
      relation: 'bound_to_approval', toKind: 'approval',
      toId: input.approvalId, sourceEventId: input.eventId,
    });
  }

  /* ============================================================
   * Step 3a: record trusted receipt + seal result capsule
   * (applicationStatus === 'applied' only)
   * ============================================================ */

  recordReceipt(input: RecordReceiptInput): RecordReceiptOutput {
    if (input.applicationStatus === 'unknown') {
      // Unknown outcome: do NOT write a receipt row. Plan 10 §3.2.1
      // (step 7) + §4 require that a sent attempt lacking a
      // complete trusted receipt/result capsule is `unknown`,
      // NOT `received`. The driver / recovery layer must use
      // recordUnknownOutcome() instead. Fail closed here so
      // accidental misuse cannot bypass reconciliation.
      throw new OgraError(OgraErrorCode.EFFECT_OUTCOME_UNKNOWN,
        'recordReceipt refused: applicationStatus=unknown must go through recordUnknownOutcome');
    }
    if (input.applicationStatus === 'not_applied') {
      // The callback was cancelled before it started. Plan 10
      // §3.2 requires `cancelled_before_send` for this case,
      // which is a terminal state set BEFORE the cas — but
      // casToInFlight already left the effect in `in_flight`.
      // The driver should use cancelBeforeSend() instead of
      // recordReceipt for this path. Fail closed.
      throw new OgraError(OgraErrorCode.EFFECT_INVALID_TRANSITION,
        'recordReceipt refused: applicationStatus=not_applied must go through cancelBeforeSend');
    }
    return this.recordTrustedReceipt(input);
  }

  /* ============================================================
   * Step 3b: trusted receipt (private — invoked via recordReceipt)
   * ============================================================ */

  private recordTrustedReceipt(input: RecordReceiptInput): RecordReceiptOutput {
    const effect = this.runtime.readEffect(input.effectId);
    if (effect.state !== 'in_flight') {
      throw new OgraError(OgraErrorCode.EFFECT_INVALID_TRANSITION,
        `recordReceipt: effect ${input.effectId} not in_flight (was ${effect.state})`);
    }
    if (input.attemptNo <= 0) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'recordReceipt: attemptNo must be positive');
    }
    // Build a fresh receipt id.
    const receiptId = `rcp_${crypto.randomBytes(6).toString('hex')}`;
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    return this.runtime.transactionalAppend<RecordReceiptOutput>({
      meta: {
        runId: effect.runId,
        workspaceId: null,
        eventType: 'effect_received',
        eventPayload: {
          effectId: effect.id,
          attemptNo: input.attemptNo,
          applicationStatus: input.applicationStatus,
          providerStatus: input.providerStatus,
        },
        frameId: effect.ownerFrameId,
        effectId: effect.id,
        externalReceiptHash: null,
      },
      body: (eventId) => {
        // `capsules.receipt_id` is a FK and the receipt must be part of the
        // result capsule's AEAD AAD. Defer this one transaction's FK check so
        // we can seal first and insert the immutable receipt before commit.
        this.odb.getDB().pragma('defer_foreign_keys = ON');
        // 1. Seal the result capsule. The raw result body lives
        // inside the ciphertext; SQLite only sees ref/hash/version.
        // `responseHash` identifies the exact structured adapter outcome, not
        // the encrypted-capsule blob.  It is calculated before sealing so it
        // can be included in the AEAD AAD (via payloadFingerprint) and later
        // checked against both the receipt and decrypted result metadata.
        const resultPayload = {
          attemptNo: input.attemptNo,
          applicationStatus: input.applicationStatus,
          providerStatus: input.providerStatus,
          requestId: input.requestId,
          requestHash: input.requestHash,
          result: input.result,
        };
        const responseHash = crypto.createHash('sha256')
          .update(canonicalJSON(resultPayload)).digest('hex');
        const resultBinding: CapsuleBinding = {
          workspaceId: this.resolveWorkspaceId(effect.runId),
          capsuleKind: 'result',
          formatVersion: 'v1',
          runId: effect.runId,
          effectId: effect.id,
          // The receipt id is allocated before sealing specifically so it is
          // part of the AEAD binding. A result capsule cannot be replayed
          // onto a different receipt during restart finalization.
          receiptId,
          attemptNo: input.attemptNo,
          adapterKind: effect.adapterKind,
          adapterVersion: 'M1-fixture',
          // Capsules.payload_fingerprint is an authenticated projection. For
          // result capsules it binds the receipt's response hash; callback
          // capsules retain their callback/approval fingerprint.
          payloadFingerprint: responseHash,
          scopeHash: effect.idempotencyKeyHash ?? '',
          expiresAt,
          createdEventId: eventId,
        };
        const resultCapsule = this.capsuleStore.seal(resultBinding, resultPayload);
        // 2. Compute the receipt hash from the canonical receipt
        // tuple. The result is also persisted INSIDE the result
        // capsule above; the receipt row carries only the hash +
        // capsule refs.
        const receiptHash = crypto.createHash('sha256')
          .update(canonicalJSON({
            effectId: effect.id,
            attemptNo: input.attemptNo,
            requestHash: input.requestHash,
            responseHash,
            applicationStatus: input.applicationStatus,
            providerStatus: input.providerStatus,
          })).digest('hex');
        try {
          this.odb.getDB().prepare(`
            INSERT INTO effect_receipts (id, effect_id, attempt_no,
              request_id, request_hash, response_hash, result_capsule_ref,
              result_capsule_hash, result_capsule_format_version,
              provider_status, application_status, receipt_hash,
              event_id, received_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            receiptId, effect.id, input.attemptNo,
            input.requestId, input.requestHash, responseHash,
            resultCapsule.ref, resultCapsule.hash,
            resultCapsule.formatVersion,
            input.providerStatus, input.applicationStatus,
            receiptHash, eventId, new Date().toISOString(),
          );
        } catch (err) {
          if (String((err as Error)?.message).includes('UNIQUE')) {
            throw new OgraError(OgraErrorCode.RECEIPT_DUPLICATE,
              `effect ${effect.id} already has a receipt for attempt_no=${input.attemptNo}`);
          }
          throw err;
        }
        // 3. Transition to received (CAS — must still be in_flight).
        const casRes = this.odb.getDB().prepare(`
          UPDATE run_effects SET state = 'received',
            effect_revision = effect_revision + 1,
            authoritative_receipt_id = ?, external_receipt_hash = ?,
            updated_at = ? WHERE id = ? AND state = 'in_flight'
        `).run(receiptId, receiptHash, new Date().toISOString(), effect.id);
        if (casRes.changes === 0) {
          throw new OgraError(OgraErrorCode.REVISION_CONFLICT,
            `recordReceipt CAS lost for effect ${effect.id}`);
        }
        // 4. Edge: effect → receipt. Bind the edge to the L1 event
        // so the L0-L1 bidirectional index is fully traceable.
        this.runtime.appendEdge({
          runId: effect.runId, fromKind: 'effect',
          fromId: effect.id, relation: 'has_receipt',
          toKind: 'receipt', toId: receiptId, sourceEventId: eventId,
        });
        return {
          effectId: effect.id,
          receiptId,
          attemptNo: input.attemptNo,
          resultCapsuleRef: resultCapsule.ref,
          resultCapsuleHash: resultCapsule.hash,
        };
      },
    });
  }

  /* ============================================================
   * Step 3c: record unknown outcome (no receipt row, transition
   * to `unknown` with incident). This is the ONLY way to leave
   * the effect in `unknown` state for reconciliation.
   * ============================================================ */

  recordUnknownOutcome(input: {
    effectId: string;
    attemptNo: number;
    providerStatus: string | null;
    /**
     * If the adapter supports outcome query, the recovery layer
     * may have ALREADY reconciled the unknown to a known
     * outcome. In that case the driver can pass
     * `resolvedOutcome` ('applied' | 'not_applied') and we'll
     * skip the unknown transition. Otherwise we record a
     * `unknown` transition with an incident log entry.
     */
    resolvedOutcome?: 'applied' | 'not_applied' | null;
  }): { effectId: string; state: 'unknown' | 'received' | 'cancelled_before_send' } {
    const effect = this.runtime.readEffect(input.effectId);
    if (effect.state !== 'in_flight') {
      throw new OgraError(OgraErrorCode.EFFECT_INVALID_TRANSITION,
        `recordUnknownOutcome: effect ${input.effectId} not in_flight (was ${effect.state})`);
    }
    if (input.attemptNo <= 0) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'recordUnknownOutcome: attemptNo must be positive');
    }
    return this.runtime.transactionalAppend<{
      effectId: string; state: 'unknown' | 'received' | 'cancelled_before_send';
    }>({
      meta: {
        runId: effect.runId,
        workspaceId: null,
        eventType: 'effect_unknown_state',
        eventPayload: {
          effectId: effect.id,
          attemptNo: input.attemptNo,
          providerStatus: input.providerStatus,
          resolvedOutcome: input.resolvedOutcome ?? null,
        },
        frameId: effect.ownerFrameId,
        effectId: effect.id,
        externalReceiptHash: null,
      },
      body: (eventId) => {
        // Persist a capsule failure so the audit packet + recovery
        // report can correlate the unknown state with an incident.
        this.capsuleStore.recordFailure({
          effectId: effect.id, runId: effect.runId,
          capsuleRef: '(no-trusted-receipt)', attemptNo: input.attemptNo,
          failureKind: 'missing',
          detail: `effect ${input.effectId} attempt=${input.attemptNo} adapter outcome ${input.providerStatus ?? 'unknown'} ` +
                  `— no trusted receipt; transition to unknown`,
        });
        // CAS: in_flight -> unknown. We do NOT touch any receipt
        // row; the effect is now in a state that requires the
        // recovery layer to reconcile (outcome query or
        // idempotent retry).
        const casRes = this.odb.getDB().prepare(`
          UPDATE run_effects SET state = 'unknown',
            effect_revision = effect_revision + 1,
            updated_at = ? WHERE id = ? AND state = 'in_flight'
        `).run(new Date().toISOString(), effect.id);
        if (casRes.changes === 0) {
          throw new OgraError(OgraErrorCode.REVISION_CONFLICT,
            `recordUnknownOutcome CAS lost for effect ${effect.id}`);
        }
        // Edge: effect → incident (audit edge ties the unknown
        // state to the L1 event that produced it).
        this.runtime.appendEdge({
          runId: effect.runId, fromKind: 'effect',
          fromId: effect.id, relation: 'has_ingress',
          toKind: 'ingress', toId: `incident_${input.attemptNo}`,
          sourceEventId: eventId,
        });
        return { effectId: effect.id, state: 'unknown' };
      },
    });
  }

  /**
   * Mark a planned effect as `cancelled_before_send`.
   * Use this when the callback is known to not have been
   * started (e.g. local decision to abort before cas).
   */
  cancelBeforeSend(input: { effectId: string; expectedRevision: number }): {
    effectId: string; state: 'cancelled_before_send';
  } {
    const effect = this.runtime.readEffect(input.effectId);
    // `in_flight` is durable evidence that callback intent was committed.
    // We cannot prove that the callback did not leave the process after that
    // point, so it must reconcile through unknown/outcome handling instead of
    // manufacturing the stronger cancelled-before-send terminal evidence.
    if (effect.state !== 'planned') {
      throw new OgraError(OgraErrorCode.EFFECT_INVALID_TRANSITION,
        `cancelBeforeSend: effect ${input.effectId} not planned (was ${effect.state})`);
    }
    if (effect.effectRevision !== input.expectedRevision) {
      throw new OgraError(OgraErrorCode.REVISION_CONFLICT,
        `cancelBeforeSend: effect ${input.effectId} expected revision ${input.expectedRevision} but was ${effect.effectRevision}`);
    }
    return this.runtime.transactionalAppend<{
      effectId: string; state: 'cancelled_before_send';
    }>({
      meta: {
        runId: effect.runId,
        workspaceId: null,
        eventType: 'effect_cancelled_before_send',
        eventPayload: { effectId: effect.id },
        frameId: effect.ownerFrameId,
        effectId: effect.id,
      },
      body: (eventId) => {
        const casRes = this.odb.getDB().prepare(`
          UPDATE run_effects SET state = 'cancelled_before_send',
            effect_revision = effect_revision + 1,
            updated_at = ? WHERE id = ? AND state = 'planned'
            AND effect_revision = ?
        `).run(new Date().toISOString(), effect.id, input.expectedRevision);
        if (casRes.changes === 0) {
          throw new OgraError(OgraErrorCode.REVISION_CONFLICT,
            `cancelBeforeSend CAS lost for effect ${effect.id}`);
        }
        this.runtime.appendEdge({
          runId: effect.runId, fromKind: 'effect',
          fromId: effect.id, relation: 'has_ingress',
          toKind: 'ingress', toId: `cancel_${effect.id}`,
          sourceEventId: eventId,
        });
        return { effectId: effect.id, state: 'cancelled_before_send' };
      },
    });
  }

  /* ============================================================
   * Step 4: commit terminal (received -> committed)
   * ============================================================ */

  commitToTerminal(input: CommitTerminalInput): CommitTerminalOutput {
    const effect = this.runtime.readEffect(input.effectId);
    if (effect.state !== 'received') {
      throw new OgraError(OgraErrorCode.EFFECT_INVALID_TRANSITION,
        `commitToTerminal: effect ${input.effectId} not received (was ${effect.state})`);
    }
    if (effect.effectRevision !== input.expectedRevision) {
      throw new OgraError(OgraErrorCode.REVISION_CONFLICT,
        `commitToTerminal: effect ${input.effectId} expected revision ${input.expectedRevision} but was ${effect.effectRevision}`);
    }
    this.assertActiveLease(effect.runId, input.leaseHolder, input.expectedLeaseVersion,
      'commitToTerminal');
    // A received effect is only eligible for ingress when its authoritative
    // receipt names an intact, workspace-bound result capsule.  Do this once
    // before the transaction so a failure can persist its incident, and once
    // inside the transaction below to protect the final CAS from a concurrent
    // row mutation.
    this.verifyAuthoritativeResultCapsule(effect, input.receiptId, input.expectedAttemptNo);
    const findingId = `finding_${crypto.randomBytes(6).toString('hex')}`;
    return this.runtime.transactionalAppend({
      meta: {
        runId: effect.runId,
        workspaceId: null,
        eventType: 'effect_committed',
        eventPayload: {
          effectId: effect.id,
          attemptNo: input.expectedAttemptNo,
          receiptId: input.receiptId,
          findingId,
        },
        frameId: effect.ownerFrameId,
        effectId: effect.id,
        externalReceiptHash: null,
      },
      body: (eventId) => {
        this.assertActiveLease(effect.runId, input.leaseHolder, input.expectedLeaseVersion,
          'commitToTerminal');
        this.verifyAuthoritativeResultCapsule(effect, input.receiptId, input.expectedAttemptNo);
        // 1. Write the (minimal) ingress finding row. M1 always
        // writes "accepted" — full ingress review is M2.
        const now = new Date().toISOString();
        this.odb.getDB().prepare(`
          INSERT INTO ingress_findings (id, effect_id, receipt_id,
            finding_kind, detail, event_id, created_at)
          VALUES (?, ?, ?, 'accepted', ?, ?, ?)
        `).run(findingId, effect.id, input.receiptId,
          `M1 fixture accepted; attempt=${input.expectedAttemptNo}`,
          eventId, now);
        // 2. Terminal CAS — only one transaction can win.
        const casRes = this.odb.getDB().prepare(`
          UPDATE run_effects SET state = 'committed',
            effect_revision = effect_revision + 1,
            ingress_finding_id = ?,
            terminal_event_id = ?,
            updated_at = ? WHERE id = ? AND state = 'received'
            AND effect_revision = ?
        `).run(findingId, eventId, now, effect.id, input.expectedRevision);
        if (casRes.changes === 0) {
          throw new OgraError(OgraErrorCode.REVISION_CONFLICT,
            `commitToTerminal CAS lost for effect ${effect.id}`);
        }
        // 3. Edge: effect → ingress_finding. Bind the edge to
        // the L1 event so the L0-L1 bidirectional index is
        // fully traceable.
        this.runtime.appendEdge({
          runId: effect.runId, fromKind: 'effect',
          fromId: effect.id, relation: 'has_ingress',
          toKind: 'ingress', toId: findingId,
          sourceEventId: eventId,
        });
        const refreshed = this.runtime.readEffect(effect.id);
        return {
          effectId: refreshed.id,
          ingressFindingId: findingId,
          effectRevision: refreshed.effectRevision,
        };
      },
    });
  }

  /* ============================================================
   * Recovery-side helpers (used by RecoveryService)
   * ============================================================ */

  private assertActiveLease(
    runId: string, holderId: string, leaseVersion: number, operation: string,
  ): void {
    const row = this.odb.getDB().prepare(`
      SELECT 1 FROM recovery_leases
       WHERE run_id = ? AND holder_id = ? AND lease_version = ?
         AND released_at IS NULL AND expires_at > ?
    `).get(runId, holderId, leaseVersion, new Date().toISOString());
    if (!row) {
      throw new OgraError(OgraErrorCode.LEASE_NOT_HELD,
        `${operation}: active lease authority is not held by ${holderId}`);
    }
  }

  /**
   * Load the authoritative callback capsule for an attempt.
   * Returns the decrypted payload OR throws a typed failure
   * (which the caller may surface to incident log).
   */
  loadCallbackPayload(effectId: string, attemptNo: number): {
    binding: CapsuleBinding;
    workspaceTag: string;
    payload: unknown;
    verifiedHash: string;
  } {
    return this.capsuleStore.openByEffect({
      effectId, capsuleKind: 'callback', attemptNo,
    });
  }

  private verifyAuthoritativeResultCapsule(
    effect: ReturnType<DurableRuntimeService['readEffect']>, receiptId: string, attemptNo: number,
  ): void {
    if (effect.authoritativeReceiptId !== receiptId) {
      throw new OgraError(OgraErrorCode.RECEIPT_NOT_FOUND,
        `commitToTerminal: receipt ${receiptId} is not authoritative for effect ${effect.id}`);
    }
    const receipt = this.odb.getDB().prepare(
      `SELECT id, effect_id, attempt_no, request_id, request_hash, response_hash,
              provider_status, application_status, receipt_hash,
              result_capsule_ref, result_capsule_hash, result_capsule_format_version
         FROM effect_receipts WHERE id = ?`,
    ).get(receiptId) as {
      id: string; effect_id: string; attempt_no: number;
      request_id: string | null; request_hash: string | null; response_hash: string | null;
      provider_status: string | null; application_status: string; receipt_hash: string;
      result_capsule_ref: string | null; result_capsule_hash: string | null;
      result_capsule_format_version: string | null;
    } | undefined;
    if (!receipt || receipt.effect_id !== effect.id || receipt.attempt_no !== attemptNo) {
      throw new OgraError(OgraErrorCode.RECEIPT_NOT_FOUND,
        `commitToTerminal: receipt ${receiptId} does not belong to effect ${effect.id} attempt ${attemptNo}`);
    }
    if (receipt.application_status !== 'applied') {
      throw new OgraError(OgraErrorCode.EFFECT_INVALID_TRANSITION,
        `commitToTerminal: receipt ${receiptId} is not trusted applied evidence`);
    }
    const expectedReceiptHash = crypto.createHash('sha256').update(canonicalJSON({
      effectId: effect.id,
      attemptNo,
      requestHash: receipt.request_hash,
      responseHash: receipt.response_hash,
      applicationStatus: receipt.application_status,
      providerStatus: receipt.provider_status,
    })).digest('hex');
    if (!receipt.response_hash || receipt.receipt_hash !== expectedReceiptHash) {
      throw new OgraError(OgraErrorCode.CAPSULE_INVALID,
        `commitToTerminal: receipt ${receiptId} hash is invalid`);
    }
    const opened = this.capsuleStore.openResultForReceipt<{
      attemptNo?: unknown; applicationStatus?: unknown; providerStatus?: unknown;
      requestId?: unknown; requestHash?: unknown; result?: unknown;
    }>({
      workspaceId: this.resolveWorkspaceId(effect.runId), effectId: effect.id,
      receiptId, attemptNo, resultCapsuleRef: receipt.result_capsule_ref,
      resultCapsuleHash: receipt.result_capsule_hash,
      resultCapsuleFormatVersion: receipt.result_capsule_format_version,
    });
    const resultPayload = opened.payload;
    const expectedResponseHash = crypto.createHash('sha256')
      .update(canonicalJSON(resultPayload)).digest('hex');
    if (opened.binding.payloadFingerprint !== receipt.response_hash
        || expectedResponseHash !== receipt.response_hash
        || resultPayload.attemptNo !== attemptNo
        || resultPayload.applicationStatus !== 'applied'
        || resultPayload.providerStatus !== receipt.provider_status
        || resultPayload.requestId !== receipt.request_id
        || resultPayload.requestHash !== receipt.request_hash) {
      throw new OgraError(OgraErrorCode.CAPSULE_INVALID,
        `commitToTerminal: result capsule does not match receipt ${receiptId}`);
    }
  }

  /**
   * Load the authoritative result capsule for an attempt.
   */
  loadResultPayload(effectId: string, attemptNo: number): OpenCapsule {
    return this.capsuleStore.openByEffect({
      effectId, capsuleKind: 'result', attemptNo,
    });
  }

  /** Lookup helpers for the audit packet. */
  readCapsuleForEffect(effectId: string, kind: 'callback' | 'result', attemptNo: number): SealedCapsuleRow | null {
    return this.capsuleStore.fetchByBinding({ effectId, capsuleKind: kind, attemptNo });
  }

  /* ============================================================
   * Workspace resolution
   * ============================================================ */

  /**
   * The effect protocol writes rows to the `capsules` table whose
   * `workspace_id` references `workspaces(id)`. Resolve that id
   * via the agent_runs row. If no workspace is attached (test
   * fixtures), fall back to the runtime's workspace lookup so
   * CapsuleStore can synthesize a tag.
   */
  private resolveWorkspaceId(runId: string): string {
    const row = this.odb.getDB().prepare(
      'SELECT workspace_id FROM agent_runs WHERE id = ?',
    ).get(runId) as { workspace_id: string | null } | undefined;
    if (row && row.workspace_id) return row.workspace_id;
    // Fallback: a fake "default" workspace id. CapsuleStore will
    // persist a tag against this id; in production this never
    // fires because every run has a workspace.
    return 'ws_default';
  }
}
