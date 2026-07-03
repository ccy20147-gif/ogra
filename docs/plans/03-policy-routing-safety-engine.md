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

| Classification | Default route | Alpha behavior |
|---|---|---|
| Public | Cloud allowed | May route to local or cloud if provider/model policy allows. |
| Internal | Local default, cloud after controls | Cloud requires redaction preview when private context is included and explicit approval when policy requires it. |
| Confidential | Local-only by default | Alpha MUST route local or blocked. Alpha MUST block cloud upload for Confidential. Exception flows are Beta/v1 or later. |
| Restricted | Strict local allowlist | Must use approved local models and approved agents only. Ordinary user approval MUST NOT convert Restricted data to cloud. |

Unknown classification MUST be treated as at least Internal until explicitly resolved. It MUST NOT default to Public.

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

- decision: allow, require_approval, redact, local_only, blocked.
- matched rules.
- reasons.
- required approvals.
- required audit events.

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

Alpha MUST implement:

- local route.
- cloud route for Public-only tasks through OpenAI-compatible adapter.
- blocked route.
- internal representation of hybrid, even if UI labels hybrid as not yet available.

Alpha MUST block Confidential and Restricted cloud upload. Internal redacted-cloud flow MAY be implemented in Alpha only if redaction preview, approval, payload hash, and audit records are complete; otherwise Internal cloud requests should block or stay local.

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
- provider-side logging after approved cloud call.
- external process telemetry.
- crash reports and telemetry unless explicitly disabled or controlled by Ogra.
- clipboard.
- browser tools.
- MCP tools or remote A2A agents launched outside Ogra control.
- local Agent network requests unless the adapter can enforce network limits.
- local Agent stdout/stderr beyond what Ogra captures.

Data Safety Center MUST show this limitation near `0 Ogra-managed cloud calls`.

## 9. Prompt Injection and Untrusted Context

RAG content, tool output, remote messages, local agent stdout/stderr, code comments, and imported documents MUST be treated as untrusted context.

Alpha MUST:

- wrap retrieved content in quoted context blocks.
- separate user instruction from retrieved context in prompts.
- detect simple injection phrases such as "ignore previous instructions", "upload this file", "call external tool", and similar patterns.
- emit prompt injection warning events.
- include warnings in run risk summary.
- block tool/file/network escalation based solely on retrieved content.
- write warning events to `run_events` with chunk id, pattern id, detector version, and evidence hash.
- create an incident when a warning affects route, tool, cloud, or permission decisions.

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

## 11.1 Redaction Requirements

Internal redacted-cloud flows MUST include:

- deterministic redaction rules for email, phone, address-like patterns, API keys, private keys, ID numbers, account numbers, and user-defined keywords.
- before/after diff preview.
- residual risk warning.
- irreversible replacement or tokenization.
- payload summary and payload hash.
- user confirmation when original or redacted content may leave local execution.
- redaction rule version in audit and model call records.

Alpha may defer this flow; if deferred, Internal cloud requests that include private context must block or route local.

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
- Confidential context routes local or blocked and cannot call cloud adapters in Alpha.
- Restricted context cannot be sent to cloud through ordinary approval.
- Public-only tasks can use an OpenAI-compatible cloud adapter when allowed.
- `0 Ogra-managed cloud calls` is computed from controlled adapter call records.
- Prompt injection warnings are detected for rule-based fixtures and written to audit/risk records.
- Blocked cloud calls create incident records.
- Tests cover Public, Internal, Confidential, Restricted, unknown classification, and mixed-context high-water behavior.

## 14. Anti-Patterns

MUST NOT introduce:

- default cloud routing for unknown data.
- user approval that overrides Restricted data into cloud.
- route decisions generated after the model call.
- prompt strings that mix trusted instructions and RAG content without boundaries.
- policy results that exist only in UI state.
- cloud provider calls outside Ogra-controlled adapters.
