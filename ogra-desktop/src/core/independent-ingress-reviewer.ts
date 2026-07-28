/**
 * M2 ingress-review process supervisor.
 *
 * The review policy executes in a distinct Node process. The supervisor only
 * sends immutable references and digests over the `ogra.ingress-review.v1`
 * protocol, validates the closed verdict, then asks IngressReviewService to
 * perform its existing authoritative receipt/capsule/lease/CAS transaction.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { OgraDatabase } from './database';
import { DurableRuntimeService } from './durable-runtime-service';
import { EncryptedCapsuleStore } from './capsule-store';
import { OgraError, OgraErrorCode } from '../shared/errors';
import { canonicalJSON } from './audit-envelope';
import { IngressOutcome, IngressReviewDecision, IngressReviewDecisionInput, IngressReviewResult, StructuredIngressFinding } from './ingress-review-service';

export type ReviewerSource = 'agent' | 'recovery';

const PROTOCOL_NAMESPACE = 'ogra.ingress-review.v1';
const SUPERVISOR_CONTEXT = 'core-ingress-supervisor';
const WORKER_CONTEXT = 'ingress-review-worker';
const CLOSED_OUTCOMES = new Set<IngressOutcome>(['accepted', 'quarantined', 'rejected']);
const CLOSED_REASON_CODES = new Set([
  'no_anomalies_detected',
  'recovery_replay_validated',
  'payload_digest_empty',
  'receipt_binding_invalid',
  'prompt_injection_detected',
]);

interface ReviewRequest extends IngressReviewDecisionInput {
  namespace: typeof PROTOCOL_NAMESPACE;
  callerContext: typeof SUPERVISOR_CONTEXT;
  requestId: string;
  /** One-time AEAD ciphertext for the already-authoritative result only. */
  sealedPayload?: string;
}

interface ReviewResponse {
  namespace: string;
  callerContext: string;
  requestId: string;
  pid: number;
  verdict: {
    outcome: unknown;
    reviewer: unknown;
    sanitizedReasonCode?: unknown;
    structuredFindings?: unknown;
  };
}

export interface IndependentIngressReviewerOptions {
  /** Test-only worker override for crash/timeout/malformed IPC cases. */
  workerPath?: string;
  /** Bounded subprocess execution. A timeout is an ingress denial. */
  timeoutMs?: number;
}

/**
 * The old in-process policy is retained only as a type-compatible helper for
 * older fixtures. Production verdicts MUST come from the child process below.
 */
export class DefaultReviewerPolicy {
  decide(input: IngressReviewDecisionInput): IngressReviewDecision {
    if (!input.payloadDigest) {
      return { outcome: 'quarantined', reviewer: 'default-policy', sanitizedReasonCode: 'payload_digest_empty' };
    }
    if (!input.receiptId || input.attemptNo <= 0) {
      return { outcome: 'quarantined', reviewer: 'default-policy', sanitizedReasonCode: 'receipt_binding_invalid' };
    }
    return {
      outcome: 'accepted',
      reviewer: 'default-policy',
      sanitizedReasonCode: input.source === 'agent' ? 'no_anomalies_detected' : 'recovery_replay_validated',
    };
  }
}

/**
 * Supervises a one-shot reviewer child process. The worker has a distinct PID,
 * JavaScript module loader and working directory. It never receives a result
 * capsule, plaintext payload, key, receipt body, or adapter-owned scratch.
 */
export class IndependentIngressReviewer {
  private readonly workerPath: string;
  private readonly timeoutMs: number;
  public lastWorkerPid: number | null = null;

  constructor(
    // Keep these constructor dependencies to avoid broad M2 wiring churn. They
    // deliberately are not passed to the worker.
    private readonly _odb: OgraDatabase,
    private readonly _runtime: DurableRuntimeService,
    private readonly _capsuleStore: EncryptedCapsuleStore,
    private readonly ingressReview: {
      finalizeIngressDecision(input: {
        effectId: string; outcome: IngressOutcome; reviewer: string;
        sanitizedReasonCode?: string; sanitizedReasonDetail?: string;
        structuredFindings?: StructuredIngressFinding[];
        reviewerPayloadDigest: string; leaseHolderId: string; leaseVersion: number;
        ruleVersion: string; asOf?: string;
      }): {
        effectId: string; findingId: string; reviewDecisionId: string;
        outcome: IngressOutcome; stateBefore: string; stateAfter: string;
        payloadDigest: string; outcomeEventId: string;
        sanitizedReasonCode?: string; sanitizedReasonDetail?: string;
      };
    },
    options: IndependentIngressReviewerOptions = {},
  ) {
    this.workerPath = options.workerPath ?? this.resolveWorkerPath();
    this.timeoutMs = options.timeoutMs ?? 2_000;
  }

