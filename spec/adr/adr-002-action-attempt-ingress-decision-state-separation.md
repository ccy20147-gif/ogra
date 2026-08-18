# ADR-002: Action, Attempt, Ingress, and Decision State Separation

- **Status**: Accepted
- **Date**: 2026-08-17
- **Applies to**: M0 Protocol Freeze; M1 Durable Kernel
- **Related**: PROT-011, PROT-012, PROT-013, PROT-014, PROT-015; handbook §2.2

## Context

A crash after external acceptance, an unknown outcome, an ingress review,
and a recovery retry are different facts that a single "effect state" string
cannot express without either lying or inventing states like `safe_retry` or
`reconciled`. The pre-M0 TypeScript code conflated phases; M0 must freeze the
separation before any durable kernel work.

## Decision

Four independent state machines, each with its own machine-readable
transition table under `spec/v0alpha1/state-machines/`:

1. **Action** — the user-visible aggregate: `proposed -> authorized ->
   executing -> result_received -> committed`, plus `blocked`, `cancelled`,
   `failed_authoritative`, `unknown_outcome`, `quarantined`,
   `review_unavailable`. `safe_retry` and `reconciled` are NOT Action states.
2. **ActionAttempt** — one physical callback. `prepared ->
   dispatch_authorized -> acknowledged -> response_received`, plus
   `cancelled`, `failed_local`, `failed_authoritative`, and `unknown`
   (terminal). A retry is always a NEW Attempt.
3. **Ingress** — `pending -> accepted | quarantined | review_unavailable`,
   `quarantined -> accepted | rejected`. Content never becomes an Agent
   observation before `accepted`.
4. **RecoveryDecision** — `pending -> decided -> executed`, with `superseded`,
   `expired`, `cancelled`. Decisions are `reconcile | retry_with_same_key |
   compensate | manual_review | stop`; they are records, not Action states.

Invariants encoded in the tables and enforced by validators:

- Illegal transitions fail without partial mutation (PROT-011).
- Timeout/transport loss is never authoritative failure (PROT-012).
- An expired grant without an authoritative acknowledgement makes the
  Attempt `unknown` (PROT-013) and the Action `unknown_outcome`.
- Framework checkpoints correlate but never satisfy Attempt/receipt
  transitions (PROT-014).
- `unknown_outcome` resolves only through authoritative reconciliation;
  retry requires a verified RecoveryDecision plus a new grant and recovery
  approval (PROT-015).
- The Attempt machine has NO transition out of `unknown`: a non-idempotent,
  non-queryable unknown Attempt has no automatic replay path (M0 exit gate).

## Alternatives

- **Single effect state string**: rejected — cannot express "acknowledged but
  unverified" vs "response received" vs "quarantined" without conflation.
- **Event sourcing as the ledger model**: deferred; M0 freezes state machines,
  M1 stores SQLite snapshots plus an append-only audit chain (ADR-003).
- **`unknown` as a non-terminal Attempt state**: rejected — recovery must
  flow through new Attempts, never by mutating an unknown one.

## Consequences

- Positive: crash windows map one-to-one onto machine states; validators can
  mechanically reject illegal transitions; conformance and Crash Lab share
  the same tables.
- Negative: more objects on the wire (snapshot vs attempt vs decision);
  SDKs must map framework events to the right machine.
