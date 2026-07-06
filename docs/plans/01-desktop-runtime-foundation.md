# 01 Desktop Runtime Foundation

> Layer: application foundation
>
> Phase coverage: Alpha required, Beta/v1 extensions noted
>
> Depends on: [00 Development Requirements Index](00-development-requirements-index.md)

## 1. Goal

Build the Ogra Desktop foundation as a local-first Electron application with strict process boundaries:

```text
Renderer UI
  -> Preload typed bridge
  -> Main permission gateway
  -> Ogra Core service layer
  -> Ogra Edge workers / child processes
  -> SQLite, filesystem, model endpoints
```

The foundation must support local file access, local indexing, local model calls, audit persistence, and policy-gated cloud provider use without exposing privileged capabilities to the renderer.

## 2. Non-Negotiable Boundaries

### 2.0 Electron Security Baseline

Every application window MUST use:

- `contextIsolation: true`.
- `nodeIntegration: false`.
- `sandbox: true` unless a documented Electron limitation blocks it.
- no `remote` module.
- restricted navigation.
- denied or allowlisted `window.open`.
- strict Content Security Policy.
- no renderer access to `process`, `require`, Node built-ins, SQLite paths, or secret values.

Shell/browser escapes such as `shell.openExternal` MUST be allowlisted and audited.

### 2.1 Renderer

Renderer MUST:

- Render the product UI.
- Call only typed APIs exposed by preload.
- Treat all local file, secret, database, and model operations as remote capabilities.
- Display permission prompts and route/audit evidence returned by Ogra Core.

Renderer MUST NOT:

- Read or write SQLite files directly.
- Read environment variables or API keys.
- Call cloud providers directly.
- Read arbitrary local paths without an approved IPC capability.
- Execute shell commands.

### 2.2 Preload

Preload MUST:

- Expose a minimal typed `window.ogra` API through `contextBridge`.
- Validate method names through a channel allowlist.
- Validate arguments through shared runtime schemas.
- Avoid exposing generic `ipcRenderer.send` or arbitrary channel access.
- Avoid allowing renderer-controlled event subscriptions outside approved progress/result streams.

Preload SHOULD:

- Export TypeScript types shared with the renderer.
- Return structured errors with stable codes.

### 2.3 Main Process

Main process MUST:

- Own app lifecycle, windows, menus, protocol registration, tray, and update entry points.
- Act as the permission and IPC gateway.
- Broker secrets through OS secure storage or a dedicated secret module.
- Start and supervise Ogra Core/Edge workers.
- Record permission decisions as audit events.
- Inject caller context and permission context into Ogra Core calls.
- Spawn and supervise the Ingress Review Agent as a separate process boundary. The Ingress Review Agent MUST NOT share the InternalAgentAdapter's process, module loader, or scratch space. The main process MUST enforce a different IPC channel namespace for ingress review and a different caller context shape. A compromised cloud response must never influence its own reviewer.

Main process MUST NOT:

- Execute long-running indexing, embedding, model, or agent jobs inline.
- Store provider keys in renderer-accessible state.
- Accept arbitrary filesystem paths without workspace/path policy checks.
- Trust renderer-supplied workspace ids, provider ids, approval ids, or approval state without server-side validation.
- Co-locate Ingress Review Agent state with InternalAgentAdapter state.

Ogra Core services MAY run in the Main process for Alpha only if long-running work is delegated out. Main handlers MUST remain thin permission and routing wrappers.

### 2.4 Ogra Core

Ogra Core MUST:

- Implement application services: workspace, policy, routing, audit, RAG, model invocation, agent runs.
- Own domain validation and transactional writes.
- Write run events through the audit logger.
- Expose typed service methods to Main, not UI components.

### 2.5 Ogra Edge Workers

Ogra Edge workers MUST:

- Execute local indexing, retrieval, model calls, and agent jobs outside the renderer.
- Report progress and structured events to Ogra Core.
- Support cancellation.
- Fail closed when policy, permission, or workspace scope is unclear.
- Receive scoped job input only.
- Avoid inheriting full parent environment variables.
- Avoid direct secret access by default.
- Avoid direct SQLite writes unless the job is explicitly designated as a single-writer core job.
- Return structured results, event proposals, hashes, counts, and errors instead of raw unrestricted file contents.

Alpha MAY implement workers as Node worker threads or child processes. The interface must leave room for a future sidecar daemon.

Alpha SHOULD use Ogra Core as the single database writer. Worker cancellation MUST clean up partial job state and write a cancellation event through Core.

## 3. Alpha Requirements

### 3.1 Project Setup

Alpha MUST include:

- `package.json` scripts for development, test, build, and packaging smoke checks.
- TypeScript strict mode.
- Electron main, preload, renderer, and core source folders.
- Vitest for unit/integration tests.
- Playwright or equivalent for minimal desktop/e2e smoke tests.

Recommended structure:

```text
electron/
  main/
  preload/
src/
  renderer/
  core/
  edge/
  shared/
tests/
```

The renderer may import shared types and schemas, but MUST NOT import Ogra Core service implementations.

