/**
 * Sequence 1B Milestone 1 — Recovery Service.
 *
 * Implements plan 10 §8 (Recovery Flow). The recovery service is
 * the ONLY entry point that may move an effect out of `unknown`
 * or finalize an effect in `received`. It:
 *
 *   1. Acquires / renews the local recovery lease.
 *   2. Loads the recovery state for a run from SQLite + capsule
 *      (no in-memory map is consulted).
 *   3. Reconciles each effect in a non-terminal state by:
 *        - `planned`: callback never started. The effect can be
 *          resumed by casToInFlight again. Recovery performs a
 *          controlled retry ONLY if the adapter supports
 *          idempotency AND the callback capsule is intact; else
 *          it creates an incident and blocks.
 *        - `in_flight`: callback was attempted but no receipt
 *          committed. Recovery treats this as `unknown` for
 *          reconciliation purposes (the adapter may have applied).
 *        - `received`: local commit pending. Recovery performs
 *          the commit (never re-invokes the callback). This is
 *          the "crash after receipt committed but before ingress
 *          finished" case.
 *        - `unknown`: recovery reconciles by reading the
 *          authoritative receipt row (if any) + the result
 *          capsule (if any) and either:
 *            a) reconcile to `received`/`committed` (no
 *               double-application) — when the result capsule
 *               + receipt row exist AND the adapter supports
 *               outcome query (which our MockEffectAdapter does
 *               not — but the real reconciliation path is
 *               agnostic to whether the adapter supports outcome
 *               query, because the receipt row IS the outcome).
 *            b) `unknown -> in_flight` for a controlled retry
 *               ONLY IF the adapter supports idempotency AND a
 *               new attempt_no is supplied AND the callback
 *               capsule is intact. The kernel records a fresh
 *               attempt + receipt; never re-applies the same
 *               idempotency key.
 *            c) Incident + block when the adapter cannot guarantee
 *               idempotent application AND no receipt is on
 *               disk.
 *
 * The service is hermetic: every state change is committed in
 * the same SQLite transaction as the L1 audit event, with the
 * receipt + result capsule + audit edges bound. No synthetic
 * completions; no raw payload in audit; no re-applied idempotency
 * key.
 */

import * as crypto from 'crypto';
import { OgraError, OgraErrorCode } from '../shared/errors';
import { OgraDatabase } from './database';
import { EncryptedCapsuleStore } from './capsule-store';
import {
  DurableRuntimeService,
} from './durable-runtime-service';
import {
  EffectState,
  RecoveryLease,
  RunEffect,
} from './durable-runtime-types';
import { canonicalJSON } from './audit-envelope';
import { EffectProtocolService } from './effect-protocol-service';
import type { VerifiedCallbackRecoveryCapabilities } from './capsule-store';
export interface RecoveryConditionChecker {
  /**
   * Series 1B M1 Round 6: re-verify before any recovery retry.
   * The recovery layer MUST refuse to re-callback an effect
   * whose approval has expired, been revoked, or whose
   * policy/route bindings no longer match the canonical
   * persisted state. Per plan 10 §3.2.1 step 9 + §4 step 4
   * ("revalidate approval, policy and route before retry").
   *
   * Returns the canonical approval/policy/route snapshot when
   * all checks pass; returns `{ok:false, reason}` otherwise.
   * Implementations should be fail-closed: missing rows,
   * expired timestamps, mismatched fingerprints, etc.
   * all return ok:false.
   *
   * Round 7: the checker is async because the default
   * implementation invokes `PolicyService.evaluate()`.
   */
  check(input: {
    effect: RunEffect;
    approvalId: string | null;
    policyVersionHash: string | null;
    routeDecisionId: string | null;
    payloadFingerprint: string;
    scopeHash: string | null;
    /** Now override (test-only). */
    asOf?: string;
  }): Promise<{
    ok: boolean;
    reason?:
      | 'approval_missing'
      | 'approval_expired'
      | 'approval_revoked'
      | 'approval_fingerprint_mismatch'
      | 'approval_scope_mismatch'
      | 'approval_policy_version_mismatch'
      | 'route_policy_drift'
      | 'route_decision_missing'
      | 'redaction_rule_version_mismatch';
    detail?: string;
  }>;
}

export interface RecoveryInput {
  runId: string;
  holderId: string;
  /**
   * @deprecated Ignored. Recovery only trusts capability evidence sealed in
   * the verified callback capsule at prepare time.
   */
  adapterSupportsOutcomeQuery?: boolean;
  /** @deprecated Ignored; see adapterSupportsOutcomeQuery. */
  adapterSupportsIdempotencyKey?: boolean;
  /** Adapter's external outcome query — M1 fixture may provide a
   *  pre-known outcome keyed by (effect_id, attempt_no). */
  queryOutcome?: (
    effectId: string,
    attemptNo: number,
  ) => Promise<{
    applied: boolean;
    payload?: unknown;
  } | null>;
  /**
   * Series 1B M1 Round 6: optional condition checker for the
   * approval / policy / route gate. When present, every retry
   * path (planned + unknown → in_flight) MUST consult it before
   * invoking the adapter. When absent, recovery proceeds
   * without revalidation — same behaviour as Round 5.
   */
  conditionChecker?: RecoveryConditionChecker;
  /**
   * A newly approved, attempt-scoped authority for unknown -> in_flight.
   * Recovery never implicitly reuses the initial callback approval.
   */
  recoveryApprovalId?: string | null;
  /**
   * Round 6: optional ISO timestamp override used to test
   * approval expiry. Default = now.
   */
  asOf?: string;
  /** Captured by recover(); never trust caller-supplied lease evidence. */
  recoveryLeaseVersion?: number;
}

