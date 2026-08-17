# Ogra Planning Workspace

This repository contains the current product guidance and implementation research
for **Ogra / Ogra Edge**.

## Current Source of Truth

- [Ogra Product Handbook](ogra-product-handbook.md)
- [Development Requirements Index](docs/plans/00-development-requirements-index.md)
- [Python-First Action Runtime Quickstart](docs/plans/01-python-first-action-runtime-quickstart.md)

The handbook is the highest-priority product and technical guidance. Earlier
Desktop-first plans are superseded.

## Current Product Direction

Ogra is a language- and framework-neutral runtime for governing and recovering
AI Agent actions.

> **Control every Agent call before it leaves. Recover safely, or stop when the
> outcome is unknown.**

Every Ogra-controlled model or tool call becomes an `Action` with:

- deterministic data classification, policy, and routing;
- redaction or payload-bound approval before egress;
- durable intent before the external callback;
- receipt or explicit `unknown_outcome` after the callback;
- ingress review before the result reaches the Agent;
- verifiable local evidence and recovery state.

Python is the first implementation stack. LangChain and LangGraph are the first
integrations. They are not the product boundary.

## Generic Quickstart Contract

The first public experience must add Ogra to an ordinary LangChain Agent in a
few lines:

```bash
pip install "ogra[langchain]"
```

```python
from ogra.langchain import create_ogra_agent

agent = create_ogra_agent(model=model, tools=tools)
result = agent.invoke(input)
```

In development, the SDK may automatically discover or start a local Ogra Edge
daemon. Production deployment uses an explicit endpoint and supervised runtime.

A normal run keeps the framework return value and emits a concise summary:

```text
OGRA governed | model_calls=1 | tool_actions=2 | redacted=3 |
approvals=1 | ingress=clean | audit=verified | run=ogra://run_123
```

No business-specific scenario is required. A separate generic Crash Lab proves
fault behavior and adapter recovery capability.

## Capability Levels

| Level | Meaning |
|---|---|
| L1 Observe | Record controlled model/tool boundary activity without enforcement. |
| L2 Govern | Apply policy, redaction, approval, ingress review, and evidence. |
| L3 Recover | Reconcile or safely retry through verified adapter capabilities. |
| L4 Isolate | Run with hardened process, credential, network, and filesystem boundaries. |

Ordinary integrations receive L2 value. L3 requires provider support for
idempotency, outcome query, or compensation. When an outcome cannot be proven,
Ogra persists `unknown_outcome` and blocks blind replay.

## Product Surfaces

- **Ogra Protocol**: versioned, language-neutral Action and evidence schemas.
- **Ogra SDKs**: low-friction framework and language integration.
- **Ogra Edge**: local policy, Action ledger, recovery, ingress, quarantine, and audit runtime.
- **Ogra Studio**: later approval, quarantine, recovery, and evidence UI.
- **Ogra Cloud**: optional future managed runtime and team control plane.

The existing Electron application is an implementation reference and possible
future Studio foundation. It is no longer the primary product shape.

## First Release Scope

The first release focuses on:

1. Ogra Action Protocol schemas.
2. Python SDK and local Ogra Edge runtime.
3. Drop-in LangChain integration.
4. Model and client-side tool interception.
5. Egress policy, redaction, and approval binding.
6. Persistent intent, attempts, receipts, and unknown outcomes.
7. Ingress review, quarantine, and reviewer-unavailable behavior.
8. Append-only evidence and verifier.
9. Generic Crash Lab and adapter conformance tests.

It does not require Desktop, RAG, M3 Memory, Agent Groups, Skills Market, a
custom Agent loop, SaaS multi-tenancy, or a validator marketplace.

## Repository Map

```text
.
├── AGENTS.md
├── README.md
├── ogra-product-handbook.md
├── docs/
│   └── plans/
│       ├── 00-development-requirements-index.md
│       └── 01-python-first-action-runtime-quickstart.md
├── ogra-desktop/        # existing TypeScript semantic reference
└── archive/             # historical context only
```

## Existing Implementation

The TypeScript/Electron implementation contains valuable durable-execution,
policy, approval, redaction, ingress, Tool Broker, receipt, and audit semantics.
The new Python implementation should extract protocol invariants and fault
tests, not translate the existing code line by line.

Existing source changes are intentionally preserved until a separate migration
is approved.

## Repository Workflow

- Current direction branch: `ogra-action-runtime-v0.2`.
- Do not assume a clean worktree.
- Do not stage, commit, or push unless explicitly requested.
- Keep this README and the handbook synchronized when product direction changes.
- Use `archive/` only as historical context.

## Naming

- Product: `Ogra`.
- Local/runtime component: `Ogra Edge`.
- Do not reintroduce the archived `Orga` spelling.
