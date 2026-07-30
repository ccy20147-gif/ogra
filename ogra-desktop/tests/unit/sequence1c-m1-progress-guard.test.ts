import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

import { OgraDatabase } from '../../src/core/database';
import { DatabaseService } from '../../src/core/database-service';
import { DurableRuntimeService } from '../../src/core/durable-runtime-service';
import { ProgressGuard } from '../../src/core/progress-guard';
import { OgraError, OgraErrorCode } from '../../src/shared/errors';

function newTmpDir(prefix: string): string {
  return path.join(os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
}

function seedRun(odb: OgraDatabase): { runId: string } {
  const wsid = `ws_${crypto.randomBytes(4).toString('hex')}`;
  odb.getDB().prepare(`
    INSERT INTO workspaces (id, name, type, default_data_classification,
                           created_at, updated_at, workspace_tag)
    VALUES (?, 'pg ws', 'personal', 'Public',
            ?, ?, hex(randomblob(16)))
  `).run(wsid, new Date().toISOString(), new Date().toISOString());
  const runId = `run_${crypto.randomBytes(4).toString('hex')}`;
  odb.getDB().prepare(`
    INSERT INTO agent_runs
      (id, workspace_id, task, status, started_at)
    VALUES (?, ?, 'pg test', 'created', ?)
  `).run(runId, wsid, new Date().toISOString());
  return { runId };
}

interface WireProcess {
  cleanup: () => void;
  odb: OgraDatabase; runtime: DurableRuntimeService; guard: ProgressGuard;
  runId: string;
}

function wireProcess(opts?: { maxActionCount?: number; repeatWindow?: number;
  repeatThreshold?: number; maxTotalSteps?: number;
  maxUniqueActions?: number; maxWallClockMs?: number;
  stagnationMs?: number;
}): WireProcess {
  const dir = newTmpDir('s1c-pg');
  fs.mkdirSync(dir, { recursive: true });
  const dbService = new DatabaseService(dir);
  dbService.initialize();
  const odb = new OgraDatabase(dir);
  const runtime = new DurableRuntimeService(
    odb,
    () => 'pvh_default',
    () => 'rv_default',
  );
  const guard = new ProgressGuard(odb, runtime, opts);
  const { runId } = seedRun(odb);
  return {
    odb, runtime, guard, runId,
    cleanup: () => {
      dbService.close(); odb.close();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

describe('Sequence 1C M1 — ProgressGuard', () => {
  let proc: WireProcess;
  beforeEach(() => { proc = wireProcess(); });
  afterEach(() => { if (proc) proc.cleanup(); });

  it('observe: bumps action_count + persisted snapshot row', () => {
    const res1 = proc.guard.observe({
      runId: proc.runId,
      actionTarget: 'tool:knowledge.search',
    });
    expect(res1.ok).toBe(true);
    expect(res1.observed.actionCount).toBe(1);
    expect(res1.observed.lastRepeatTarget).toBe('tool:knowledge.search');
    expect(res1.observed.lastRepeatCount).toBe(1);
    const snap = proc.odb.getDB().prepare(
      'SELECT action_count, last_repeat_target, guard_terminated FROM progress_run_state WHERE run_id = ?',
    ).get(proc.runId) as { action_count: number; last_repeat_target: string; guard_terminated: number };
    expect(snap.action_count).toBe(1);
    expect(snap.last_repeat_target).toBe('tool:knowledge.search');
    expect(snap.guard_terminated).toBe(0);
  });

  it('observe: rejects action_target outside the closed regex', () => {
    expect(() => proc.guard.observe({
      runId: proc.runId, actionTarget: 'Tool:Capitalised',
    })).toThrow(/actionTarget MUST match/);
  });

  it('budget: action_count > max returns ok=false and terminates the run', () => {
    const dir = path.join(os.tmpdir(),
      `s1c-pg-cap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(dir, { recursive: true });
    const dbService = new DatabaseService(dir);
    dbService.initialize();
    const odb = new OgraDatabase(dir);
    const runtime = new DurableRuntimeService(odb,
      () => 'pvh', () => 'rv');
    const guard = new ProgressGuard(odb, runtime, { maxActionCount: 3 });
    const { runId } = seedRun(odb);
    for (let i = 0; i < 3; i++) {
      const r = guard.observe({
        runId,
        actionTarget: i % 2 === 0 ? 'tool:knowledge.search' : 'tool:summarize',
        progressDelta: 1,
      });
      expect(r.ok).toBe(true);
    }
    const over = guard.observe({
      runId,
      actionTarget: 'tool:knowledge.search',
    });
    expect(over.ok).toBe(false);
    expect(over.reasonCode).toBe('guard_budget_exhausted_action_count');
    // Subsequent observe calls return the same reason code
    // without further mutation.
    const second = guard.observe({
      runId,
      actionTarget: 'tool:knowledge.search',
    });
    expect(second.ok).toBe(false);
    expect(second.reasonCode).toBe('guard_budget_exhausted_action_count');
    expect(second.sequenceNo).toBeNull();
    // Sanity: the durable snapshot reflects the termination.
    const snap = odb.getDB().prepare(
      'SELECT guard_terminated, termination_reason_code FROM progress_run_state WHERE run_id = ?',
    ).get(runId) as { guard_terminated: number; termination_reason_code: string };
    expect(snap.guard_terminated).toBe(1);
    expect(snap.termination_reason_code).toBe('guard_budget_exhausted_action_count');
    dbService.close(); odb.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('crash recovery: durable snapshot is the SOLE source of truth across "process restart"', () => {
    const dir = path.join(os.tmpdir(),
      `s1c-pg-crash-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(dir, { recursive: true });
    const dbService = new DatabaseService(dir);
    dbService.initialize();
    const odb = new OgraDatabase(dir);
    const runtime = new DurableRuntimeService(odb,
      () => 'pvh', () => 'rv');
    // Disable loop + stagnation for this restart test by raising
    // thresholds; we only want to verify observed counters persist.
    const guard = new ProgressGuard(odb, runtime, {
      maxActionCount: 10, repeatThreshold: 999,
      stagnationMs: 24 * 60 * 60 * 1000,
      maxWallClockMs: 24 * 60 * 60 * 1000,
    });
    const { runId } = seedRun(odb);
    // Process 1: bump the counter using varying targets to avoid
    // repeat-trigger; persist 5 observations.
    for (let i = 0; i < 5; i++) {
      const r = guard.observe({
        runId,
        actionTarget: i % 2 === 0 ? 'tool:knowledge.search' : 'tool:summarize',
        progressDelta: 1,
      });
      expect(r.ok).toBe(true);
    }
    dbService.close(); odb.close();
    // Process restart: a fresh OgraDatabase / Runtime / Guard reads the
    // SAME SQLite file and recovers the persisted snapshot.
    const odb2 = new OgraDatabase(dir);
    const dbService2 = new DatabaseService(dir);
    dbService2.initialize();
    const runtime2 = new DurableRuntimeService(odb2,
      () => 'pvh2', () => 'rv2');
    const guard2 = new ProgressGuard(odb2, runtime2);
    const snap = guard2.loadObservedState(runId);
    expect(snap.actionCount).toBe(5);
    expect(snap.guardTerminated).toBe(false);
    expect(snap.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The original observations persist too via the ledger.
    const decisions = guard2.listDecisionsForRun(runId);
    expect(decisions).toHaveLength(5);
    dbService2.close(); odb2.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('crash recovery: terminated-run state survives process restart', () => {
    const dir = path.join(os.tmpdir(),
      `s1c-pg-crash-term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(dir, { recursive: true });
    const dbService = new DatabaseService(dir);
    dbService.initialize();
    const odb = new OgraDatabase(dir);
    const runtime = new DurableRuntimeService(odb,
      () => 'pvh', () => 'rv');
    const guard = new ProgressGuard(odb, runtime, { maxActionCount: 2 });
    const { runId } = seedRun(odb);
    for (let i = 0; i < 2; i++) {
      const r = guard.observe({ runId, actionTarget: 'agent:plan', progressDelta: 1 });
      expect(r.ok).toBe(true);
    }
    const over = guard.observe({ runId, actionTarget: 'agent:plan' });
    expect(over.ok).toBe(false);
    expect(over.reasonCode).toBe('guard_budget_exhausted_action_count');
    dbService.close(); odb.close();
    // Restart.
    const odb2 = new OgraDatabase(dir);
    const dbService2 = new DatabaseService(dir);
    dbService2.initialize();
    const runtime2 = new DurableRuntimeService(odb2,
      () => 'pvh', () => 'rv');
    const guard2 = new ProgressGuard(odb2, runtime2, { maxActionCount: 2 });
    expect(guard2.isGuardTerminated(runId)).toBe(true);
    const observe = guard2.observe({ runId, actionTarget: 'agent:plan' });
    expect(observe.ok).toBe(false);
    expect(observe.reasonCode).toBe('guard_budget_exhausted_action_count');
    dbService2.close(); odb2.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('loop detection: 4 consecutive identical targets flags guard_loop_detected', () => {
    const dir = path.join(os.tmpdir(),
      `s1c-pg-loop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(dir, { recursive: true });
    const dbService = new DatabaseService(dir);
    dbService.initialize();
    const odb = new OgraDatabase(dir);
    const runtime = new DurableRuntimeService(odb,
      () => 'pvh', () => 'rv');
    const guard = new ProgressGuard(odb, runtime, {
      repeatWindow: 4, repeatThreshold: 4,
    });
    const { runId } = seedRun(odb);
    // Three repetitions are still ok; the 4th consecutive match
    // trips the loop detection.
    for (let i = 0; i < 3; i++) {
      const r = guard.observe({ runId, actionTarget: 'tool:knowledge.search' });
      expect(r.ok).toBe(true);
    }
    const fourth = guard.observe({ runId, actionTarget: 'tool:knowledge.search' });
    expect(fourth.ok).toBe(false);
    expect(fourth.reasonCode).toBe('guard_loop_detected');
    dbService.close(); odb.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('progress_delta resets last_progress_at; stagnation requires both time and stale delta', () => {
    const dir = path.join(os.tmpdir(),
      `s1c-pg-stag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(dir, { recursive: true });
    const dbService = new DatabaseService(dir);
    dbService.initialize();
    const odb = new OgraDatabase(dir);
    const runtime = new DurableRuntimeService(odb,
      () => 'pvh', () => 'rv');
    // stagnationMs: 50ms; wall_clock cap is high so timing
    // doesn't drive the decision.
    const guard = new ProgressGuard(odb, runtime, {
      stagnationMs: 50, maxWallClockMs: 24 * 60 * 60 * 1000,
    });
    const { runId } = seedRun(odb);
    const t0 = new Date().toISOString();
    const ok = guard.observe({
      runId, actionTarget: 'tool:knowledge.search',
      progressDelta: 1, asOf: t0,
    });
    expect(ok.ok).toBe(true);
    expect(ok.observed.lastProgressAt).toBe(t0);
    // 100ms later with progressDelta=0 → stagnation trips.
    const t1 = new Date(Date.parse(t0) + 100).toISOString();
    const stuck = guard.observe({
      runId, actionTarget: 'tool:knowledge.search', asOf: t1,
    });
    expect(stuck.ok).toBe(false);
    expect(stuck.reasonCode).toBe('guard_stagnation_detected');
    dbService.close(); odb.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
});
