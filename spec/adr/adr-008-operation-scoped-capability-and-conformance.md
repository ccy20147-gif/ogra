# ADR-008: Operation-Scoped Adapter Capability and Conformance Trust

- **Status**: Accepted
- **Date**: 2026-08-17
- **Applies to**: M0 Protocol Freeze; M5 Recovery and Adapter Conformance
- **Related**: PROT-018, PROT-021; handbook §2.3, §8.2

## Context

A provider may be outcome-queryable for one operation and non-idempotent and
non-queryable for another. Recovery claims must be operation-scoped and
must not be self-serving: an adapter declaring `idempotent` without evidence
must not unlock retry.

## Decision

1. `CapabilityManifest` declares per-operation recovery capabilities from the
   closed set `replay_safe | idempotent | outcome_query | compensatable`
   (PROT-018), plus operation-scoped metadata: idempotency scope, dedup
   window, conflict behavior, outcome retention, duplicate-effect risk,
   retry-cost risk, and audit level.
2. **A manifest claim never enables recovery until its conformance result is
   trusted by Edge** (PROT-021). `conformance[].status` is
   `trusted | untrusted | pending`; only `trusted` entries (run by an
   authoritative conformance harness) enable capabilities. Unknown capability
   values are rejected with `UNKNOWN_CAPABILITY`.
3. **Conformance trust is OPERATION-SCOPED** (P0-1): each operation declares
   `conformance_refs`; that operation's capabilities are enabled ONLY when it
   references at least one conformance result AND every referenced
   `conformance_id` has status `trusted`. A trusted conformance for one
   operation never enables another operation; missing or unknown conformance
   ids fail closed.
4. **Duplicate identifiers are rejected, order-independently** (P1-2 round
   2): the same `conformance_id` or `operation_id` appearing more than once in
   a manifest is REJECTED with the typed error `DUPLICATE_ID` — never resolved
   by "last one wins" (a conformance_id declared both untrusted and trusted
   can never enable capabilities, regardless of declaration order). This is
   the conservative degradation required for contradictory capability
   claims.
5. **Recovery decisions are gated by enabled capabilities**:
   - `retry_with_same_key` requires `replay_safe` or `idempotent`;
   - `reconcile` requires `outcome_query` (query first, then retry);
   - `compensate` (EXECUTION) requires `compensatable`; PROPOSING
     compensation is always allowed — a human may always decide, but only a
     conformance-backed operation may execute compensation (P1-7);
   - `manual_review` and `stop` are always allowed (they touch nothing
     external);
   - no capability → `unknown_outcome` with zero automatic replay.
5. `read_only` never implies `replay_safe`; the manifest's `duplicate_effect_risk`
   and `retry_cost_risk` are mandatory so the cost of a wrong retry is
   visible.
6. Conformance is the authority for adapter recovery claims; Crash Lab and
   the adapter conformance suite (M5) run the same state-machine
   implementation as production Edge.

## Alternatives

- **Adapter self-declaration without conformance**: rejected — recovery
  claims would be marketing, and blind retries would follow.
- **One capability per adapter**: rejected — operation scoping is required by
  the handbook and by real providers.
- **Trusting unknown capabilities**: rejected — unknown capabilities are
  rejected, never ignored, so typos and invented guarantees cannot slip in.

## Consequences

- Positive: recovery is mechanically gated; conformance status is auditable;
  unknown capability requests fail loudly; Crash Lab truth tables can assert
  which windows must remain unknown.
- Negative: adapters must carry a conformance run to unlock recovery; the
  conformance suite is a first-class M5 deliverable, not an afterthought.
