# Ogra Planning Workspace

This directory contains the current product guidance and archived strategy documents for **Ogra / Ogra Edge**.

## Current Source Of Truth

- [ogra-product-handbook.md](ogra-product-handbook.md)

This is the highest-priority guidance file for future implementation. It supersedes the older whitepaper-style documents now stored under `archive/`.

## Current Product Direction

**Ogra Desktop** is a local-first, hybrid edge/cloud, transparent-routing, auditable AI Agent workspace for individuals and small teams.

Its core promise:

> Users can work with private personal or enterprise data in Ogra while clearly knowing which data stays local, which data goes to the cloud through Ogra-managed adapters, why it was routed there, whether it was redacted, which model was used, and what local audit trail was produced.

## Core Concepts

- **Ogra Desktop**: the main desktop product.
- **Ogra Edge**: the local runtime, local model node, local RAG/indexing layer, and edge/cloud routing executor.
- **Local-first workspace**: files, memories, knowledge bases, traces, and audit logs default to local storage.
- **Transparent routing**: every task produces a route decision such as `local`, `cloud`, `hybrid`, or `blocked`.
- **Data Safety Center**: data safety surface for data classification, model allowlists, redaction, data asset maps, and Ogra-managed cloud call records.
- **AI Governance Center**: governance surface for run risk, approval workflow, incident review, policy registry, model registry, and audit reports.
- **RAG personal knowledge base**: first-class local knowledge layer for documents, code, PDFs, and project files.
- **Agent Group orchestration**: controlled multi-agent flows such as `Pipeline`, `Parallel`, and `Debate`.
- **M3 memory**: audit-linked white-box memory split into episodic, semantic, and procedural memory.
- **Human-confirmed self-building organization**: agents can recommend adding capabilities, but users must approve.
- **Local Agent Control Plane**: supervised launcher plus transcript/audit wrapper for local agent runtimes such as Codex, Claude Code, Hermes Agent, Aider, Open Interpreter, and local script agents. Full control is adapter-dependent and phased after Alpha.

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

Alpha should prove the core loop:

1. Desktop shell.
2. Local workspace.
3. Markdown / TXT / code folder import.
4. Manual reindex.
5. SQLite FTS5 retrieval.
6. Ollama model adapter.
7. OpenAI-compatible adapter.
8. InternalAgentAdapter.
9. Basic policy engine.
10. Route decisions.
11. Append-only local audit trail.
12. Data Safety Center v0.
13. AI Governance Center v0 run risk summary.

Alpha demo path:

```text
Import sensitive folder
  -> mark Confidential
  -> local RAG retrieval
  -> policy decides local-only
  -> local model answers
  -> show 0 Ogra-managed cloud calls
  -> show route decision + local audit trail
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
├── ogra-product-handbook.md
└── archive/
    ├── orga-product-doc.md
    └── orga-edge-whitepaper.md
```

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
