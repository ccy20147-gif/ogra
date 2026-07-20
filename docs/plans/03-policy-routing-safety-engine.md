# 03 Policy, Routing, and Safety Engine

> Layer: policy-first execution
>
> Phase coverage: Alpha required, Beta/v1 extensions noted
>
> Depends on: [02 Local Data, Audit, and Governance Store](02-local-data-audit-governance-store.md)

## 1. Goal

Build Ogra's deterministic policy and routing engine so every task is evaluated before data moves into context, model payloads, tools, memory, export, or audit views.

The engine must produce a visible and stored `RouteDecision` for every run:

```json
{
  "run_id": "run_123",
  "task_id": "run_123",
  "route": "local",
  "data_classification": "confidential",
  "reason": ["confidential data detected", "workspace policy forbids cloud upload"],
  "local_steps": ["retrieve", "assemble_context", "generate"],
  "cloud_steps": [],
  "requires_user_approval": false,
  "policy_evaluation_id": "policy_eval_123",
  "policy_version_hash": "sha256:...",
  "approval_id": null,
  "provider_id": "ollama_local",
  "model_id": "qwen",
  "cloud_payload_summary": null,
  "cloud_payload_hash": null,
  "high_water_sources": ["chunk_1"],
  "incident_ids": [],
  "audit_log_id": "audit_123"
}
```

## 2. Classification Semantics

Ogra MUST support four built-in data classifications:

| Classification | Default egress mode (Alpha) | Alpha behavior |
|---|---|---|
| Public | Auto-Filter-then-Egress | May route to local or cloud if provider/model policy allows. No redaction or approval required. |
| Internal (standard) | Auto-Filter-then-Egress | Cloud requires deterministic redaction. No user approval required when redaction is complete and reversible redactors are used. |
| Internal (high-sensitivity) | Log-then-Egress | Egress proceeds after policy evaluation. Full audit record with payload hash and redaction rule version is written. No user approval required. |
| Confidential | Approve-then-Egress (Alpha) | Redaction engine produces a sanitized preview. The preview, the redacted payload, the payload hash, and the redaction rule version MUST be shown to the user. The cloud call proceeds only after explicit user approval. The full preview, approval, and redaction rule version MUST be recorded in audit. |
| Restricted | Blocked | Must use approved local models and approved agents only. Ordinary user approval MUST NOT convert Restricted data to cloud. v1.0 is the earliest phase where any policy-scoped exception could be allowed; Alpha blocks. |

Unknown classification MUST be treated as at least Internal until explicitly resolved. It MUST NOT default to Public. The default for unknown + cloud request is Auto-Filter-then-Egress with conservative redaction rules.

The classification of a run is the high-water mark across: workspace default, knowledge base, retrieved documents and chunks, accessed memories, requested tool outputs, agent manifest risk, and the originating task abstract.

## 3. Policy Execution Points

Policy MUST run at these points:

- before RAG retrieval.
- before context assembly.
- before embedding requests.
- before model invocation.
- before tool invocation.
- before agent delegation.
- before local agent runtime launch.
- before file export.
- before memory write.
- before audit view and audit export.

Each check MUST return:

- decision: allow, require_approval, redact, local_only, blocked, log_and_proceed, auto_redact.
- matched rules.
- reasons.
- required approvals.
- required audit events.

### 3.6 Re-Sanitize Loop

When the policy selects `require_approval` on the Approve-then-Egress tier, the runtime MUST:

1. Run the redaction engine against the egress payload and produce a sanitized preview.
2. Present the preview, payload hash, and redaction rule version to the user.
3. Wait for user decision. If the user approves, the call proceeds and an `egress_records` row is written with `egress_mode = approve_then_egress`.
4. If the user rejects, the runtime MUST:
   - record the rejection in `rejection_resanitize_iterations` with `decision = rejected` and the user's reason (optional annotation).
   - apply a stricter redaction rule version (next version, or user-specified exclusions) and produce a new preview.
   - present the new preview. The loop continues until the user approves or aborts.
5. Each iteration MUST write a new `run_events` row and a new `redaction_records` row with the new rule version and payload hash.
6. The loop MUST terminate on `approved` or `aborted` only. There is no automatic timeout that aborts without user decision.

This is NOT a "deny and block" cycle. It is a "send back for rework" cycle, and every iteration is audited.

## 4. Alpha Policy Inputs

Alpha MUST support deterministic inputs only:

- workspace id.
- workspace default classification.
- knowledge base classification.
- folder/file/chunk classification.
- provider id.
- model id.
- provider locality: local or cloud.
- provider data retention policy.
- provider training opt-out status.
- provider region.
- provider zero data retention support.
- provider file upload/tool calling/streaming-log risk metadata.
- requested operation: retrieve, embed, generate, export, write_memory, view_audit.
- agent id and manifest.
- requested tools.
- requires cloud flag.
- user approval status.

Alpha MUST NOT rely on LLM judgment for sensitive classification.

Beta MAY add heuristic task complexity or local sensitive detectors, but those cannot weaken explicit user classification.

## 5. Policy Representation

Alpha MUST provide built-in default policies and MAY allow YAML editing/import.

Built-in policies MUST include:

```yaml
- name: confidential-local-only
  match:
    data_classification: Confidential
  route:
    allowed_compute: local
    cloud_upload: false

- name: restricted-local-allowlist
  match:
    data_classification: Restricted
  route:
    allowed_compute: local
    allowed_models:
      - local:qwen
      - local:llama
    cloud_upload: false

- name: internal-redacted-cloud
  match:
    data_classification: Internal
    requested_compute: cloud
  route:
    require_redaction_preview: true
    require_user_approval: true
```

Every policy version MUST have a content hash and be linked from policy evaluations and run events.

## 5.1 Policy Priority and Conflict Handling

When multiple policies apply, evaluation MUST use this priority:

1. Restricted and Confidential rules.
2. deny/block rules before allow rules.
3. explicit user disabled-cloud preference.
4. workspace policy.
5. file, folder, and knowledge base policy.
6. tool and Agent permission policy.
7. valid user approval.
8. default local-only or blocked.

No matching policy MUST NOT mean Public or cloud. It MUST fall back to local-only or blocked depending on requested operation.

## 6. Routing Behavior

The router MUST select one of:

- `local`: all execution remains local.
- `cloud`: no private context enters payload and policy allows provider/model.
- `hybrid`: local preprocessing/redaction plus cloud reasoning plus local synthesis.
- `blocked`: policy disallows the run or required approval is missing.

The DEFAULT routing for tasks that touch non-Public data in Alpha is `hybrid`. Pure `local` routing remains available as a high-security option that the workspace policy can pin. The user-visible label and the audit record MUST always state which mode was chosen and why.

Alpha MUST implement:

- local route.
- cloud route for Public-only tasks through OpenAI-compatible adapter.
- blocked route.
- hybrid route with at minimum: local retrieval -> redaction engine -> cloud reasoning -> local synthesis. The redaction engine and the cloud reasoning are different stages, both recorded in the route decision.

Egress mode selection (per data classification, see §2):

- Public and Internal (standard): Auto-Filter-then-Egress (`auto_redact`). Redaction is automatic and deterministic. No user approval.
- Internal (high-sensitivity): Log-then-Egress (`log_and_proceed`). Egress proceeds, full audit record with payload hash and redaction rule version is written. No user approval.
- Confidential: Approve-then-Egress (`require_approval` with re-sanitize loop, §3.6). User MUST approve the sanitized preview before the call proceeds.
- Restricted: Blocked.

Alpha MUST block Restricted cloud upload. Confidential cloud upload is permitted only through the Approve-then-Egress tier with an explicit user approval recorded. Public-only tasks can use an OpenAI-compatible cloud adapter when allowed.

## 7. High-Water Mark

When assembling context, the run classification MUST become the highest classification among:

- workspace default.
- selected knowledge base.
- retrieved documents.
- retrieved chunks.
- accessed memories.
- requested tool outputs.
- agent manifest risk.

High-water mark MUST be recomputed when new context, tools, agents, or memories are added.

## 8. Data Egress Model

Ogra MUST explicitly model controlled and uncontrolled egress paths.

Controlled by Ogra adapters:

- model payloads.
- embedding requests.
- Ogra-managed exports.
- Ogra-managed tool calls.
- Ogra-launched local agent inputs/outputs when adapter supports capture.
- Ogra-managed remote A2A or MCP calls when those features exist.

Not fully controlled by Ogra:

- user copy/paste.
- screenshots.
- OS-level network traffic.
- third-party tools launched outside Ogra.
- provider-side logging after approved cloud call, including the cloud model's internal chain of thought and provider-side tool calls.
- external process telemetry.
- crash reports and telemetry unless explicitly disabled or controlled by Ogra.
- clipboard.
- browser tools.
- MCP tools or remote A2A agents launched outside Ogra control.
- local Agent network requests unless the adapter can enforce network limits.
- local Agent stdout/stderr beyond what Ogra captures.

