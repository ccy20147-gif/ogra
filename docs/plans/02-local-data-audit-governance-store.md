# 02 Local Data, Audit, and Governance Store

> Layer: local persistence and evidence
>
> Phase coverage: Alpha required, Beta/v1 extensions noted
>
> Depends on: [01 Desktop Runtime Foundation](01-desktop-runtime-foundation.md)

## 1. Goal

Build the local SQLite-backed storage layer that makes Ogra auditable, explainable, and local-first.

This layer is not just CRUD persistence. It is the evidence substrate for:

- workspace isolation.
- knowledge source provenance.
- route decisions.
- policy evaluations.
- model/provider usage.
- cloud-call counts.
- run risk summaries.
- audit exports.

## 2. Storage Principles

Alpha MUST use SQLite as the primary local store.

The database MUST:

- live under the Ogra app data directory.
- be accessed only by Ogra Core/Edge services.
- use migrations with schema version tracking.
- enable foreign keys.
- support SQLite FTS5 for text retrieval.
- store audit events append-only.
- include hash-chain fields for run events.

The database MUST NOT:

- be read directly by renderer code.
- store raw provider secrets.
- silently delete run evidence.
- treat audit logs as ordinary mutable rows.

## 3. Alpha Schema Requirements

### 3.1 Workspace and Data Assets

Alpha MUST include:

```text
workspaces
  id
  name
  type: personal | project | company
  default_data_classification
  created_at
  updated_at

knowledge_bases
  id
  workspace_id
  name
  root_path
  classification
  indexing_status
  last_indexed_at
  created_at
  updated_at

documents
  id
  workspace_id
  knowledge_base_id
  file_path
  file_name
  extension
  content_hash
  size_bytes
  classification
  classification_source
  source_trust_level
  indexed_at

document_chunks
  id
  document_id
  workspace_id
  content
  content_hash
  source_start_offset
  source_end_offset
  classification_snapshot
  parser_version
  chunker_version
  allowed_for_context
```

`document_chunks` MUST have an FTS5-backed search path. If implementation uses a separate virtual table, it MUST preserve mapping back to `document_chunks.id`.

### 3.2 Runs and Route Decisions

Alpha MUST include:

```text
agent_runs
  id
  workspace_id
  task
  status
  started_at
  completed_at
  final_output_location

route_decisions
  id
  run_id
  route: local | cloud | hybrid | blocked
  data_classification
  high_water_sources_json
  reason_json
  local_steps_json
  cloud_steps_json
  requires_user_approval
  approval_id
  policy_evaluation_id
  audit_event_id
  provider_id
  model_id
  cloud_payload_summary
  cloud_payload_hash
  incident_ids_json
  created_at
```

Route decisions MUST be stored even when a run is blocked.

### 3.3 Audit Events

Alpha MUST include append-only run events:

```text
run_events
  id
  run_id
  workspace_id
  sequence
  event_type
  event_payload_json
  payload_hash
  previous_hash
  event_hash
  policy_version_hash
  redaction_rule_version
  created_at
```

Hash-chain requirements:

- `sequence` MUST be monotonic per run.
- `previous_hash` MUST point to the previous event hash for the same run, or a genesis value.
- `event_hash` MUST be derived from stable event fields using SHA-256 over canonical JSON.
- canonical JSON MUST use deterministic key ordering and stable timestamp representation.
- genesis `previous_hash` MUST use a documented constant.
- `(run_id, sequence)` MUST be unique.
- event append and hash calculation MUST happen in one transaction.
- event updates MUST NOT mutate prior event content.
- audit deletion/export/cleanup actions MUST add new events.
- an audit verifier MUST be able to recompute the chain.

Alpha does not need to claim compliance-grade non-repudiation. It does need local tamper-evident evidence.

### 3.4 Policy and Approval Records

Alpha MUST include:

```text
policies
  id
  workspace_id
  name
  version
  source
  content_yaml
  content_hash
  enabled
  created_at

policy_evaluations
  id
  run_id
  policy_id
  input_snapshot_json
  result_json
  matched_rules_json
  created_at

approvals
  id
  run_id
  approval_type
  requested_scope_json
  decision: approved | denied | expired
  decided_by
  reason
  expires_at
  created_at
  decided_at
```

