/**
 * Sequence 1A Milestone 0 — versioned canonical envelope hash for
 * run_events (plan 02 §3.3 + plan 10 §6).
 *
 * Legacy v1 envelopes (the existing Sequence 0 audit chain) hash
 * `canonicalJSON(event_payload) + previous_hash` only — that is
 * INSUFFICIENT to detect tampering of non-payload envelope fields
 * (id, run_id, workspace_id, sequence, event_type, policy_version,
 * redaction_version, created_at, previous_hash, hash_envelope_version
 * itself). Plan 02 requires new events to use the v2 canonical
 * envelope:
 *
 *   envelope_v2_hash = sha256(
 *     id, run_id, workspace_id, sequence, event_type,
 *     payload_hash, policy_version_hash, redaction_rule_version,
 *     created_at, previous_hash, hash_envelope_version
 *   )
 *
 * with canonical JSON (deterministic key ordering) and a documented
 * GENESIS_HASH constant for the first event of a run.
 *
 * The verifier MUST:
 * - select the algorithm by hash_envelope_version
 * - verify legacy v1 chains exactly as they were written
 * - detect tampering of ANY non-payload field on v2 rows
 * - report rather than silently rewrite a legacy chain
 */

import * as crypto from 'crypto';

export const GENESIS_HASH = '0'.repeat(64);
export const HASH_ENVELOPE_VERSION_V1 = 'v1';
export const HASH_ENVELOPE_VERSION_V2 = 'v2';

/** Deterministic canonical JSON: sorted keys at every level. */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortKeys(obj[key]);
    }
    return out;
  }
  return value;
}

/** v1 legacy hash: payload_json + previous_hash only. */
export function envelopeV1Hash(payloadJson: string, previousHash: string): string {
  return crypto.createHash('sha256')
    .update(payloadJson + previousHash)
    .digest('hex');
}

/**
 * v2 canonical envelope hash: covers ALL non-payload envelope
 * fields plus the envelope version itself. Order of fields in the
 * canonical input is fixed (see plan 02 §3.3).
 */
export function envelopeV2Hash(input: {
  id: string;
  runId: string;
  workspaceId: string | null;
  sequence: number;
  eventType: string;
  /** The raw canonicalized JSON of the event payload (NOT a hash
   *  of it). Including the full payload in the envelope hash
   *  makes tampering with event_payload_json itself detectable. */
  eventPayloadJson: string;
  payloadHash: string | null;
  policyVersionHash: string | null;
  redactionRuleVersion: string | null;
  createdAt: string;
  previousHash: string;
}): string {
  const ordered = {
    hash_envelope_version: HASH_ENVELOPE_VERSION_V2,
    id: input.id,
    run_id: input.runId,
    workspace_id: input.workspaceId ?? '',
    sequence: input.sequence,
    event_type: input.eventType,
    event_payload_json: input.eventPayloadJson,
    payload_hash: input.payloadHash ?? '',
    policy_version_hash: input.policyVersionHash ?? '',
    redaction_rule_version: input.redactionRuleVersion ?? '',
    created_at: input.createdAt,
    previous_hash: input.previousHash,
  };
  return crypto.createHash('sha256')
    .update(canonicalJSON(ordered))
    .digest('hex');
}

/** Stable payload hash (sha256 of canonical JSON). */
export function payloadHash(payload: unknown): string {
  return crypto.createHash('sha256')
    .update(canonicalJSON(payload))
    .digest('hex');
}

export interface AuditEnvelopeV2Input {
  id: string;
  runId: string;
  workspaceId: string | null;
  sequence: number;
  eventType: string;
  eventPayload: unknown;
  policyVersionHash?: string | null;
  redactionRuleVersion?: string | null;
  createdAt?: string;
  previousHash: string;
}

/**
 * Compose the v2 envelope — returns the canonical envelope hash
 * plus the payload_hash and event_payload_json that the producer
 * must persist together.
 */
export function composeV2Envelope(input: AuditEnvelopeV2Input): {
  envelopeVersion: string;
  eventHash: string;
  payloadHash: string;
  eventPayloadJson: string;
} {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const eventPayloadJson = canonicalJSON(input.eventPayload);
  const ph = crypto.createHash('sha256').update(eventPayloadJson).digest('hex');
  const eventHash = envelopeV2Hash({
    id: input.id,
    runId: input.runId,
    workspaceId: input.workspaceId,
    sequence: input.sequence,
    eventType: input.eventType,
    eventPayloadJson: eventPayloadJson,
    payloadHash: ph,
    policyVersionHash: input.policyVersionHash ?? null,
    redactionRuleVersion: input.redactionRuleVersion ?? null,
    createdAt,
    previousHash: input.previousHash,
  });
  return {
    envelopeVersion: HASH_ENVELOPE_VERSION_V2,
    eventHash,
    payloadHash: ph,
    eventPayloadJson,
  };
}