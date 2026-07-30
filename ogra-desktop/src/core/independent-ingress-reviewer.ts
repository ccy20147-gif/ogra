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
import {
  ToolTerminalProjectionResult, ToolTerminalProjectionService,
} from './tool-terminal-projection';

export type ReviewerSource = 'agent' | 'recovery';

const PROTOCOL_NAMESPACE = 'ogra.ingress-review.v1';
const SUPERVISOR_CONTEXT = 'core-ingress-supervisor';
const WORKER_CONTEXT = 'ingress-review-worker';
// A cold Node process can exceed two seconds when the desktop application is
// under load (or when the test runner starts several isolated workers). Keep
// the reviewer bounded, but give a local, one-shot security review enough
// time to start and verify the sealed payload. Timeout remains fail-closed.
const DEFAULT_REVIEW_TIMEOUT_MS = 30_000;
const CLOSED_OUTCOMES = new Set<IngressOutcome>(['accepted', 'quarantined', 'rejected']);
const CLOSED_REASON_CODES = new Set([
  'no_anomalies_detected',
  'recovery_replay_validated',
  'payload_digest_empty',
  'receipt_binding_invalid',
  'prompt_injection_detected',
]);
const INVALID_REVIEW_RESPONSE = 'ingress reviewer returned an invalid or untrusted verdict';

interface ReviewRequest extends IngressReviewDecisionInput {
  namespace: typeof PROTOCOL_NAMESPACE;
  callerContext: typeof SUPERVISOR_CONTEXT;
  requestId: string;
  /** One-time AEAD ciphertext for the already-authoritative result only. */
  sealedPayload?: string;
}

export interface IndependentIngressReviewerOptions {
  /** Test-only worker override for crash/timeout/malformed IPC cases. */
  workerPath?: string;
  /** Bounded subprocess execution. A timeout is an ingress denial. */
  timeoutMs?: number;
}

