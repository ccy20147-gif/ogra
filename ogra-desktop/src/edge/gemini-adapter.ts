import { BaseModelAdapter, ModelRequest, ModelResult, ModelCapabilities, ProviderHealth, ModelEvent } from '../core/model-adapter';
import { OgraSecretBroker } from '../core/secret-broker';
import { AuditService } from '../core/audit-service';
import { ProviderService } from '../core/provider-service';
import { OgraError, OgraErrorCode } from '../shared/errors';
import * as crypto from 'crypto';

/**
 * Google Gemini (Generative Language) API adapter.
 *
 * Connects to https://generativelanguage.googleapis.com/v1beta/models/{model}
 * :generateContent and supports Gemini Pro / Flash / Ultra. Like the
 * Anthropic adapter, this is NOT OpenAI-compatible: the endpoint,
 * auth model, request shape, and streaming format all differ.
 *
 * # Auth
 *
 * Gemini uses an API key passed as the `key` query parameter
 * (`?key=...`) rather than a header. We accept the same Ogra
 * `OgraSecretBroker` value as for the OpenAI / Anthropic adapters —
 * the value is the same opaque string, only the transport differs.
 *
 * # System instructions
 *
 * Gemini takes the system prompt as a top-level `systemInstruction`
 * field, similar in spirit to Anthropic's `system`. Ogra's
 * `ModelRequest.promptParts` folds both into `role: 'system' | 'developer'`,
 * which the split helper below unwinds.
 *
 * # Response envelope
 *
 * Unlike OpenAI (`choices[0].message.content`) and Anthropic
 * (`content: [{type:'text', text:…}]`), Gemini returns
 * `candidates[0].content.parts[0].text` — a *different* indentation
 * for the same idea. Token usage is `usageMetadata.promptTokenCount /
 * candidatesTokenCount / totalTokenCount` — yet another naming.
 *
 * # Streaming
 *
 * Gemini streams via SSE on `…:streamGenerateContent?alt=sse`. The
 * frames are plain `data: {json}` lines (no `event:` field) and each
 * frame carries a partial `candidates[0].content.parts[0].text` we
 * append. The stream is registered for cancellation via the same
 * `activeRequests` map as `generate()`.
 *
 * # Status (PoC)
 *
 * This file is a self-contained demonstration. It is NOT yet wired
 * into `electron/main/main.ts` (the dispatch in `ProviderService`
 * still only knows `ollama` and `openai_compatible`). To activate:
 *
 *   1. Add `gemini` to `ProviderKind` in `src/shared/types.ts`.
 *   2. In `electron/main/main.ts`, instantiate `GeminiAdapter` and
 *      dispatch on the provider kind in `addProvider` / `addGemini`.
 *   3. Wire the Settings → API Keys panel to call into the broker
 *      with `providerId = 'gemini'` and the user's Google AI Studio
 *      key.
 *
 * Until those three steps land, importing this file is harmless:
 * nothing in the running app will instantiate it.
 *
 * # Egress policy
 *
 * Confidential and Restricted data is blocked before any HTTP call.
 * Same contract as the OpenAI-compatible and Anthropic adapters —
 * the cloud boundary is the same regardless of which cloud provider.
 *
 * # Tool calling
 *
 * Gemini has native function-calling support
 * (`tools: [{functionDeclarations: [...]}]`) and is recorded as
 * `supports_tool_calling: true` in capabilities, but the actual
 * tool-call loop is not wired in this PoC. When the InternalAgent
 * adapter grows a tool-use handler, the Gemini tool-call encoding
 * is the next adapter to plumb.
 */

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const API_VERSION = 'v1beta';
/** Gemini requires a default model in the URL path; overridable in `updateConfig`. */
const DEFAULT_MODEL = 'gemini-1.5-pro';
const DEFAULT_MAX_TOKENS = 2048;

