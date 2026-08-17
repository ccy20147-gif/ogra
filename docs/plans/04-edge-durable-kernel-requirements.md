# Edge Durable Kernel Requirements

> Milestone: M1
>
> Requirement prefix: `EDGE`

## 1. Scope

Ogra Edge is the framework-neutral authority for Action state, policy decisions,
attempts, approvals, receipts, ingress status, recovery decisions, and evidence.
This milestone builds the durable kernel before framework integration.

## 2. Module Boundary

```text
protocol DTOs
  -> command/query application layer
  -> domain state machines and ports
  -> SQLite, transport, crypto, scanner, and provider adapters
```

The domain MUST NOT import LangChain, Electron, provider SDKs, HTTP frameworks,
or SQLite implementations.

## 3. Storage Model

The first implementation SHOULD use SQLite WAL with migrations, transactional
snapshot tables, and an append-only audit table written in the same transaction.
It MUST NOT require full event sourcing.

Minimum durable records:

- runs and Actions;
- attempts and dispatch grants;
- payload references and retention metadata;
- policy, route, redaction, and approval decisions;
- receipts and ingress findings;
- recovery decisions and leases;
- audit events, schema migrations, and runtime identity.

## 4. Normative Requirements

- **EDGE-001**: Intent MUST commit before a dispatch grant or callback.
- **EDGE-002**: State mutation and its audit event MUST commit atomically.
- **EDGE-003**: Every mutation MUST use expected revision or equivalent CAS.
- **EDGE-004**: Command identities MUST make client retries idempotent.
- **EDGE-005**: Recovery leases MUST use monotonic fencing tokens, not only TTL.
- **EDGE-006**: A stale lease holder MUST be unable to mutate recovery state.
- **EDGE-007**: Startup MUST scan incomplete Attempts and apply the protocol
  transition table without invoking providers automatically.
- **EDGE-008**: `unknown_outcome` MUST survive restart, migration, export, and
  client reconnect.
- **EDGE-009**: Receipt authority MUST be bound to Action, Attempt, destination,
  request identity, receipt kind, authority, effect status, and provider evidence.
- **EDGE-010**: Framework checkpoints and callbacks MUST remain correlation data,
  never receipt authority.

## 5. Command and Query Surface

The minimum API MUST support:

- health, runtime identity, and protocol negotiation;
- create/query/list Run and Action;
- accept and persist typed policy/route/approval decisions through domain ports;
- prepare Attempt and issue/consume DispatchGrant;
- record acknowledgement, result, failure, or uncertainty;
- submit approval and ingress decision;
- acquire/renew/release recovery lease;
- request reconciliation or manual resolution;
- inspect and verify bounded evidence.

- **EDGE-011**: Queries MUST not mutate recovery or lease state.
- **EDGE-012**: Administrative resolution MUST identify actor, reason, prior
  state, and evidence.
- **EDGE-013**: API errors MUST use the protocol error envelope.
- **EDGE-021**: M1 MUST use test decision adapters only; production
  classification, policy evaluation, approval, and ingress engines belong to M2.
- **EDGE-022**: Run and Action creation MUST enforce stable submission-key
  uniqueness and return the existing identity after response loss.

## 6. Audit Integrity

- **EDGE-014**: Audit events MUST be append-only and hash-linked.
- **EDGE-015**: The verifier MUST detect mutation, reordering, broken links, and
  truncation when an expected head is supplied.
- **EDGE-016**: Product claims MUST say tamper-evident, not immutable, unless an
  external anchor exists.
- **EDGE-017**: Evidence MUST omit raw secrets and payloads by default.

## 7. Concurrency and Failure Tests

The test harness MUST terminate the process, reopen the database, and verify
state at each boundary:

1. before Action commit;
2. after Action commit and before grant;
3. after grant and before acknowledgement;
4. after acknowledgement and before result;
5. after result and before ingress decision;
6. after ingress decision and before commit;
7. during concurrent recovery lease acquisition;
8. during migration and audit append.
9. after server commit and before the client receives the created identity.

- **EDGE-018**: Tests MUST use real process termination for crash claims.
- **EDGE-019**: Database reopen MUST never infer provider success from local
  progress alone.
- **EDGE-020**: Concurrent commands MUST produce one legal revision history.

## 8. Acceptance Gates

- all kill/reopen points result in a legal, explainable state;
- twenty concurrent clients cannot create conflicting runtime ownership;
- a second process can query the first process's run and verify evidence;
- stale revision and stale fencing-token tests fail before mutation;
- audit and snapshot state agree after every successful command.

## 9. Non-Goals

- framework orchestration or graph scheduling;
- provider-specific business logic in the domain;
- distributed consensus or multi-region replication;
- full event sourcing;
- silently repairing unknown external outcomes.