export interface RecoveryReport {
  runId: string;
  holderId: string;
  lease: RecoveryLease;
  inspectedEffects: number;
  /** Per-effect outcome. */
  effects: Array<{
    effectId: string;
    stateBefore: EffectState;
    decision:
      | 'committed'           // received -> committed (no callback)
      | 'reconciled_to_received'  // unknown -> received (result capsule present)
      | 'controlled_retry'    // unknown -> in_flight (idempotent + capsule intact)
      | 'incident_blocked'    // could not auto-recover; incident logged
      | 'noop_already_terminal';
    attemptNo?: number;
    receiptId?: string;
    ingressFindingId?: string;
    incidentKind?:
      | 'no_idempotency'
      | 'capsule_corrupt'
      | 'capsule_missing'
      | 'capsule_expired'
      | 'capsule_payload_mismatch'
      | 'outcome_unknown';
    detail: string;
  }>;
}

export class RecoveryService {
  constructor(
    private readonly odb: OgraDatabase,
    private readonly runtime: DurableRuntimeService,
    private readonly capsuleStore: EncryptedCapsuleStore,
    private readonly effectProtocol?: EffectProtocolService,
    /**
     * Production services receive this at construction time.  It is not an
     * optional caller hint: recover() always prefers it over input, so code
     * with a reference to the service cannot bypass Core's policy gate by
     * calling RecoveryService directly.  Hermetic fixtures may construct a
     * service without one and inject a deterministic checker per call.
     */
    private readonly configuredConditionChecker?: RecoveryConditionChecker,
  ) {}

  /**
   * Series 1B M1 Round 6: revalidate approval / policy / route
   * before any recovery retry. Fail-closed. Returns null when
   * the gate passes (recovery may proceed). Returns a
   * populated decision block when the gate fails — the caller
   * MUST return this block from its handler.
   */
  private async checkRecoveryConditions(
    effect: RunEffect,
    input: RecoveryInput,
    approvalId: string | null = effect.currentApprovalId,
  ): Promise<{
    effectId: string;
    decision: 'incident_blocked';
    incidentKind:
      | 'capsule_payload_mismatch'
      | 'capsule_corrupt'
      | 'capsule_expired'
      | 'no_idempotency';
    detail: string;
  } | null> {
    if (!input.conditionChecker) {
      // No checker injected — proceed without revalidation.
      // (M1 fixture paths without approval / policy bindings
      // legitimately skip this gate. Production wires the
      // DefaultRecoveryConditionChecker from OgraCore.)
      return null;
    }
    const result = await input.conditionChecker.check({
      effect,
      approvalId,
      // Round 6: the agent persists policy_version_hash and
      // scope_hash on the effect row at prepare-time. Pass them
      // through to the checker for exact-match comparison.
      policyVersionHash: effect.policyVersionHash,
      routeDecisionId: effect.routeDecisionId,
      payloadFingerprint: effect.payloadFingerprint,
      scopeHash: effect.scopeHash,
      asOf: input.asOf,
    });
    if (result.ok) return null;
    const detail = `recovery gate failed (${result.reason ?? 'unknown'}): ` +
      `${result.detail ?? ''}`;
    return {
      effectId: effect.id,
      decision: 'incident_blocked',
      incidentKind: 'capsule_payload_mismatch',
      detail,
    };
  }

  /**
   * Acquire the lease (or fail-closed if another holder owns it).
   * The lease is the ONLY entry point that may move an effect
   * out of `unknown` or finalize a `received` effect.
   */
  acquireLease(holderId: string, ttlMs: number): RecoveryLease {
    return this.runtime.acquireLease({
      runId: this.requireRun(holderId),
      holderId,
      ttlMs,
    });
  }

  /** Renew an existing lease. */
  renewLease(holderId: string, leaseVersion: number, ttlMs: number): RecoveryLease {
    // We need the runId from the lease.
    const runId = this.findHolderRunId(holderId);
    if (!runId) {
      throw new OgraError(OgraErrorCode.LEASE_NOT_HELD,
        'renewLease: no lease found for this holder');
    }
    return this.runtime.renewLease({
      runId, holderId, expectedLeaseVersion: leaseVersion, ttlMs,
    });
  }

  /** Release the lease. */
  releaseLease(holderId: string, leaseVersion: number): void {
    const runId = this.findHolderRunId(holderId);
    if (!runId) return;
    this.runtime.releaseLease({ runId, holderId, expectedLeaseVersion: leaseVersion });
  }

  /* ============================================================
   * The recovery flow.
   * ============================================================ */

  async recover(input: RecoveryInput): Promise<RecoveryReport> {
    // Do this once at the public boundary.  In production the configured
    // checker wins over any caller-provided value; test-only services without
    // a configured checker retain explicit dependency injection.
    const guardedInput: RecoveryInput = {
      ...input,
      conditionChecker: this.configuredConditionChecker ?? input.conditionChecker,
    };
    // Lease must be held by the caller. Re-acquire if missing.
    let lease: RecoveryLease;
    try {
      lease = this.runtime.readLease(input.runId);
      if (lease.holderId !== input.holderId
          || this.runtime.leaseExpired(lease)) {
        throw new OgraError(OgraErrorCode.LEASE_NOT_HELD,
          'recover: caller does not hold an active lease');
      }
    } catch {
      lease = this.runtime.acquireLease({
        runId: input.runId, holderId: input.holderId, ttlMs: 5 * 60 * 1000,
      });
    }

    // Find every effect that is not terminal.
    const openEffects = this.odb.getDB().prepare(`
      SELECT * FROM run_effects WHERE run_id = ? AND state IN
        ('planned','in_flight','unknown','received')
      ORDER BY id ASC
    `).all(input.runId) as any[];

    const report: RecoveryReport = {
      runId: input.runId,
      holderId: input.holderId,
      lease,
      inspectedEffects: openEffects.length,
      effects: [],
    };

    for (const row of openEffects) {
      const effect = this.rowToEffect(row);
      const decision = await this.reconcileEffect(effect, {
        ...guardedInput, recoveryLeaseVersion: lease.leaseVersion,
      });
      report.effects.push(decision);
    }

    return report;
  }

  /* ============================================================
   * Per-effect reconciliation
   * ============================================================ */