export class GeminiAdapter extends BaseModelAdapter {
  readonly id = 'gemini_adapter';
  readonly providerId = 'gemini';
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
   * fields) and then this classification gate runs.
   */
  private enforceEgressPolicy(request: ModelRequest): void {
    const snap = request.routeDecisionSnapshot as Record<string, unknown>;
    const classification = snap?.dataClassification as string | undefined;
    if (classification === 'Confidential' || classification === 'Restricted') {
      throw new OgraError(
        OgraErrorCode.POLICY_BLOCKED,
        `Gemini adapter blocked for ${classification} data. ` +
        `Use a local adapter, or route via Approve-then-Egress with a sanitized preview.`,
      );
    }
  }

  async generate(request: ModelRequest): Promise<ModelResult> {
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

    const { systemInstruction, contents } = splitSystemAndContents(request.promptParts);
    const modelId = request.allowedModelId || this.defaultModel;

    const body = {
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      generationConfig: { maxOutputTokens: DEFAULT_MAX_TOKENS },
    };

    const apiKey = await this.secretBroker.getValue(this.providerId);

    try {
      // Auth: Gemini takes the key as the `key` query parameter, NOT a
      // header. This is the single most surprising difference from
      // every other cloud provider we support — worth calling out.
      const url = new URL(
        `${this.baseUrl}/${API_VERSION}/models/${encodeURIComponent(modelId)}:generateContent`,
      );
      if (apiKey) url.searchParams.set('key', apiKey);

      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini returned ${response.status}: ${errText}`);
      }

      const data = await response.json() as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
          finishReason?: string;
        }>;
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          totalTokenCount?: number;
        };
      };

      // The first candidate's first text part is the answer. Other
      // parts (functionCall, etc.) are ignored for now — see the file
      // header for the tool-calling follow-up plan.
      const text = (data.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? '')
        .join('');

      const completedAt = new Date().toISOString();
      const promptTokens = data.usageMetadata?.promptTokenCount ?? 0;
      const completionTokens = data.usageMetadata?.candidatesTokenCount ?? 0;

      return {
        id: `model_call_${crypto.randomBytes(8).toString('hex')}`,
        content: text,
        finishReason: data.candidates?.[0]?.finishReason ?? 'stop',
        tokenUsage: {
          prompt: promptTokens,
          completion: completionTokens,
          total: promptTokens + completionTokens,
        },
        modelId,
        providerId: this.providerId,
        responseHash: crypto.createHash('sha256').update(text).digest('hex'),
        startedAt,
        completedAt,
      };
    } catch (err) {
      const completedAt = new Date().toISOString();
      throw new Error(`Gemini generation failed: ${(err as Error).message}`);
    } finally {
      this.activeRequests.delete(request.runId);
    }
  }

  /**
   * SSE streaming. Gemini's stream is `…:streamGenerateContent?alt=sse`
   * — note `alt=sse` is required; the default alt returns a single
   * newline-delimited JSON object instead of a real event stream.
   * Each line is `data: {…}` (no `event:` field) carrying a partial
   * `candidates[0].content.parts[0].text` we append.
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

    const { systemInstruction, contents } = splitSystemAndContents(request.promptParts);
    const modelId = request.allowedModelId || this.defaultModel;

    const body = {
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      generationConfig: { maxOutputTokens: DEFAULT_MAX_TOKENS },
    };

    const apiKey = await this.secretBroker.getValue(this.providerId);
    let promptTokens = 0;
    let completionTokens = 0;
    let finishReason: string | undefined;

    try {
      const url = new URL(
        `${this.baseUrl}/${API_VERSION}/models/${encodeURIComponent(modelId)}:streamGenerateContent`,
      );
      if (apiKey) url.searchParams.set('key', apiKey);
      // alt=sse is REQUIRED for SSE; without it Gemini returns a
      // single newline-delimited JSON object and the SSE parser below
      // would see only one frame.
      url.searchParams.set('alt', 'sse');

      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });

      if (!response.ok || !response.body) {
        const errText = await response.text();
        throw new Error(`Gemini stream failed: ${response.status} ${errText}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      // Gemini SSE: frames are separated by `\n\n`, each frame is a
      // single `data: {json}` line. We accumulate until blank line.
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const data = extractSseData(frame);
          if (!data) continue;
          try {
            const parsed = JSON.parse(data);
            const part = parsed?.candidates?.[0]?.content?.parts?.[0];
            if (part && typeof part.text === 'string' && part.text.length > 0) {
              yield { type: 'token', data: part.text };
            }
            // Gemini reports usage and finishReason on the final
            // candidate. We accept whichever is present on any frame.
            if (typeof parsed?.candidates?.[0]?.finishReason === 'string') {
              finishReason = parsed.candidates[0].finishReason;
            }
            const usage = parsed?.usageMetadata;
            if (usage) {
              if (typeof usage.promptTokenCount === 'number') {
                promptTokens = usage.promptTokenCount;
              }
              if (typeof usage.candidatesTokenCount === 'number') {
                completionTokens = usage.candidatesTokenCount;
              }
            }
          } catch { /* malformed frame — skip */ }
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

      // Cheapest possible probe: a 1-token `maxOutputTokens` request.
      // Cost is ~ a few hundred input tokens; the request is
      // cancelable and we don't care about the answer.
      const url = new URL(
        `${this.baseUrl}/${API_VERSION}/models/${encodeURIComponent(this.defaultModel)}:generateContent`,
      );
      if (apiKey) url.searchParams.set('key', apiKey);

      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
          generationConfig: { maxOutputTokens: 1 },
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
        return { ok: false, message: `Gemini returned ${response.status}` };
      }

      this.auditService?.appendEvent({
        runId: '',
        workspaceId: '',
        eventType: 'connection_test',
        eventPayload: { providerId: this.providerId, success: true, model: this.defaultModel, latency },
      });

      return {
        ok: true,
        message: `Connected to Gemini at ${this.baseUrl}`,
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
 * Gemini's generateContent takes the system prompt as a top-level
 * `systemInstruction` field, not as a `system` role message. The
 * Ogra `ModelRequest` shape uses `promptParts` with `role: 'system'
 * | 'developer' | …`; we split them here.
 *
 * Gemini also expects `contents` as an array of
 * `{ role, parts: [{text}] }`, so we map Ogra's
 * `role: 'user' | 'assistant' | 'context'` to Gemini's
 * `role: 'user' | 'model'`. (RAG context folds into a user message
 * with a `[Context]` prefix, same trick we use for Anthropic.)
 */
function splitSystemAndContents(
  parts: ModelRequest['promptParts'],
): { systemInstruction?: { role: 'system'; parts: Array<{ text: string }> }; contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> } {
  const systemParts: string[] = [];
  const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
  for (const p of parts) {
    if (p.role === 'system' || p.role === 'developer') {
      systemParts.push(p.content);
    } else if (p.role === 'assistant') {
      contents.push({ role: 'model', parts: [{ text: p.content }] });
    } else if (p.role === 'user' || p.role === 'context') {
      if (p.role === 'context') {
        contents.push({ role: 'user', parts: [{ text: `[Context]\n${p.content}` }] });
      } else {
        contents.push({ role: 'user', parts: [{ text: p.content }] });
      }
    }
  }
  return {
    systemInstruction: systemParts.length > 0
      ? { role: 'system', parts: [{ text: systemParts.join('\n\n') }] }
      : undefined,
    contents,
  };
}

/**
 * Gemini SSE frames are plain `data: {json}` lines (no `event:` field)
 * separated by blank lines. We extract the *last* `data:` value from
 * the frame (Gemini emits a single `data:` per frame) and return
 * `null` for empty/comment frames.
 */
function extractSseData(frame: string): string | null {
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('data:')) {
      const piece = line.slice(5).trimStart();
      data = data ? `${data}\n${piece}` : piece;
    }
  }
  return data || null;
}
