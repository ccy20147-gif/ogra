# ADR-001: JSON Schema, OpenAPI, Canonical JSON, and Hashing

- **Status**: Accepted
- **Date**: 2026-08-17
- **Applies to**: M0 Protocol Freeze; all SDKs and Edge
- **Related**: PROT-001, PROT-002, PROT-004, PROT-005, PROT-006, PROT-007

## Context

Every SDK, the Edge runtime, and future languages must agree on data shapes,
wire contract, and identity. The pre-M0 codebase was TypeScript-only and
couples semantics to Python objects, LangChain state, and Electron IPC.
Without a canonical serialization and hashing rule, two SDKs can compute
different fingerprints for the same semantic document, breaking approval
binding, submission dedup, and audit linking.

## Decision

1. **JSON Schema Draft 2020-12 is the data-shape authority** (PROT-001).
   Versioned schema files live in `spec/v0alpha1/schemas/`; every object has
   an `$id` containing the protocol version. Pydantic classes, TypeScript
   types, and SQLite rows are projections.
2. **OpenAPI 3.1 defines the command/query transport** (PROT-002).
   `spec/v0alpha1/openapi.yaml` is generated from the schema files by
   `tools/build-openapi.py` (schemas stay the single source of truth; drift is
   a failed gate). OpenAPI 3.1 uses the JSON Schema 2020-12 dialect, keeping
   one dialect across the stack.
3. **Canonical JSON: `ogra-jcs-1`** (PROT-004). Object keys sorted by Unicode
   code point; UTF-8 without BOM; minimal escaping (only `"`, `\`, and
   U+0000–U+001F); integers only (no floats); `null` dropped; compact output.
   See `spec/v0alpha1/canonical.md`.
4. **Hashing** (PROT-005). SHA-256 over canonical UTF-8 bytes, represented as
   `sha256:<64 lowercase hex>`. Every hash is a `HashRef` carrying
   `algorithm`, `canonicalization` (`ogra-jcs-1` or `raw-bytes`), and `value`.
5. **IDs** (PROT-006). Generated IDs are `<kind>_<ULID>` opaque strings
   (time-ordered, no PID, no Python identity). `submission_key` is
   caller-stable and caller-chosen, scoped by (principal, operation).
6. **Strictness** (PROT-007). Unknown fields and unknown enum values are
   rejected; forward compatibility is handled at handshake negotiation only.

## Alternatives

- **Pydantic as authority**: rejected — leaks Python semantics into the wire
  contract and makes cross-language conformance impossible.
- **RFC 8785 (JCS)**: considered; we diverge deliberately on numbers
  (integers only) and on `null` (dropped) to remove float ambiguity and
  null-vs-absent divergence across languages.
- **Hand-written OpenAPI duplicating schemas**: rejected — drift risk; the
  generator makes schema files the authority.
- **Hash algorithms other than SHA-256**: rejected for v0alpha1; a `HashRef`
  is extensible per algorithm value for later migration.

## Consequences

- Positive: cross-language canonical hashes are byte-identical (verified by
  golden vectors in both validators); approval binding and submission dedup
  rest on one fingerprint definition; schema and transport contract cannot
  drift apart.
- Negative: strictness means minor-version evolution requires new schema
  files and a compatibility policy (ADR-009); integers are restricted to the
  safe range |n| <= 2^53-1 (P0-3) so Python and JS hashes cannot diverge;
  larger integers and fractions must be decimal strings.
- The meta-schema gate (all schemas validate against Draft 2020-12) and the
  OpenAPI load gate run in `tools/verify-m0.sh`.
