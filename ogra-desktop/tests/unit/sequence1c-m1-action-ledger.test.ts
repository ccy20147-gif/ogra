/**
 * Sequence 1C Milestone 1 — Action Ledger.
 *
 * Coverage:
 *   - closed-set enforcement (action_type / source_kind / outcome)
 *   - sha256 digest regex enforcement
 *   - action_target regex enforcement (lowercase prefix : name)
 *   - paired L1 v2 audit event written in same SQLite transaction
 *   - audit_edges `frame -> has_action_ledger -> event` written
 *   - raw payload never persisted (digest only)
 *   - listForRun + projectionForRun return only sanitized fields
 *   - hashPayload helper matches canonicalJSON
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

import { OgraDatabase } from '../../src/core/database';
import { DatabaseService } from '../../src/core/database-service';
import { DurableRuntimeService } from '../../src/core/durable-runtime-service';
import { ActionLedgerService, ALLOWED_OUTCOME_REASONS } from '../../src/core/action-ledger';
import { OgraError, OgraErrorCode } from '../../src/shared/errors';
import { canonicalJSON } from '../../src/core/audit-envelope';

function newTmpDir(prefix: string): string {
  const d = path.join(os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function seedRun(odb: OgraDatabase, workspaceId: string): {
  runId: string; frameId: string;
} {
  const runId = `run_${crypto.randomBytes(4).toString('hex')}`;
  odb.getDB().prepare(`
    INSERT INTO agent_runs
      (id, workspace_id, task, status, started_at)
    VALUES (?, ?, 'm1c-al', 'created', ?)
  `).run(runId, workspaceId, new Date().toISOString());
  const frameId = `frm_${crypto.randomBytes(4).toString('hex')}`;
  odb.getDB().prepare(`
    INSERT INTO run_frames
      (id, run_id, parent_frame_id, run_step_id, frame_kind, status,
       path_json, node_revision, subtree_revision,
       input_hash, output_hash,
       created_event_id, terminal_event_id, created_at, updated_at)
    VALUES (?, ?, NULL, NULL, 'root', 'running',
            '[]', 1, 1,
            NULL, NULL,
            NULL, NULL, ?, ?)
  `).run(frameId, runId, new Date().toISOString(), new Date().toISOString());
  return { runId, frameId };
}

interface WireProcess {
  dir: string; cleanup: () => void;
  odb: OgraDatabase; runtime: DurableRuntimeService;
  ledger: ActionLedgerService;
  workspaceId: string; runId: string; frameId: string;
}

function wireProcess(): WireProcess {
  const dir = newTmpDir('s1c-al');
  // Both OgraDatabase + DatabaseService open the same file. Use
  // the database-service's open path so migrations run.
  const dbService = new DatabaseService(dir);
  dbService.initialize();
  const odb = new OgraDatabase(dir);
  const runtime = new DurableRuntimeService(
    odb,
    () => 'pvh_default_for_test',
    () => 'rv_default_for_test',
  );
  const ledger = new ActionLedgerService(odb, runtime);
  const workspaceId = `ws_${crypto.randomBytes(4).toString('hex')}`;
  odb.getDB().prepare(`
    INSERT INTO workspaces (id, name, type, default_data_classification,
                           created_at, updated_at, workspace_tag)
    VALUES (?, 'm1c-al ws', 'personal', 'Internal',
            ?, ?, hex(randomblob(16)))
  `).run(workspaceId,
    new Date().toISOString(), new Date().toISOString());
  const { runId, frameId } = seedRun(odb, workspaceId);
  const cleanup = () => {
    dbService.close(); odb.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  };
  return { dir, cleanup, odb, runtime, ledger,
           workspaceId, runId, frameId };
}

describe('Sequence 1C M1 — Action Ledger', () => {
  let proc: WireProcess;
  beforeEach(() => { proc = wireProcess(); });
  afterEach(() => { if (proc) proc.cleanup(); });

  it('recordAction: writes the ledger row + a paired L1 v2 audit event in one SQLite txn', () => {
    const res = proc.ledger.recordAction({
      runId: proc.runId,
      workspaceId: proc.workspaceId,
      frameId: proc.frameId,
      actionType: 'tool_call',
      actionTarget: 'tool:knowledge.search',
      sourceKind: 'production',
      payloadDigest: ActionLedgerService.hashPayload({ foo: 'bar' }),
      ruleVersion: 's1c-m1',
      outcomeSummary: 'tool_invocation_committed',
    });
    expect(res.id).toMatch(/^act_/);
    expect(res.sequenceNo).toBe(1);
    expect(res.l1EventId).toMatch(/^evt_/);
    const ledgerRow = proc.odb.getDB().prepare(
      'SELECT * FROM action_ledger WHERE id = ?',
    ).get(res.id) as Record<string, unknown>;
    expect(ledgerRow['run_id']).toBe(proc.runId);
    expect(ledgerRow['frame_id']).toBe(proc.frameId);
    expect(ledgerRow['action_type']).toBe('tool_call');
    expect(ledgerRow['source_kind']).toBe('production');
    expect(ledgerRow['outcome_summary']).toBe('tool_invocation_committed');
    expect(ledgerRow['l1_event_id']).toBe(res.l1EventId);
    const eventRow = proc.odb.getDB().prepare(
      'SELECT * FROM run_events WHERE id = ?',
    ).get(res.l1EventId) as Record<string, unknown>;
    expect(eventRow).toBeDefined();
    expect(eventRow['event_type']).toBe('ledger_record');
    expect(eventRow['frame_id']).toBe(proc.frameId);
    expect(eventRow['hash_envelope_version']).toBe('v2');
    // Audit edge from frame -> ledger-event is emitted so audit
    // packets can walk forward from the frame root.
    const edge = proc.odb.getDB().prepare(
      `SELECT * FROM audit_edges
        WHERE run_id = ? AND relation = 'has_action_ledger'
          AND source_event_id = ?`,
    ).get(proc.runId, res.l1EventId) as Record<string, unknown>;
    expect(edge).toBeDefined();
    expect(edge['from_kind']).toBe('frame');
    expect(edge['to_kind']).toBe('event');
  });

  it('recordAction: rejects non-closed-set actionType', () => {
    expect(() => proc.ledger.recordAction({
      runId: proc.runId, workspaceId: proc.workspaceId, frameId: proc.frameId,
      actionType: 'rogue_action' as unknown as 'tool_call',
      actionTarget: 'tool:knowledge.search', sourceKind: 'production',
      payloadDigest: ActionLedgerService.hashPayload({}),
      ruleVersion: 's1c-m1',
    })).toThrow(OgraError);
  });

  it('recordAction: rejects non-closed-set sourceKind', () => {
    expect(() => proc.ledger.recordAction({
      runId: proc.runId, workspaceId: proc.workspaceId, frameId: proc.frameId,
      actionType: 'tool_call', actionTarget: 'tool:knowledge.search',
      sourceKind: 'rogue_kind' as unknown as 'production',
      payloadDigest: ActionLedgerService.hashPayload({}),
      ruleVersion: 's1c-m1',
    })).toThrow(/not in the closed set/);
  });

  it('recordAction: rejects non-closed-set outcome; sanitizes to closed_set_violation', () => {
    const res = proc.ledger.recordAction({
      runId: proc.runId, workspaceId: proc.workspaceId, frameId: proc.frameId,
      actionType: 'tool_call', actionTarget: 'tool:knowledge.search',
      sourceKind: 'production',
      payloadDigest: ActionLedgerService.hashPayload({}),
      ruleVersion: 's1c-m1',
      outcomeSummary: 'attacker-controlled-string',
    });
    const row = proc.odb.getDB().prepare(
      'SELECT outcome_summary FROM action_ledger WHERE id = ?',
    ).get(res.id) as { outcome_summary: string };
    expect(row.outcome_summary).toBe('closed_set_violation');
  });

  it('recordAction: rejects payload_digest that is not a 64-char hex sha256', () => {
    expect(() => proc.ledger.recordAction({
      runId: proc.runId, workspaceId: proc.workspaceId, frameId: proc.frameId,
      actionType: 'tool_call', actionTarget: 'tool:knowledge.search',
      sourceKind: 'production',
      payloadDigest: 'not-a-real-digest',
      ruleVersion: 's1c-m1',
    })).toThrow(/MUST be a 64-char hex sha256/);
  });

  it('recordAction: rejects action_target that does not match `^[a-z]+:[a-z0-9_\\-:.]+$`', () => {
    expect(() => proc.ledger.recordAction({
      runId: proc.runId, workspaceId: proc.workspaceId, frameId: proc.frameId,
      actionType: 'tool_call', actionTarget: 'Tool:Capitalised',
      sourceKind: 'production',
      payloadDigest: ActionLedgerService.hashPayload({}),
      ruleVersion: 's1c-m1',
    })).toThrow(/action_target MUST match/);
    expect(() => proc.ledger.recordAction({
      runId: proc.runId, workspaceId: proc.workspaceId, frameId: proc.frameId,
      actionType: 'tool_call', actionTarget: 'no-colon',
      sourceKind: 'production',
      payloadDigest: ActionLedgerService.hashPayload({}),
      ruleVersion: 's1c-m1',
    })).toThrow();
  });

  it('recordAction: sequence_no is monotonic per run', () => {
    const a = proc.ledger.recordAction({
      runId: proc.runId, workspaceId: proc.workspaceId, frameId: proc.frameId,
      actionType: 'agent_step', actionTarget: 'agent:plan_step',
      sourceKind: 'production',
      payloadDigest: ActionLedgerService.hashPayload({ s: 1 }),
      ruleVersion: 's1c-m1', outcomeSummary: 'agent_step_planned',
    });
    const b = proc.ledger.recordAction({
      runId: proc.runId, workspaceId: proc.workspaceId, frameId: proc.frameId,
      actionType: 'agent_step', actionTarget: 'agent:plan_step',
      sourceKind: 'production',
      payloadDigest: ActionLedgerService.hashPayload({ s: 2 }),
      ruleVersion: 's1c-m1', outcomeSummary: 'agent_step_committed',
    });
    expect(a.sequenceNo).toBe(1);
    expect(b.sequenceNo).toBe(2);
  });

  it('projectionForRun: returns sanitized fields only — never raw payload', () => {
    const secret = 'TOP-SECRET-RETRIEVED-FROM-RAG';
    const digest = ActionLedgerService.hashPayload({ secret });
    proc.ledger.recordAction({
      runId: proc.runId, workspaceId: proc.workspaceId, frameId: proc.frameId,
      actionType: 'tool_call', actionTarget: 'tool:knowledge.search',
      sourceKind: 'production',
      payloadDigest: digest,
      ruleVersion: 's1c-m1', outcomeSummary: 'tool_invocation_committed',
    });
    const projection = proc.ledger.projectionForRun(proc.runId);
    expect(projection).toHaveLength(1);
    const row = projection[0];
    expect(row.payloadDigest).toBe(digest);
    // The raw secret must never appear in the projection.
    const projectionJson = JSON.stringify(projection);
    expect(projectionJson).not.toContain(secret);
    // The raw digest bytes are never visible either.
    expect(row.actionType).toBe('tool_call');
    expect(row.outcomeSummary).toBe('tool_invocation_committed');
  });

  it('hashPayload: matches canonicalJSON(sha256)', () => {
    const payload = { b: 1, a: 2, list: [{ y: 1, x: 2 }, 3] };
    const expected = crypto.createHash('sha256')
      .update(canonicalJSON(payload)).digest('hex');
    expect(ActionLedgerService.hashPayload(payload)).toBe(expected);
  });

  it('listForRun: ordering is by sequence_no ASC', () => {
    for (const outcome of ['agent_step_planned', 'agent_step_committed', 'agent_step_committed']) {
      proc.ledger.recordAction({
        runId: proc.runId, workspaceId: proc.workspaceId, frameId: proc.frameId,
        actionType: 'agent_step', actionTarget: 'agent:plan_step',
        sourceKind: 'production',
        payloadDigest: ActionLedgerService.hashPayload({ outcome }),
        ruleVersion: 's1c-m1', outcomeSummary: outcome,
      });
    }
    const rows = proc.ledger.listForRun(proc.runId);
    expect(rows.map((r) => r.sequenceNo)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.outcomeSummary)).toEqual([
      'agent_step_planned', 'agent_step_committed', 'agent_step_committed',
    ]);
  });

  it('lastForRun: returns the highest sequence_no for a run', () => {
    proc.ledger.recordAction({
      runId: proc.runId, workspaceId: proc.workspaceId, frameId: proc.frameId,
      actionType: 'guard_decision', actionTarget: 'guard:budget_exhausted',
      sourceKind: 'production',
      payloadDigest: ActionLedgerService.hashPayload({ a: 1 }),
      ruleVersion: 's1c-m1', outcomeSummary: 'guard_budget_exhausted_action_count',
    });
    proc.ledger.recordAction({
      runId: proc.runId, workspaceId: proc.workspaceId, frameId: proc.frameId,
      actionType: 'recovery_decision', actionTarget: 'recovery:reconcile',
      sourceKind: 'production',
      payloadDigest: ActionLedgerService.hashPayload({ a: 2 }),
      ruleVersion: 's1c-m1', outcomeSummary: 'recovery_decided',
    });
    const last = proc.ledger.lastForRun(proc.runId);
    expect(last?.actionType).toBe('recovery_decision');
    expect(last?.sequenceNo).toBe(2);
  });

  it('ALLOWED_OUTCOME_REASONS exposes the canonical closed set the production ledger accepts', () => {
    // A non-empty sanity check: the production code uses these
    // names. Mutation of this set is a hard code change.
    expect(ALLOWED_OUTCOME_REASONS.has('tool_invocation_committed')).toBe(true);
    expect(ALLOWED_OUTCOME_REASONS.has('guard_loop_detected')).toBe(true);
    expect(ALLOWED_OUTCOME_REASONS.has('recovery_decided')).toBe(true);
    expect(ALLOWED_OUTCOME_REASONS.has('ingress_rejected')).toBe(true);
    expect(ALLOWED_OUTCOME_REASONS.has('approval_revoked_for_recovery')).toBe(true);
    expect(ALLOWED_OUTCOME_REASONS.has('closed_set_violation')).toBe(true);
    expect(ALLOWED_OUTCOME_REASONS.has('arbitrary_text_outcome')).toBe(false);
  });
});
