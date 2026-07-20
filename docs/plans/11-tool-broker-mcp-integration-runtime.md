# 11 Tool Broker and MCP Integration Runtime

> Status: active implementation plan
>
> Phase coverage: Alpha foundation, Beta skills, v1.0 MCP interoperability
>
> Depends on: [02 Local Data, Audit, and Governance Store](02-local-data-audit-governance-store.md), [03 Policy, Routing, and Safety Engine](03-policy-routing-safety-engine.md), [05 Model and Agent Orchestration](05-model-agent-orchestration.md), [10 SHD-Inspired Durable Execution Runtime](10-shd-inspired-durable-execution-runtime.md)

## 1. Goal and Product Decision

Build one Ogra-native capability boundary for callable tools and Agent
delegations. The implementation is a TypeScript/SQLite `CapabilityGateway` with
two distinct paths:

```text
CapabilityGateway
  ToolBroker
    built-in tools
    declarative local-recipe/Skill tools
    MCP stdio tools
    MCP Streamable HTTP tools
  DelegationBroker / AgentAdapter
    InternalAgent
    LocalCommandAgent
    A2A-compatible agents
```

Tool Broker owns typed, bounded tool invocation. Agent delegation remains an
AgentAdapter concern because tasks, messages, artifacts, streaming, and remote
Agent lifecycles are not equivalent to one tool call. Both paths MUST reuse the
same policy, approval, owned-effect, receipt, ingress review, audit, recovery,
and governance envelope.

ModelAdapter invocation remains owned by plan 05 and is not routed through Tool
Broker. Cloud models still use the same plan 10 effect/egress/ingress/audit
envelope. Provider-native tool requests may propose a Tool Broker call but may
never execute it inside the provider adapter.

The product decision is:

> MCP is a capability discovery and invocation protocol, not an authorization,
> recovery, trust, or audit authority. No MCP server, SDK, model provider, Skill,
> or Agent may create a second path around Ogra Core.

Ogra MUST NOT expose an MCP server's raw `tools/list` directly to an Agent. It
exposes only enabled, workspace-bound, immutable Ogra tool versions.

## 2. Current State and Decision Boundary

As of this plan, Ogra has policy and schema fragments but no production Tool
Broker or MCP runtime:

- `tool_calls` is a minimal table and is not a durable invocation authority;
- agent manifests contain tool allowlists, but the real run path does not yet
  provide a complete requested-tool context;
- `InternalAgentAdapter` does not yet execute a production ReAct tool loop;
- Skills have planned schemas and flows, but no complete registry/invoker path;
- no MCP initialize, discovery, transport, session, auth, or invocation client
  is implemented;
- the current A2A bridge is a compatibility fixture, not a production remote
  delegation path;
- durable effects, real approval binding, and independent ingress review must be
  completed before external tools are enabled.

This plan does not claim those capabilities already exist. It defines the
contract and dependency order required to build them.

Ogra adopts:

- one versioned descriptor and binding model for all tool sources;
- immutable schema snapshots and run/effect version pinning;
- deterministic policy and approval before callback;
- plan 10 effect ownership and unknown-outcome semantics;
- independent ingress review before an external result becomes an Observation;
- separately governed MCP transports and client capabilities;
- visible recovery, isolation, and audit grades per adapter.

Ogra does not adopt:

- MCP server annotations, descriptions, or instructions as trusted policy;
- MCP sessions or JSON-RPC request ids as idempotency/outcome evidence;
- server-wide approval as permission for every current or future tool;
- arbitrary Skill code execution in the first Skill implementation;
- dynamic package download as a server launch mechanism;
- A2A as a disguised tool transport;
- exactly-once, automatic rollback, or complete sandbox claims.

## 3. Terms and Authority

- **Tool**: one typed capability invocation with bounded input and output.
- **Skill**: reusable prompt, workflow, or package metadata. A Skill is not
  executable permission. A declarative Skill lowers to a pinned set of Tool
  Broker capabilities.
- **ToolAdapter**: source/transport implementation that invokes a tool and
  declares verified recovery/isolation capabilities.
- **MCP server**: one source of remotely described tools.
- **MCP connection**: one negotiated protocol session and generation; it is
  short-lived operational state, not durable authorization.
- **Tool version**: immutable Ogra descriptor payload snapshot of identity,
  schema, effect class, permissions, provenance, and recovery properties. Its
  separately recorded lifecycle state may change and every change is audited.
- **Workspace binding**: explicit enablement of one tool version for one
  workspace under constraints and an auth reference.
- **Invocation**: a projection linking a pinned tool version to exactly one
  plan 10 effect.

Authority order:

