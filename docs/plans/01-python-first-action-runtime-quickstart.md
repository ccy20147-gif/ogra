# Python-First Action Runtime Quickstart Contract

> Layer: first public developer experience
>
> Product boundary: language- and framework-neutral
>
> First implementation: Python
>
> First integration: LangChain `create_agent`
>
> Status: active contract, not yet implemented

## 1. Goal

A developer must be able to add Ogra to an ordinary LangChain Agent in under
five minutes and immediately see useful governance and evidence for real model
and tool calls.

The Quickstart is generic. It must not depend on a refund, healthcare, finance,
or other business-specific scenario.

## 2. Public Experience Budget

Installation:

```bash
pip install "ogra[langchain]"
```

Target application change:

```python
from ogra.langchain import create_ogra_agent

agent = create_ogra_agent(model=model, tools=tools)
result = agent.invoke(input)
```

The final API may use a factory or middleware object, but the default case must
remain a drop-in two-to-five-line change. Users must not manually assemble a
policy engine, ledger, reviewer, or checkpointer to see value.

## 3. Runtime Discovery

The Python SDK resolves Edge in this order:

1. Use explicit `OGRA_ENDPOINT` and credentials.
2. Reuse a healthy local daemon registered for the selected data directory.
3. In development mode, acquire a file lock and start one local daemon.
4. Fail with a specific diagnostic when startup or migration is unsafe.

Development auto-start must expose:

- daemon PID;
- endpoint or socket;
- persistent data directory;
- protocol version;
- health and migration state;
- actual governance, execution, recovery, and isolation profiles.

Auto-start is a development process boundary, not hardened security isolation.

Production mode requires explicit endpoint, credentials, lifecycle ownership,
and health policy. It must never silently fall back to an in-process runtime.

## 4. LangChain Mapping

The integration maps:

| LangChain surface | Ogra behavior |
|---|---|
| Agent start | create or correlate the Ogra run |
| Model request | classify, route, redact/approve, persist Action intent |
| Model response | persist receipt metadata, review ingress, accept/quarantine |
| Tool call | validate schema/scope, apply policy/approval, persist Action intent |
| Tool result | persist receipt, review ingress, accept/quarantine |
| Interrupt/resume | map user decision to a bound Ogra approval or escalation |
| Agent completion | seal the summary and evidence packet |

Ogra should be the outermost governance middleware in the supplied factory. The
factory must compose with user middleware while preserving documented ordering.

Direct provider SDK calls, provider-native tools, unwrapped subgraphs, and
external processes are outside coverage unless separately adapted.

## 5. Normal-Run Behavior

The integration preserves the ordinary LangChain return value. It emits one
high-signal summary through logging, callback events, or the configured output
channel:

```text
OGRA governed | destination=openai:gpt-4.1-mini + tools:1 |
classification=public | policy=allowed | execution=inline |
recovery=unknown_if_interrupted | isolation=development |
coverage=model+client_tools | ingress=clean |
audit=chain_valid | anchor=none | run=run_123
inspect: ogra run show run_123
```

When redaction or approval is needed, the summary reports the actual activity:

```text
OGRA governed | model_calls=1 | tool_actions=2 | redacted=3 |
approvals=1 | execution=inline | ingress=clean |
audit=chain_valid | anchor=none | run=run_124
inspect: ogra run show run_124
```

Expandable evidence includes:

- Action and attempt IDs;
- destination and operation;
- data classification and policy reasons;
- canonical payload hash;
- redaction and policy versions;
- approval binding when present;
- adapter recovery capability;
- receipt or `unknown_outcome`;
- ingress findings;
- audit-chain verification.

Raw secrets and sensitive payloads are excluded by default.

## 6. Default Safety Contract

For every intercepted external call, the runtime must:

1. derive the Action and destination;
2. compute the data high-water mark;
3. evaluate deterministic policy;
4. redact, approve, allow, or block;
5. persist intent before invoking the callback;
6. persist an attempt and any authoritative receipt;
7. mark a send-window failure as `unknown_outcome` unless outcome evidence exists;
8. review the external result before returning it to the Agent;
9. append verifiable evidence.

Reviewer unavailability fails closed in governed production mode.

