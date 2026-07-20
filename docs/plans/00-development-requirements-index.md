# Ogra Development Requirements Index

> Status: active planning document
>
> Source of truth: [../../ogra-product-handbook.md](../../ogra-product-handbook.md)
>
> Purpose: define layered development requirements through Alpha, Beta, and v1.0.

## 1. Product Contract

All development plans in this directory must preserve the handbook definition:

> Ogra Desktop is a local-first, hybrid edge/cloud, transparent-routing, auditable AI Agent workspace for individuals and small teams.

The first implementation target is not a generic chat app and not a SaaS platform. The product must make these facts visible to the user:

- Which data stayed local.
- Which data went to an Ogra-controlled cloud adapter.
- Why the route was selected, including which egress mode (approve / log / auto-filter) applied.
- Whether redaction, approval, or re-sanitization cycles were required.
- Which model, agent, and skill executed each step.
- Whether cloud response passed independent ingress review.
- Which local audit evidence was produced.

## 2. Document Set

The development requirements are split by responsibility layer:

1. [01 Desktop Runtime Foundation](01-desktop-runtime-foundation.md)
   - Electron shell, process boundaries, typed IPC, workers, app lifecycle, local permissions, ingress review isolation.

2. [02 Local Data, Audit, and Governance Store](02-local-data-audit-governance-store.md)
   - SQLite schema, migrations, workspace isolation, hash-chain run events, route decisions, model/provider/policy registries, ingress findings, quarantine, redaction rule sets, skills registry, scheduled runs.

3. [03 Policy, Routing, and Safety Engine](03-policy-routing-safety-engine.md)
   - deterministic policy evaluation, three-tier egress (approve / log / auto-filter), route decision schema, approval rules, re-sanitize loop, prompt-injection warnings, egress modeling, ingress review policy.

4. [04 RAG and Knowledge Engine](04-rag-knowledge-engine.md)
   - local file import, classification inheritance, FTS5 retrieval, citations, indexing status, source trust, future vector search.

5. [05 Model and Agent Orchestration](05-model-agent-orchestration.md)
   - model adapters, InternalAgentAdapter as PlanExecute + ReAct + strong persistence engine, integrated middleware chain, agent manifests, bounded runs, Agent Group with interval/continuous scheduling, Skills Market, Local Agent Control Plane, A2A/MCP.

6. [06 Application UI and UX](06-application-ui-ux.md)
   - workspace UX, knowledge import, chat/run experience, route trace viewer, Data Safety Center, AI Governance Center, redaction preview, ingress review UI, quarantine sandbox.

7. [07 Verification, Packaging, and Release Gates](07-verification-packaging-release-gates.md)
   - unit/integration/e2e tests, security checks, demo scripts, packaging, acceptance gates by phase.

8. [08 Memory, Agent Group, Recipes, and Interop Requirements](08-memory-agentgroup-recipes-v1-requirements.md)
   - M3 memory, Agent Group, recipes, Local Agent Control Plane, A2A/MCP, and v1 completion gates.

9. [09 vNext Strategic Direction](09-vNext-strategic-direction.md)
   - Strategic direction for hybrid-default routing, three-tier egress/ingress, ReAct engine, Skills Market, scheduling, cloud agent transparency boundary. Items explicitly subsumed into Alpha are marked there.

10. [10 SHD-Inspired Durable Execution Runtime](10-shd-inspired-durable-execution-runtime.md)
   - Ogra-native TypeScript/SQLite task frames, effect ownership, revisions, idempotency, typed repair verification, recovery capsules, local recovery leases, audit packets, and the authority boundary between runtime state and M3 Memory.

11. [11 Tool Broker and MCP Integration Runtime](11-tool-broker-mcp-integration-runtime.md)
   - Capability Gateway boundary, immutable Tool descriptors and workspace bindings, policy/approval/effect/receipt/ingress invocation protocol, MCP transport hardening, and phased tool/Skill/MCP delivery.

## 3. Phase Definitions

### 3.1 Alpha: Hybrid-Default Trustable Core

Alpha is no longer a pure-local demo. After [09 vNext Strategic Direction](09-vNext-strategic-direction.md) was accepted as the source of product intent, Alpha's product promise becomes:

> A local-first, hybrid edge/cloud, transparent-routing, auditable AI Agent workspace, in which data leaves the machine only through a deterministic three-tier egress policy (Approve / Log / Auto-Filter), every cloud response is reviewed by an independent ingress agent, and every Ogra-managed boundary crossing has auditable bounded metadata, hashes, and receipts without persisting raw secrets or sensitive payloads in audit.

