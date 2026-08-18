# Receipts: Kind, Authority, Effect Status

> Normative for protocol version `0.1` (`v0alpha1`). Implements PROT-022,
> PROT-028, PROT-029. See [ADR-004](../adr/adr-004-inline-and-edge-mediated-execution.md).

An `ExternalReceipt` records what is known about the external effect of one
Attempt. Every receipt declares three orthogonal dimensions plus provenance.

## 1. `receipt_kind`

| Value | Meaning |
|---|---|
| `transport_ack` | The transport acknowledged delivery (e.g. HTTP 2xx). Says nothing about the external effect. |
| `provider_acceptance` | The provider accepted the request (e.g. returned a request ID). |
| `effect_completion` | The provider or a trusted observer confirms the effect completed. |
| `failure` | The provider or a trusted observer confirms the effect failed. |
| `result` | The actual result content was received (response body, tool result). |

## 2. `authority`

| Value | Meaning |
|---|---|
| `advisory` | Informational. Cannot resolve an Action effect. |
| `authoritative` | Backed by an adapter contract and conformance result trusted by Edge; may resolve an Action effect. |

Rules:

- HTTP 2xx, provider request IDs, and framework checkpoints are advisory
  unless the adapter contract proves stronger semantics (PROT-028).
- Only authoritative completion or failure evidence may resolve an
  `executing` or `unknown_outcome` Action (PROT-029).
- Advisory receipts NEVER push an Action toward `committed` or
  `failed_authoritative`.

## 3. `effect_status`

| Value | Meaning |
|---|---|
| `unknown` | No proof about the external effect. |
| `accepted` | The effect was accepted (may or may not have completed). |
| `completed` | The effect completed. |
| `failed` | The effect failed. |

Mapping defaults (may be strengthened only by a trusted adapter contract):

| `receipt_kind` | Default `authority` | Default `effect_status` |
|---|---|---|
| `transport_ack` | `advisory` | `unknown` |
| `provider_acceptance` | `advisory` | `unknown` |
| `effect_completion` | `authoritative` | `completed` |
| `failure` | `authoritative` | `failed` |
| `result` | `authoritative` (for content) | `completed` or `failed` (explicit) |

## 4. Provenance

Every receipt additionally records: `execution_profile` (PROT-022),
provider, account, operation, provider request identity, evidence retention,
and `received_at`. A receipt never contains the raw external payload; result
content is referenced through a `PayloadRef`.

## 5. Resolution rules

1. An Attempt may accumulate multiple receipts. Receipts are additive
   evidence, not a state overwrite.
2. `transport_ack` alone leaves the Attempt at `acknowledged` (if persisted)
   and the Action at `executing`. A `transport_ack` can NEVER be
   `authoritative` (schema-enforced).
3. `authority` is not self-declared: resolving requires ALL of (P0-2):
   - `authority = authoritative` AND
   - `receipt_kind` is `effect_completion` or `failure` (transport and
     acceptance receipts never resolve) AND
   - `effect_status` is `completed` or `failed` AND
   - the receipt's (provider, operation) pair is backed by a trusted adapter
     conformance result (PROT-028: "unless the adapter contract proves
     stronger semantics" — the proof is trusted conformance).
   The trusted conformance context is REQUIRED: omitting it fails closed
   (an authoritative receipt with no context never resolves, P0-2 round 2).
4. **Attempt binding**: the receipt's declared `provider` fields are
   client-declared and are NOT authorization evidence. The only state-advancing
   decision takes the server-persisted `ActionAttempt`, and requires matching
   receipt/Attempt `attempt_id`, receipt/Attempt `action_id`, execution
   profile, and receipt (provider, operation) / Attempt destination. Missing
   Attempt context fails closed. The field-only evidence predicate is never a
   state-transition entry point.

   Version `0.1` does not persist provider account or provider request identity
   in `ActionAttempt`. Those receipt fields remain correlation evidence in M0;
   Edge MUST NOT claim they were bound from this schema or synthesize such
   fields. A later protocol version may bind them only after it defines
   server-persisted counterparts.
5. An authoritative `effect_completion` or `failure` may move an Attempt to
   `response_received`/`failed_authoritative` and, together with ingress
   acceptance, the Action to `committed`/`failed_authoritative`.
6. A timeout or transport loss is NEVER an authoritative `failure`
   (PROT-012); it yields `unknown`.
7. Provider request IDs are correlated, never conflated, with Ogra Action or
   Attempt identity (PROT-014).
8. A `result` receipt is evidence for ingress review, not for effect
   resolution.
