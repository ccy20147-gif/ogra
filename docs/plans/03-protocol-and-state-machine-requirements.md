# Protocol and State Machine Requirements

> Milestone: M0
>
> Requirement prefix: `PROT`
>
> Authority: versioned files under `spec/`, not Python classes

## 1. Scope

This document defines the language-neutral wire contract, state separation,
canonical identity, compatibility rules, and execution-profile semantics used by
every Ogra SDK, Edge runtime, and adapter.

## 2. Protocol Objects

The first protocol version MUST define:

- `RunRef` and `ActionIntent`;
- `ActionSnapshot` and `ActionAttempt`;
- `PolicyDecision`, `RouteDecision`, and `RedactionRecord`;
- `ApprovalBinding` and `DispatchGrant`;
- `ExternalReceipt` and `PayloadRef`;
- `IngressFinding` and `RecoveryDecision`;
- `CapabilityManifest` and `AuditEvent`;
- `ErrorEnvelope` and protocol handshake objects.

Framework-native messages MAY appear in adapter metadata, but MUST NOT be
required to interpret an Action.

## 3. Normative Requirements

- **PROT-001**: JSON Schema 2020-12 MUST be the data-shape authority.
- **PROT-002**: OpenAPI MUST define the first command/query transport over local
  HTTP, Unix domain socket, or loopback TCP.
- **PROT-003**: Schema identifiers MUST include a protocol major and minor.
- **PROT-004**: Canonical JSON MUST define object-key order, UTF-8 encoding,
  number representation, timestamps, `null`, omitted fields, and byte encoding.
- **PROT-005**: Payload, policy, scope, and evidence hashes MUST identify their
  canonicalization and hash algorithm.
- **PROT-006**: IDs MUST be opaque strings with a documented stable format and
  MUST NOT depend on Python object identity or process ID.
- **PROT-007**: Unknown fields, unknown enum values, unsupported major versions,
  and older minor versions MUST have deterministic compatibility behavior.
- **PROT-008**: Commands that mutate state MUST include a command identity and
  expected revision.
- **PROT-009**: Error responses MUST be typed, sanitized, retry-classified, and
  safe to display without raw payload disclosure.
- **PROT-010**: Golden vectors MUST cover valid, invalid, boundary, upgrade, and
  canonical hash cases.

## 4. State Separation

### Action

```text
proposed -> authorized -> executing -> result_received -> committed
proposed -> blocked
authorized -> cancelled
executing -> failed_authoritative | unknown_outcome
result_received -> quarantined | review_unavailable
review_unavailable -> result_received
quarantined -> committed | failed_authoritative
unknown_outcome -> executing | committed | failed_authoritative
```

An Action is the user-visible aggregate. `safe_retry` and `reconciled` MUST NOT
be Action states.

### Attempt

```text
prepared -> dispatch_authorized | cancelled | failed_local
dispatch_authorized -> acknowledged | cancelled | unknown
acknowledged -> response_received | failed_authoritative | unknown
```

Each physical callback MUST have one Attempt. A new callback requires a new
Attempt while retaining the Action identity and verified idempotency identity.

### Ingress

```text
pending -> accepted | quarantined | review_unavailable
review_unavailable -> pending
quarantined -> accepted | rejected
```

External content MUST NOT become an Agent observation before `accepted`.

### Recovery Decision

Allowed decisions are:

```text
reconcile
retry_with_same_key
compensate
manual_review
stop
```

Every decision MUST include evidence, actor, revision, lease token, and reason.

- **PROT-011**: Illegal transitions MUST fail without partial state mutation.
- **PROT-012**: Timeout or transport loss MUST NOT be treated as authoritative
  external failure.
- **PROT-013**: An expired dispatch grant without authoritative acknowledgement
  MUST produce an unknown Attempt.
- **PROT-014**: Framework checkpoints MAY correlate with Actions but MUST NOT
  satisfy Attempt or receipt transitions.
- **PROT-015**: Unknown Actions MUST transition to committed or failed only from
  authoritative reconciliation; retry MUST create a new Attempt under a verified
  recovery decision.

## 5. Capability Profiles

- **PROT-016**: `governance_profile` MUST be `observe` or `govern`.
- **PROT-017**: `execution_profile` MUST be `inline` or `edge_mediated`.
- **PROT-018**: recovery capabilities MUST be operation-scoped and MAY include
  `replay_safe`, `idempotent`, `outcome_query`, and `compensatable`.
- **PROT-019**: `isolation_profile` MUST be `development`, `supervised`, or
  `hardened`.
- **PROT-020**: Profiles MUST be reported independently in API and evidence.
- **PROT-021**: A manifest claim MUST NOT enable recovery until its required
  conformance result is trusted by Edge.

## 6. Execution Ownership

For inline execution, Edge issues a short-lived `DispatchGrant` bound to Action,
Attempt, canonical payload, destination, policy, scope, revision, and expiry.
The SDK executes the callback and submits acknowledgement or result evidence.

For Edge-mediated execution, Edge or its supervised worker owns the callback.
The adapter still needs verified idempotency or outcome query for safe retry
after an ambiguous provider boundary.

- **PROT-022**: Every receipt MUST identify the execution profile.
- **PROT-023**: Inline execution MUST NOT be advertised as Edge-isolated.
- **PROT-024**: Edge-mediated execution MUST NOT imply exactly-once.

## 7. Payload References

`PayloadRef` MUST distinguish:

- `hash_only`: evidence exists, replay is impossible;
- `encrypted_replayable`: sanctioned bytes are encrypted under explicit retention;
- `external_reference`: an authoritative external store owns retrieval.

- **PROT-025**: Replay eligibility MUST be machine-readable.
- **PROT-026**: A hash-only payload MUST never enter an automatic retry path.
- **PROT-027**: Evidence projection MUST not expose encrypted payload material,
  key identifiers, or secrets beyond the documented administrative surface.

## 8. Receipt Authority

Every receipt MUST declare:

- `receipt_kind`: transport acknowledgement, provider acceptance, effect
  completion, failure, or result;
- `authority`: advisory or authoritative;
- `effect_status`: unknown, accepted, completed, or failed;
- provider, account, operation, request identity, and evidence retention.

- **PROT-028**: HTTP success or a provider request ID MUST be advisory unless the
  adapter contract proves stronger semantics.
- **PROT-029**: Only authoritative completion or failure evidence may resolve an
  executing or unknown Action.
- **PROT-030**: `submission_key` MUST be caller-stable, scoped by principal and
  operation, and uniquely map retries to the original Run or Action.
- **PROT-031**: A repeated submission key MUST return the existing identity and
  MUST reject a conflicting canonical request.

## 9. Acceptance Tests

1. Python and minimal TypeScript validators accept and reject the same vectors.
2. Canonical hashes match across both validators.
3. Every illegal transition is rejected at the expected revision.
4. Unknown fields and minor-version negotiation match the compatibility table.
5. No schema imports LangChain, Electron, Pydantic, or SQLite concepts.
6. A non-queryable, non-idempotent unknown Attempt has no automatic replay decision.
7. Server commit followed by client-response loss reattaches through the stable
   submission key without creating another Action.
8. Advisory acknowledgement cannot resolve an external effect.

## 10. Non-Goals

- defining a universal Agent message protocol;
- selecting every future transport;
- promising exactly-once external execution;
- embedding policy implementation into the wire schema.