Alpha proves the hybrid-default core loop:

```text
Import sensitive folder
  -> mark Confidential
  -> user task: "summarize Q2 anomalies"
  -> local RAG retrieval
  -> policy classifies data classification (high-water mark)
  -> egress policy selects mode:
       Public / Internal(standard) -> Auto-Filter-then-Egress
       Internal(high-sensitivity) -> Log-then-Egress
       Confidential                 -> Approve-then-Egress (preview required)
       Restricted                   -> Blocked
  -> redaction engine sanitizes payload (when applicable)
  -> user approves sanitized payload (Approve mode)
  -> cloud reasoning
  -> cloud response arrives
  -> independent Ingress Review Agent scans for prompt injection
  -> ingress policy applies (approve / log / auto-filter)
  -> local synthesis and final answer
  -> run events, route decision, redaction preview, approval, ingress findings, payload hashes, and audit chain all recorded
```

Alpha MUST include:

- Electron desktop shell with safe renderer/main/core boundaries.
- Local workspace, Markdown/TXT/code folder import, manual reindex with visible status.
- SQLite FTS5 retrieval and a v0 vector retrieval path (sqlite-vss or equivalent) behind a feature flag.
- Ollama adapter (local).
- OpenAI-compatible adapter (cloud or local) with policy-gated use.
- InternalAgentAdapter as a PlanExecute + ReAct + strong-persistence engine with an integrated sanitize/policy/route/audit middleware chain.
- SHD-inspired durable execution semantics implemented natively in TypeScript/SQLite: persistent task frames, effect ownership, separate effect/payload/idempotency identities, branch-local revisions, typed repair verification, unknown-outcome reconciliation, local recovery lease/CAS, and frame/effect audit packets. See [10 SHD-Inspired Durable Execution Runtime](10-shd-inspired-durable-execution-runtime.md).
- Three-tier egress policy: `auto_redact`, `log_and_proceed`, `approve_then_egress`, plus the existing `allow / require_approval / redact / local_only / blocked` decisions.
- Redaction engine with deterministic rules (email, phone, address, API keys, private keys, ID numbers, account numbers, user-defined keywords), before/after diff preview, irreversible replacement or tokenization, payload hash, redaction rule version stamp.
- Independent Ingress Review Agent running in a separate process boundary, with its own prompt-injection detector and structured findings `{ patternId, evidence, evidenceHash, severity, layer }`. The review agent must NOT be the same InternalAgentAdapter that assembled the prompt.
- Quarantine table for suspicious/malicious ingress content with restricted sandbox view, sanitize-summary user notification, and full evidence hash chain.
- Re-sanitize loop on user rejection: each iteration is audited, stricter rules or user-specified exclusions can be applied, loop continues until approve or abort.
- Tool Broker contract and one deterministic, read-only `knowledge.search` vertical slice through policy, owned effect, receipt, ingress review, and audit. This does not enable MCP in Alpha.
- Basic deterministic policy engine, route decision for every run, append-only local audit trail with hash-chain fields, Data Safety Center v0, AI Governance Center v0 run risk summary.
- Audit export endpoint (NDJSON or CSV) with policy-gated access.

Alpha MUST NOT include:

- SaaS multi-tenancy, SSO/RBAC.
- Commercial template / skill marketplace (marketplace skills are v1.0).
- Automatic self-organizing agent recruitment (capability taxonomy and Coordinator are reserved as Alpha data structures; the recruitment decision itself is deferred).
- Auto-download of unknown plugins or auto-pulling of GitHub repos for execution.
- Silent cloud upload of any data.
- Source-less long-term memory.

### 3.2 Beta: Personal Workspace

Beta turns the Alpha loop into a usable personal workspace and adds:

- Richer local model management and provider metadata UI.
- PDF import and automatic incremental indexing evaluation.
- Audit export UX (search, filter, segmented download).
- Quarantine sandbox view, ingress review detail panel.
- Full re-sanitize iteration UI in the Approve-then-Egress flow.
- Skills Market UX: discover, pin version, first-use approval, opt-in auto-update.
- M3 Memory Center and source-linked memory projection.
- Pipeline, Parallel, and Debate Agent Groups with bounded interval/continuous scheduling.
- built-in and declarative local-recipe Skills lowered to pinned Tool Broker capabilities.
- a genuinely restricted and tested LocalCommandAgentAdapter read-only profile.

### 3.3 v1.0: Trusted Desktop Product

v1.0 expands Ogra into a daily workbench:

