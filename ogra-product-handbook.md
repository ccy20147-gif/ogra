# Ogra / Ogra Edge Product Handbook

> Version: v0.2
>
> Date: 2026-08-17
>
> Status: current product and technical source of truth

---

# 0. Core Decision

Ogra is no longer defined as a desktop Agent workspace.

Ogra is a language- and framework-neutral runtime for controlling and recovering
AI Agent actions:

> **Ogra turns every Ogra-controlled model or tool call into a governed,
> recoverable, and verifiable Action.**

The user problem is concrete:

> Agents can call real models and tools, but developers cannot safely trust what
> data leaves, what exact payload was approved, whether an external action
> succeeded before a crash, whether it will be repeated, or what evidence remains.

Ogra owns the lifecycle of the boundary crossing:

```text
propose
  -> classify
  -> policy and route
  -> redact or block
  -> bind approval to the exact payload
  -> persist intent
  -> invoke
  -> record receipt or unknown outcome
  -> review ingress
  -> commit, quarantine, reconcile, or escalate
  -> append verifiable evidence
```

Python is the first implementation stack. LangChain and LangGraph are the first
framework integrations. Neither Python nor LangChain/LangGraph defines the
product boundary.

---

# 1. Product Positioning

## 1.1 One-Line Positioning

English:

> **Control every Agent call before it leaves. Recover safely, or stop when the
> outcome is unknown.**

Chinese:

> **控制每次 Agent 外部调用的数据和权限；中断后安全恢复，结果未知时绝不盲目重放。**

## 1.2 Immediate Developer Value

Ogra must provide a Mem0-like developer experience: a developer adds a few lines
to an existing Agent and immediately sees value in normal use.

For every Ogra-controlled model or tool call, the default experience exposes:

- destination and action identity;
- data classification and egress decision;
- redaction or approval result;
- persisted Action state;
- receipt or explicit `unknown_outcome`;
- ingress review result;
- a local evidence reference.

Recovery is a failure-path capability. A normal successful call cannot prove
crash recovery, but it must already be persisted under the same recovery
contract. Fault behavior is demonstrated by a separate generic Crash Lab, not by
making a specific business scenario the product entry point.

## 1.3 Product Boundary

Ogra governs only calls that pass through Ogra-controlled SDKs, adapters, or
gateways. It does not claim to govern:

- direct provider SDK calls that bypass Ogra;
- unrelated local processes or system-wide network traffic;
- provider-internal retention, reasoning, or tool execution;
- third-party telemetry outside the Ogra boundary;
- user copy/paste, screenshots, or exports outside an Ogra-controlled path.

Product copy must state this boundary explicitly.

---

# 2. The Ogra Action

## 2.1 User-Facing Object

The user-facing primitive is an `Action`, not a policy row, effect row, or audit
event.

```text
Ogra Action
  - what the Agent intends to do
  - which model, tool, Agent, or destination it will call
  - which data will cross the boundary
  - which policy and rule versions apply
  - which exact payload was approved
  - whether the external system accepted or completed it
  - whether the returned content is trusted
  - whether recovery may retry, reconcile, compensate, or must stop
  - which evidence proves each decision
```

An Action may represent:

- a model request;
- a tool invocation;
- an Agent delegation;
- a memory write;
- an export or file write;
- another typed external side effect.

## 2.2 Authoritative States

Action, execution attempt, ingress, and recovery decision are separate state
machines. The minimum Action lifecycle is:

```text
proposed -> authorized -> executing -> result_received -> committed
proposed -> blocked
authorized -> cancelled
executing -> failed_authoritative | unknown_outcome
result_received -> quarantined | review_unavailable
review_unavailable -> result_received
quarantined -> committed | failed_authoritative
unknown_outcome -> executing | committed | failed_authoritative
```

Each execution attempt has its own lifecycle:

```text
prepared -> dispatch_authorized | cancelled | failed_local
dispatch_authorized -> acknowledged | cancelled | unknown
acknowledged -> response_received | failed_authoritative | unknown
```

`reconcile`, `retry_with_same_key`, `compensate`, `manual_review`, and `stop`
are recovery decisions, not Action terminal states. An inline SDK that obtained a
dispatch grant but did not persist an authoritative acknowledgement before its
lease expired must be treated as unknown.

An unknown Action may become committed or failed only after authoritative
reconciliation. A retry creates a new Attempt and requires a verified recovery
decision; uncertainty itself is never retry authority.

Local exceptions, transport errors, HTTP success, or provider request IDs are
not authoritative effect outcomes by default. Receipts identify their kind,
authority, and external effect status; only authoritative completion or failure
evidence may resolve the Action.