```text
L0  run_effects + approval/policy/receipt evidence  recovery authority
L1  hash-chained run_events                         audit authority
L2  immutable tool versions + workspace bindings   configuration authority
L3  tool_invocations/tool_calls/traces/metrics      rebuildable read models
L4  M3 procedural memory                            planning hints only
```

Registry state, MCP connection state, telemetry, and M3 Memory MUST NOT prove an
external outcome or authorize retry. `run_effects` and its linked evidence are
authoritative for recovery.

## 4. Threat Model and Invariants

The design assumes that a server, catalog entry, tool description, schema,
result, Skill package, network path, or model-produced argument may be malicious,
compromised, stale, or simply wrong.

Threats include:

- tool poisoning and misleading names/descriptions;
- schema replacement after approval (catalog rug-pull);
- argument injection and confused-deputy access across workspaces;
- forged approval, binding, connection, or secret references;
- stdio executable substitution, shell expansion, workdir escape, inherited
  environment leakage, unbounded stdout/stderr, and orphaned process trees;
- HTTP SSRF, redirects, DNS rebinding, private/link-local/metadata endpoint
  access, and OAuth token audience/scope errors;
- prompt injection or executable next-actions in tool output;
- crash or disconnect after an external mutation but before acknowledgment;
- cancellation being mistaken for proof that no external effect occurred.

Required invariants:

1. No tool invocation bypasses Tool Broker.
2. An Agent supplies only `{ toolId, arguments }`; it cannot select a transport,
   server, workspace, approval, connection, or secret. Core injects those values.
3. Every invocation pins one immutable tool version and workspace binding.
4. Every invocation, including read-only invocation, owns one plan 10 effect
   before callback. Read-only recovery still revalidates policy and source revision.
5. Policy, approval, effect revision, descriptor hash, schema hash, server config
   revision, and binding are checked again immediately before callback.
6. A descriptor/schema/capability change creates a new pending version and
   invalidates prior approval for new calls. It never mutates a version in place.
7. Tool output remains untrusted ingress. It cannot become an Observation until
   independent review accepts it.
8. A URI, suggested next action, embedded tool request, or resource reference in
   output is never followed automatically; it requires a new effect.
9. Raw secrets, OAuth tokens, idempotency keys, arguments, sensitive outputs,
   and full payloads do not enter renderer state, audit events, or telemetry.
10. Unknown external outcomes reconcile or fail closed. Non-idempotent calls are
    never automatically replayed.

MCP `readOnlyHint`, `destructiveHint`, and similar annotations are untrusted
hints. Ogra derives risk and effect class from local review and policy and MUST
NOT lower protection solely from server metadata.

## 5. Unified Tool Contract

The runtime contract is represented conceptually as:

```ts
type ToolSourceKind = "builtin" | "skill" | "mcp";
type ToolTransport = "in_process" | "isolated_worker" | "mcp_stdio" | "mcp_http";
type EffectClass = "read_only" | "local_mutation" | "external_mutation";

interface ToolDescriptorVersion {
  id: string;
  descriptorId: string;
  logicalName: string;
  sourceKind: ToolSourceKind;
  sourceRef: string;
  owner: string;
  sourceVersion: string;
  transport: ToolTransport;
  inputSchema: object;
  outputSchema?: object;
  effectClass: EffectClass;
  permissions: object;
  dataCompatibility: object;
  riskTier: "low" | "medium" | "high" | "blocked";
  recoveryCapabilities: object;
  provenance: object;
  descriptorHash: string;
  inputSchemaHash: string;
  outputSchemaHash?: string;
}
```

`logicalName` is display/discovery metadata, never an authorization key.
Canonical ToolId is an opaque id derived from the pinned source/server version
identity and the exact protocol tool name. Duplicate exact names in one catalog
are rejected. Cross-server names never collapse. UI always shows source and
version and safely escapes control, bidi, confusable, and truncation-sensitive
text without changing the canonical id used by policy/approval.

Schemas MUST use a supported, explicitly versioned JSON Schema dialect.
Canonicalization, hashing, validation behavior, unsupported keyword handling,
maximum document size, maximum nesting depth, maximum collection length, and
string/binary limits MUST be deterministic. Validation is performed both before
policy evaluation and immediately before invocation. Output schema validation
does not replace ingress review.

External/remote `$ref`, unknown formats, and custom keywords are denied by
default. Local references must remain inside the reviewed schema snapshot;
cycles, regex complexity, `oneOf`/`anyOf` expansion, compilation time, CPU,
memory, and validation time are bounded. Schema compilation runs without network
access in a resource-limited validator boundary. Prototype-pollution keys are
rejected or handled by a parser/validator proven safe for them.

