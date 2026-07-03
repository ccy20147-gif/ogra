# 08 Memory, Agent Group, Recipes, and Interop Requirements

> Layer: Beta/v1 product completeness
>
> Phase coverage: Beta required, v1.0 required
>
> Depends on: [02 Local Data, Audit, and Governance Store](02-local-data-audit-governance-store.md), [05 Model and Agent Orchestration](05-model-agent-orchestration.md), [06 Application UI and UX](06-application-ui-ux.md)

## 1. Goal

Close the gap between Alpha's trusted core loop and the handbook's full Ogra Desktop product definition.

This document turns the Beta/v1 roadmap items into hard requirements for:

- M3 white-box memory.
- Agent Group as the main work surface.
- reusable recipes and human-confirmed self-building organization.
- Local Agent Control Plane beyond InternalAgentAdapter.
- A2A-compatible bridge.
- safe MCP tool access.
- Data Safety coverage for memory and embedding indexes.
- Beta/v1 release gates.

## 2. Required Data Model Extensions

Beta/v1 MUST extend the local store with these first-class objects:

```text
agents
  id
  workspace_id
  name
  adapter_kind
  manifest_json
  capability_matrix_json
  audit_level
  enabled
  created_at
  updated_at

agent_groups
  id
  workspace_id
  name
  mode: pipeline | parallel | debate
  description
  default_policy_id
  max_rounds
  max_tokens
  max_duration_ms
  created_at
  updated_at

agent_group_members
  id
  agent_group_id
  agent_id
  role
  step_order
  permissions_snapshot_json

agent_group_runs
  id
  workspace_id
  agent_group_id
  mode
  task
  status
  high_water_classification
  started_at
  completed_at

run_steps
  id
  run_id
  agent_group_run_id
  step_index
  agent_id
  role
  status
  input_hash
  output_hash
  route_decision_id
  policy_evaluation_id
  model_call_id
  started_at
  completed_at

messages
  id
  run_id
  step_id
  sender_agent_id
  role
  content_hash
  content_summary
  classification_snapshot
  created_at

artifacts
  id
  workspace_id
  run_id
  step_id
  artifact_type
  storage_ref
  content_hash
  classification
  source_event_ids_json
  created_at

recipes
  id
  workspace_id
  name
  description
  required_capabilities_json
  agent_group_template_json
  policy_requirements_json
  source
  trusted
  created_at
  updated_at

workflow_saves
  id
  workspace_id
  source_run_id
  recipe_id
  agent_group_id
  saved_by
  created_at

self_build_recommendations
  id
  run_id
  workspace_id
  missing_capability
  candidate_recipe_ids_json
  candidate_agent_ids_json
  rationale
  decision: pending | accepted | rejected
  decided_at

secrets_metadata
  id
  provider_id
  display_name
  masked_value
  secret_store_ref
  created_at
  updated_at
  last_used_at
```

All objects that can influence a run MUST link back to run events, policy evaluations, and route decisions when used.

## 3. M3 Memory Requirements

Beta MUST implement M3 Memory Center.

### 3.1 Memory Types

The memory store MUST support:

```text
episodic_memories
  id
  workspace_id
  event_summary
  occurred_at
  participating_agent_ids_json
  source_run_id
  source_file_ids_json
  source_route_decision_id
  source_event_ids_json
  confidence
  scope
  created_at
  deleted_at

semantic_memories
  id
  workspace_id
  subject
  relation
  object
  source_run_id
  source_file_ids_json
  source_route_decision_id
  confidence
  user_confirmed
  scope
  created_at
  updated_at
  deleted_at

procedural_memories
  id
  workspace_id
  task_type
  recommended_agent_group_id
  toolchain_json
  route_policy_id
  failure_notes
  source_run_id
  user_confirmed
  scope
  created_at
  updated_at
  deleted_at

memory_access_events
  id
  run_id
  memory_id
  memory_type
  access_type: read | proposed_write | confirmed_write | edited | deleted | denied
  policy_evaluation_id
  route_decision_id
  created_at
```

### 3.2 Memory Rules

Beta MUST:

- automatically write only episodic run summaries.
- require explicit user confirmation before semantic or procedural memory write.
- show source run, source files, route decision, confidence, and scope for every memory.
- allow users to edit and delete memories.
- preserve tombstone records for deleted memories.
- enforce memory read/write policy before injection into any run.
- include memory access in run risk classification.
- include memory assets in Data Safety Center.

MUST NOT:

- silently write high-impact semantic/procedural memory.
- inject all memories into all agents by default.
- create source-less memory.
- make memory undeletable.

## 4. Agent Group Requirements

Agent Group is the main v1.0 work surface.

### 4.1 Beta Pipeline

Beta MUST implement bounded 3-agent Pipeline mode.

Pipeline MUST support:

- configurable agents and roles.
- step order.
- max steps.
- max tokens.
- max duration.
- pause.
- cancel.
- force summarize.
- visible intermediate outputs.
- per-step policy checks.
- per-step route decisions.
- per-step model/tool evidence.
- per-step audit events.

### 4.2 v1.0 Parallel and Debate

v1.0 MUST implement:

- Parallel mode.
- Debate mode.

Parallel MUST show:

- agents running against the same task/context.
- per-agent sources, model calls, tool calls, and route decisions.
- convergence/merge step.

Debate MUST show:

- position agents.
- judge/reviewer agent.
- argument rounds.
- max rounds.
- final synthesis.
- route/audit evidence for every round.

All modes MUST be bounded, cancellable, auditable, and policy-aware.

## 5. Recipes and Self-Building Organization

v1.0 MUST implement human-confirmed self-building organization.

### 5.1 Recipe Requirements

Recipes MUST define:

- task type.
- required capabilities.
- recommended agents.
- allowed tools.
- route policy requirements.
- data classification compatibility.
- audit expectations.
- reusable workflow template.

Recipes MUST be local-first in v1.0. No automatic marketplace download is required.

### 5.2 Self-Building Flow

The Coordinator MUST:

1. analyze capability gaps.
2. search local recipes and agents.
3. recommend 1-3 candidate agents or recipes.
4. show rationale, permissions, data access, and risk.
5. require user confirmation.
6. record approval or rejection.
7. add selected agent to current group.
8. write route/audit events.
9. allow saving the resulting workflow as a recipe.

MUST NOT:

- auto-install unknown plugins.
- auto-run GitHub code.
- auto-enable shell.
- auto-grant high-sensitivity data access.
- recruit across workspaces without confirmation.

## 6. Local Agent Control Plane Requirements

Beta MUST implement read-only `LocalCommandAgentAdapter`.

Beta adapter MUST:

- run under supervised launcher.
- restrict workdir.
- disable shell write actions by default.
- capture process start/stop.
- capture stdout/stderr transcript.
- hash input and output.
- write Level 1 audit events.
- support cancellation.

v1.0 MUST implement graded evaluation for at least one external local agent adapter family, such as Codex, Claude Code, Aider, Open Interpreter, Hermes, or A2A-compatible local agent.

Every external adapter MUST declare:

- capabilities.
- audit level.
- file/network/shell enforcement support.
- artifact support.
- cancellation support.
- known control limitations.

Ogra MUST label what it can and cannot control for each adapter.

## 7. A2A and MCP Requirements

v1.0 MUST implement an A2A-compatible bridge and safe MCP tool access.

### 7.1 A2A Bridge

v1.0 A2A bridge MUST support:

- mapping A2A task to internal Ogra run.
- returning final artifact/result.
- preserving Ogra route metadata as extension metadata.
- policy check before delegation.
- audit record for inbound and outbound delegation.
- blocked/error semantics.

Streaming, complex auth delegation, and complex artifact negotiation MAY be phased after the minimal bridge.

### 7.2 MCP Tool Access

v1.0 MCP support MUST include:

- tool registry.
- tool manifest.
- permission prompt.
- workspace scope.
- data classification compatibility.
- policy check before invocation.
- input/output hashing.
- audit event.
- incident on denial or suspicious output.

MCP tools MUST be disabled by default for sensitive workspaces until explicitly allowed.

## 8. Data Safety and Governance Expansion

Beta/v1 MUST extend Data Safety Center asset map to include:

- memories.
- embedding indexes.
- recipes.
- agent groups.
- artifacts.
- external/local agent adapters.
- MCP tools.
- A2A delegations.

Beta/v1 MUST extend AI Governance Center to include:

- Agent Group run risk summaries.
- per-step risk.
- memory write approvals.
- recipe/self-building approvals.
- local agent incidents.
- MCP/A2A incidents.
- adapter capability/audit-level registry.

## 9. UI Requirements

Beta UI MUST include:

- M3 Memory Center.
- Pipeline Agent Group Board.
- recipe save/reuse flow.
- LocalCommandAgentAdapter read-only permission flow.
- audit export flow.

v1.0 UI MUST include:

- Parallel Agent Group Board.
- Debate Agent Group Board.
- self-building recommendation panel.
- recipe library.
- A2A/MCP permission surfaces.
- local agent adapter registry.
- Data Safety asset pages for memory, embedding index, agent group, recipes, artifacts, MCP, and A2A.

Every Agent Group board MUST expose:

- participants.
- step timeline.
- intermediate outputs.
- citations.
- route trace.
- model/tool calls.
- cloud-call count.
- risk summary.
- audit evidence.

## 10. Beta Release Gates

Beta can be called complete only when:

- M3 episodic memory is automatically written and source-linked.
- semantic/procedural memory requires explicit confirmation.
- memory edit/delete/tombstone flows work.
- memory read/write policy is enforced and audited.
- Data Safety Center lists memory and embedding index assets.
- 3-agent Pipeline is bounded, cancellable, auditable, and policy-aware.
- Pipeline per-step route/model/tool evidence is visible.
- recipes can be saved and reused locally.
- redaction preview is usable and audited.
- audit export works.
- LocalCommandAgentAdapter read-only mode is supervised, scoped, cancellable, and audited.

## 11. v1.0 Release Gates

v1.0 can be called complete only when:

- Agent Group is the main work surface.
- Pipeline, Parallel, and Debate modes are implemented.
- all Agent Group modes are bounded, cancellable, auditable, and policy-aware.
- user-confirmed self-building organization works end to end.
- recipe recommendation, approval/rejection, and workflow save are audited.
- A2A-compatible bridge maps external tasks into internal runs and returns final artifacts/results.
- MCP tool access is disabled by default and works through manifest, permission, policy, and audit.
- at least one external local agent adapter family is evaluated and graded, with its control limitations visible.
- Data Safety Center covers workspace, knowledge base, folder, file, memory, embedding index, recipe, agent group, artifact, MCP, A2A, and local agent adapter assets.
- AI Governance Center covers Agent Group runs, per-step risk, memory approvals, self-building approvals, local agent incidents, MCP/A2A incidents, and adapter audit levels.
- no v1.0 feature can bypass policy, route decision, or audit logging.

## 12. Anti-Patterns

MUST NOT introduce:

- Agent Group as unbounded chat.
- memory without source run/file/route links.
- self-building without user confirmation.
- recipes that bypass policy.
- external agents with unclear audit level.
- MCP tools enabled globally by default.
- A2A delegation without route/audit metadata.
- Data Safety maps that omit memory or embedding indexes.
