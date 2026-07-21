/**
 * Sequence 1B Milestone 1 — Recovery Audit Packet Service.
 *
 * Read-only, bounded, local query that emits the full L0 state
 * + L1 audit-chain evidence for a run. NEVER returns:
 *   - raw idempotency keys
 *   - secret material
 *   - full callback payloads
 *   - full result bodies
 *   - hidden chain-of-thought
 *
 * Only refs / hashes / versions / event ids / lineage are
 * returned. Capsules are referenced by ref + hash + format
 * version; callers needing the raw payload must use
 * CapsuleStore.open() (which still fail-closes on workspace
 * mismatch, expiry, hash drift).
 */

import { OgraDatabase } from './database';
import { RecoveryReport } from './recovery-service';
import * as crypto from 'crypto';

export interface AuditFrame {
  id: string;
  runId: string;
  parentFrameId: string | null;
  runStepId: string | null;
  frameKind: string;
  status: string;
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

export interface AuditEffect {
  id: string;
  runId: string;
  ownerFrameId: string;
  effectType: string;
  adapterKind: string;
  payloadFingerprint: string;
  callbackCapsuleRef: string | null;
  callbackCapsuleHash: string | null;
  callbackCapsuleFormatVersion: string | null;
  idempotencyKeyHash: string | null;
  state: string;
  effectRevision: number;
  routeDecisionId: string | null;
  policyEvaluationId: string | null;
  authoritativeReceiptId: string | null;
  externalReceiptHash: string | null;
  ingressFindingId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditReceipt {
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
  applicationStatus: string;
  receiptHash: string;
  receivedAt: string;
  eventId: string | null;
}

export interface AuditCapsuleRef {
  ref: string;
  hash: string;
  formatVersion: string;
  capsuleKind: 'callback' | 'result';
  effectId: string | null;
  receiptId: string | null;
  attemptNo: number;
  adapterKind: string | null;
  payloadFingerprint: string | null;
  scopeHash: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  runId: string;
  workspaceId: string | null;
  sequence: number;
  eventType: string;
  /**
   * Sanitized payload summary — NEVER the raw payload body.
   * Includes only:
   *   - `kind`: a canonical label that classifies the event
   *     ('structural' = frame/effect state; 'payload' =
   *     user-derived, see `payloadDigest` for content)
   *   - `keyCount`: count of payload keys (informational; may
   *     indirectly characterise payload shape)
   *   - `payloadDigest`: a sha256 of the canonical payload
   *     body — this lets a verifier cross-reference the
   *     payload WITHOUT exposing its contents. The full
   *     payload body MUST be retrieved via the trusted
   *     audit-chain re-export, which is gated by separate
   *     policy.
   *   - `hasSensitiveFields`: true iff any payload key is in
   *     a sentinel list of sensitive field names (task, query,
   *     promptParts, response.text, etc.). The raw values are
   *     NEVER returned.
   */
  payloadDigest: string;
  payloadKeyCount: number;
  payloadKind: 'structural' | 'policy' | 'redaction' | 'model';
  hasSensitiveFields: boolean;
  previousHash: string;
  eventHash: string;
  hashEnvelopeVersion: string | null;
  policyVersionHash: string | null;
  redactionRuleVersion: string | null;
  frameId: string | null;
  effectId: string | null;
  repairTransactionId: string | null;
  idempotencyKeyHash: string | null;
  externalReceiptHash: string | null;
  createdAt: string;
}

export interface AuditLease {
  runId: string;
  holderId: string;
  leaseVersion: number;
  acquiredAt: string;
  expiresAt: string;
  renewedAt: string;
  releasedAt: string | null;
}

export interface AuditEdgeEntry {
  fromKind: string;
  fromId: string;
  relation: string;
  toKind: string;
  toId: string;
  sourceEventId: string | null;
  createdAt: string;
}

export interface RecoveryAuditPacket {
  runId: string;
  generatedAt: string;
  frameLineage: {
    frames: AuditFrame[];
    effects: AuditEffect[];
    receipts: AuditReceipt[];
    capsules: AuditCapsuleRef[];
    lease: AuditLease | null;
    auditEdges: AuditEdgeEntry[];
    events: AuditEvent[];
    lastRecoveryReport: RecoveryReport | null;
  };
}

const RECOVERY_REPORT_EVENT = 'recovery_audit';

export class RecoveryAuditPacketService {
  constructor(private readonly odb: OgraDatabase) {}

