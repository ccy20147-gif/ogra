# Capability Profiles

> Normative for protocol version `0.1` (`v0alpha1`). Implements PROT-016
> through PROT-021. See [ADR-004](../adr/adr-004-inline-and-edge-mediated-execution.md)
> and [ADR-008](../adr/adr-008-operation-scoped-capability-and-conformance.md).

Profiles are **independent dimensions**. They are reported independently in
every API response, receipt, summary, and evidence record (PROT-020). There is
no single "capability ladder".

## 1. Governance profile

| Value | Meaning |
|---|---|
| `observe` | Record controlled boundary activity without enforcement. |
| `govern` | Apply policy, redaction, approval, ingress review, and evidence. |

The few-line integration defaults to `govern` on intercepted paths.

## 2. Execution profile

| Value | Meaning |
|---|---|
| `inline` | The application SDK executes the provider/tool callback after receiving a payload-bound `DispatchGrant`. A crash after grant issuance and possible use can only become `unknown_outcome` unless the operation has authoritative outcome query or stable idempotency. |
| `edge_mediated` | Edge or a supervised worker owns callback execution and receipt persistence. Stronger supervision and credential isolation, but NOT exactly-once semantics; safe recovery still depends on verified provider capability. |

Authority boundary for `inline`:

1. Edge persists intent and policy/approval state.
2. Edge issues a short-lived, single-use `DispatchGrant` bound to Action,
   Attempt, canonical payload, destination, policy version, redaction rule
   version, scope, revision, and expiry.
3. The SDK executes the callback and submits acknowledgement, receipt, or
   result evidence.
4. If the grant may have been used but no authoritative acknowledgement was
   persisted before expiry, the Attempt becomes `unknown` (PROT-013) and the
   Action becomes `unknown_outcome`.

`inline` execution MUST NOT be advertised as Edge-isolated (PROT-023).
`edge_mediated` execution MUST NOT imply exactly-once (PROT-024).

## 3. Recovery capabilities

Recovery capability is **operation-scoped** (PROT-018): a provider may be
outcome-queryable for one operation and non-idempotent and non-queryable for
another. Capabilities are declared in a `CapabilityManifest` and only take
effect after Edge trusts the corresponding conformance result (PROT-021).

| Capability | Meaning | Safe replay precondition |
|---|---|---|
| `replay_safe` | Conformance proves the operation can be repeated under the current policy and revision. | Current policy/rule revision still applies. `read_only` labeling alone is insufficient (cost, rate limits, telemetry, nondeterminism). |
| `idempotent` | The operation deduplicates on a stable identity. | Verified stable identity, valid idempotency scope, unexpired dedup window, matching canonical payload, defined conflict behavior, sufficient outcome retention. |
| `outcome_query` | An authoritative outcome query exists. | Reconcile BEFORE any retry; retry only if the query proves no completion or returns authoritative no-outcome evidence. |
| `compensatable` | A typed, scoped compensation operation exists. | Explicit compensation authority and a new compensation Action. |

When none applies, Ogra persists `unknown_outcome` and blocks blind replay.
Uncertainty is never retry authority.

## 4. Isolation profile

| Value | Meaning |
|---|---|
| `development` | Automatically started local daemon (process convenience, NOT a security-isolation claim). |
| `supervised` | Explicit lifecycle, endpoint, credentials, and health policy. |
| `hardened` | OS/container, network, filesystem, and secret boundaries appropriate to a production environment. |

## 5. Profile reporting

A profile set is:

```json
{
  "governance": "govern",
  "execution": "inline",
  "recovery": ["outcome_query"],
  "isolation": "development"
}
```

`recovery` is an array because capabilities are independently true per
operation; a server-level profile lists the capabilities it can honor, while
each `CapabilityManifest.operations[].recovery` lists what applies to that
specific operation.

## 6. Unknown required capability

If an SDK, manifest, or route requests a capability that is not a defined
protocol capability (e.g. `exactly_once`), the request is REJECTED with the
typed error `UNKNOWN_CAPABILITY`. A declared-but-untrusted capability is
reported as `conformance: "untrusted"` and is never enabled for recovery.
