# 09 vNext Strategic Direction

> Layer: post-Alpha product strategy and architecture direction
>
> Phase coverage: Beta / v1.0 / v1.x
>
> Depends on: [00 Development Requirements Index](00-development-requirements-index.md), [03 Policy, Routing, and Safety Engine](03-policy-routing-safety-engine.md), [05 Model and Agent Orchestration](05-model-agent-orchestration.md)
>
> Status: directional guidance, not implementation spec

## 1. Purpose

This document captures the strategic product direction discussed for post-Alpha phases.
It is not an implementation specification. It defines the product semantics, the
target user experience, and the architectural principles that subsequent development
phases must follow.

When specific implementation plans are created for Beta or v1.0, they should
reference this document as the source of truth for product intent.

---

## 2. Local-First Semantic Clarification

### 2.1 What "Local-First" Actually Means

Ogra's local-first position has a specific, narrow meaning that must be clearly
communicated in product messaging:

**Data residency:**

> All user data — files, knowledge bases, memories, audit logs — lives on the
> local machine by default. Nothing is uploaded to cloud storage, sync services,
> or third-party servers unless the user explicitly configures it.

**Compute strategy:**

> Data processing and reasoning should default to cloud strong models and tools.
> The local runtime handles data reading, sanitization, task abstraction,
> result adaptation, and local execution. Complex generation (code writing,
> report drafting, analysis) is delegated to cloud agents after sanitization.

### 2.2 Default Routing Strategy

The default mode for tasks involving non-Public data is **hybrid routing**:

```
Local phase:
  1. Read local data
  2. Sanitize and abstract the task (strip sensitive fields)
  3. Route sanitized task + schema to cloud agent

Cloud phase:
  4. Cloud agent executes generation (code, report, analysis)
  5. Result returns to local runtime

Local phase:
  6. Adapt result to local data schema
  7. Execute locally (if applicable)
  8. Record full audit trail
```

Pure local routing (Confidential data → local model → answer) remains available
as a **high-security option**, not as the default. It should be presented as the
exception, not the norm.

The product message shifts from "keep everything local" to:

> Your data never leaves your machine. Powerful cloud models do the heavy
> lifting — but only after your data is sanitized, and only with your knowledge
> and consent. Every byte that crosses the boundary is recorded and auditable.

---

## 3. Data Egress Strategy

### 3.1 Three-Tier Egress Policy

Every data egress event must fall into one of three modes, selectable by data
classification and workspace policy:

| Mode | Description | Default For | User Action Required |
|---|---|---|---|
| **Approve-then-Egress** | User must preview and approve the sanitized payload before it leaves the machine | Confidential, Restricted | Preview → Approve/Reject |
| **Log-then-Egress** | Egress proceeds automatically; a full audit record is written | Internal (high-sensitivity) | None (audit-only) |
| **Auto-Filter-then-Egress** | Deterministic redaction applied automatically; redacted payload is sent | Internal (standard), Public | None (auto-redact) |

### 3.2 Egress Decision Flow

```
Task requires cloud compute
  → Policy engine evaluates data classification
    → Public: Auto-Filter-then-Egress (mode C)
    → Internal (standard): Auto-Filter-then-Egress (mode C)
    → Internal (high-sensitivity): Log-then-Egress (mode B)
    → Confidential: Approve-then-Egress (mode A)
    → Restricted: Blocked (no egress path)
```

### 3.3 Rejection → Re-Sanitize Loop

When egress is in Approve-then-Egress mode and the user rejects the sanitized
payload:

1. User provides rejection reason (optional annotation)
2. System records the rejection as an audit event with `decision: rejected`
3. System offers "重新脱敏" (re-sanitize) action
4. Re-sanitize applies stricter redaction rules or user-specified exclusions
5. New preview is generated and presented for re-approval
6. Loop continues until user approves or aborts the task

This is NOT a "deny and block" — it's a "send back for rework" cycle.
Each iteration is audited.

### 3.4 New Policy Decision Type

Current `PolicyEvaluationResult.decision` supports:

```
allow | require_approval | redact | local_only | blocked
```

vNext must add:

```
log_and_proceed   — for Log-then-Egress mode
auto_redact       — for Auto-Filter-then-Egress mode (distinct from manual redact)
```

### 3.5 Redaction Engine (New Component)

The redaction engine applies deterministic rules before any cloud egress:

- Email, phone, address-like patterns
- API keys, private keys, tokens
- ID numbers, account numbers
- User-defined keywords and patterns
- Column removal for structured data