  private async reconcileEffect(effect: RunEffect, input: RecoveryInput): Promise<RecoveryReport['effects'][number]> {
    const decision: RecoveryReport['effects'][number] = {
      effectId: effect.id,
      stateBefore: effect.state,
      decision: 'noop_already_terminal',
      detail: `effect ${effect.id} was in ${effect.state}`,
    };
    switch (effect.state) {
      case 'planned':
        return await this.handlePlanned(effect, decision, input);
      case 'received':
        return await this.handleReceived(effect, decision, input);
      case 'in_flight':
      case 'unknown':
        return await this.handleUnknownOrInFlight(effect, decision, input);
      default:
        return decision;
    }
  }

  private resolveWorkspaceId(runId: string): string {
    const row = this.odb.getDB().prepare(
      'SELECT workspace_id FROM agent_runs WHERE id = ?',
    ).get(runId) as { workspace_id: string | null } | undefined;
    if (!row) {
      throw new OgraError(OgraErrorCode.WORKSPACE_NOT_FOUND,
        `recovery: run ${runId} not found`);
    }
    return row.workspace_id ?? 'no_workspace';
  }

  /**
   * Do not let a recovery caller upgrade an adapter's authority with boolean
   * flags.  Its capabilities must be the ones encrypted with the exact
   * callback request and bound to the durable effect's adapter identity.
   */
  private verifiedCallbackCapabilities(
    effect: RunEffect,
    decision: RecoveryReport['effects'][number],
  ): VerifiedCallbackRecoveryCapabilities | null {
    try {
      return this.capsuleStore.readVerifiedCallbackRecoveryCapabilities({
        effectId: effect.id,
        attemptNo: 1,
        expectedAdapterKind: effect.adapterKind,
      });
    } catch (err) {
      decision.decision = 'incident_blocked';
      decision.incidentKind = 'capsule_corrupt';
      decision.detail = `effect ${effect.id} recovery capability evidence failed verification: ` +
        `${(err as Error)?.message ?? 'unknown'}`;
      this.capsuleStore.recordFailure({
        effectId: effect.id,
        runId: effect.runId,
        capsuleRef: effect.callbackCapsuleRef ?? '(missing)',
        attemptNo: 1,
        failureKind: 'decrypt_failed',
        detail: decision.detail,
      });
      return null;
    }
  }

  private async handlePlanned(
    effect: RunEffect, decision: RecoveryReport['effects'][number], input: RecoveryInput,
  ): Promise<RecoveryReport['effects'][number]> {
    // Round 6: revalidate approval / policy / route BEFORE
    // considering a re-callback. Any drift in approval state
    // (revoked / expired / fingerprint / scope / policy version)
    // or missing route_decision must block the retry.
    const gate = await this.checkRecoveryConditions(effect, input);
    if (gate) {
      decision.decision = gate.decision;
      decision.detail = gate.detail;
      return decision;
    }
    // planned => callback never started. Recovery may drive
    // casToInFlight again, but only if the callback capsule is
    // intact and the adapter supports idempotency (otherwise we
    // cannot prove a previous attempt never applied). M1 fixture
    // supports idempotency + outcome query.
    const callback = this.capsuleStore.fetchByBinding({
      effectId: effect.id, capsuleKind: 'callback', attemptNo: 1,
    });
    if (!callback) {
      this.capsuleStore.recordFailure({
        effectId: effect.id, runId: effect.runId,
        capsuleRef: '(missing)', attemptNo: 1,
        failureKind: 'missing',
        detail: 'recovery: planned effect has no callback capsule',
      });
      decision.decision = 'incident_blocked';
      decision.incidentKind = 'capsule_missing';
      decision.detail = `planned effect ${effect.id} missing callback capsule`;
      return decision;
    }
    try {
      this.capsuleStore.openByEffect({
        effectId: effect.id, capsuleKind: 'callback', attemptNo: 1,
      });
    } catch (err) {
      decision.decision = 'incident_blocked';
      decision.incidentKind = 'capsule_corrupt';
      decision.detail = `planned effect ${effect.id} callback capsule failed verification`;
      this.capsuleStore.recordFailure({
        effectId: effect.id, runId: effect.runId,
        capsuleRef: callback.ref, attemptNo: 1,
        failureKind: 'decrypt_failed',
        detail: (err as Error)?.message ?? 'unknown',
      });
      return decision;
    }
    // Plan 10 §3.2.1 step 9 + §4 step 4: the canonical hash of
    // the callback capsule payload MUST equal the effect's
    // payload_fingerprint. A drift means a different payload
    // is about to be re-applied than was originally prepared.
    // Recovery MUST fail closed in that case to prevent a
    // callback that re-applies with the user's approval bound
    // to a different byte string.
    // The recovery anchor is `effect.capsuleFingerprint`
    // (Round 5 separation). The Sequence-0 approval anchor
    // (`effect.payloadFingerprint`) is independent — recovery
    // never compares against it, never overwrites it. A drift
    // means the canonical capsule bytes differ, which is a
    // fail-closed incident.
    const verifyFp = this.capsuleStore.verifyCallbackAgainstFingerprint({
      effectId: effect.id, attemptNo: 1,
      expectedFingerprint: effect.capsuleFingerprint ?? effect.payloadFingerprint,
    });
    if (verifyFp.outcome !== 'match') {
      decision.decision = 'incident_blocked';
      decision.incidentKind = verifyFp.outcome === 'capsule_failure'
        ? 'capsule_corrupt' : 'capsule_payload_mismatch';
      decision.detail = `planned effect ${effect.id} callback capsule ` +
        `${verifyFp.outcome}: ${verifyFp.detail ?? ''}`;
      this.capsuleStore.recordFailure({
        effectId: effect.id, runId: effect.runId,
        capsuleRef: callback.ref, attemptNo: 1,
        failureKind: verifyFp.outcome === 'mismatch'
          ? 'decrypt_failed' : 'decrypt_failed',
        detail: verifyFp.detail ?? 'canonical hash mismatch',
      });
      return decision;
    }
    const capabilities = this.verifiedCallbackCapabilities(effect, decision);
    if (!capabilities) return decision;
    if (!capabilities.supportsIdempotencyKey) {
      decision.decision = 'incident_blocked';
      decision.incidentKind = 'no_idempotency';
      decision.detail = `planned effect ${effect.id} adapter ${capabilities.adapterKind}@` +
        `${capabilities.adapterVersion} has no sealed idempotency capability`;
      return decision;
    }
    // A planned effect has not been sent, but its callback still must go
    // through the same callback-intent transaction as a normal first attempt.
    // This is where an approval-required effect creates its immutable initial
    // binding and consumes its one-use approval before callback.
    try {
      this.callbackIntentForPlannedRecovery({
        effectId: effect.id,
        expectedRevision: effect.effectRevision,
        leaseHolder: input.holderId,
        approvalId: effect.currentApprovalId,
        expectedLeaseVersion: input.recoveryLeaseVersion,
      });
      decision.decision = 'controlled_retry';
      decision.attemptNo = 1;
      decision.detail = `planned effect ${effect.id} resumed as in_flight`;
    } catch (err) {
      decision.decision = 'incident_blocked';
      decision.incidentKind = 'capsule_corrupt';
      decision.detail = `planned effect ${effect.id} could not CAS to in_flight: ${(err as Error)?.message ?? ''}`;
    }
    return decision;
  }