For a run already in progress, the pinned version remains inspectable. A
removed, stale, or revoked tool blocks new invocations. Revocation may also stop
an in-flight call when the adapter can cancel, but cancellation does not prove a
mutation was not applied.

## 6. Registry and Persistence Model

Plan 02 owns the physical schema. The target model is:

```text
tool_descriptors
  id, source_kind, source_ref, logical_name, owner, latest_version_id,
  lifecycle_state, created_at, updated_at

tool_versions
  id, descriptor_id, source_version, descriptor_hash,
  input_schema_json, input_schema_hash, output_schema_json, output_schema_hash,
  effect_class, permissions_json, data_compatibility_json,
  recovery_capabilities_json, provenance_json,
  status: discovered | pending_review | enabled | stale | revoked,
  created_at

workspace_tool_bindings
  id, logical_binding_id, parent_binding_id, workspace_id, tool_version_id,
  revision, binding_hash, enabled,
  policy_id, approval_mode,
  constraints_json, auth_binding_id, created_at, updated_at

tool_invocations
  id, effect_id UNIQUE, tool_version_id, binding_id, connection_id,
  connection_generation, input_hash, output_hash, policy_evaluation_id,
  current_approval_id, ingress_finding_id, started_at, completed_at

mcp_servers
  id, active_version_id, provenance_json, trust_state, state,
  created_at, updated_at

mcp_server_versions
  id, server_id, revision, transport, launch_or_url_config_json,
  config_hash, auth_profile_id, created_at

mcp_connections
  id, server_id, generation, negotiated_protocol_version,
  capability_snapshot_hash, state, opened_at, closed_at, last_error_code

mcp_catalog_snapshots
  id, server_id, connection_generation, cursor, catalog_hash, created_at

tool_schema_reviews
  id, tool_version_id, diff_hash, decision, approval_id, reviewer, decided_at

tool_auth_bindings
  id, logical_binding_id, parent_binding_id, provider_kind, secret_ref,
  audience, scopes_json, generation, binding_hash, created_at, revoked_at
```

```text
approval_consumptions
  id, approval_id, effect_id, callback_attempt_no, approval_revision,
  consumed_at, event_id, UNIQUE(approval_id, effect_id, callback_attempt_no)

effect_approval_bindings
  id, effect_id, callback_attempt_no, approval_id, approval_revision,
  binding_kind, created_event_id, UNIQUE(effect_id, callback_attempt_no)
```

Tool descriptor payloads and server config versions are immutable. Tool
lifecycle changes, binding revisions, auth-binding generations, and active
server-version changes are mutable control state but MUST append audit events;
historical versions remain queryable. Each effect and approval pins the binding
revision/hash, server version/config hash, and auth generation that applied.
Every workspace-binding change creates a new row linked by
`logical_binding_id`/`parent_binding_id`; old effects pin the concrete row id and
hash. Scope/audience/auth generation changes likewise create a new auth-binding
row rather than rewriting history.
`tool_invocations` does not define a second invocation state machine; state is
derived from its unique `run_effects` row.
The existing `tool_calls` table becomes a compatibility/read projection.
`skill_invocations` links to `tool_invocation_id` and `effect_id`; it does not
create independent outcome authority.

The authoritative effect also references a versioned sealed callback capsule
and sealed idempotency-key material as defined by plan 10. The capsule contains
the exact sanitized outbound arguments needed for a verified retry, uses
workspace-scoped authenticated encryption, excludes auth tokens, and is never
copied into `tool_invocations`, audit, renderer state, logs, or telemetry.
Each receipt also references a sealed result capsule containing the exact
returned value needed to resume ingress review. It uses workspace-scoped
authenticated encryption, binds effect/receipt/attempt/adapter/response hash,
and is likewise excluded from projections, audit, renderer state, logs, and
telemetry.
Alpha combines all policy obligations for one callback attempt into one exact
approval decision. Its use is consumed through `approval_consumptions` in the
same CAS transaction that checks `uses_consumed < use_limit`, increments it,
records the callback attempt number, and transitions the effect to `in_flight`.
A sent or `unknown` effect never refunds that use. A policy-permitted recovery
attempt uses a new scoped approval and attempt number on the same effect.
Each attempt appends an `effect_approval_bindings` row. The effect/invocation
current-approval pointer may advance for query convenience but is not authority
and never replaces prior approval, binding, consumption, event, or receipt rows.