Terminal names may evolve, but the following meanings may not:

- a graph checkpoint is not proof that an external action succeeded;
- a timeout is not proof that an external action failed;
- `unknown_outcome` may not be silently converted to retry;
- approval is valid only for the bound payload, policy, revision, scope, and time;
- ingress content is not accepted until review succeeds.

## 2.3 External Capability Manifest

Every model, tool, or delegation adapter declares recovery capabilities:

```text
supports_idempotency_key
supports_outcome_query
supports_cancel
supports_compensation
compensation_is_lossless
idempotency_scope
idempotency_valid_until
idempotency_conflict_behavior
outcome_retention_until
duplicate_effect_risk
retry_cost_risk
audit_level
```

Ogra derives recovery behavior from declared and conformance-tested capability,
not from optimistic assumptions.

Capability is operation-scoped. A provider may be outcome-queryable for one
operation and non-idempotent and non-queryable for another.

---

# 3. Product Surfaces

## 3.1 Ogra SDKs

SDKs provide the lowest-friction integration for application developers.

Planned order:

1. Python SDK.
2. TypeScript SDK.
3. Additional SDKs based on adoption and contributor demand.

SDK responsibilities:

- framework mapping;
- local runtime discovery;
- typed Action submission;
- approval and resume APIs;
- evidence lookup;
- honest capability reporting.

SDKs do not own policy or effect authority. They map framework events to the
Ogra Protocol.

## 3.2 Ogra Edge

Ogra Edge is the local Action runtime and evidence authority.

It owns:

- policy evaluation and data high-water marks;
- redaction and approval binding;
- Action/effect persistence;
- attempts, receipts, leases, and recovery decisions;
- ingress review and quarantine;
- append-only audit evidence;
- local API and CLI.

In development, an SDK may automatically discover or start a local Edge daemon
using a file lock and a stable data directory. This is a convenience process
boundary, not a security-isolation claim.

In production, Edge must support explicit deployment, endpoint configuration,
separate credentials, health checks, and supervised lifecycle management.

## 3.3 Ogra Studio

Ogra Studio is a later visual surface for:

- approvals and re-sanitize decisions;
- Action state and recovery decisions;
- quarantine and incident review;
- policy simulation;
- evidence and audit verification.

Studio is not required for the first SDK release and is not the product core.
The existing Electron application is an implementation reference and possible
future Studio foundation, not the primary distribution target.

## 3.4 Ogra Cloud

A hosted service may later provide managed runtime, team policy distribution,
central evidence search, and multi-device operation. The open-source local
runtime must remain useful without Ogra Cloud.

Policy, Action state, evidence formats, and the verifier must remain open and
portable so Cloud does not become the only source of trust.

---

# 4. Generic Quickstart Contract

## 4.1 Required Experience

The homepage Quickstart must work against an ordinary existing LangChain Agent.
It must not require a refund, finance, healthcare, or other specific domain.

Target installation:

```bash
pip install "ogra[langchain]"
```

Target integration shape:

```python
from ogra.langchain import create_ogra_agent

agent = create_ogra_agent(model=model, tools=tools)
result = agent.invoke(input)
```

The exact API may change during implementation, but the integration budget may
not grow beyond a drop-in factory or equivalent two-to-five-line change for the
default case.

The SDK should automatically connect to `OGRA_ENDPOINT` when configured. In
development, it may start or reuse a local Edge daemon when no endpoint is
configured. Production deployment remains explicit.

## 4.2 First-Run Output

Normal framework return values remain unchanged. Ogra adds a concise summary:

```text
OGRA governed | destination=openai:gpt-4.1-mini + tools:1 |
classification=public | policy=allowed | execution=inline |
recovery=unknown_if_interrupted | isolation=development |
coverage=model+client_tools | ingress=clean |
audit=chain_valid | anchor=none | run=run_123
inspect: ogra run show run_123
```

The summary must provide a working CLI or API evidence reference rather than an
undefined custom URI or internal state-machine dump.

## 4.3 Default Interception Scope

The first LangChain integration governs:

- model request and response;
- client-side tool call and result;
- run/thread correlation;
- human approval interrupts;
- accepted observations returned to the Agent loop.

Delegation, RAG, memory, provider-native tools, and calls made outside the
wrapped Agent are governed only when they pass through an Ogra adapter. Coverage
must never be implied when interception is absent.

## 4.4 Crash Lab

Crash Lab is a generic conformance and proof environment. It is not the main
Quickstart.

It must include a recording external sink and deterministic failure injection at
at least these points:

- before external send;
- after external acceptance but before local receipt persistence;
- after receipt persistence but before ingress acceptance;
- while the ingress reviewer is unavailable;
- during concurrent recovery attempts.

The sink records request bytes, idempotency identity, provider receipt, and call
count so the user can verify redaction and replay behavior.

---

# 5. Capability Profiles

Capability is reported across independent dimensions. Ogra must not compress
these into a single maturity level.

## 5.1 Governance Profile

- `observe`: record controlled boundary activity without enforcement;
- `govern`: apply policy, redaction, approval, ingress review, and evidence.

The default few-line integration uses `govern` on intercepted paths.

## 5.2 Execution Profile

- `inline`: the application SDK executes the provider or tool callback after an
  Edge authorization; a crash after authorization may leave the outcome unknown;
- `edge_mediated`: Edge or a supervised worker owns callback execution and
  receipt persistence.

Edge-mediated execution improves supervision but does not create exactly-once
semantics. Safe recovery still depends on provider capability.

## 5.3 Recovery Capabilities

Each operation declares and proves any combination of:

- `replay_safe` proven by conformance;
- `idempotent` with stable identity;
- `outcome_query` with authoritative evidence;
- `compensatable` with typed, scoped compensation.

When none applies, Ogra persists `unknown_outcome` and blocks blind replay.

## 5.4 Isolation Profile

- `development`: automatically started local daemon;
- `supervised`: explicit lifecycle, endpoint, credentials, and health policy;
- `hardened`: appropriate OS/container, network, filesystem, and secret boundaries.

A development daemon is a process convenience, not a security-isolation claim.

---

# 6. Language-Neutral Protocol

## 6.1 Protocol Authority

The Ogra Protocol, not any SDK class, is authoritative. Core objects use
versioned, language-neutral schemas:

```text
ActionIntent
ActionAttempt
PolicyDecision
RouteDecision
RedactionRecord
ApprovalBinding
ExternalReceipt
IngressFinding
RecoveryDecision
AuditEvent
CapabilityManifest
```

Transport may start with local HTTP and Unix domain sockets. Schema semantics
must not depend on LangChain state, Python object identity, or Electron IPC.

## 6.2 Framework Mapping

Framework adapters translate native lifecycle events into the protocol:

```text
LangChain create_agent
  -> model/tool middleware
  -> Ogra Action protocol

LangGraph
  -> Runtime/context/interrupt/ToolNode mapping
  -> Ogra Action protocol

Other frameworks and languages
  -> native adapter
  -> the same Ogra Action protocol
```

Framework checkpoints remain framework state. Ogra Action/effect records remain
external-side-effect authority. IDs are correlated, not conflated.

---

# 7. Policy, Egress, and Ingress

## 7.1 Egress Modes

Every Ogra-controlled external call receives one deterministic mode:

```text
auto_redact
log_and_proceed
approve_then_egress
blocked
```

Default classification mapping:

| Classification | Default mode |
|---|---|
| Public | `auto_redact` |
| Internal | `auto_redact` or `log_and_proceed` by policy |
| Confidential | `approve_then_egress` |
| Restricted | `blocked` |

No match may silently default to public cloud egress.

## 7.2 Approval Binding

Approval must bind at least:

- canonical payload hash;
- Action and attempt identity;
- policy and redaction rule versions;
- route and destination;
- principal and workspace/scope;
- revision;
- expiry;
- allowed operation.

A payload, destination, policy, scope, revision, or time change invalidates the
approval and requires re-evaluation.

An ordinary approval authorizes exactly one dispatch Attempt. A recovery retry
requires a new recovery approval bound to the new Attempt, original sanctioned
payload, stable identity, and verified recovery decision.

## 7.3 Ingress Review

Every governed model response, tool result, Agent message, or remote result is
untrusted until reviewed.

Results are:

```text
clean
suspicious
malicious
review_unavailable
```

Suspicious or malicious content enters quarantine. Reviewer unavailability
fails closed for governed production modes. An in-process reviewer may be used
for development, but it does not satisfy independent isolation claims.

---

# 8. Durable Recovery Semantics

## 8.1 Authority Boundary

```text
Framework state/checkpoint
  - Agent messages
  - node progress
  - graph routing
  - interrupt/resume cursor

Ogra Action ledger
  - external intent
  - exact payload fingerprint
  - approval binding
  - attempt and idempotency identity
  - external receipt
  - unknown outcome
  - ingress acceptance
  - recovery authority
```

Framework persistence is adopted where useful but never replaces the Ogra
ledger.

## 8.2 Recovery Rules

