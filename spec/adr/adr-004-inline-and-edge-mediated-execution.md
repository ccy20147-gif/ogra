# ADR-004: Inline and Edge-Mediated Execution Guarantees

- **Status**: Accepted
- **Date**: 2026-08-17
- **Applies to**: M0 Protocol Freeze; M1+, M5 Crash Lab
- **Related**: PROT-017, PROT-022, PROT-023, PROT-024, PROT-028, PROT-029;
  handbook §5.2, §8

## Context

Who executes the provider/tool callback determines what can be proven after a
crash. The protocol must state the exact authority boundary for each execution
profile and must not let either profile imply exactly-once semantics.

## Decision

### Inline

- Edge persists intent, policy, approval, and an Attempt, then issues a
  **short-lived, single-use `DispatchGrant`** bound to Action, Attempt,
  canonical payload, destination, policy version, redaction rule version,
  scope, revision, and expiry.
- The application SDK executes the callback and submits acknowledgement,
  receipts, or result evidence.
- If the grant may have been used but no authoritative acknowledgement is
  persisted before expiry, the Attempt becomes `unknown` (PROT-013) and the
  Action `unknown_outcome` unless authoritative outcome query or stable
  idempotency exists.

### Edge-mediated

- Edge or a supervised worker owns the adapter callback and receipt
  persistence. Stronger supervision and credential isolation.
- **Edge-mediated execution does NOT create exactly-once semantics**
  (PROT-024): after an ambiguous provider boundary, safe retry still requires
  verified provider capability (idempotency or outcome query) plus a verified
  RecoveryDecision.

Rules encoded in the protocol:

- Every receipt identifies `execution_profile` (PROT-022).
- Inline execution is never advertised as Edge-isolated (PROT-023).
- HTTP 2xx and provider request IDs are advisory unless the adapter contract
  proves stronger semantics (PROT-028).
- Only authoritative completion or failure evidence resolves an executing or
  unknown Action (PROT-029).

## Alternatives

- **Always edge-mediated**: rejected — breaks the few-line inline SDK
  experience and the generic Quickstart.
- **Implying exactly-once for edge_mediated**: rejected — a protocol promise
  no implementation could keep; conformance and provider capability decide
  replay safety, not execution ownership.

## Consequences

- Positive: honest capability reporting; crash windows are well-defined for
  Crash Lab truth tables; approval and grant binding cover both profiles.
- Negative: inline users must accept durable uncertainty after grant loss;
  edge-mediated requires supervised deployment and adapter conformance to be
  useful for recovery.
