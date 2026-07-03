import { BaseModelAdapter, ModelRequest, ModelResult, ModelCapabilities, ProviderHealth } from '../core/model-adapter';
import { OgraSecretBroker } from '../core/secret-broker';
import * as crypto from 'crypto';

/**
 * Ollama model adapter.
 *
 * Connects to a local Ollama instance for fully local model inference.
 * No API key required.
 */
export class OllamaAdapter extends BaseModelAdapter {
  readonly id = 'ollama_adapter';
  readonly providerId = 'ollama_local';
  readonly isLocal = true;
  readonly capabilities: ModelCapabilities = {
    streaming: true,
    toolCalling: false,
    fileUpload: false,
  };

  constructor(
    private baseUrl: string,
    private defaultModel: string,
    private secretBroker?: OgraSecretBroker,
  ) {
    super();
  }

  async generate(request: ModelRequest): Promise<ModelResult> {
    this.validatePolicyGate(request);
    const startedAt = new Date().toISOString();

    // Build the Ollama chat request
    const messages = request.promptParts.map(p => ({
      role: p.role === 'context' ? 'user' : p.role,
      content: p.content,
    }));

    const modelName = request.allowedModelId.replace('ollama_', '').replace(':', '/');

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelName,
          messages,
          stream: false,
          options: {
            num_predict: 2048,
            temperature: 0.7,
          },
        }),
        signal: AbortSignal.timeout(60000),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Ollama returned ${response.status}: ${errText}`);
      }

      const data = await response.json() as any;
      const content = data.message?.content || '';
      const completedAt = new Date().toISOString();

      return {
        id: `model_call_${crypto.randomBytes(8).toString('hex')}`,
        content,
        finishReason: 'stop',
        tokenUsage: {
          prompt: data.prompt_eval_count || 0,
          completion: data.eval_count || 0,
          total: (data.prompt_eval_count || 0) + (data.eval_count || 0),
        },
        modelId: request.allowedModelId,
        providerId: this.providerId,
        responseHash: crypto.createHash('sha256').update(content).digest('hex'),
        startedAt,
        completedAt,
      };
    } catch (err) {
      const completedAt = new Date().toISOString();
      throw new Error(`Ollama generation failed: ${(err as Error).message}`);
    }
  }

  async testConnection(): Promise<ProviderHealth> {
    try {
      const start = Date.now();
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      const latency = Date.now() - start;

      if (!response.ok) {
        return { ok: false, message: `Ollama returned ${response.status}` };
      }

      const data = await response.json() as any;
      const models = (data.models || []).map((m: any) => m.name);

      return {
        ok: true,
        message: `Connected to Ollama at ${this.baseUrl}`,
        models,
        latency,
      };
    } catch (err) {
      return { ok: false, message: `Cannot connect to Ollama: ${(err as Error).message}` };
    }
  }

  updateConfig(baseUrl?: string, defaultModel?: string): void {
    if (baseUrl) this.baseUrl = baseUrl;
    if (defaultModel) this.defaultModel = defaultModel;
  }
}

/**
 * OpenAI-compatible model adapter.
 *
 * Connects to any OpenAI-compatible endpoint (local or cloud).
 * Supports API key auth through the secret broker.
 */
export class OpenAICompatibleAdapter extends BaseModelAdapter {
  readonly id = 'openai_compatible_adapter';
  readonly isLocal: boolean;

  constructor(
    public readonly providerId: string,
    private endpoint: string,
    private defaultModel: string,
    private secretBroker: OgraSecretBroker,
    isLocal: boolean,
    readonly capabilities: ModelCapabilities = {
      streaming: true,
      toolCalling: false,
      fileUpload: false,
    },
  ) {
    super();
    this.isLocal = isLocal;
  }

  async generate(request: ModelRequest): Promise<ModelResult> {
    this.validatePolicyGate(request);
    const startedAt = new Date().toISOString();

    // Build the OpenAI-compatible request
    const messages = request.promptParts.map(p => ({
      role: p.role === 'context' ? 'user' : p.role,
      content: p.content,
    }));

    // Get API key from secret broker
    const apiKey = await this.secretBroker.getValue(this.providerId);

    try {
      const response = await fetch(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: request.allowedModelId,
          messages,
          max_tokens: 2048,
          temperature: 0.7,
        }),
        signal: AbortSignal.timeout(60000),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Provider returned ${response.status}: ${errText}`);
      }

      const data = await response.json() as any;
      const choice = data.choices?.[0];
      const content = choice?.message?.content || '';
      const completedAt = new Date().toISOString();

      return {
        id: `model_call_${crypto.randomBytes(8).toString('hex')}`,
        content,
        finishReason: choice?.finish_reason || 'stop',
        tokenUsage: {
          prompt: data.usage?.prompt_tokens || 0,
          completion: data.usage?.completion_tokens || 0,
          total: data.usage?.total_tokens || 0,
        },
        modelId: request.allowedModelId,
        providerId: this.providerId,
        responseHash: crypto.createHash('sha256').update(content).digest('hex'),
        startedAt,
        completedAt,
      };
    } catch (err) {
      throw new Error(`OpenAI-compatible generation failed: ${(err as Error).message}`);
    }
  }

  async testConnection(): Promise<ProviderHealth> {
    try {
      const apiKey = await this.secretBroker.getValue(this.providerId);
      const start = Date.now();
      const response = await fetch(`${this.endpoint}/models`, {
        headers: {
          ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
        },
        signal: AbortSignal.timeout(5000),
      });
      const latency = Date.now() - start;

      if (!response.ok) {
        return { ok: false, message: `Provider returned ${response.status}` };
      }

      const data = await response.json() as any;
      const models = (data.data || []).map((m: any) => m.id);

      return {
        ok: true,
        message: `Connected to ${this.providerId} at ${this.endpoint}`,
        models,
        latency,
      };
    } catch (err) {
      return { ok: false, message: `Cannot connect: ${(err as Error).message}` };
    }
  }

  updateConfig(endpoint?: string, defaultModel?: string): void {
    if (endpoint) this.endpoint = endpoint;
    if (defaultModel) this.defaultModel = defaultModel;
  }
}
