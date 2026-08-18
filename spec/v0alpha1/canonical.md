# Canonical JSON, Hashing, Time, Numbers, IDs

> Normative for protocol version `0.1` (`v0alpha1`). Implements PROT-004,
> PROT-005, PROT-006. See [ADR-001](../adr/adr-001-json-schema-openapi-canonical-hash.md).

## 1. Canonical JSON: `ogra-jcs-1`

The canonical JSON canonicalization scheme for Ogra protocol documents is
named **`ogra-jcs-1`**. Every byte-for-byte identical semantic document MUST
canonicalize to the identical byte sequence in every implementation language.

Rules, in order of application:

1. **Document shape.** The input MUST be a JSON object. Arrays are valid only
   inside object members. Duplicate object keys are rejected before
   canonicalization.
2. **Encoding.** UTF-8 without BOM. Canonical bytes are the UTF-8 encoding of
   the serialized form.
3. **Object member order.** Members are serialized in ascending order of their
   key strings, compared as sequences of Unicode code points. (UTF-8 is
   order-preserving for code points, so byte-wise key comparison is equivalent
   for valid UTF-8 keys.)
4. **String escaping.** Escape only the double quote (`"` → `\"`), the
   backslash (`\` → `\\`), and control characters U+0000–U+001F (each as
   `\u00XX` with lowercase hexadecimal digits). All other characters,
   including non-ASCII, are emitted as their UTF-8 bytes, never as `\u` or
   `\x` escapes. Escaped form of a control character is always the 4-digit
   `\u` form (never `\n`, `\t`, `\b`, `\f`, `\r`).
5. **Numbers.** All protocol numbers are integers (see §2). Serialize as
   base-10 digits, no leading zeros, no exponent, no sign for zero (`-0` is
   serialized as `0`).
6. **Booleans and null.** `true` and `false` as literals. `null` is NOT a
   valid protocol value (see §4); a defensive canonicalizer drops members
   whose value is `null`, but validators reject `null` wherever the schema
   does not explicitly declare it.
7. **Arrays.** Elements are serialized in input order. No whitespace.
8. **Whitespace.** None. Serialization is compact; the hash is computed over
   the exact canonical bytes with no trailing newline.

Example:

```json
{"b":2,"a":{"d":true,"c":"x\u0001"},"z":["1",1]}
```

canonicalizes to:

```text
{"a":{"c":"x\u0001","d":true},"b":2,"z":["1",1]}
```

## 2. Numbers

- JSON numbers in protocol documents MUST be integers within the
  **safe integer range** `|n| <= 2^53 - 1` (9007199254740991). This is the
  largest range in which Python `int` and JavaScript `Number` both represent
  every value exactly; a larger integer would hash differently across
  languages and break approval binding, submission dedup, and audit linking
  (P0-3).
- Non-integer quantities and integers beyond the safe range (e.g. very large
  sequence counters) MUST be represented as decimal strings with their unit
  documented in the schema.
- Canonicalization REJECTS integers outside the safe range instead of
  serializing them; both validators fail fast (see the `ch-unsafe-*` golden
  vectors).
- The safe range is ALSO enforced in the authoritative JSON Schemas: every
  integer field and the `X-Ogra-Expected-Revision` header reuse the shared
  `SafeInteger` definition in `schemas/_defs.schema.json` (P1-3 round 2), so
  an out-of-range integer is rejected at the data-shape layer, not only at
  canonicalization time.
- This removes float and precision ambiguity from cross-language hashing.

## 3. Timestamps

- Wire format: RFC 3339 subset — `YYYY-MM-DDTHH:MM:SS.sssZ`, uppercase `T`
  and `Z`, exactly three fractional digits, UTC only, zero-padded.
- Regex: `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`.
- Normalization before hashing: parse as UTC; if fractional digits beyond the
  third are present, TRUNCATE (never round); if no fraction is present,
  append `.000`. Leap seconds are not representable.
- Example canonical form: `2026-08-17T12:00:00.000Z`.

## 4. `null` versus omitted fields

- Optional fields are OMITTED. `null` is not a value in protocol version
  `0.1` unless a schema explicitly declares `"type": [..., "null"]` and
  documents the meaning. No `0.1` schema declares `null`.
- On input, a document containing `null` for a non-nullable field is INVALID.
- A defensive canonicalizer additionally drops `null` members so that
  `{"a": null, "b": 1}` and `{"b": 1}` never hash differently.

## 5. Unknown fields and unknown enum values

- All core protocol objects declare `additionalProperties: false`. An unknown
  field is REJECTED with a typed validation error.
- Extension points are explicit: fields whose schema declares free-form
  objects (e.g. `CapabilityManifest.metadata`,
  `ExternalReceipt.provider_details`). Extension content is preserved
  verbatim, never interpreted by core logic, and excluded from semantic
  decisions.
- All enums in `0.1` are closed. An unknown enum value is REJECTED with a
  typed validation error naming the field.
- Documents from a hypothetical newer minor version are still REJECTED by
  `0.1` receivers. Forward compatibility is handled at the wire layer only,
  by handshake negotiation (see [ADR-009](../adr/adr-009-protocol-negotiation-compatibility.md)),
  where the newer side constrains itself to the negotiated minor.

## 6. Hashing

- Default hash algorithm: **SHA-256** over canonical UTF-8 bytes.
- A hash value is a string of the form `sha256:<64 lowercase hex digits>`.
- Every hash in the protocol is a `HashRef`:

```json
{
  "algorithm": "sha256",
  "canonicalization": "ogra-jcs-1",
  "value": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
}
```

- `canonicalization` is `ogra-jcs-1` for protocol documents and JSON payloads,
  or `raw-bytes` for non-JSON payloads (the exact bytes that cross the
  boundary are hashed).
- Payload, policy, scope, and evidence hashes MUST carry both
  `algorithm` and `canonicalization` (PROT-005).

## 7. ID formats

All generated identifiers are opaque strings with a stable, documented,
language-neutral format. They never depend on Python object identity,
process IDs, or framework checkpoints (PROT-006).

| Prefix | Object | Example |
|---|---|---|
| `run_` | Run | `run_01H6Z9KX4Q2B1Z9QW3JX3G0N5M` |
| `act_` | Action | `act_01H6Z9KX4Q2B1Z9QW3JX3G0N5M` |
| `atp_` | ActionAttempt | `atp_01H6Z9KX4Q2B1Z9QW3JX3G0N5M` |
| `ing_` | IngressFinding | `ing_01H6Z9KX4Q2B1Z9QW3JX3G0N5M` |
| `rec_` | ExternalReceipt | `rec_01H6Z9KX4Q2B1Z9QW3JX3G0N5M` |
| `dec_` | RecoveryDecision | `dec_01H6Z9KX4Q2B1Z9QW3JX3G0N5M` |
| `evt_` | AuditEvent | `evt_01H6Z9KX4Q2B1Z9QW3JX3G0N5M` |
| `app_` | ApprovalBinding | `app_01H6Z9KX4Q2B1Z9QW3JX3G0N5M` |
| `grn_` | DispatchGrant | `grn_01H6Z9KX4Q2B1Z9QW3JX3G0N5M` |
| `pdc_` | PolicyDecision | `pdc_01H6Z9KX4Q2B1Z9QW3JX3G0N5M` |
| `rte_` | RouteDecision | `rte_01H6Z9KX4Q2B1Z9QW3JX3G0N5M` |
| `rdr_` | RedactionRecord | `rdr_01H6Z9KX4Q2B1Z9QW3JX3G0N5M` |
| `ply_` | Stored payload | `ply_01H6Z9KX4Q2B1Z9QW3JX3G0N5M` |
| `mft_` | CapabilityManifest | `mft_01H6Z9KX4Q2B1Z9QW3JX3G0N5M` |
| `cmd_` | Command (idempotency) | `cmd_01H6Z9KX4Q2B1Z9QW3JX3G0N5M` |

`ClientHello` and `ServerHello` are transport messages and do not carry
generated IDs.

- Generated ID body: a 26-character Crockford Base32 ULID
  (time-ordered, lexicographically sortable, 128 bits, no `i/l/o/u`).
- Lexical rule for generated IDs:
  `^(run|act|atp|ing|rec|dec|evt|app|grn|cmd)_[0-9a-hjkmnp-tv-z]{26}$`.
- `submission_key`: caller-chosen and caller-stable, NOT generated by Edge.
  Lexical rule `^[A-Za-z0-9._:-]{1,128}$`. Scoped by (principal, operation)
  on the server. Repeated submission with the same key returns the existing
  identity; a conflicting canonical request is rejected (PROT-030, PROT-031).
  Callers SHOULD derive the key from canonical inputs (e.g. a digest of the
  canonical request) so that a lost response can be re-attached.
- Principal and actor identifiers: opaque strings matching
  `^[A-Za-z0-9._:@/-]{1,128}$`.

## 8. Protocol version strings

- `protocol_version` is a string `"MAJOR.MINOR"` — `"0.1"` for this spec.
- Major version changes break wire compatibility. Minor versions add optional
  fields or enum values only.
- Negotiation: same major REQUIRED; negotiated minor is
  `min(client_minor, server_minor)`; the side declaring the higher minor MUST
  constrain itself to the negotiated minor (see
  [compatibility.json](../compatibility.json) and ADR-009).