- Work may be replayed automatically only when conformance proves it
  `replay_safe`; a read-only label alone is insufficient because calls may incur
  cost, rate limits, telemetry, or nondeterministic results.
- Idempotent work may be retried only with the verified stable identity.
- Idempotent retry also requires a valid provider/account/operation scope,
  unexpired deduplication window, matching canonical payload, defined conflict
  behavior, and sufficient outcome retention.
- Queryable work must reconcile before retry.
- Compensatable work requires explicit, scoped compensation authority.
- Non-idempotent and non-queryable work remains `unknown_outcome` until a user or
  adapter provides authoritative evidence.
- Stale approval, policy, payload, scope, revision, lease, or capability causes
  recovery to fail closed.

Ogra does not make a universal exactly-once claim.

## 8.3 Payload Retention and Replay

Audit evidence and replay material are separate. Evidence stores bounded metadata
and hashes by default. When safe retry requires the exact sanctioned payload,
Edge may retain it only as an explicitly replayable, authenticated-encrypted
payload reference with a key identity, retention class, expiry, and audit trail.

A hash-only payload proves identity but cannot be replayed. Expired, deleted, or
undecryptable payload material automatically removes replay eligibility.

---

# 9. Evidence and Audit

The local evidence trail is append-only and hash-linked. It records bounded
metadata and hashes by default, not raw secrets or sensitive payloads.

Every governed Action should be able to answer:

- what was proposed;
- what data classification applied;
- which policy and rule versions decided it;
- what exact payload was approved and sent;
- which attempt reached the external system;
- what receipt or uncertainty remains;
- how ingress was classified;
- which recovery decision was made and why.

Audit scope is Ogra-controlled boundary evidence, not provider-internal
reasoning or system-wide non-repudiation.

---

# 10. First Release Scope

The first release proves generic few-line integration, not a desktop workspace.

Required scope:

1. Versioned Ogra Action Protocol schemas.
2. Python SDK and local Edge runtime.
3. `pip install "ogra[langchain]"` distribution.
4. Drop-in LangChain Agent integration.
5. Development runtime auto-discovery/start.
6. Model and client-side tool interception.
7. Deterministic egress policy, redaction, and approval binding.
8. Persistent Action/effect ledger with attempts and receipts.
9. Explicit `unknown_outcome` and no blind replay.
10. Ingress review, reviewer-unavailable handling, and quarantine.
11. Append-only evidence and verifier.
12. Generic Crash Lab and adapter conformance kit.
13. Sync/async and checkpoint correlation tests.

The first release does not require:

- Ogra Desktop or Studio;
- a custom Agent loop or graph runtime;
- RAG or knowledge-base management;
- M3 memory;
- Agent Groups;
- Skills Market;
- self-building organizations;
- full MCP or A2A transport;
- SaaS multi-tenancy;
- custom prompt-injection models or a validator marketplace.

---

# 11. Acceptance Gates

## 11.1 Time to Value

- A LangChain developer installs and integrates Ogra in under five minutes.
- Default integration changes no more than two to five application lines.
- Existing Agent return values remain compatible.
- The first normal run produces a concise, useful governance summary.

## 11.2 Governance

- Every intercepted model/tool call has an Action ID.
- Policy executes before external send.
- Approval is rejected on any binding mismatch.
- Ingress is not returned to the Agent before review acceptance.
- Coverage limitations are visible.

## 11.3 Recovery

- Intent is durable before callback.
- A crash after external acceptance but before local receipt yields
  `unknown_outcome`.
- Unknown outcomes are never automatically replayed without verified authority.
- Outcome-query and idempotency adapters pass conformance tests.
- Concurrent recovery has a single valid lease holder.

## 11.4 Evidence

- Audit-chain validation is deterministic and reports external anchor status.
- Without an expected or externally anchored head, a valid local chain does not
  prove that tail events were never removed.
- Evidence contains no raw secrets by default.
- The recording sink can prove exact test bytes and call count.
- Claims distinguish Ogra-controlled calls from system-wide behavior.

---

# 12. Ecosystem and Distribution

## 12.1 Package Strategy

Start with one Python distribution and optional extras:

```text
ogra                 # SDK, CLI, local Edge, SQLite, protocol projection
ogra[langchain]      # adds the LangChain integration
ogra[conformance]    # adds Crash Lab and adapter authoring fixtures
ogra[server]         # adds explicitly hosted production-server dependencies
```

`ogra[langchain]` must include everything required for the development
Quickstart, including local Edge and SQLite through the base distribution.

Do not fragment the first release into many distributions. A discovery shim such as
`langchain-ogra` may be considered after the public API stabilizes.