Output:
- Before/after diff preview (for Approve-then-Egress mode)
- Redacted payload with irreversible replacement or tokenization
- Payload hash for audit trail
- Redaction rule version stamp

---

## 4. Data Ingress Security

### 4.1 Threat Model

Inbound data — cloud model responses, external agent outputs, tool return values,
A2A messages, MCP tool results — must be treated as untrusted. A malicious or
compromised cloud model could attempt to:

- Inject instructions that override system prompts
- Request unauthorized file uploads or network access
- Attempt policy bypass through response content
- Embed exfiltration instructions in "code" or "report" outputs

### 4.2 Independent Ingress Review Agent

Ingress review must be performed by a **separate agent** from the one that
generated or requested the content. It cannot be the same InternalAgentAdapter
that assembled the prompt — a compromised response could influence its own
reviewer.

```
Cloud response arrives
  → Ingress Review Agent (independent, local)
    → Scan for injection patterns
    → Semantic analysis for policy bypass attempts
    → Output: clean / suspicious / malicious
      → clean: forward to local assembly
      → suspicious: isolate, record incident, request user review
      → malicious: discard, create incident, notify user
```

### 4.3 Ingress Review Modes (Same Three Tiers)

The same three-tier policy applies to ingress review:

| Mode | Behavior |
|---|---|
| **Approve-then-Ingest** | Suspicious content held; user must review and approve before it enters context |
| **Log-then-Ingest** | Content passes through; full review report written to audit |
| **Auto-Filter-then-Ingest** | Detection patterns applied automatically; flagged content stripped or rewritten |

### 4.4 Prompt Injection Detector Evolution

Current `PromptInjectionDetector` is regex-based with 5 pattern groups.
vNext evolves to:

1. Keep regex layer as fast pre-filter (low latency, no model cost)
2. Add semantic review layer via local LLM for suspicious-but-not-certain cases
3. Both layers produce structured findings: `{ patternId, evidence, evidenceHash, severity, layer }`
4. Ingress Review Agent consumes both layers' output to make final classification

### 4.5 Isolation and Cleanup

When malicious content is detected:

1. Content is stored in isolated "quarantine" table (not in main context store)
2. Incident record is created with full evidence hash chain
3. User is notified with sanitized summary (not the malicious content itself)
4. Option: user can view quarantined content in a restricted sandbox view
5. Option: "clean and proceed" — attempt to strip injection while preserving legitimate content

---

## 5. Local Agent Dynamic Task Orchestration

### 5.1 Problem Statement

The current `InternalAgentAdapter` is a single-shot executor:

```
task in → retrieve → policy → model call → answer out
```

This is insufficient for real-world tasks that require:

- Multi-step planning and execution
- Conditional branching based on intermediate results
- Coordinated use of local tools and cloud agents
- Automatic sanitization before any data egress
- Independent pre-audit of cloud responses before ingestion
- Transparent routing decisions embedded in the execution flow
- Recovery from failures without losing progress

The local agent must evolve from a "smart RAG wrapper" into a **persistent,
self-directed task execution engine** that integrates Ogra's core capabilities
(sanitization, policy, routing, audit) as built-in middleware rather than
optional add-ons.

### 5.2 Execution Model: PlanExecute + ReAct + Strong Persistence

The local agent's execution engine combines three complementary patterns:

```
┌─────────────────────────────────────────────┐
│              Local Agent Runtime             │
│                                             │
│  ┌─────────┐   ┌──────────┐   ┌──────────┐ │
│  │  PLAN   │ → │  EXECUTE │ → │ OBSERVE  │ │
│  │ (LLM)   │   │ (ReAct)  │   │ (validate│ │
│  │         │   │          │   │  + route)│ │
│  └─────────┘   └──────────┘   └──────────┘ │
│       ↑                            │        │
│       └────────  persist  ─────────┘        │
│                                             │
│  Middleware (every step):                    │
│    sanitize → policy check → route → audit  │
└─────────────────────────────────────────────┘
```

#### 5.2.1 Plan Phase

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

The planner is a local LLM call with structured output. It does NOT see raw
user data — it only sees task abstracts and capability declarations. This keeps
the planner cheap (can run on a local 7B model) and safe (no data leakage risk).

#### 5.2.2 Execute Phase (ReAct Loop)

Each step executes as a ReAct loop:

```
Thought → Action → Observation → Thought → Action → ... → Final Answer
```

The action space includes:

- `retrieve(kbId, query)` — local RAG retrieval
- `generate(prompt)` — local model generation
- `delegate(agentId, sanitizedTask)` — delegate to another agent (local or cloud)
- `execute(code, runtime)` — run code in local sandbox
- `read_file(path)` — read local file (policy-gated)
- `write_file(path, content)` — write local file (policy-gated, approval-gated)
- `ask_user(question)` — request clarification from user
- `complete(result)` — declare step finished

Every action passes through the middleware chain (see 5.3).

#### 5.2.3 Strong Persistence

Every agent state transition is durably persisted. The agent can survive a crash,
restart, or user interruption and resume exactly where it left off:

```
Persisted per step:
  - step status: pending | planning | executing | awaiting_approval | completed | failed
  - current ReAct iteration: { thought, action, observation }
  - accumulated context: retrieved chunks, previous step outputs
  - intermediate artifacts: partial code, draft reports
  - route decisions: one per delegate/external call
  - audit events: append-only event log

Persisted per run:
  - plan snapshot (immutable after plan phase)
  - high-water mark (recomputed on every new data access)
  - token budget consumed / remaining
  - elapsed time / remaining
```

Persistence uses the existing `agent_runs` + `run_steps` + `run_events` tables,
extended with `run_step_actions` for ReAct iteration granularity.

#### 5.2.4 Recovery Semantics

When a run resumes after interruption:

1. Load persisted state → find last in-progress step
2. If step is `awaiting_approval` → re-prompt user
3. If step is `executing` with partial ReAct state → resume from last Observation
4. If step is `failed` with retries remaining → retry with backoff
5. If step is `completed` → advance to next step
6. Re-run policy evaluation on restored context (high-water mark may have changed)

### 5.3 Integrated Middleware Chain

Every action in the ReAct loop passes through a mandatory middleware chain.
This is NOT optional — the agent runtime enforces it. The agent cannot bypass
sanitization, cannot skip policy checks, cannot make unrecorded calls.

```
Agent decides Action
  → [Sanitize] strip sensitive fields from action payload
  → [Policy Eval] does this action violate any policy?
    → allowed: continue
    → require_approval: pause, request user approval
    → blocked: record incident, return error to agent
  → [Route] if action touches external endpoint:
    → local: execute directly
    → cloud: apply egress policy (approve / log / auto-filter)
    → hybrid: split into local phase + cloud phase
  → [Pre-Audit] record action intent before execution
  → [Execute] perform the actual action
  → [Ingress Review] if result came from external source:
    → scan for injection
    → apply ingress policy (approve / log / auto-filter)
  → [Post-Audit] record action result and evidence hash
  → Return result to agent's Observation
```

Key design decisions:

- **Middleware is enforced at the runtime level**, not the agent level. The agent
  cannot choose to skip sanitization "for performance."
- **Sanitization is automatic and deterministic.** The agent does not manually
  call a sanitize function — the runtime intercepts any payload destined for
  external consumption and applies redaction rules automatically.
- **Pre-audit before execution, post-audit after.** This creates a verifiable
  hash chain: intent hash → execution → result hash.

### 5.4 Skills Market

#### 5.4.1 Concept

Ogra agents — both the local runtime agent and external agents registered in the
Local Agent Control Plane — need access to reusable capabilities beyond what
their base model provides. A **Skills Market** is a discoverable catalog of
capability modules that agents can load and execute.

A skill is a packaged capability unit:

```
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
  source: "builtin" | "local_recipe" | "marketplace"
  trustLevel: "verified" | "community" | "untrusted"
  content: string  // the actual skill definition (prompt template, code, or agent group config)
}
```

#### 5.4.2 Skill Sources

| Source | Description | Trust Model |
|---|---|---|
| **Built-in** | Shipped with Ogra; report generation, code review, data analysis | Fully trusted |
| **Local Recipe** | User-created or workspace-saved from successful runs | User-trusted |
| **Marketplace** | Community or vendor-provided; downloaded with user approval | Sandboxed, policy-gated |

#### 5.4.3 Skill Execution Flow

```
Agent identifies needed capability
  → Query Skills Market: findSkills(tags=["generate/report", "analyze/finance"])
  → Returns candidate skills ranked by trust + capability match
  → Agent selects skill (or asks user to choose)
  → Policy evaluation on skill manifest:
    → Does skill require permissions the agent doesn't have?
    → Does skill's runtime (cloud) conflict with data classification?
    → Is skill's trustLevel acceptable per workspace policy?
  → If approved: load skill, inject into agent's action space
  → Agent invokes skill as an action: use_skill(skillId, params)
  → Skill execution goes through standard middleware chain
  → Result returned to agent's Observation
```