  private handleReceived(
    effect: RunEffect, decision: RecoveryReport['effects'][number], input: RecoveryInput,
  ): RecoveryReport['effects'][number] {
    // received => local commit pending. Recovery performs the
    // commit (never re-invokes the callback). This is the
    // canonical "crash after receipt, before ingress" path.
    const receipts = effect.authoritativeReceiptId
      ? this.odb.getDB().prepare(
        'SELECT * FROM effect_receipts WHERE id = ? AND effect_id = ?',
      ).get(effect.authoritativeReceiptId, effect.id) as any | undefined
      : undefined;
    if (!receipts) {
      // Defensive — should never happen because in_flight → received
      // is only triggered by recordReceipt. Treat as incident.
      decision.decision = 'incident_blocked';
      decision.incidentKind = 'capsule_missing';
      decision.detail = `received effect ${effect.id} has no receipt row`;
      this.capsuleStore.recordFailure({
        effectId: effect.id, runId: effect.runId,
        capsuleRef: '(missing-receipt)', attemptNo: 0,
        failureKind: 'missing',
        detail: 'received effect missing receipt row',
      });
      return decision;
    }
    // Rerun the receipt + commit path. The protocol's
    // commitToTerminal is idempotent given the same receipt row
    // and revision: if another recovery already committed, the
    // revision CAS loses here and we treat it as noop.
    try {
      const result = this.commitTerminalEffect(
        effect, receipts.id, receipts.attempt_no, input.holderId, input.recoveryLeaseVersion,
      );
      decision.decision = 'committed';
      decision.attemptNo = receipts.attempt_no;
      decision.receiptId = receipts.id;
      decision.detail = `received effect ${effect.id} committed on restart`;
      decision.ingressFindingId = result.ingressFindingId;
      return decision;
    } catch (err) {
      // CAS lost or already-committed effect: treat as noop.
      if (err && (err as { code?: string }).code === OgraErrorCode.REVISION_CONFLICT) {
        decision.decision = 'noop_already_terminal';
        decision.detail = `effect ${effect.id} was already committed`;
        return decision;
      }
      throw err;
    }
  }

