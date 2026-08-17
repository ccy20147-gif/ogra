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
   - product positioning, Action semantics, capability profiles, scope, safety,
     roadmap, and external messaging.

2. [Python-First Action Runtime Quickstart](01-python-first-action-runtime-quickstart.md)
   - public integration contract, runtime discovery, observable behavior,
     protocol objects, recovery capabilities, conformance, and release gates.

3. [Action Runtime Implementation Roadmap](02-action-runtime-implementation-roadmap.md)
   - milestone order, dependency graph, public release boundary, and requirement
     document ownership.

4. Milestone requirements:
   - [Protocol and State Machine](03-protocol-and-state-machine-requirements.md)
   - [Edge Durable Kernel](04-edge-durable-kernel-requirements.md)
   - [Governance, Evidence, and Data Handling](05-governance-evidence-and-data-handling-requirements.md)
   - [Python SDK and Runtime Discovery](06-python-sdk-runtime-discovery-requirements.md)
   - [LangChain Integration](07-langchain-integration-requirements.md)
   - [Recovery, Crash Lab, and Conformance](08-recovery-crash-lab-and-conformance-requirements.md)
   - [Release and Cross-Language Ecosystem](09-release-and-cross-language-ecosystem-requirements.md)

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
15. Inline and Edge-mediated execution expose different guarantees.
16. Recovery, execution, governance, and isolation are independent profiles.
17. Replayable payload storage is encrypted and explicitly retained; hash-only
    storage is never treated as replayable.

## 4. Current Development Sequence

The authoritative sequence and exit gates are maintained in the
[Action Runtime Implementation Roadmap](02-action-runtime-implementation-roadmap.md).

The public Alpha gate requires both the generic governed Quickstart and the real
Crash Lab recovery proof. Internal milestones may land separately, but neither
data-egress governance nor recovery may be represented as the complete product
while the other remains a mock.

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
