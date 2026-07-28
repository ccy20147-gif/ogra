/**
 * Series 1B Milestone 2 — UI status badges.
 *
 * A pure, deterministic renderer for effect/frame state. NEVER
 * accepts raw payload bytes — only refs/hashes/state names.
 *
 * Closed-set sanitizer (M2 P0 #6):
 *   - `state` must be one of the canonical `EffectStateBadge`
 *     values; anything else renders as `unknown_placeholder`
 *     so an attacker cannot smuggle arbitrary strings into
 *     the DOM via a forged state field.
 *   - `sanitizedReasonCode` is matched against a closed-set of
 *     allowed reason codes. Unknown codes are replaced with
 *     `invalid_sanitized_code`; raw text is NEVER passed to
 *     the renderer. The reason code length is also bounded
 *     to 64 chars as defense-in-depth against label stretching
 *     attacks.
 *   - `decisionCode` (recovery decisions) goes through the
 *     same closed-set.
 *
 * These checks run in the renderer (defense-in-depth). The
 * canonical state comes from `OgraCore.effectStatusList`,
 * which is itself backed by SQL.
 */

import React from 'react';

export type EffectStateBadge =
  | 'planned'
  | 'in_flight'
  | 'awaiting_callback_verification'
  | 'received'
  | 'unknown'
  | 'interrupted'
  | 'committed'
  | 'quarantined'
  | 'failed'
  | 'cancelled_before_send'
  | 'compensating'
  | 'compensated';

const BADGE_COLOR: Record<EffectStateBadge, { bg: string; fg: string; label: string }> = {
  planned: { bg: '#e0e7ff', fg: '#1e1b4b', label: 'planned' },
  in_flight: { bg: '#fef3c7', fg: '#78350f', label: 'in_flight' },
  awaiting_callback_verification: { bg: '#fde68a', fg: '#78350f', label: 'awaiting verification' },
  received: { bg: '#e0e7ff', fg: '#3730a3', label: 'received' },
  unknown: { bg: '#fecaca', fg: '#7f1d1d', label: 'unknown' },
  interrupted: { bg: '#fed7aa', fg: '#7c2d12', label: 'interrupted' },
  committed: { bg: '#bbf7d0', fg: '#14532d', label: 'committed' },
  quarantined: { bg: '#fde68a', fg: '#92400e', label: 'quarantined' },
  failed: { bg: '#fecaca', fg: '#7f1d1d', label: 'failed' },
  cancelled_before_send: { bg: '#e5e7eb', fg: '#1f2937', label: 'cancelled' },
  compensating: { bg: '#fde68a', fg: '#92400e', label: 'compensating' },
  compensated: { bg: '#bbf7d0', fg: '#14532d', label: 'compensated' },
};

/**
 * Closed-set of allowed sanitized reason codes. Anything
 * outside this set is replaced with `invalid_sanitized_code`.
 */
const ALLOWED_REASON_CODES: ReadonlySet<string> = new Set([
  'awaiting_user_action',
  'awaiting_recovery_approval',
  'awaiting_redaction_evidence',
  'awaiting_policy_reevaluation',
  'no_anomalies_detected',
  'recovery_replay_validated',
  'policy_drift_detected',
  'route_drift_detected',
  'redaction_rule_drift',
  'approval_policy_mismatch',
  'approval_scope_mismatch',
  'approval_fingerprint_mismatch',
  'approval_missing',
  'approval_expired',
  'approval_revoked',
  'capsule_payload_mismatch',
  'capsule_corrupt',
  'capsule_expired',
  'capsule_missing',
  'capsule_format_mismatch',
  'capsule_hash_mismatch',
  'payload_digest_empty',
  'prompt_injection_detected',
  'receipt_binding_invalid',
  'capsule_invalid',
  'lease_not_held',
  'revision_conflict',
  'no_idempotency',
  'outcome_unknown',
  'route_policy_drift',
  'route_decision_missing',
  'redaction_evidence_missing',
  'invalid_sanitized_code',
]);

/**
 * Closed-set of allowed recovery decision codes.
 */
