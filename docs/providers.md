# Ogra Provider Configuration

> Source of truth: [`src/edge/model-adapters.ts`](../ogra-desktop/src/edge/model-adapters.ts), [`src/core/provider-service.ts`](../ogra-desktop/src/core/provider-service.ts), [`src/core/secret-broker.ts`](../ogra-desktop/src/core/secret-broker.ts), [`docs/plans/03-policy-routing-safety-engine.md`](plans/03-policy-routing-safety-engine.md)
>
> Audience: anyone wiring a model endpoint (Ollama, llama.cpp, vLLM, OpenAI-compatible API) into Ogra Desktop for the first time.
>
> Scope: Alpha (v0.1.0). Anthropic / Gemini / Bedrock adapters are not in Alpha — see §7.

## 1. The two-adapter model

Ogra ships two production model adapters. Every model in `ProviderService` is registered as one of these two, regardless of which product it came from.

| Adapter | File | Use case | Locality |
|---|---|---|---|
| `OllamaAdapter` | `src/edge/model-adapters.ts:14` | Ollama local server (and any Ollama-API-compatible daemon) | `isLocal: true` |
| `OpenAICompatibleAdapter` | `src/edge/model-adapters.ts:178` | Anything speaking the OpenAI Chat Completions API: OpenAI, Azure OpenAI, OpenRouter, vLLM, LM Studio, llama.cpp `--api-type openai`, Together, Fireworks, Groq, etc. | `isLocal: false` (cloud) **or** `isLocal: true` (local OpenAI-compatible) |

Both adapters implement `BaseModelAdapter` (`src/core/model-adapter.ts`), which enforces the policy gate before any HTTP call. The OpenAI-compatible variant adds one extra check: `Confidential` and `Restricted` data are blocked entirely (`model-adapters.ts:218-222`) — those must use a local adapter or the Approve-then-Egress tier per `plans/03-policy-routing-safety-engine.md` §2.

## 2. What "configuration" actually means

A provider is three things in Ogra:

1. **A `ProviderRecord`** in the local SQLite `model_providers` table — metadata: `kind` (ollama / openai_compatible), `endpoint`, `isLocal`, `data_retention_policy`, `training_opt_out`, `region`, `zero_data_retention_supported`, `supports_streaming`, `supports_tool_calling`, `enabled`. See `src/shared/types.ts` `ProviderKind` and `src/core/provider-service.ts` `ProviderRecord`.
2. **Zero or more `ModelRecord`s** — a model is `id` + `providerId` + `name` + `display_name` + `modality` + `local_only` + `enabled`. A provider is the *endpoint*; models are the *choices* on that endpoint.
3. **Optionally, a secret** in the `OgraSecretBroker` for the provider's API key. Secrets are stored encrypted under the app data dir, never in SQLite, never in renderer state.

The `SettingsTab` in the UI provides form-based CRUD for providers and secrets. There is no separate "admin" surface; everything lives in the Settings tab of the running app.

## 3. Quick start: Ollama (the default local path)

```bash
# 1. Install and start Ollama
curl -fsSL https://ollama.com/install.sh | sh
ollama serve &           # default port 11434
ollama pull qwen2.5:7b    # any model; pick what fits your machine

# 2. In Ogra:
#    Settings → Provider Management → Add Provider
#    Name:    ollama
#    Endpoint: http://localhost:11434
#    Local:   ✓
#    Save
#    → Test (should return "Connected to Ollama at http://localhost:11434" + model list)

# 3. In Ogra:
#    Settings → Model Configuration
#    (Ollama models surface automatically from /api/tags)
#    Pick qwen2.5:7b as the default.

# 4. Run a task. Route decision should show route: "local".
```

No API key. No cloud. No data leaves the machine. The `OllamaAdapter.testConnection()` probes `/api/tags` with a 5s timeout; a healthy Ollama returns the model list as `ProviderHealth.models`.

## 4. Quick start: llama.cpp (local, OpenAI-compatible mode)

llama.cpp ships with an OpenAI-compatible HTTP server. Run it like so:

```bash
# Install llama.cpp (binary or build from source)
./llama-server \
    -m /path/to/model.gguf \
    --port 8080 \
    --host 127.0.0.1
# That gives you a /v1 endpoint speaking OpenAI Chat Completions.
```

In Ogra:

```
Settings → Provider Management → Add Provider
  Name:     llama.cpp
  Endpoint: http://127.0.0.1:8080/v1
  Local:    ✓                       ← critical: must be on
  Save
  → Add an API Key in the next section. llama.cpp ignores any token but Ogra still expects the field;
    use a dummy value like "no-key-needed".
```

The `OpenAICompatibleAdapter` will probe `/models` on testConnection; llama.cpp returns the loaded model id there.

If you want zero-key flow, run llama.cpp with `--api-key ""` and have Ogra use a blank string as the secret; the `Authorization: Bearer …` header is only emitted when the key is non-empty (`model-adapters.ts:242`).

## 5. Quick start: OpenAI cloud

```
Settings → Provider Management → Add Provider
  Name:     openai
  Endpoint: https://api.openai.com/v1
  Local:    ✗                       ← critical: must be off
  Save
Settings → API Keys
  Provider: openai
  Key:      sk-…                     ← stored encrypted, never in renderer
  Save
Settings → Model Configuration
  Add: gpt-4o (or whatever you have access to)
```

