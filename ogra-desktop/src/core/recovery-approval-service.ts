/**
 * Series 1B Milestone 2 — RecoveryApprovalService.
 *
 * Each `unknown -> in_flight` retry must mint a new
 * recovery_approval row. The prepare-time approval is marked
 * `revoked_for_recovery = 1` so any further use fails closed.
 *
 * The recovery_approval is bound to:
 *   - (effect_id, recovery_attempt) UNIQUE
 *   - current policy_version_hash captured at recovery time
 *   - current redaction_rule_version captured at recovery time
 *   - scope_hash (if known)
 *   - payload_fingerprint (= sha256(canonicalJSON(sealedPayload)))
 *
 * The mint path runs the entire finalize inside the runtime's
 * `transactionalAppend` so the L1 event is written with the
 * correct v2 envelope hash + sequence + previous_hash, the
 * audit edges + recovery_decisions row land in the same
 * transaction, and stmt.changes() verifies the effect revision
 * CAS loser path.
 */
import * as crypto from 'crypto';
import { OgraDatabase } from './database';
import { DurableRuntimeService } from './durable-runtime-service';
import { OgraError, OgraErrorCode } from '../shared/errors';

export interface MintRecoveryApprovalInput {
  effectId: string;
  recoveryAttempt: number;
  /** Canonical user/Core-approved recovery_retry approval. */
  approvedRecoveryApprovalId: string;
  /** Reviewer / operator who minted the recovery approval. */
  decidedBy: string;
  /** Reason for retry (sanitized — NO raw payload bytes). */
  reason?: string;
  /** Optional expiry (ISO). */
  expiresAt?: string;
  /** Active lease evidence. */
  leaseHolderId: string;
  leaseVersion: number;
  /** asOf override (test-only). */
  asOf?: string;
}

export interface MintRecoveryApprovalResult {
  recoveryApprovalId: string;
  revokedPrepareApprovalId: string | null;
  recoveryAttempt: number;
  outcomeEventId: string;
}

export class RecoveryApprovalService {
  constructor(
    private readonly odb: OgraDatabase,
    private readonly runtime: DurableRuntimeService,
  ) {}