The product transparency claim MUST be scoped to the Ogra-controlled boundary:

> Ogra records everything that crosses the boundary between your machine and the cloud. It does not — and cannot — record what happens inside the cloud provider's infrastructure after the data arrives. What you send, why you sent it, and what you got back: these are auditable. The model's internal chain of thought: that belongs to the provider.

Data Safety Center MUST show this limitation near any cloud-call count or "0 Ogra-managed cloud calls" badge, and MUST state the egress mode (`auto_redact`, `log_and_proceed`, `approve_then_egress`) for every egress record.

## 9. Prompt Injection and Untrusted Context

RAG content, tool output, remote messages, local agent stdout/stderr, code comments, imported documents, AND every inbound cloud response, external agent message, MCP tool result, and tool return value MUST be treated as untrusted context.

Alpha MUST:

- wrap retrieved content in quoted context blocks.
- separate user instruction from retrieved context in prompts.
- detect simple injection phrases such as "ignore previous instructions", "upload this file", "call external tool", and similar patterns.
- emit prompt injection warning events.
- include warnings in run risk summary.
- block tool/file/network escalation based solely on retrieved content.
- write warning events to `run_events` with chunk id, pattern id, detector version, and evidence hash.
- create an incident when a warning affects route, tool, cloud, or permission decisions.
- run the independent Ingress Review Agent on every inbound cloud response, tool return, A2A message, and MCP result before the local runtime ingests it. The Ingress Review Agent runs in a separate process boundary, uses its own prompt-injection detector, and produces structured findings `{ patternId, evidence, evidenceHash, severity, layer }` that are persisted in `ingress_review_findings`. Clean findings are forwarded to local assembly. Suspicious findings isolate the content in `quarantine_contents` and create an incident. Malicious findings discard the content, create an incident, and notify the user.
- support a three-tier ingress policy analogous to egress: `auto_filter` (apply detector-driven redaction and forward), `log` (forward and write a full review report to audit), `approve` (hold and request user decision before ingest).

The PromptInjectionDetector in Alpha evolves to two layers:

1. A regex layer as a fast pre-filter (low latency, no model cost). This is the current detector.
2. A semantic review layer via a local LLM for suspicious-but-not-certain cases. The semantic layer runs in the Ingress Review Agent, not in the InternalAgentAdapter that assembled the prompt.

Alpha does not need to guarantee complete prompt-injection defense.

## 10. Agent Permission Model

Every agent MUST have a manifest:

```yaml
agent:
  id: internal_agent
  filesystem:
    read: []
    write: []
  network:
    egress: false
  shell: false
  env_secrets: []
  clipboard: false
  browser: false
  mcp_tools: []
  a2a_agents: []
  memory:
    read: []
    write: []
  models:
    allowed: []
```

Alpha InternalAgentAdapter MUST default to:

- no shell.
- no arbitrary network.
- no cross-workspace access.
- no direct secret access.
- read only approved workspace RAG chunks.
- write only run events and optional episodic run summary.

Tool authorization follows
[11 Tool Broker and MCP Integration Runtime](11-tool-broker-mcp-integration-runtime.md).
An Agent may request only `{toolId, arguments}`; policy context derives the
workspace, Agent/frame, immutable tool version, binding revision, server config,
auth generation, destination, data scope, and effect class from Core-owned
state. A missing/empty manifest or missing binding MUST deny a requested tool;
it is not an implicit allowlist.

Tool approval MUST bind the canonical sanitized argument hash, target/data
scope, descriptor/schema hashes, tool and binding versions, effect revision,
policy/redaction revisions, server config revision, and auth audience/scopes.
Any change invalidates the approval. MCP server annotations and tool descriptions
are untrusted inputs and cannot lower Ogra's locally assigned risk/effect class.
Server config/enable/discovery, schema review, and workspace-binding approvals
authorize only those administrative operations. They cannot satisfy a concrete
`tool_invocation` or `recovery_retry` callback approval or consumption record.

## 11. Run Risk Classification

Every run MUST produce:

```json
{
  "run_id": "run_123",
  "risk_level": "medium",
  "risk_reasons": ["internal data included", "cloud model requested"],
  "required_approvals": ["allow_internal_redacted_cloud"],
  "status": "awaiting_user_approval"
}
```

Risk inputs MUST include:

- data classification.
- agent permissions.
- model locality.
- cloud provider metadata.
- tool permissions.
- memory access.
- prompt injection warnings.
- file write/shell/network requests.

Risk classification is an operational signal, not a legal compliance claim.