Both callback and result capsules use plan 10's cross-store write-ahead
durability protocol. For filesystem storage, Ogra seals to temp, fsyncs,
atomically no-replace renames within the same filesystem to an immutable
content-addressed path, fsyncs the destination directory after rename,
reopens/verifies, and only then commits the SQLite ref/hash/version plus
effect/receipt/state/event. Unsupported durability primitives fail closed or use
the same-transaction encrypted-BLOB backend.
Completion is exposed only after DB commit. Orphans from a pre-DB crash are
removed after a grace period by an audited policy-gated collector; SQLite must
never point to a non-durable capsule.

Server configuration states:

```text
draft -> enabled -> disabled
                 -> revoked
```

Connection states:

```text
disconnected -> connecting -> initializing -> ready -> degraded
                                             -> draining -> closed
                   any non-terminal state -> failed
```

Tool version states:

```text
discovered -> pending_review -> enabled -> stale -> revoked
```

Emergency revocation may transition directly from `discovered`,
`pending_review`, `enabled`, or `stale` to `revoked`; it never waits for a normal
stale-review sequence.

## 7. Broker API and Invocation Protocol

Core-owned interfaces are intentionally narrow:

```text
listEnabledTools(runContext) -> pinned descriptors
prepareInvocation(runContext, toolId, arguments) -> effect/obligations
invokePrepared(effectId) -> reviewed result | quarantine | unknown | failure
reconcileInvocation(effectId) -> verified outcome | user decision required
```

There is no renderer-facing or Agent-facing raw `invoke(server, transport, ...)`
API. Renderer surfaces may list, configure, approve, disable, and inspect tools,
but Core is the only invocation authority.

Every invocation follows:

```text
1. Core resolves the enabled workspace binding and immutable tool version.
2. Canonical JSON Schema validation and size/depth limits run on arguments.
3. Core classifies referenced data and recomputes the high-water mark.
4. Required sanitization produces a payload fingerprint.
5. Deterministic policy and routing produce obligations.
6. The sanitized outbound arguments are validated again against the pinned
   schema, canonicalized, and hashed.
7. One transaction resolves/updates the existing owner frame, creates its
   planned effect, stores sealed callback/idempotency refs and hashes, and
   appends prepare intent. A tool call does not imply a new frame.
8. Any approval is then requested and bound to the concrete effect id/revision,
   exact payload, and complete invocation scope. The planned effect/frame waits.
9. Immediately before callback, one CAS transaction rechecks version, schema,
   binding, server config, effect/frame revisions, policy, route, and approval;
   it atomically reserves/consumes the permitted approval use, transitions the
   effect to `in_flight`, and appends callback intent. Calls without approval use
   the same pre-callback CAS without a consumption step.
10. Tool Host invokes the adapter with bounded time/resources and a stable
   idempotency key only where the adapter supports it.
11. After a result arrives, one transaction appends the receipt and sealed
    result capsule and transitions `in_flight -> received` before the adapter
    reports completion to the orchestrator/releases the session. Transport
    failure and tool-level `isError` remain distinguishable.
12. Independent ingress review decrypts/verifies, validates, and classifies the
    result capsule.
13. One transaction CASes `received` state, effect revision, and authoritative
    receipt id, then commits the single ingress finding/incident, accepted
    Observation when any, terminal effect state, and post-audit evidence. A CAS
    loser commits nothing and reloads.
14. Only an accepted ingress result is persisted as an Observation.
```

Approval MUST bind at least:

- workspace, Agent, run/frame, and tool version;
- workspace binding revision and binding hash;
- descriptor and input/output schema hashes;
- server config revision and effect class;
- canonical arguments/payload fingerprint and target resource/data scope;
- policy and redaction revisions;
- auth binding identity, audience, scopes, and generation without the token;
- expiry, use count, and approver.

A changed value invalidates approval. Approval of a server or connection alone
is never sufficient for an invocation.

Administrative approvals (`server_config`, `server_enable`,
`server_discovery`, `schema_review`, `workspace_binding`) authorize only their
named configuration/catalog operation. They cannot populate invocation approval
or consumption records. Callback approvals (`tool_invocation`,
`recovery_retry`) bind a concrete effect, payload, effect revision, and callback
attempt. Tests MUST prove that a server-wide/schema/binding approval cannot
trigger `tools/call`.

## 8. Execution Boundaries

```text
Renderer
  registry/grant/approval/inspection requests only
        |
Main / typed IPC permission gate
        |
Ogra Core
  registry + policy + approval + durable effect + audit authority
        |
Ogra Edge Tool Host (isolated worker/child/utility process)
  bounded adapter execution, no SQLite, no raw secret store
        |
built-in implementation or MCP transport
```