  /** Runs the isolated policy only; useful for boundary-focused tests. */
  review(input: IngressReviewDecisionInput, verifiedPayload?: unknown): IngressReviewDecision {
    const requestId = crypto.randomBytes(12).toString('hex');
    const request: ReviewRequest = {
      namespace: PROTOCOL_NAMESPACE,
      callerContext: SUPERVISOR_CONTEXT,
      requestId,
      effectId: input.effectId,
      runId: input.runId,
      workspaceId: input.workspaceId,
      receiptId: input.receiptId,
      attemptNo: input.attemptNo,
      payloadDigest: input.payloadDigest,
      source: input.source,
    };
    const reviewKey = verifiedPayload === undefined
      ? undefined
      : crypto.randomBytes(32);
    if (reviewKey) {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', reviewKey, nonce);
      cipher.setAAD(Buffer.from(requestId, 'utf8'));
      const ciphertext = Buffer.concat([
        cipher.update(Buffer.from(canonicalJSON(verifiedPayload), 'utf8')),
        cipher.final(),
      ]);
      request.sealedPayload = Buffer.concat([nonce, ciphertext, cipher.getAuthTag()])
        .toString('base64');
    }
    const workerScratch = fs.mkdtempSync(path.join(process.cwd(), '.ogra-ingress-review-'));
    let execution: ReturnType<typeof spawnSync>;
    try {
      execution = spawnSync(process.execPath, [
        this.workerPath,
      ], {
        input: JSON.stringify(request),
        encoding: 'utf8',
        timeout: this.timeoutMs,
        // New cwd means the review process cannot inherit adapter scratch space.
        cwd: workerScratch,
        env: {
          PATH: process.env.PATH ?? '',
          NODE_ENV: process.env.NODE_ENV ?? 'production',
          // A one-call AEAD key. It can decrypt only request.sealedPayload,
          // never a workspace capsule or any SQLite record.
          ...(reviewKey
            ? { OGRA_INGRESS_REVIEW_KEY: reviewKey.toString('base64') }
            : {}),
        },
        maxBuffer: 16 * 1024,
        windowsHide: true,
      });
    } finally {
      fs.rmSync(workerScratch, { recursive: true, force: true });
    }
    if (execution.error || execution.signal || execution.status !== 0) {
      throw new OgraError(OgraErrorCode.INGRESS_REVIEW_DENIED,
        `ingress reviewer unavailable (${execution.error?.message ?? execution.signal ?? execution.status ?? 'unknown'}): ${String(execution.stderr).slice(0, 160)}`);
    }
    return this.validateResponse(String(execution.stdout), requestId);
  }

  reviewAndFinalize(input: {
    effectId: string; runId: string; workspaceId: string; receiptId: string;
    attemptNo: number; payloadDigest: string; source: ReviewerSource;
    ruleVersion: string; leaseHolderId: string; leaseVersion: number; asOf?: string;
  }): IngressReviewResult {
    // Core remains the authority for receipt ownership and AEAD verification.
    // Do this before spawning the detector so capsule faults preserve their
    // durable CAPSULE_* semantics instead of being confused with worker loss.
    const payload = this.verifyAuthoritativeResult(input);
    const verdict = this.review({
      effectId: input.effectId, runId: input.runId, workspaceId: input.workspaceId,
      receiptId: input.receiptId, attemptNo: input.attemptNo,
      payloadDigest: input.payloadDigest, source: input.source,
    }, payload);
    return this.ingressReview.finalizeIngressDecision({
      effectId: input.effectId,
      outcome: verdict.outcome,
      reviewer: verdict.reviewer,
      sanitizedReasonCode: verdict.sanitizedReasonCode,
      structuredFindings: verdict.structuredFindings,
      reviewerPayloadDigest: input.payloadDigest,
      leaseHolderId: input.leaseHolderId,
      leaseVersion: input.leaseVersion,
      ruleVersion: input.ruleVersion,
      asOf: input.asOf,
    });
  }

