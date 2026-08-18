# ADR-006: Sanctioned Payload Encryption, Retention, and Replay Eligibility

- **Status**: Accepted
- **Date**: 2026-08-17
- **Applies to**: M0 Protocol Freeze; M2 Governance and Data Handling
- **Related**: PROT-025, PROT-026, PROT-027; handbook §8.3; development index
  invariant 17

## Context

Safe retry sometimes requires the exact sanctioned payload bytes; evidence
must not store raw secrets. These goals conflict unless replayable material is
a distinct, explicitly retained, encrypted class.

## Decision

1. `PayloadRef` distinguishes three `storage_mode` values:
   - `hash_only` — evidence exists (hash only); replay is impossible by
     construction.
   - `encrypted_replayable` — sanctioned bytes are stored authenticated-
     encrypted under explicit retention: `storage_ref`, `key_id` (identity,
     never key material), `encryption_scheme`, `retention_class`,
     `expires_at`, and an audit trail (`payload_stored`, `payload_deleted`
     audit events).
   - `external_reference` — an authoritative external store owns retrieval;
     `retrieval_policy` (`immediate | delegated | unknown`) declares replay
     semantics.
2. **Replay eligibility is machine-readable** (PROT-025): every `PayloadRef`
   carries explicit `replay_eligible`. Rules enforced by schema and
   validators: `hash_only` MUST be `false` (schema if/then); encrypted
   material is eligible only while within retention, not deleted, and not
   expired; external references only when the policy is `immediate` or
   `delegated`.
3. **Hash-only never enters an automatic retry path** (PROT-026): retry
   requires a `PayloadRef` whose replay eligibility is true AND a verified
   RecoveryDecision; the golden `hash-only-replay` vectors pin this down.
4. **Evidence projection excludes replay material** (PROT-027): audit and
   evidence records carry bounded metadata and hashes; encrypted payload
   material, key identifiers, and secrets are never projected into evidence.

## Alternatives

- **Store plaintext payloads for retry**: rejected — raw secrets would live
  in the ledger and leak into evidence.
- **No replayable storage at all**: rejected — idempotent retry and outcome
  reconciliation for sanctioned payloads would be impossible.
- **Derive replay eligibility from `read_only` or mode**: rejected — a
  read-only label alone is insufficient (cost, rate limits, telemetry,
  nondeterminism); eligibility must be explicit and provable.

## Consequences

- Positive: replay eligibility is a mechanical, testable property; evidence
  stays clean by default; expired/deleted/undecryptable material loses replay
  eligibility automatically.
- Negative: encrypted replayable storage requires key management, retention
  policies, and audit events in M2; external references rely on the external
  store's trust model.