Built-in tools SHOULD run in a restricted worker when they touch files or
untrusted content. The first vertical slice is `knowledge.search`, a read-only
TypeScript adapter that calls a Core-owned, scope-checked `KnowledgeQueryPort`.
The Tool Host receives only the authorized query/scope and result; it never
opens SQLite directly. Model-native tool-calling is not required for this slice;
a deterministic Internal Agent plan may invoke it to prove the control envelope.

Declarative local-recipe Skills may compose pinned tools and prompts. The first
Skill runtime MUST NOT execute arbitrary package code. Code-backed marketplace
Skills require a separate trust, signature, sandbox, update, and rollback plan.

## 9. MCP Protocol and Lifecycle

Server administration and discovery are privileged effects, not harmless setup.
Adding/enabling configuration, launching stdio, opening HTTP/OAuth connections,
initializing a server, and fetching a catalog MUST follow:

```text
policy/admin approval -> owned effect -> supervised launch/connect
  -> bounded initialize/catalog response -> independent ingress review
  -> immutable pending tool versions -> explicit schema review/binding
```

Unreviewed descriptions, instructions, annotations, and schemas are stored as
untrusted, bounded evidence and are not rendered as trusted UI or made Agent
visible. Catalog pagination, cursor count, total tools, schema size, refresh
frequency, notification rate, reconnects, and concurrent discovery are bounded.
`tools/list_changed` is debounced and rate-limited; a notification storm cannot
auto-reconnect, auto-enable a tool, or mutate the active version.

The first MCP adapter supports only:

- `initialize` and `initialized`;
- paginated `tools/list`;
- `tools/call`;
- negotiated `notifications/tools/list_changed`.

Server instructions and metadata are stored and reviewed as untrusted content;
they are not injected into system instructions. A list-change notification or
catalog hash change creates new immutable versions in `pending_review`. Existing
in-flight effects keep their pinned version; new calls to changed/removed tools
are blocked until review and binding.

MCP resources, prompts, roots, sampling, and elicitation are disabled initially.
Each future capability needs its own policy operation, data-flow analysis,
approval scope, audit events, and UI. In particular, an MCP server MUST NOT
silently trigger model sampling or solicit sensitive input under a generic
server approval.

The protocol dispatcher MUST reject every unnegotiated or disabled
server-initiated method with the appropriate JSON-RPC error and an audit event.
This includes unsolicited/SSE requests for sampling/createMessage, elicitation,
roots, resources, prompts, logging changes, or nested calls. Rejection MUST NOT
open UI, call a model/tool, read roots/data/secrets, or create an implicit effect.

MCP tool-level `isError` is an application result, not a JSON-RPC transport
failure. Both cases retain receipts and pass through ingress review. A JSON-RPC
request id is correlation metadata, not an Ogra idempotency key.

### 9.1 stdio Profile

Local stdio is the first MCP transport and MUST:

- pin an absolute executable, explicit argument vector, and config hash;
- pin canonical realpath, content digest, owner/mode, and package/signature
  provenance when available; reject writable parent-path or symlink-swap risk,
  and recheck immediately before spawn using a non-substitutable handle where
  the platform supports it;
- invoke without a shell and forbid `npx` or other dynamic download launchers;
- use a canonical bounded workdir;
- construct a minimal environment without inherited `HOME`, credentials, or
  the full parent environment;
- bound request/response size, stdout/stderr, concurrency, and wall time;
- implement cancellation, process-tree cleanup, restart backoff, and health;
- keep protocol stdout separate from diagnostic stderr;
- expose its actual OS sandbox and network-enforcement grade without claiming
  stronger isolation than the platform provides.

`cwd` and environment controls are not a sandbox. Production stdio may receive
non-Public data or any secret only when an OS-enforced profile demonstrably
restricts filesystem paths, network (including localhost/private/link-local and
metadata endpoints), process creation/tree, `/proc` or equivalent same-user
inspection, and ambient credentials. On a platform where Ogra cannot enforce
that profile, every third-party or user-configured stdio server fails closed in
production regardless of current argument/data classification. Only an
Ogra-built, content-pinned, secretless fixture may run for protocol/security
tests; it is not registered as a user-callable production tool. A config,
digest, owner/mode, executable, args, workdir, or sandbox profile change creates
a new server version and requires review.
Workspace enablement or user approval cannot upgrade an unverified isolation
grade or authorize an unsandboxed spawn. Public arguments do not make a process
safe because it can read ambient Confidential files or credentials. A future
unmanaged-external-process mode, if ever designed, must be manual-only, cannot
be Agent invoked, and sits outside Tool Broker and Ogra's controlled-boundary
claims under its own product/security plan.

### 9.2 Streamable HTTP Profile

