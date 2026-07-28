/**
 * Series 1B Milestone 2 — IngressReviewService.
 *
 * Independent ingress review for verified result capsules.
 *
 * Contract:
 *   - Inputs come ONLY from the verified result capsule
 *     (no renderer / audit / adapter in-memory raw response).
 *   - The reviewer writes a single ingress_review_decisions row +
 *     UPDATE ingress_findings + UPDATE run_effects state +
 *     L1 event (via transactionalAppend, v2 envelope) +
 *     audit edges in ONE SQLite transaction.
 *   - Quarantine / reject paths NEVER mark an accepted
 *     Observation and never expose the raw result.
 *   - The transaction also persists recovery_decisions when
 *     applicable so the audit chain shows every finalization.
 *   - The result capsule is opened via openResultForReceipt
 *     which validates ownership (workspace / effect / receipt /
 *     attempt), format_version, and stored-vs-verified hash.
 *     Fail-closed on any mismatch.
 *   - effect.effect_revision CAS: the UPDATE returns
 *     stmt.changes(); a 0 change count is a CAS loser and
 *     aborts the entire transaction.
 */
import * as crypto from 'crypto';
import { OgraDatabase } from './database';
import { DurableRuntimeService } from './durable-runtime-service';
import { EncryptedCapsuleStore } from './capsule-store';
import { OgraError, OgraErrorCode } from '../shared/errors';
import { canonicalJSON } from './audit-envelope';

export type IngressOutcome = 'accepted' | 'quarantined' | 'rejected';

/**
 * Sequence 1B Milestone 2 — the independent ingress reviewer
 * is the SOLE path that may author an ingress finding. Both
 * the agent's production path and the recovery's restart
 * finalize path delegate to it. The reviewer MUST run in a
 * different process / sandbox / context than the agent that
 * produced the result capsule, so the producer's assertions
 * cannot influence the verdict.
 *
 * In M2 the reviewer is a separate process boundary via
 * OgraCore.effectStatusList + a worker queue. For tests the
 * boundary is enforced by injecting a fake reviewer into the
 * IngressReviewService constructor.
 */
export interface IngressReviewDecisionInput {
  effectId: string;
  runId: string;
  workspaceId: string;
  /** Authoritative receipt id (used to open the result capsule). */
  receiptId: string;
  attemptNo: number;
  /** The verified result capsule payload hash (already computed by the agent / recovery). */
  payloadDigest: string;
  /** Reviewer's caller identity — 'agent' (production) or 'recovery' (restart finalize). */
  source: 'agent' | 'recovery';
}

export interface IngressReviewDecision {
  outcome: IngressOutcome;
  reviewer: string;
  sanitizedReasonCode?: string;
  sanitizedReasonDetail?: string;
  structuredFindings?: StructuredIngressFinding[];
}

/** Structured detector evidence. `evidence` is a fixed redaction marker; the
 * verifier keeps the evidence hash, never the matched plaintext. */
export interface StructuredIngressFinding {
  patternId: string;
  evidence: '[redacted]';
  evidenceHash: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  layer: 'result_payload';
}

export interface IngressReviewInput {
  effectId: string;
  /** Outcome the reviewer chose. */
  outcome: IngressOutcome;
  /** Reviewer identity (display name / user id; not a secret). */
  reviewer: string;
  /** Reason code for quarantine / reject paths. */
  sanitizedReasonCode?: string;
  /** Sanitized detail (NO raw payload bytes, NO provider secrets). */
  sanitizedReasonDetail?: string;
  structuredFindings?: StructuredIngressFinding[];
  /**
   * Payload digest the reviewer is signing off on. MUST equal
   * sha256(canonicalJSON(verifiedCapsule.payload)). The service
   * recomputes this from the verified result capsule and
   * rejects mismatches — fail-closed.
   */
  reviewerPayloadDigest: string;
  /**
   * Active lease evidence. Caller MUST hold the recovery lease
   * at the supplied version. The service re-checks via
   * `assertActiveLease()`.
   */
  leaseHolderId: string;
  leaseVersion: number;
  /** Rule version baked into the finalization. */
  ruleVersion: string;
  /** asOf override (test-only). */
  asOf?: string;
}

export interface IngressReviewResult {
  effectId: string;
  findingId: string;
  reviewDecisionId: string;
  outcome: IngressOutcome;
  stateBefore: string;
  stateAfter: string;
  payloadDigest: string;
  outcomeEventId: string;
  sanitizedReasonCode?: string;
  sanitizedReasonDetail?: string;
}

