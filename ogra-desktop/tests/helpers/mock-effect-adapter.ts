/**
 * Sequence 1A Milestone 0 — MockEffectAdapter (test only).
 *
 * A controllable stand-in for a durable effect adapter. It declares
 * idempotency + outcome-query recovery capabilities and tracks:
 *  - the count of physical callback attempts (each invocation)
 *  - the count of *physical applications* (the adapter actually
 *    mutated external state on that attempt)
 *  - per-attempt history with payload hash and idempotency key hash
 *
 * The key invariant — for an idempotent adapter, physical
 * applications MUST equal callback attempts when given the same
 * idempotency key; for an unknown-outcome adapter, applications
 * may be LESS than attempts (the request may have been sent but
 * the response was lost).
 *
 * Milestone 0: do NOT wire MockEffectAdapter into the production
 * InternalAgentAdapter path. It is exposed as a test fixture only.
 */

import * as crypto from 'crypto';
import type { RecoveryCapabilities } from '../../src/core/durable-runtime-types';

export type MockEffectOutcome = 'applied' | 'unknown' | 'compensated' | 'denied';

export interface MockEffectAttempt {
  attemptNo: number;
  payloadHash: string;
  idempotencyKeyHash: string;
  /** True iff this attempt caused a physical side-effect. */
  physicalApplication: boolean;
  outcome: MockEffectOutcome;
  startedAt: string;
  completedAt: string | null;
}

export class MockEffectAdapter {
  readonly id: string;
  readonly providerId = 'mock_effect';
  readonly isLocal = false;
  readonly recoveryCapabilities: RecoveryCapabilities;

  private attempts = 0;
  private physicalApplications = 0;
  private readonly _history: MockEffectAttempt[] = [];
  /**
   * If set to true, the adapter will REFUSE to apply on any
   * attempt — physical applications stay 0 while attempts grow.
   * Used to simulate an unknown-outcome adapter where the request
   * was sent but the response was lost.
   */
  private unknownOutcomeMode = false;
  /**
   * If set to true, the adapter refuses all attempts after the
   * first (deterministic denial) — physical applications stay 1
   * while attempts may grow on retries.
   */
  private denyAfterFirst = false;

  constructor(id = 'mock-effect-default') {
    this.id = id;
    this.recoveryCapabilities = {
      supportsIdempotencyKey: true,
      supportsOutcomeQuery: true,
      supportsCancel: false,
      supportsCompensation: true,
      compensationIsLossless: true,
      retryCostRisk: 'low',
      duplicateEffectRisk: 'low',
      auditLevel: 'full',
    };
  }

  setUnknownOutcomeMode(on: boolean): void { this.unknownOutcomeMode = on; }
  setDenyAfterFirst(on: boolean): void { this.denyAfterFirst = on; }

  get attemptCount(): number { return this.attempts; }
  get applicationCount(): number { return this.physicalApplications; }
  get history(): ReadonlyArray<MockEffectAttempt> { return this._history; }

  /**
   * Invoke the mock adapter. Records an attempt and (depending on
   * the configured mode) records a physical application. Returns
   * the recorded outcome.
   */
  invoke(args: { payloadHash: string; idempotencyKeyHash: string }): MockEffectAttempt {
    this.attempts += 1;
    const startedAt = new Date().toISOString();
    let physicalApplication = false;
    let outcome: MockEffectOutcome;
    if (this.unknownOutcomeMode) {
      // Send the request, but the response is lost — physical
      // application may or may not have happened.
      physicalApplication = false;
      outcome = 'unknown';
    } else if (this.denyAfterFirst && this.physicalApplications >= 1) {
      physicalApplication = false;
      outcome = 'denied';
    } else {
      physicalApplication = true;
      this.physicalApplications += 1;
      outcome = 'applied';
    }
    const entry: MockEffectAttempt = {
      attemptNo: this.attempts,
      payloadHash: args.payloadHash,
      idempotencyKeyHash: args.idempotencyKeyHash,
      physicalApplication,
      outcome,
      startedAt,
      completedAt: outcome === 'unknown' ? null : new Date().toISOString(),
    };
    this._history.push(entry);
    return entry;
  }

  /** Compute the canonical payload hash for a JSON payload. */
  static hashPayload(payload: unknown): string {
    const json = JSON.stringify(payload, Object.keys(payload as object).sort());
    return crypto.createHash('sha256').update(json).digest('hex');
  }
}