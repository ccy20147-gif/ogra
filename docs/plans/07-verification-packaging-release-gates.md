# 07 Verification, Packaging, and Release Gates

> Layer: quality, security, packaging, and phase acceptance
>
> Phase coverage: Alpha required, Beta/v1 extensions noted
>
> Depends on: all previous plan documents

## 1. Goal

Define the verification gates that prove Ogra works as a local-first, transparent-routing, auditable desktop product.

Passing tests is necessary but not sufficient. A phase is accepted only when product evidence is visible in UI, persisted in local data, and reproducible through automated or scripted checks.

## 2. Alpha Demo Fixture

Alpha MUST include a local fixture set:

```text
fixtures/
  confidential-finance/
    q2-anomalies.md
    vendor-payments.txt
  public-research/
    market-notes.md
  prompt-injection/
    hostile-instructions.md
```

Fixtures MUST cover:

- Confidential data.
- Public data.
- mixed Public + Confidential retrieval.
- prompt injection pattern.
- unsupported files.
- common code file.

No fixture should contain real secrets or personal data.

## 3. Alpha End-to-End Acceptance

The required Alpha E2E script:

```text
1. Start Ogra Desktop.
2. Create workspace "Finance Review".
3. Set workspace default classification to Confidential.
4. Import fixture confidential folder.
5. Confirm classification inheritance.
6. Run manual reindex.
7. Ask a question answered by local RAG.
8. Policy chooses local route.
9. Ollama or another explicitly configured local model-compatible service returns answer.
10. UI shows citations.
11. UI shows route decision.
12. UI shows 0 Ogra-managed cloud calls.
13. UI shows local audit trail.
14. AI Governance shows run risk summary.
15. Data Safety shows recent accessed assets and 0 cloud calls.
```

The same E2E suite MUST verify:

- Public-only fixture can use OpenAI-compatible adapter when policy and test configuration allow.
- Confidential fixture is blocked from OpenAI-compatible cloud adapter.
- Restricted fixture cannot be sent to cloud through approval.
- prompt-injection fixture creates warning and incident/risk entry.
- policy blocks or allows at each required execution point: retrieval, context assembly, embedding, model invocation, tool invocation, agent delegation, local agent launch, file export, memory write, audit view, and audit export.

CI MAY use mocked local/provider adapters. Alpha release gate MUST include at least one packaged or production-like smoke test against the real Ollama adapter or a real local OpenAI-compatible model service.

## 4. Unit Test Requirements

Alpha MUST include unit tests for:

- classification high-water mark.
- policy priority and deny-first conflict handling.
- route decision generation.
- hash-chain audit event creation and verification.
- secret broker metadata/value separation.
- provider registry validation.
- model adapter request hashing.
- RAG parser/chunker source offsets.
- FTS search.
- prompt injection detector.
- IPC schema validation.
- path canonicalization.
- run risk classification.
- policy gates for embedding, export, audit view/export, memory write, tool invocation, and agent delegation.

## 5. Integration Test Requirements

Alpha MUST include integration tests for:

- database migration from empty database.
- workspace creation and classification.
- folder import and indexing.
- retrieval with policy filtering.
- context assembly with citations.
- local Ollama adapter through mocked HTTP server.
- OpenAI-compatible adapter through mocked HTTP server.
- blocked cloud call creates incident.
- model call ledger drives cloud-call count.
- route trace fetch.
- Data Safety read models.
- AI Governance read models.
- cancellation of indexing and generation jobs.
- secret broker use without exposing secret values.
- worker job execution without inherited full environment, direct secret reads, or direct SQLite writes.
- audit export and audit view policy checks.

## 6. Desktop Security Checks

Alpha MUST verify:

- `contextIsolation` enabled.
- `nodeIntegration` disabled.
- `sandbox` enabled unless documented otherwise.
- `remote` module disabled.
- `shell.openExternal` allowlisted and audited.
- renderer cannot access `process`, `require`, SQLite path, or secret values.
- generic IPC channels are rejected.
- IPC channel allowlist is enforced.
- IPC runtime schema validation rejects malformed input.
- Main/Core injects permission context and rejects renderer-forged workspace ids, paths, provider ids, approval ids, and approval state.
- navigation and window-open policies are restricted.
- CSP is configured.
- path traversal and symlink escape are blocked.
- renderer-side provider fetch is absent.
- secret values do not appear in logs, renderer state, progress events, or error messages.
- workers/child processes do not inherit full parent environment by default.
- workers cannot directly read secrets or write SQLite unless explicitly designated.
- cancelled workers clean up partial state.

## 7. Audit Verification

Alpha MUST include a verifier that checks:

- every run has ordered events.
- `sequence` is monotonic per run.
- `(run_id, sequence)` is unique.
- `previous_hash` matches prior event.
- `event_hash` is reproducible.
- canonical JSON serialization, hash algorithm, and genesis value match the documented spec.
- route decision event exists.
- policy evaluation event exists.
- model call events exist when generation happens.
- blocked events exist when run is blocked.
- export/delete/cleanup audit operations append events.
- participating agents, accessed files/chunks, accessed memories if any, route decision, local/cloud calls, provider/model, redaction summary when any, uploaded payload hash when any, approval, tool calls, output location, and timestamps are present for each applicable run.
- tamper tests fail verification after event payload, sequence, or previous hash mutation.
- concurrent event append tests preserve transaction boundaries.