Remote Streamable HTTP is later than the local stdio gate and MUST:

- require HTTPS except an explicit loopback development fixture;
- validate an endpoint allowlist and Origin expectations;
- revalidate every redirect and resolved address;
- never follow 3xx for `tools/call`; endpoint changes create a new reviewed
  server version, and authorization headers/bodies are never forwarded;
- block private, link-local, loopback, metadata, and disallowed address ranges
  for remote configurations, including DNS-rebinding cases;
- bound response size, concurrency, SSE/session lifetime, reconnects, and retry;
- track protocol version, session id, and connection generation;
- treat a new generation as a new operational session, never as outcome proof.

Where OAuth is supported, use Authorization Code with PKCE, single-use
short-lived `state`, exact redirect-URI match, issuer/resource/audience binding,
least scopes, code replay protection, refresh rotation/revocation, and explicit
token lifecycle as required by the supported MCP authorization profile.
Authorization metadata, issuer, and redirect endpoints receive the same
SSRF/DNS/redirect validation as the tool endpoint. Dynamic client registration
and token passthrough are denied by default. Tokens are held only by the
OS-backed secret broker and injected for the exact auth binding. OAuth
authenticates a connection; it does not authorize a tool call. T5 OAuth remains
disabled until this complete profile and its attack tests pass.

## 10. Durable Recovery and Memory

MCP defines no universal idempotency or outcome-query contract. Generic MCP
tools therefore default to:

```text
supports_idempotency_key = false
supports_outcome_query = false
supports_cancel = transport-specific
supports_compensation = false
```

Disconnect or crash after send and before a trustworthy receipt moves the
effect to `unknown`. A non-idempotent invocation MUST NOT be automatically
replayed. JSON-RPC cancellation or process termination only records a cancelled
attempt; it does not prove `not_applied`. Stronger recovery capability may be
declared only by a tested adapter extension with explicit outcome evidence.

Even when replay is otherwise allowed, recovery MUST decrypt and verify the
sealed callback capsule and idempotency material, then repeat schema, policy,
approval, binding, revision, and target checks. Missing, corrupt, expired,
wrong-workspace, or hash-mismatched material fails closed and creates an
incident. Capsule retention MUST outlive every non-terminal/unknown effect and
then follow an explicit policy-gated retention/deletion rule.

Recovery from `received` verifies/decrypts the receipt's result capsule and
reruns ingress review only; it MUST NOT call the adapter again. A sent attempt
without a transactionally complete receipt/result capsule is `unknown`.
Missing/corrupt/mismatched result material fails closed and creates an incident.
Result capsule retention covers `received`, every non-terminal/unknown effect,
and any audit-retention obligation before policy-gated audited deletion.
Recovered ingress requires the run recovery lease; both live and recovered
finalizers use the same effect/revision/authoritative-receipt CAS.

Tool and MCP recovery follows plan 10 leases, revisions, receipts, repair
verification, and audit packets. A changed connection generation cannot resume
a session-bound effect by assumption.

M3 Memory may store source-linked episodic outcomes and user-confirmed
procedural candidates such as a successful tool sequence. It MUST NOT store raw
arguments, secrets, approval tokens, live ids, or idempotency keys and MUST NOT
authorize or reconcile an effect. A remembered tool must resolve to a currently
enabled pinned version and repeat current policy/approval checks.

## 11. Observability, Evaluation, and Governance UI

Tool traces correlate `run -> frame -> effect -> tool version -> server ->
connection generation -> receipt -> ingress finding` without recording secrets
or raw sensitive input/output. Metrics include invocation, denial, quarantine,
application error, transport error, timeout, cancellation, latency p50/p95,
approval wait, unknown outcome, recovery, schema drift, and connection health.
Metrics and traces are non-authoritative projections.

Evaluation suites measure separately:

- tool selection accuracy;
- argument and schema correctness;
- policy/approval compliance;
- result grounding and ingress handling;
- recovery correctness under crash/disconnect;
- resistance to malicious catalogs, schemas, descriptions, and outputs.

Data Safety Center MUST show:

- configured servers, provenance/trust, transport, endpoint/launch summary,
  actual isolation and network-control grade;
- immutable tool versions, schema diff/review status, workspace binding, data
  scope, effect class, and auth scope summary;
- recent accesses/egress, connection health, and current disable/revoke state.

AI Governance Center MUST show:

- approval/denial history and exact bound scope;
- invocation/effect/receipt/ingress lineage;
- unknown outcomes and recovery decisions;
- schema drift, quarantine, auth, SSRF, sandbox, timeout, and crash incidents;
- adapter recovery and audit capability grades.

