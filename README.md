# Ogra Planning Workspace

This directory contains the current product guidance and archived strategy documents for **Ogra / Ogra Edge**.

## Current Source Of Truth

- [ogra-product-handbook.md](ogra-product-handbook.md)

This is the highest-priority guidance file for future implementation. It supersedes the older whitepaper-style documents now stored under `archive/`.

## Current Product Direction

**Ogra Desktop** is a local-first, hybrid-default, transparent-routing, auditable AI Agent workspace for individuals and small teams.

Its core promise:

> Users can work with private personal or enterprise data in Ogra while clearly knowing which data stays local, which data goes to the cloud through Ogra-managed adapters and under which egress mode (Approve / Log / Auto-Filter), why it was routed there, what was redacted under which rule version, which model was used, what local audit trail was produced, and how every inbound cloud response was reviewed by the independent Ingress Review Agent.

## Core Concepts

- **Ogra Desktop**: the main desktop product.
- **Ogra Edge**: the local runtime, local model node, local RAG/indexing layer, redaction engine, ingress review agent, edge/cloud routing executor, and audit runtime.
- **Local-first residency**: files, memories, knowledge bases, traces, and audit logs default to local storage.
- **Hybrid-default compute**: non-Public tasks default to a hybrid plan (local retrieval -> redaction -> cloud reasoning -> local synthesis). Pure local remains available as a high-security workspace policy override.
- **Three-tier egress policy**: every cloud call falls into one of `auto_redact`, `log_and_proceed`, `approve_then_egress` (with re-sanitize loop on rejection), or `blocked`. The mode is selected from the data classification high-water mark.
- **Independent ingress review**: every cloud response, tool return, A2A message, and MCP result is processed by an Ingress Review Agent that runs in a separate process boundary from the InternalAgentAdapter that produced the original request. Suspicious or malicious findings land in a quarantine table with an incident.
- **Transparent routing**: every task produces a route decision, an egress record (mode + payload hash + redaction rule version), ingress findings, and an audit event.
- **Data Safety Center**: data safety surface for data classification, model allowlists, redaction rule sets, egress mode, ingress findings summary, scheduled/continuous run assets, and the explicit limitation of audit scope (Ogra-controlled boundary only; cloud-internal reasoning is outside Ogra's audit).
- **AI Governance Center**: governance surface for run risk, approval queue, re-sanitize history, ingress incident records, scheduled run risk summaries, policy registry, model registry, and audit reports.
- **RAG personal knowledge base**: first-class local knowledge layer for documents, code, PDFs, and project files.
- **Agent Group orchestration**: bounded Pipeline, Parallel, and Debate modes, each with per-step policy, route, and audit. Interval and continuous scheduling with lifetime-level bounds.
- **Skills Market**: built-in and local-recipe skills loaded via manifest, evaluated by policy, audited per invocation.
- **M3 memory**: audit-linked white-box memory split into episodic, semantic, and procedural memory.
- **Human-confirmed self-building organization**: agents can recommend adding capabilities, but users must approve. Self-building is deferred from Alpha as a recruitment decision; the data structures are reserved.
- **Local Agent Control Plane**: supervised launcher plus transcript/audit wrapper for local agent runtimes. Alpha includes InternalAgentAdapter (Plan + ReAct) and LocalCommandAgentAdapter (read-only supervised). External adapters (Codex, Claude Code, Hermes, Aider, Open Interpreter) are v1.0.

## Recommended Product Shape

Primary form:

```text
Ogra Desktop
  = Electron desktop shell
  + Web UI
  + Local Runtime
  + Ogra Edge
  + Optional Cloud Providers
```

The desktop app is the priority because Ogra depends on local files, local indexing, local models, local audit logs, and a strong privacy/security user expectation.

Alpha uses Electron. Tauri is a future lightweight port / experimental runtime, not part of the first implementation target.

Pure Web is not the first target. It may become a future companion surface for docs, sync, recipes, or remote audit review.

## MVP Scope

Alpha should prove the hybrid-default loop:

1. Desktop shell.
2. Local workspace.
3. Markdown / TXT / code folder import.
4. Manual reindex with progress events.
5. SQLite FTS5 retrieval.
6. Ollama model adapter.
7. OpenAI-compatible adapter.
8. InternalAgentAdapter as Plan + ReAct + strong-persistence engine with sanitize/policy/route/audit middleware.
9. LocalCommandAgentAdapter (read-only supervised).
10. Basic policy engine with three-tier egress (`auto_redact` / `log_and_proceed` / `approve_then_egress`) and three-tier ingress.
11. Redaction engine (versioned rule sets, diff preview, re-sanitize loop).
12. Ingress Review Agent (separate process boundary, regex layer).
13. Quarantine table and restricted sandbox view.
14. Route decisions (with egress_mode, redaction_rule_version, ingress findings).
15. Append-only local audit trail with hash-chain integrity.
16. Data Safety Center v0.
17. AI Governance Center v0 (with egress approval queue, ingress incidents, scheduled run summaries).
18. Agent Group Pipeline + Parallel + Debate.
19. Agent Group interval + continuous scheduling.
20. Skills Market (built-in + local-recipe).
21. Audit export (NDJSON/CSV, policy-gated).
22. M3 memory center (episodic auto; semantic/procedural user-confirmed).

Alpha demo path:

```text
Import sensitive folder
  -> mark Confidential
  -> local RAG retrieval
  -> policy selects egress_mode = approve_then_egress
  -> redaction engine produces sanitized preview
  -> user approves (or re-sanitize loop)
  -> cloud reasoning
  -> cloud response arrives
  -> Ingress Review Agent scans (separate process)
  -> clean / suspicious / malicious handling
  -> local synthesis and final answer
  -> show route decision, egress mode, redaction rule version, ingress findings, re-sanitize history, audit chain
```

## Explicit Non-Goals For The First Phase

- Do not build a full LobeHub replacement.
- Do not fork LobeHub deeply.
- Do not build SaaS multi-tenancy.
- Do not build SSO / RBAC / enterprise admin.
- Do not build a commercial template marketplace.
- Do not build fully automatic self-organizing agents.
- Do not auto-run shell commands by default.
- Do not silently upload private data to cloud models.
- Do not make long-term memory uneditable or source-less.

## Directory Map

```text
.
├── README.md
├── AGENTS.md
├── docs/
│   ├── plans/
│   │   ├── 00-development-requirements-index.md
│   │   ├── 01-desktop-runtime-foundation.md
│   │   ├── 02-local-data-audit-governance-store.md
│   │   ├── 03-policy-routing-safety-engine.md
│   │   ├── 04-rag-knowledge-engine.md
│   │   ├── 05-model-agent-orchestration.md
│   │   ├── 06-application-ui-ux.md
│   │   ├── 07-verification-packaging-release-gates.md
│   │   ├── 08-memory-agentgroup-recipes-v1-requirements.md
│   │   └── 09-vNext-strategic-direction.md
│   └── prd/
│       └── 01-ogra-alpha-requirements.md
├── ogra-product-handbook.md
└── archive/
    ├── orga-product-doc.md
    └── orga-edge-whitepaper.md
```

## Development Requirements

The active implementation planning documents are under [docs/plans](docs/plans/), starting with:

- [docs/plans/00-development-requirements-index.md](docs/plans/00-development-requirements-index.md)

These plans replace the earlier Alpha demo task breakdown. They are organized by product and architecture layer: desktop runtime, local data/audit/governance store, policy/routing/safety, RAG, model and Agent orchestration, UI/UX, verification/release gates, and Beta/v1 memory/Agent Group/recipes/interoperability completion.

## Repository Status

This directory is now a git repository.

Current state:

- Initialized with `git init`.
- Current default branch: `master`.
- No initial commit has been made yet.

Recommended workflow for future agents:

1. Check status before editing:

   ```bash
   git status --short --branch
   ```

2. Keep root documents and navigation in sync:
   - [ogra-product-handbook.md](ogra-product-handbook.md)
   - [README.md](README.md)
   - [AGENTS.md](AGENTS.md), when agent workflow changes

3. Do not move archived files unless explicitly requested.

4. If the branch is renamed later, update this section and [AGENTS.md](AGENTS.md).

## Archived Documents

The archive contains earlier strategy material:

- [archive/orga-product-doc.md](archive/orga-product-doc.md)
- [archive/orga-edge-whitepaper.md](archive/orga-edge-whitepaper.md)

These are useful as historical context, but they include broader assumptions about SaaS, enterprise commercialization, template markets, and cloud-first architecture. When they conflict with the handbook, follow [ogra-product-handbook.md](ogra-product-handbook.md).

## Agent Startup

Agents working in this directory should start with [AGENTS.md](AGENTS.md), then read this README, then read the handbook.
