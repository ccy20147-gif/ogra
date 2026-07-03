# 05 Model and Agent Orchestration

> Layer: model adapters, internal agent runs, and phased orchestration
>
> Phase coverage: Alpha required, Beta/v1 extensions noted
>
> Depends on: [03 Policy, Routing, and Safety Engine](03-policy-routing-safety-engine.md), [04 RAG and Knowledge Engine](04-rag-knowledge-engine.md)

## 1. Goal

Build the execution layer that runs Ogra tasks through policy-aware model adapters and auditable agent adapters.

Alpha proves a single InternalAgentAdapter can:

- retrieve local context.
- evaluate policy.
- select local/cloud/blocked route.
- invoke an approved model.
- record model calls.
- return answer, citations, route trace, and audit evidence.

The architecture must leave room for Agent Group orchestration without pretending Alpha is already a full multi-agent workspace.

## 2. Model Adapter Contract

Every model adapter MUST implement:

```typescript
interface ModelAdapter {
  id: string;
  providerId: string;
  isLocal: boolean;
  capabilities: {
    streaming: boolean;
    toolCalling: boolean;
    fileUpload: boolean;
  };
  generate(request: ModelRequest): Promise<ModelResult>;
  stream?(request: ModelRequest): AsyncIterable<ModelEvent>;
  testConnection(): Promise<ProviderHealth>;
}
```

`ModelRequest` MUST include:

- run id.
- workspace id.
- route decision id.
- policy evaluation id.
- policy version hash.
- allowed provider id.
- allowed model id.
- model id.
- prompt parts.
- context source ids.
- approval id when needed.
- payload hash.
- route decision snapshot.

Adapters MUST NOT accept raw arbitrary prompt strings from renderer.

Adapters MUST reject requests that lack Core-issued policy gate evidence. The adapter layer must verify that provider/model ids match the route decision and policy evaluation before sending any request.

## 3. Alpha Model Adapters

Alpha MUST implement:

### 3.1 Ollama Adapter

Requirements:

- local provider.
- configurable base URL.
- configurable default model.
- connection test.
- generation request.
- timeout and cancellation.
- model call record with `is_cloud = false`.
- no API key requirement.

### 3.2 OpenAI-Compatible Adapter

Requirements:

- cloud or local endpoint mode.
- provider metadata registry.
- provider data-retention, training opt-out, region, zero-data-retention, file-upload, tool-calling, and streaming-log risk metadata.
- secret broker integration.
- masked key metadata in UI.
- connection test that writes audit event.
- generation request only after policy allows cloud/local endpoint use.
- model call record with `is_cloud` derived from provider metadata.
- request/upload payload hash.
- response hash.
- error/status recording.

OpenAI-compatible cloud calls MUST be blocked for Confidential and Restricted data in Alpha without exception.

Alpha MUST default OpenAI-compatible tool calling and file upload to disabled. Streaming MUST NOT write complete prompts, payloads, or sensitive chunks to logs.

## 4. Model Selection

Alpha model selection MUST be policy-controlled.

Inputs:

- requested model, if user selected one.
- workspace default model.
- data classification.
- provider locality.
- model allowlist.
- route decision.
- approval status.

Behavior:

- Public data MAY use cloud model if policy allows.
- Internal data defaults local; cloud requires redaction/approval when private context is included.
- Confidential data uses local model or blocks.
- Restricted data uses allowlisted local model or blocks.

If no acceptable model is available, the run MUST become blocked with a user-visible reason.

## 5. InternalAgentAdapter

Alpha MUST implement only `InternalAgentAdapter`.

Responsibilities:

- accept a bounded user task.
- retrieve context through RAG service.
- invoke policy and router before context assembly and model call.
- assemble prompt with untrusted context separation.
- invoke selected model adapter.
- record participating agent.
- record accessed files/chunks.
- record model call.
- record route decision and run events.
- return structured result to UI.

InternalAgentAdapter MUST default to:

- read-only workspace RAG.
- no shell.
- no arbitrary network.
- no clipboard/browser/MCP/A2A access.
- no cross-workspace access.
- no direct secret access.

## 6. Run Lifecycle

Every run MUST follow:

