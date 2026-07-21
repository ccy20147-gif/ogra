/**
 * Sequence 1B Milestone 1 — Durable Mock Effect Driver.
 *
 * Test-only driver that exercises the full effect protocol with a
 * MockEffectAdapter. Used by the M1 crash-injection test matrix
 * and by the recovery audit tests. NOT wired into the production
 * InternalAgentAdapter path (Sequence 0 keeps its own model call
 * route; M2 will wire the kernel into the Confidential trust loop).
 *
 * Responsibilities:
 *   - prepare effect (sealed callback capsule)
 *   - cas to in_flight (only if the lease is held)
 *   - invoke the mock adapter (counts attempts vs physical
 *     applications; the mock is idempotent: same idempotency key
 *     produces exactly one physical application across retries)
 *   - record receipt (sealed result capsule)
 *   - commit terminal (received -> committed)
 *
 * Crash injection hooks are exposed as `crashBefore` /
 * `crashAfter` callbacks the test can plug in to simulate
 * process death at the right moment.
 */

import * as crypto from 'crypto';
import { OgraError, OgraErrorCode } from '../shared/errors';
import { OgraDatabase } from '../core/database';
import {
  EncryptedCapsuleStore,
  StaticMasterKeyProvider,
  OgraSecretBrokerKeyProvider,
} from '../core/capsule-store';
import { DurableRuntimeService } from '../core/durable-runtime-service';
import { EffectProtocolService } from '../core/effect-protocol-service';
import { RecoveryService } from '../core/recovery-service';
import { MockEffectAdapter, MockEffectOutcome } from '../../tests/helpers/mock-effect-adapter';
import { RecoveryAuditPacketService } from '../core/recovery-audit-packet';
import { canonicalJSON } from './audit-envelope';

export interface MockAdapterBehavior {
  /** Adapter-declared recovery capabilities. */
  supportsIdempotencyKey?: boolean;
  supportsOutcomeQuery?: boolean;
  supportsCompensation?: boolean;
  /** Mock's outcome-mode flag: 'applied' or 'unknown'. */
  outcomeMode?: 'applied' | 'unknown';
}

export interface DurableMockEffectInput {
  runId: string;
  ownerFrameId: string;
  adapter: MockEffectAdapter;
  payload: unknown;
  payloadFingerprint: string;
  idempotencyKey: string;
  scopeHash: string;
  routeDecisionId?: string;
  policyEvaluationId?: string;
  policyVersionHash?: string;
  classification?: string;
  behavior?: MockAdapterBehavior;
  /** Test hooks: invoked at named checkpoints so the test can
   *  throw to simulate a crash. Each hook receives the running
   *  driver so the test can inspect state. */
  crashBefore?: 'prepare' | 'cas' | 'invoke' | 'receipt' | 'commit';
  crashAfter?: 'prepare' | 'cas' | 'invoke' | 'receipt' | 'commit';
  leaseHolder: string;
}

export interface DurableMockEffectOutput {
  effectId: string;
  attemptNo: number;
  receiptId: string;
  state: 'committed' | 'unknown';
  attempts: number;
  physicalApplications: number;
  /** Did the mock apply during this run? */
  outcome: MockEffectOutcome;
}

export class DurableMockEffectDriver {
  /** Set by tests to force a crash at the next step boundary. */
  public crashBeforeHook: ((step: string) => void) | null = null;
  public crashAfterHook: ((step: string) => void) | null = null;

  constructor(
    private readonly odb: OgraDatabase,
    private readonly runtime: DurableRuntimeService,
    private readonly capsuleStore: EncryptedCapsuleStore,
    private readonly protocol: EffectProtocolService,
    private readonly recovery: RecoveryService,
  ) {}

  async runOnce(input: DurableMockEffectInput): Promise<DurableMockEffectOutput> {
    const { effectId, attemptNo } = await this.runPrepare(input);
    return this.runAdapterAndCommit({ ...input, effectId, attemptNo });
  }

