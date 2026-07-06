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
- Why the route was selected.
- Whether redaction or approval was required.
- Which model and agent executed each step.
- Which local audit evidence was produced.

## 2. Document Set

The development requirements are split by responsibility layer:

1. [01 Desktop Runtime Foundation](01-desktop-runtime-foundation.md)
   - Electron shell, process boundaries, typed IPC, workers, app lifecycle, local permissions.

2. [02 Local Data, Audit, and Governance Store](02-local-data-audit-governance-store.md)
   - SQLite schema, migrations, workspace isolation, hash-chain run events, route decisions, model/provider/policy registries.

3. [03 Policy, Routing, and Safety Engine](03-policy-routing-safety-engine.md)
   - deterministic policy evaluation, route decision schema, approval rules, prompt-injection warnings, egress modeling.

4. [04 RAG and Knowledge Engine](04-rag-knowledge-engine.md)
   - local file import, classification inheritance, FTS5 retrieval, citations, indexing status, source trust, future vector search.

5. [05 Model and Agent Orchestration](05-model-agent-orchestration.md)
   - model adapters, InternalAgentAdapter, agent manifests, bounded runs, future Agent Group and local agent control plane.

6. [06 Application UI and UX](06-application-ui-ux.md)
   - workspace UX, knowledge import, chat/run experience, route trace viewer, Data Safety Center, AI Governance Center.

7. [07 Verification, Packaging, and Release Gates](07-verification-packaging-release-gates.md)
   - unit/integration/e2e tests, security checks, demo scripts, packaging, acceptance gates by phase.

8. [08 Memory, Agent Group, Recipes, and Interop Requirements](08-memory-agentgroup-recipes-v1-requirements.md)
   - M3 memory, Agent Group, recipes, self-building organization, Local Agent Control Plane, A2A/MCP, and Beta/v1 completion gates.

9. [09 vNext Strategic Direction](09-vNext-strategic-direction.md)
   - Post-Alpha product strategy: local-first semantic clarification, three-tier data egress/ingress policy, Agent Group scheduling, self-building direction, cloud agent transparency boundary.

## 3. Phase Definitions

### 3.1 Alpha: Trustable Core Loop

Alpha proves the non-negotiable loop:

```text
Import sensitive folder
  -> mark Confidential
  -> local RAG retrieval
  -> policy decides local-only
  -> local model answers
  -> show 0 Ogra-managed cloud calls
  -> show route decision + local audit trail
```

Alpha must include:

- Electron desktop shell with safe renderer/main/core boundaries.
- Local workspace.
- Markdown, TXT, and common code folder import.
- Manual reindex with visible status.
- SQLite FTS5 retrieval.
- Ollama adapter.
- OpenAI-compatible adapter with policy-gated cloud use.
- InternalAgentAdapter.
- Basic deterministic policy engine.
- RouteDecision record for every run.
- Append-only local audit trail with hash-chain fields.
- Data Safety Center v0.
- AI Governance Center v0 run risk summary.

Alpha must not include:

- SaaS multi-tenancy.
- SSO/RBAC.
- marketplace/commercial recipes.
- fully automatic agent self-organization.
- default shell execution.
- silent cloud upload.
- source-less long-term memory.

### 3.2 Beta: Personal Workspace

Beta turns the Alpha loop into a usable personal workspace:

- M3 Memory Center with automatic episodic run summaries only.
- Semantic and procedural memories only after user confirmation.
- 3-agent Pipeline mode.
- reusable recipes.
- redaction preview and user approval flow.
- audit export.
- richer local model management.
- read-only LocalCommandAgentAdapter.
- PDF and automatic incremental indexing evaluation.

### 3.3 v1.0: Trusted Desktop Product

v1.0 expands Ogra into a daily workbench:

- user-confirmed self-building organization.
- A2A-compatible bridge.
- safe MCP tool integration.
- multi-workspace policies.
- reliable background jobs.
- app updates.
- evaluated Codex, Claude Code, Aider, Open Interpreter, and similar local agent adapters.

Beta and v1.0 hard requirements are detailed in [08 Memory, Agent Group, Recipes, and Interop Requirements](08-memory-agentgroup-recipes-v1-requirements.md). These items are not optional roadmap ideas once the named phase is in scope.

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

