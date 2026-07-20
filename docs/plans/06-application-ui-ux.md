# 06 Application UI and UX

> Layer: desktop product experience
>
> Phase coverage: Alpha required, Beta/v1 extensions noted
>
> Depends on: [01 Desktop Runtime Foundation](01-desktop-runtime-foundation.md), [05 Model and Agent Orchestration](05-model-agent-orchestration.md)

## 1. Goal

Build an Ogra Desktop UI that makes local-first execution, routing, data safety, and audit evidence visible in normal workflows.

The UI must not feel like a generic chat app with a shield icon. The first usable surface should communicate:

- current workspace.
- local knowledge state.
- active data classification.
- route decision.
- model/agent used.
- cloud-call status.
- audit/risk evidence.

## 2. Design Direction

Ogra is a professional desktop workbench for sensitive local knowledge. The UI SHOULD be:

- dense enough for repeated work.
- calm and technical.
- scannable.
- explicit about risk and route state.
- restrained in color and motion.

The design SHOULD avoid:

- marketing hero layout as the app first screen.
- decorative gradients/orbs.
- oversized cards inside cards.
- vague AI chat branding.
- hiding governance details behind only settings.

## 3. Primary Navigation

Alpha MUST include these top-level surfaces:

1. Workspace
   - current workspace selector.
   - workspace classification.
   - local folder/knowledge import.
   - workspace overview.

2. Run Workspace
   - task input.
   - answer stream/result.
   - citations.
   - route status.
   - audit shield / route trace.
   - run lifecycle timeline.
   - context sources panel.
   - model call ledger.
   - run history/detail split view.

3. Knowledge
   - knowledge bases.
   - indexing status.
   - file counts.
   - classification.
   - recent retrievals.

4. Data Safety Center
   - data asset map.
   - classification summary.
   - provider/model allowlist.
   - recent Ogra-managed cloud calls.
   - `0 Ogra-managed cloud calls` explanation.

5. AI Governance Center
   - run risk summaries.
   - approvals.
   - incidents.
   - policy registry.
   - model/provider registry.

Alpha MAY implement Data Safety and AI Governance as tabs in one Safety/Governance area, but their responsibilities must be visually and architecturally distinct.

## 4. Workspace UX

Alpha MUST support:

- create workspace.
- select workspace.
- set workspace type: personal/project/company.
- set default data classification.
- view workspace isolation note.
- view active policies.

Workspace overview MUST show:

- knowledge bases.
- agents available in this workspace.
- memory status placeholder.
- active policies.
- default local/cloud model status.
- recent runs.
- recent risk and incident summary.
- recent Ogra-managed cloud-call summary.
- indexing health.

Workspace switching MUST reset active run context unless user explicitly carries data across workspaces. Cross-workspace sharing is not required for Alpha.

## 5. Knowledge Import UX

Alpha import UI MUST include:

- folder picker button.
- selected folder display with privacy-conscious truncation.
- classification selector.
- file type preview.
- excluded file count and reasons.
- import confirmation.
- indexing progress.
- cancel indexing.
- reindex action.
- indexing warnings.

The UI MUST make classification inheritance visible:

```text
Folder classification: Confidential
Files inherit: Confidential
Chunks inherit: Confidential snapshot at index time
```

## 6. Run Workspace UX

Alpha run UI MUST include:

- task input.
- selected workspace.
- selected model or automatic policy selection indicator.
- run status.
- answer.
- citation list.
- route decision summary.
- cloud call count.
- risk level.
- audit shield or evidence button.
- stage timeline: created, retrieval, policy checks, route decision, risk classification, approval/redaction if any, model call, final output, audit complete.
- context sources panel with retrieved/selected/local/cloud/blocked states.
- model call ledger for the run.
- output/artifact location.
- cancel and timeout state.
- interrupted/recovering/unknown-outcome state when applicable.
- recovery decision summary and whether user action is required.
- run history and detail split view.

Alpha SHOULD structure the single InternalAgent run as steps/participants/trace so the surface can evolve into Agent Group Board without a full rewrite.

When policy downgrades or blocks a run, UI MUST show:

- what happened.
- why.
- which classification caused it.
- which policy matched.
- what user can do next.

Example:

```text
Route: Local only
Reason: Confidential source retrieved from Finance Q2 folder.
Model: qwen via Ollama
Cloud calls: 0 Ogra-managed calls
Audit: recorded
```

## 7. Route Trace Viewer

Alpha MUST provide a route trace viewer for each run.

It MUST show:

- task id/run id.
- route.
- high-water classification.
- matched policy.
- reasons.
- local steps.
- cloud steps.
- approval status.
- model calls.
- retrieved sources.
- redaction status.
- owning frame/effect status for externally visible actions.
- recovery/repair events, revision checks, and external receipt evidence when a
  run was interrupted.
- audit event ids.

Route Trace MUST use an ordered timeline with step detail. It must show the sequence of policy checks, retrieval, context assembly, model calls, approval/redaction decisions, and audit events, not only a flat field list.

The route trace viewer MUST distinguish:

- no cloud call was needed.
- cloud call was blocked.
- cloud call happened through Ogra-controlled adapter.
- Ogra cannot prove activity outside Ogra-controlled adapters.

## 8. Citation UX

Every RAG answer MUST show citations with:

- file name.
- snippet.
- line range or offset.
- classification badge.
- retrieval method.
- context destination: local, cloud, blocked, not sent.

Citation expansion MUST NOT reveal excessive file path detail by default.

## 9. Data Safety Center v0

Alpha Data Safety Center MUST show:

- workspace assets grouped by classification.
- knowledge bases and folders.
- file/chunk counts.
- inheritance source.
- recent access.
- recent cloud-context inclusion.
- model/provider allowlist.
- cloud provider permission status.
- recent Ogra-managed cloud calls.
- explicit `0 Ogra-managed cloud calls` scope.

Alpha Data Safety Center MUST let users:

- adjust classification with audit event.
- inspect inheritance source.
- inspect associated policy.
- open recent access/cloud inclusion evidence.
- manage model allowlist/provider permission for the workspace.
- jump from an asset to related route traces and governance records.

Required copy near cloud-call count:

```text
Ogra can prove calls made through Ogra-controlled adapters. This does not cover manual copy/paste, screenshots, tools launched outside Ogra, provider-side retention after approved calls, or other local processes.
```

## 10. AI Governance Center v0

Alpha AI Governance Center MUST show:

- recent runs.
- risk level.
- risk reasons.
- required approvals.
- approval status.
- policy evaluations.
- incidents.
- model/provider registry.
- audit evidence export entry point.

Alpha AI Governance Center MUST let users:

- open incident detail.
- review approval history.
- deny or approve supported approval requests.
- inspect policy evaluation input/output.
- preview audit evidence export.
- review risk exception scope when exceptions exist.

Run risk detail MUST include:

- data classification.
- cloud provider/model use.
- memory access.
- tool/agent permission requests.
- prompt injection warnings.
- blocked or approved exceptions.

Alpha MUST NOT claim ISO, EU AI Act, or enterprise certification compliance.

## 11. Provider and Model Settings

Alpha MUST support:

- Ollama base URL and model.
- OpenAI-compatible endpoint.
- masked API key add/update/delete.
- connection test.
- provider metadata display.
- locality flag: local or cloud.
- retention/training/region/ZDR metadata fields when known.

Connection tests and secret changes MUST create audit events.

## 12. Approval UX

Alpha MUST support approval UI when a run requires approval.

Approval UI MUST show:

- requested action.
- affected data classification.
- payload summary/hash, not raw sensitive payload by default.
- provider/model.
- redaction status.
- expiry/scope when relevant.
- approve/deny.

Confidential cloud upload MUST default to blocked until the full
Approve-then-Egress requirements are satisfied. The approval UI MUST show the
sanitized preview/diff, payload fingerprint, redaction rule version, provider,
scope, and expiry. A changed payload, rule version, policy scope, or target
revision invalidates the approval and requires a new decision.
Restricted cloud upload MUST be blocked.

## 13. Error and Empty States

Alpha MUST include clear states for:

- no workspace.
- no knowledge base.
- no indexed files.
- local model unavailable.
- provider key missing.
- policy blocked.
- no citations found.
- indexing failed.
- audit unavailable.

Errors MUST provide next action without exposing secrets or raw payloads.

First-run activation MUST guide users through:

```text
create workspace
  -> import folder
  -> classify as Confidential
  -> configure or verify Ollama
  -> run demo query
  -> open trace and audit evidence
```

## 14. Beta UX

Beta MUST add:

- M3 Memory Center.
- 3-agent Pipeline board.
- recipe save/reuse flow.
- redaction diff preview.
- audit export workflow.
- local model management.
- read-only local command agent permission prompts.

Beta MUST introduce an Agent Group Board information architecture for Pipeline:

- participants lane.
- step timeline.
- intermediate outputs.
- per-step route and policy checks.
- pause/cancel/force summarize controls.

## 15. v1.0 UX

v1.0 MUST add:

- Parallel and Debate Agent Group modes.
- user-confirmed self-building organization.
- A2A/MCP permission surfaces.
- multi-workspace policy comparison.
- external local agent adapter control surfaces.
- recipe library.
- local agent adapter registry.
- memory, embedding index, recipe, agent group, artifact, MCP, and A2A asset pages in Data Safety Center.

The Tool/MCP surfaces MUST implement plan 11 governance rather than a generic
connector toggle:

- registry and immutable version/schema inspection;
- workspace binding, data scope, effect/risk class, auth scope summary, and
  actual isolation/recovery grade;
- permission prompt bound to exact tool version, sanitized argument/target
  summary, destination, effect class, expiry, and reconciliation capability;
- schema-change review/reapproval, connection health, disable/revoke, unknown
  outcome, quarantine, and incident states;
- invocation drilldown from run/frame/effect through receipt and ingress finding.

Renderer IPC may list, inspect, enable/disable, manage grants, approve, and read
evidence. It MUST NOT expose a generic `tool.invoke` or accept renderer-supplied
workspace, transport, server, secret, or approval identifiers for execution.

Parallel and Debate modes MUST reuse the same bounded run timeline, participant, route trace, and audit evidence model.

Detailed Beta/v1 UI acceptance is defined in [08 Memory, Agent Group, Recipes, and Interop Requirements](08-memory-agentgroup-recipes-v1-requirements.md).

## 16. Acceptance Criteria

Alpha is accepted when:

- User can complete the handbook demo path without using dev tools.
- Workspace, Knowledge, Run, Data Safety, and Governance surfaces are reachable.
- Route status is visible before or during model execution, not only after answer text.
- Every answer can expand route trace and audit evidence.
- Data Safety Center derives cloud-call count from model call ledger.
- AI Governance Center shows risk summary for the same run.
- Citation UI shows file, snippet, classification, retrieval method, and context destination.
- Run Workspace shows lifecycle timeline, context sources, model call ledger, cancellation state, and run detail.
- Interrupted runs visibly distinguish recovering, unknown outcome,
  awaiting-user-decision, resumed, and failed-closed states; the UI links the
  recovery decision to frame/effect/audit evidence.
- Workspace overview shows knowledge health, recent runs, risk/cloud summary, active policies, and model status.
- Knowledge surface supports browsing, retrieval testing, chunk inspection, warnings, and reindex job review.
- Data Safety Center supports classification changes and policy/allowlist evidence drilldown.
- Governance Center supports incident detail, approval history, policy evaluation detail, and audit export preview.
- Provider key values never appear in renderer-visible state, logs, or errors.
- UI tests cover downgraded, blocked, local-only, Public cloud-allowed, and no-source states.

## 17. Anti-Patterns

MUST NOT introduce:

- a chat-only first screen with no safety/governance context.
- hard-coded `0 cloud calls`.
- vague "secure" claims without evidence.
- hidden classifications.
- approvals that hide payload scope.
- a generic retry button that can replay an `unknown` effect without
  reconciliation and typed verification.
- UI that implies M3 Memory can prove an external outcome or authorize recovery.
- route trace available only in logs.
- settings-only provider risk metadata.
- UI copy implying Ogra controls non-Ogra network activity.