```text
created
  -> policy_precheck
  -> retrieval
  -> context_policy_check
  -> route_decision
  -> risk_classified
  -> redaction_preview_required | approval_required | blocked | payload_hash_recorded
  -> approval_decision
  -> model_invocation
  -> model_call_recorded
  -> cloud_call_ledger_updated
  -> final_output
  -> audit_complete
```

Each transition MUST emit a run event.

Runs MUST support:

- status fetch.
- cancellation.
- timeout.
- structured errors.
- route trace fetch.
- evidence fetch.

## 7. Agent Group Requirements

Agent Group is the v1.0 main work surface. This section defines the orchestration layer; detailed data/UI/release requirements are in [08 Memory, Agent Group, Recipes, and Interop Requirements](08-memory-agentgroup-recipes-v1-requirements.md).

### Alpha

Alpha MUST NOT build free-form multi-agent collaboration.

Alpha MUST define data types or migration-compatible placeholders for future:

- agent.
- agent group.
- group run.
- run step.

Only one InternalAgentAdapter participates in a run.

### Beta

Beta MUST implement 3-agent Pipeline:

```text
Research -> Draft -> Review
```

Pipeline requirements:

- max steps.
- max tokens.
- max duration.
- pause.
- cancel.
- force summarize.
- visible intermediate outputs.
- policy check before each step.
- per-agent permissions.

### v1.0

In this roadmap, "first version of Agent Group as a main work surface" means v1.0, not Alpha. v1.0 MUST add:

- Parallel mode.
- Debate mode.
- user-confirmed self-building organization.
- reusable recipes.

Parallel and Debate MUST preserve bounded runs, policy checks, route traces, and audit evidence.

## 8. Local Agent Control Plane Requirements

Alpha:

- InternalAgentAdapter only.

Beta MUST implement:

- LocalCommandAgentAdapter in read-only mode.
- supervised launch.
- stdout/stderr transcript.
- input/output hash.
- no default shell write access.

v1.0 MUST implement:

- evaluation and graded integration of at least one external adapter family such as CodexAdapter, ClaudeCodeAdapter, AiderAdapter, OpenInterpreterAdapter, HermesAdapter, or A2A-compatible local agent.

External local agent adapters MUST declare:

- capabilities.
- audit level.
- workdir constraints.
- network/shell/file permissions.
- cancellation support.
- artifact reporting.

Ogra MUST NOT promise full control over third-party tools that bypass Ogra adapters.

## 9. A2A and MCP Strategy

Ogra SHOULD remain A2A-compatible instead of inventing a closed protocol.

Alpha MUST NOT implement remote A2A or MCP tool execution.

v1.0 MUST add:

- mapping document from Ogra Run/Message schema to A2A.
- minimal A2A task bridge.
- safe MCP tool allowlist.

All A2A/MCP delegation MUST go through policy, permission, route decision, and audit logging.

The minimal A2A/MCP acceptance contract is defined in [08 Memory, Agent Group, Recipes, and Interop Requirements](08-memory-agentgroup-recipes-v1-requirements.md).

## 10. Artifacts and Outputs

Every agent/model run MUST produce:

- final answer or blocked/error state.
- citation list.
- route decision.
- model call summary.
- cloud call count.
- run risk summary.
- audit event ids.
- optional artifacts.

Artifacts MUST have:

- workspace id.
- run id.
- path or storage reference.
- classification.
- source event ids.

## 11. Acceptance Criteria

Alpha is accepted when:

- InternalAgentAdapter completes the Confidential local RAG demo path.
- Ollama answers local RAG questions and writes local model call records.
- OpenAI-compatible adapter can answer Public-only questions when policy allows.
- Cloud adapter is blocked for Confidential and Restricted fixtures without exception in Alpha.
- Model adapters reject calls missing policy gate evidence.
- Run lifecycle events are complete and ordered.
- Cancellation writes an audit event and stops pending work.
- Model call ledger drives `0 Ogra-managed cloud calls`.
- Agent manifest restrictions are enforced in tests.
- UI can fetch answer, citations, route trace, risk summary, and audit evidence for a run.

## 12. Anti-Patterns

MUST NOT introduce:

- model calls from renderer.
- agent adapters without manifest.
- uncontrolled shell access.
- cloud calls before route decision.
- unbounded agent loops.
- multi-agent group chat without max rounds/tokens/duration.
- external local agents reading sensitive knowledge bases without trace.
- A2A/MCP execution before policy and audit foundations are complete.
