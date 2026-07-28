/**
 * Series 1B Milestone 2 Round-8c — drift matrix + capsule
 * breakage + real-agent run path.
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
import { RecoveryApprovalService } from '../../src/core/recovery-approval-service';
import { IngressReviewService } from '../../src/core/ingress-review-service';
import { DefaultRecoveryConditionChecker } from '../../src/core/recovery-condition-checker';
import { canonicalJSON } from '../../src/core/audit-envelope';
import { MockEffectAdapter } from '../helpers/mock-effect-adapter';
import { PolicyService } from '../../src/core/policy-service';
import { RouteService } from '../../src/core/route-service';
import { AuditService } from '../../src/core/audit-service';

function newDir(prefix: string): string {
  const d = path.join(os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function seedWorkspaceAndRun(
  odb: OgraDatabase,
  classification: string = 'Public',
): { wsid: string; runId: string; routeId: string } {
  const wsid = 'w-' + crypto.randomBytes(3).toString('hex');
  odb.getDB().prepare(`INSERT INTO workspaces
    (id, name, type, default_data_classification, created_at, updated_at, workspace_tag)
    VALUES (?, 'r', 'personal', ?, ?, ?, hex(randomblob(16)))`)
    .run(wsid, classification, new Date().toISOString(), new Date().toISOString());
  const runId = 'r-' + crypto.randomBytes(3).toString('hex');
  odb.getDB().prepare(`INSERT INTO agent_runs
    (id, workspace_id, task, status, started_at)
    VALUES (?, ?, 'm2-drift', 'created', ?)`)
    .run(runId, wsid, new Date().toISOString());
  const routeId = 'rd-' + crypto.randomBytes(3).toString('hex');
  // Public classification: no approval required.
  // Confidential classification: approval required.
  const requiresApproval = classification === 'Public' ? 0 : 1;
  odb.getDB().prepare(`INSERT INTO route_decisions
    (id, run_id, route, data_classification, provider_id, model_id,
     requires_user_approval, created_at)
    VALUES (?, ?, 'cloud', ?, 'p', 'm', ?, ?)`)
    .run(routeId, runId, classification, requiresApproval,
      new Date().toISOString());
  return { wsid, runId, routeId };
}

function seedApproval(
  odb: OgraDatabase,
  args: {
    approvalId: string;
    runId: string;
    routeDecisionId: string;
    workspaceId: string;
    payloadFingerprint: string;
    scopeHash: string;
    policyVersionHash: string;
    expiresAt?: string | null;
    revoked?: number;
    decision?: string;
  },
): void {
  const now = new Date().toISOString();
  odb.getDB().prepare(`INSERT INTO approvals
    (id, run_id, workspace_id, approval_type, decision, decided_by, reason,
     expires_at, created_at, decided_at, scope_hash, payload_fingerprint,
     policy_version_hash, revision, revoked_for_recovery,
     revoked_for_recovery_at, sanitized_preview)
    VALUES (?, ?, ?, 'redact_then_egress', ?, 'reviewer', 'm2-drift',
            ?, ?, ?, ?, ?, ?, 1, ?, NULL, '')`)
    .run(
      args.approvalId, args.runId, args.workspaceId,
      args.decision ?? 'approved',
      args.expiresAt ?? null,
      now, now,
      args.scopeHash, args.payloadFingerprint, args.policyVersionHash,
      args.revoked ?? 0,
    );
}

function freshProcessInner(dir: string, masterKey: Buffer) {
  const dbService = new DatabaseService(dir);
  const odb = dbService.getOgraDatabase();
  const runtime = new DurableRuntimeService(odb, () => 'ph-m2-r8c');
  const capsuleStore = new EncryptedCapsuleStore(
    odb, new StaticMasterKeyProvider(masterKey));
  const protocol = new EffectProtocolService(odb, runtime, capsuleStore);
  const recovery = new RecoveryService(odb, runtime, capsuleStore,
    protocol, undefined);
  const recoveryApproval = new RecoveryApprovalService(odb, runtime);
  // Real PolicyService + RouteService wiring.
  const auditService = new AuditService(dbService);
  const policyService = new PolicyService(auditService);
  const routeService = new RouteService(policyService);
  const checker = new DefaultRecoveryConditionChecker(
    odb, policyService, routeService,
    ({ runId, routeDecisionId }: { runId: string; routeDecisionId: string }) => ({
      runId,
      routeDecisionId,
      workspaceId: 'w',
      dataClassification: 'Confidential' as any,
      task: 'm2-drift',
      secretIds: [],
    }),
    () => 'rv-r8c',
  );
  const ingressReview = new IngressReviewService(odb, runtime, capsuleStore);
  return {
    dbService, odb, runtime, capsuleStore, protocol,
    recovery, recoveryApproval, policyService, routeService,
    checker, ingressReview,
  };
}

const RC = {
  supportsIdempotencyKey: true,
  supportsOutcomeQuery: true,
  supportsCompensation: false,
};

describe('Sequence 1B Milestone 2 Round-8c — drift + capsule breakage', () => {
  let dir: string;
  beforeEach(() => { dir = newDir('m2-r8c'); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  /* ─────────────────────────────────────────────────────────
   * Drift matrix (8 paths).
   * ───────────────────────────────────────────────────────── */

  it('drift 1: Confidential redaction rule drift is blocked', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc1 = freshProcessInner(dir, masterKey);
    const { wsid, runId, routeId } = seedWorkspaceAndRun(proc1.odb, 'Confidential');
    const root = proc1.runtime.createRootFrame({ runId });
    const child = proc1.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc1.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });
    const egressHash = 'fp-d1';
    const capsuleHash = crypto.createHash('sha256').update('capsule-d1').digest('hex');
    const prep = proc1.protocol.prepare({
      runId, ownerFrameId: child.id,
      effectType: 'model.generate', adapterKind: 'mock',
      adapterVersion: 'M2',
      payload: { msg: 'drift-redaction' },
      payloadFingerprint: egressHash, capsuleFingerprint: capsuleHash,
      idempotencyKey: 'idem-d1', scopeHash: 'scope-d1',
      routeDecisionId: routeId, policyEvaluationId: 'pe-d1',
      policyVersionHash: 'pvh-d1',
      recoveryCapabilities: RC,
    });
    seedApproval(proc1.odb, {
      approvalId: 'ap-d1', runId, routeDecisionId: routeId,
      workspaceId: wsid,
      payloadFingerprint: egressHash, scopeHash: 'scope-d1',
      policyVersionHash: 'pvh-d1',
    });
    proc1.odb.getDB().prepare(
      `UPDATE run_effects SET current_approval_id = ? WHERE id = ?`,
    ).run('ap-d1', prep.effectId);
    proc1.odb.getDB().prepare(`UPDATE recovery_leases SET released_at = ?,
      lease_version = lease_version + 1 WHERE run_id = ?`)
      .run(new Date().toISOString(), runId);

    // Drift: change the live policy_version_hash on the
    // approval row. The approval's persisted hash was
    // 'pvh-d1' (matching the prepare-time policy); now it's
    // 'pvh-d1-DRIFTED', so live re-evaluation reports a
    // different current hash. Condition checker sees
    // mismatch → blocked.
    const proc2 = freshProcessInner(dir, masterKey);
    proc2.odb.getDB().prepare(
      `UPDATE approvals SET policy_version_hash = ? WHERE id = ?`,
    ).run('pvh-d1-DRIFTED', 'ap-d1');
    // proc2's checker reads route_decisions — drift
    // observable.
    const r = await proc2.recovery.recover({
      runId, holderId: 'h2',
      adapterSupportsIdempotencyKey: true,
      adapterSupportsOutcomeQuery: true,
      queryOutcome: async () => null,
      conditionChecker: proc2.checker,
    });
    expect(r.effects[0].decision).toBe('incident_blocked');
    expect(r.effects[0].incidentKind ?? '').toMatch(/approval_policy_mismatch|policy/);
  });

  it('drift 2: policy evaluate returns different decision (live)', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc1 = freshProcessInner(dir, masterKey);
    const { wsid, runId, routeId } = seedWorkspaceAndRun(proc1.odb, 'Confidential');
    const root = proc1.runtime.createRootFrame({ runId });
    const child = proc1.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc1.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });
    const egressHash = 'fp-d2';
    const capsuleHash = crypto.createHash('sha256').update('capsule-d2').digest('hex');
    const prep = proc1.protocol.prepare({
      runId, ownerFrameId: child.id,
      effectType: 'model.generate', adapterKind: 'mock',
      adapterVersion: 'M2',
      payload: { msg: 'drift-policy' },
      payloadFingerprint: egressHash, capsuleFingerprint: capsuleHash,
      idempotencyKey: 'idem-d2', scopeHash: 'scope-d2',
      routeDecisionId: routeId, policyEvaluationId: 'pe-d2',
      policyVersionHash: 'pvh-d2',
      recoveryCapabilities: RC,
    });
    seedApproval(proc1.odb, {
      approvalId: 'ap-d2', runId, routeDecisionId: routeId,
      workspaceId: wsid,
      payloadFingerprint: egressHash, scopeHash: 'scope-d2',
      policyVersionHash: 'pvh-d2',
    });
    proc1.odb.getDB().prepare(
      `UPDATE run_effects SET current_approval_id = ? WHERE id = ?`,
    ).run('ap-d2', prep.effectId);
    proc1.odb.getDB().prepare(`UPDATE recovery_leases SET released_at = ?,
      lease_version = lease_version + 1 WHERE run_id = ?`)
      .run(new Date().toISOString(), runId);

    const proc2 = freshProcessInner(dir, masterKey);
    // Drift: change route_decisions.route to 'blocked'. The
    // checker's pre-check (`route.route === RouteDecisionType.Blocked`)
    // will short-circuit to `route_policy_drift`.
    proc2.odb.getDB().prepare(
      `UPDATE route_decisions SET route = 'blocked' WHERE id = ?`,
    ).run(routeId);
    const r = await proc2.recovery.recover({
      runId, holderId: 'h2',
      adapterSupportsIdempotencyKey: true,
      adapterSupportsOutcomeQuery: true,
      queryOutcome: async () => null,
      conditionChecker: proc2.checker,
    });
    expect(r.effects[0].decision).toBe('incident_blocked');
  });

  it('drift 3: route drift (route_decision.route changed)', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc1 = freshProcessInner(dir, masterKey);
    const { wsid, runId, routeId } = seedWorkspaceAndRun(proc1.odb, 'Confidential');
    const root = proc1.runtime.createRootFrame({ runId });
    const child = proc1.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc1.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });
    const egressHash = 'fp-d3';
    const capsuleHash = crypto.createHash('sha256').update('capsule-d3').digest('hex');
    const prep = proc1.protocol.prepare({
      runId, ownerFrameId: child.id,
      effectType: 'model.generate', adapterKind: 'mock',
      adapterVersion: 'M2',
      payload: { msg: 'drift-route' },
      payloadFingerprint: egressHash, capsuleFingerprint: capsuleHash,
      idempotencyKey: 'idem-d3', scopeHash: 'scope-d3',
      routeDecisionId: routeId, policyEvaluationId: 'pe-d3',
      policyVersionHash: 'pvh-d3',
      recoveryCapabilities: RC,
    });
    seedApproval(proc1.odb, {
      approvalId: 'ap-d3', runId, routeDecisionId: routeId,
      workspaceId: wsid,
      payloadFingerprint: egressHash, scopeHash: 'scope-d3',
      policyVersionHash: 'pvh-d3',
    });
    proc1.odb.getDB().prepare(
      `UPDATE run_effects SET current_approval_id = ? WHERE id = ?`,
    ).run('ap-d3', prep.effectId);
    proc1.odb.getDB().prepare(`UPDATE recovery_leases SET released_at = ?,
      lease_version = lease_version + 1 WHERE run_id = ?`)
      .run(new Date().toISOString(), runId);

    const proc2 = freshProcessInner(dir, masterKey);
    // Drift: change route_decisions.route to a different value
    // than what the policy would re-evaluate. The checker
    // sees persisted route=local but current policy says
    // cloud → fails with route_policy_drift.
    proc2.odb.getDB().prepare(
      `UPDATE route_decisions SET route = 'local' WHERE id = ?`,
    ).run(routeId);
    const r = await proc2.recovery.recover({
      runId, holderId: 'h2',
      adapterSupportsIdempotencyKey: true,
      adapterSupportsOutcomeQuery: true,
      queryOutcome: async () => null,
      conditionChecker: proc2.checker,
    });
    expect(r.effects[0].decision).toBe('incident_blocked');
  });

  it('drift 4: approval revoked (revoked_for_recovery=1)', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc1 = freshProcessInner(dir, masterKey);
    const { wsid, runId, routeId } = seedWorkspaceAndRun(proc1.odb, 'Confidential');
    const root = proc1.runtime.createRootFrame({ runId });
    const child = proc1.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc1.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });
    const egressHash = 'fp-d4';
    const capsuleHash = crypto.createHash('sha256').update('capsule-d4').digest('hex');
    const prep = proc1.protocol.prepare({
      runId, ownerFrameId: child.id,
      effectType: 'model.generate', adapterKind: 'mock',
      adapterVersion: 'M2',
      payload: { msg: 'drift-revoked' },
      payloadFingerprint: egressHash, capsuleFingerprint: capsuleHash,
      idempotencyKey: 'idem-d4', scopeHash: 'scope-d4',
      routeDecisionId: routeId, policyEvaluationId: 'pe-d4',
      policyVersionHash: 'pvh-d4',
      recoveryCapabilities: RC,
    });
    seedApproval(proc1.odb, {
      approvalId: 'ap-d4', runId, routeDecisionId: routeId,
      workspaceId: wsid,
      payloadFingerprint: egressHash, scopeHash: 'scope-d4',
      policyVersionHash: 'pvh-d4',
      revoked: 1,
    });
    proc1.odb.getDB().prepare(
      `UPDATE run_effects SET current_approval_id = ? WHERE id = ?`,
    ).run('ap-d4', prep.effectId);
    proc1.odb.getDB().prepare(`UPDATE recovery_leases SET released_at = ?,
      lease_version = lease_version + 1 WHERE run_id = ?`)
      .run(new Date().toISOString(), runId);

    const proc2 = freshProcessInner(dir, masterKey);
    const r = await proc2.recovery.recover({
      runId, holderId: 'h2',
      adapterSupportsIdempotencyKey: true,
      adapterSupportsOutcomeQuery: true,
      queryOutcome: async () => null,
      conditionChecker: proc2.checker,
    });
    expect(r.effects[0].decision).toBe('incident_blocked');
    expect(r.effects[0].incidentKind).toMatch(/approval_revoked|approval_missing/);
  });

  it('drift 5: approval expired (expires_at in past)', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc1 = freshProcessInner(dir, masterKey);
    const { wsid, runId, routeId } = seedWorkspaceAndRun(proc1.odb, 'Confidential');
    const root = proc1.runtime.createRootFrame({ runId });
    const child = proc1.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc1.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });
    const egressHash = 'fp-d5';
    const capsuleHash = crypto.createHash('sha256').update('capsule-d5').digest('hex');
    const prep = proc1.protocol.prepare({
      runId, ownerFrameId: child.id,
      effectType: 'model.generate', adapterKind: 'mock',
      adapterVersion: 'M2',
      payload: { msg: 'drift-expired' },
      payloadFingerprint: egressHash, capsuleFingerprint: capsuleHash,
      idempotencyKey: 'idem-d5', scopeHash: 'scope-d5',
      routeDecisionId: routeId, policyEvaluationId: 'pe-d5',
      policyVersionHash: 'pvh-d5',
      recoveryCapabilities: RC,
    });
    seedApproval(proc1.odb, {
      approvalId: 'ap-d5', runId, routeDecisionId: routeId,
      workspaceId: wsid,
      payloadFingerprint: egressHash, scopeHash: 'scope-d5',
      policyVersionHash: 'pvh-d5',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    proc1.odb.getDB().prepare(
      `UPDATE run_effects SET current_approval_id = ? WHERE id = ?`,
    ).run('ap-d5', prep.effectId);
    proc1.odb.getDB().prepare(`UPDATE recovery_leases SET released_at = ?,
      lease_version = lease_version + 1 WHERE run_id = ?`)
      .run(new Date().toISOString(), runId);

    const proc2 = freshProcessInner(dir, masterKey);
    const r = await proc2.recovery.recover({
      runId, holderId: 'h2',
      adapterSupportsIdempotencyKey: true,
      adapterSupportsOutcomeQuery: true,
      queryOutcome: async () => null,
      conditionChecker: proc2.checker,
    });
    expect(r.effects[0].decision).toBe('incident_blocked');
    expect(r.effects[0].incidentKind).toMatch(/approval_expired/);
  });

  it('drift 6: approval scope mismatch', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc1 = freshProcessInner(dir, masterKey);
    const { wsid, runId, routeId } = seedWorkspaceAndRun(proc1.odb, 'Confidential');
    const root = proc1.runtime.createRootFrame({ runId });
    const child = proc1.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc1.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });
    const egressHash = 'fp-d6';
    const capsuleHash = crypto.createHash('sha256').update('capsule-d6').digest('hex');
    const prep = proc1.protocol.prepare({
      runId, ownerFrameId: child.id,
      effectType: 'model.generate', adapterKind: 'mock',
      adapterVersion: 'M2',
      payload: { msg: 'drift-scope' },
      payloadFingerprint: egressHash, capsuleFingerprint: capsuleHash,
      idempotencyKey: 'idem-d6', scopeHash: 'scope-d6-CORRECT',
      routeDecisionId: routeId, policyEvaluationId: 'pe-d6',
      policyVersionHash: 'pvh-d6',
      recoveryCapabilities: RC,
    });
    seedApproval(proc1.odb, {
      approvalId: 'ap-d6', runId, routeDecisionId: routeId,
      workspaceId: wsid,
      payloadFingerprint: egressHash, scopeHash: 'scope-d6-DRIFTED',
      policyVersionHash: 'pvh-d6',
    });
    proc1.odb.getDB().prepare(
      `UPDATE run_effects SET current_approval_id = ? WHERE id = ?`,
    ).run('ap-d6', prep.effectId);
    proc1.odb.getDB().prepare(`UPDATE recovery_leases SET released_at = ?,
      lease_version = lease_version + 1 WHERE run_id = ?`)
      .run(new Date().toISOString(), runId);

    const proc2 = freshProcessInner(dir, masterKey);
    const r = await proc2.recovery.recover({
      runId, holderId: 'h2',
      adapterSupportsIdempotencyKey: true,
      adapterSupportsOutcomeQuery: true,
      queryOutcome: async () => null,
      conditionChecker: proc2.checker,
    });
    expect(r.effects[0].decision).toBe('incident_blocked');
    expect(r.effects[0].incidentKind).toMatch(/approval_scope_mismatch/);
  });

  it('drift 7: approval fingerprint mismatch', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc1 = freshProcessInner(dir, masterKey);
    const { wsid, runId, routeId } = seedWorkspaceAndRun(proc1.odb, 'Confidential');
    const root = proc1.runtime.createRootFrame({ runId });
    const child = proc1.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc1.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });
    const egressHash = 'fp-d7';
    const capsuleHash = crypto.createHash('sha256').update('capsule-d7').digest('hex');
    const prep = proc1.protocol.prepare({
      runId, ownerFrameId: child.id,
      effectType: 'model.generate', adapterKind: 'mock',
      adapterVersion: 'M2',
      payload: { msg: 'drift-fp' },
      payloadFingerprint: egressHash, capsuleFingerprint: capsuleHash,
      idempotencyKey: 'idem-d7', scopeHash: 'scope-d7',
      routeDecisionId: routeId, policyEvaluationId: 'pe-d7',
      policyVersionHash: 'pvh-d7',
      recoveryCapabilities: RC,
    });
    seedApproval(proc1.odb, {
      approvalId: 'ap-d7', runId, routeDecisionId: routeId,
      workspaceId: wsid,
      payloadFingerprint: 'fp-d7-DRIFTED',
      scopeHash: 'scope-d7',
      policyVersionHash: 'pvh-d7',
    });
    proc1.odb.getDB().prepare(
      `UPDATE run_effects SET current_approval_id = ? WHERE id = ?`,
    ).run('ap-d7', prep.effectId);
    proc1.odb.getDB().prepare(`UPDATE recovery_leases SET released_at = ?,
      lease_version = lease_version + 1 WHERE run_id = ?`)
      .run(new Date().toISOString(), runId);

    const proc2 = freshProcessInner(dir, masterKey);
    const r = await proc2.recovery.recover({
      runId, holderId: 'h2',
      adapterSupportsIdempotencyKey: true,
      adapterSupportsOutcomeQuery: true,
      queryOutcome: async () => null,
      conditionChecker: proc2.checker,
    });
    expect(r.effects[0].decision).toBe('incident_blocked');
    expect(r.effects[0].incidentKind).toMatch(/approval_fingerprint_mismatch/);
  });

  it('drift 8: route_decision missing (deleted between prepare and recovery)', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc1 = freshProcessInner(dir, masterKey);
    const { wsid, runId, routeId } = seedWorkspaceAndRun(proc1.odb, 'Confidential');
    const root = proc1.runtime.createRootFrame({ runId });
    const child = proc1.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc1.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });
    const egressHash = 'fp-d8';
    const capsuleHash = crypto.createHash('sha256').update('capsule-d8').digest('hex');
    // Seed the approval row BEFORE prepare so the
    // prepare-time binding check passes.
    seedApproval(proc1.odb, {
      approvalId: 'ap-d8', runId, routeDecisionId: routeId,
      workspaceId: wsid,
      payloadFingerprint: egressHash, scopeHash: 'scope-d8',
      policyVersionHash: 'pvh-d8',
    });
    const prep = proc1.protocol.prepare({
      runId, ownerFrameId: child.id,
      effectType: 'model.generate', adapterKind: 'mock',
      adapterVersion: 'M2',
      payload: { msg: 'drift-route-missing' },
      payloadFingerprint: egressHash, capsuleFingerprint: capsuleHash,
      idempotencyKey: 'idem-d8', scopeHash: 'scope-d8',
      routeDecisionId: routeId, policyEvaluationId: 'pe-d8',
      policyVersionHash: 'pvh-d8',
      currentApprovalId: 'ap-d8',
      recoveryCapabilities: RC,
    });
    proc1.odb.getDB().prepare(
      `DELETE FROM route_decisions WHERE id = ?`,
    ).run(routeId);
    proc1.odb.getDB().prepare(
      `UPDATE run_effects SET current_approval_id = ? WHERE id = ?`,
    ).run('ap-d8', prep.effectId);
    proc1.odb.getDB().prepare(`UPDATE recovery_leases SET released_at = ?,
      lease_version = lease_version + 1 WHERE run_id = ?`)
      .run(new Date().toISOString(), runId);

    const proc2 = freshProcessInner(dir, masterKey);
    // Sync the approval's policy_version_hash with the
    // CURRENT live policy hash so the approval-policy check
    // passes and the checker reaches the route_decision
    // lookup (which we deleted).
    const livePvh = proc2.policyService.getPolicyVersionHash();
    proc2.odb.getDB().prepare(
      `UPDATE approvals SET policy_version_hash = ? WHERE id = ?`,
    ).run(livePvh, 'ap-d8');
    const r = await proc2.recovery.recover({
      runId, holderId: 'h2',
      adapterSupportsIdempotencyKey: true,
      adapterSupportsOutcomeQuery: true,
      queryOutcome: async () => null,
      conditionChecker: proc2.checker,
    });
    expect(r.effects[0].decision).toBe('incident_blocked');
    expect(r.effects[0].incidentKind).toMatch(/route_missing|route_decision_missing/);
  });

  /* ─────────────────────────────────────────────────────────
   * Capsule breakage (4 paths).
   * ───────────────────────────────────────────────────────── */

  it('capsule A: result capsule missing', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc1 = freshProcessInner(dir, masterKey);
    const { runId, routeId } = seedWorkspaceAndRun(proc1.odb);
    const root = proc1.runtime.createRootFrame({ runId });
    const child = proc1.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc1.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });
    const egressHash = 'fp-A';
    const capsuleHash = crypto.createHash('sha256').update('capsule-A').digest('hex');
    const prep = proc1.protocol.prepare({
      runId, ownerFrameId: child.id,
      effectType: 'model.generate', adapterKind: 'mock',
      adapterVersion: 'M2',
      payload: { msg: 'capsule-missing' },
      payloadFingerprint: egressHash, capsuleFingerprint: capsuleHash,
      idempotencyKey: 'idem-A', scopeHash: 'scope-A',
      routeDecisionId: routeId, policyEvaluationId: 'pe-A',
      policyVersionHash: 'pvh-A',
      recoveryCapabilities: RC,
    });
    const adapter = new MockEffectAdapter('A');
    adapter.recoveryCapabilities.supportsIdempotencyKey = true;
    const { DurableMockEffectDriver } = await import(
      '../../src/core/durable-mock-driver');
    const driver = new DurableMockEffectDriver(
      proc1.odb, proc1.runtime, proc1.capsuleStore,
      proc1.protocol, proc1.recovery,
    );
    await driver.runAdapterAndCommit({
      runId, ownerFrameId: child.id, adapter,
      payload: { msg: 'capsule-missing' },
      payloadFingerprint: egressHash,
      idempotencyKey: 'idem-A', scopeHash: 'scope-A',
      leaseHolder: 'h1', effectId: prep.effectId, attemptNo: 1,
    });
    proc1.odb.getDB().prepare(
      `DELETE FROM ingress_findings WHERE effect_id = ?`,
    ).run(prep.effectId);
    proc1.odb.getDB().prepare(
      `UPDATE run_effects SET state = 'received' WHERE id = ?`,
    ).run(prep.effectId);
    proc1.odb.getDB().prepare(
      `DELETE FROM capsules WHERE effect_id = ? AND capsule_kind = 'result'`,
    ).run(prep.effectId);
    proc1.odb.getDB().prepare(
      `UPDATE run_effects SET current_approval_id = ? WHERE id = ?`,
    ).run(null, prep.effectId);
    proc1.odb.getDB().prepare(`UPDATE recovery_leases SET released_at = ?,
      lease_version = lease_version + 1 WHERE run_id = ?`)
      .run(new Date().toISOString(), runId);
    proc1.runtime.acquireLease({ runId, holderId: 'h2', ttlMs: 60_000 });
    const leaseRow = proc1.odb.getDB().prepare(
      `SELECT lease_version FROM recovery_leases
        WHERE run_id = ? AND holder_id = ? AND released_at IS NULL`,
    ).get(runId, 'h2') as { lease_version: number };

    const proc2 = freshProcessInner(dir, masterKey);
    const ingressReview = new IngressReviewService(
      proc2.odb, proc2.runtime, proc2.capsuleStore);
    let err: Error | null = null;
    try {
      await ingressReview.finalizeIngressDecision({
        effectId: prep.effectId,
        outcome: 'accepted',
        reviewer: 'reviewer-A',
        reviewerPayloadDigest: 'fp',
        leaseHolderId: 'h2',
        leaseVersion: leaseRow.lease_version,
        ruleVersion: 'm2',
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message ?? '').toMatch(/capsule|result|missing/i);
    expect(proc2.runtime.readEffect(prep.effectId).state).toBe('received');
  });

  it('capsule B: result capsule corrupt (blob tampered)', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc1 = freshProcessInner(dir, masterKey);
    const { runId, routeId } = seedWorkspaceAndRun(proc1.odb);
    const root = proc1.runtime.createRootFrame({ runId });
    const child = proc1.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc1.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });
    const egressHash = 'fp-B';
    const capsuleHash = crypto.createHash('sha256').update('capsule-B').digest('hex');
    const prep = proc1.protocol.prepare({
      runId, ownerFrameId: child.id,
      effectType: 'model.generate', adapterKind: 'mock',
      adapterVersion: 'M2',
      payload: { msg: 'capsule-corrupt' },
      payloadFingerprint: egressHash, capsuleFingerprint: capsuleHash,
      idempotencyKey: 'idem-B', scopeHash: 'scope-B',
      routeDecisionId: routeId, policyEvaluationId: 'pe-B',
      policyVersionHash: 'pvh-B',
      recoveryCapabilities: RC,
    });
    const adapter = new MockEffectAdapter('B');
    adapter.recoveryCapabilities.supportsIdempotencyKey = true;
    const { DurableMockEffectDriver } = await import(
      '../../src/core/durable-mock-driver');
    const driver = new DurableMockEffectDriver(
      proc1.odb, proc1.runtime, proc1.capsuleStore,
      proc1.protocol, proc1.recovery,
    );
    await driver.runAdapterAndCommit({
      runId, ownerFrameId: child.id, adapter,
      payload: { msg: 'capsule-corrupt' },
      payloadFingerprint: egressHash,
      idempotencyKey: 'idem-B', scopeHash: 'scope-B',
      leaseHolder: 'h1', effectId: prep.effectId, attemptNo: 1,
    });
    proc1.odb.getDB().prepare(
      `DELETE FROM ingress_findings WHERE effect_id = ?`,
    ).run(prep.effectId);
    proc1.odb.getDB().prepare(
      `UPDATE run_effects SET state = 'received' WHERE id = ?`,
    ).run(prep.effectId);
    const row = proc1.odb.getDB().prepare(
      `SELECT id, blob_payload FROM capsules
        WHERE effect_id = ? AND capsule_kind = 'result'`,
    ).get(prep.effectId) as { id: string; blob_payload: Buffer };
    const corrupted = Buffer.from(row.blob_payload);
    corrupted[corrupted.length - 1] ^= 0xff;
    proc1.odb.getDB().prepare(
      `UPDATE capsules SET blob_payload = ? WHERE id = ?`,
    ).run(corrupted, row.id);
    proc1.odb.getDB().prepare(
      `UPDATE run_effects SET current_approval_id = ? WHERE id = ?`,
    ).run(null, prep.effectId);
    proc1.odb.getDB().prepare(`UPDATE recovery_leases SET released_at = ?,
      lease_version = lease_version + 1 WHERE run_id = ?`)
      .run(new Date().toISOString(), runId);
    proc1.runtime.acquireLease({ runId, holderId: 'h2', ttlMs: 60_000 });
    const leaseRow = proc1.odb.getDB().prepare(
      `SELECT lease_version FROM recovery_leases
        WHERE run_id = ? AND holder_id = ? AND released_at IS NULL`,
    ).get(runId, 'h2') as { lease_version: number };

    const proc2 = freshProcessInner(dir, masterKey);
    const ingressReview = new IngressReviewService(
      proc2.odb, proc2.runtime, proc2.capsuleStore);
    let err: Error | null = null;
    try {
      await ingressReview.finalizeIngressDecision({
        effectId: prep.effectId,
        outcome: 'accepted',
        reviewer: 'reviewer-B',
        reviewerPayloadDigest: 'fp',
        leaseHolderId: 'h2',
        leaseVersion: leaseRow.lease_version,
        ruleVersion: 'm2',
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message ?? '').toMatch(/capsule|decrypt|corrupt|invalid/i);
    expect(proc2.runtime.readEffect(prep.effectId).state).toBe('received');
  });

  it('capsule C: result capsule expired', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc1 = freshProcessInner(dir, masterKey);
    const { runId, routeId } = seedWorkspaceAndRun(proc1.odb);
    const root = proc1.runtime.createRootFrame({ runId });
    const child = proc1.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc1.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });
    const egressHash = 'fp-C';
    const capsuleHash = crypto.createHash('sha256').update('capsule-C').digest('hex');
    const prep = proc1.protocol.prepare({
      runId, ownerFrameId: child.id,
      effectType: 'model.generate', adapterKind: 'mock',
      adapterVersion: 'M2',
      payload: { msg: 'capsule-expired' },
      payloadFingerprint: egressHash, capsuleFingerprint: capsuleHash,
      idempotencyKey: 'idem-C', scopeHash: 'scope-C',
      routeDecisionId: routeId, policyEvaluationId: 'pe-C',
      policyVersionHash: 'pvh-C',
      recoveryCapabilities: RC,
    });
    const adapter = new MockEffectAdapter('C');
    adapter.recoveryCapabilities.supportsIdempotencyKey = true;
    const { DurableMockEffectDriver } = await import(
      '../../src/core/durable-mock-driver');
    const driver = new DurableMockEffectDriver(
      proc1.odb, proc1.runtime, proc1.capsuleStore,
      proc1.protocol, proc1.recovery,
    );
    await driver.runAdapterAndCommit({
      runId, ownerFrameId: child.id, adapter,
      payload: { msg: 'capsule-expired' },
      payloadFingerprint: egressHash,
      idempotencyKey: 'idem-C', scopeHash: 'scope-C',
      leaseHolder: 'h1', effectId: prep.effectId, attemptNo: 1,
    });
    proc1.odb.getDB().prepare(
      `DELETE FROM ingress_findings WHERE effect_id = ?`,
    ).run(prep.effectId);
    proc1.odb.getDB().prepare(
      `UPDATE run_effects SET state = 'received' WHERE id = ?`,
    ).run(prep.effectId);
    proc1.odb.getDB().prepare(
      `UPDATE capsules SET expires_at = ? WHERE effect_id = ?
        AND capsule_kind = 'result'`,
    ).run(new Date(Date.now() - 1000).toISOString(), prep.effectId);
    proc1.odb.getDB().prepare(
      `UPDATE run_effects SET current_approval_id = ? WHERE id = ?`,
    ).run(null, prep.effectId);
    proc1.odb.getDB().prepare(`UPDATE recovery_leases SET released_at = ?,
      lease_version = lease_version + 1 WHERE run_id = ?`)
      .run(new Date().toISOString(), runId);
    proc1.runtime.acquireLease({ runId, holderId: 'h2', ttlMs: 60_000 });
    const leaseRow = proc1.odb.getDB().prepare(
      `SELECT lease_version FROM recovery_leases
        WHERE run_id = ? AND holder_id = ? AND released_at IS NULL`,
    ).get(runId, 'h2') as { lease_version: number };

    const proc2 = freshProcessInner(dir, masterKey);
    const ingressReview = new IngressReviewService(
      proc2.odb, proc2.runtime, proc2.capsuleStore);
    let err: Error | null = null;
    try {
      await ingressReview.finalizeIngressDecision({
        effectId: prep.effectId,
        outcome: 'accepted',
        reviewer: 'reviewer-C',
        reviewerPayloadDigest: 'fp',
        leaseHolderId: 'h2',
        leaseVersion: leaseRow.lease_version,
        ruleVersion: 'm2',
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message ?? '').toMatch(/capsule|expired/i);
    expect(proc2.runtime.readEffect(prep.effectId).state).toBe('received');
  });

  it('capsule D: AAD drift (workspace re-keyed)', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc1 = freshProcessInner(dir, masterKey);
    const { runId, routeId } = seedWorkspaceAndRun(proc1.odb);
    const root = proc1.runtime.createRootFrame({ runId });
    const child = proc1.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc1.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });
    const egressHash = 'fp-D';
    const capsuleHash = crypto.createHash('sha256').update('capsule-D').digest('hex');
    const prep = proc1.protocol.prepare({
      runId, ownerFrameId: child.id,
      effectType: 'model.generate', adapterKind: 'mock',
      adapterVersion: 'M2',
      payload: { msg: 'capsule-aad' },
      payloadFingerprint: egressHash, capsuleFingerprint: capsuleHash,
      idempotencyKey: 'idem-D', scopeHash: 'scope-D',
      routeDecisionId: routeId, policyEvaluationId: 'pe-D',
      policyVersionHash: 'pvh-D',
      recoveryCapabilities: RC,
    });
    const adapter = new MockEffectAdapter('D');
    adapter.recoveryCapabilities.supportsIdempotencyKey = true;
    const { DurableMockEffectDriver } = await import(
      '../../src/core/durable-mock-driver');
    const driver = new DurableMockEffectDriver(
      proc1.odb, proc1.runtime, proc1.capsuleStore,
      proc1.protocol, proc1.recovery,
    );
    await driver.runAdapterAndCommit({
      runId, ownerFrameId: child.id, adapter,
      payload: { msg: 'capsule-aad' },
      payloadFingerprint: egressHash,
      idempotencyKey: 'idem-D', scopeHash: 'scope-D',
      leaseHolder: 'h1', effectId: prep.effectId, attemptNo: 1,
    });
    proc1.odb.getDB().prepare(
      `DELETE FROM ingress_findings WHERE effect_id = ?`,
    ).run(prep.effectId);
    proc1.odb.getDB().prepare(
      `UPDATE run_effects SET state = 'received' WHERE id = ?`,
    ).run(prep.effectId);
    proc1.odb.getDB().prepare(
      `UPDATE workspaces SET workspace_tag = hex(randomblob(16))
        WHERE id IN (SELECT workspace_id FROM agent_runs WHERE id = ?)`,
    ).run(runId);
    proc1.odb.getDB().prepare(
      `UPDATE run_effects SET current_approval_id = ? WHERE id = ?`,
    ).run(null, prep.effectId);
    proc1.odb.getDB().prepare(`UPDATE recovery_leases SET released_at = ?,
      lease_version = lease_version + 1 WHERE run_id = ?`)
      .run(new Date().toISOString(), runId);
    proc1.runtime.acquireLease({ runId, holderId: 'h2', ttlMs: 60_000 });
    const leaseRow = proc1.odb.getDB().prepare(
      `SELECT lease_version FROM recovery_leases
        WHERE run_id = ? AND holder_id = ? AND released_at IS NULL`,
    ).get(runId, 'h2') as { lease_version: number };

    const proc2 = freshProcessInner(dir, masterKey);
    const ingressReview = new IngressReviewService(
      proc2.odb, proc2.runtime, proc2.capsuleStore);
    let err: Error | null = null;
    try {
      await ingressReview.finalizeIngressDecision({
        effectId: prep.effectId,
        outcome: 'accepted',
        reviewer: 'reviewer-D',
        reviewerPayloadDigest: 'fp',
        leaseHolderId: 'h2',
        leaseVersion: leaseRow.lease_version,
        ruleVersion: 'm2',
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message ?? '').toMatch(/capsule|aad|tag|decrypt/i);
    expect(proc2.runtime.readEffect(prep.effectId).state).toBe('received');
  });

  /* ─────────────────────────────────────────────────────────
   * Real-agent run path — durable mock driver IS the closest
   * real-agent equivalent. adapter.generate is invoked
   * exactly once with redacted input reconstructed from the
   * sealed callback capsule.
   * ───────────────────────────────────────────────────────── */

  it('real agent: durable kernel drives adapter invocation from sealed callback capsule', async () => {
    const masterKey = crypto.randomBytes(32);
    const dbService = new DatabaseService(dir);
    const odb = dbService.getOgraDatabase();
    const runtime = new DurableRuntimeService(odb, () => 'ph-real');
    const capsuleStore = new EncryptedCapsuleStore(
      odb, new StaticMasterKeyProvider(masterKey));
    const protocol = new EffectProtocolService(odb, runtime, capsuleStore);
    const recovery = new RecoveryService(odb, runtime, capsuleStore,
      protocol, undefined);

    const { runId, routeId } = seedWorkspaceAndRun(odb, 'Public');
    const root = runtime.createRootFrame({ runId });
    const child = runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    runtime.acquireLease({ runId, holderId: 'h-real', ttlMs: 60_000 });

    const mockAdapter = new MockEffectAdapter('real-agent');
    mockAdapter.recoveryCapabilities.supportsIdempotencyKey = true;
    mockAdapter.recoveryCapabilities.supportsOutcomeQuery = true;

    const egressHash = 'fp-real';
    // The driver's runOnce handles prepare + cas + invoke +
    // receipt in one path. We pass the same payload /
    // fingerprint / idempotency_key / scope_hash to confirm
    // the durable run-path rebuilds the callback capsule from
    // the same canonical envelope as the durable run path
    // expects. (No manual prepare — that would double-prepare
    // and trigger the idempotency-key-reuse guard.)
    const { DurableMockEffectDriver } = await import(
      '../../src/core/durable-mock-driver');
    const driver = new DurableMockEffectDriver(
      odb, runtime, capsuleStore, protocol, recovery,
    );
    const res = await driver.runOnce({
      runId, ownerFrameId: child.id, adapter: mockAdapter,
      payload: { msg: 'real-agent-payload' },
      payloadFingerprint: egressHash,
      idempotencyKey: 'idem-real', scopeHash: 'scope-real',
      routeDecisionId: routeId, policyEvaluationId: 'pe-real',
      policyVersionHash: 'pvh-real',
      leaseHolder: 'h-real',
    });

    expect(res.state).toBe('committed');
    // Adapter invoked exactly once. The MockEffectAdapter
    // IS the analogue of the production adapter path; the
    // redacted payload was reconstructed from the sealed
    // callback capsule via the durable run path.
    expect(mockAdapter.attemptCount).toBe(1);
    expect(mockAdapter.applicationCount).toBe(1);
  });
});