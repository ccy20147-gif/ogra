# ADR-010: Tamper-Evident Audit Claim and External Anchoring Boundary

- **Status**: Accepted
- **Date**: 2026-08-17
- **Applies to**: M0 Protocol Freeze; M1 audit chain; M2 evidence
- **Related**: handbook §9, §11.4; ADR-003

## Context

Ogra promises "verifiable local evidence and recovery state". A hash-linked
local chain detects mutation, but a local-only chain cannot prove that tail
events were never removed: an attacker (or an operator) with write access can
rebuild the whole chain. The audit claim must be scoped honestly.

## Decision

1. **Append-only, hash-linked chain**: `AuditEvent` rows are immutable; each
   event carries `sequence`, `prev_event_id`, `prev_hash`, and its own
   `content_hash` (over the sanitized event payload with `ogra-jcs-1`).
   `AuditEvent` has no update or delete path (M1 schema).
2. **Claim boundary** (handbook §11.4): a valid local chain proves
   "no mutation within the observed chain" but NOT "no events were removed".
   Removal proof requires an **expected or externally anchored head**:
   - `anchor: "none"` — local chain valid; head not independently verifiable.
   - `anchor: {provider, ref}` — an external anchor (e.g. a transparency log
     or signed timestamp) commits the head outside Edge; tail-removal then
     becomes detectable.
   - `/audit/verify` reports `chain_valid`, `anchor`, `verified_events`, and
     `head_event_id`; without an anchor it explicitly reports the limited
     claim.
3. **Evidence hygiene**: evidence projection excludes raw secrets and
   sensitive payloads by default (PROT-027, ADR-006); summary fields carry
   counts, flags, and digests only.
4. **Correlation with framework state**: framework checkpoints are correlated
   via `CorrelationRef` and never become audit authority (PROT-014).

## Alternatives

- **Claiming tamper-proof local evidence**: rejected — dishonest without an
  external anchor; acceptance gate 11.4 explicitly requires the anchor status
  to be reported.
- **Requiring an external anchor always**: rejected — the local runtime must
  remain useful standalone; anchor is optional but its absence is visible.
- **Raw payloads in evidence**: rejected — leaks secrets and bloats the chain.

## Consequences

- Positive: deterministic audit verification with an honest, machine-readable
  claim; external anchoring slots in later without protocol change; evidence
  stays clean by default.
- Negative: "chain_valid + anchor=none" must never be over-sold in product
  copy; external anchoring requires an anchor provider integration (post-M1).