Alpha can use a single local user identity, but approval records MUST still exist to support future governance.

### 3.5 Models and Providers

Alpha MUST include:

```text
model_providers
  id
  kind: ollama | openai_compatible
  name
  endpoint
  is_local
  data_retention_policy
  training_opt_out
  region
  zero_data_retention_supported
  supports_streaming
  supports_tool_calling
  enabled

models
  id
  provider_id
  name
  display_name
  modality
  local_only
  enabled

model_calls
  id
  run_id
  status
  adapter_kind
  provider_id
  model_id
  route_decision_id
  approval_id
  is_cloud
  prompt_hash
  request_payload_hash
  uploaded_payload_hash
  redaction_rule_version
  response_hash
  error_code
  error_message
  token_usage_json
  started_at
  completed_at
```

Raw API keys MUST be stored outside SQLite through the secret broker. SQLite MAY store secret metadata only.

### 3.6 Governance and Incidents

Alpha MUST include:

```text
run_risk_summaries
  id
  run_id
  risk_level: low | medium | high | blocked
  risk_reasons_json
  required_approvals_json
  status
  created_at

incidents
  id
  workspace_id
  run_id
  incident_type
  severity
  summary
  evidence_event_ids_json
  status
  created_at
  resolved_at
```

Alpha MUST create incident records for:

- policy block.
- cloud call denied.
- prompt injection warning.
- tool or permission request denied.

### 3.7 Memory Placeholder

Alpha MUST include enough schema for episodic run summaries:

```text
memories
  id
  workspace_id
  type: episodic | semantic | procedural
  content
  source_run_id
  source_event_ids_json
  confidence
  user_confirmed
  scope
  created_at
  deleted_at
```

Alpha MUST NOT silently write semantic or procedural memory.

Beta/v1 MUST replace this placeholder with the full M3 memory tables and memory access events defined in [08 Memory, Agent Group, Recipes, and Interop Requirements](08-memory-agentgroup-recipes-v1-requirements.md).

### 3.8 Run Evidence Tables

Alpha MUST include structured evidence tables instead of relying only on JSON event payloads:

```text
run_participants
  id
  run_id
  agent_id
  adapter_kind
  role
  audit_level

document_access_events
  id
  run_id
  workspace_id
  document_id
  chunk_id
  access_type: retrieved | selected_for_context | included_in_local_prompt | included_in_cloud_payload | redacted | blocked | excluded
  classification_snapshot
  policy_evaluation_id
  route_decision_id
  model_call_id
  payload_hash
  created_at

run_context_sources
  id
  run_id
  document_id
  chunk_id
  lifecycle_state: retrieved | selected | local_context | redacted | cloud_context | blocked | excluded
  retrieval_method
  score
  source_start_offset
  source_end_offset
  source_line_start
  source_line_end
  classification_snapshot
  cloud_payload_hash
  created_at

tool_calls
  id
  run_id
  agent_id
  tool_name
  requested_scope_json
  decision: allowed | denied | blocked
  policy_evaluation_id
  approval_id
  input_hash
  output_hash
  created_at

redaction_records
  id
  run_id
  model_call_id
  rule_version
  rule_set_id
  before_hash
  after_hash
  summary
  residual_risk
  user_confirmed
  user_confirmed_at
  approval_id
  created_at
```

### 3.8.1 Redaction Rule Sets and Versions

Alpha MUST include queryable, version-stamped redaction rule sets so the audit chain and Data Safety Center can show which rules applied to a given model call:

```text
redaction_rule_sets
  id
  name
  description
  created_at
  enabled

redaction_rule_versions
  id
  rule_set_id
  version
  rules_json
  content_hash
  parent_version
  created_at
```

The active redaction rule version MUST be recorded in `redaction_records.rule_version` and in the corresponding `run_events` and `model_calls` rows.

### 3.8.2 Egress Mode and Re-Sanitize Iterations

Alpha MUST record the egress mode chosen for each cloud call and the iteration history of any re-sanitize loop:

```text
egress_records
  id
  run_id
  model_call_id
  route_decision_id
  approval_id
  egress_mode: auto_redact | log_and_proceed | approve_then_egress
  payload_hash
  payload_summary
  redaction_rule_version
  payload_classification
  created_at

rejection_resanitize_iterations
  id
  run_id
  approval_id
  iteration_no
  rule_version
  before_hash
  after_hash
  decision: rejected | approved | aborted
  decided_by
  reason
  created_at
```

