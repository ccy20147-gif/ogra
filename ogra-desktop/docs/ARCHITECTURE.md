# Ogra Desktop — Architecture Overview

> Version: 0.1.0-alpha | Date: 2026-07-03

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
| Cloud calls | Policy evaluation before any adapter call; Confidential/Restricted blocked in Alpha |
| Worker isolation | Workers receive scoped job input only, no inherited env, no direct SQLite |

## Data Classification

| Level | Default Route | Alpha Behavior |
|-------|--------------|----------------|
| Public | Cloud allowed | May route to local or cloud if policy allows |
| Internal | Local default | Cloud requires redaction + approval |
| Confidential | Local-only | MUST route local or blocked; cloud upload blocked |
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

## Key Non-Goals (Alpha)

- No SaaS multi-tenancy
- No SSO/RBAC
- No marketplace/commercial recipes
- No fully automatic self-building agents
- No default shell execution
- No silent cloud upload
- No source-less long-term memory

## Data Egress Model

Ogra controls: model payloads, embedding requests, Ogra-managed exports, tool calls through adapters.

Ogra does NOT control: copy/paste, screenshots, OS-level network, provider-side retention after approved calls, third-party tools outside Ogra, clipboard, browser tools, MCP/A2A (not yet implemented), local agent network requests.

> "Ogra can prove calls made through Ogra-controlled adapters. This does not cover manual copy/paste, screenshots, tools launched outside Ogra, provider-side retention after approved calls, or other local processes."