The OpenAI-compatible adapter's `generate()` requests the secret from the broker on every call (`model-adapters.ts:235`), so rotating a key is just "save a new key in the API Keys panel" — no app restart.

Cloud adapters obey egress policy. A `Public` task with `gpt-4o` will pick `auto_redact` mode and fly; a `Confidential` task with the same provider will **be blocked at the policy gate** (see `model-adapters.ts:218-222` and `03-policy-routing-safety-engine.md` §2). For Confidential cloud work, switch the provider to `isLocal: true` (against a local OpenAI-compatible endpoint) or use the Approve-then-Egress tier after the redaction engine lands.

## 6. Provider metadata, retention, and risk

`ProviderRecord` carries the data-protection metadata the policy engine uses to score risk. The renderer's `SettingsTab` currently exposes a subset; the rest is recorded at provider creation time. For hand-editing or programmatic setup, the relevant fields are:

| Field | When to set it |
|---|---|
| `data_retention_policy` | Provider-side log/eval retention window. `0` for ZDR endpoints. |
| `training_opt_out` | `true` if the vendor contractually prohibits training on inputs (most paid tiers). |
| `region` | Data residency hint (`us`, `eu`, `cn`, `local`, `unknown`). |
| `zero_data_retention_supported` | `true` for vendors with a contractual ZDR tier. |
| `supports_streaming` | `true` if the model endpoint supports SSE. |
| `supports_tool_calling` | `true` for function-calling-capable models; Ogra will not enable MCP/A2A tools against a model that lacks this. |
| `enabled` | Set `false` to take a provider out of rotation without deleting its history. |

These fields are surfaced in `DataSafetyCenter` and `AiGovernanceCenter` risk summaries. A `Confidential` task against a provider with `data_retention_policy > 0` and `training_opt_out = false` raises the run risk; the user then sees the reason in the risk summary card and can decide.

## 7. Out of scope for Alpha

- **Anthropic** (Claude) — non-OpenAI-compatible. Adding a `ClaudeAdapter` would mean a parallel implementation of the message format, SSE events, prompt-caching fields, and the prompt-caching-aware redaction. Estimated ~300 lines + tests; not a blocker for Alpha.
- **Google Gemini** — non-OpenAI-compatible, similar scope as Anthropic.
- **AWS Bedrock** — non-OpenAI-compatible and adds AWS SigV4 signing on top.
- **Cohere / Mistral / AI21 / OpenRouter-native** — the OpenAI-compatible adapter already covers most of them; only OpenRouter's native API would need a separate adapter.
- **Tool calling / function calling** — `supports_tool_calling` is recorded but the runtime does not yet wire it through (A2A/MCP is planned for v1.0 per `plans/08-memory-agentgroup-recipes-v1-requirements.md` §7).

To add a new adapter:

1. Implement `BaseModelAdapter` (`src/core/model-adapter.ts`).
2. Register a `ProviderKind` in `src/shared/types.ts`.
3. Add the dispatch arm in `ProviderService` if your kind isn't `ollama` or `openai_compatible`.
4. Write a connection test in the new adapter's `testConnection()`.
5. Add a test fixture under `tests/unit/` and a render-only check in `tests/integration/`.

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Cannot connect: ECONNREFUSED 127.0.0.1:11434` | Ollama not running, or wrong port | `ollama serve`; check the endpoint in `Settings`. |
| `Provider returned 401` on a cloud test | Wrong key, or key not yet set | Add the key in `API Keys`. The broker is the only source. |
| `Policy blocked: Confidential` on a cloud call | Cloud adapter refuses Confidential / Restricted by design | Switch to a local adapter, or pin the workspace to local-only. After the redaction engine lands, the Approve-then-Egress tier allows it with user approval. |
| `Provider disabled` on a real run | `ProviderRecord.enabled = false` | Re-enable in `Settings → Provider Management`. |
| `0 Ogra-managed cloud calls` while expecting a cloud call | The route decision dropped to local (most often: high-water mark raised, no local model for that classification → block) | Check `RunWorkspaceTab → Route Decision` for the reason; switch the workspace default model or lower the data classification. |
| Connection test passes but every call 404s on `/chat/completions` | Endpoint is missing `/v1` or `/chat/completions` suffix | Set the endpoint to the API root, e.g. `https://api.openai.com/v1` or `http://127.0.0.1:8080/v1`. |

## 9. Where to look in the code

| Concern | File |
|---|---|
| `OllamaAdapter.generate()` | `src/edge/model-adapters.ts:37-108` |
| `OpenAICompatibleAdapter.generate()` | `src/edge/model-adapters.ts:203-283` |
| `BaseModelAdapter.validatePolicyGate()` (must be called first) | `src/core/model-adapter.ts` |
| `ProviderService.addOpenAICompatible()` | `src/core/provider-service.ts:105-129` |
| `ProviderService.testConnection()` | `src/core/provider-service.ts:131-…` |
| `OgraSecretBroker.getValue()` (API key source) | `src/core/secret-broker.ts` |
| Settings tab UI | `src/renderer/components/SettingsTab.tsx` |
| Egress policy gate (the line that throws POLICY_BLOCKED for Confidential) | `src/edge/model-adapters.ts:218-222` |
| 06 § Provider metadata surfacing in Data Safety Center | `plans/03-policy-routing-safety-engine.md` §6 + `plans/06-application-ui-ux.md` §9 |