Each rejection iteration MUST write a new `run_events` row. The loop MUST terminate on `approved` or `aborted` only.

### 3.8.3 Ingress Review Findings and Quarantine

Alpha MUST include first-class tables for the independent Ingress Review Agent so findings, severity, and isolation status are queryable:

```text
ingress_review_findings
  id
  run_id
  source_kind: cloud_response | tool_output | a2a_message | mcp_result | local_agent_stdout
  source_ref
  pattern_id
  layer: regex | semantic | combined
  evidence
  evidence_hash
  severity: info | suspicious | malicious
  finding_class: clean | suspicious | malicious
  ingress_mode: auto_filter | log | approve
  user_decision: approved | denied | pending
  decided_by
  created_at
  decided_at

quarantine_contents
  id
  run_id
  ingress_finding_id
  content_hash
  summary
  stored_blob_path
  classification
  user_can_view: true | false
  status: quarantined | cleaned | discarded | released
  created_at
  updated_at
```

Quarantined content MUST be persisted under a path that renderer code cannot read directly. Renderer access MUST go through the policy-gated `quarantine.read` IPC, and only when the user has been notified of the risk.

### 3.8.4 Skills Registry

Alpha MUST include a registry for built-in and local-recipe skills so manifest, version pinning, and per-invocation audit are persistent:

```text
skills
  id
  name
  version
  description
  capability_tags_json
  runtime: local | cloud | hybrid
  entrypoint: prompt | code | agent_group
  source: builtin | local_recipe
  trust_level: verified | user_trusted
  manifest_json
  content_hash
  enabled
  created_at
  updated_at

skill_invocations
  id
  run_id
  skill_id
  skill_version
  input_hash
  output_hash
  policy_evaluation_id
  approval_id
  model_call_id
  created_at
```

### 3.8.5 Scheduled and Continuous Agent Group Runs

Alpha MUST include tables for interval and continuous Agent Group scheduling so lifecycle, bounds, and audit are persistent:

```text
scheduled_runs
  id
  workspace_id
  agent_group_id
  schedule_kind: interval | continuous
  schedule_expr
  task_template
  max_iterations
  max_total_duration_ms
  max_total_tokens
  max_concurrent_runs
  failure_behavior: retry | skip | alert
  notification_policy_json
  enabled
  last_iteration_at
  next_run_at
  created_at
  updated_at

scheduled_run_iterations
  id
  scheduled_run_id
  run_id
  iteration_no
  started_at
  completed_at
  status
  token_usage_json
  duration_ms
  error
```

### 3.8.6 Run Step Actions (ReAct Granularity)

Alpha MUST persist the InternalAgentAdapter's Plan + ReAct iterations so runs can resume after crash or interruption:

```text
run_step_actions
  id
  run_step_id
  action_no
  thought
  action_type: retrieve | generate | delegate | execute | read_file | write_file | ask_user | complete
  action_payload_json
  observation
  observation_hash
  created_at
```

ReAct action persistence MUST be transactional with the corresponding `run_events` row, and recovery MUST resume from the last persisted `action_no` for the in-progress step.

### 3.9 Policy Scopes and Allowlists

Alpha MUST include queryable scope records:

```text
policy_scopes
  id
  policy_id
  workspace_id
  knowledge_base_id
  classification
  provider_id
  model_id
  agent_id
  enabled

classification_model_allowlists
  id
  workspace_id
  classification
  provider_id
  model_id
  allowed

agent_permissions
  id
  workspace_id
  agent_id
  permission_kind
  scope_json
  allowed
```

Alpha uses a single local user and local registries only. These tables MUST NOT imply RBAC, SSO, SaaS tenancy, or centralized compliance.

### 3.10 Long-Term Product Objects

Beta/v1 MUST add first-class tables for:

- `agents`
- `agent_groups`
- `agent_group_members`
- `agent_group_runs`
- `run_steps`
- `messages`
- `artifacts`
- `recipes`
- `workflow_saves`
- `self_build_recommendations`
- `secrets_metadata`
- M3 memory typed tables
- `memory_access_events`