Incidents MUST be created for policy block, prompt injection warning affecting execution, cloud call blocked, tool denied, permission denied, suspected unauthorized access, and rejected memory write.

Risk exceptions MUST record approver, scope, reason, expiration, linked run, and revocation status.

### 11.1 Redaction Requirements

Internal redacted-cloud flows and Confidential Approve-then-Egress flows MUST include:

- a version-stamped redaction rule set. The active rule version is recorded in `redaction_records.rule_version` and in the corresponding `run_events` and `model_calls` rows.
- deterministic redaction rules for email, phone, address-like patterns, API keys, private keys, ID numbers, account numbers, and user-defined keywords. The rule set MUST be queryable through `redaction_rule_sets` and `redaction_rule_versions`.
- before/after diff preview.
- residual risk warning.
- irreversible replacement or tokenization. The replacement strategy MUST be visible to the user.
- payload summary and payload hash.
- user confirmation when original or redacted content may leave local execution. For the Approve-then-Egress tier, user approval MUST be explicit and recorded.
- redaction rule version in audit, model call records, and egress records.
- on user rejection, a re-sanitize loop (see §3.6) that re-runs the redaction engine with a stricter rule version or user-specified exclusions and presents a new preview.

### 11.2 Ingress Review and Quarantine

The Ingress Review Agent MUST:

- run in a separate process boundary from the InternalAgentAdapter.
- be invoked for every cloud response, tool return, A2A message, and MCP result before the local runtime ingests it.
- produce structured findings `{ patternId, evidence, evidenceHash, severity, layer }` persisted in `ingress_review_findings`.
- classify each finding as `clean`, `suspicious`, or `malicious`.
- on `clean`: forward the content to local assembly. A `log` ingress record is written.
- on `suspicious`: isolate the content in `quarantine_contents`, create an incident, and request user review. The `quarantine.read` IPC exposes a restricted sandbox view; the user is shown a sanitize summary, not the raw malicious content.
- on `malicious`: discard the content, create an incident, and notify the user. The user may request a "clean and proceed" attempt that strips the injection while preserving legitimate content; the attempt is itself audited.

The same three-tier ingress policy applies:

- `auto_filter`: detector-driven redaction strips flagged content; the cleaned payload is forwarded. Used for low-risk sources.
- `log`: content is forwarded; full review report is written to audit. Used for medium-risk sources.
- `approve`: content is held; user MUST decide before ingest. Used for high-risk sources or per-source policy override.

## 12. Policy Simulator

Alpha SHOULD include a basic dry-run API:

```text
simulatePolicy(input) -> route, blocked_reasons, required_approvals, cloud_payload_summary
```

UI MAY expose the simulator in Data Safety or Governance Center after the core run path works.

## 13. Acceptance Criteria

Alpha is accepted when:

- Every run has a stored policy evaluation and route decision.
- Policy checks run before retrieval, context assembly, embedding, model invocation, tool invocation, agent delegation, local agent launch, file export, memory write, audit view, and audit export.
- The default route for non-Public tasks is hybrid. Pure local remains available as a high-security workspace policy override.
- The egress mode is selected from the data classification per §2, and is recorded in `egress_records` with payload hash and redaction rule version.
- Confidential cloud upload is permitted only through the Approve-then-Egress tier with an explicit user approval of the sanitized preview; the full preview, approval, and redaction rule version are recorded in audit.
- Restricted context cannot be sent to cloud through ordinary approval.
- Public-only tasks can use an OpenAI-compatible cloud adapter when allowed.
- The Ingress Review Agent runs in a separate process boundary from the InternalAgentAdapter, produces structured findings, and writes them to `ingress_review_findings`. Suspicious or malicious findings land in `quarantine_contents` with an incident.
- The re-sanitize loop terminates only on `approved` or `aborted`, and every iteration is audited in `rejection_resanitize_iterations`.
- `0 Ogra-managed cloud calls` is computed from controlled adapter call records, with the egress mode shown alongside.
- Prompt injection warnings are detected for rule-based fixtures and written to audit/risk records.
- Blocked cloud calls create incident records.
- Tests cover Public, Internal (standard), Internal (high-sensitivity), Confidential, Restricted, unknown classification, and mixed-context high-water behavior.

## 14. Anti-Patterns

MUST NOT introduce:

- default cloud routing for unknown data.
- user approval that overrides Restricted data into cloud.
- route decisions generated after the model call.
- prompt strings that mix trusted instructions and RAG content without boundaries.
- policy results that exist only in UI state.
- cloud provider calls outside Ogra-controlled adapters.