### 3.2 Typed IPC Contract

Alpha MUST define typed APIs for:

- workspace create/list/select/update classification.
- folder import request.
- indexing start/status/cancel.
- chat/run start/status/cancel.
- route decision fetch.
- audit event fetch.
- audit export (NDJSON or CSV), policy-gated.
- Data Safety Center summaries.
- AI Governance run risk summaries.
- model/provider registry read and update.
- permission request and decision.
- approval request and decision (including the Approve-then-Egress approval record and the re-sanitize loop).
- policy dry-run.
- secret metadata create/update/delete.
- provider connection test.
- data egress summary.
- cloud call ledger.
- ingress review request and result.
- quarantine list, quarantine read (sandbox view), quarantine clean-and-proceed.

Every IPC handler MUST:

- validate input.
- attach caller context.
- enforce workspace scope.
- call Ogra Core service.
- return structured success/error results.
- write an audit event for privileged operations.

Every IPC error MUST use a stable error code. Rejected arbitrary channels MUST be covered by tests.

Route decisions are mandatory run artifacts created before model invocation, not just records fetched after completion.

### 3.3 File Access

Alpha MUST support:

- user-selected folder import.
- allowed workspace roots.
- Markdown, TXT, and common code file discovery.
- explicit folder classification at import time.
- canonical path validation using `realpath` or equivalent.
- saved approved roots.
- subpath checks against approved roots.
- symlink escape detection.
- path traversal rejection.
- hidden/system directory opt-in.

Alpha MUST NOT:

- recursively index the whole home directory by default.
- follow symlinks outside approved roots without explicit handling.
- index hidden/system folders unless user explicitly opts in.

Renderer MUST NOT receive a capability that can read arbitrary paths. Path display in UI SHOULD be privacy-conscious.

### 3.4 Runtime Configuration

Alpha MUST provide local configuration for:

- app data directory.
- database path.
- Ollama base URL and default model.
- OpenAI-compatible endpoint metadata.
- telemetry/crash reporting absent or disabled by default.

Renderer MUST NOT receive raw API keys.

Configuration MUST distinguish:

- non-sensitive app settings.
- provider metadata visible to renderer.
- secret values accessible only through the secret broker.

OpenAI-compatible raw keys, auth headers, environment variables, and secret values MUST NOT enter renderer state, worker environment, logs, progress events, or error messages.

Secret broker requirements:

- store secret values outside renderer-readable SQLite rows.
- store only masked metadata in SQLite/UI.
- inject provider credentials only for approved adapter calls.
- write audit event on secret create/update/delete/use.
- deny agent/worker direct secret reads by default.

If telemetry or crash reporting is introduced later, it MUST be modeled as data egress and require explicit user-facing explanation and consent.

### 3.5 Cancellation and Progress

Alpha MUST expose progress events for:

- folder scanning.
- parsing/chunking.
- FTS indexing.
- model generation.
- audit write completion.

Long-running operations MUST support cancellation. Cancellation MUST write a run event when it affects a run or index job.

Progress events MUST NOT include complete prompts, full file contents, secret values, raw cloud payloads, or unredacted sensitive data. They may include ids, counts, hashes, statuses, warning ids, and short user-approved labels.

## 4. Beta Requirements

Beta SHOULD add:

- background indexing scheduler.
- file watcher for optional incremental indexing.
- secret rotation UI.
- read-only local command agent process wrapper.
- audit export file picker.
- more robust crash recovery for interrupted jobs.

## 5. v1.0 Requirements

v1.0 SHOULD add:

- auto-update flow.
- signed packaged app.
- adapter supervisor for external local agents.
- durable job queue.
- optional sidecar-ready Ogra Edge boundary.

## 6. Acceptance Criteria

Alpha is accepted when:

- The desktop app starts without renderer access to Node globals.
- Renderer calls privileged functions only through typed preload APIs.
- Renderer has no usable `process` or `require`.
- Arbitrary IPC channels are rejected.
- A user can choose a folder and import it into a workspace without direct renderer filesystem access.
- Path traversal and symlink escape attempts are rejected.
- Index and run jobs report progress and can be cancelled.
- Local database and secrets are inaccessible from renderer code.
- Secret values do not appear in renderer, devtools-visible state, logs, progress events, or errors.
- A policy-gated run can call Ollama through Ogra Core/Edge.
- A policy-gated cloud call can only happen through an Ogra-controlled model adapter after route decision and policy evaluation.
- IPC tests cover allowed and rejected calls.
- At least one e2e smoke test runs the Alpha demo path in the packaged or dev Electron app.

## 7. Anti-Patterns

MUST NOT introduce:

- `window.ipcRenderer` or generic IPC escape hatches.
- renderer-side `fetch` to model providers.
- long model calls inside Main process handlers.
- hard-coded workspace IDs in production paths.
- silent permission grants for files, shell, network, or secrets.
- app-wide global mutable state for the active workspace without audit context.
- worker processes inheriting full parent environment by default.
- full file content or prompt content in audit/progress logs by default.
