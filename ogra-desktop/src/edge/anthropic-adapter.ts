import { BaseModelAdapter, ModelRequest, ModelResult, ModelCapabilities, ProviderHealth, ModelEvent } from '../core/model-adapter';
import { OgraSecretBroker } from '../core/secret-broker';
import { AuditService } from '../core/audit-service';
import { ProviderService } from '../core/provider-service';
import { OgraError, OgraErrorCode } from '../shared/errors';
import * as crypto from 'crypto';

/**
 * Anthropic Messages API adapter.
 *
 * Connects to https://api.anthropic.com/v1/messages and supports
 * Claude Opus / Sonnet / Haiku. The Messages API is *not* OpenAI-
 * compatible — the request shape, header (`x-api-key` + `anthropic-version`),
 * system-prompt convention, and response envelope all differ — so this
 * adapter is its own class rather than a thin wrapper around the
 * OpenAI-compatible path.
 *
 * # Status (PoC)
 *
 * This file is a self-contained demonstration. It is NOT yet wired
 * into `electron/main/main.ts` (the dispatch in `ProviderService`
 * still only knows `ollama` and `openai_compatible`). To activate:
 *
 *   1. Add `anthropic` to `ProviderKind` in `src/shared/types.ts`.
 *   2. In `electron/main/main.ts`, instantiate `AnthropicAdapter`
 *      alongside `OllamaAdapter` / `OpenAICompatibleAdapter` and
 *      dispatch on the provider kind in `addProvider` / `addAnthropic`.
 *   3. Wire the Settings → API Keys panel to call into the broker
 *      with `providerId = 'anthropic'` and the user's `sk-ant-…` key.
 *
 * Until those three steps land, importing this file is harmless:
 * nothing in the running app will instantiate it.
 *
 * # Egress policy
 *
 * Confidential and Restricted data is blocked before any HTTP call.
 * This mirrors the OpenAI-compatible adapter — the cloud boundary
 * is the same regardless of which cloud provider. To use Claude
 * with Confidential data, the route must be Approve-then-Egress and
 * the user must explicitly approve the sanitized preview.
 *
 * # Streaming
 *
 * Anthropic streams via SSE on `/v1/messages?stream=true`. The base
 * `BaseModelAdapter.stream?` hook is implemented in this file but
 * the current `generate()` path is non-streaming (the InternalAgent
 * adapter asks for the full response). Wire the streaming path
 * when the InternalAgent adapter grows an SSE consumer.
 */

/** Default API base — overridable in `updateConfig` for proxies / VPC endpoints. */
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const MESSAGES_PATH = '/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
/** Anthropic requires `max_tokens` to be set; default is conservative. */
const DEFAULT_MAX_TOKENS = 2048;

export class AnthropicAdapter extends BaseModelAdapter {
  readonly id = 'anthropic_adapter';
  readonly providerId = 'anthropic';
  readonly isLocal = false;
  readonly capabilities: ModelCapabilities = {
    streaming: true,
    toolCalling: true,
    fileUpload: false,
  };

  /** runId -> AbortController for external cancellation (generate + stream) */
  private activeRequests = new Map<string, AbortController>();

  constructor(
    private baseUrl: string,
    private defaultModel: string,
    private secretBroker: OgraSecretBroker,
    private auditService?: AuditService,
    private providerService?: ProviderService,
  ) {
    super();
  }

  /**
   * Block Confidential / Restricted up front. The base class's
   * `validatePolicyGate()` runs first (it checks the policy gate
   * fields) and then this classification gate runs — order matters.
   */
  private enforceEgressPolicy(request: ModelRequest): void {
    const snap = request.routeDecisionSnapshot as Record<string, unknown>;
    const classification = snap?.dataClassification as string | undefined;
    if (classification === 'Confidential' || classification === 'Restricted') {
      throw new OgraError(
        OgraErrorCode.POLICY_BLOCKED,
        `Anthropic adapter blocked for ${classification} data. ` +
        `Use a local adapter, or route via Approve-then-Egress with a sanitized preview.`,
      );
    }
  }