  private verifyAuthoritativeResult(input: {
    effectId: string; workspaceId: string; receiptId: string; attemptNo: number;
    payloadDigest: string;
  }): unknown {
    const receipt = this._odb.getDB().prepare(`
      SELECT result_capsule_ref, result_capsule_hash, result_capsule_format_version
        FROM effect_receipts WHERE id = ? AND effect_id = ?
    `).get(input.receiptId, input.effectId) as {
      result_capsule_ref: string | null; result_capsule_hash: string | null;
      result_capsule_format_version: string | null;
    } | undefined;
    if (!receipt) {
      throw new OgraError(OgraErrorCode.RECEIPT_NOT_FOUND,
        `ingress reviewer: authoritative receipt ${input.receiptId} not found`);
    }
    const opened = this._capsuleStore.openResultForReceipt<unknown>({
      workspaceId: input.workspaceId, effectId: input.effectId,
      receiptId: input.receiptId, attemptNo: input.attemptNo,
      resultCapsuleRef: receipt.result_capsule_ref,
      resultCapsuleHash: receipt.result_capsule_hash,
      resultCapsuleFormatVersion: receipt.result_capsule_format_version,
    });
    const digest = crypto.createHash('sha256').update(canonicalJSON(opened.payload)).digest('hex');
    if (digest !== input.payloadDigest) {
      throw new OgraError(OgraErrorCode.CAPSULE_INVALID,
        'ingress reviewer: verified result payload digest drift');
    }
    return opened.payload;
  }

  private resolveWorkerPath(): string {
    const candidates = [
      path.join(__dirname, 'ingress-review-worker.js'),
      path.join(process.cwd(), 'src', 'core', 'ingress-review-worker.js'),
    ];
    const workerPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!workerPath) {
      throw new OgraError(OgraErrorCode.INGRESS_REVIEW_DENIED,
        'ingress reviewer worker executable is unavailable');
    }
    return workerPath;
  }

  private validateResponse(raw: string, requestId: string): IngressReviewDecision {
    let response: ReviewResponse;
    try {
      response = JSON.parse(raw) as ReviewResponse;
    } catch {
      throw new OgraError(OgraErrorCode.INGRESS_REVIEW_DENIED,
        'ingress reviewer returned malformed IPC response');
    }
    const structuredFindings = this.validateStructuredFindings(response.verdict.structuredFindings);
    if (response.namespace !== PROTOCOL_NAMESPACE
      || response.callerContext !== WORKER_CONTEXT
      || response.requestId !== requestId
      || !Number.isInteger(response.pid)
      || response.pid === process.pid
      || !response.verdict
      || !CLOSED_OUTCOMES.has(response.verdict.outcome as IngressOutcome)
      || typeof response.verdict.reviewer !== 'string'
      || response.verdict.reviewer !== 'default-policy'
      || (response.verdict.sanitizedReasonCode !== undefined
        && (!CLOSED_REASON_CODES.has(response.verdict.sanitizedReasonCode as string)))
      || structuredFindings === null) {
      throw new OgraError(OgraErrorCode.INGRESS_REVIEW_DENIED,
        'ingress reviewer returned an invalid or untrusted verdict');
    }
    this.lastWorkerPid = response.pid;
    return {
      outcome: response.verdict.outcome as IngressOutcome,
      reviewer: response.verdict.reviewer,
      sanitizedReasonCode: response.verdict.sanitizedReasonCode as string | undefined,
      structuredFindings,
    };
  }

  private validateStructuredFindings(value: unknown): StructuredIngressFinding[] | undefined | null {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > 16) return null;
    for (const finding of value) {
      if (!finding || typeof finding !== 'object') return null;
      const item = finding as Record<string, unknown>;
      if (typeof item.patternId !== 'string' || !/^[a-z0-9_.-]{1,96}$/.test(item.patternId)
        || item.evidence !== '[redacted]'
        || typeof item.evidenceHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.evidenceHash)
        || !['low', 'medium', 'high', 'critical'].includes(item.severity as string)
        || item.layer !== 'result_payload') return null;
    }
    return value as StructuredIngressFinding[];
  }
}