#### 5.4.4 Marketplace Safety

Skills from the marketplace carry inherent risk. Mitigations:

- **Sandbox by default.** Marketplace skills run with minimal permissions unless
  user explicitly grants more.
- **Manifest verification.** Every skill declares its required permissions,
  models, and runtime. The policy engine evaluates these before loading.
- **Content scanning.** Skill content (prompt text, code) passes through the
  same ingress review pipeline as any external content.
- **Execution audit.** Every skill invocation is recorded: which skill, which
  version, what input, what output, what cloud calls were made.
- **User approval gate.** First use of any marketplace skill requires explicit
  user confirmation. Subsequent uses within the same workspace can be auto-approved
  if the user opts in.
- **Version pinning.** Once a user approves a skill version, it stays pinned
  until the user explicitly updates. Auto-update is opt-in, not default.

#### 5.4.5 Skills Market vs Self-Building

Skills Market and Self-Building Agent Groups are complementary:

- **Skills Market**: "What capabilities can my agent load?"
- **Self-Building**: "Which agents should join my group?"

A skill is loaded INTO an agent. An agent is added TO a group. The Coordinator
in the self-building flow can recommend both skills (load into existing agent)
and agents (add to group) as solutions to a capability gap.

---

## 6. Agent Group Scheduling

### 6.1 Beyond One-Shot Execution

Current `PipelineOrchestrator` only supports user-triggered, bounded runs:

```
user initiates → run starts → run completes → done
```

vNext must support two additional execution modes:

### 6.2 Interval Execution (Scheduled)

Agent Groups can be configured to run on a schedule:

```
Config:
  - schedule: cron expression or interval
  - agent group id
  - task template (with parameter slots)
  - max concurrent runs
  - failure behavior: retry / skip / alert
  - notification: on completion / on failure / on incident only
```

Use cases:
- Daily report generation from updated local data
- Periodic code review of new commits
- Weekly knowledge base summarization
- Scheduled data quality checks

### 6.3 Continuous Running (Daemon / Watch Mode)

Agent Groups can run as long-lived processes:

```
Config:
  - trigger: event-driven (file change, new data, API webhook) or loop
  - loop interval or event subscription
  - max duration per iteration
  - cooldown between iterations
  - state persistence between iterations
```

Use cases:
- Monitor folder for new files → auto-import → auto-classify → auto-index
- Watch for new code changes → review → suggest fixes
- Continuous competitor monitoring via web scraping agent

### 6.4 Implications for Bounded Run Design

Continuous and interval modes challenge the current "bounded run" assumptions:

- `max_duration_ms` — per iteration or total lifetime?
- `max_tokens` — per iteration or cumulative?
- `cancel` — stop after current iteration or immediate?
- `pause` — pause between iterations or mid-iteration?

These must be resolved before implementing scheduling. Likely answer:
- Per-iteration bounds (max_duration, max_tokens, cancel) remain as-is
- New lifetime-level bounds (max_iterations, max_total_duration, max_total_tokens)
- `pause` pauses between iterations; mid-iteration pause is per-iteration cancel

---

## 7. Cloud Agent Transparency Boundary

### 7.1 What Ogra Audits vs What It Doesn't

Ogra's audit scope is **data egress and ingress**, not the internal reasoning
of cloud agents. This must be clearly communicated:

**Audited (Ogra-controlled):**

- What data left the local machine (payload hash, sanitized preview)
- Why it left (route decision, policy evaluation)
- Which provider and model received it
- What came back (response hash, token usage)
- Whether the response passed ingress review
- Cloud call count and ledger

**Not Audited (outside Ogra control):**

- Internal reasoning steps of the cloud model
- Tool calls the cloud model made on its own infrastructure
- Provider-side logging and telemetry
- Model training data usage
- Third-party sub-processors

### 7.2 Product Messaging

The transparency claim must be scoped:

> Ogra records everything that crosses the boundary between your machine and
> the cloud. It does not — and cannot — record what happens inside the cloud
> provider's infrastructure after the data arrives. What you send, why you
> sent it, and what you got back: these are auditable. The model's internal
> chain of thought: that belongs to the provider.

---

## 8. Self-Building Agent Groups

### 8.1 Current Status

**Decision deferred.** The product direction is defined but the implementation
approach is not yet decided.

### 8.2 Product Intent

From the product handbook:

> When the Coordinator determines the current Agent Group lacks a capability,
> Ogra can recommend candidate agents from local recipes/agents. The user
> confirms, and the agent joins the current task.

### 8.3 Architecture Ingredients (For Future Decision)