- Private data defaults to local.
- No cloud call happens before policy evaluation.
- Internal private context can enter cloud only after policy, redaction preview when required, and user approval when required.
- Confidential data is local-only in Alpha; any Beta/v1 or later exception must be explicit, policy-scoped, approval-recorded, and visibly high risk.
- Restricted data cannot be moved to cloud through ordinary user approval.
- Every run emits route decision and audit events.
- Ogra Edge is the local execution, indexing, model, policy, routing, and audit runtime inside Ogra Desktop; it is not an optional demo layer or a separate Alpha product line.
- RAG content is untrusted context and cannot override policy or system instructions.
- Renderer never directly reads database files or API keys.
- Main process does not execute long-running RAG/model/agent jobs directly.
- Memory entries are source-linked, editable, and deletable.
- External agent control is phased and adapter-dependent.
- Policy must run before retrieval, context assembly, embedding, model invocation, tool invocation, agent delegation, local agent launch, file export, memory write, audit view, and audit export.
- Data egress modeling must explain what Ogra controls and does not control, including model payloads, embeddings, exports, telemetry/crash reports, clipboard, screenshots, browser tools, MCP tools, remote A2A agents, local agent networking, stdout, and stderr.
- Beta/v1 Agent Group, M3 Memory, recipes, self-building organization, Local Agent Control Plane, A2A, and MCP must use the same policy, route decision, audit, Data Safety, and Governance primitives as Alpha.

## 5. Acceptance Vocabulary

The requirement keywords are:

- **MUST**: required for the named phase.
- **SHOULD**: required unless a documented tradeoff is accepted.
- **MAY**: optional.
- **MUST NOT**: prohibited.

Each layer document includes phase-specific acceptance criteria. A feature is not complete when code compiles; it is complete when the product evidence is visible in UI, recorded in local data, and verifiable through tests or demo scripts.

## 6. Top-Level Alpha Gates

Alpha MUST pass these product gates:

- E2E demo imports a fixture folder, marks it Confidential, performs local RAG, answers through a local model, shows `0 Ogra-managed cloud calls`, and exposes route decision plus local audit trail.
- RouteDecision includes run/task id, route, high-water classification, reasons, local/cloud steps, approval state, policy evaluation link, provider/model references when applicable, cloud payload hash/summary when applicable, and audit evidence link.
- Audit events are append-only and verifiable through `previous_hash` / `event_hash`; payload hash, policy version hash, and redaction rule version are recorded when relevant.
- RAG citations show file, snippet, retrieval method, data classification, source offset/line range, and whether the chunk entered local context, cloud context, or neither.
- Data Safety Center v0 shows asset map, inheritance source, recent access, recent cloud inclusion, associated policy, accessible agents/models, provider policy, and the explicit limitation of `0 Ogra-managed cloud calls`.
- AI Governance Center v0 shows run risk level, risk reasons, required approvals, status, incidents, and policy evaluations.
- Renderer and agents cannot read API keys; secret use writes audit events; provider registry records data-retention/training/region/ZDR/file-upload/tool-calling/streaming-log risk metadata when known.
- OpenAI-compatible endpoint is callable only after policy allows it; Confidential and Restricted cloud calls are blocked in Alpha.
- Renderer does not directly access SQLite or privileged local resources; Main does not execute long-running RAG/model/agent jobs inline.

## 7. Top-Level Beta/v1 Gates

Beta MUST pass these product gates:

- M3 Memory Center supports source-linked episodic memory, confirmed semantic/procedural memory, edit/delete/tombstone, memory policy, and memory audit events.
- Pipeline Agent Group is bounded, cancellable, policy-aware, and auditable per step.
- Local recipes can be saved and reused.
- LocalCommandAgentAdapter read-only mode is supervised and audited.
- Data Safety Center includes memory and embedding index assets.

v1.0 MUST pass these product gates:

- Agent Group is the main work surface with Pipeline, Parallel, and Debate modes.
- Human-confirmed self-building organization works end to end.
- A2A-compatible bridge and safe MCP tool access are implemented through policy, permissions, route decisions, and audit.
- At least one external local agent adapter family is evaluated and graded with visible control limitations.
- Data Safety Center includes workspace, knowledge base, folder, file, memory, embedding index, recipe, agent group, artifact, MCP, A2A, and local agent adapter assets.
- AI Governance Center includes Agent Group runs, per-step risk, memory approvals, self-building approvals, local agent incidents, MCP/A2A incidents, and adapter audit levels.
