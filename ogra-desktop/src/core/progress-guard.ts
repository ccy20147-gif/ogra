/**
 * Sequence 1C Milestone 1 — ProgressGuard.
 *
 * Per-run resource guard for agent / tool action loops. Enforces
 * deterministic budget limits, detects repeat-targets in a window,
 * detects stagnation (no progress_delta for a window), and persists
 * every observe() decision to the durable `progress_ledger` so a
 * crash / restart restores the exact observed state from disk.
 *
 * Invariants:
 *   - Any guard rejection MUST fail closed. The decision is written
 *     to the ledger and the run is marked `guard_terminated` so
 *     every subsequent observe() call returns the same reason code
 *     without further mutation.
 *   - crash/restart MUST recover guard state from the durable
 *     `progress_run_state` snapshot, never from memory.
 *   - The guard never inspects raw payload bytes. Its inputs are
 *     refs / hashes / closed-set action_target strings only.
 *
 * Default budgets (Alpha safe defaults; may be widened per
 * workspace in later phases):
 *   - action_count max 200
 *   - unique_actions max 80 (in the last `repeatWindow`)
 *   - total_steps max 400
 *   - wall_clock_ms max 30 min
 *   - repeat_window 6, repeatThreshold 4 consecutive identical targets
 *   - stagnation_ms 5 min without progress_delta > 0
 */
import * as crypto from 'crypto';
import { OgraDatabase } from './database';
import { DurableRuntimeService } from './durable-runtime-service';
import { OgraError, OgraErrorCode } from '../shared/errors';

export type GuardReasonCode =
  | 'guard_budget_exhausted_action_count'
  | 'guard_budget_exhausted_steps'
  | 'guard_loop_detected'
  | 'guard_stagnation_detected'
  | 'guard_unknown_action';

export interface ProgressGuardConfig {
  /** Max action_count observed for one run. Default 200. */
  maxActionCount?: number;
  /** Max distinct action_target strings in the recent window. Default 80. */
  maxUniqueActions?: number;
  /** Max total_steps observed. Default 400. */
  maxTotalSteps?: number;
  /** Max wall_clock_ms since run start. Default 30 min. */
  maxWallClockMs?: number;
  /** Repeat window — the last N observations. Default 6. */
  repeatWindow?: number;
  /** Threshold of identical consecutive targets. Default 4. */
  repeatThreshold?: number;
  /** Stagnation threshold — ms with no progress. Default 5 min. */
  stagnationMs?: number;
}

const DEFAULTS: Required<ProgressGuardConfig> = {
  maxActionCount: 200,
  maxUniqueActions: 80,
  maxTotalSteps: 400,
  maxWallClockMs: 30 * 60 * 1000,
  repeatWindow: 6,
  repeatThreshold: 4,
  stagnationMs: 5 * 60 * 1000,
};

const ACTION_TARGET_RE = /^[a-z]+:[a-z0-9_\-:.]+$/;

export interface ObserveInput {
  runId: string;
  workspaceId?: string;
  frameId?: string;
  actionTarget: string;
  /** 1 if this observation marks progress; 0 for repeats. */
  progressDelta?: number;
  asOf?: string;
}

export interface ObserveObserved {
  actionCount: number;
  uniqueActions: number;
  totalSteps: number;
  startedAt: string;
  lastProgressAt: string | null;
  lastRepeatTarget: string | null;
  lastRepeatCount: number;
}

export interface ObserveResult {
  ok: boolean;
  reasonCode: GuardReasonCode | null;
  detail: string | null;
  observed: ObserveObserved;
  sequenceNo: number | null;
  l1EventId: string | null;
}

export interface ProgressGuardDecisionRow {
  runId: string;
  sequenceNo: number;
  budgetKind: 'action_count' | 'unique_actions' | 'total_steps'
    | 'wall_clock_ms' | 'repeat_window';
  observedValue: number;
  budgetValue: number;
  target: string | null;
  reasonCode: GuardReasonCode | null;
  l1EventId: string;
}

interface LoadedObservedState {
  actionCount: number;
  uniqueActions: number;
  totalSteps: number;
  startedAt: string;
  lastProgressAt: string | null;
  lastRepeatTarget: string | null;
  lastRepeatCount: number;
  guardTerminated: boolean;
  terminationReasonCode: GuardReasonCode | null;
}