- Skills Market with community/vendor marketplace skills, content scanning, trust verification.
- Self-building Agent Groups (Coordinator, dynamic group assembly, confirmation UI) — decision was deferred in Alpha; v1.0 is where the implementation approach gets chosen.
- A2A-compatible bridge.
- Safe MCP tool integration.
- Multi-workspace policies.
- Reliable background jobs.
- App updates.
- Evaluated external local agent adapter family (Codex / Claude Code / Aider / Open Interpreter / Hermes) with visible control limitations.

### 3.4 Post-v1

Post-v1 capabilities remain out of first product execution:

- cloud sync.
- team collaboration.
- centralized enterprise audit center.
- SSO/RBAC.
- template marketplace.
- mobile apps.
- full SaaS.

## 4. Cross-Document Invariants

Every layer must preserve these invariants:

- Private data residency defaults to local; compute strategy defaults to hybrid (local phase + cloud phase) with deterministic redaction and explicit user approval on the Approve-then-Egress tier.
- No cloud call happens before (1) policy evaluation, (2) redaction engine output when in auto-filter or approve modes, and (3) user approval when in approve mode.
- Internal private context may enter cloud only after policy, redaction, and (when required) explicit user approval.
- Confidential data can leave local only through the Approve-then-Egress mode after user approval of the sanitized preview. The full preview, approval, payload hash, and redaction rule version must be recorded.
- Restricted data cannot be moved to cloud through ordinary user approval; only an explicit, policy-scoped, approval-recorded, visibly high-risk exception is possible, and only outside Alpha.
- Every run emits a route decision and audit events.
- Every externally visible side effect has one owning frame, a payload fingerprint, a durable state, a linked pre/post audit event, and adapter-specific recovery metadata. A graph/action checkpoint without effect outcome, ownership, dependency, revision, and idempotency evidence is not sufficient recovery state.
- Every tool invocation resolves through the Tool Broker to an immutable, workspace-bound tool version. Agents and renderer code cannot choose transports, servers, secrets, approvals, or invoke adapters directly.
- A Tool/Skill/MCP schema or capability change creates a new pending version and invalidates approval for new calls; an in-flight effect keeps its pinned version.
- Every cloud call emits an egress record with the egress mode (approve / log / auto-filter), payload hash, redaction rule version, and approval id when required.
- Every cloud response is processed by the independent Ingress Review Agent before the local runtime ingests it; an ingress finding with severity and layer is always recorded.
- Ogra Edge is the local execution, indexing, model, policy, routing, redaction, ingress review, and audit runtime inside Ogra Desktop; it is not an optional demo layer or a separate Alpha product line.
- RAG content and any external content (cloud response, tool output, A2A message, MCP tool result) is untrusted context and cannot override policy or system instructions.
- Renderer never directly reads database files or API keys.
- Main process does not execute long-running RAG/model/agent jobs directly.
- Memory entries are source-linked, editable, and deletable.
- Runtime frames/effects and hash-chained audit evidence are authoritative for recovery. Episodic, semantic, and procedural memory may reference and summarize that evidence but cannot replace effect outcomes, approvals, idempotency records, revisions, or authorization.
- External agent control is phased and adapter-dependent.
- Policy must run before retrieval, context assembly, embedding, model invocation, tool invocation, agent delegation, local agent launch, file export, memory write, audit view, and audit export.
- Data egress modeling must explain what Ogra controls and does not control, including model payloads, embeddings, exports, telemetry/crash reports, clipboard, screenshots, browser tools, MCP tools, remote A2A agents, local agent networking, stdout, stderr, and provider-side reasoning/telemetry after the request has been sent.
- Agent Group, M3 Memory, recipes, self-building organization, Local Agent Control Plane, A2A, and MCP must use the same policy, route decision, audit, Data Safety, and Governance primitives as Alpha.
- The Ingress Review Agent must run in a separate process boundary from the InternalAgentAdapter that assembled the original prompt; a single compromised response must never influence its own reviewer.

## 5. Acceptance Vocabulary

The requirement keywords are:

- **MUST**: required for the named phase.
- **SHOULD**: required unless a documented tradeoff is accepted.
- **MAY**: optional.
- **MUST NOT**: prohibited.

Each layer document includes phase-specific acceptance criteria. A feature is not complete when code compiles; it is complete when the product evidence is visible in UI, recorded in local data, and verifiable through tests or demo scripts.

## 6. Top-Level Alpha Gates

Alpha MUST pass these product gates:

