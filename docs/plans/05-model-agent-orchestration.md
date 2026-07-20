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
    providerNativeToolCalling: boolean;
    ograToolBrokerWired: boolean;
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

OpenAI-compatible cloud calls for Confidential data MUST use the
Approve-then-Egress path: deterministic sanitization, current payload preview,
payload/rule-bound approval, and policy revalidation immediately before the
callback. Restricted data MUST be blocked from cloud use without exception in
Alpha.

Alpha MUST default OpenAI-compatible tool calling and file upload to disabled. Streaming MUST NOT write complete prompts, payloads, or sensitive chunks to logs.

Provider-native protocol support MUST be reported separately from Ogra runtime
wiring. An adapter that can parse a provider's tool-call format but does not yet
route it through plan 11 MUST report `ograToolBrokerWired = false` and MUST NOT
execute or silently discard the request as if tool execution succeeded.

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
- Confidential data defaults local; cloud use is allowed only through the
  Approve-then-Egress path with a sanitized, payload-bound approval.
- Restricted data uses allowlisted local model or blocks.

If no acceptable model is available, the run MUST become blocked with a user-visible reason.

## 5. InternalAgentAdapter

Alpha MUST implement the InternalAgentAdapter as a **Plan + ReAct + strong-persistence engine** with an integrated sanitize/policy/route/audit middleware chain. This is the Alpha execution engine; the previous single-shot executor is no longer sufficient.

### 5.1 Execution Model

The runtime is a persistent, self-directed task execution engine. Every action in the ReAct loop passes through a mandatory middleware chain that the agent cannot bypass:

```
Agent decides Action
  -> [Sanitize] strip sensitive fields from action payload
  -> [Policy Eval] does this action violate any policy?
     -> allowed: continue
     -> require_approval: pause, request user approval
     -> blocked: record incident, return error to agent
  -> [Route] if action touches external endpoint:
     -> local: execute directly
     -> cloud: apply egress policy (approve / log / auto-filter)
     -> hybrid: split into local phase + cloud phase
  -> [Pre-Audit] record action intent before execution
  -> [Execute] perform the actual action
  -> [Ingress Review] if result came from external source:
     -> scan for injection via Ingress Review Agent
     -> apply ingress policy (approve / log / auto-filter)
  -> [Post-Audit] record action result and evidence hash
  -> Return result to agent's Observation
```

Key design decisions:

- Middleware is enforced at the runtime level, not the agent level. The agent cannot choose to skip sanitization "for performance."
- Sanitization is automatic and deterministic. The agent does not manually call a sanitize function; the runtime intercepts any payload destined for external consumption and applies redaction rules automatically.
- Pre-audit before execution, post-audit after. This creates a verifiable hash chain: intent hash -> execution -> result hash.

### 5.2 Plan Phase

The agent first produces a structured execution plan:

```
Input: user task + available capabilities
Output: Plan { steps: Step[], estimatedTokens: number, riskLevel: string }

Each Step:
  - id, goal, actionType (retrieve | generate | review | execute | delegate)
  - requiredCapabilities: string[]
  - expectedOutput: schema description
  - routePreference: local | cloud | hybrid
  - dependencies: stepId[] (for DAG execution)
  - retryPolicy: { maxRetries, backoff, fallbackAction }
```

The planner is a local LLM call with structured output. It does NOT see raw user data; it only sees task abstracts and capability declarations. This keeps the planner cheap (can run on a local 7B model) and safe (no data leakage risk).

### 5.3 Execute Phase (ReAct Loop)

Each step executes as a ReAct loop:

```
Thought -> Action -> Observation -> Thought -> Action -> ... -> Final Answer
```

The action space includes:

- `retrieve(kbId, query)` — local RAG retrieval.
- `generate(prompt)` — local model generation.
- `delegate(agentId, sanitizedTask)` — delegate to another agent (local or cloud).
- `execute(code, runtime)` — run code in local sandbox.
- `read_file(path)` — read local file (policy-gated).
- `write_file(path, content)` — write local file (policy-gated, approval-gated).
- `ask_user(question)` — request clarification from user.
- `use_skill(skillId, params)` — invoke a registered skill (see §9).
- `complete(result)` — declare step finished.

Every action passes through the middleware chain in §5.1.

Callable tools, including capabilities selected by a Skill or proposed by a
provider-native tool call, MUST execute through
[11 Tool Broker and MCP Integration Runtime](11-tool-broker-mcp-integration-runtime.md).
The Agent supplies only tool id and arguments; Ogra Core supplies workspace,
binding, transport, secret, policy, approval, and effect context.

