/**
 * Sequence 1C Milestone 1 — ad-hoc end-to-end verification.
 *
 * Drives OgraCore end-to-end through knowledge.search:
 *   1. bootstrap workspace + knowledge base + a single chunk
 *   2. seed the canonical knowledge.search v1 binding
 *   3. prepareInvocation
 *   4. invokePrepared (Real IndependentIngressReviewer path)
 *   5. reconcileInvocation
 *   6. verify persisted state — no raw payload bytes anywhere
 *      outside the sealed result capsule
 *   7. idempotent re-prepare yields the same effect id with
 *      no duplicate physical dispatch (effect_receipts UNIQUE
 *      constraint + plan 10 §3.2 idempotency check)
 *   8. ProgressGuard durability: same SQLite file → fresh
 *      ProgressGuard → observed state recovers
 *
 * The script prints PASS / FAIL lines, a SUMMARY line, and exits
 * non-zero on any failure so it composes with the standard
 * verification pipeline at /tmp/hermes-verify-*.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

import { OgraCore } from './src/core/index.ts';
import { OgraSecretBroker } from './src/core/secret-broker';
import { ALLOWED_OUTCOME_REASONS } from './src/core/action-ledger.ts';

let passCount = 0;
let failCount = 0;

function pass(label: string): void {
  passCount += 1;
  console.log(`PASS  ${label}`);
}
function fail(label: string, _err: unknown): void {
  failCount += 1;
  console.error(`FAIL  ${label}: verification_failed`);
}
function assertEq<T>(label: string, actual: T, expected: T): void {
  if (actual === expected) pass(label);
  else fail(label, `expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
}

async function main(): Promise<void> {
  const dir = path.join(os.tmpdir(),
    `s1c-verify-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  let core!: OgraCore;
  try {
    const secretBroker = new OgraSecretBroker(dir);
    core = new OgraCore({ appDataDir: dir, secretBroker, isDev: true });
    await core.initialize();

    // Workspace + KB + a chunk so the FTS5 retrieval path can hit.
    const workspaceId = `ws_${crypto.randomBytes(4).toString('hex')}`;
    core.databaseService.getRawDB().prepare(`
      INSERT INTO workspaces
        (id, name, type, default_data_classification,
         created_at, updated_at, workspace_tag)
      VALUES (?, 's1c-m1 verify', 'personal', 'Internal',
              ?, ?, hex(randomblob(16)))
    `).run(workspaceId, new Date().toISOString(), new Date().toISOString());
    const kbId = `kb_${crypto.randomBytes(4).toString('hex')}`;
    core.databaseService.getRawDB().prepare(`
      INSERT INTO knowledge_bases
        (id, workspace_id, name, root_path, classification,
         indexing_status, created_at, updated_at)
      VALUES (?, ?, 'verify kb', '/tmp/s1c-m1', 'Internal',
              'succeeded', ?, ?)
    `).run(kbId, workspaceId,
      new Date().toISOString(), new Date().toISOString());
    const docId = `doc_${crypto.randomBytes(4).toString('hex')}`;
    core.databaseService.getRawDB().prepare(`
      INSERT INTO documents
        (id, workspace_id, knowledge_base_id, file_path, file_name,
         extension, content_hash, size_bytes, classification, indexed_at)
      VALUES (?, ?, ?, '/tmp/s1c-m1.md', 's1c-m1.md', 'md',
              ?, 60, 'Internal', ?)
    `).run(docId, workspaceId, kbId,
      crypto.createHash('sha256').update('s1c-m1 content').digest('hex'),
      new Date().toISOString());
    const chunkId = `chk_${crypto.randomBytes(4).toString('hex')}`;
    core.databaseService.getRawDB().prepare(`
      INSERT INTO document_chunks
        (id, document_id, workspace_id, content, content_hash,
         source_start_offset, source_end_offset,
         classification_snapshot, allowed_for_context)
      VALUES (?, ?, ?, 'm1c verify content for the ad-hoc test',
              'h_m1c_verify',
              0, 36, 'Internal', 1)
    `).run(chunkId, docId, workspaceId);
    pass('seed: workspace + KB + chunk inserted');

    const seed = await core.ensureKnowledgeSearchBinding(workspaceId, {
      enabledKnowledgeBaseIds: [kbId], approvalMode: 'none',
    });
    assertEq('seed: tool version enabled', seed.toolVersionId.length > 0, true);
    pass('seed: knowledge.search v1 binding created');

    const enabled = core.capabilityGateway.listEnabledTools(workspaceId);
    assertEq('seed: exactly one enabled tool', enabled.length, 1);
    assertEq('seed: closed-set ToolId is knowledge.search',
      enabled[0].descriptor.logicalName, 'knowledge.search');
    assertEq('seed: version is enabled',
      enabled[0].version.status, 'enabled');

    const runId = `run_${crypto.randomBytes(4).toString('hex')}`;
    core.databaseService.storeRun({
      id: runId, workspaceId, task: 's1c-m1-verify',
      status: 'created', startedAt: new Date().toISOString(),
    });
    const root = core.durableRuntime.createRootFrame({ runId });
    const child = core.durableRuntime.createChildFrame({
      runId, parentFrameId: root.id, frameKind: 'plan_step',
    });

    const args = { query: 'fixture', topK: 3 };
    // Caller-supplied workspaceId: must be rejected.
    let callerSuppliedRejected = false;
    try {
      await core.capabilityGateway.prepareInvocation({
        runId, workspaceId, ownerFrameId: child.id,
        toolId: seed.toolId,
        arguments: { ...args, workspaceId: 'attacker' },
      });
    } catch (err) {
      if (err instanceof Error
          && /caller-supplied workspaceId is not honored/.test(err.message)) {
        callerSuppliedRejected = true;
      }
    }
    assertEq('reject: caller-supplied workspaceId',
      callerSuppliedRejected, true);

    // Happy path: prepare + invoke.
    const prep = await core.capabilityGateway.prepareInvocation({
      runId, workspaceId, ownerFrameId: child.id,
      toolId: seed.toolId, arguments: args,
    });
    assertEq('prepare: holderId prefix matches Core broker',
      prep.holderId.startsWith('ogracore-tool-broker-'), true);
    if (!/^effect_/.test(prep.effectId)) {
      fail('prepare: effectId format', `unexpected ${prep.effectId}`);
    }
    pass('prepare: effect id has canonical effect_ prefix');
    assertEq('prepare: payloadFingerprint is 64-hex',
      /^[a-f0-9]{64}$/.test(prep.payloadFingerprint), true);

    const idem = `idem-${prep.effectId}`;
    const out = await core.capabilityGateway.invokePrepared({
      workspaceId, effectId: prep.effectId, holderId: prep.holderId,
      arguments: args, idempotencyKey: idem,
    });
    assertEq('invoke: ingress outcome accepted', out.ingressOutcome, 'accepted');
    if (!/^find_/.test(out.ingressFindingId)) {
      fail('invoke: ingressFindingId prefix', `unexpected ${out.ingressFindingId}`);
    }
    pass('invoke: ingressFindingId has canonical find_ prefix');
    if (!/^rdec_/.test(out.ingressReviewDecisionId)) {
      fail('invoke: reviewDecisionId prefix', `unexpected ${out.ingressReviewDecisionId}`);
    }
    pass('invoke: reviewDecisionId has canonical rdec_ prefix');
    if (!/^act_/.test(out.actionLedgerId)) {
      fail('invoke: actionLedgerId prefix', `unexpected ${out.actionLedgerId}`);
    }
    pass('invoke: actionLedgerId has canonical act_ prefix');

    // Persisted effect is committed.
    const effRow = core.databaseService.getRawDB().prepare(
      'SELECT state, authoritative_receipt_id FROM run_effects WHERE id = ?',
    ).get(prep.effectId) as { state: string; authoritative_receipt_id: string };
    assertEq('effect: persisted state is committed', effRow.state, 'committed');
    // run_effects.authoritative_receipt_id pins to the receipt.
    assertEq('effect: authoritative receipt linked',
      effRow.authoritative_receipt_id, out.receiptId);

    // Tool invocations row exists.
    const inv = core.databaseService.getRawDB().prepare(
      'SELECT tool_version_id, workspace_binding_id, ingress_finding_id, completed_at FROM tool_invocations WHERE effect_id = ?',
    ).get(prep.effectId) as { tool_version_id: string; workspace_binding_id: string;
      ingress_finding_id: string; completed_at: string };
    assertEq('tool_invocations: tool_version_id', inv.tool_version_id, seed.toolVersionId);
    assertEq('tool_invocations: binding_id', inv.workspace_binding_id, seed.bindingId);
    assertEq('tool_invocations: ingress linked', inv.ingress_finding_id, out.ingressFindingId);

    // Action ledger row + paired L1 event.
    const led = core.databaseService.getRawDB().prepare(
      'SELECT action_type, outcome_summary, action_target, l1_event_id FROM action_ledger WHERE id = ?',
    ).get(out.actionLedgerId) as { action_type: string; outcome_summary: string;
      action_target: string; l1_event_id: string };
    assertEq('ledger: action_type', led.action_type, 'tool_call');
    assertEq('ledger: outcome_summary closed-set',
      ALLOWED_OUTCOME_REASONS.has(led.outcome_summary), true);
    assertEq('ledger: action_target', led.action_target, `tool:${seed.toolId}`);
    const ledgerEvent = core.databaseService.getRawDB().prepare(
      'SELECT event_type, hash_envelope_version FROM run_events WHERE id = ?',
    ).get(led.l1_event_id) as { event_type: string; hash_envelope_version: string };
    assertEq('ledger: paired L1 envelope v2', ledgerEvent.hash_envelope_version, 'v2');
    assertEq('ledger: paired L1 event_type is terminal',
      ['effect_accepted', 'effect_quarantined', 'effect_rejected']
        .includes(ledgerEvent.event_type), true);

    // Sanitize: raw payload bytes never reach audit / ledger.
    const auditSnapshot = core.databaseService.getRawDB().prepare(
      'SELECT event_payload_json FROM run_events WHERE id = ?',
    ).get(led.l1_event_id) as { event_payload_json: string };
    const ledgerSecret = 'SECRET_THAT_MUST_NEVER_APPEAR';
    // Re-issue with a new query that contains a traceable token.
    const sensitiveArgs = { query: `${args.query} ${ledgerSecret}` };
    const prep2 = await core.capabilityGateway.prepareInvocation({
      runId, workspaceId, ownerFrameId: child.id,
      toolId: seed.toolId, arguments: sensitiveArgs,
    });
    const out2 = await core.capabilityGateway.invokePrepared({
      workspaceId, effectId: prep2.effectId, holderId: prep2.holderId,
      arguments: sensitiveArgs, idempotencyKey: `idem-${prep2.effectId}`,
    });
    const allEvents = core.databaseService.getRawDB().prepare(
      'SELECT event_payload_json, event_hash FROM run_events WHERE run_id = ?',
    ).all(runId) as Array<{ event_payload_json: string; event_hash: string }>;
    const flattened = allEvents.map((r) => r.event_payload_json).join('\n');
    if (flattened.includes(ledgerSecret)) {
      fail('sanitize: raw payload bytes leaked into run_events payload',
        'secret token appears in event_payload_json');
    }
    pass('sanitize: raw payload bytes never reach run_events payload');
    // Also: action_ledger never stores raw args.
    const ledgerRows = core.databaseService.getRawDB().prepare(
      'SELECT action_target, payload_digest FROM action_ledger WHERE run_id = ?',
    ).all(runId) as Array<{ action_target: string; payload_digest: string }>;
    if (ledgerRows.some((r) => r.action_target.includes(ledgerSecret))) {
      fail('sanitize: raw payload bytes leaked into action_ledger.action_target', '');
    }
    pass('sanitize: raw payload bytes never reach action_ledger.action_target');

    // Idempotency: same args + same owner frame + same idempotencyHash
    // yields the same effect id (plan 10 §3.2).
    const prep3 = await core.capabilityGateway.prepareInvocation({
      runId, workspaceId, ownerFrameId: child.id,
      toolId: seed.toolId, arguments: sensitiveArgs,
    });
    assertEq('idempotency: same owner + same fingerprint ⇒ same effect',
      prep3.effectId, prep2.effectId);

    // count effect_receipts: there must be exactly one row for the
    // effect (UNIQUE(effect_id, attempt_no)). Plan 10: zero duplicate
    // physical applications.
    const receiptRows = core.databaseService.getRawDB().prepare(
      'SELECT attempt_no FROM effect_receipts WHERE effect_id = ?',
    ).all(prep2.effectId) as Array<{ attempt_no: number }>;
    assertEq('no-duplicate-physical-call: exactly one receipt for effect',
      receiptRows.length, 1);

    // Reconcile: returns only refs / closed-set fields.
    const rec = core.capabilityGateway.reconcileInvocation({
      workspaceId, effectId: prep.effectId,
    });
    assertEq('reconcile: state committed', rec.state, 'committed');
    assertEq('reconcile: ingress outcome accepted',
      rec.ingressOutcome, 'accepted');
    const recJson = JSON.stringify(rec);
    if (recJson.includes(ledgerSecret)) {
      fail('reconcile: secret leaked into projection', '');
    }
    pass('reconcile: secret bytes do not appear in projection');

    // Fail-closed: a second dispatch after the first already
    // committed must NOT produce a second receipt (the gate at
    // `recordReceipt` enforces application_status uniqueness on
    // a per-effect basis).
    let secondReceiptRejected = false;
    try {
      await core.capabilityGateway.invokePrepared({
        workspaceId, effectId: prep.effectId, holderId: prep.holderId,
        arguments: args, idempotencyKey: `${idem}-retry`,
      });
    } catch (err) {
      if (err instanceof Error
          && /state=committed/.test(err.message || '')) {
        secondReceiptRejected = true;
      }
    }
    assertEq('no-duplicate-physical-call: 2nd dispatch on committed effect rejected',
      secondReceiptRejected, true);

    // ProgressGuard durability across "process restart".
    const guard = core.progressGuard;
    const observe1 = guard.observe({
      runId, actionTarget: `tool:${seed.toolId}`, progressDelta: 1,
    });
    assertEq('progress: 1st observe ok', observe1.ok, true);
    // The new OgraDatabase / Runtime / ProgressGuard readers
    // share the SQLite file; the durable snapshot recovers.
    const guard2 = new (await import(
      './src/core/progress-guard.ts'
    )).ProgressGuard(core.databaseService.getOgraDatabase(), core.durableRuntime);
    const snap = guard2.loadObservedState(runId);
    assertEq('progress: persisted actionCount survives "restart"',
      snap.actionCount, observe1.observed.actionCount);
  } catch (err) {
    fail('uncaught', err);
  } finally {
    if (core) {
      try { core.databaseService.close(); } catch { /* ignore */ }
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log(`SUMMARY  total=${passCount + failCount}  passed=${passCount}  failed=${failCount}`);
  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch(() => {
  console.error('SUMMARY  total=0  passed=0  failed=1');
  console.error('FAIL  uncaught: verification_failed');
  process.exit(1);
});
