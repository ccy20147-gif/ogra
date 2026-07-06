import { RunEventType } from '../shared/types';
import { OgraError, OgraErrorCode } from '../shared/errors';

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
  promptParts: Array<{
    role: 'system' | 'developer' | 'user' | 'assistant' | 'context';
    content: string;
    sourceIds?: string[];
  }>;
  contextSourceIds: string[];
  approvalId?: string;
  payloadHash: string;
  routeDecisionSnapshot: Record<string, unknown>;
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
  startedAt: string;
  completedAt: string;
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
 */
export abstract class BaseModelAdapter {
  abstract readonly id: string;
  abstract readonly providerId: string;
  abstract readonly isLocal: boolean;
  abstract readonly capabilities: ModelCapabilities;

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