## 12.2 Extension Providers

The ecosystem should grow through typed providers:

- classifiers;
- redactors;
- policy sources;
- model/tool/delegation adapters;
- ingress scanners;
- receipt/outcome reconcilers;
- audit exporters;
- storage backends.

Ogra owns policy, approval, Action/effect, quarantine, recovery, and evidence
authority. External providers propose findings or perform typed operations; they
do not commit authoritative state directly.

## 12.3 Open-Source Release Gate

Before public package release, the repository must have an explicit root
license, contribution guide, security policy, versioning policy, trusted package
publishing, and compatibility matrix. Apache-2.0 is the current recommendation,
but license selection requires an explicit project decision.

---

# 13. Existing Implementation

The existing TypeScript/Electron code contains valuable implemented semantics:

- durable frames and effect ownership;
- payload and approval binding;
- receipts and unknown outcomes;
- recovery leases and revision checks;
- redaction, route, ingress, and audit primitives;
- Tool Broker concepts.

These are behavioral assets, not a requirement to keep the old product shape.

Migration rules:

- extract protocol semantics and state-machine invariants;
- reuse failure matrices and conformance cases;
- do not translate TypeScript line by line into Python;
- do not make the Python SDK depend on Electron or desktop IPC;
- keep current source changes intact until a separate implementation migration
  is explicitly approved.

Earlier Desktop-first plans are superseded by this handbook and the current
Action Runtime development index.

---

# 14. Risks

## 14.1 Invisible Value

If Ogra prints only audit internals, developers will perceive it as governance
tax. The default summary must show concrete outcomes: what was controlled,
redacted, approved, committed, quarantined, or held.

## 14.2 False Security

Few-line integration can create the impression of universal interception. The
runtime must expose coverage, bypass paths, reviewer mode, and capability profiles.

## 14.3 Recovery Overclaim

Ogra cannot manufacture idempotency or outcome queries. Execution ownership,
recovery capabilities, and fallback states must be visible in APIs and product copy.

## 14.4 Framework Coupling

LangChain APIs will evolve. The protocol core and conformance tests must remain
framework-neutral, with adapters versioned independently where needed.

## 14.5 Scope Expansion

Memory, RAG, multi-Agent orchestration, desktop UI, MCP, and cloud control planes
can each consume the project. None may enter the first release unless it is
required to prove the generic Action contract.

---

# 15. Roadmap

## Phase 0: Contract Extraction

- freeze Action and evidence schemas;
- map existing TypeScript invariants;
- define capability profiles and conformance fixtures;
- decide license and package ownership.

## Alpha: Python-First Generic Integration

- local Edge runtime;
- Python SDK;
- LangChain integration;
- governed handling for model and tool calls;
- persistent unknown-outcome safety;
- evidence verifier;
- generic Crash Lab.

## Beta: Recovery Ecosystem

- recovery-capability manifests and conformance;
- outcome query, idempotency, and compensation providers;
- LangGraph-native mapping;
- TypeScript SDK and a second framework integration;
- early Studio approval/evidence view if required by adoption.

## v1: Hardened Multi-Stack Runtime

- hardened deployment profile;
- hardened remote Edge transport and secrets;
- Ogra Studio;
- managed Ogra Cloud option;
- additional language and framework SDKs;
- MCP/A2A integration through the same Action contract.

---

# 16. External Messaging

Recommended homepage statement:

```text
Add Ogra to your Agent in a few lines.
Control every model and tool call before it leaves,
review every result when it returns,
and never silently replay an unknown action.
```

Recommended proof points:

1. Generic LangChain Quickstart on an existing Agent.
2. Expandable evidence from a normal model/tool run.
3. Generic Crash Lab proving unknown-outcome and replay behavior.
4. Capability matrix showing governance, execution, recovery, and isolation profiles.

Do not lead with Desktop, RAG, Memory, Agent Group, governance centers, or a
specific business scenario.

---

# 17. Final Principles

1. **The product boundary is language- and framework-neutral.**
2. **Python is the first stack, not the market definition.**
3. **Few-line integration is a release requirement.**
4. **Every controlled external call becomes an Action.**
5. **Data is controlled before egress.**
6. **External results are reviewed before Agent observation.**
7. **Intent is durable before callback.**
8. **Unknown outcomes are never blindly replayed.**
9. **Recovery guarantees follow verified provider capability.**
10. **Evidence scope is explicit and honest.**
11. **The protocol, not a framework adapter, is authoritative.**
12. **Build the Action runtime before expanding into workspace features.**

---

End of handbook.
