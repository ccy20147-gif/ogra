import { RunEventType } from '../shared/types';
import { OgraError, OgraErrorCode } from '../shared/errors';
import type { RecoveryCapabilities } from './durable-runtime-types';

/**
 * Model adapter contract for Ogra Desktop.
 *
 * Every model adapter must implement this interface.
 * Adapters MUST reject requests that lack Core-issued policy gate evidence.
 */

export interface ModelCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  fileUpload: boolean;
}

export interface ModelRequest {
  runId: string;
  workspaceId: string;
  routeDecisionId: string;
  policyEvaluationId: string;
  policyVersionHash: string;
  allowedProviderId: string;
  allowedModelId: string;
  modelInternalId?: string;
  promptParts: Array<{
    role: 'system' | 'developer' | 'user' | 'assistant' | 'context';
    content: string;
    sourceIds?: string[];
  }>;
  contextSourceIds: string[];
  approvalId?: string;
  /**
   * Scope hash bound to the approval row at the time it was granted.
   * Adapters that perform their own scoping can check this against
   * the approval row before sending.
   */
  approvalScopeHash?: string;
  payloadHash: string;
  /** Raw adapter idempotency authority, supplied only from an authenticated
   * callback capsule. It must never be persisted in plaintext. */
  idempotencyKey?: string;
  routeDecisionSnapshot: Record<string, unknown>;
  /**
   * AbortSignal the adapter MUST honor to honor cancellation.
   * Adapters that ignore this signal fail closed.
   */
  signal?: AbortSignal;
}

export interface ModelResult {
  id: string;
  content: string;
  finishReason: string;
  tokenUsage: {
    prompt: number;
    completion: number;
    total: number;
  };
  modelId: string;
  providerId: string;
  responseHash: string;
  /**
   * P0: sha256 of the exact JSON body sent to the provider's HTTP
   * endpoint. This is the hash of the ACTUAL bytes that left the
   * machine — not the egress payload hash (which covers the
   * pre-serialization redacted preview). Both hashes are persisted
   * so the audit chain can verify that the redacted preview and
   * the HTTP body are consistent.
   */
  httpBodyHash: string;
  startedAt: string;
  completedAt: string;
  /** Which redaction rule set was applied at egress, if any. */
  redactionRuleVersion?: string;
}

export interface ModelEvent {
  type: 'token' | 'done' | 'error';
  data: string;
  finishReason?: string;
  tokenUsage?: { prompt: number; completion: number; total: number };
}

export interface ProviderHealth {
  ok: boolean;
  message?: string;
  models?: string[];
  latency?: number;
}

/**
 * Abstract base class for model adapters.
 *
 * Milestone 0 (Sequence 1A) — every adapter MUST declare its
 * recovery capabilities (plan 10 §5). The default is the most
 * conservative: no idempotency, no outcome query, no compensation.
 * Subclasses that bridge to providers supporting idempotency keys
 * or outcome queries MUST override.
 */
export abstract class BaseModelAdapter {
  abstract readonly id: string;
  abstract readonly providerId: string;
  abstract readonly isLocal: boolean;
  abstract readonly capabilities: ModelCapabilities;

  /**
   * Recovery capability declaration. Defaults are conservative —
   * everything false / low / lossless=false. Adapters that support
   * idempotency keys or outcome queries MUST override.
   */
  recoveryCapabilities(): RecoveryCapabilities {
    return {
      supportsIdempotencyKey: false,
      supportsOutcomeQuery: false,
      supportsCancel: false,
      supportsCompensation: false,
      compensationIsLossless: false,
      retryCostRisk: 'high',
      duplicateEffectRisk: 'high',
      auditLevel: 'summary',
    };
  }

  abstract generate(request: ModelRequest): Promise<ModelResult>;
  abstract testConnection(): Promise<ProviderHealth>;

  /**
   * Optional streaming method.
   * Adapters that support streaming should override this.
   */
  stream?(request: ModelRequest): AsyncGenerator<ModelEvent>;

  /**
   * Validate that the request has proper policy gate evidence
   * and that the provider/model IDs match the route decision.
   */
  protected validatePolicyGate(request: ModelRequest): void {
    if (!request.routeDecisionId) {
      throw new OgraError(OgraErrorCode.POLICY_BLOCKED, 'Missing route decision');
    }
    if (!request.policyEvaluationId) {
      throw new OgraError(OgraErrorCode.POLICY_BLOCKED, 'Missing policy evaluation');
    }
    if (!request.policyVersionHash) {
      throw new OgraError(OgraErrorCode.POLICY_BLOCKED, 'Missing policy version hash');
    }
    // Cross-verify provider/model IDs match the route decision
    if (request.allowedProviderId && this.providerId && request.allowedProviderId !== this.providerId) {
      throw new OgraError(OgraErrorCode.POLICY_BLOCKED,
        `Provider mismatch: route decision allows "${request.allowedProviderId}" but adapter is "${this.providerId}"`);
    }
    if (request.allowedModelId) {
      const snap = request.routeDecisionSnapshot as Record<string, unknown>;
      const snapModelId = snap?.modelId as string | undefined;
      if (snapModelId && request.allowedModelId !== snapModelId) {
        throw new OgraError(OgraErrorCode.POLICY_BLOCKED,
          `Model mismatch: route decision allows "${snapModelId}" but request uses "${request.allowedModelId}"`);
      }
    }
  }
}