  private async handleUnknownOrInFlight(
    effect: RunEffect, decision: RecoveryReport['effects'][number], input: RecoveryInput,
  ): Promise<RecoveryReport['effects'][number]> {
    // Round 6: revalidate approval / policy / route BEFORE any
    // re-callback or commit-from-receipt. An expired/revoked
    // approval or missing route must block recovery entirely.
    const gate = await this.checkRecoveryConditions(effect, input);
    if (gate) {
      decision.decision = gate.decision;
      decision.detail = gate.detail;
      return decision;
    }
    // in_flight / unknown => either the adapter applied with no
    // local receipt, or it never applied. Distinguish via:
    //   (a) a receipt row exists => we know applied-or-not;
    //   (b) the adapter's outcome query reports applied; or
    //   (c) neither => we cannot prove non-application, so we
    //       either retry idempotently or block.
    const existingReceipt = this.odb.getDB().prepare(
      'SELECT * FROM effect_receipts WHERE id = ? AND effect_id = ?',
    ).get(effect.authoritativeReceiptId ?? '', effect.id) as any | undefined;
    if (existingReceipt) {
      // We have authoritative receipt evidence. Promote to
      // committed via the normal commit path.
      try {
        const result = this.commitTerminalEffect(
          effect, existingReceipt.id, existingReceipt.attempt_no, input.holderId, input.recoveryLeaseVersion,
        );
        decision.decision = 'committed';
        decision.attemptNo = existingReceipt.attempt_no;
        decision.receiptId = existingReceipt.id;
        decision.detail = `in_flight/unknown effect ${effect.id} reconciled to committed via authoritative receipt`;
        decision.ingressFindingId = result.ingressFindingId;
        return decision;
      } catch (err) {
        if (err && (err as { code?: string }).code === OgraErrorCode.REVISION_CONFLICT) {
          decision.decision = 'noop_already_terminal';
          return decision;
        }
        throw err;
      }
    }
    // No receipt on disk. Ask the adapter's outcome query if
    // available. The outcome query is the SOURCE OF TRUTH for
    // "did this callback apply?" — if it returns
    // {applied: true, payload}, the recovery layer seals a
    // fresh result capsule from that payload, writes a
    // receipt row, and promotes the effect to `committed`
    // in the same SQLite transaction. The adapter is NOT
    // re-invoked.
    // The outcome-query callback is supplied by the host, but whether it may
    // influence recovery comes only from AEAD-verified capability evidence.
    const capabilities = this.verifiedCallbackCapabilities(effect, decision);
    if (!capabilities) return decision;
    if (capabilities.supportsOutcomeQuery && input.queryOutcome) {
      const out = await input.queryOutcome(effect.id, 1);
      if (out && out.applied) {
        try {
          const now = new Date().toISOString();
          // The mock fixture's `payload` is whatever it
          // returned — we seal it as the result body. The
          // result capsule ref is computed from effect+attempt
          // and bound to the recovery lease holder.
          //
          // Phase 1: result capsule + effect_receipts row +
          // effect → received (same SQLite transaction,
          // bound to the L1 `effect_received` event).
          const phase1 = this.runtime.transactionalAppend<{
            effectId: string;
            state: 'received';
            receiptId: string;
            capsuleRef: string;
            capsuleHash: string;
            receivedEventId: string;
          }>({
            meta: {
              runId: effect.runId, workspaceId: null,
              eventType: 'effect_received',
              eventPayload: {
                effectId: effect.id,
                attemptNo: 1,
                applicationStatus: 'applied',
                providerStatus: 'ok',
                source: 'outcome_query',
              },
              frameId: effect.ownerFrameId,
              effectId: effect.id,
            },
            body: (eventId) => {
              this.assertActiveRecoveryLease(effect.runId, input.holderId, input.recoveryLeaseVersion);
              this.odb.getDB().pragma('defer_foreign_keys = ON');
              // (a) Seal the result capsule. The raw payload
              // travels INSIDE the encrypted BLOB; SQLite only
              // sees ref + hash + workspace-tagged AAD. The
              // createdEventId is the L1 event_id, so the
              // capsule row is bidirectionally linked to the
              // audit envelope.
              const receiptId = `rcp_${crypto.randomBytes(6).toString('hex')}`;
              const resultPayload = {
                attemptNo: 1,
                applicationStatus: 'applied',
                providerStatus: 'ok',
                requestId: `recovered_${effect.id}`,
                requestHash: effect.payloadFingerprint,
                result: out.payload ?? {},
                source: 'outcome_query',
              };
              const responseHash = crypto.createHash('sha256')
                .update(canonicalJSON(resultPayload)).digest('hex');
              const sealed = this.capsuleStore.seal({
                workspaceId: this.resolveWorkspaceId(effect.runId),
                capsuleKind: 'result',
                formatVersion: 'v1',
                runId: effect.runId,
                effectId: effect.id,
                receiptId,
                attemptNo: 1,
                adapterKind: effect.adapterKind,
                adapterVersion: 'M1-fixture',
                payloadFingerprint: responseHash,
                scopeHash: effect.idempotencyKeyHash ?? '',
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
                  .toISOString(),
                createdEventId: eventId,
              }, resultPayload);
              // (b) Compute receipt hash from canonical receipt
              // tuple.
              const receiptHash = crypto.createHash('sha256')
                .update(canonicalJSON({
                  effectId: effect.id,
                  attemptNo: 1,
                  requestHash: effect.payloadFingerprint,
                  responseHash,
                  applicationStatus: 'applied',
                  providerStatus: 'ok',
                })).digest('hex');
              // (c) INSERT INTO effect_receipts with event_id.
              try {
                this.odb.getDB().prepare(`
                  INSERT INTO effect_receipts (id, effect_id, attempt_no,
                    request_id, request_hash, response_hash,
                    result_capsule_ref, result_capsule_hash,
                    result_capsule_format_version,
                    provider_status, application_status,
                    receipt_hash, event_id, received_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                  receiptId, effect.id, 1,
                  `recovered_${effect.id}`, effect.payloadFingerprint,
                  responseHash, sealed.ref, sealed.hash,
                  sealed.formatVersion,
                  'ok', 'applied', receiptHash, eventId, now,
                );
              } catch (err) {
                if (String((err as Error)?.message).includes('UNIQUE')) {
                  throw new OgraError(OgraErrorCode.RECEIPT_DUPLICATE,
                    `recovery: effect ${effect.id} already has a receipt for attempt 1`);
                }
                throw err;
              }
              // (d) Edge: effect → receipt. The source event is the
              // SAME L1 `effect_received` event.
              this.runtime.appendEdge({
                runId: effect.runId, fromKind: 'effect',
                fromId: effect.id, relation: 'has_receipt',
                toKind: 'receipt', toId: receiptId, sourceEventId: eventId,
              });
              // (e) CAS in_flight/unknown → received with the
              // authoritative_receipt_id + external_receipt_hash
              // bound on the row.
              const casRes = this.odb.getDB().prepare(`
                UPDATE run_effects SET state = 'received',
                  effect_revision = effect_revision + 1,
                  authoritative_receipt_id = ?, external_receipt_hash = ?,
                  updated_at = ? WHERE id = ? AND state = ?
              `).run(receiptId, receiptHash, now,
                effect.id, effect.state);
              if (casRes.changes === 0) {
                throw new OgraError(OgraErrorCode.REVISION_CONFLICT,
                  `recovery: outcome-query CAS lost for effect ${effect.id}`);
              }
              return {
                effectId: effect.id, state: 'received' as const,
                receiptId, capsuleRef: sealed.ref, capsuleHash: sealed.hash,
                receivedEventId: eventId,
              };
            },
          });
          // Phase 2: commit to terminal in a SECOND
          // transactional append. ingress_finding.event_id is
          // bound to the L1 `effect_recovery_committed` event
          // and the receipt_id is NOT NULL (it carries the
          // authoritative row we wrote in phase 1).
          const phase2 = this.runtime.transactionalAppend<{
            findingId: string;
            terminalEventId: string;
          }>({
            meta: {
              runId: effect.runId, workspaceId: null,
              eventType: 'effect_recovery_committed',
              eventPayload: {
                effectId: effect.id,
                receiptId: phase1.receiptId,
                source: 'outcome_query',
              },
              frameId: effect.ownerFrameId,
              effectId: effect.id,
            },
            body: (eventId) => {
              this.assertActiveRecoveryLease(effect.runId, input.holderId, input.recoveryLeaseVersion);
              const receivedEffect = this.runtime.readEffect(effect.id);
              if (receivedEffect.state !== 'received') {
                throw new OgraError(OgraErrorCode.REVISION_CONFLICT,
                  `recovery: effect ${effect.id} is no longer received`);
              }
              if (!receivedEffect.authoritativeReceiptId) {
                throw new OgraError(OgraErrorCode.RECEIPT_NOT_FOUND,
                  `recovery: authoritative receipt ${phase1.receiptId} is missing`);
              }
              this.verifyAuthoritativeResultCapsule(receivedEffect, phase1.receiptId, 1);
              const findingId = `finding_${crypto.randomBytes(6).toString('hex')}`;
              this.odb.getDB().prepare(`
                INSERT INTO ingress_findings (id, effect_id, receipt_id,
                  finding_kind, detail, event_id, created_at)
                VALUES (?, ?, ?, 'accepted', ?, ?, ?)
              `).run(findingId, effect.id, phase1.receiptId,
                'M1 fixture: outcome-query accepted',
                eventId, now);
              const cas = this.odb.getDB().prepare(`
                UPDATE run_effects SET state = 'committed',
                  effect_revision = effect_revision + 1,
                  ingress_finding_id = ?,
                  terminal_event_id = ?,
                  updated_at = ? WHERE id = ? AND state = 'received'
              `).run(findingId, eventId, now, effect.id);
              if (cas.changes === 0) {
                throw new OgraError(OgraErrorCode.REVISION_CONFLICT,
                  `recovery: outcome-query commit CAS lost for effect ${effect.id}`);
              }
              // Edge: effect → ingress_finding.
              this.runtime.appendEdge({
                runId: effect.runId, fromKind: 'effect',
                fromId: effect.id, relation: 'has_ingress',
                toKind: 'ingress', toId: findingId,
                sourceEventId: eventId,
              });
              return { findingId, terminalEventId: eventId };
            },
          });
          void phase2;
          decision.decision = 'committed';
          decision.receiptId = phase1.receiptId;
          decision.detail = `effect ${effect.id} reconciled to ` +
            `committed via outcome_query (no physical re-apply); ` +
            `result capsule ${phase1.capsuleRef.slice(0, 16)}… → receipt ${phase1.receiptId.slice(0, 16)}… → finding ${phase2.findingId.slice(0, 16)}…`;
          return decision;
        } catch (err) {
          decision.decision = 'noop_already_terminal';
          decision.detail = `effect ${effect.id} outcome-query reconcile failed: ${(err as Error)?.message ?? ''} (${String((err as { code?: string })?.code ?? '')})`;
          // eslint-disable-next-line no-console
          console.error('outcome-query reconcile failed:', err);
          return decision;
        }
      }
      // Outcome query returned null or applied=false: fall
      // through to idempotent retry / incident.
    }
    // Fallback: support idempotent retry IF the adapter
    // supports idempotency AND the callback capsule is intact.
    if (capabilities.supportsIdempotencyKey) {
      const callback = this.capsuleStore.fetchByBinding({
        effectId: effect.id, capsuleKind: 'callback', attemptNo: 1,
      });
      if (callback) {
        try {
          this.capsuleStore.openByEffect({
            effectId: effect.id, capsuleKind: 'callback', attemptNo: 1,
          });
        } catch {
          decision.decision = 'incident_blocked';
          decision.incidentKind = 'capsule_corrupt';
          decision.detail = `effect ${effect.id} callback capsule failed verification`;
          return decision;
        }
        // Series 1B M1 Round 6: same fail-closed gate as
        // handlePlanned — the recovery anchor is
        // `effect.capsuleFingerprint` (Round 5 separation).
        // Comparing against `effect.payloadFingerprint`
        // (the redactor's egress hash) would always mismatch
        // and block legitimate unknown->in_flight retries.
        const verifyFp = this.capsuleStore.verifyCallbackAgainstFingerprint({
          effectId: effect.id, attemptNo: 1,
          expectedFingerprint: effect.capsuleFingerprint ?? effect.payloadFingerprint,
        });
        if (verifyFp.outcome !== 'match') {
          decision.decision = 'incident_blocked';
          decision.incidentKind = verifyFp.outcome === 'capsule_failure'
            ? 'capsule_corrupt' : 'capsule_payload_mismatch';
          decision.detail = `effect ${effect.id} callback capsule ` +
            `${verifyFp.outcome}: ${verifyFp.detail ?? ''}`;
          this.capsuleStore.recordFailure({
            effectId: effect.id, runId: effect.runId,
            capsuleRef: callback.ref, attemptNo: 1,
            failureKind: 'decrypt_failed',
            detail: verifyFp.detail ?? 'canonical hash mismatch',
          });
          return decision;
        }
        // A retried physical callback gets fresh, scoped authority. The
        // initial approval was consumed before attempt 1 and cannot be
        // silently reused after an unknown outcome.
        if (this.recoveryApprovalRequired(effect) && !input.recoveryApprovalId) {
          decision.decision = 'incident_blocked';
          decision.incidentKind = 'no_idempotency';
          decision.detail = `effect ${effect.id} requires a new recovery approval for attempt 2`;
          return decision;
        }
        if (input.recoveryApprovalId) {
          const recoveryGate = await this.checkRecoveryConditions(
            effect, input, input.recoveryApprovalId,
          );
          if (recoveryGate) {
            decision.decision = recoveryGate.decision;
            decision.detail = recoveryGate.detail;
            return decision;
          }
        }
        // Recovery can drive unknown -> in_flight only through the same
        // callback-intent transaction that creates a recovery_retry binding
        // and consumes the new approval.
        try {
          this.callbackIntentForRecovery({
            effectId: effect.id,
            expectedRevision: effect.effectRevision,
            leaseHolder: input.holderId,
            approvalId: input.recoveryApprovalId ?? null,
            expectedLeaseVersion: input.recoveryLeaseVersion,
          });
          decision.decision = 'controlled_retry';
          decision.attemptNo = 2;
          decision.detail = `unknown effect ${effect.id} driven to in_flight for controlled retry (attempt 2)`;
          return decision;
        } catch (err) {
          decision.decision = 'incident_blocked';
          decision.incidentKind = 'no_idempotency';
          decision.detail = `unknown effect ${effect.id} callback intent blocked: ${(err as Error)?.message ?? ''}`;
          return decision;
        }
      }
    }
    // No outcome query, no idempotency, no receipt → cannot
    // guarantee non-application. Create incident + block.
    decision.decision = 'incident_blocked';
    decision.incidentKind = 'no_idempotency';
    decision.detail = `effect ${effect.id} state=${effect.state} with no authoritative receipt and no idempotency contract`;
    this.capsuleStore.recordFailure({
      effectId: effect.id, runId: effect.runId,
      capsuleRef: '(no-receipt)', attemptNo: 0,
      failureKind: 'missing',
      detail: `no outcome, no idempotency, no receipt — cannot prove non-application`,
    });
    return decision;
  }

  private recoveryApprovalRequired(effect: RunEffect): boolean {
    if (effect.currentApprovalId) return true;
    if (!effect.routeDecisionId) return false;
    const row = this.odb.getDB().prepare(
      'SELECT requires_user_approval FROM route_decisions WHERE id = ?',
    ).get(effect.routeDecisionId) as { requires_user_approval: number | null } | undefined;
    return row?.requires_user_approval === 1;
  }

  private callbackIntentForRecovery(input: {
    effectId: string;
    expectedRevision: number;
    leaseHolder: string;
    approvalId: string | null;
    expectedLeaseVersion: number | undefined;
  }): void {
    if (!this.effectProtocol) {
      throw new OgraError(OgraErrorCode.RECOVERY_BLOCKED,
        'recovery callback intent protocol is not configured');
    }
    this.effectProtocol.casToInFlight({
      effectId: input.effectId,
      expectedRevision: input.expectedRevision,
      expectedAttemptNo: 2,
      expectedState: 'unknown',
      leaseHolder: input.leaseHolder,
      approvalId: input.approvalId,
      expectedLeaseVersion: input.expectedLeaseVersion,
    });
  }

  private callbackIntentForPlannedRecovery(input: {
    effectId: string;
    expectedRevision: number;
    leaseHolder: string;
    approvalId: string | null;
    expectedLeaseVersion: number | undefined;
  }): void {
    if (!this.effectProtocol) {
      throw new OgraError(OgraErrorCode.RECOVERY_BLOCKED,
        'planned recovery callback intent protocol is not configured');
    }
    this.effectProtocol.casToInFlight({
      effectId: input.effectId,
      expectedRevision: input.expectedRevision,
      expectedAttemptNo: 1,
      expectedState: 'planned',
      leaseHolder: input.leaseHolder,
      approvalId: input.approvalId,
      expectedLeaseVersion: input.expectedLeaseVersion,
    });
  }

  /* ============================================================
   * Terminal commit (received → committed)
   * ============================================================ */

  private commitTerminalEffect(
    effect: RunEffect, receiptId: string, receiptAttemptNo: number, leaseHolder: string,
    leaseVersion?: number,
  ): { ingressFindingId: string } {
    this.verifyAuthoritativeResultCapsule(effect, receiptId, receiptAttemptNo);
    // We re-run the receipt path: insert a fresh result-capsule
    // reference (the original capsule row is already on disk and
    // immutable) and transition received -> committed.
    //
    // To avoid creating duplicate result capsules (the
    // `effect_id, capsule_kind, attempt_no` UNIQUE), we reuse the
    // existing capsule ref via the receipt row's existing
    // result_capsule_ref column.
    return this.runtime.transactionalAppend({
      meta: {
        runId: effect.runId,
        workspaceId: null,
        eventType: 'effect_recovery_committed',
        eventPayload: {
          effectId: effect.id,
          receiptId,
          attemptNo: receiptAttemptNo,
          leaseHolder,
        },
        frameId: effect.ownerFrameId,
        effectId: effect.id,
        externalReceiptHash: null,
      },
      body: (eventId) => {
        this.assertActiveRecoveryLease(effect.runId, leaseHolder, leaseVersion);
        this.verifyAuthoritativeResultCapsule(effect, receiptId, receiptAttemptNo);
        const findingId = `finding_${crypto.randomBytes(6).toString('hex')}`;
        const now = new Date().toISOString();
        this.odb.getDB().prepare(`
          INSERT INTO ingress_findings (id, effect_id, receipt_id,
            finding_kind, detail, event_id, created_at)
          VALUES (?, ?, ?, 'accepted', ?, ?, ?)
        `).run(findingId, effect.id, receiptId,
          `M1 recovery accepted; attempt=${receiptAttemptNo}`,
          eventId, now);
        const casRes = this.odb.getDB().prepare(`
          UPDATE run_effects SET state = 'committed',
            effect_revision = effect_revision + 1,
            ingress_finding_id = ?,
            terminal_event_id = ?,
            updated_at = ? WHERE id = ? AND state = 'received'
        `).run(findingId, eventId, now, effect.id);
        if (casRes.changes === 0) {
          throw new OgraError(OgraErrorCode.REVISION_CONFLICT,
            `recovery commit CAS lost for effect ${effect.id}`);
        }
        // Plan 10 §3.2.1: the L1 audit event id is bound to the
        // ingress finding + the audit edge.
        this.runtime.appendEdge({
          runId: effect.runId, fromKind: 'effect',
          fromId: effect.id, relation: 'has_ingress',
          toKind: 'ingress', toId: findingId,
          sourceEventId: eventId,
        });
        return { ingressFindingId: findingId, terminalEventId: eventId };
      },
    });
  }

  private assertActiveRecoveryLease(runId: string, holderId: string, leaseVersion?: number): void {
    if (leaseVersion === undefined) {
      throw new OgraError(OgraErrorCode.LEASE_NOT_HELD,
        'recovery mutation has no captured lease version');
    }
    const row = this.odb.getDB().prepare(`
      SELECT 1 FROM recovery_leases WHERE run_id = ? AND holder_id = ?
        AND lease_version = ? AND released_at IS NULL AND expires_at > ?
    `).get(runId, holderId, leaseVersion, new Date().toISOString());
    if (!row) {
      throw new OgraError(OgraErrorCode.LEASE_NOT_HELD,
        'recovery lease is stale inside finalization transaction');
    }
  }

  private verifyAuthoritativeResultCapsule(
    effect: RunEffect, receiptId: string, attemptNo: number,
  ): void {
    if (effect.authoritativeReceiptId !== receiptId) {
      throw new OgraError(OgraErrorCode.RECEIPT_NOT_FOUND,
        `recovery: receipt ${receiptId} is not authoritative for effect ${effect.id}`);
    }
    const receipt = this.odb.getDB().prepare(
      `SELECT effect_id, attempt_no, request_id, request_hash, response_hash,
              provider_status, application_status, receipt_hash,
              result_capsule_ref, result_capsule_hash, result_capsule_format_version
         FROM effect_receipts WHERE id = ?`,
    ).get(receiptId) as {
      effect_id: string; attempt_no: number; request_id: string | null;
      request_hash: string | null; response_hash: string | null;
      provider_status: string | null; application_status: string; receipt_hash: string;
      result_capsule_ref: string | null;
      result_capsule_hash: string | null; result_capsule_format_version: string | null;
    } | undefined;
    if (!receipt || receipt.effect_id !== effect.id || receipt.attempt_no !== attemptNo) {
      throw new OgraError(OgraErrorCode.RECEIPT_NOT_FOUND,
        `recovery: receipt ${receiptId} does not belong to effect ${effect.id} attempt ${attemptNo}`);
    }
    if (receipt.application_status !== 'applied') {
      throw new OgraError(OgraErrorCode.EFFECT_INVALID_TRANSITION,
        `recovery: receipt ${receiptId} is not trusted applied evidence`);
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
        `recovery: receipt ${receiptId} hash is invalid`);
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
        `recovery: result capsule does not match receipt ${receiptId}`);
    }
  }

  /* ============================================================
   * Helpers
   * ============================================================ */

  private requireRun(holderId: string): string {
    const row = this.odb.getDB().prepare(
      'SELECT run_id FROM recovery_leases WHERE holder_id = ? LIMIT 1',
    ).get(holderId) as { run_id: string } | undefined;
    if (!row) {
      throw new OgraError(OgraErrorCode.LEASE_NOT_HELD,
        `no run is leased by holder ${holderId}`);
    }
    return row.run_id;
  }

  private findHolderRunId(holderId: string): string | null {
    const row = this.odb.getDB().prepare(
      'SELECT run_id FROM recovery_leases WHERE holder_id = ? LIMIT 1',
    ).get(holderId) as { run_id: string } | undefined;
    return row?.run_id ?? null;
  }

  private rowToEffect(row: any): RunEffect {
    return {
      id: row.id,
      runId: row.run_id,
      ownerFrameId: row.owner_frame_id,
      effectType: row.effect_type,
      adapterKind: row.adapter_kind,
      payloadFingerprint: row.payload_fingerprint,
      // Round 5 separation: the recovery anchor (set by the
      // protocol). Falls back to null when the column is not
      // yet present (older test fixtures).
      capsuleFingerprint: row.capsule_fingerprint ?? null,
      // Round 6: snapshot of approval binding fields.
      policyVersionHash: row.policy_version_hash ?? null,
      scopeHash: row.scope_hash ?? null,
      redactionRuleVersion: row.redaction_rule_version ?? null,
      callbackCapsuleRef: row.callback_capsule_ref ?? null,
      callbackCapsuleHash: row.callback_capsule_hash ?? null,
      callbackCapsuleFormatVersion: row.callback_capsule_format_version ?? null,
      idempotencyKeyRef: row.idempotency_key_ref ?? null,
      idempotencyKeyHash: row.idempotency_key_hash ?? null,
      state: row.state,
      allowedRepairActions: JSON.parse(row.allowed_repair_actions_json ?? '[]'),
      dependencyEffectIds: JSON.parse(row.dependency_effect_ids_json ?? '[]'),
      effectRevision: row.effect_revision,
      routeDecisionId: row.route_decision_id ?? null,
      policyEvaluationId: row.policy_evaluation_id ?? null,
      currentApprovalId: row.current_approval_id ?? null,
      egressRecordId: row.egress_record_id ?? null,
      ingressFindingId: row.ingress_finding_id ?? null,
      externalRequestId: row.external_request_id ?? null,
      authoritativeReceiptId: row.authoritative_receipt_id ?? null,
      externalReceiptHash: row.external_receipt_hash ?? null,
      createdEventId: row.created_event_id ?? null,
      terminalEventId: row.terminal_event_id ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Persist a serialized recovery report to L1 so the audit
   * packet can include it.
   */
  appendRecoveryAuditEvent(report: RecoveryReport): string {
    const id = `evt_rec_${crypto.randomBytes(6).toString('hex')}`;
    this.runtime.transactionalAppend({
      meta: {
        runId: report.runId,
        workspaceId: null,
        eventType: 'recovery_audit',
        eventPayload: {
          recoveryEventId: id,
          holderId: report.holderId,
          inspectedEffects: report.inspectedEffects,
          decisions: report.effects.map(e => ({
            effectId: e.effectId, decision: e.decision,
            attemptNo: e.attemptNo ?? null,
            receiptId: e.receiptId ?? null,
            incidentKind: e.incidentKind ?? null,
          })),
        },
      },
      body: () => {
        return id;
      },
    });
    return id;
  }
}