The detailed schema requirements are defined in [08 Memory, Agent Group, Recipes, and Interop Requirements](08-memory-agentgroup-recipes-v1-requirements.md).

### 3.11 Embedding Index Metadata

Beta MUST add queryable embedding index metadata before vector retrieval is considered complete:

```text
embedding_indexes
  id
  workspace_id
  knowledge_base_id
  provider_id
  model_id
  embedding_dim
  index_kind
  is_local
  classification_snapshot
  content_hash
  created_at
  updated_at

embedding_index_chunks
  id
  embedding_index_id
  document_chunk_id
  vector_ref
  source_content_hash
  classification_snapshot
  created_at
```

Embedding indexes MUST be included in Data Safety Center asset maps.

## 4. Data Safety Center Queries

Storage MUST support these Alpha summaries:

- assets by workspace and classification.
- knowledge bases and folders by classification.
- files recently accessed.
- files recently included in model context.
- recent cloud calls through Ogra-controlled adapters.
- runs with `0 Ogra-managed cloud calls`.
- policies associated with workspace and knowledge base.
- agents/models allowed for each data classification.

Beta/v1 summaries MUST also include:

- memory assets and access events.
- embedding index assets.
- agent groups and group runs.
- recipes and workflow saves.
- artifacts.
- local/external agent adapters.
- MCP tools and A2A delegations.

Required read models or equivalent queries:

```text
data_asset_map_view
run_cloud_call_summary_view
recent_document_access_view
classification_policy_scope_view
model_agent_allowlist_view
memory_asset_map_view
embedding_index_asset_view
agent_group_asset_view
recipe_asset_view
adapter_asset_view
```

These read models MUST be backed by structured rows such as `document_access_events`, `run_context_sources`, `model_calls`, `policy_scopes`, `classification_model_allowlists`, and `agent_permissions`.

## 5. AI Governance Center Queries

Storage MUST support:

- recent runs with risk level.
- blocked runs and blocked reasons.
- approval requests and decisions.
- incident list.
- policy evaluation details.
- model/provider registry details.
- exportable run evidence bundle.

Beta/v1 governance MUST also support:

- Agent Group run evidence.
- per-step risk summaries.
- memory approvals and access events.
- recipe/self-building approvals.
- local agent incidents.
- MCP/A2A incidents.
- adapter audit-level registry.

Required read models or equivalent queries:

```text
governance_run_evidence_view
run_risk_summary_view
incident_review_view
approval_history_view
policy_evaluation_detail_view
agent_group_run_evidence_view
run_step_risk_view
memory_governance_view
self_building_governance_view
adapter_governance_view
```

## 6. Migration Requirements

Alpha MUST include:

- migration table.
- deterministic migration order.
- startup migration execution before services are available.
- test coverage that creates a fresh database and validates required tables.
- test coverage for migrating from an empty database to current schema.

Beta SHOULD add:

- backup before destructive migrations.
- export/import diagnostics.
- database integrity check UI.

## 7. Acceptance Criteria

Alpha is accepted when:

- A fresh install creates the full required schema.
- Renderer cannot open or query the database directly.
- Every run creates `agent_runs`, `route_decisions`, `policy_evaluations`, `run_risk_summaries`, and `run_events`.
- `run_events` maintain a verifiable per-run hash chain.
- Hash-chain verifier can recompute canonical SHA-256 event hashes.
- Local model calls and cloud model calls are distinguishable.
- `0 Ogra-managed cloud calls` is derived from `model_calls`, not hard-coded.
- Data Safety Center can list data assets, recent document access, context inclusion, associated policies, allowlists, and cloud-call status.
- AI Governance Center can list risk summaries, incidents, approvals, policy details, and exportable run evidence.
- Deleting or exporting audit data appends an audit event.
- The Alpha fixture demo path creates all rows needed for route trace, citations, cloud-call ledger, Data Safety summary, and Governance summary.

## 8. Anti-Patterns

MUST NOT introduce:

- hard-coded `cloudCalls={0}` as evidence.
- a single JSON blob that hides route/policy/audit data from queries.
- mutable audit rows.
- default `Public` classification when classification is unknown.
- raw prompt/payload persistence by default.
- raw API key storage in SQLite.
- schema names that imply enterprise compliance certification in Alpha.