  /**
   * Mint a recovery approval. Marks the prepare-time approval
   * (if any) as `revoked_for_recovery = 1` so subsequent uses
   * fail closed.
   */
  mintRecoveryApproval(
    input: MintRecoveryApprovalInput,
  ): MintRecoveryApprovalResult {
    if (!input.approvedRecoveryApprovalId) {
      throw new OgraError(OgraErrorCode.APPROVAL_REQUIRED,
        'mintRecoveryApproval requires an approved recovery_retry approval');
    }
    const now = input.asOf ?? new Date().toISOString();
    const recoveryApprovalId = `rap_${crypto.randomBytes(6).toString('hex')}`;
    const edgeId = `edg_${crypto.randomBytes(6).toString('hex')}`;
    const recoveryDecisionId = `rdc_${crypto.randomBytes(6).toString('hex')}`;
    const edgeRecoveryDecision = `edg_${crypto.randomBytes(6).toString('hex')}`;

    // Resolve effect's run_id + workspace_id for the L1
    // event meta BEFORE opening transactionalAppend.
    // `run_effects` doesn't carry workspace_id directly.
    const effectMeta = this.odb.getDB().prepare(`
      SELECT e.run_id AS run_id, r.workspace_id AS workspace_id
        FROM run_effects e
        JOIN agent_runs r ON r.id = e.run_id
       WHERE e.id = ?
    `).get(input.effectId) as
      { run_id: string; workspace_id: string } | undefined;
    if (!effectMeta) {
      throw new OgraError(OgraErrorCode.EFFECT_NOT_FOUND,
        `mintRecoveryApproval: effect ${input.effectId} not found`);
    }

    return this.runtime.transactionalAppend<MintRecoveryApprovalResult>({
      meta: {
        runId: effectMeta.run_id, workspaceId: effectMeta.workspace_id,
        eventType: 'effect_recovery_approval_minted',
        eventPayload: {
          effectId: input.effectId,
          recoveryApprovalId,
          recoveryAttempt: input.recoveryAttempt,
          decidedBy: input.decidedBy,
          ruleVersion: 'm2',
        },
      },
      body: (outcomeEventId) => {
        // 1. Active lease CAS.
        const leaseRow = this.odb.getDB().prepare(`
          SELECT 1 FROM recovery_leases WHERE run_id = (
            SELECT run_id FROM run_effects WHERE id = ?
          ) AND holder_id = ? AND lease_version = ?
            AND released_at IS NULL AND expires_at > ?
        `).get(input.effectId, input.leaseHolderId, input.leaseVersion, now);
        if (!leaseRow) {
          throw new OgraError(OgraErrorCode.LEASE_NOT_HELD,
            `mintRecoveryApproval: lease ${input.leaseHolderId} v${input.leaseVersion} is not actively held`);
        }

        // 2. Effect lookup (run_effects has no workspace_id; we
        // JOIN to agent_runs to resolve it for the
        // recovery_approvals INSERT below).
        const effect = this.odb.getDB().prepare(`
          SELECT e.id AS id, e.run_id AS run_id,
                 r.workspace_id AS workspace_id,
                 e.current_approval_id, e.policy_version_hash,
                 e.scope_hash, e.payload_fingerprint,
                 e.redaction_rule_version, e.effect_revision, e.state
            FROM run_effects e
            JOIN agent_runs r ON r.id = e.run_id
           WHERE e.id = ?
        `).get(input.effectId) as any;
        if (!effect) {
          throw new OgraError(OgraErrorCode.EFFECT_NOT_FOUND,
            `mintRecoveryApproval: effect ${input.effectId} not found`);
        }
        // A caller identity and lease are never an approval authority. The
        // legacy rap_* ledger may only mirror an already-approved, exact
        // standard recovery_retry approval created by OgraCore.
        const approved = this.odb.getDB().prepare(`
          SELECT id FROM approvals
           WHERE id = ? AND run_id = ? AND workspace_id = ?
             AND effect_id = ? AND effect_revision = ?
             AND approval_type = 'recovery_retry' AND decision = 'approved'
             AND uses_consumed < use_limit
             AND (expires_at IS NULL OR expires_at > ?)
             AND payload_fingerprint = ? AND policy_version_hash = ?
             AND (scope_hash IS ? OR scope_hash = ?)
        `).get(
          input.approvedRecoveryApprovalId, effect.run_id, effect.workspace_id,
          effect.id, effect.effect_revision, now,
          effect.payload_fingerprint ?? '', effect.policy_version_hash ?? '',
          effect.scope_hash ?? null, effect.scope_hash ?? null,
        ) as { id: string } | undefined;
        if (!approved) {
          throw new OgraError(OgraErrorCode.APPROVAL_REQUIRED,
            'mintRecoveryApproval requires an approved, current effect-bound recovery_retry approval');
        }
        if (effect.current_approval_id) {
          const apRow = this.odb.getDB().prepare(
            `SELECT revoked_for_recovery FROM approvals WHERE id = ?`,
          ).get(effect.current_approval_id) as
            { revoked_for_recovery: number } | undefined;
          if (apRow?.revoked_for_recovery) {
            throw new OgraError(OgraErrorCode.APPROVAL_REVOKED,
              `mintRecoveryApproval: prepare-time approval ${effect.current_approval_id} already revoked for recovery`);
          }
        }

        // 3. INSERT recovery_approval (UNIQUE on effect_id +
        //    recovery_attempt so re-mint fails closed).
        try {
          this.odb.getDB().prepare(`
            INSERT INTO recovery_approvals
              (id, effect_id, run_id, recovery_attempt, workspace_id,
               policy_version_hash, redaction_rule_version, scope_hash,
               payload_fingerprint, decided_by, reason, expires_at,
               use_limit, uses_consumed, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)
          `).run(
            recoveryApprovalId, input.effectId, effect.run_id, input.recoveryAttempt,
            effect.workspace_id,
            effect.policy_version_hash ?? '',
            effect.redaction_rule_version ?? '',
            effect.scope_hash ?? null,
            effect.payload_fingerprint ?? '',
            input.decidedBy, input.reason ?? null, input.expiresAt ?? null,
            now,
          );
        } catch (err) {
          const msg = (err as Error)?.message ?? '';
          if (msg.includes('UNIQUE')) {
            throw new OgraError(OgraErrorCode.APPROVAL_REVOKED,
              `mintRecoveryApproval: recovery_approval already exists for effect ${input.effectId} attempt=${input.recoveryAttempt}`);
          }
          throw err;
        }

        // 4. Mark prepare-time approval revoked_for_recovery.
        let revokedId: string | null = null;
        if (effect.current_approval_id) {
          const upRes = this.odb.getDB().prepare(`
            UPDATE approvals SET revoked_for_recovery = 1,
              revoked_for_recovery_at = ?
              WHERE id = ?
          `).run(now, effect.current_approval_id);
          if (upRes.changes !== 1) {
            throw new OgraError(OgraErrorCode.REVISION_CONFLICT,
              `mintRecoveryApproval: prepare-time approval ${effect.current_approval_id} revoke CAS lost (changes=${upRes.changes})`);
          }
          revokedId = effect.current_approval_id;
        }

        // 5. Audit edge: effect -> recovery_approval.
        this.odb.getDB().prepare(`
          INSERT INTO audit_edges
            (id, run_id, from_kind, from_id, relation, to_kind, to_id,
             source_event_id, created_at)
          VALUES (?, ?, 'effect', ?, 'has_recovery_approval', 'recovery_approval', ?, ?, ?)
        `).run(edgeId, effect.run_id, input.effectId,
          recoveryApprovalId, outcomeEventId, now);

        // 6. recovery_decisions row + audit edge.
        this.odb.getDB().prepare(`
          INSERT INTO recovery_decisions
            (id, run_id, effect_id, lease_holder_id, lease_version,
             state_before, final_state, decision_code, incident_kind,
             detail, payload_digest, rule_version, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          recoveryDecisionId, effect.run_id, input.effectId,
          input.leaseHolderId, input.leaseVersion,
          effect.state ?? 'unknown', effect.state ?? 'unknown',
          'recovery_approval_minted', null,
          input.reason ?? null,
          effect.payload_fingerprint ?? null,
          'm2', now,
        );
        this.odb.getDB().prepare(`
          INSERT INTO audit_edges
            (id, run_id, from_kind, from_id, relation, to_kind, to_id,
             source_event_id, created_at)
          VALUES (?, ?, 'effect', ?, 'recovery_approval_minted', 'recovery_decision', ?, ?, ?)
        `).run(edgeRecoveryDecision, effect.run_id, input.effectId,
          recoveryDecisionId, outcomeEventId, now);

        return {
          recoveryApprovalId,
          revokedPrepareApprovalId: revokedId,
          recoveryAttempt: input.recoveryAttempt,
          outcomeEventId,
        };
      },
    });
  }

  /**
   * Read the latest recovery approval row for an effect, if any.
   * Returns null when no recovery approval has been minted yet.
   */
  latestFor(effectId: string): {
    id: string;
    recoveryAttempt: number;
    policyVersionHash: string;
    redactionRuleVersion: string;
    scopeHash: string | null;
    payloadFingerprint: string;
    decidedBy: string;
    reason: string | null;
    expiresAt: string | null;
    usesConsumed: number;
  } | null {
    const row = this.odb.getDB().prepare(`
      SELECT id, recovery_attempt, policy_version_hash,
             redaction_rule_version, scope_hash, payload_fingerprint,
             decided_by, reason, expires_at, uses_consumed
        FROM recovery_approvals
        WHERE effect_id = ?
        ORDER BY recovery_attempt DESC
        LIMIT 1
    `).get(effectId) as any;
    if (!row) return null;
    return {
      id: row.id,
      recoveryAttempt: row.recovery_attempt,
      policyVersionHash: row.policy_version_hash,
      redactionRuleVersion: row.redaction_rule_version,
      scopeHash: row.scope_hash ?? null,
      payloadFingerprint: row.payload_fingerprint,
      decidedBy: row.decided_by,
      reason: row.reason ?? null,
      expiresAt: row.expires_at ?? null,
      usesConsumed: row.uses_consumed,
    };
  }
}
