# Ogra Action Runtime Implementation Roadmap

> Status: active
>
> Planning model: exit-gate driven, not calendar driven
>
> Public target: Python-first Alpha with LangChain integration

## 1. Outcome

The roadmap exists to produce one credible public experience:

```bash
pip install "ogra[langchain]"
```

```python
from ogra.langchain import create_ogra_agent

agent = create_ogra_agent(model=model, tools=tools)
result = agent.invoke(input)
```

That experience must prove, on any ordinary Agent:

- what model and tool calls crossed an Ogra-controlled boundary;
- what data policy allowed, redacted, approved, or blocked;
- what durable Action and evidence were created;
- what recovery capability actually exists;
- that uncertain external results stop at `unknown_outcome` instead of being
  silently replayed.

The public Alpha does not ship until both the normal governed run and the Crash
Lab recovery proof are real.

## 2. Planning Decisions

The architecture review converged on these decisions:

1. Build a thin vertical slice early, but make language-neutral schemas and
   failure semantics authoritative before public API stability.
2. Keep one user-facing Python distribution initially; keep internal module
   boundaries strict enough for later SDKs.
3. Separate Action, Attempt, Ingress, and RecoveryDecision state.
4. Treat governance, execution, recovery, and isolation as independent profiles.
5. Distinguish inline SDK execution from Edge-mediated execution in every API,
   receipt, summary, and claim.
6. Use SQLite snapshots plus an append-only audit chain, not full event sourcing.
7. Store replayable sanctioned payloads only under explicit encrypted retention;
   hash-only records are evidence, not replay material.
8. Make conformance tests the authority for adapter recovery claims.

## 3. Target Architecture

```text
Agent application
  -> framework adapter
  -> Ogra SDK
  -> Ogra Protocol over local HTTP/Unix socket
  -> Ogra Edge command/query API
  -> domain state machines + policy + recovery authority
  -> SQLite ledger + append-only evidence
  -> inline dispatch grant OR Edge-mediated adapter
  -> external model/tool/provider
```

Target repository boundaries:

```text
spec/                         JSON Schema, OpenAPI, state tables, golden vectors
python/src/ogra/protocol/     generated or schema-validated DTOs only
python/src/ogra/sdk/          client, discovery, run and approval APIs
python/src/ogra/edge/domain/  state machines, policy and recovery invariants
python/src/ogra/edge/app/     commands, queries and transaction orchestration
python/src/ogra/edge/adapters SQLite, transport, scanners and providers
python/src/ogra/langchain/    the only Python module that imports LangChain
python/src/ogra/testing/      Crash Lab and conformance utilities
examples/                     generic runnable integrations
```

These may ship in one `ogra` distribution. Physical package count must not blur
dependency direction: adapters depend on protocol and ports; the domain does not
depend on LangChain, Electron, or provider SDKs.

## 4. Execution Profiles

### Inline

Edge persists intent and returns a payload-bound dispatch grant. The application
process invokes the provider or Python tool and reports the result.

This supports governed handling and durable uncertainty. Once a grant may have
been used, loss of the application process can only become `unknown_outcome`
unless the operation has authoritative outcome query or stable idempotency.

### Edge-Mediated

Edge or a supervised worker owns the adapter callback and receipt persistence.
This enables stronger supervision and credential isolation, but still does not
create exactly-once semantics. Recovery remains operation-capability dependent.

## 5. Milestone Dependency Graph

```text
M0 Protocol and decision records
  -> M1 Durable kernel
       -> M2 Governance and data handling
       M1 + M3 -> integrated SDK/runtime
  -> M3 Python SDK and discovery against a fake Edge
            M2 + integrated SDK/runtime -> M4 LangChain governed Alpha
       M1 + M2 + M3 -> M5 Recovery and Crash Lab
            M4 + M5 -> M6 Public Alpha
  -> M7 Cross-language and adapter ecosystem
```

M3 may begin after the M0 wire contract using a fake Edge. M2 begins after the
M1 domain ports stabilize; SDK/runtime integration still depends on M1.
M5 begins its recording sink and process-kill harness during M1 so recovery is
tested as architecture, not appended at release time.

## 6. Milestones

### M0: Protocol and Architecture Freeze

Deliver:

- JSON Schema 2020-12 protocol objects and OpenAPI command/query surface;
- Action, Attempt, Ingress, and RecoveryDecision transition tables;
- canonical JSON and hashing rules;
- execution, governance, recovery, and isolation profile definitions;
- error envelope, version negotiation, golden vectors, and ADR-001 through ADR-010.

Exit gate:

- Python and a minimal TypeScript validator pass the same vectors;
- schemas contain no Python, LangChain, Electron, or SQLite types;
- non-idempotent, non-queryable unknown outcomes have no automatic replay path.

Requirements: [03](03-protocol-and-state-machine-requirements.md).

### M1: Edge Durable Kernel

Deliver:

- framework-neutral Edge service and local transport;
- SQLite WAL migrations and transactional Action ledger;
- attempts, receipts, payload references, revisions, fencing leases, and audit;
- startup recovery scan and command idempotency.

Exit gate:

- kill/reopen tests pass at every transaction boundary;
- a second client process can query the same run and evidence;
- concurrent recovery has one valid fencing-token holder;
- audit verification detects mutation and truncation within its documented scope.

Requirements: [04](04-edge-durable-kernel-requirements.md).

### M2: Governance and Data-Handling Pipeline

Deliver:

- deterministic classification, routing, redaction, and blocking;
- exact-payload approval binding;
- ingress review and quarantine;
- encrypted replayable payload storage and hash-only mode;
- high-signal evidence projection without raw secrets.

Exit gate:

- the recording sink proves exact allowed/redacted bytes;
- any payload, destination, policy, scope, revision, or expiry mismatch blocks;
- unsafe or unreviewed ingress never reaches the Agent;
- hash-only Actions are mechanically ineligible for replay.

Requirements: [05](05-governance-evidence-and-data-handling-requirements.md).

### M3: Python SDK and Runtime Discovery

Deliver:

- sync and async protocol client;
- `OGRA_ENDPOINT` production connection;
- development daemon discovery and single-start locking;
- `ogra doctor`, `ogra run show`, and `ogra audit verify`;
- protocol handshake and explicit degraded/fail-closed behavior.

Exit gate:

- concurrent clients start or reuse one healthy daemon;
- stale registry, PID reuse, migration failure, and protocol mismatch are tested;
- production never silently falls back to in-process or development mode.

Requirements: [06](06-python-sdk-runtime-discovery-requirements.md).

### M4: LangChain Governed Alpha

Deliver:

- `create_ogra_agent` and composable middleware;
- model and client-side tool interception;
- run/thread/checkpoint correlation;
- governed sync, async, parallel tools, and buffered streaming;
- normal-run summary, evidence link, and coverage report.

Exit gate:

- an existing Agent is governed with a two-to-five-line change;
- return values, callbacks, and supported tracing remain compatible;
- bypassed provider-native tools and direct SDK calls are visibly out of scope;
- clean-environment time to first governed run is under five minutes.

Requirements: [07](07-langchain-integration-requirements.md).

### M5: Recovery, Crash Lab, and Adapter Conformance

Deliver:

- operation-scoped capability manifests;
- idempotent retry, outcome reconciliation, compensation, and manual resolution;
- recovery leases and stable identities;
- external recording model/tool sink;
- real process termination at all required failure windows;
- independently runnable adapter conformance suite.

Exit gate:

- external call count, Attempts, and receipts match the expected truth table for
  each failure window, including intentional unknown gaps;
- supported adapters reconcile or retry only with verified authority;
- unsupported outcomes remain unknown with zero blind replay;
- Crash Lab and production Edge use the same state-machine implementation.

Requirements: [08](08-recovery-crash-lab-and-conformance-requirements.md).

### M6: Public Alpha

Deliver:

- trusted PyPI publishing for one `ogra` distribution, with base and
  `[langchain]` installation smoke tests;
- homepage Quickstart and generic examples;
- license, contribution, security, support, and versioning policies;
- compatibility matrix, provenance, SBOM, and release rollback procedure.

Exit gate:

- M2, M4, and M5 gates all pass in release CI;
- at least five independent pre-release developers test the Quickstart, at least
  80% finish in five minutes, and at least 70% name a concrete normal-run value;
- external developers can explain normal-run value without a domain demo;
- external users can distinguish committed from unknown outcomes;
- no supported crash window produces an unproven duplicate execution.

Requirements: [09](09-release-and-cross-language-ecosystem-requirements.md).

### M7: Cross-Language and Ecosystem Proof

Deliver:

- TypeScript SDK and a second framework integration;
- LangGraph-native mapping;
- provider, scanner, policy, storage, and reconciler extension interfaces;
- generated capability matrix and conformance-backed compatibility badge.

Exit gate:

- Python-created interrupted runs are queryable from TypeScript and vice versa;
- both SDKs produce identical canonical hashes for golden vectors;
- a third-party adapter passes conformance without changing Edge.

Requirements: [09](09-release-and-cross-language-ecosystem-requirements.md).

## 7. Public Release Boundary

M4 is an internal governed preview, not the complete product. M5 is an internal
recovery proof, not a usable distribution. Public Alpha requires both.

Do not publish the complete Ogra claim when any of these is true:

- normal runs produce only audit noise;
- recovery uses mocks instead of real process termination;
- an unknown result is mapped to failure and retried;
- inline and Edge-mediated guarantees are indistinguishable;
- reviewer failure allows governed content to pass;
- the Quickstart depends on a refund or other domain-specific fixture.

## 8. Product Validation Gates

Before Beta planning:

- at least 10 external developers across at least three Agent/tool categories;
- at least 80% reach a governed run in five minutes;
- at least 70% can name a concrete normal-run benefit without Crash Lab;
- all participants can distinguish `committed` and `unknown_outcome`;
- at least five developers run Crash Lab against their own adapter or tool;
- zero blind replay in every unresolved conformance case.

These are validation targets, not guarantees that justify weakening safety gates.

## 9. Required ADRs

1. ADR-001: JSON Schema, OpenAPI, canonical JSON, and hashing.
2. ADR-002: Action, Attempt, Ingress, and Decision state separation.
3. ADR-003: SQLite snapshots plus append-only audit.
4. ADR-004: inline and Edge-mediated execution guarantees.
5. ADR-005: discovery, locking, local authentication, and production fail-closed.
6. ADR-006: sanctioned payload encryption, retention, and replay eligibility.
7. ADR-007: LangChain middleware order, approval, streaming, and cancellation.
8. ADR-008: operation-scoped adapter capability and conformance trust.
9. ADR-009: protocol negotiation and cross-language compatibility.
10. ADR-010: tamper-evident audit claim and external anchoring boundary.

No ADR may weaken the handbook invariants without updating the handbook first.