export class IngressReviewService {
  constructor(
    private readonly odb: OgraDatabase,
    private readonly runtime: DurableRuntimeService,
    private readonly capsuleStore: EncryptedCapsuleStore,
  ) {}

  /**
   * Finalize ingress review for an effect that is currently in
   * `awaiting_callback_verification` (post-receipt, pre-commit).
   * Three valid outcomes:
   *   - accepted    → effect state = `committed`
   *   - quarantined → effect state = `quarantined` (terminal)
   *   - rejected    → effect state = `failed` (terminal; UI shows
   *                   as "rejected" via the audit edge
   *                   `rejected_ingress_outcome`)
   *
   * Returns the canonical L0 row ids (finding, review_decision)
   * plus the post-state. Throws on any fail-closed condition.
   */
  finalizeIngressDecision(input: IngressReviewInput): IngressReviewResult {
    if (!input.leaseHolderId || !input.leaseVersion || !input.ruleVersion) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'finalizeIngressDecision: lease holder/version/rule_version required');
    }

    const now = input.asOf ?? new Date().toISOString();
    const findingKind = (() => {
      switch (input.outcome) {
        case 'accepted': return 'accepted';
        case 'quarantined': return 'quarantined';
        case 'rejected': return 'rejected';
      }
    })();
    const stateAfter = (() => {
      switch (input.outcome) {
        case 'accepted': return 'committed';
        case 'quarantined': return 'quarantined';
        case 'rejected': return 'failed';
      }
    })();
    const eventType = `effect_${input.outcome}` as const;
    const eventTypeStr = eventType;
    const quarantinedAt = input.outcome === 'quarantined' ? now : null;
    const acceptAt = input.outcome === 'accepted' ? now : null;

    // Resolve run_id + workspace_id for the L1 event meta
    // BEFORE opening transactionalAppend (the runtime needs
    // them to find prev_hash + compute the correct sequence).
    // `run_effects` doesn't carry workspace_id directly, so
    // we JOIN to `agent_runs`.
    const effectMeta = this.odb.getDB().prepare(`
      SELECT e.run_id AS run_id, r.workspace_id AS workspace_id
        FROM run_effects e
        JOIN agent_runs r ON r.id = e.run_id
       WHERE e.id = ?
    `).get(input.effectId) as
      { run_id: string; workspace_id: string } | undefined;
    if (!effectMeta) {
      throw new OgraError(OgraErrorCode.EFFECT_NOT_FOUND,
        `finalizeIngressDecision: effect ${input.effectId} not found`);
    }

    // pre-generate ids so we can wire edges + L1 event + the
    // body return.
    const findingId = `find_${crypto.randomBytes(6).toString('hex')}`;
    const reviewDecisionId = `rdec_${crypto.randomBytes(6).toString('hex')}`;
    const edgeIngress = `edg_${crypto.randomBytes(6).toString('hex')}`;
    const edgeReview = `edg_${crypto.randomBytes(6).toString('hex')}`;
    const edgeRecovery = `edg_${crypto.randomBytes(6).toString('hex')}`;
    const recoveryDecisionId = `rdc_${crypto.randomBytes(6).toString('hex')}`;
    const quarantineId = `qtn_${crypto.randomBytes(6).toString('hex')}`;
    const incidentId = `inc_${crypto.randomBytes(6).toString('hex')}`;

    try {
      return this.runtime.transactionalAppend<IngressReviewResult>({
      meta: {
        runId: effectMeta.run_id, workspaceId: effectMeta.workspace_id,
        eventType: eventTypeStr,
        eventPayload: {
          effectId: input.effectId,
          outcome: input.outcome,
          reviewer: input.reviewer,
          findingId, reviewDecisionId, ruleVersion: input.ruleVersion,
        },
        effectId: input.effectId,
      },
      body: (outcomeEventId) => {
        // 1. Active lease CAS — re-check before doing anything.
        const leaseRow = this.odb.getDB().prepare(`
          SELECT 1 FROM recovery_leases WHERE run_id = (
            SELECT run_id FROM run_effects WHERE id = ?
          ) AND holder_id = ? AND lease_version = ?
            AND released_at IS NULL AND expires_at > ?
        `).get(input.effectId, input.leaseHolderId,
          input.leaseVersion, now);
        if (!leaseRow) {
          throw new OgraError(OgraErrorCode.LEASE_NOT_HELD,
            `finalizeIngressDecision: lease ${input.leaseHolderId} v${input.leaseVersion} is not actively held`);
        }

        // 2. Read effect (must be in received or
        //    awaiting_callback_verification). The runId +
        //    workspaceId were already resolved above to seed
        //    the L1 event meta; reuse them inside the body.
        const effect = { ...effectMeta, id: input.effectId } as any;
        const stateRow = (this.odb.getDB().prepare(
          `SELECT state, effect_revision, payload_fingerprint,
                  policy_version_hash, redaction_rule_version,
                  current_approval_id, scope_hash,
                  authoritative_receipt_id
             FROM run_effects WHERE id = ?`,
        ).get(input.effectId) as any) || {};
        Object.assign(effect, stateRow);
        if (effect.state !== 'received'
            && effect.state !== 'awaiting_callback_verification') {
          throw new OgraError(OgraErrorCode.EFFECT_INVALID_TRANSITION,
            `finalizeIngressDecision: effect ${input.effectId} state=${effect.state}; expected received or awaiting_callback_verification`);
        }
        const stateBefore = effect.state;

        // 3. Read AUTHORITATIVE receipt — effect.authoritative_receipt_id
        //    is the only accepted source. NEVER take "the latest
        //    receipt" (which could be a tampered replay).
        const authoritativeReceiptId = effect.authoritative_receipt_id as
          string | null | undefined;
        if (!authoritativeReceiptId) {
          throw new OgraError(OgraErrorCode.RECEIPT_NOT_FOUND,
            `finalizeIngressDecision: effect ${input.effectId} has no authoritative_receipt_id`);
        }
        const receipt = this.odb.getDB().prepare(
          `SELECT id, effect_id, attempt_no, application_status,
                  provider_status, receipt_hash, request_hash,
                  response_hash, request_id,
                  result_capsule_ref, result_capsule_hash,
                  result_capsule_format_version
             FROM effect_receipts WHERE id = ?`,
        ).get(authoritativeReceiptId) as
          { id: string; effect_id: string; attempt_no: number;
            application_status: string; provider_status: string;
            receipt_hash: string; request_hash: string;
            response_hash: string; request_id: string;
            result_capsule_ref: string | null;
            result_capsule_hash: string | null;
            result_capsule_format_version: string | null; } | undefined;
        if (!receipt) {
          throw new OgraError(OgraErrorCode.RECEIPT_NOT_FOUND,
            `finalizeIngressDecision: authoritative receipt ${authoritativeReceiptId} not found`);
        }
        // The authoritative receipt MUST have application_status='applied'
        // and provider_status='ok' — recovery-approval pre-conditions.
        if (receipt.application_status !== 'applied') {
          throw new OgraError(OgraErrorCode.RECEIPT_NOT_FOUND,
            `finalizeIngressDecision: authoritative receipt ${authoritativeReceiptId} application_status=${receipt.application_status}; expected 'applied'`);
        }
        // Provider adapters use different success vocabularies (`ok` for the
        // durable protocol and `applied` in older verified fixtures). The
        // authoritative guard is application_status plus the canonical
        // receipt/capsule tuple; reject only empty or explicit non-success
        // statuses rather than coupling ingress to a transport label.
        if (receipt.provider_status !== 'ok'
            && receipt.provider_status !== 'applied') {
          throw new OgraError(OgraErrorCode.RECEIPT_NOT_FOUND,
            `finalizeIngressDecision: authoritative receipt ${authoritativeReceiptId} provider_status=${receipt.provider_status}; expected a verified success status`);
        }
        // Verify receipt_hash matches the canonical payload hash.
        // If anything was tampered with the receipt row, fail closed.
        const expectedReceiptHash = crypto.createHash('sha256')
          .update(canonicalJSON({
            effectId: receipt.effect_id,
            attemptNo: receipt.attempt_no,
            requestHash: receipt.request_hash,
            responseHash: receipt.response_hash,
            applicationStatus: receipt.application_status,
            providerStatus: receipt.provider_status,
          })).digest('hex');
        if (receipt.receipt_hash !== expectedReceiptHash) {
          throw new OgraError(OgraErrorCode.RECEIPT_NOT_FOUND,
            `finalizeIngressDecision: authoritative receipt ${authoritativeReceiptId} receipt_hash mismatch; reject (fail-closed)`);
        }

        // 4. Strict open — validates ownership, format,
        //    stored-vs-verified hash. Any mismatch throws.
        const opened = this.capsuleStore.openResultForReceipt<unknown>({
          workspaceId: effect.workspace_id,
          effectId: receipt.effect_id,
          receiptId: receipt.id,
          attemptNo: receipt.attempt_no,
          resultCapsuleRef: receipt.result_capsule_ref,
          resultCapsuleHash: receipt.result_capsule_hash,
          resultCapsuleFormatVersion: receipt.result_capsule_format_version,
        });
        // 5. Compute digest and assert reviewer agreement.
        const computedDigest = crypto.createHash('sha256')
          .update(canonicalJSON(opened.payload)).digest('hex');
        if (computedDigest !== input.reviewerPayloadDigest) {
          throw new OgraError(OgraErrorCode.CAPSULE_INVALID,
            `finalizeIngressDecision: payload_digest mismatch (capsule=${computedDigest.slice(0, 12)}…, reviewer=${input.reviewerPayloadDigest.slice(0, 12)}…)`);
        }

        // 6. Append a NEW immutable ingress_findings row bound
        //    to the authoritative receipt. NEVER update an
        //    existing finding. The append-only invariant is
        //    what lets the audit chain prove the verdict was
        //    based on the exact receipt that authorized the
        //    callback. receipt_id is NOT NULL.
        const findingIdFinal = findingId;
        this.odb.getDB().prepare(`
          INSERT INTO ingress_findings
            (id, effect_id, receipt_id, finding_kind, detail,
             event_id, created_at)
          VALUES (?, ?, ?, ?, '', ?, ?)
        `).run(findingIdFinal, input.effectId, receipt.id,
          findingKind, outcomeEventId, now);

        // 7. INSERT ingress_review_decisions row — also bound
        //    to the authoritative receipt_id (via finding_id).
        this.odb.getDB().prepare(`
          INSERT INTO ingress_review_decisions
            (id, ingress_finding_id, receipt_id, effect_id, outcome,
             reviewer, reviewer_decision_at, payload_digest,
             sanitized_reason_code, sanitized_reason_detail,
             rule_version, structured_findings_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          reviewDecisionId, findingIdFinal, receipt.id, input.effectId,
          input.outcome, input.reviewer, now, computedDigest,
          input.sanitizedReasonCode ?? null,
          input.sanitizedReasonDetail ?? null,
          input.ruleVersion,
          input.structuredFindings ? canonicalJSON(input.structuredFindings) : null,
        );

        // The independent worker may emit several detector findings. Persist
        // only its fixed redaction marker plus hashes and closed-set fields.
        // A quarantine without a detector match still gets one synthetic
        // ledger finding so it can be isolated and audited.
        const reviewFindings = input.structuredFindings?.length
          ? input.structuredFindings
          : input.outcome === 'quarantined'
            ? [{
                patternId: 'ingress.review.quarantined', evidence: '[redacted]' as const,
                evidenceHash: computedDigest, severity: 'high' as const,
                layer: 'result_payload' as const,
              }]
            : [];
        const persistedFindingIds: string[] = [];
        for (const finding of reviewFindings) {
          const detectorFindingId = `irf_${crypto.randomBytes(6).toString('hex')}`;
          persistedFindingIds.push(detectorFindingId);
          this.odb.getDB().prepare(`
            INSERT INTO ingress_review_findings
              (id, run_id, effect_id, receipt_id, ingress_review_decision_id,
               source_kind, source_ref, pattern_id, layer, evidence,
               evidence_hash, severity, finding_class, ingress_mode,
               user_decision, created_at)
            VALUES (?, ?, ?, ?, ?, 'cloud_response', ?, ?, ?, '[redacted]',
                    ?, ?, ?, 'approve', 'pending', ?)
          `).run(
            detectorFindingId, effect.run_id, input.effectId, receipt.id,
            reviewDecisionId, receipt.id, finding.patternId, finding.layer,
            finding.evidenceHash, finding.severity,
            input.outcome === 'quarantined' ? 'suspicious' : 'clean', now,
          );
        }
        if (input.outcome === 'quarantined') {
          const detectorFindingId = persistedFindingIds[0];
          this.odb.getDB().prepare(`
            INSERT INTO quarantine_contents
              (id, run_id, ingress_finding_id, content_hash, summary,
               sealed_capsule_ref, classification, user_can_view, status,
               created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'untrusted', 0, 'quarantined', ?, ?)
          `).run(
            quarantineId, effect.run_id, detectorFindingId, computedDigest,
            input.sanitizedReasonCode ?? 'ingress_review_quarantined',
            receipt.result_capsule_ref, now, now,
          );
          this.odb.getDB().prepare(`
            INSERT INTO incidents
              (id, workspace_id, run_id, incident_type, severity, summary,
               evidence_event_ids_json, created_at)
            VALUES (?, ?, ?, 'ingress_quarantined', 'high', ?, ?, ?)
          `).run(
            incidentId, effect.workspace_id, effect.run_id,
            input.sanitizedReasonCode ?? 'ingress_review_quarantined',
            canonicalJSON([outcomeEventId]), now,
          );
        }

        // 8. UPDATE run_effects with effect_revision CAS.
        //    stmt.changes() MUST be 1; 0 means a CAS loser.
        //    This UPDATE is also the row that carries
        //    terminal_event_id (= the L1 outcome event we just
        //    wrote) so the M2 audit packet and the renderer's
        //    effect-state view both know which event closed the
        //    effect's terminal transition.
        const newRevision = (effect.effect_revision as number) + 1;
        const updateRes = this.odb.getDB().prepare(`
          UPDATE run_effects
            SET state = ?, effect_revision = ?, updated_at = ?,
                quarantined_review_id = ?,
                quarantined_at = ?,
                terminal_event_id = ?
          WHERE id = ? AND effect_revision = ?
        `).run(
          stateAfter, newRevision, now,
          input.outcome === 'quarantined' ? reviewDecisionId : null,
          quarantinedAt,
          outcomeEventId,
          input.effectId, effect.effect_revision,
        );
        if (updateRes.changes !== 1) {
          throw new OgraError(OgraErrorCode.REVISION_CONFLICT,
            `finalizeIngressDecision: effect ${input.effectId} revision CAS lost (expected ${effect.effect_revision}, got ${updateRes.changes} changes)`);
        }

        // 9. Append audit edges.
        this.odb.getDB().prepare(`
          INSERT INTO audit_edges
            (id, run_id, from_kind, from_id, relation, to_kind, to_id,
             source_event_id, created_at)
          VALUES (?, ?, 'effect', ?, 'has_ingress', 'ingress_finding', ?, ?, ?)
        `).run(edgeIngress, effect.run_id, input.effectId,
          findingIdFinal, outcomeEventId, now);
        this.odb.getDB().prepare(`
          INSERT INTO audit_edges
            (id, run_id, from_kind, from_id, relation, to_kind, to_id,
             source_event_id, created_at)
          VALUES (?, ?, 'effect', ?, 'ingress_outcome', 'ingress_review_decision', ?, ?, ?)
        `).run(edgeReview, effect.run_id, input.effectId,
          reviewDecisionId, outcomeEventId, now);

        // 10. recovery_decisions row (this IS a recovery finalization).
        this.odb.getDB().prepare(`
          INSERT INTO recovery_decisions
            (id, run_id, effect_id, lease_holder_id, lease_version,
             state_before, final_state, decision_code, incident_kind,
             detail, payload_digest, rule_version, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          recoveryDecisionId, effect.run_id, input.effectId,
          input.leaseHolderId, input.leaseVersion,
          stateBefore, stateAfter, `ingress_${input.outcome}`,
          null,
          input.sanitizedReasonCode ?? input.sanitizedReasonDetail ?? null,
          computedDigest, input.ruleVersion, now,
        );
        // edge to recovery_decisions (use v30-extended kind)
        this.odb.getDB().prepare(`
          INSERT INTO audit_edges
            (id, run_id, from_kind, from_id, relation, to_kind, to_id,
             source_event_id, created_at)
          VALUES (?, ?, 'effect', ?, 'ingress_outcome', 'recovery_decision', ?, ?, ?)
        `).run(edgeRecovery, effect.run_id, input.effectId,
          recoveryDecisionId, outcomeEventId, now);

        return {
          effectId: input.effectId,
          findingId: findingIdFinal,
          reviewDecisionId,
          outcome: input.outcome,
          stateBefore,
          stateAfter,
          payloadDigest: computedDigest,
          outcomeEventId,
        };
      },
      });
    } catch (err) {
      // The finalization transaction rightly rolls back on any capsule
      // failure. Persist the incident only after that rollback, otherwise it
      // would disappear with the failed L0/L1 mutation.
      const message = (err as Error)?.message ?? '';
      const code = (err as { code?: string })?.code;
      if (code === OgraErrorCode.CAPSULE_INVALID
          || code === OgraErrorCode.CAPSULE_EXPIRED
          || message.includes('capsule')) {
        const lower = message.toLowerCase();
        const failureKind = code === OgraErrorCode.CAPSULE_EXPIRED
          || lower.includes('expired') ? 'expired'
          : lower.includes('not found') || lower.includes('missing') ? 'missing'
          : lower.includes('hash') ? 'hash_mismatch'
          : lower.includes('workspace') ? 'wrong_workspace'
          : 'decrypt_failed';
        try {
          this.capsuleStore.recordFailure({
            effectId: input.effectId,
            runId: effectMeta.run_id,
            capsuleRef: '(authoritative-result)',
            attemptNo: 0,
            failureKind,
            detail: 'result capsule verification failed during ingress review',
          });
        } catch {
          // The original evidence failure remains authoritative.
        }
      }
      throw err;
    }
  }
}
