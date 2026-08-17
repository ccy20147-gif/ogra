# Ogra Development Requirements Index

> Direction: language-neutral Agent Action Runtime
>
> First stack: Python
>
> First integrations: LangChain and LangGraph
>
> Status: active

## 1. Product Contract

Ogra turns every Ogra-controlled model or tool call into a governed,
recoverable, and verifiable Action.

```text
classify
  -> policy and route
  -> redact or block
  -> bind exact approval
  -> persist intent
  -> invoke
  -> receipt or unknown outcome
  -> ingress review
  -> commit, quarantine, reconcile, or escalate
  -> verifiable evidence
```

The first release must make this value available through a two-to-five-line
change to an ordinary LangChain Agent.

## 2. Active Documents

1. [Ogra Product Handbook](../../ogra-product-handbook.md)
   - product positioning, Action semantics, capability levels, scope, safety,
     roadmap, and external messaging.

2. [Python-First Action Runtime Quickstart](01-python-first-action-runtime-quickstart.md)
   - public integration contract, runtime discovery, observable behavior,
     protocol objects, recovery levels, conformance, and release gates.

Earlier Desktop-first implementation plans are superseded and are not active
requirements for the new product direction.

## 3. Non-Negotiable Invariants

1. Python is the first stack, not the product boundary.
2. The Ogra Protocol is language- and framework-neutral.
3. Default integration changes no more than two to five application lines.
4. Every intercepted external call receives an Action ID.
5. Policy and approval complete before external send.
6. Approval binds the exact payload, destination, policy, scope, revision, and expiry.
7. External intent is durable before callback.
8. Timeout or crash after send produces `unknown_outcome` unless authoritative evidence exists.
9. Unknown outcomes are never silently replayed.
10. Recovery behavior follows conformance-tested adapter capability.
11. External results are untrusted until ingress review accepts them.
12. Audit evidence is append-only, hash-linked, and excludes raw secrets by default.
13. Product claims cover Ogra-controlled paths only.
14. Framework checkpoints never replace the Ogra Action ledger.

## 4. Current Development Sequence

### Sequence 0: Contract Extraction

- define versioned Action and evidence schemas;
- map reusable invariants from the TypeScript implementation;
- preserve current fault and recovery behavior as conformance fixtures;
- decide package ownership, license, and release process.

Exit gate: schemas and state transitions can be implemented without importing
Electron, LangChain, or TypeScript runtime types.

### Sequence 1: Python Local Runtime

- implement Ogra Edge local daemon and persistent store;
- implement Action, attempt, receipt, approval, ingress, and audit services;
- implement SDK discovery and development auto-start;
- implement explicit production endpoint configuration.

Exit gate: a framework-neutral client can submit and inspect an Action across a
client-process restart.

### Sequence 2: Generic LangChain Integration

- implement the drop-in Agent factory or equivalent middleware wrapper;
- intercept model calls and client-side tool calls;
- correlate LangChain run/thread/checkpoint IDs without making them authoritative;
- preserve ordinary Agent return values;
- emit a concise governance summary and evidence reference.

Exit gate: an existing LangChain Agent gains L2 governance through a
two-to-five-line change.

### Sequence 3: Recovery and Crash Lab

- implement adapter capability manifests;
- implement idempotency and outcome-query reconciliation;
- implement unknown-outcome blocking and manual escalation;
- implement deterministic failure injection and recording sink;
- verify concurrent recovery lease behavior.

Exit gate: the Crash Lab proves exact request bytes, call count, unknown state,
and no blind replay at every required failure window.

### Sequence 4: Ecosystem Expansion

- publish LangGraph-native mapping;
- publish TypeScript SDK and a second framework integration;
- add provider/scanner/reconciler interfaces and conformance suites;
- evaluate Studio only after developer adoption proves a UI need.

Exit gate: a second language or framework uses the same protocol and passes the
same Action conformance tests.

## 5. Explicit Non-Goals for the First Release

- custom Agent loop or graph runtime;
- custom checkpointer;
- Ogra Desktop as the primary distribution;
- RAG and knowledge-base product;
- M3 Memory;
- Agent Groups;
- Skills Market;
- self-building organizations;
- full MCP/A2A transport;
- SaaS multi-tenancy;
- custom prompt-injection model;
- validator marketplace.

## 6. Release Gates

- under-five-minute time to first governed run;
- two-to-five-line default integration;
- sync and async compatibility;
- visible coverage and bypass limitations;
- deterministic approval-binding rejection tests;
- ingress reviewer fail-closed tests;
- crash-window and unknown-outcome tests;
- audit-chain verification;
- no raw secrets in evidence by default;
- root license, contribution, security, and versioning policies;
- trusted package publishing and compatibility matrix.
