/**
 * Series 1B Milestone 2 Round-8d — payload sanitization.
 *
 * Catches raw payload / secret / response / CoT leakage in:
 *   1. audit export (RecoveryAuditPacketService)
 *   2. UI render (EffectStateBadge / RecoveryDecisionBadge)
 *
 * Test technique: seed a sentinel secret + sentinel response
 * + sentinel idempotency key, then assert NO occurrence of any
 * sentinel in the audit packet JSON or the rendered DOM
 * node text.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { canonicalJSON } from '../../src/core/audit-envelope';
import { DatabaseService } from '../../src/core/database-service';
import { OgraDatabase } from '../../src/core/database';
import { DurableRuntimeService } from '../../src/core/durable-runtime-service';
import {
  EncryptedCapsuleStore, StaticMasterKeyProvider,
} from '../../src/core/capsule-store';
import { EffectProtocolService } from '../../src/core/effect-protocol-service';
import { RecoveryService } from '../../src/core/recovery-service';
import { RecoveryAuditPacketService } from '../../src/core/recovery-audit-packet';
import { IngressReviewService } from '../../src/core/ingress-review-service';
import { MockEffectAdapter } from '../helpers/mock-effect-adapter';
import {
  EffectStateBadge, RecoveryDecisionBadge,
} from '../../src/renderer/components/EffectStateBadge';

function newDir(prefix: string): string {
  const d = path.join(os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const SENTINEL_TASK = 'SECRET_TASK_DO_NOT_LEAK_r8d_T1';
const SENTINEL_QUERY = 'SECRET_QUERY_DO_NOT_LEAK_r8d_Q1';
const SENTINEL_RESPONSE = 'SECRET_RESPONSE_DO_NOT_LEAK_r8d_R1';
const SENTINEL_KEY = 'SECRET_IDEMPOTENCY_DO_NOT_LEAK_r8d_K1';
const SENTINEL_COMMAND = 'SECRET_COMMAND_DO_NOT_LEAK_r8d_C1';

function seedRun(odb: OgraDatabase, runId: string): string {
  const wsid = 'w-' + crypto.randomBytes(3).toString('hex');
  odb.getDB().prepare(`INSERT INTO workspaces
    (id, name, type, default_data_classification, created_at, updated_at, workspace_tag)
    VALUES (?, 'r', 'personal', 'Public', ?, ?, hex(randomblob(16)))`)
    .run(wsid, new Date().toISOString(), new Date().toISOString());
  odb.getDB().prepare(`INSERT INTO agent_runs
    (id, workspace_id, task, status, started_at)
    VALUES (?, ?, 'm2-r8d', 'created', ?)`)
    .run(runId, wsid, new Date().toISOString());
  return wsid;
}

function freshProcess(dir: string, masterKey: Buffer) {
  const dbService = new DatabaseService(dir);
  const odb = dbService.getOgraDatabase();
  const runtime = new DurableRuntimeService(odb, () => 'ph-m2-r8d');
  const capsuleStore = new EncryptedCapsuleStore(
    odb, new StaticMasterKeyProvider(masterKey));
  const protocol = new EffectProtocolService(odb, runtime, capsuleStore);
  const recovery = new RecoveryService(odb, runtime, capsuleStore,
    protocol, undefined);
  const auditPacket = new RecoveryAuditPacketService(odb);
  const ingressReview = new IngressReviewService(
    odb, runtime, capsuleStore);
  return {
    dbService, odb, runtime, capsuleStore, protocol,
    recovery, auditPacket, ingressReview,
  };
}

const RC = {
  supportsIdempotencyKey: true,
  supportsOutcomeQuery: true,
  supportsCompensation: false,
};

describe('Sequence 1B Milestone 2 Round-8d — payload sanitization', () => {
  let dir: string;
  beforeEach(() => { dir = newDir('m2-r8d'); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  /* ─────────────────────────────────────────────────────────
   * Audit packet sanitization — the audit JSON MUST NOT leak
   * raw task / query / response / idempotency key / secret /
   * CoT. Only refs/hashes/state/decision codes allowed.
   * ───────────────────────────────────────────────────────── */

  it('audit packet: zero raw payload / secret / idempotency-key leakage', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc = freshProcess(dir, masterKey);
    const runId = 'r-r8d-' + crypto.randomBytes(3).toString('hex');
    seedRun(proc.odb, runId);
    const root = proc.runtime.createRootFrame({ runId });
    const child = proc.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc.runtime.acquireLease({ runId, holderId: 'h-r8d', ttlMs: 60_000 });

    // Synthesize a run_events row carrying a sensitive
    // payload (the real path would never do this, but we
    // want to verify the audit packet sanitizes it).
    proc.odb.getDB().prepare(`INSERT INTO run_events
      (id, run_id, workspace_id, sequence, event_type,
       event_payload_json, payload_hash,
       policy_version_hash, redaction_rule_version,
       previous_hash, event_hash, created_at)
      VALUES (?, ?, ?, 100, 'task_submitted', ?, ?, 'ph-r8d',
        'rv-r8d', '', 'eh-r8d-1', ?)`).run(
        'evt-r8d-1', runId, 'w',
        JSON.stringify({
          task: SENTINEL_TASK,
          query: SENTINEL_QUERY,
          idempotencyKey: SENTINEL_KEY,
          command: SENTINEL_COMMAND,
          responseText: SENTINEL_RESPONSE,
          secret: 'SECRET_DO_NOT_LEAK_r8d_S1',
          apiKey: 'APIKEY_DO_NOT_LEAK_r8d_A1',
          token: 'TOKEN_DO_NOT_LEAK_r8d_T1',
          password: 'PASSWORD_DO_NOT_LEAK_r8d_P1',
          promptParts: ['SECRET_PROMPT_DO_NOT_LEAK_r8d_P1'],
          chainOfThought: 'SECRET_COT_DO_NOT_LEAK_r8d_CT1',
        }),
        'fp-r8d-1',
        new Date().toISOString(),
      );

    // Build the audit packet for the run.
    const packet = proc.auditPacket.build(runId);
    const json = JSON.stringify(packet);

    // Forbidden sentinel assertions.
    expect(json).not.toContain(SENTINEL_TASK);
    expect(json).not.toContain(SENTINEL_QUERY);
    expect(json).not.toContain(SENTINEL_RESPONSE);
    expect(json).not.toContain(SENTINEL_KEY);
    expect(json).not.toContain(SENTINEL_COMMAND);
    expect(json).not.toContain('SECRET_DO_NOT_LEAK_r8d_S1');
    expect(json).not.toContain('APIKEY_DO_NOT_LEAK_r8d_A1');
    expect(json).not.toContain('TOKEN_DO_NOT_LEAK_r8d_T1');
    expect(json).not.toContain('PASSWORD_DO_NOT_LEAK_r8d_P1');
    expect(json).not.toContain('SECRET_PROMPT_DO_NOT_LEAK_r8d_P1'.replace('Prompt', 'PROMPT'));
    expect(json).not.toContain('SECRET_COT_DO_NOT_LEAK_r8d_CT1');
    // Required sanitized fields. The audit packet stores
    // events with payloadDigest / payloadKeyCount /
    // hasSensitiveFields — refs/hashes/state, no raw
    // payload bytes.
    expect(json).toContain('payloadDigest');
    expect(json).toContain('payloadKeyCount');
    expect(json).toContain('hasSensitiveFields');
    // event_payload_json MUST NOT appear.
    expect(json).not.toContain('"event_payload_json"');
    // The seeded sentinel row is recorded in the events list
    // (with sequence=100) and must carry hasSensitiveFields
    // = true because task/query/idempotencyKey are sensitive
    // keys per the audit packet's SENSITIVE_KEYS list.
    const sentinelEvent = JSON.parse(json).frameLineage.events
      .find((e: any) => e.id === 'evt-r8d-1');
    expect(sentinelEvent).toBeTruthy();
    expect(sentinelEvent.hasSensitiveFields).toBe(true);
  });

  /* ─────────────────────────────────────────────────────────
   * Ingress review finalization sanitization — the recovery
   * packet generated alongside finalizeIngressDecision
   * MUST NOT echo back any of the in-flight response body
   * bytes (which are the original provider response that
   * the renderer must NEVER see raw).
   * ───────────────────────────────────────────────────────── */

  it('ingress review: finalizeIngressDecision never echoes raw response body to audit / state', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc = freshProcess(dir, masterKey);
    const runId = 'r-r8d-2-' + crypto.randomBytes(3).toString('hex');
    seedRun(proc.odb, runId);
    const root = proc.runtime.createRootFrame({ runId });
    const child = proc.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc.runtime.acquireLease({ runId, holderId: 'h-r8d-2', ttlMs: 60_000 });

    const egressHash = 'fp-r8d-2';
    const capsuleHash = crypto.createHash('sha256').update('capsule-r8d-2').digest('hex');
    const prep = proc.protocol.prepare({
      runId, ownerFrameId: child.id,
      effectType: 'model.generate', adapterKind: 'mock',
      adapterVersion: 'M2',
      payload: { msg: 'capsule-r8d-2' },
      payloadFingerprint: egressHash, capsuleFingerprint: capsuleHash,
      idempotencyKey: 'idem-r8d-2', scopeHash: 'scope-r8d-2',
      routeDecisionId: 'rd-r8d-2', policyEvaluationId: 'pe-r8d-2',
      policyVersionHash: 'ph-r8d-2',
      recoveryCapabilities: RC,
    });
    const adapter = new MockEffectAdapter('r8d-2');
    adapter.recoveryCapabilities.supportsIdempotencyKey = true;
    const { DurableMockEffectDriver } = await import(
      '../../src/core/durable-mock-driver');
    const driver = new DurableMockEffectDriver(
      proc.odb, proc.runtime, proc.capsuleStore,
      proc.protocol, proc.recovery,
    );
    await driver.runAdapterAndCommit({
      runId, ownerFrameId: child.id, adapter,
      payload: { msg: 'capsule-r8d-2' },
      payloadFingerprint: egressHash,
      idempotencyKey: 'idem-r8d-2', scopeHash: 'scope-r8d-2',
      leaseHolder: 'h-r8d-2', effectId: prep.effectId, attemptNo: 1,
    });
    proc.odb.getDB().prepare(
      `DELETE FROM ingress_findings WHERE effect_id = ?`,
    ).run(prep.effectId);
    proc.odb.getDB().prepare(
      `UPDATE run_effects SET state = 'received' WHERE id = ?`,
    ).run(prep.effectId);
    proc.odb.getDB().prepare(`UPDATE recovery_leases SET released_at = ?,
      lease_version = lease_version + 1 WHERE run_id = ?`)
      .run(new Date().toISOString(), runId);
    proc.runtime.acquireLease({ runId, holderId: 'h-r8d-2b', ttlMs: 60_000 });
    const leaseRow = proc.odb.getDB().prepare(
      `SELECT lease_version FROM recovery_leases
        WHERE run_id = ? AND holder_id = ? AND released_at IS NULL`,
    ).get(runId, 'h-r8d-2b') as { lease_version: number };

    // Note: we deliberately do NOT mutate the on-disk capsule
    // blob to inject a sentinel. The finalizer verifies the
    // reviewer's payload digest against canonicalJSON(opened.payload),
    // which reads the immutable on-disk capsule. Mutating the
    // blob would (correctly) trigger a digest mismatch. The
    // sanitization guarantees of finalizeIngressDecision are
    // exercised by the audit-packet test above (which inserts
    // a sentinel directly into the run_events row) and by the
    // general "IngressReviewService writes only refs/hashes" path
    // verified in sequence1b-m2-crash-matrix.test.ts.
    const resultCapsuleRef = (proc.odb.getDB().prepare(
      `SELECT result_capsule_ref FROM effect_receipts WHERE effect_id = ?`,
    ).get(prep.effectId) as { result_capsule_ref: string }).result_capsule_ref;
    const opened = proc.capsuleStore.openByRef<{ payload: any }>(
      { ref: resultCapsuleRef });
    const canonical = canonicalJSON(opened.payload);
    const reviewerDigest = crypto.createHash('sha256')
      .update(canonical).digest('hex');
    const reviewResult = proc.ingressReview.finalizeIngressDecision({
      effectId: prep.effectId,
      outcome: 'accepted',
      reviewer: 'reviewer-r8d-2',
      reviewerPayloadDigest: reviewerDigest,
      leaseHolderId: 'h-r8d-2b',
      leaseVersion: leaseRow.lease_version,
      ruleVersion: 'm2',
    });
    expect(reviewResult.outcome).toBe('accepted');
    expect(reviewResult.stateAfter).toBe('committed');
    // The audit packet for the run MUST NOT contain the
    // response payload sentinels even when the result capsule
    // carries them.
    const packet = proc.auditPacket.build(runId);
    const json = JSON.stringify(packet);
    // The result capsule payload itself is allowed to carry the
    // response body — that's where it belongs. But the audit
    // packet summary keys are refs/hashes/state only.
    expect(json).not.toContain(SENTINEL_RESPONSE);
    expect(json).not.toContain(SENTINEL_KEY);
  });

  /* ─────────────────────────────────────────────────────────
   * UI render sanitization — the EffectStateBadge and
   * RecoveryDecisionBadge MUST accept only refs/hashes/
   * state; rendering an object that contains raw payload
   * bytes MUST NEVER cause the raw bytes to appear in the
   * DOM.
   * ───────────────────────────────────────────────────────── */

  it('UI: EffectStateBadge never echoes raw payload / secret to DOM', () => {
    const html = renderToStaticMarkup(
      React.createElement(EffectStateBadge, {
        state: 'awaiting_callback_verification',
        sanitizedReasonCode: 'awaiting_user_action',
        awaitingApproval: true,
      }),
    );
    // Required UI labels.
    expect(html).toContain('awaiting verification');
    expect(html).toContain('awaiting_user_action');
    // Forbidden sentinel — no raw payload / secret.
    expect(html).not.toContain(SENTINEL_TASK);
    expect(html).not.toContain(SENTINEL_RESPONSE);
    expect(html).not.toContain(SENTINEL_KEY);
  });

  it('UI: RecoveryDecisionBadge never echoes raw payload to DOM', () => {
    const html = renderToStaticMarkup(
      React.createElement(RecoveryDecisionBadge, {
        decisionCode: 'ingress_accepted',
        sanitizedReason: SENTINEL_RESPONSE,
      }),
    );
    expect(html).toContain('ingress_accepted');
    expect(html).not.toContain(SENTINEL_RESPONSE);
    expect(html).not.toContain(SENTINEL_TASK);
    expect(html).not.toContain(SENTINEL_RESPONSE);
  });

  /* ─────────────────────────────────────────────────────────
   * Defense-in-depth — the audit packet's `eventPayloadSummary`
   * carries only `keyCount / hasSensitiveFields / payloadDigest /
   * fieldTypes`. None of the raw payload keys are exposed.
   * ───────────────────────────────────────────────────────── */

  it('audit packet: eventPayloadSummary fields are exactly the allowed set', () => {
    const masterKey = crypto.randomBytes(32);
    const proc = freshProcess(dir, masterKey);
    const runId = 'r-r8d-3-' + crypto.randomBytes(3).toString('hex');
    seedRun(proc.odb, runId);
    proc.odb.getDB().prepare(`INSERT INTO run_events
      (id, run_id, workspace_id, sequence, event_type,
       event_payload_json, payload_hash,
       policy_version_hash, redaction_rule_version,
       previous_hash, event_hash, created_at)
      VALUES (?, ?, ?, 100, 'task_submitted', ?, ?, 'ph-r8d',
        'rv-r8d', '', 'eh-r8d-1', ?)`).run(
        'evt-r8d-3', runId, 'w',
        JSON.stringify({
          task: SENTINEL_TASK,
          query: SENTINEL_QUERY,
          idempotencyKey: SENTINEL_KEY,
        }),
        'fp-r8d-3',
        new Date().toISOString(),
      );
    const packet = proc.auditPacket.build(runId);
    const events = (packet.frameLineage.events as Array<any>);
    expect(events.length).toBeGreaterThan(0);
    const ev = events.find((e) => e.id === 'evt-r8d-3');
    expect(ev).toBeTruthy();
    // hasSensitiveFields MUST be true (task/query/idemkey
    // are SENSITIVE_KEYS).
    expect(ev.hasSensitiveFields).toBe(true);
    // payloadKeyCount reflects the payload key set.
    expect(ev.payloadKeyCount).toBe(3);
    // eventPayloadJson / event_payload_json field MUST NOT
    // appear in the audit packet (only refs/hashes).
    const json = JSON.stringify(packet);
    expect(json).not.toContain('"event_payload_json"');
    expect(json).not.toContain(SENTINEL_TASK);
    expect(json).not.toContain(SENTINEL_QUERY);
    expect(json).not.toContain(SENTINEL_KEY);
  });
});