  /**
   * Phase A: prepare only. Returns the effect id + the
   * attempt_no that the next callback phase should use.
   * Throws if prepare fails (capsule integrity, owner
   * mismatch, etc.).
   */
  async runPrepare(input: DurableMockEffectInput): Promise<{
    effectId: string; attemptNo: number;
  }> {
    const behavior = input.behavior ?? {};
    if (behavior.supportsIdempotencyKey !== undefined) {
      input.adapter.recoveryCapabilities.supportsIdempotencyKey =
        behavior.supportsIdempotencyKey;
    }
    if (behavior.supportsOutcomeQuery !== undefined) {
      input.adapter.recoveryCapabilities.supportsOutcomeQuery =
        behavior.supportsOutcomeQuery;
    }
    if (behavior.supportsCompensation !== undefined) {
      input.adapter.recoveryCapabilities.supportsCompensation =
        behavior.supportsCompensation;
    }
    if (behavior.outcomeMode === 'unknown') {
      input.adapter.setUnknownOutcomeMode(true);
    } else {
      input.adapter.setUnknownOutcomeMode(false);
    }
    try {
      this.runtime.readLease(input.runId);
    } catch {
      this.runtime.acquireLease({
        runId: input.runId, holderId: input.leaseHolder, ttlMs: 5 * 60 * 1000,
      });
    }
    if (this.crashBeforeHook) this.crashBeforeHook('prepare');
    const prepared = this.protocol.prepare({
      runId: input.runId,
      ownerFrameId: input.ownerFrameId,
      effectType: 'mock.egress',
      adapterKind: 'mock',
      adapterVersion: 'M1-fixture',
      payload: input.payload,
      payloadFingerprint: input.payloadFingerprint,
      idempotencyKey: input.idempotencyKey,
      scopeHash: input.scopeHash,
      routeDecisionId: input.routeDecisionId ?? 'rd_mock',
      policyEvaluationId: input.policyEvaluationId ?? 'pe_mock',
      policyVersionHash: input.policyVersionHash ?? 'ph_mock',
      classification: input.classification ?? 'Internal',
      // The fixture makes its declaration explicit on the adapter first;
      // prepare seals that actual declaration rather than any later recovery
      // caller's booleans.
      recoveryCapabilities: {
        supportsIdempotencyKey: input.adapter.recoveryCapabilities.supportsIdempotencyKey,
        supportsOutcomeQuery: input.adapter.recoveryCapabilities.supportsOutcomeQuery,
        supportsCompensation: input.adapter.recoveryCapabilities.supportsCompensation,
      },
    });
    if (this.crashAfterHook) this.crashAfterHook('prepare');
    return { effectId: prepared.effectId, attemptNo: prepared.attemptNo };
  }

  /**
   * Phase B: cas + invoke + receipt + (commit if applied).
   * Takes the effectId from runPrepare. Throws if the effect
   * is not in a state that allows the next phase (e.g.,
   * another process already committed).
   */
  async runAdapterAndCommit(input: DurableMockEffectInput & {
    effectId: string; attemptNo: number;
  }): Promise<DurableMockEffectOutput> {
    if (this.crashBeforeHook) this.crashBeforeHook('cas');
    const cas = this.protocol.casToInFlight({
      effectId: input.effectId,
      expectedRevision: 1,
      expectedAttemptNo: input.attemptNo,
      leaseHolder: input.leaseHolder,
    });
    if (this.crashAfterHook) this.crashAfterHook('cas');

    if (this.crashBeforeHook) this.crashBeforeHook('invoke');
    const command = cas.callbackPayload as {
      payload?: unknown; idempotencyKey?: unknown;
    };
    if (!Object.prototype.hasOwnProperty.call(command, 'payload')
        || typeof command.idempotencyKey !== 'string') {
      throw new OgraError(OgraErrorCode.CAPSULE_INVALID,
        'mock callback capsule has no valid payload or idempotency key');
    }
    const payloadHash = crypto.createHash('sha256')
      .update(canonicalJSON(command.payload)).digest('hex');
    const mockAttempt = input.adapter.invoke({
      payloadHash,
      idempotencyKeyHash: crypto.createHash('sha256')
        .update(command.idempotencyKey).digest('hex'),
    });
    const outcome = mockAttempt.outcome;
    if (this.crashAfterHook) this.crashAfterHook('invoke');

    let receiptId: string | null = null;
    if (this.crashBeforeHook) this.crashBeforeHook('receipt');
    if (outcome === 'applied') {
      const resultBody = {
        outcome, attemptNo: mockAttempt.attemptNo,
        physicalApplication: mockAttempt.physicalApplication,
        payloadHash,
      };
      const receipt = this.protocol.recordReceipt({
        effectId: input.effectId,
        attemptNo: input.attemptNo,
        requestId: `req_${input.effectId}_${input.attemptNo}`,
        requestHash: payloadHash,
        result: resultBody,
        applicationStatus: 'applied',
        providerStatus: outcome,
      });
      receiptId = receipt.receiptId;
    } else {
      this.protocol.recordUnknownOutcome({
        effectId: input.effectId,
        attemptNo: input.attemptNo,
        providerStatus: outcome,
        resolvedOutcome: outcome === 'unknown' ? null : 'not_applied',
      });
    }
    if (this.crashAfterHook) this.crashAfterHook('receipt');

    if (this.crashBeforeHook) this.crashBeforeHook('commit');
    if (receiptId) {
      const effect = this.runtime.readEffect(input.effectId);
      this.protocol.commitToTerminal({
        effectId: input.effectId,
        expectedRevision: effect.effectRevision,
        expectedAttemptNo: input.attemptNo,
        receiptId,
        leaseHolder: input.leaseHolder,
        expectedLeaseVersion: cas.leaseVersion,
      });
    }
    if (this.crashAfterHook) this.crashAfterHook('commit');

    return {
      effectId: input.effectId,
      attemptNo: input.attemptNo,
      receiptId: receiptId ?? '',
      state: receiptId ? 'committed' : 'unknown',
      attempts: input.adapter.attemptCount,
      physicalApplications: input.adapter.applicationCount,
      outcome,
    };
  }

