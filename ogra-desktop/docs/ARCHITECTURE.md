# Ogra Desktop — Architecture Overview

> Version: 0.1.0-alpha | Date: 2026-07-03

> This document describes the current implementation snapshot. The active
> target architecture and implementation order are defined by
> [the development requirements index](../../docs/plans/00-development-requirements-index.md)
> and [the durable execution runtime plan](../../docs/plans/10-shd-inspired-durable-execution-runtime.md).
> Tool/Skill/MCP target boundaries are defined by
> [the Tool Broker plan](../../docs/plans/11-tool-broker-mcp-integration-runtime.md).
> In particular, the current Confidential cloud block remains in place until
> the complete Approve-then-Egress and durable effect protocol is implemented.

## Process Architecture

```
Renderer Process (React/Vite UI)
  - Workspace, Chat, Knowledge, Safety, Governance surfaces
  - Calls only typed `window.ogra.*` preload APIs
  - No direct SQLite, secret, or filesystem access
       │
       │ preload.ts (contextBridge)
       ▼
Main Process (Electron)
  - App lifecycle, windows, menus, IPC gateway
  - Permission gate, secret broker
  - Validates caller context and IPC channels
  - Forwards to Ogra Core
       │
       ▼
Ogra Core (Service Layer)
  - WorkspaceService, PolicyService, RouteService
  - AuditService, RunService, ProviderService
  - DataSafetyService, GovernanceService
  - Domain validation, transactional writes
       │
       ▼
Ogra Edge (Runtime Layer)
  - DocumentParser, RagEngine
  - ModelAdapters (Ollama, OpenAI-compatible)
  - InternalAgentAdapter
  - KnowledgeService (import/index)
       │
       ▼
SQLite (Local Store)
  - 32 tables: workspaces, documents, chunks, runs, audit, policies, providers, etc.
  - FTS5 full-text search
  - Append-only run_events with SHA-256 hash chain
```

## Security Boundaries

| Boundary | Enforcement |
|----------|------------|
| Renderer ↔ Node | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` |
| IPC channel access | `ALLOWED_IPC_CHANNELS` allowlist + `validateIpcChannel()` |
| API keys | `OgraSecretBroker` — AES-256-CBC encrypted file, masked in UI |
| File paths | `PathValidator` — canonical path, symlink escape, traversal detection |
| Cloud calls | Current snapshot: policy evaluation before any adapter call; Confidential/Restricted blocked |
| Worker isolation | Workers receive scoped job input only, no inherited env, no direct SQLite |

The secret-broker row describes the current implementation, not the remote MCP
target. Before MCP OAuth, secrets must migrate to an OS-backed store with
audience/scope/generation binding, authenticated protection where portable
storage is unavoidable, and explicit migration/corruption reporting.

## Data Classification

| Level | Default Route | Alpha Behavior |
|-------|--------------|----------------|
| Public | Cloud allowed | May route to local or cloud if policy allows |
| Internal | Local default | Cloud requires redaction + approval |
| Confidential | Local-only | Current snapshot blocks cloud; target Alpha permits only complete Approve-then-Egress |
| Restricted | Strict local allowlist | Approved local models only; approval cannot override |

## Run Lifecycle

```
created
  → policy_precheck
  → retrieval
  → context_policy_check
  → route_decision
  → risk_classified
  → redaction_preview | approval_required | blocked | payload_hash
  → model_invocation
  → model_call_recorded
  → cloud_call_ledger_updated
  → final_output
  → audit_complete
```

Each transition emits an append-only run_event with SHA-256 hash-chain.

The target durable runtime adds persistent task frames, owned effects, explicit
`unknown` outcomes, revisions, typed repair verification, and a local recovery
lease. These are planned capabilities, not claims about the current code. See
[plan 10](../../docs/plans/10-shd-inspired-durable-execution-runtime.md).

## Key Non-Goals (Alpha)

- No SaaS multi-tenancy
- No SSO/RBAC
- No marketplace/commercial recipes
- No fully automatic self-building agents
- No default shell execution
- No silent cloud upload
- No source-less long-term memory

## Data Egress Model

Ogra currently controls model payloads, embedding requests, and Ogra-managed
exports. Tool control is a target: the Capability Gateway will route built-in,
Skill-derived, and MCP tools through immutable versions, policy, owned effects,
receipts, independent ingress review, and audit. It is not implemented yet.

Ogra does NOT control: copy/paste, screenshots, OS-level network, provider-side retention after approved calls, third-party tools outside Ogra, clipboard, browser tools, MCP/A2A (not yet implemented), local agent network requests.

> "Ogra can prove calls made through Ogra-controlled adapters. This does not cover manual copy/paste, screenshots, tools launched outside Ogra, provider-side retention after approved calls, or other local processes."