- E2E demo imports a fixture folder, marks it Confidential, performs local RAG, applies three-tier egress (auto-filter / log / approve), runs the redaction engine, requires user approval on the Approve tier, sends a sanitized payload to a cloud model, returns a cloud response, processes it through the independent Ingress Review Agent, synthesizes a local answer, and exposes route decision, redaction preview, approval record, ingress findings, payload hash, redaction rule version, and local audit trail.
- The default routing for non-Public data is hybrid (local preprocessing/redaction + cloud reasoning + local synthesis) unless the workspace policy overrides; the UI must surface which mode applied and why.
- RouteDecision includes run/task id, route, high-water classification, egress mode, reasons, local/cloud steps, approval state, policy evaluation link, provider/model references when applicable, cloud payload hash/summary when applicable, redaction rule version when applicable, and audit evidence link.
- Audit events are append-only and verifiable through `previous_hash` / `event_hash`; payload hash, policy version hash, redaction rule version, and ingress review findings are recorded when relevant.
- RAG citations show file, snippet, retrieval method, data classification, source offset/line range, and whether the chunk entered local context, cloud context (after redaction), or neither.
- Data Safety Center v0 shows asset map, inheritance source, recent access, recent cloud inclusion with redaction rule version and payload hash, associated policy, accessible agents/models, provider policy, redaction rule sets, ingress review findings summary, scheduled and continuous Agent Group runs, and the explicit limitation of audit scope (Ogra-controlled boundary only; cloud-internal reasoning is outside Ogra's audit).
- AI Governance Center v0 shows run risk level, risk reasons, required approvals, status, incidents, policy evaluations, egress approval queue, ingress incident records, scheduled run risk summaries, and per-agent ingress/egress statistics.
- Renderer and agents cannot read API keys; secret use writes audit events; provider registry records data-retention/training/region/ZDR/file-upload/tool-calling/streaming-log risk metadata when known.
- The redaction engine has version-stamped rule sets, deterministic before/after diff preview, irreversible replacement or tokenization, payload hash, and audit linkage.
- The Ingress Review Agent produces structured findings `{ patternId, evidence, evidenceHash, severity, layer }`, runs in a process boundary separate from the InternalAgentAdapter, and writes findings to audit. Suspicious or malicious findings land in a quarantine table and surface in the UI as an incident with a restricted sandbox view.
- The Approve-then-Egress tier exposes a re-sanitize loop on user rejection; each iteration is audited with a stricter rule version and a new preview until the user approves or aborts.
- The InternalAgentAdapter executes a Plan + ReAct loop with strong persistence, an enforced sanitize/policy/route/audit middleware chain, and per-step recovery on crash or interruption.
- Interrupted runs recover through the durable execution contract in plan 10: acquire a local lease, load a complete recovery capsule, reconcile unknown external outcomes, re-evaluate policy/approval/revisions, verify a typed recovery decision, and only then resume, retry, compensate, replan, or escalate.
- The Tool Broker `knowledge.search` slice validates canonical arguments, derives workspace scope from Core, and records a pinned descriptor, policy decision, owned effect, receipt, ingress result, and accepted Observation.
- OpenAI-compatible endpoint is callable only after policy allows it; Restricted cloud calls are blocked in Alpha; Confidential cloud calls are blocked in Alpha unless the workspace policy explicitly allows the Approve-then-Egress tier and the user has approved the sanitized preview.
- Renderer does not directly access SQLite or privileged local resources; Main does not execute long-running RAG/model/agent jobs inline.

## 7. Current Development Sequence

Development proceeds in dependency order. Later product surfaces MUST NOT be
used to hide an incomplete earlier runtime layer.

### Sequence 0: Restore a Trustworthy Baseline

- install and lock the desktop dependencies in a writable/reproducible environment;
- run typecheck, unit, integration, security, and current E2E suites;
- align tests and implementation with the current hybrid-default contract, especially Confidential Approve-then-Egress behavior;
- connect `OgraCore`, `RunService`, `InternalAgentAdapter`, and SQLite through one real run path;
- remove simulated model completion and synthetic approval state from the production path.

Exit gate: one real local run is persisted end to end and the baseline suite is green.

### Sequence 1: Durable Data and Runtime Kernel

- implement plan 10 Milestone 0 and Milestone 1;
- add frame/effect/repair/lease migrations and transactional service APIs;
- upgrade new audit events to the versioned canonical envelope hash in plan 02,
  retain legacy verification, and test tampering of event id, hash-envelope
  version, and all other non-payload envelope fields;
- add adapter recovery capability declarations;
- define the plan 11 Tool Broker boundary, immutable descriptor/version/binding
  contract, and a mocked effect adapter; do not enable MCP;
- add crash injection, unknown-outcome reconciliation, and audit-index consistency tests.

Exit gate: a fresh process resumes an idempotent mocked effect without duplicate
physical application and blocks stale, dependency-invalid, or sibling-owned repair.

### Sequence 2: Alpha Hybrid Trust Loop

- implement deterministic redaction rule versions and payload fingerprints;
- implement real approval persistence and bind approval to payload/rule revision;
- implement three-tier egress and re-sanitize iterations;
- execute a policy-gated cloud adapter call through the durable effect protocol;
- implement the independent ingress review process and quarantine path;
- implement the read-only `knowledge.search` Tool Broker vertical slice and route
  its result through the same independent ingress boundary;
- synthesize locally only after accepted ingress review.

Exit gate: the Confidential Alpha fixture completes the full hybrid loop and
survives crash points before egress, after external response, and before local commit.

### Sequence 3: Evidence and Governance UI

- replace demo approval and placeholder overview data with real read models;
- surface frame/effect state, interrupted/unknown state, recovery decision, and audit packet;
- complete Data Safety and AI Governance views for egress, ingress, incidents, approvals, and recovery;
- add policy-gated audit export and UI E2E coverage.

Exit gate: every important runtime claim is visible in UI and traceable to local evidence.

### Sequence 4: Memory Projection

- implement the L0-L4 authority model in plan 10;
- generate episodic memories from terminal audit packets;
- propose semantic/procedural memories with user confirmation and frame/effect/event provenance;
- add stale-source indicators and prohibit memory from authorizing recovery or effects.

Exit gate: a later run can use source-linked memory while current runtime state,
policy, approval, and revisions remain authoritative.

### Sequence 5: Agent Group, Skills, and Scheduling

- map Pipeline, Parallel, and Debate branches to frame subtrees;
- add deterministic merge/Judge steps and sibling-effect isolation;
- implement built-in/declarative local-recipe Skill manifests by lowering them
  to pinned Tool Broker versions and linking invocation audit to owned effects;
- add interval/continuous scheduling with lifetime bounds and recovery leases.

Exit gate: branch failure can be repaired without touching safe sibling effects,
and every scheduled iteration remains bounded, recoverable, and auditable.

### Sequence 6: External Interoperability

- grade LocalCommand and future external adapters by recovery and audit capability;
- add one fixed local stdio MCP tools-only fixture, then hardened Streamable
  HTTP/OAuth, through the plan 11 policy, binding, effect, ingress, and audit contract;
- keep A2A in the AgentAdapter/delegation path while reusing the same execution envelope;
- evaluate external durable workflow substrates only when the native runtime has measured scaling or reliability limits.

Exit gate: no external adapter weakens Ogra's policy, effect, recovery, or audit contract.

## 8. Top-Level Beta/v1 Gates

Beta MUST pass these product gates:

- Audit export UX supports search, filter, segmented download, and policy-gated access.
- Quarantine sandbox view, ingress review detail panel, and full re-sanitize iteration UI in the Approve-then-Egress flow.
- Skills Market UX: discover, pin version, first-use approval, opt-in auto-update.
- Memory Center supports source-linked episodic memory, confirmed semantic/procedural memory, edit/delete/tombstone, memory policy, and memory audit events.
- Pipeline Agent Group is bounded, cancellable, policy-aware, and auditable per step.
- Local recipes can be saved and reused.
- LocalCommandAgentAdapter read-only mode is supervised and audited.
- Data Safety Center includes memory and embedding index assets.

v1.0 MUST pass these product gates:

- Skills Market supports community/vendor marketplace skills with content scanning, trust verification, and user approval gate.
- Self-building Agent Groups end to end (Coordinator, dynamic group assembly, confirmation UI) — implementation approach decided at v1.0 kickoff.
- A2A-compatible bridge and safe MCP tool access are implemented through policy, permissions, route decisions, and audit.
- At least one external local agent adapter family is evaluated and graded with visible control limitations.
- Agent Group is the main work surface with Pipeline, Parallel, and Debate modes, including the user-confirmed self-building flow.
- Data Safety Center includes workspace, knowledge base, folder, file, memory, embedding index, recipe, agent group, artifact, MCP, A2A, local agent adapter, and skill assets.
- AI Governance Center includes Agent Group runs, per-step risk, memory approvals, self-building approvals, local agent incidents, MCP/A2A incidents, adapter audit levels, scheduled and continuous run risk summaries.