## 7. Recovery Capabilities

### Conformance-Proven Replay Safe

May be replayed under the current policy and revision. A `read_only` label alone
is insufficient because calls can still incur cost, rate limits, telemetry, or
nondeterministic results.

### Idempotent

May be retried only with the verified stable idempotency identity.

### Outcome-Queryable

Must query and reconcile the external result before considering retry.

### Compensatable

May compensate only through an approved, typed compensation Action.

### Non-Idempotent and Non-Queryable

Must remain `unknown_outcome`, block automatic replay, and request a user or
adapter decision.

The Quickstart must communicate actual adapter capability. It may not present
all tools as automatically recoverable.

## 8. Adapter Declaration

An advanced tool may opt into stronger recovery with a concise declaration:

```python
@ogra.action(
    idempotency=stable_action_key,
    reconcile=query_external_outcome,
)
def external_action(...):
    ...
```

Exact decorator names are not fixed by this contract. The requirements are:

- a stable identity derived from canonical Action inputs;
- an outcome query that returns authoritative evidence;
- declared duplicate and retry risks;
- conformance tests before advertising recoverability.

Tools without this declaration still receive governed handling, durable intent,
explicit unknown state, and no blind replay.

## 9. Crash Lab

Crash Lab is a framework-neutral proof suite, not a domain demo.

It provides:

- an OpenAI-compatible recording model endpoint;
- a typed recording tool endpoint;
- deterministic request-byte capture;
- idempotency and outcome-query fixtures;
- fault injection controlled by Edge, not a catchable application exception.

Required windows:

```text
before_send
after_remote_accept_before_receipt
after_receipt_before_ingress
ingress_reviewer_unavailable
after_ingress_before_observation
concurrent_recovery
```

For each window, the suite verifies:

- exact external call count;
- request bytes and redaction assertions;
- Action and attempt state;
- approval validity;
- receipt or unknown state;
- recovery decision;
- audit-chain integrity.

## 10. Protocol Boundary

The Python adapter maps to versioned language-neutral objects:

```text
ActionIntent
ActionAttempt
PolicyDecision
ApprovalBinding
ExternalReceipt
IngressFinding
RecoveryDecision
AuditEvent
CapabilityManifest
```

The schemas and conformance suite must be reusable by TypeScript and future
SDKs. Python objects and LangChain state are projections, not protocol authority.

## 11. Compatibility Requirements

- supported Python versions are explicit;
- supported LangChain/LangGraph ranges are tested in CI;
- sync and async invocation have equivalent governance semantics;
- streaming is buffered or gated until governed content is safe to release;
- middleware ordering is deterministic;
- framework checkpoint IDs are correlated but never treated as external receipts;
- SDK/runtime protocol negotiation fails clearly on incompatibility.

## 12. Acceptance Tests

### Developer Experience

- clean environment to first governed run in under five minutes;
- no more than two to five integration lines;
- no required domain fixture;
- normal Agent return value remains compatible;
- evidence reference is available after every controlled run.

### Egress

- confidential fixture cannot leave without bound approval;
- payload mutation invalidates approval;
- exact test request bytes contain no configured PII after redaction;
- Ogra-controlled scope is stated in output.

### Ingress

- suspicious result never reaches the Agent observation;
- reviewer unavailability fails closed in production mode;
- quarantine evidence excludes unsafe raw display by default.

### Recovery

- intent is durable before callback;
- send-window crash yields `unknown_outcome`;
- unknown result is never blindly replayed;
- idempotent retry reuses the stable identity;
- outcome query reconciles before retry;
- stale approval, policy, revision, scope, or lease fails closed.

### Evidence

- audit chain validates from persisted events, with anchor scope reported;
- evidence is available across client-process restart;
- raw secrets are absent by default;
- Crash Lab call count, Attempts, and receipts match the failure-window truth
  table, including explicit unknown gaps.

## 13. Non-Goals

This contract does not require:

- a desktop shell;
- a custom Agent loop;
- a custom LangGraph checkpointer;
- RAG, memory, or multi-Agent orchestration;
- system-wide DLP or network monitoring;
- universal exactly-once execution;
- security isolation from an auto-started development daemon.