const ALLOWED_DECISION_CODES: ReadonlySet<string> = new Set([
  'ingress_accepted',
  'ingress_quarantined',
  'ingress_rejected',
  'recovery_approval_minted',
  'committed',
  'noop_already_terminal',
  'controlled_retry',
  'incident_blocked',
  'invalid_sanitized_code',
]);

export interface EffectStateBadgeProps {
  state: string;
  /** Optional reason code (sanitized) shown in title tooltip. */
  sanitizedReasonCode?: string | null;
  /** Whether the effect is awaiting an approval row. */
  awaitingApproval?: boolean;
}

/**
 * Closed-set sanitizer: only allow canonical state values.
 * Anything else renders as `unknown_placeholder` so an
 * attacker cannot smuggle arbitrary strings into the DOM
 * via a forged state field.
 */
function pickStatePalette(rawState: string): {
  bg: string; fg: string; label: string; valid: boolean;
} {
  if (Object.prototype.hasOwnProperty.call(BADGE_COLOR, rawState)) {
    return { ...BADGE_COLOR[rawState as EffectStateBadge], valid: true };
  }
  return {
    bg: '#e5e7eb', fg: '#1f2937', label: 'unknown_placeholder', valid: false,
  };
}

function pickReasonCode(rawCode: string | null | undefined): string {
  if (!rawCode) return '';
  if (ALLOWED_REASON_CODES.has(rawCode)) return rawCode;
  return 'invalid_sanitized_code';
}

/**
 * Tiny pill showing an effect's state with optional overlaid
 * "awaiting approval" subbadge. Pure render — no raw payload.
 * The closed-set sanitizer (see header) rejects unknown state
 * values.
 */
export const EffectStateBadge: React.FC<EffectStateBadgeProps> = ({
  state, sanitizedReasonCode, awaitingApproval,
}) => {
  const palette = pickStatePalette(state);
  const reasonCode = pickReasonCode(sanitizedReasonCode);
  const tooltip = reasonCode
    ? `${palette.label} — ${reasonCode}`
    : palette.label;
  // `awaitingApproval` is a boolean — no injection risk.
  const awaiting = Boolean(awaitingApproval);
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      <span
        title={tooltip}
        style={{
          background: palette.bg,
          color: palette.fg,
          padding: '2px 8px',
          borderRadius: 8,
          fontSize: 11,
          fontFamily: 'monospace',
        }}>
        {palette.label}
      </span>
      {awaiting && (
        <span
          title="awaiting approval"
          style={{
            background: '#fde68a',
            color: '#78350f',
            padding: '2px 8px',
            borderRadius: 8,
            fontSize: 11,
            fontFamily: 'monospace',
          }}>
          awaiting approval
        </span>
      )}
    </span>
  );
};

/**
 * Recovery decision code pill. NEVER renders raw payload bytes.
 * decisionCode goes through the closed-set ALLOWED_DECISION_CODES.
 * It intentionally renders no free-text detail. Audit/UI consumers must use
 * stable reason and decision codes, never a producer-controlled summary.
 */
export interface RecoveryDecisionBadgeProps {
  decisionCode: string;
  sanitizedReason?: string | null;
}

function pickDecisionCode(rawCode: string): string {
  if (ALLOWED_DECISION_CODES.has(rawCode)) return rawCode;
  return 'invalid_sanitized_code';
}

export const RecoveryDecisionBadge: React.FC<RecoveryDecisionBadgeProps> = ({
  decisionCode,
}) => {
  const safeCode = pickDecisionCode(decisionCode);
  return (
    <span
      title={safeCode}
      style={{
        background: '#e0e7ff',
        color: '#1e1b4b',
        padding: '2px 8px',
        borderRadius: 8,
        fontSize: 11,
        fontFamily: 'monospace',
      }}>
      recovery: {safeCode}
    </span>
  );
};

/**
 * Exposed for unit tests. The sanitizer functions are
 * pure and never accept raw payload bytes.
 */
export const __sanitizer = {
  pickStatePalette,
  pickReasonCode,
  pickDecisionCode,
  ALLOWED_REASON_CODES,
  ALLOWED_DECISION_CODES,
};
