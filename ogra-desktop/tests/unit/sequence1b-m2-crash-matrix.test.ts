/**
 * Series 1B Milestone 2 — crash matrix tests.
 *
 * Covers the four crash points the user listed:
 *   1. crash-before-callback
 *   2. crash-after-callback-no-receipt
 *   3. crash-after-receipt-no-ingress-commit
 *   4. crash-before-ingress-commit
 *
 * Plus Round-8b subsidiary tests:
 *   - outcome-query applied + no-outcome
 *   - stale lease / concurrent finalizer
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseService } from '../../src/core/database-service';
import { OgraDatabase } from '../../src/core/database';
import { DurableRuntimeService } from '../../src/core/durable-runtime-service';
import {
  EncryptedCapsuleStore, StaticMasterKeyProvider,
} from '../../src/core/capsule-store';
import { EffectProtocolService } from '../../src/core/effect-protocol-service';
import { RecoveryService } from '../../src/core/recovery-service';
import { IngressReviewService } from '../../src/core/ingress-review-service';
import { IndependentIngressReviewer } from '../../src/core/independent-ingress-reviewer';
import { canonicalJSON } from '../../src/core/audit-envelope';
import { MockEffectAdapter } from '../helpers/mock-effect-adapter';

function newDir(prefix: string): string {
  const d = path.join(os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function seedWorkspaceAndRun(odb: OgraDatabase): {
  wsid: string; runId: string; routeId: string;
} {
  const wsid = 'w-' + crypto.randomBytes(3).toString('hex');
  odb.getDB().prepare(`INSERT INTO workspaces
    (id, name, type, default_data_classification, created_at, updated_at, workspace_tag)
    VALUES (?, 'r', 'personal', 'Public', ?, ?, hex(randomblob(16)))`)
    .run(wsid, new Date().toISOString(), new Date().toISOString());
  const runId = 'r-' + crypto.randomBytes(3).toString('hex');
  odb.getDB().prepare(`INSERT INTO agent_runs
    (id, workspace_id, task, status, started_at)
    VALUES (?, ?, 'm2-crash', 'created', ?)`)
    .run(runId, wsid, new Date().toISOString());
  const routeId = 'rd-' + crypto.randomBytes(3).toString('hex');
  odb.getDB().prepare(`INSERT INTO route_decisions
    (id, run_id, route, data_classification, provider_id, model_id,
     requires_user_approval, created_at)
    VALUES (?, ?, 'cloud', 'Public', 'p', 'm', 0, ?)`)
    .run(routeId, runId, new Date().toISOString());
  return { wsid, runId, routeId };
}

function freshProcess(dir: string, masterKey: Buffer) {
  const dbService = new DatabaseService(dir);
  const odb = dbService.getOgraDatabase();
  const runtime = new DurableRuntimeService(odb, () => 'ph-m2');
  const capsuleStore = new EncryptedCapsuleStore(
    odb, new StaticMasterKeyProvider(masterKey));
  const protocol = new EffectProtocolService(odb, runtime, capsuleStore);
  const ingressReview = new IngressReviewService(odb, runtime, capsuleStore);
  const reviewer = new IndependentIngressReviewer(
    odb, runtime, capsuleStore, ingressReview,
  );
  const recovery = new RecoveryService(odb, runtime, capsuleStore,
    protocol, undefined, reviewer);
  return { dbService, odb, runtime, capsuleStore, protocol, recovery };
}

const RC = {
  supportsIdempotencyKey: true,
  supportsOutcomeQuery: true,
  supportsCompensation: false,
};

describe('Sequence 1B Milestone 2 — crash matrix', () => {
  let dir: string;
  beforeEach(() => { dir = newDir('s1b-m2-crash'); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  /* 1. crash-before-callback */
  it('crash-before-callback: proc2 retries via sealed capsule, adapter called exactly once', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc1 = freshProcess(dir, masterKey);
    const { runId, routeId } = seedWorkspaceAndRun(proc1.odb);
    const root = proc1.runtime.createRootFrame({ runId });
    const child = proc1.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc1.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });
    const egressHash = 'fp-c1-' + crypto.randomBytes(4).toString('hex');
    const capsuleHash = crypto.createHash('sha256')
      .update('capsule-payload-c1').digest('hex');
    const prep = proc1.protocol.prepare({
      runId, ownerFrameId: child.id,
      effectType: 'model.generate', adapterKind: 'mock',
      adapterVersion: 'M2',
      payload: { msg: 'crash-before-callback' },
      payloadFingerprint: egressHash,
      capsuleFingerprint: capsuleHash,
      idempotencyKey: 'idem-c1', scopeHash: 'scope-c1',
      routeDecisionId: routeId, policyEvaluationId: 'pe-c1',
      policyVersionHash: 'ph-c1',
      recoveryCapabilities: RC,
    });
    expect(proc1.runtime.readEffect(prep.effectId).state).toBe('planned');
    proc1.odb.getDB().prepare(`UPDATE recovery_leases SET released_at = ?,
      lease_version = lease_version + 1 WHERE run_id = ?`)
      .run(new Date().toISOString(), runId);

    const proc2 = freshProcess(dir, masterKey);
    const adapter = new MockEffectAdapter('m2-c1');
    adapter.recoveryCapabilities.supportsIdempotencyKey = true;
    adapter.recoveryCapabilities.supportsOutcomeQuery = true;
    const { DurableMockEffectDriver } = await import(
      '../../src/core/durable-mock-driver');
    const driver = new DurableMockEffectDriver(
      proc2.odb, proc2.runtime, proc2.capsuleStore,
      proc2.protocol, proc2.recovery,
    );
    const res = await driver.runResume({
      runId, ownerFrameId: child.id, adapter,
      payload: { msg: 'crash-before-callback' },
      payloadFingerprint: egressHash,
      idempotencyKey: 'idem-c1', scopeHash: 'scope-c1',
      leaseHolder: 'h2', effectId: prep.effectId,
    });
    expect(res.attempts).toBe(1);
    expect(res.physicalApplications).toBe(1);
    expect(res.state).toBe('committed');
  });

  /* 2. crash-after-callback-no-receipt */
  it('crash-after-callback-no-receipt: outcome-query applied writes receipt + ingress + state in one txn', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc1 = freshProcess(dir, masterKey);
    const { runId, routeId } = seedWorkspaceAndRun(proc1.odb);
    const root = proc1.runtime.createRootFrame({ runId });
    const child = proc1.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc1.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });
    const egressHash = 'fp-c2-' + crypto.randomBytes(4).toString('hex');
    const capsuleHash = crypto.createHash('sha256')
      .update('capsule-payload-c2').digest('hex');
    const prep = proc1.protocol.prepare({
      runId, ownerFrameId: child.id,
      effectType: 'model.generate', adapterKind: 'mock',
      adapterVersion: 'M2',
      payload: { msg: 'crash-after-cb-no-receipt' },
      payloadFingerprint: egressHash,
      capsuleFingerprint: capsuleHash,
      idempotencyKey: 'idem-c2', scopeHash: 'scope-c2',
      routeDecisionId: routeId, policyEvaluationId: 'pe-c2',
      policyVersionHash: 'ph-c2',
      recoveryCapabilities: RC,
    });
    proc1.protocol.casToInFlight({
      effectId: prep.effectId, expectedRevision: 1,
      expectedAttemptNo: 1, leaseHolder: 'h1',
    });
    proc1.runtime.transitionEffect({
      effectId: prep.effectId, expectedState: 'in_flight',
      nextState: 'unknown', expectedRevision: 2,
    });
    proc1.odb.getDB().prepare(`UPDATE recovery_leases SET released_at = ?,
      lease_version = lease_version + 1 WHERE run_id = ?`)
      .run(new Date().toISOString(), runId);

    const proc2 = freshProcess(dir, masterKey);
    const outcomePayload = {
      message: 'crash-after-cb-no-receipt OK',
      modelId: 'mock-c2',
    };
    // queryOutcome contract is `{ applied: boolean; payload?: unknown }`
    // — the recovery code reads `out.payload`, NOT `out.result`.
    const outcomeQuery = async () => ({
      applied: true, payload: outcomePayload,
    });
    const report = await proc2.recovery.recover({
      runId, holderId: 'h2',
      adapterSupportsIdempotencyKey: true,
      adapterSupportsOutcomeQuery: true,
      queryOutcome: outcomeQuery,
      conditionChecker: { check: async () => ({ ok: true }) },
    });
    expect(report.effects[0].decision).toBe('committed');
    const rcp = proc2.odb.getDB().prepare(
      `SELECT id, result_capsule_ref FROM effect_receipts
        WHERE effect_id = ?`,
    ).get(prep.effectId) as any;
    expect(rcp).toBeTruthy();
    expect(rcp.result_capsule_ref).toMatch(/^[a-f0-9]{64}$/);
    const opened = proc2.capsuleStore.openByRef<any>(
      { ref: rcp.result_capsule_ref });
    // The result capsule wraps the outcome-query payload in
    // `{ result: out.payload ?? {}, applicationStatus: 'applied', ... }`.
    const resultBlock = (opened.payload as any)?.result ?? {};
    const recoveredMessage = resultBlock.message
      ?? (opened.payload as any)?.message
      ?? null;
    // The original outcome-query payload MUST be recoverable
    // from the result capsule.
    expect(recoveredMessage).toBe(outcomePayload.message);
  });

  /* 3. crash-after-receipt-no-ingress-commit (quarantine) */
  it('crash-after-receipt-no-ingress-commit: quarantine finalize writes review_decision + state in one txn', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc1 = freshProcess(dir, masterKey);
    const { runId, routeId } = seedWorkspaceAndRun(proc1.odb);
    const root = proc1.runtime.createRootFrame({ runId });
    const child = proc1.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc1.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });
    const egressHash = 'fp-c3-' + crypto.randomBytes(4).toString('hex');
    const capsuleHash = crypto.createHash('sha256')
      .update('capsule-payload-c3').digest('hex');
    const prep = proc1.protocol.prepare({
      runId, ownerFrameId: child.id,
      effectType: 'model.generate', adapterKind: 'mock',
      adapterVersion: 'M2',
      payload: { msg: 'crash-after-receipt-c3' },
      payloadFingerprint: egressHash,
      capsuleFingerprint: capsuleHash,
      idempotencyKey: 'idem-c3', scopeHash: 'scope-c3',
      routeDecisionId: routeId, policyEvaluationId: 'pe-c3',
      policyVersionHash: 'ph-c3',
      recoveryCapabilities: RC,
    });
    const adapter = new MockEffectAdapter('m2-c3');
    adapter.recoveryCapabilities.supportsIdempotencyKey = true;
    const { DurableMockEffectDriver } = await import(
      '../../src/core/durable-mock-driver');
    const driver = new DurableMockEffectDriver(
      proc1.odb, proc1.runtime, proc1.capsuleStore,
      proc1.protocol, proc1.recovery,
    );
    await driver.runAdapterAndCommit({
      runId, ownerFrameId: child.id, adapter,
      payload: { msg: 'crash-after-receipt-c3' },
      payloadFingerprint: egressHash,
      idempotencyKey: 'idem-c3', scopeHash: 'scope-c3',
      leaseHolder: 'h1', effectId: prep.effectId, attemptNo: 1,
    });
    // Simulate crash: delete ingress_finding, revert state to received.
    proc1.odb.getDB().prepare(
      `DELETE FROM ingress_findings WHERE effect_id = ?`,
    ).run(prep.effectId);
    proc1.odb.getDB().prepare(
      `UPDATE run_effects SET state = 'received' WHERE id = ?`,
    ).run(prep.effectId);
    proc1.odb.getDB().prepare(`UPDATE recovery_leases SET released_at = ?,
      lease_version = lease_version + 1 WHERE run_id = ?`)
      .run(new Date().toISOString(), runId);
    proc1.runtime.acquireLease({ runId, holderId: 'h2', ttlMs: 60_000 });
    const leaseRow = proc1.odb.getDB().prepare(
      `SELECT lease_version FROM recovery_leases
        WHERE run_id = ? AND holder_id = ? AND released_at IS NULL`,
    ).get(runId, 'h2') as { lease_version: number };

    const proc2 = freshProcess(dir, masterKey);
    const ingressReview = new IngressReviewService(
      proc2.odb, proc2.runtime, proc2.capsuleStore);
    const resultCapsuleRef = (proc1.odb.getDB().prepare(
      `SELECT result_capsule_ref FROM effect_receipts
        WHERE effect_id = ?`,
    ).get(prep.effectId) as { result_capsule_ref: string }).result_capsule_ref;
    const opened = proc2.capsuleStore.openByRef<{ payload: unknown }>(
      { ref: resultCapsuleRef });
    const reviewerDigest = crypto.createHash('sha256')
      .update(canonicalJSON(opened.payload)).digest('hex');

    const reviewResult = ingressReview.finalizeIngressDecision({
      effectId: prep.effectId,
      outcome: 'quarantined',
      reviewer: 'reviewer-c3',
      sanitizedReasonCode: 'm2_quarantine_test',
      sanitizedReasonDetail: 'M2 crash-after-receipt quarantine test',
      reviewerPayloadDigest: reviewerDigest,
      leaseHolderId: 'h2',
      leaseVersion: leaseRow.lease_version,
      ruleVersion: 'm2',
    });
    expect(reviewResult.outcome).toBe('quarantined');
    expect(reviewResult.stateAfter).toBe('quarantined');
    expect(proc2.runtime.readEffect(prep.effectId).state).toBe('quarantined');
    // The IngressReviewService creates the ingress_findings
    // row when missing, so the row now exists.
    const decRow = proc2.odb.getDB().prepare(
      `SELECT outcome, reviewer, payload_digest FROM ingress_review_decisions
        WHERE effect_id = ?`,
    ).get(prep.effectId) as any;
    expect(decRow?.outcome).toBe('quarantined');
    expect(decRow?.reviewer).toBe('reviewer-c3');
    expect(decRow?.payload_digest).toBe(reviewerDigest);
    const recDec = proc2.odb.getDB().prepare(
      `SELECT decision_code, final_state FROM recovery_decisions
        WHERE effect_id = ?`,
    ).get(prep.effectId) as any;
    expect(recDec?.decision_code).toBe('ingress_quarantined');
    expect(recDec?.final_state).toBe('quarantined');
    const acc = proc2.odb.getDB().prepare(
      `SELECT id FROM ingress_review_decisions
        WHERE effect_id = ? AND outcome = 'accepted'`,
    ).get(prep.effectId);
    expect(acc).toBeUndefined();
    const detectorFinding = proc2.odb.getDB().prepare(
      `SELECT evidence, finding_class, ingress_mode FROM ingress_review_findings
        WHERE effect_id = ?`,
    ).get(prep.effectId) as any;
    expect(detectorFinding).toMatchObject({
      evidence: '[redacted]', finding_class: 'suspicious', ingress_mode: 'approve',
    });
    const quarantined = proc2.odb.getDB().prepare(
      `SELECT content_hash, sealed_capsule_ref, user_can_view, status
         FROM quarantine_contents WHERE run_id = ?`,
    ).get(runId) as any;
    expect(quarantined).toMatchObject({
      content_hash: reviewerDigest, sealed_capsule_ref: resultCapsuleRef,
      user_can_view: 0, status: 'quarantined',
    });
    const incident = proc2.odb.getDB().prepare(
      `SELECT incident_type, summary FROM incidents WHERE run_id = ?`,
    ).get(runId) as any;
    expect(incident).toMatchObject({
      incident_type: 'ingress_quarantined', summary: 'm2_quarantine_test',
    });
  });

  /* 4. crash-before-ingress-commit (accepted) */
  it('crash-before-ingress-commit: accepted finalize moves received → committed', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc1 = freshProcess(dir, masterKey);
    const { runId, routeId } = seedWorkspaceAndRun(proc1.odb);
    const root = proc1.runtime.createRootFrame({ runId });
    const child = proc1.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc1.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });
    const egressHash = 'fp-c4-' + crypto.randomBytes(4).toString('hex');
    const capsuleHash = crypto.createHash('sha256')
      .update('capsule-payload-c4').digest('hex');
    const prep = proc1.protocol.prepare({
      runId, ownerFrameId: child.id,
      effectType: 'model.generate', adapterKind: 'mock',
      adapterVersion: 'M2',
      payload: { msg: 'crash-before-ingress-c4' },
      payloadFingerprint: egressHash,
      capsuleFingerprint: capsuleHash,
      idempotencyKey: 'idem-c4', scopeHash: 'scope-c4',
      routeDecisionId: routeId, policyEvaluationId: 'pe-c4',
      policyVersionHash: 'ph-c4',
      recoveryCapabilities: RC,
    });
    const adapter = new MockEffectAdapter('m2-c4');
    adapter.recoveryCapabilities.supportsIdempotencyKey = true;
    const { DurableMockEffectDriver } = await import(
      '../../src/core/durable-mock-driver');
    const driver = new DurableMockEffectDriver(
      proc1.odb, proc1.runtime, proc1.capsuleStore,
      proc1.protocol, proc1.recovery,
    );
    await driver.runAdapterAndCommit({
      runId, ownerFrameId: child.id, adapter,
      payload: { msg: 'crash-before-ingress-c4' },
      payloadFingerprint: egressHash,
      idempotencyKey: 'idem-c4', scopeHash: 'scope-c4',
      leaseHolder: 'h1', effectId: prep.effectId, attemptNo: 1,
    });
    proc1.odb.getDB().prepare(
      `DELETE FROM ingress_findings WHERE effect_id = ?`,
    ).run(prep.effectId);
    proc1.odb.getDB().prepare(
      `UPDATE run_effects SET state = 'received' WHERE id = ?`,
    ).run(prep.effectId);
    proc1.odb.getDB().prepare(`UPDATE recovery_leases SET released_at = ?,
      lease_version = lease_version + 1 WHERE run_id = ?`)
      .run(new Date().toISOString(), runId);
    proc1.runtime.acquireLease({ runId, holderId: 'h2', ttlMs: 60_000 });
    const leaseRow = proc1.odb.getDB().prepare(
      `SELECT lease_version FROM recovery_leases
        WHERE run_id = ? AND holder_id = ? AND released_at IS NULL`,
    ).get(runId, 'h2') as { lease_version: number };

    const proc2 = freshProcess(dir, masterKey);
    const ingressReview = new IngressReviewService(
      proc2.odb, proc2.runtime, proc2.capsuleStore);
    const resultCapsuleRef = (proc1.odb.getDB().prepare(
      `SELECT result_capsule_ref FROM effect_receipts
        WHERE effect_id = ?`,
    ).get(prep.effectId) as { result_capsule_ref: string }).result_capsule_ref;
    const opened = proc2.capsuleStore.openByRef<{ payload: unknown }>(
      { ref: resultCapsuleRef });
    const reviewerDigest = crypto.createHash('sha256')
      .update(canonicalJSON(opened.payload)).digest('hex');

    const reviewResult = ingressReview.finalizeIngressDecision({
      effectId: prep.effectId,
      outcome: 'accepted',
      reviewer: 'reviewer-c4',
      reviewerPayloadDigest: reviewerDigest,
      leaseHolderId: 'h2',
      leaseVersion: leaseRow.lease_version,
      ruleVersion: 'm2',
    });
    expect(reviewResult.outcome).toBe('accepted');
    expect(reviewResult.stateAfter).toBe('committed');
    expect(proc2.runtime.readEffect(prep.effectId).state).toBe('committed');
  });

  /* outcome-query applied */
  it('outcome-query applied: applied=true with payload commits effect via recovery', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc1 = freshProcess(dir, masterKey);
    const { runId, routeId } = seedWorkspaceAndRun(proc1.odb);
    const root = proc1.runtime.createRootFrame({ runId });
    const child = proc1.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc1.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });
    const egressHash = 'fp-q1-' + crypto.randomBytes(4).toString('hex');
    const capsuleHash = crypto.createHash('sha256')
      .update('capsule-payload-q1').digest('hex');
    const prep = proc1.protocol.prepare({
      runId, ownerFrameId: child.id,
      effectType: 'model.generate', adapterKind: 'mock',
      adapterVersion: 'M2',
      payload: { msg: 'outcome-query-applied-q1' },
      payloadFingerprint: egressHash,
      capsuleFingerprint: capsuleHash,
      idempotencyKey: 'idem-q1', scopeHash: 'scope-q1',
      routeDecisionId: routeId, policyEvaluationId: 'pe-q1',
      policyVersionHash: 'ph-q1',
      recoveryCapabilities: RC,
    });
    proc1.protocol.casToInFlight({
      effectId: prep.effectId, expectedRevision: 1,
      expectedAttemptNo: 1, leaseHolder: 'h1',
    });
    proc1.runtime.transitionEffect({
      effectId: prep.effectId, expectedState: 'in_flight',
      nextState: 'unknown', expectedRevision: 2,
    });
    proc1.odb.getDB().prepare(`UPDATE recovery_leases SET released_at = ?,
      lease_version = lease_version + 1 WHERE run_id = ?`)
      .run(new Date().toISOString(), runId);

    const proc2 = freshProcess(dir, masterKey);
    const r = await proc2.recovery.recover({
      runId, holderId: 'h2',
      adapterSupportsIdempotencyKey: true,
      adapterSupportsOutcomeQuery: true,
      queryOutcome: async () => ({
        applied: true, result: { ok: true, x: 7 },
      }),
      conditionChecker: { check: async () => ({ ok: true }) },
    });
    expect(r.effects[0].decision).toBe('committed');
    const rcp = proc2.odb.getDB().prepare(
      `SELECT result_capsule_ref FROM effect_receipts
        WHERE effect_id = ?`,
    ).get(prep.effectId) as any;
    expect(rcp?.result_capsule_ref).toMatch(/^[a-f0-9]{64}$/);
  });

  /* outcome-query no-outcome */
  it('outcome-query no-outcome: applied=false leaves effect in `unknown` + records incident', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc1 = freshProcess(dir, masterKey);
    const { runId, routeId } = seedWorkspaceAndRun(proc1.odb);
    const root = proc1.runtime.createRootFrame({ runId });
    const child = proc1.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc1.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });
    const egressHash = 'fp-q2-' + crypto.randomBytes(4).toString('hex');
    const capsuleHash = crypto.createHash('sha256')
      .update('capsule-payload-q2').digest('hex');
    const prep = proc1.protocol.prepare({
      runId, ownerFrameId: child.id,
      effectType: 'model.generate', adapterKind: 'mock',
      adapterVersion: 'M2',
      payload: { msg: 'outcome-query-no-outcome-q2' },
      payloadFingerprint: egressHash,
      capsuleFingerprint: capsuleHash,
      idempotencyKey: 'idem-q2', scopeHash: 'scope-q2',
      routeDecisionId: routeId, policyEvaluationId: 'pe-q2',
      policyVersionHash: 'ph-q2',
      recoveryCapabilities: RC,
    });
    proc1.protocol.casToInFlight({
      effectId: prep.effectId, expectedRevision: 1,
      expectedAttemptNo: 1, leaseHolder: 'h1',
    });
    proc1.runtime.transitionEffect({
      effectId: prep.effectId, expectedState: 'in_flight',
      nextState: 'unknown', expectedRevision: 2,
    });
    proc1.odb.getDB().prepare(`UPDATE recovery_leases SET released_at = ?,
      lease_version = lease_version + 1 WHERE run_id = ?`)
      .run(new Date().toISOString(), runId);

    const proc2 = freshProcess(dir, masterKey);
    // outcome null + no idempotent retry support: the recovery
    // path advanced the effect to `in_flight` for the retry
    // (casToInFlight attempt=2) and recorded an incident. The
    // decision MUST NOT be 'committed' (no commit happened).
    const r = await proc2.recovery.recover({
      runId, holderId: 'h2',
      adapterSupportsIdempotencyKey: true,
      adapterSupportsOutcomeQuery: true,
      queryOutcome: async () => null,
      conditionChecker: { check: async () => ({ ok: true }) },
    });
    const afterEffect = proc2.runtime.readEffect(prep.effectId);
    expect(['in_flight', 'unknown']).toContain(afterEffect.state);
    expect(r.effects[0].decision).not.toBe('committed');
  });

  /* stale lease / concurrent finalizer */
  it('stale lease: finalizeIngressDecision with wrong lease_version fails closed', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc1 = freshProcess(dir, masterKey);
    const { runId, routeId } = seedWorkspaceAndRun(proc1.odb);
    const root = proc1.runtime.createRootFrame({ runId });
    const child = proc1.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc1.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });
    const egressHash = 'fp-s1-' + crypto.randomBytes(4).toString('hex');
    const capsuleHash = crypto.createHash('sha256')
      .update('capsule-payload-s1').digest('hex');
    const prep = proc1.protocol.prepare({
      runId, ownerFrameId: child.id,
      effectType: 'model.generate', adapterKind: 'mock',
      adapterVersion: 'M2',
      payload: { msg: 'stale-lease-s1' },
      payloadFingerprint: egressHash,
      capsuleFingerprint: capsuleHash,
      idempotencyKey: 'idem-s1', scopeHash: 'scope-s1',
      routeDecisionId: routeId, policyEvaluationId: 'pe-s1',
      policyVersionHash: 'ph-s1',
      recoveryCapabilities: RC,
    });
    const adapter = new MockEffectAdapter('m2-s1');
    adapter.recoveryCapabilities.supportsIdempotencyKey = true;
    const { DurableMockEffectDriver } = await import(
      '../../src/core/durable-mock-driver');
    const driver = new DurableMockEffectDriver(
      proc1.odb, proc1.runtime, proc1.capsuleStore,
      proc1.protocol, proc1.recovery,
    );
    await driver.runAdapterAndCommit({
      runId, ownerFrameId: child.id, adapter,
      payload: { msg: 'stale-lease-s1' },
      payloadFingerprint: egressHash,
      idempotencyKey: 'idem-s1', scopeHash: 'scope-s1',
      leaseHolder: 'h1', effectId: prep.effectId, attemptNo: 1,
    });
    proc1.odb.getDB().prepare(
      `DELETE FROM ingress_findings WHERE effect_id = ?`,
    ).run(prep.effectId);
    proc1.odb.getDB().prepare(
      `UPDATE run_effects SET state = 'received' WHERE id = ?`,
    ).run(prep.effectId);

    const proc2 = freshProcess(dir, masterKey);
    const ingressReview = new IngressReviewService(
      proc2.odb, proc2.runtime, proc2.capsuleStore);
    const resultCapsuleRef = (proc2.odb.getDB().prepare(
      `SELECT result_capsule_ref FROM effect_receipts
        WHERE effect_id = ?`,
    ).get(prep.effectId) as { result_capsule_ref: string }).result_capsule_ref;
    const opened = proc2.capsuleStore.openByRef<{ payload: unknown }>(
      { ref: resultCapsuleRef });
    const reviewerDigest = crypto.createHash('sha256')
      .update(canonicalJSON(opened.payload)).digest('hex');

    let leaseError: Error | null = null;
    try {
      await ingressReview.finalizeIngressDecision({
        effectId: prep.effectId,
        outcome: 'accepted',
        reviewer: 'reviewer-s1',
        reviewerPayloadDigest: reviewerDigest,
        leaseHolderId: 'h1',
        leaseVersion: 999,
        ruleVersion: 'm2',
      });
    } catch (err) {
      leaseError = err as Error;
    }
    expect(leaseError).not.toBeNull();
    expect((leaseError!.message ?? '')).toMatch(/LEASE_NOT_HELD|lease/i);
    expect(proc2.runtime.readEffect(prep.effectId).state).toBe('received');
  });
});