/**
 * ProgressGuard. Singleton-per-OgraCore. All decisions land in
 * `progress_ledger`; the crash/restart read is `loadObservedState`
 * which runs synchronously on OgraCore init or on the first
 * observe() call.
 */
export class ProgressGuard {
  private readonly cfg: Required<ProgressGuardConfig>;

  constructor(
    private readonly odb: OgraDatabase,
    private readonly runtime: DurableRuntimeService,
    cfg?: ProgressGuardConfig,
  ) {
    this.cfg = { ...DEFAULTS, ...(cfg ?? {}) };
  }

  /** Snapshot of the current guard config so tests can introspect. */
  config(): Required<ProgressGuardConfig> {
    return { ...this.cfg };
  }

  /**
   * Read the durable observed state for one run. Used on:
   *   - OgraCore construction (crash restore)
   *   - observe() itself (to increment counters atomically)
   *   - tests
   *
   * The snapshot row is the SOLE source of truth; in-memory caches
   * never override it.
   */
  loadObservedState(runId: string): LoadedObservedState {
    const stateRow = this.odb.getDB().prepare(
      `SELECT action_count, unique_actions, total_steps, started_at,
              last_progress_at, last_repeat_target, last_repeat_count,
              guard_terminated, termination_reason_code
         FROM progress_run_state WHERE run_id = ?`,
    ).get(runId) as {
      action_count: number; unique_actions: number; total_steps: number;
      started_at: string; last_progress_at: string | null;
      last_repeat_target: string | null; last_repeat_count: number;
      guard_terminated: number; termination_reason_code: string | null;
    } | undefined;
    if (stateRow) {
      return {
        actionCount: stateRow.action_count,
        uniqueActions: stateRow.unique_actions,
        totalSteps: stateRow.total_steps,
        startedAt: stateRow.started_at,
        lastProgressAt: stateRow.last_progress_at,
        lastRepeatTarget: stateRow.last_repeat_target,
        lastRepeatCount: stateRow.last_repeat_count,
        guardTerminated: stateRow.guard_terminated === 1,
        terminationReasonCode: (stateRow.termination_reason_code as GuardReasonCode | null) ?? null,
      };
    }
    // No state row yet — lazy-init on first observe() call.
    // We do NOT seed here outside observe(); the run may not yet
    // be tracked. Tests can call this directly.
    const now = new Date().toISOString();
    this.odb.getDB().prepare(`
      INSERT OR IGNORE INTO progress_run_state
        (run_id, action_count, unique_actions, total_steps,
         last_progress_at, last_repeat_target, last_repeat_count,
         guard_terminated, started_at, updated_at)
      VALUES (?, 0, 0, 0, ?, NULL, 0, 0, ?, ?)
    `).run(runId, now, now, now);
    return {
      actionCount: 0,
      uniqueActions: 0,
      totalSteps: 0,
      startedAt: now,
      lastProgressAt: null,
      lastRepeatTarget: null,
      lastRepeatCount: 0,
      guardTerminated: false,
      terminationReasonCode: null,
    };
  }