The permission prompt shows the tool owner/version, source server, requested
operation, target/data scope, effect class, payload summary/hash, network/secret
use, expiry, and whether outcome reconciliation is possible. It does not render
raw untrusted server instructions as trusted UI copy.

## 12. Delivery Plan and Exit Gates

### T0: Cumulative Prerequisite Trust Gates

These gates accumulate by milestone rather than all blocking T1 at once. T1
requires the baseline, durable kernel, and audit-envelope items; T2 additionally
requires real approval and independent ingress; T5 additionally requires the
secret-store migration.

- complete Sequence 0 real run wiring;
- complete plan 10 Milestones 0-1;
- upgrade the audit chain to a versioned canonical event-envelope hash covering
  event/run/workspace ids, sequence, event type, payload hash, policy/redaction
  revisions, timestamp, previous hash, and the envelope version itself; preserve
  legacy-chain verification;
- before T2, persist real scoped approvals and complete the independent ingress
  boundary used by tool returns;
- before T5, migrate provider/tool secrets to an authenticated OS-backed secret
  store, use authenticated encryption where portable storage is unavoidable,
  and surface migration/corruption instead of silently dropping credentials.

Exit gate: a mocked effect proves policy/approval callback exclusion, crash
recovery, receipt, ingress, and audit behavior end to end, and tampering with any
hashed event-envelope field is detected.

### T1: Broker Contract and Registry

- implement descriptor/version/binding types, canonical schema validation, and
  migrations;
- implement Core-owned registry and broker preparation APIs;
- make empty/missing manifests deny requested tools rather than fail open;
- add immutable version, schema drift, binding, and approval-scope tests.

Exit gate: an Agent cannot construct a transport/secret/server choice, changed
schema blocks new calls, and no callback occurs without a valid owned effect.

### T2: Read-Only Built-in Vertical Slice

- implement `knowledge.search` in the bounded Tool Host;
- invoke it from one deterministic Internal Agent plan;
- persist tool version, invocation/effect, policy, access, receipt, ingress, and
  Observation evidence;
- expose trace and governance read models.

Exit gate: the slice survives crash injection and cross-workspace, malformed
arguments, oversized result, forged approval, and malicious-output tests.

### T3: Declarative Local Recipe Skills

- lower built-in/local recipes to pinned tool allowlists;
- implement manifest trust, first-use approval, and version pinning;
- prohibit arbitrary recipe code and dynamic dependency installation;
- link Skill projections to Tool Broker effects.

Exit gate: a recipe can compose approved tools without gaining permissions and
can be reproduced from pinned versions and evidence.

### T4: Local MCP stdio Fixture

- implement protocol lifecycle, catalog snapshots, tools-only negotiation, and
  list-change invalidation;
- run one Ogra-built, content-pinned, locally packaged test server in the Tool
  Host; this fixture does not authorize production third-party stdio;
- implement bounds, minimal environment, workdir enforcement, process-tree
  cleanup, and honest isolation grading;
- test disconnect/unknown outcome and non-replay semantics.
- gate any production/user-configured stdio enablement on the verified OS
  filesystem/network/process/credential enforcement profile in §9.1.

Exit gate: a malicious or changed local server cannot bypass policy, leak parent
environment, silently alter a schema, inject an Observation, or trigger replay.

### T5: Remote MCP Streamable HTTP and OAuth

- implement hardened HTTP transport, sessions/generations, SSRF/redirect/DNS
  controls, rate/size/time bounds, and connection health;
- implement audience/scope-bound auth through the OS secret broker;
- add remote connection, schema-review, incident, and revocation UI;
- keep sampling, elicitation, prompts, resources, and roots disabled.

Exit gate: remote MCP passes the security and recovery matrix below without
weakening the local tool contract.

### T6: Separately Governed MCP Capabilities

Evaluate resources, prompts, roots, sampling, and elicitation one capability at
a time after T5. Each needs a written threat model, policy operation, approval
binding, ingress/egress classification, audit schema, UI, and release gate.
There is no commitment to ship all capabilities in v1.0.

## 13. Verification Matrix

At minimum, tests MUST prove:

- adapter callback count is zero without owned effect and valid policy/approval;
- cross-workspace access, forged binding/approval/secret refs, and stale
  policy/effect revisions are rejected;
- malformed, ambiguous, oversized, deeply nested, and unsupported schemas or
  values fail deterministically;
- external/recursive `$ref`, validator SSRF, catastrophic regex/combination,
  prototype-pollution keys, and validator CPU/memory/time exhaustion fail closed;
- catalog/list-change/schema drift blocks new calls and preserves pinned
  in-flight evidence;