  /** Build the full bounded packet for a run. */
  build(runId: string): RecoveryAuditPacket {
    const frames = this.queryFrames(runId);
    const effects = this.queryEffects(runId);
    const receipts = this.queryReceipts(runId);
    const capsules = this.queryCapsules(runId);
    const lease = this.queryLease(runId);
    const auditEdges = this.queryAuditEdges(runId);
    const events = this.queryEvents(runId);
    const lastRecoveryReport = this.queryLastRecoveryReport(runId);
    return {
      runId,
      generatedAt: new Date().toISOString(),
      frameLineage: {
        frames, effects, receipts, capsules, lease, auditEdges, events,
        lastRecoveryReport,
      },
    };
  }

  /* ============================================================
   * Query helpers — all read-only, no decrypt, no payload body
   * ============================================================ */

  private queryFrames(runId: string): AuditFrame[] {
    const rows = this.odb.getDB().prepare(
      'SELECT * FROM run_frames WHERE run_id = ? ORDER BY id ASC',
    ).all(runId) as any[];
    return rows.map(r => ({
      id: r.id,
      runId: r.run_id,
      parentFrameId: r.parent_frame_id ?? null,
      runStepId: r.run_step_id ?? null,
      frameKind: r.frame_kind,
      status: r.status,
      path: JSON.parse(r.path_json ?? '[]'),
      nodeRevision: r.node_revision,
      subtreeRevision: r.subtree_revision,
      inputHash: r.input_hash ?? null,
      outputHash: r.output_hash ?? null,
      createdEventId: r.created_event_id ?? null,
      terminalEventId: r.terminal_event_id ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  private queryEffects(runId: string): AuditEffect[] {
    const rows = this.odb.getDB().prepare(
      'SELECT * FROM run_effects WHERE run_id = ? ORDER BY id ASC',
    ).all(runId) as any[];
    return rows.map(r => ({
      id: r.id, runId: r.run_id, ownerFrameId: r.owner_frame_id,
      effectType: r.effect_type, adapterKind: r.adapter_kind,
      payloadFingerprint: r.payload_fingerprint,
      callbackCapsuleRef: r.callback_capsule_ref ?? null,
      callbackCapsuleHash: r.callback_capsule_hash ?? null,
      callbackCapsuleFormatVersion: r.callback_capsule_format_version ?? null,
      idempotencyKeyHash: r.idempotency_key_hash ?? null,
      state: r.state, effectRevision: r.effect_revision,
      routeDecisionId: r.route_decision_id ?? null,
      policyEvaluationId: r.policy_evaluation_id ?? null,
      authoritativeReceiptId: r.authoritative_receipt_id ?? null,
      externalReceiptHash: r.external_receipt_hash ?? null,
      ingressFindingId: r.ingress_finding_id ?? null,
      createdAt: r.created_at, updatedAt: r.updated_at,
    }));
  }

  private queryReceipts(runId: string): AuditReceipt[] {
    const rows = this.odb.getDB().prepare(`
      SELECT er.* FROM effect_receipts er
      JOIN run_effects re ON re.id = er.effect_id
      WHERE re.run_id = ? ORDER BY er.effect_id, er.attempt_no ASC
    `).all(runId) as any[];
    return rows.map(r => ({
      id: r.id, effectId: r.effect_id, attemptNo: r.attempt_no,
      requestId: r.request_id ?? null,
      requestHash: r.request_hash ?? null,
      responseHash: r.response_hash ?? null,
      resultCapsuleRef: r.result_capsule_ref ?? null,
      resultCapsuleHash: r.result_capsule_hash ?? null,
      resultCapsuleFormatVersion: r.result_capsule_format_version ?? null,
      providerStatus: r.provider_status ?? null,
      applicationStatus: r.application_status,
      receiptHash: r.receipt_hash, receivedAt: r.received_at,
      eventId: r.event_id ?? null,
    }));
  }

  private queryCapsules(runId: string): AuditCapsuleRef[] {
    const rows = this.odb.getDB().prepare(
      `SELECT * FROM capsules WHERE run_id = ? ORDER BY created_at ASC`,
    ).all(runId) as any[];
    return rows.map(r => ({
      ref: r.ref, hash: r.hash, formatVersion: r.format_version,
      capsuleKind: r.capsule_kind,
      effectId: r.effect_id ?? null,
      receiptId: r.receipt_id ?? null,
      attemptNo: r.attempt_no,
      adapterKind: r.adapter_kind ?? null,
      payloadFingerprint: r.payload_fingerprint ?? null,
      scopeHash: r.scope_hash ?? null,
      expiresAt: r.expires_at, createdAt: r.created_at,
    }));
  }

  private queryLease(runId: string): AuditLease | null {
    const r = this.odb.getDB().prepare(
      'SELECT * FROM recovery_leases WHERE run_id = ?',
    ).get(runId) as any | undefined;
    if (!r) return null;
    return {
      runId: r.run_id, holderId: r.holder_id,
      leaseVersion: r.lease_version,
      acquiredAt: r.acquired_at, expiresAt: r.expires_at,
      renewedAt: r.renewed_at, releasedAt: r.released_at ?? null,
    };
  }

  private queryAuditEdges(runId: string): AuditEdgeEntry[] {
    const rows = this.odb.getDB().prepare(
      `SELECT * FROM audit_edges WHERE run_id = ? ORDER BY created_at ASC`,
    ).all(runId) as any[];
    return rows.map(r => ({
      fromKind: r.from_kind, fromId: r.from_id, relation: r.relation,
      toKind: r.to_kind, toId: r.to_id,
      sourceEventId: r.source_event_id ?? null, createdAt: r.created_at,
    }));
  }

  private queryEvents(runId: string): AuditEvent[] {
    const rows = this.odb.getDB().prepare(
      `SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence ASC`,
    ).all(runId) as any[];
    const SENSITIVE_KEYS = new Set([
      'task', 'query', 'promptParts', 'prompt_parts', 'redactedText',
      'responseText', 'content', 'message', 'secret', 'password',
      'apiKey', 'token', 'command', 'cwd', 'shell', 'shellCommand',
      'input', 'output', 'stdout', 'stderr', 'pastedCommand',
      'rawText', 'answer', 'response', 'result', 'rawPayload',
    ]);
    return rows.map(r => {
      let keyCount = 0;
      let hasSensitiveFields = false;
      let payloadDigest = r.payload_hash ?? '';
      try {
        const parsed = JSON.parse(r.event_payload_json ?? '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const keys = Object.keys(parsed);
          keyCount = keys.length;
          for (const k of keys) {
            if (SENSITIVE_KEYS.has(k)) {
              hasSensitiveFields = true;
              break;
            }
          }
          // Independent digest of the canonical payload bytes.
          // We compute and store it as payloadDigest (overrides
          // the row's precomputed payload_hash) so the packet
          // always carries an authenticatable fingerprint of
          // the payload, even when the row's payload_hash was
          // placeholder text.
          payloadDigest = crypto.createHash('sha256')
            .update(JSON.stringify(parsed))
            .digest('hex');
        } else if (Array.isArray(parsed)) {
          keyCount = parsed.length;
        }
      } catch {
        // malformed — leave defaults.
      }
      const payloadKind: AuditEvent['payloadKind'] = r.event_type.startsWith('frame_')
        || r.event_type.startsWith('effect_')
        || r.event_type === 'recovery_audit'
        ? 'structural'
        : r.event_type === 'policy_evaluated'
          || r.event_type === 'route_decided'
          ? 'policy'
        : r.event_type === 'redaction_applied'
          ? 'redaction'
        : 'model';
      return {
        id: r.id, runId: r.run_id, workspaceId: r.workspace_id ?? null,
        sequence: r.sequence, eventType: r.event_type,
        payloadDigest, payloadKeyCount: keyCount,
        payloadKind, hasSensitiveFields,
        previousHash: r.previous_hash, eventHash: r.event_hash,
        hashEnvelopeVersion: r.hash_envelope_version ?? null,
        policyVersionHash: r.policy_version_hash ?? null,
        redactionRuleVersion: r.redaction_rule_version ?? null,
        frameId: r.frame_id ?? null,
        effectId: r.effect_id ?? null,
        repairTransactionId: r.repair_transaction_id ?? null,
        idempotencyKeyHash: r.idempotency_key_hash ?? null,
        externalReceiptHash: r.external_receipt_hash ?? null,
        createdAt: r.created_at,
      };
    });
  }

  private queryLastRecoveryReport(runId: string): RecoveryReport | null {
    const row = this.odb.getDB().prepare(`
      SELECT * FROM run_events WHERE run_id = ?
        AND event_type = ? ORDER BY sequence DESC LIMIT 1
    `).get(runId, RECOVERY_REPORT_EVENT) as any | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.event_payload_json);
      if (!parsed || typeof parsed !== 'object') return null;
      return {
        runId,
        holderId: parsed.holderId ?? '',
        lease: parsed.lease ?? null,
        inspectedEffects: parsed.inspectedEffects ?? 0,
        effects: Array.isArray(parsed.decisions) ? parsed.decisions.map((d: any) => ({
          effectId: d.effectId,
          stateBefore: d.stateBefore ?? 'unknown',
          decision: d.decision ?? 'noop_already_terminal',
          attemptNo: d.attemptNo ?? undefined,
          receiptId: d.receiptId ?? undefined,
          incidentKind: d.incidentKind ?? undefined,
          detail: d.detail ?? '',
        })) : [],
      };
    } catch {
      return null;
    }
  }
}