### 5.4 Strong Persistence and Recovery

Every agent state transition is durably persisted in `run_step_actions` and
`run_events`, while frame/effect/repair state is persisted through the contract
in [10 SHD-Inspired Durable Execution Runtime](10-shd-inspired-durable-execution-runtime.md).
The runtime can survive a crash, restart, or user interruption without treating
the ReAct cursor as proof of an external outcome. Persisted per step:

- step status: pending | planning | executing | awaiting_approval | completed | failed.
- current ReAct iteration: { thought, action, observation }.
- accumulated context: retrieved chunks, previous step outputs.
- intermediate artifacts: partial code, draft reports.
- route decisions: one per delegate/external call.
- audit events: append-only event log.

Persisted per run:

- plan snapshot (immutable after plan phase).
- high-water mark (recomputed on every new data access).
- token budget consumed / remaining.
- elapsed time / remaining.

Recovery semantics on resume:

1. Acquire the run's local recovery lease and load the recovery capsule.
2. Re-run policy and high-water classification checks against current state.
3. Reconcile every `unknown` effect using external request/receipt evidence,
   adapter outcome query, or the stable idempotency contract.
4. Verify effect ownership, dependencies, allowed repair action, target subtree
   revision, authorized effect revisions, approval scope, payload fingerprint,
   and rule version.
5. If an approval-bound payload or governing revision changed, return to
   `awaiting_approval`; do not reuse the old approval.
6. Only after reconciliation and typed verification, resume from the last
   accepted Observation, retry, compensate, replan, or escalate.
7. Append recovery events and release or renew the lease transactionally.

An adapter MUST declare whether it supports idempotency keys, outcome query,
cancellation, and compensation. If an external outcome is unknown and the
adapter cannot reconcile it safely, the runtime MUST fail closed or request a
user decision. Ogra does not claim exactly-once invocation or automatic
rollback.

### 5.5 Default Permissions

The InternalAgentAdapter MUST default to:

- read-only workspace RAG.
- no shell.
- no arbitrary network.
- no clipboard/browser access.
- MCP and A2A access is disabled in Alpha for the InternalAgentAdapter (v1.0 is the earliest phase for safe MCP and A2A delegation through policy).
- no cross-workspace access.
- no direct secret access.
- read only approved workspace RAG chunks.
- write only run events and optional episodic run summary.

## 6. Run Lifecycle

Every run MUST follow:

```text
created
  -> plan
  -> policy_precheck
  -> retrieval
  -> context_policy_check
  -> route_decision
  -> risk_classified
  -> redaction_engine_invoked
  -> redaction_preview_required | approval_required | blocked | payload_hash_recorded
  -> approval_decision (Approve-then-Egress)
  -> re_sanitize_loop (if rejected, see 03 §3.6)
  -> model_invocation
  -> ingress_review
  -> ingress_decision
  -> model_call_recorded
  -> egress_record_recorded
  -> cloud_call_ledger_updated
  -> final_output
  -> audit_complete
```

Within each step, the InternalAgentAdapter runs a ReAct loop with the middleware chain in §5.1. Each ReAct action and each lifecycle transition MUST emit a run event. ReAct iteration persistence uses `run_step_actions` and is transactional with the corresponding `run_events` row.

Runs MUST support:

- status fetch.
- cancellation (per-iteration for scheduled/continuous runs; mid-iteration for one-shot runs).
- timeout (per-iteration and lifetime-level for scheduled/continuous runs).
- structured errors.
- route trace fetch.
- evidence fetch.

## 7. Agent Group Requirements

Agent Group is a Beta work surface. This section defines the orchestration layer;
detailed data/UI/release requirements are in [08 Memory, Agent Group, Recipes,
and Interop Requirements](08-memory-agentgroup-recipes-v1-requirements.md).

### 7.1 Modes (Beta)

Beta MUST support all three Agent Group modes:

- **Pipeline** — `Research -> Draft -> Review`. Each step is policy-checked, route-checked, and audited. Per-step permissions apply. Bounded by `max_steps`, `max_tokens`, `max_duration`.
- **Parallel** — multiple agents run concurrently and a deterministic Merge step combines their outputs. Each parallel branch is its own bounded run with policy and audit. The Merge step is itself an agent with the same middleware chain.
- **Debate** — multiple agents run adversarially; a Judge step converges on a final answer. Each round is bounded; the Judge step is itself an agent with the same middleware chain.

All three modes MUST preserve:

- bounded runs.
- per-step policy checks.
- per-step route decisions.
- per-step audit events.
- re-sanitize loop on the Approve-then-Egress tier.
- ingress review on every external result.

### 7.2 Scheduling (Beta)

Beta MUST support two scheduling modes for Agent Groups:

- **Interval** — cron expression or interval string. The Agent Group runs on the schedule. Each iteration is a separate `agent_runs` row; per-iteration bounds apply.
- **Continuous** — event-driven (file change, new data, API webhook) or loop. The Agent Group runs as a long-lived process with `cooldown_between_iterations_ms` and lifetime-level bounds.

Schedule config persists in `scheduled_runs` (see 02 §3.8.5). Each iteration creates a `scheduled_run_iterations` row.

Bounds:

- per-iteration bounds: `max_duration_ms`, `max_tokens`, `cancel` — reuse the Alpha one-shot bounds.
- lifetime-level bounds: `max_iterations`, `max_total_duration_ms`, `max_total_tokens` — new for scheduled/continuous runs.
- `cancel` for scheduled/continuous stops after the current iteration. `pause` pauses between iterations; mid-iteration pause is per-iteration cancel.

### 7.3 Self-Building (Deferred)

Self-building Agent Group recruitment is a product decision that is explicitly deferred from Alpha. The capability taxonomy, Coordinator agent, dynamic group assembly, and confirmation UI are NOT implemented in Alpha.

Beta SHOULD reserve the data structures (a `capability_taxonomy` table or JSON registry, and a `self_build_recommendations` table) as migration-compatible placeholders so a future phase can adopt them without schema break. The placeholder does NOT trigger any auto-recruitment.

Hard constraints preserved from the handbook apply if self-building is later enabled: no auto-download of unknown plugins, no auto-pulling of GitHub repos for execution, no auto-enabling of shell permissions, no auto-access of high-sensitivity data, no cross-workspace recruitment without user confirmation, and every recommendation and decision must be audited.

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

## 9. Skills Market

Ogra agents — both the local runtime agent and external agents registered in the Local Agent Control Plane — need access to reusable capabilities beyond what their base model provides. The Skills Market is a discoverable catalog of capability modules that agents can load and execute through the `use_skill` action (§5.3).

### 9.1 Skill Definition

A skill is a packaged capability unit:

```text
Skill {
  id: string
  name: string
  version: string
  description: string
  capabilityTags: string[]        // e.g., ["generate/report", "analyze/finance"]
  runtime: "local" | "cloud" | "hybrid"
  entrypoint: "prompt" | "code" | "agent_group"
  manifest: {
    requiredPermissions: string[]  // e.g., ["file_read", "network_egress"]
    requiredModels: string[]       // model requirements
    inputSchema: JSONSchema
    outputSchema: JSONSchema
    estimatedTokens: number
    riskLevel: "low" | "medium" | "high"
  }
  source: "builtin" | "local_recipe"   // "marketplace" is v1.0
  trustLevel: "verified" | "user_trusted"
  content: string  // the actual skill definition (prompt template, code, or agent group config)
}
```

### 9.2 Beta Skill Sources

| Source | Description | Trust Model |
|---|---|---|
| **Built-in** | Shipped with Ogra; report generation, code review, data analysis | Fully trusted |
| **Local Recipe** | User-created or workspace-saved from successful runs | User-trusted |

Marketplace (community/vendor) skills are v1.0.

### 9.3 Skill Execution Flow

```
Agent identifies needed capability
  -> Query Skills Market: findSkills(tags=["generate/report", "analyze/finance"])
  -> Returns candidate skills ranked by trust + capability match
  -> Agent selects skill (or asks user to choose)
  -> Policy evaluation on skill manifest:
     -> Does skill require permissions the agent does not have?
     -> Does skill's runtime (cloud) conflict with data classification?
     -> Is skill's trustLevel acceptable per workspace policy?
  -> If approved: load skill, inject into agent's action space
  -> Agent invokes skill as an action: use_skill(skillId, params)
  -> Skill resolves only pinned Tool Broker capabilities permitted by its manifest
  -> Each capability goes through plan 11 policy/approval/effect/receipt/ingress
  -> Result returned to agent's Observation
  -> skill_invocations links to tool_invocation/effect evidence
```

### 9.4 Skill Persistence and Version Pinning

- The active skill registry is persisted in `skills` (see 02 §3.8.4). Each skill has a content hash and a version.
- Once a run is started, the skill version used is pinned for the duration of the run. Version upgrades do not retroactively change an in-flight run.
- Updating a skill version creates a new `skills` row with `version = new_version` and `parent_version = old_version`. The previous version remains queryable.
- A Skill is not a permission container. It can only compose the immutable tool
  versions allowed by its manifest, workspace binding, Agent grant, and current policy.