The following building blocks have been identified but not committed to a
specific implementation:

1. **Capability Taxonomy** — structured classification of agent capabilities
   (analyze/generate/review/execute/retrieve × domain tags)

2. **Coordinator Agent** — lightweight local agent that maps task descriptions
   to capability vectors and identifies gaps

3. **Dynamic Group Assembly** — ability to insert agents into a running
   PipelineOrchestrator at defined breakpoints

4. **Confirmation UI** — recommendation card showing agent capabilities, model
   locality, risk indicators, and per-agent approval

5. **Policy Integration** — every self-build recommendation passes through
   the same policy engine as manual configurations

6. **Recipe Save** — successfully completed self-built configurations can be
   persisted as reusable recipes

### 8.4 Open Questions

- Static analysis (pre-run recommendation) vs dynamic insertion (mid-run)?
- Coordinator: local model only, or can it use cloud for complex gap analysis?
- How many recommendation rounds per task? One or iterative?
- Should rejected recommendations influence future recommendations?
- How to handle capability conflicts (two agents claim same capability)?

### 8.5 Hard Constraints (Non-Negotiable)

From the product handbook:

- Must not auto-download or install unknown plugins
- Must not auto-pull GitHub repos for execution
- Must not auto-enable shell permissions
- Must not auto-access high-sensitivity data
- Must not recruit agents across workspaces without user confirmation
- Every recommendation and decision must be audited

---

## 9. Cross-Cutting Requirements

### 9.1 All New Features Must Preserve

- Policy evaluation before any data movement
- RouteDecision record for every run
- Append-only audit trail with hash-chain integrity
- Classification inheritance (high-water mark)
- User-visible data lineage (what went where and why)

### 9.2 Data Safety Center Coverage

vNext must extend Data Safety Center asset coverage to include:

- Redaction rule sets and versions
- Egress policy configurations
- Ingress review agent status and findings
- Scheduled and continuous Agent Group runs
- Self-build recommendation history

### 9.3 AI Governance Center Coverage

vNext must extend AI Governance Center to include:

- Egress approval queue and history
- Ingress incident records and quarantine status
- Self-build recommendation audit trail
- Scheduled run risk summaries
- Per-agent ingress/egress statistics

---

## 10. Phase Mapping

| Feature | Earliest Phase | Dependencies |
|---|---|---|---|
| Local-first semantic update (docs + messaging) | Beta | None |
| Three-tier egress policy | Beta | Policy engine extension, redaction engine |
| Rejection → re-sanitize loop | Beta | Approve-then-Egress mode, redaction engine |
| Ingress Review Agent (basic) | Beta | Independent agent runtime, semantic scanner |
| Local Agent PlanExecute + ReAct engine | Beta | Extended run_step_actions schema, middleware chain |
| Integrated sanitize/policy/route/audit middleware | Beta | ReAct engine, redaction engine, policy extension |
| Skills Market (built-in + local recipe) | v1.0 | Skill registry, manifest validation, sandboxed execution |
| Skills Market (marketplace) | v1.0 | Content scanning, trust verification, user approval gate |
| Ingress Review Agent (full three-tier) | v1.0 | Ingress policy integration |
| Agent Group interval scheduling | v1.0 | PipelineOrchestrator extension |
| Agent Group continuous running | v1.0 | PipelineOrchestrator extension, state persistence |
| Self-building Agent Groups | v1.0 | Capability taxonomy, Coordinator, dynamic assembly |
| Full ingress/egress policy matrix | v1.0 | All egress + ingress components |

---

## 11. Relationship to Existing Plans

This document supplements, not replaces, the existing plan documents:

- [03 Policy, Routing, and Safety Engine](03-policy-routing-safety-engine.md):
  This document extends section 8 (Data Egress Model) and section 9 (Prompt Injection)
  with the three-tier policy and ingress review concepts.

- [05 Model and Agent Orchestration](05-model-agent-orchestration.md):
  This document extends section 7 (Agent Group Requirements) with the hybrid-default
  routing strategy, section 2.5 (Self-Building Organization) with the capability
  taxonomy and Coordinator concepts, and section 6 (InternalAgentAdapter) with the
  PlanExecute + ReAct execution engine and integrated middleware chain.

- [08 Memory, Agent Group, Recipes, and Interop Requirements](08-memory-agentgroup-recipes-v1-requirements.md):
  This document extends the Beta/v1 feature set with scheduling, continuous running,
  and self-building agent groups.

When these extended features enter active implementation, the relevant sections
in those plan documents should be updated to reference this document as the
source of product intent.