  /**
   * Observe an action and decide. Fail-closed: returns ok=false
   * AND writes a ledger row + recovery decision. crash/restart
   * MUST recover the same observed counters and the same
   * termination state.
   */
  observe(input: ObserveInput): ObserveResult {
    if (!input.runId || !input.actionTarget) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'observe: runId and actionTarget are required');
    }
    if (typeof input.actionTarget !== 'string'
        || !ACTION_TARGET_RE.test(input.actionTarget)) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        `observe: actionTarget MUST match ${ACTION_TARGET_RE}`);
    }
    if (input.progressDelta !== undefined
        && (!Number.isInteger(input.progressDelta) || input.progressDelta < 0
            || input.progressDelta > 1)) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'observe: progressDelta must be 0 or 1');
    }

    const workspaceId = input.workspaceId ?? null;
    return this.runtime.transactionalAppend<ObserveResult>({
      meta: {
        runId: input.runId,
        workspaceId,
        eventType: 'progress_observation',
        eventPayload: {
          actionTarget: input.actionTarget,
          progressDelta: input.progressDelta ?? 0,
        },
        frameId: input.frameId ?? null,
      },
      body: (eventId) => {
        const before = this.loadObservedState(input.runId);
        if (before.guardTerminated) {
          // Idempotent: once a run is terminated, all subsequent
          // observe() calls return the persisted reason with no
          // mutation — no extra ledger row, no extra counter bump.
          return {
            ok: false,
            reasonCode: before.terminationReasonCode,
            detail: `run ${input.runId} already guard_terminated: ${before.terminationReasonCode}`,
            observed: this.toObserved(before),
            sequenceNo: null,
            l1EventId: eventId,
          };
        }
        // Approximate unique-actions in the last `repeatWindow`
        // targets — this bounds loop re-issues that would
        // otherwise grow the unique count without bound. The
        // SECOND number we expose as `recentUniqueActions` is
        // also tracked here so the budget decision in
        // maxUniqueActions reflects recent activity, not the
        // lifetime count of distinct targets.
        const lastRows = this.odb.getDB().prepare(`
          SELECT target FROM progress_ledger
           WHERE run_id = ? AND target IS NOT NULL
           ORDER BY sequence_no DESC LIMIT ?
        `).all(input.runId, this.cfg.repeatWindow) as Array<{
          target: string;
        }>;
        const seenInWindow = new Set(lastRows.map((r) => r.target));
        seenInWindow.add(input.actionTarget);
        // The "recent-unique" count is windowed; the SQL column
        // `unique_actions` stores this same windowed number for
        // crash-restart durability. A lifetime-distinct count is
        // available via `SELECT COUNT(DISTINCT target)` against
        // progress_ledger for diagnostics when needed.
        const uniqueActions = seenInWindow.size;

        const actionCount = before.actionCount + 1;
        const totalSteps = before.totalSteps
          + (input.progressDelta ?? 0);
        const lastRepeatCount = (before.lastRepeatTarget === input.actionTarget)
          ? before.lastRepeatCount + 1
          : 1;
        const now = input.asOf ?? new Date().toISOString();
        const lastProgressAt = (input.progressDelta ?? 0) > 0
          ? now : before.lastProgressAt;
        const wall = Date.parse(now) - Date.parse(before.startedAt);
        // Decision matrix — fail closed: every breach is added.
        const decisions: Array<{ reason: GuardReasonCode; detail: string }> = [];
        if (actionCount > this.cfg.maxActionCount) {
          decisions.push({
            reason: 'guard_budget_exhausted_action_count',
            detail: `run ${input.runId} action_count=${actionCount} > max=${this.cfg.maxActionCount}`,
          });
        }
        if (totalSteps > this.cfg.maxTotalSteps) {
          decisions.push({
            reason: 'guard_budget_exhausted_steps',
            detail: `run ${input.runId} total_steps=${totalSteps} > max=${this.cfg.maxTotalSteps}`,
          });
        }
        // The "recent-unique" budget — collapses distinct
        // actions within the last `repeatWindow` windows. The
        // `unique_actions` column stores this windowed number
        // for crash-restart durability; budget naming follows.
        if (uniqueActions > this.cfg.maxUniqueActions) {
          decisions.push({
            reason: 'guard_budget_exhausted_action_count',
            detail: `run ${input.runId} recent_unique_actions=${uniqueActions} > max=${this.cfg.maxUniqueActions}`,
          });
        }
        if (wall > this.cfg.maxWallClockMs) {
          decisions.push({
            reason: 'guard_budget_exhausted_action_count',
            detail: `run ${input.runId} wall_clock_ms=${wall} > max=${this.cfg.maxWallClockMs}`,
          });
        }
        if (lastRepeatCount >= this.cfg.repeatThreshold) {
          decisions.push({
            reason: 'guard_loop_detected',
            detail: `run ${input.runId} target=${input.actionTarget} repeated ${lastRepeatCount}x in window of ${this.cfg.repeatWindow}`,
          });
        }
        // Stagnation: lastProgressAt is defined and `now - lastProgressAt`
        // exceeds the threshold. A run that just started has
        // lastProgressAt === null — never flagged as stagnant.
        if (lastProgressAt) {
          const since = Date.parse(now) - Date.parse(lastProgressAt);
          if (since > this.cfg.stagnationMs) {
            decisions.push({
              reason: 'guard_stagnation_detected',
              detail: `run ${input.runId} no progress for ${since}ms > ${this.cfg.stagnationMs}ms`,
            });
          }
        }
        // Persist the observation row regardless — termination
        // is decided here, but the ledger keeps a full record of
        // what was seen.
        const seqRow = this.odb.getDB().prepare(
          'SELECT COALESCE(MAX(sequence_no), 0) AS s FROM progress_ledger WHERE run_id = ?',
        ).get(input.runId) as { s: number };
        const sequenceNo = (seqRow.s as number) + 1;
        const ok = decisions.length === 0;
        const decidedReason: GuardReasonCode | null = ok ? null : decisions[0].reason;
        const decidedDetail: string | null = ok ? null : decisions[0].detail;
        this.odb.getDB().prepare(`
          INSERT INTO progress_ledger
            (id, run_id, frame_id, sequence_no, budget_kind,
             observed_value, budget_value, target,
             decision_reason_code, l1_event_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          `prg_${crypto.randomBytes(6).toString('hex')}`,
          input.runId,
          input.frameId ?? null,
          sequenceNo,
          'action_count',
          actionCount,
          this.cfg.maxActionCount,
          input.actionTarget,
          decidedReason,
          eventId,
        );
        // Update the snapshot row.
        this.odb.getDB().prepare(`
          UPDATE progress_run_state
             SET action_count = ?, unique_actions = ?, total_steps = ?,
                 last_progress_at = ?, last_repeat_target = ?,
                 last_repeat_count = ?, guard_terminated = ?,
                 termination_reason_code = ?, updated_at = ?
           WHERE run_id = ?
        `).run(
          actionCount, uniqueActions, totalSteps, lastProgressAt,
          input.actionTarget, lastRepeatCount,
          ok ? 0 : 1,
          decidedReason, now, input.runId,
        );
        return {
          ok,
          reasonCode: decidedReason,
          detail: decidedDetail,
          observed: {
            actionCount,
            uniqueActions,
            totalSteps,
            startedAt: before.startedAt,
            lastProgressAt,
            lastRepeatTarget: input.actionTarget,
            lastRepeatCount,
          },
          sequenceNo,
          l1EventId: eventId,
        };
      },
    });
  }

  /**
   * Read all decisions for one run (sanitized rows). Used by
   * audit packets and tests.
   */
  listDecisionsForRun(runId: string): ProgressGuardDecisionRow[] {
    const rows = this.odb.getDB().prepare(`
      SELECT id, run_id, frame_id, sequence_no, budget_kind,
             observed_value, budget_value, target,
             decision_reason_code, l1_event_id, created_at
        FROM progress_ledger
       WHERE run_id = ?
       ORDER BY sequence_no ASC
    `).all(runId) as Array<{
      run_id: string; sequence_no: number;
      budget_kind: 'action_count' | 'unique_actions' | 'total_steps'
        | 'wall_clock_ms' | 'repeat_window';
      observed_value: number; budget_value: number;
      target: string | null; decision_reason_code: GuardReasonCode | null;
      l1_event_id: string;
    }>;
    return rows.map((row) => ({
      runId: row.run_id,
      sequenceNo: row.sequence_no,
      budgetKind: row.budget_kind,
      observedValue: row.observed_value,
      budgetValue: row.budget_value,
      target: row.target,
      reasonCode: row.decision_reason_code,
      l1EventId: row.l1_event_id,
    }));
  }

  /**
   * True iff the durable snapshot says the run is guard-terminated.
   * This is the SOLE way for callers to decide "can this run still
   * observe()". An empty state row returns false.
   */
  isGuardTerminated(runId: string): boolean {
    return this.loadObservedState(runId).guardTerminated;
  }

  private toObserved(s: LoadedObservedState): ObserveObserved {
    return {
      actionCount: s.actionCount,
      uniqueActions: s.uniqueActions,
      totalSteps: s.totalSteps,
      startedAt: s.startedAt,
      lastProgressAt: s.lastProgressAt,
      lastRepeatTarget: s.lastRepeatTarget,
      lastRepeatCount: s.lastRepeatCount,
    };
  }
}