- Beta local recipes are declarative and MUST NOT execute arbitrary package code.

## 10. A2A and MCP Strategy

Ogra SHOULD remain A2A-compatible instead of inventing a closed protocol.

Alpha MUST NOT implement remote A2A or MCP tool execution.

v1.0 MUST add:

- mapping document from Ogra Run/Message schema to A2A.
- minimal A2A task bridge.
- safe MCP tool allowlist.

MCP tool calls use the Tool Broker. A2A remains an AgentAdapter/delegation path;
both use policy, permission, route decision, owned effects, receipts, ingress
review, recovery, and audit logging.

The minimal A2A acceptance contract is defined in [08 Memory, Agent Group,
Recipes, and Interop Requirements](08-memory-agentgroup-recipes-v1-requirements.md).
The MCP contract is defined in [11 Tool Broker and MCP Integration Runtime](11-tool-broker-mcp-integration-runtime.md).

## 11. Artifacts and Outputs

Every agent/model run MUST produce:

- final answer or blocked/error state.
- citation list.
- route decision.
- model call summary.
- cloud call count with egress mode (`auto_redact` / `log_and_proceed` / `approve_then_egress`).
- redaction preview and redaction rule version when applicable.
- ingress review findings and quarantine references when applicable.
- re-sanitize iteration history when applicable.
- run risk summary.
- audit event ids.
- optional artifacts.

Artifacts MUST have:

- workspace id.
- run id.
- path or storage reference.
- classification.
- source event ids.

## 12. Acceptance Criteria

Alpha is accepted when:

- InternalAgentAdapter executes a Plan + ReAct + strong-persistence engine with the integrated sanitize/policy/route/audit middleware chain (§5).
- InternalAgentAdapter completes the Confidential local RAG demo path.
- Ollama answers local RAG questions and writes local model call records.
- OpenAI-compatible adapter can answer Public-only questions when policy allows, and is gated by the three-tier egress policy for non-Public data.
- Confidential cloud upload goes through the Approve-then-Egress tier only and is blocked when approval is missing.
- Restricted cloud calls are blocked without exception in Alpha.
- Model adapters reject calls missing policy gate evidence.
- Run lifecycle events are complete and ordered, including plan, redaction_engine_invoked, ingress_review, egress_record_recorded.
- Cancellation writes an audit event and stops pending Alpha work.
- Model call ledger drives `0 Ogra-managed cloud calls` and shows the egress mode alongside.
- Agent manifest restrictions are enforced in tests.
- The `knowledge.search` Tool Broker slice records a pinned version, scoped
  policy, owned effect, receipt, ingress finding, and accepted Observation.
- The Ingress Review Agent runs in a separate process boundary and produces structured findings persisted in `ingress_review_findings`; suspicious or malicious findings land in `quarantine_contents` with an incident.
- The re-sanitize loop terminates only on `approved` or `aborted`, and every iteration is audited in `rejection_resanitize_iterations`.
- Every externally visible action has an owning frame and durable effect record;
  crash recovery uses a lease, recovery capsule, reconciliation, and typed
  revision checks before any callback is retried.
- Unknown outcomes, stale approvals, changed payloads, sibling-frame repair
  overreach, and dependency reversal are rejected or escalated before execution.
- UI can fetch answer, citations, route trace, risk summary, ingress findings, and audit evidence for a run.

## 13. Anti-Patterns

MUST NOT introduce:

- model calls from renderer.
- agent adapters without manifest.
- uncontrolled shell access.
- cloud calls before route decision, before egress mode selection, or before user approval on the Approve-then-Egress tier.
- unbounded agent loops (per-iteration or lifetime).
- Agent Group Pipeline / Parallel / Debate without per-step policy, per-step route, and per-step audit.
- scheduled or continuous runs without lifetime-level bounds.
- external local agents reading sensitive knowledge bases without trace.
- A2A/MCP execution before policy and audit foundations are complete.
- skills loaded into an agent without manifest evaluation and audit.
- ingress review skipped or co-located with the InternalAgentAdapter that produced the original request.
- resuming from a ReAct Observation without reconciling the next effect state.
- reusing an approval after payload fingerprint, redaction rule, policy scope,
  or target revision changes.
- automatic retry or compensation when the adapter has no verified recovery
  contract.
- M3 Memory used as evidence that an effect succeeded or as authority to repair
  a frame.