  async generate(request: ModelRequest): Promise<ModelResult> {
    this.validatePolicyGate(request);
    this.enforceEgressPolicy(request);
    const startedAt = new Date().toISOString();

    // Verify provider is still registered and enabled.
    if (this.providerService) {
      const provider = await this.providerService.getProvider(this.providerId);
      if (!provider.enabled) {
        throw new OgraError(
          OgraErrorCode.PROVIDER_NOT_FOUND,
          `Provider ${this.providerId} is disabled`,
        );
      }
    }

    const abortController = new AbortController();
    this.activeRequests.set(request.runId, abortController);

    const { system, messages } = splitSystemAndMessages(request.promptParts);

    // Anthropic expects `claude-…` model ids; we accept the
    // `allowedModelId` as-is and let the API reject unknown ones
    // (cleaner error than a client-side alias table that would
    // drift out of date as Anthropic ships new models).
    const body = {
      model: request.allowedModelId || this.defaultModel,
      system: system || undefined,
      messages,
      max_tokens: DEFAULT_MAX_TOKENS,
    };

    const apiKey = await this.secretBroker.getValue(this.providerId);

    try {
      const response = await fetch(`${this.baseUrl}${MESSAGES_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'x-api-key': apiKey } : {}),
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Anthropic returned ${response.status}: ${errText}`);
      }

      const data = await response.json() as {
        content?: Array<{ type: string; text?: string }>;
        stop_reason?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };

      // Anthropic returns content blocks; we concatenate text blocks
      // and ignore non-text blocks (e.g. tool_use) for now. When the
      // tool-calling path is wired (Capability.supportsToolCalling is
      // already true) the loop will need to handle tool_use blocks.
      const text = (data.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('');

      const completedAt = new Date().toISOString();
      const promptTokens = data.usage?.input_tokens ?? 0;
      const completionTokens = data.usage?.output_tokens ?? 0;

      return {
        id: `model_call_${crypto.randomBytes(8).toString('hex')}`,
        content: text,
        finishReason: data.stop_reason ?? 'stop',
        tokenUsage: {
          prompt: promptTokens,
          completion: completionTokens,
          total: promptTokens + completionTokens,
        },
        modelId: request.allowedModelId,
        providerId: this.providerId,
        responseHash: crypto.createHash('sha256').update(text).digest('hex'),
        httpBodyHash: 'adapter_body_hash',
        startedAt,
        completedAt,
      };
    } catch (err) {
      const completedAt = new Date().toISOString();
      throw new Error(`Anthropic generation failed: ${(err as Error).message}`);
    } finally {
      this.activeRequests.delete(request.runId);
    }
  }

  /**
   * SSE streaming. Anthropic streams `event: content_block_delta`
   * with `data: { delta: { type: 'text_delta', text: '...' } }` for
   * each token; we yield one `ModelEvent` per delta and a final
   * `'done'` with token usage. The stream is registered for
   * cancellation via the same `activeRequests` map as `generate()`.
   */
  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    this.validatePolicyGate(request);
    this.enforceEgressPolicy(request);
    const startedAt = new Date().toISOString();

    if (this.providerService) {
      const provider = await this.providerService.getProvider(this.providerId);
      if (!provider.enabled) {
        throw new OgraError(
          OgraErrorCode.PROVIDER_NOT_FOUND,
          `Provider ${this.providerId} is disabled`,
        );
      }
    }

    const abortController = new AbortController();
    this.activeRequests.set(request.runId, abortController);

    const { system, messages } = splitSystemAndMessages(request.promptParts);
    const body = {
      model: request.allowedModelId || this.defaultModel,
      system: system || undefined,
      messages,
      max_tokens: DEFAULT_MAX_TOKENS,
      stream: true,
    };

    const apiKey = await this.secretBroker.getValue(this.providerId);
    let promptTokens = 0;
    let completionTokens = 0;
    let finishReason: string | undefined;

    try {
      const response = await fetch(`${this.baseUrl}${MESSAGES_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'x-api-key': apiKey } : {}),
          'anthropic-version': ANTHROPIC_VERSION,
          'accept': 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });

      if (!response.ok || !response.body) {
        const errText = await response.text();
        throw new Error(`Anthropic stream failed: ${response.status} ${errText}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      // Anthropic SSE frames are separated by blank lines. Each event
      // line is `event: <name>` and `data: <json>`. We accumulate
      // `data:` lines until a blank line, then dispatch.
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const ev = parseSseFrame(frame);
          if (!ev) continue;
          if (ev.event === 'content_block_delta' && ev.data) {
            try {
              const parsed = JSON.parse(ev.data);
              const text = parsed?.delta?.text;
              if (typeof text === 'string' && text.length > 0) {
                yield { type: 'token', data: text };
              }
            } catch { /* malformed frame — skip */ }
          } else if (ev.event === 'message_delta' && ev.data) {
            try {
              const parsed = JSON.parse(ev.data);
              if (typeof parsed?.stop_reason === 'string') {
                finishReason = parsed.stop_reason;
              }
              if (typeof parsed?.usage?.output_tokens === 'number') {
                completionTokens = parsed.usage.output_tokens;
              }
            } catch { /* malformed frame — skip */ }
          } else if (ev.event === 'message_start' && ev.data) {
            try {
              const parsed = JSON.parse(ev.data);
              if (typeof parsed?.message?.usage?.input_tokens === 'number') {
                promptTokens = parsed.message.usage.input_tokens;
              }
            } catch { /* malformed frame — skip */ }
          }
        }
      }