export interface IndependentIngressReviewResult extends IngressReviewResult {
  toolProjection: ToolTerminalProjectionResult | null;
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
  private readonly terminalProjection?: ToolTerminalProjectionService;
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
        postCommitBody?: (args: {
          outcomeEventId: string;
          review: { effectId: string; findingId: string; reviewDecisionId: string;
            outcome: IngressOutcome; stateBefore: string; stateAfter: string;
            payloadDigest: string; outcomeEventId: string;
            sanitizedReasonCode?: string; sanitizedReasonDetail?: string;
          };
        }) => unknown;
      }): {
        effectId: string; findingId: string; reviewDecisionId: string;
        outcome: IngressOutcome; stateBefore: string; stateAfter: string;
        payloadDigest: string; outcomeEventId: string;
        sanitizedReasonCode?: string; sanitizedReasonDetail?: string;
      };
    },
    terminalProjectionOrOptions?: ToolTerminalProjectionService | IndependentIngressReviewerOptions,
    options: IndependentIngressReviewerOptions = {},
  ) {
    this.terminalProjection = terminalProjectionOrOptions instanceof ToolTerminalProjectionService
      ? terminalProjectionOrOptions
      : undefined;
    const resolvedOptions = terminalProjectionOrOptions instanceof ToolTerminalProjectionService
      ? options
      : terminalProjectionOrOptions ?? options;
    this.workerPath = resolvedOptions.workerPath ?? this.resolveWorkerPath();
    this.timeoutMs = resolvedOptions.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
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
    let workerScratch: string | null = null;
    let execution: ReturnType<typeof spawnSync> | null = null;
    try {
      workerScratch = fs.mkdtempSync(path.join(process.cwd(), '.ogra-ingress-review-'));
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
    } catch {
      throw new OgraError(OgraErrorCode.INGRESS_REVIEW_DENIED,
        'ingress reviewer is unavailable');
    } finally {
      if (workerScratch) {
        try {
          fs.rmSync(workerScratch, { recursive: true, force: true });
        } catch {
          // Cleanup failure is non-authoritative and must not expose a system
          // exception or replace the stable reviewer outcome.
        }
      }
    }
    if (!execution || execution.error || execution.signal || execution.status !== 0) {
      throw new OgraError(OgraErrorCode.INGRESS_REVIEW_DENIED,
        'ingress reviewer is unavailable');
    }
    return this.validateResponse(String(execution.stdout), requestId);
  }

  reviewAndFinalize(input: {
    effectId: string; runId: string; workspaceId: string; receiptId: string;
    attemptNo: number; payloadDigest: string; source: ReviewerSource;
    ruleVersion: string; leaseHolderId: string; leaseVersion: number;
    asOf?: string;
  }): IndependentIngressReviewResult {
    try {
      // Core remains the authority for receipt ownership and AEAD verification.
      // Do this before spawning the detector so capsule faults preserve their
      // durable CAPSULE_* semantics instead of being confused with worker loss.
      const payload = this.verifyAuthoritativeResult(input);
      const isToolEffect = Boolean(this._odb.getDB().prepare(
        'SELECT 1 FROM tool_invocations WHERE effect_id = ?',
      ).get(input.effectId));
      if (isToolEffect && !(this.terminalProjection instanceof ToolTerminalProjectionService)) {
        throw new OgraError(OgraErrorCode.INGRESS_REVIEW_DENIED,
          'tool ingress terminal projection is unavailable');
      }
      const projection = this.terminalProjection?.forVerifiedResult({
        effectId: input.effectId,
        receiptId: input.receiptId,
        attemptNo: input.attemptNo,
        workspaceId: input.workspaceId,
        verifiedPayload: payload,
        leaseHolderId: input.leaseHolderId,
        leaseVersion: input.leaseVersion,
        sourceKind: input.source === 'agent' ? 'production' : 'recovery',
        ruleVersion: input.ruleVersion,
      }) ?? null;
      if (isToolEffect && !projection) {
        throw new OgraError(OgraErrorCode.INGRESS_REVIEW_DENIED,
          'tool ingress terminal projection is unavailable');
      }
      const verdict = this.review({
        effectId: input.effectId, runId: input.runId, workspaceId: input.workspaceId,
        receiptId: input.receiptId, attemptNo: input.attemptNo,
        payloadDigest: input.payloadDigest, source: input.source,
      }, payload);
      const finalized = this.ingressReview.finalizeIngressDecision({
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
        postCommitBody: projection?.postCommitBody,
      });
      if (projection && !projection.result) {
        throw new OgraError(OgraErrorCode.INGRESS_REVIEW_DENIED,
          'tool ingress terminal projection did not complete');
      }
      return { ...finalized, toolProjection: projection?.result ?? null };
    } catch (err) {
      if (err instanceof OgraError) throw err;
      throw new OgraError(OgraErrorCode.INGRESS_REVIEW_DENIED,
        'ingress review finalization failed');
    }
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new OgraError(OgraErrorCode.INGRESS_REVIEW_DENIED,
        INVALID_REVIEW_RESPONSE);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new OgraError(OgraErrorCode.INGRESS_REVIEW_DENIED,
        INVALID_REVIEW_RESPONSE);
    }
    const response = parsed as Record<string, unknown>;
    const rawVerdict = response.verdict;
    if (!rawVerdict || typeof rawVerdict !== 'object' || Array.isArray(rawVerdict)) {
      throw new OgraError(OgraErrorCode.INGRESS_REVIEW_DENIED,
        INVALID_REVIEW_RESPONSE);
    }
    const verdict = rawVerdict as Record<string, unknown>;
    const structuredFindings = this.validateStructuredFindings(verdict.structuredFindings);
    if (response.namespace !== PROTOCOL_NAMESPACE
      || response.callerContext !== WORKER_CONTEXT
      || response.requestId !== requestId
      || typeof response.pid !== 'number'
      || !Number.isInteger(response.pid)
      || response.pid === process.pid
      || !CLOSED_OUTCOMES.has(verdict.outcome as IngressOutcome)
      || typeof verdict.reviewer !== 'string'
      || verdict.reviewer !== 'default-policy'
      || (verdict.sanitizedReasonCode !== undefined
        && (!CLOSED_REASON_CODES.has(verdict.sanitizedReasonCode as string)))
      || structuredFindings === null) {
      throw new OgraError(OgraErrorCode.INGRESS_REVIEW_DENIED,
        INVALID_REVIEW_RESPONSE);
    }
    this.lastWorkerPid = response.pid as number;
    return {
      outcome: verdict.outcome as IngressOutcome,
      reviewer: verdict.reviewer,
      sanitizedReasonCode: verdict.sanitizedReasonCode as string | undefined,
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