- server add/enable/launch/connect/initialize/discovery requires its own scoped
  policy/effect evidence and bounded ingress review;
- catalog pagination/size/rate and list-change notification storms fail closed
  without auto-enabling or uncontrolled reconnect;
- a removed or revoked tool is not silently substituted;
- crash before callback, after send/before acknowledgment, after receipt, and
  before Observation commit has the plan 10 outcome;
- a restart from `received` replays ingress from the exact result capsule with
  adapter callback count zero; corrupt/missing/wrong-workspace/mismatched result
  material fails closed;
- duplicate receipt insertion for one effect/attempt is rejected, and two
  concurrent ingress finalizers produce exactly one finding/incident,
  Observation, terminal transition, and event;
- post-send unknown non-idempotent effects are not replayed;
- missing, corrupt, expired, wrong-workspace, or mismatched callback capsule or
  idempotency material blocks replay, while valid material reconstructs exactly
  the approved canonical request without an auth token;
- concurrent attempts cannot both consume a one-use approval, and approval
  expiry/revocation between prepare and callback prevents the callback;
- initial attempt approval followed by an `unknown` recovery attempt preserves
  both attempt-specific approvals/consumptions and permits only one callback for
  the new attempt;
- capsule fault injection before durability, after rename/before DB commit, and
  after DB commit/before callback/orchestrator acknowledgment produces no
  dangling DB reference, unsafe callback, or untracked orphan cleanup;
- power loss after rename/before destination-directory fsync never produces a
  committed capsule reference;
- cancellation is not treated as `not_applied`;
- clean, suspicious, malicious, malformed, oversized, and `isError` outputs are
  separated and reviewed before Observation;
- malicious descriptions, server instructions, URIs, and suggested next actions
  cannot alter policy or trigger a second action;
- stdio executable/arguments/workdir/environment/output limits and process-tree
  cleanup resist escape and leakage;
- stdio tests prove OS denial and incidents for parent/absolute/symlink reads,
  `HOME`, `/proc` or equivalent, localhost/private/link-local/metadata/public
  network access, ambient credentials, and child/orphan processes; without that
  enforcement, every third-party/user-configured production spawn count is zero;
- with only Public constant arguments, a malicious stdio attempt to read and
  exfiltrate workspace-external Confidential, keyring/secret-store, SSH, and
  browser canaries has spawn/callback count zero unless the mandatory OS profile
  is active and proves those accesses denied;
- executable replacement, symlink swap, writable parent, owner/mode/digest
  change, and argument-selected script change result in zero spawn pending review;
- HTTP SSRF, redirect, DNS rebinding, origin, token audience, token scope,
  response size, timeout, and reconnect cases fail closed;
- OAuth tests cover state/CSRF, exact redirect, issuer mix-up, metadata SSRF,
  token passthrough, code replay, refresh rotation/revocation, and 301/302/307/308
  to same-origin/cross-origin/private targets with zero body/token forwarding;
- duplicate/confusable/truncated tool names never alter canonical ToolId or
  approval target, and same-catalog duplicate exact names are rejected;
- every disabled or unsolicited server method is rejected/audited with zero
  model, UI, tool, secret, root, or data callback;
- server crash/restart changes connection generation and does not invent outcome;
- concurrent recovery respects the lease and does not duplicate application;
- DB, audit, renderer, logs, traces, metrics, stdout, and stderr contain no raw
  secret or OAuth token;
- read models rebuild from effects/events without becoming recovery authority.

## 14. Non-Goals and Guardrails

- Do not install an MCP SDK before the Ogra contract and tests define its
  boundary; an SDK is replaceable protocol plumbing.
- Do not expose arbitrary remote MCP, dynamic discovery, shell, browser, write,
  or marketplace-code execution in the first broker slice.
- Do not treat Skills as permission containers or MCP servers as trusted peers.
- Do not let provider-native tool calls execute outside Tool Broker.
- Do not let A2A bypass AgentAdapter delegation policy by presenting it as a tool.
- Do not persist hidden model chain-of-thought for tool evaluation or audit.
- Do not claim stdio isolation, network enforcement, exactly-once execution,
  safe cancellation, or reversible effects beyond measured adapter capability.

## 15. MCP Specification Provenance

This plan targets the MCP `2025-11-25` specification family and MUST pin the
implemented protocol versions in code and connection evidence:

- [MCP specification](https://modelcontextprotocol.io/specification/2025-11-25)
- [Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [Server tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [Client sampling](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling)
- [Client elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)

Later specification revisions require explicit compatibility review. Ogra's
local authorization, recovery, ingress, and audit invariants remain authoritative
even when the wire protocol changes.