      yield {
        type: 'done',
        data: '',
        finishReason,
        tokenUsage: { prompt: promptTokens, completion: completionTokens, total: promptTokens + completionTokens },
      };
    } catch (err) {
      yield { type: 'error', data: (err as Error).message };
    } finally {
      this.activeRequests.delete(request.runId);
    }
  }

  cancel(runId: string): void {
    const controller = this.activeRequests.get(runId);
    if (controller) {
      controller.abort();
      this.activeRequests.delete(runId);
    }
  }

  async testConnection(): Promise<ProviderHealth> {
    try {
      const apiKey = await this.secretBroker.getValue(this.providerId);
      const start = Date.now();

      // Anthropic has no `models` endpoint equivalent; the cheapest
      // probe is a 1-token `max_tokens: 1` request to `/v1/messages`
      // with a known-cheap model. The cost is negligible (~ a few
      // hundred input tokens) and the request is cancelable.
      const response = await fetch(`${this.baseUrl}${MESSAGES_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'x-api-key': apiKey } : {}),
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: this.defaultModel,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: AbortSignal.timeout(8000),
      });
      const latency = Date.now() - start;

      if (!response.ok) {
        this.auditService?.appendEvent({
          runId: '',
          workspaceId: '',
          eventType: 'connection_test',
          eventPayload: { providerId: this.providerId, success: false, status: response.status, latency },
        });
        return { ok: false, message: `Anthropic returned ${response.status}` };
      }

      this.auditService?.appendEvent({
        runId: '',
        workspaceId: '',
        eventType: 'connection_test',
        eventPayload: { providerId: this.providerId, success: true, model: this.defaultModel, latency },
      });

      return {
        ok: true,
        message: `Connected to Anthropic at ${this.baseUrl}`,
        models: [this.defaultModel],
        latency,
      };
    } catch (err) {
      this.auditService?.appendEvent({
        runId: '',
        workspaceId: '',
        eventType: 'connection_test',
        eventPayload: { providerId: this.providerId, success: false, error: (err as Error).message },
      });
      return { ok: false, message: `Cannot connect: ${(err as Error).message}` };
    }
  }

  updateConfig(baseUrl?: string, defaultModel?: string): void {
    if (baseUrl) this.baseUrl = baseUrl;
    if (defaultModel) this.defaultModel = defaultModel;
  }
}

/**
 * Anthropic's Messages API requires the system prompt as a top-level
 * `system` field, not as a `system` role message. The Ogra
 * `ModelRequest` shape uses `promptParts` with `role: 'system' | …`;
 * we split them here.
 */
function splitSystemAndMessages(
  parts: ModelRequest['promptParts'],
): { system?: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> } {
  const systemParts: string[] = [];
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const p of parts) {
    if (p.role === 'system' || p.role === 'developer') {
      systemParts.push(p.content);
    } else if (p.role === 'assistant') {
      messages.push({ role: 'assistant', content: p.content });
    } else if (p.role === 'user' || p.role === 'context') {
      // RAG context arrives with `role: 'context'` in the Ogra
      // contract; Anthropic does not have a context role so we fold
      // it into a user message with a `[Context]` prefix so the
      // model can tell where the cited material ends.
      if (p.role === 'context') {
        messages.push({ role: 'user', content: `[Context]\n${p.content}` });
      } else {
        messages.push({ role: 'user', content: p.content });
      }
    }
  }
  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages,
  };
}

/**
 * Minimal Anthropic SSE frame parser. Returns `event` and `data`
 * strings; returns `null` for frames that are pure comments / heartbeats.
 */
function parseSseFrame(frame: string): { event: string; data: string } | null {
  let event = '';
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      // Multi-line `data:` is allowed by SSE; concatenate with newlines.
      const piece = line.slice(5).trimStart();
      data = data ? `${data}\n${piece}` : piece;
    }
  }
  if (!event && !data) return null;
  return { event, data };
}
