# Recovery, Crash Lab, and Conformance Requirements

> Milestone: M5
>
> Requirement prefix: `REC`

## 1. Scope

This milestone proves that Ogra resumes only with authority. It covers operation
capability manifests, recovery decisions, real process failure, external call
count, manual resolution, and third-party adapter conformance.

## 2. Recovery Matrix

| Operation evidence | Allowed automatic behavior |
|---|---|
| conformance-proven replay safe | replay under current policy and revision |
| stable idempotency identity inside its verified window | retry with the identical key |
| authoritative outcome query | reconcile before any retry |
| typed compensation | compensate only with scoped approval |
| none of the above | hold at `unknown_outcome` |

Edge-mediated execution alone does not change this matrix.

## 3. Normative Requirements

- **REC-001**: Capability manifests MUST be operation-scoped and versioned.
- **REC-002**: Manifest claims MUST identify idempotency, outcome query,
  compensation, receipt, cancellation, duplicate risk, and retry-cost risk.
- **REC-003**: A conformance result MUST bind adapter version, operation,
  capability, fixture version, and test evidence.
- **REC-004**: Unverified or contradictory capability MUST degrade to conservative
  unknown handling.
- **REC-005**: Recovery MUST acquire a fenced lease and validate current revision,
  policy, approval, scope, payload, retention, and capability.
- **REC-006**: Idempotent retry MUST reuse the original stable identity.
- **REC-007**: Outcome-query adapters MUST reconcile before retry.
- **REC-008**: Compensation MUST be a new typed Action with explicit authority.
- **REC-009**: Manual resolution MUST record actor, reason, evidence, and whether
  the external effect was independently verified.
- **REC-010**: Unknown MUST never be silently converted to failed, succeeded, or
  retryable.
- **REC-023**: Idempotency conformance MUST bind provider, account, operation,
  canonical payload equivalence, key scope, deduplication window, expiry,
  conflict behavior, and result-retention period. Expired capability MUST fall
  back to outcome query or unknown.

## 4. Crash Lab Components

Crash Lab MUST provide:

- an OpenAI-compatible recording model endpoint;
- a typed recording tool endpoint;
- request-byte, idempotency-key, receipt, and call-count capture;
- replay-safe, idempotent, outcome-queryable, compensatable, and unsupported
  operation fixtures;
- a process supervisor that terminates SDK, worker, reviewer, or Edge at a named
  boundary;
- an evidence report comparing sink facts with Ogra state.

- **REC-011**: Failure injection for crash claims MUST use real process
  termination, not only a catchable exception.
- **REC-012**: The sink MUST run outside the terminated process.
- **REC-013**: Crash Lab MUST use the production domain and storage code paths.
- **REC-014**: Every test MUST assert exact external call count.

## 5. Required Failure Windows

```text
before_intent_commit
after_intent_before_dispatch_grant
after_grant_before_external_send
after_external_accept_before_ack
after_ack_before_result_commit
after_result_before_ingress
ingress_reviewer_unavailable
after_ingress_before_observation
concurrent_recovery
```

For inline execution, the interval after grant and before acknowledgement is
ambiguous unless external evidence resolves it. For Edge-mediated execution,
worker death at the provider boundary remains ambiguous under the same rule.

- **REC-015**: Each window MUST assert Action, Attempt, ingress, lease, and
  recovery-decision state.
- **REC-016**: Restart MUST not issue a new callback before recovery authority is
  established.
- **REC-017**: Concurrent recovery MUST permit one effective decision holder.
- **REC-018**: Reviewer failure MUST prevent Agent observation.

## 6. Adapter Conformance

The public conformance runner MUST:

- accept an adapter manifest and isolated test configuration;
- execute capability-specific positive and adversarial cases;
- emit machine-readable results and sanitized human output;
- sign or hash-bind the report to versions and fixtures;
- support local execution without Ogra Cloud.

- **REC-019**: A compatibility badge MUST derive from a publishable conformance
  result, not self-attestation alone.
- **REC-020**: Manifest and observed behavior disagreement MUST fail the claimed
  capability.
- **REC-021**: Provider documentation MUST display missing capabilities as well
  as supported ones.
- **REC-022**: Conformance MUST test retry with the same key and reject a changed
  key where idempotency is claimed.

## 7. Acceptance Gates

1. Sink call count, Ogra Attempts, and receipts match the failure-window truth
   table; expected gaps are explicitly represented as unknown.
2. Unsupported ambiguity produces `unknown_outcome` and zero automatic replay.
3. Outcome query confirms accepted work without duplicate execution.
4. Idempotent retry uses the exact stable key.
5. Stale policy, approval, revision, lease, or payload blocks before callback.
6. Crash Lab reports inline and Edge-mediated profiles separately.
7. A third-party adapter can run conformance without modifying Edge.

## 8. Non-Goals

- universal exactly-once execution;
- treating HTTP timeout as proof of failure;
- certifying provider internals Ogra cannot observe;
- making compensation lossless by declaration;
- using a domain-specific refund scenario as the conformance model.
