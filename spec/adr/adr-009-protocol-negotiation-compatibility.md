# ADR-009: Protocol Negotiation and Cross-Language Compatibility

- **Status**: Accepted
- **Date**: 2026-08-17
- **Applies to**: M0 Protocol Freeze; M3 SDK handshake; M7 cross-language
- **Related**: PROT-003, PROT-007; `spec/compatibility.json`

## Context

SDKs (Python first, TypeScript later) and Edge must agree on protocol
versions without a release train coupling every language. Old clients must
keep working against newer servers and vice versa, within documented bounds,
and mismatches must be typed errors, not mysterious parse failures.

## Decision

1. **Versioning**: `protocol_version` is `"MAJOR.MINOR"`. The v0alpha1 spec
   directory corresponds to `0.1` (mapping in `spec/compatibility.json`).
   Schema `$id`s embed the version directory (PROT-003).
2. **Negotiation rules** (PROT-007):
   - Major version MUST match exactly; mismatch → `PROTOCOL_MAJOR_MISMATCH`.
   - Negotiated minor = `min(client_minor, server_minor)`; the side declaring
     the higher minor MUST constrain itself to the negotiated minor.
   - The client may declare `minimum_protocol_version`; a negotiated version
     below it → `PROTOCOL_MINOR_MISMATCH`.
   - Unparseable version strings → `BAD_REQUEST`.
   - Negotiation happens in the handshake (`ClientHello`/`ServerHello`);
     documents from a newer minor are still rejected by `0.1` receivers —
     forward compatibility is a wire-layer concern, not a schema concern.
3. **Compatibility matrix**: `spec/compatibility.json` is machine-readable
   (mapping, dialect, canonicalization, hash algorithm, negotiation rules,
   profiles, minor history) and is a normative input to handshake
   implementations.
4. **Cross-language evidence**: golden vectors (canonical hashes, transitions,
   negotiation, receipts, replay eligibility) are run by BOTH the Python and
   the TypeScript validators; identical verdicts are an M0 exit gate and an
   M7 gate ("Python-created interrupted runs are queryable from TypeScript and
   vice versa").
5. **Minor evolution policy**: a minor version may add optional fields or
   enum values, never remove or reinterpret existing ones; every minor change
   creates new schema files and a `compatibility.json` history entry.

## Alternatives

- **Single unversioned contract**: rejected — no safe path to evolve.
- **Negotiate to the server version always**: rejected — breaks clients that
  only know older semantics; min-of-both is the standard conservative rule.
- **Forward-compatible documents (ignore unknown fields)**: rejected for
  v0alpha1 — strict reject keeps validation deterministic and evidence
  trustworthy; ADR-001 records the strictness trade-off.

## Consequences

- Positive: independent SDK/Edge release cadence; typed negotiation failures;
  one machine-readable matrix every implementation can load; cross-language
  hash equality proven by vectors.
- Negative: minor bumps require coordinated new schema files; the strict
  document policy means older receivers cannot read newer documents — handled
  by handshake downgrade.