The verifier MAY be a test helper in Alpha. It SHOULD become a user-facing diagnostic later.

## 8. UI Test Requirements

Alpha UI tests MUST cover:

- no workspace state.
- no indexed knowledge state.
- import flow.
- indexing progress.
- local-only run.
- downgraded run.
- blocked run.
- Public cloud-allowed run.
- citation expansion.
- route trace viewer.
- Data Safety Center cloud-call count.
- Data Safety Center asset map.
- Data Safety Center classification inheritance.
- Data Safety Center recent access.
- Data Safety Center recent cloud inclusion.
- Data Safety Center associated policy and model/agent allowlist.
- AI Governance run risk detail.
- provider key masked display.
- local model unavailable.

Responsive checks SHOULD include at least desktop and narrow-window layouts.

## 9. Packaging Requirements

Alpha MUST provide:

- dev run command.
- test command.
- build command.
- package command or documented packaging path.
- clean app-data reset command for local testing.
- smoke test against packaged or production-like desktop app.

Alpha package MUST:

- store data in app data directory.
- not require a cloud account.
- work with Ollama optional but clearly show missing local model state.
- keep telemetry/crash reporting disabled.
- run the Confidential local demo without any cloud account.
- create app data with appropriate local permissions.
- verify OS secret store availability or present a clear blocked setup state.
- run database migrations forward from prior Alpha schema versions when present.
- keep devtools/debug IPC/test backdoors disabled in production builds.
- ensure reset commands do not delete user-selected source folders.

## 10. Documentation Requirements

Alpha MUST include developer docs for:

- architecture overview.
- local setup.
- fixture demo path.
- database migration.
- policy defaults.
- provider setup.
- test commands.
- security assumptions and non-goals.

User-facing Alpha docs MUST explain:

- what `0 Ogra-managed cloud calls` means.
- what Ogra does not control.
- modeled egress paths including telemetry/crash reports, clipboard, screenshots, browser tools, MCP, remote A2A, local agent network requests, stdout, and stderr.
- how to import and classify a folder.
- how to read route trace and audit evidence.
- how provider keys are stored.

## 11. Release Gates

### Alpha Gate

Alpha can be called complete only when:

- all Alpha E2E acceptance steps pass.
- packaged/prod-like smoke test proves real local model adapter path.
- Confidential local-only demo passes with cloud call count derived from ledger.
- route decisions and audit evidence are persisted and visible.
- Data Safety Center v0 and AI Governance Center v0 are usable.
- OpenAI-compatible adapter is policy-gated.
- hash-chain audit verifier passes.
- renderer cannot access local privileged resources.
- critical/high security findings are fixed before release.
- unresolved medium security findings have documented risk acceptance.
- any secret leakage, policy bypass, audit tamper verification failure, or cloud-call ledger mismatch blocks release.

### Beta Gate

Beta can be called complete only when:

- M3 episodic memory is source-linked and automatically written only as run summaries.
- semantic/procedural memory requires user confirmation.
- memory edit, delete, tombstone, access policy, and memory audit flows pass tests.
- Data Safety Center lists memory and embedding index assets.
- 3-agent Pipeline is bounded, cancellable, and audited.
- Pipeline per-step policy, route, model, tool, citation, risk, and audit evidence is visible.
- local recipes can be saved and reused.
- redaction preview is usable and audited.
- audit export works.
- LocalCommandAgentAdapter read-only mode is supervised and audited.
- LocalCommandAgentAdapter workdir, stdout/stderr transcript, input/output hash, cancellation, and denied write attempts are tested.

### v1.0 Gate

v1.0 can be called complete only when:

- Agent Group is the main work surface.
- Pipeline, Parallel, and Debate modes are implemented.
- Parallel and Debate modes are bounded and audited.
- self-building organization requires user confirmation.
- recipe recommendation, approval/rejection, agent add, and workflow save are audited.
- A2A bridge maps external task to internal run and returns final artifact/result.
- MCP integrations are disabled by default and work only through manifest, permission, policy, route decision, and audit.
- at least one external local agent adapter family is evaluated and graded with declared audit level, permission limits, and visible control limitations.
- multi-workspace policy behavior is tested.
- Data Safety Center covers memory, embedding index, recipe, agent group, artifact, MCP, A2A, and local agent adapter assets.
- AI Governance Center covers Agent Group runs, per-step risk, memory approvals, self-building approvals, local agent incidents, MCP/A2A incidents, and adapter audit levels.
- packaged app update path is reliable.

Detailed Beta/v1 release gates are defined in [08 Memory, Agent Group, Recipes, and Interop Requirements](08-memory-agentgroup-recipes-v1-requirements.md).

## 12. CI Expectations

Alpha SHOULD run in CI:

- typecheck.
- lint.
- unit tests.
- integration tests with mocked providers.
- audit verifier tests.
- UI component tests.

Desktop E2E MAY run in a separate workflow if CI environment constraints make it expensive.

## 13. Anti-Patterns

MUST NOT release with:

- demo-only hard-coded workspace ids.
- hard-coded cloud-call count.
- route decision only in memory.
- audit events without hash verification.
- direct renderer access to secrets or SQLite.
- cloud adapter callable before policy.
- undocumented safety limitations.
- UI that hides blocked reasons.
- tests that pass only by mocking the entire product path.