  /**
   * Resume (Phase B only) an effect that an earlier process
   * left in `planned` or `in_flight`. Acquires the lease as a
   * fresh holder, uses the recovery service to drive planned
   * -> in_flight if needed, then runs the adapter. Returns the
   * usual DurableMockEffectOutput (or the existing effect
   * result if it was already committed).
   */
  async runResume(input: DurableMockEffectInput & {
    effectId: string;
  }): Promise<DurableMockEffectOutput> {
    // Acquire the lease as the new holder.
    this.runtime.acquireLease({
      runId: input.runId, holderId: input.leaseHolder, ttlMs: 5 * 60 * 1000,
    });
    // Resolve the effect's current state.
    const effect = this.runtime.readEffect(input.effectId);
    if (effect.state === 'committed') {
      // Already committed by an earlier process — nothing to do.
      const receipt = this.odb.getDB().prepare(
        'SELECT * FROM effect_receipts WHERE effect_id = ? AND attempt_no = ?',
      ).get(input.effectId, 1) as any | undefined;
      return {
        effectId: input.effectId,
        attemptNo: receipt?.attempt_no ?? 1,
        receiptId: receipt?.id ?? '',
        state: 'committed',
        attempts: input.adapter.attemptCount,
        physicalApplications: input.adapter.applicationCount,
        outcome: 'applied',
      };
    }
    return this.runAdapterAndCommit({ ...input, attemptNo: 1 });
  }

  /**
   * Wire the durable kernel to a brand-new OgraDatabase + workspace.
   * Convenience for tests so they don't have to repeat the wiring.
   */
  static wireForTests(args: {
    dbService: { odb: OgraDatabase };
    workspaceId: string;
    runId: string;
    policyVersionHash: string;
    secretBrokerKey?: Buffer;
  }): {
    odb: OgraDatabase;
    runtime: DurableRuntimeService;
    capsuleStore: EncryptedCapsuleStore;
    protocol: EffectProtocolService;
    recovery: RecoveryService;
    auditPacket: RecoveryAuditPacketService;
  } {
    const odb = args.dbService.odb;
    const masterKey = args.secretBrokerKey
      ?? crypto.randomBytes(32);
    const keyProvider = new StaticMasterKeyProvider(masterKey);
    const capsuleStore = new EncryptedCapsuleStore(odb, keyProvider);
    const runtime = new DurableRuntimeService(
      odb, () => args.policyVersionHash,
    );
    const protocol = new EffectProtocolService(odb, runtime, capsuleStore);
    const recovery = new RecoveryService(odb, runtime, capsuleStore, protocol);
    const auditPacket = new RecoveryAuditPacketService(odb);
    return { odb, runtime, capsuleStore, protocol, recovery, auditPacket };
  }
}
