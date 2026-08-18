# ADR-003: SQLite Snapshots plus Append-Only Audit

- **Status**: Accepted
- **Date**: 2026-08-17
- **Applies to**: M1 Edge Durable Kernel (decision frozen in M0)
- **Related**: handbook §8, §9; roadmap planning decision 6

## Context

Ogra Edge must persist Action/effect state, attempts, receipts, leases,
payload references, and evidence, and must survive kill/reopen at every
transaction boundary. Full event sourcing gives replayable history but adds
projection complexity; the M0 architecture review chose a simpler model.

## Decision

1. Edge uses **SQLite with WAL** as the durable kernel: transactional
   snapshot rows for Actions, Attempts, Ingress findings, RecoveryDecisions,
   approvals, grants, receipts, and payload references, with revision counters
   for optimistic concurrency.
2. The **audit trail is a separate append-only, hash-linked chain** (see
   ADR-010): `AuditEvent` rows are never updated or deleted; each event links
   to its predecessor by ID and hash.
3. A snapshot revision bumps only via legal state-machine transitions
   (ADR-002 tables), committed in the same transaction as the corresponding
   audit event.
4. The protocol defines the state semantics; SQLite is an implementation
   detail. Schema-neutral projections (`ActionSnapshot`, evidence packets)
   are what cross the wire.

## Alternatives

- **Full event sourcing**: rejected for M1 — heavier than needed; the audit
  chain already provides append-only history for the events that matter.
- **Embedded key-value store**: rejected — SQLite WAL is portable, testable,
  and already proven in the existing codebase.
- **Only in-memory state with journal files**: rejected — kill/reopen tests
  at every transaction boundary require real transactional storage.

## Consequences

- Positive: simple, testable durability; concurrent recovery has one valid
  lease holder via CAS on revision; the audit chain stays independent of
  snapshot layout.
- Negative: snapshot schema migrations are versioned and append-only (the
  M1 migration policy); historical event reconstruction requires the audit
  chain, not snapshot rows.
