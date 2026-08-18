# Ingress State Machine

> Machine-readable authority: [ingress.json](ingress.json). Implements
> handbook §7.3. See [ADR-002](../../adr/adr-002-action-attempt-ingress-decision-state-separation.md).

Every governed model response, tool result, Agent message, or remote result is
untrusted until reviewed. External content MUST NOT become an Agent
observation before `accepted`.

```text
pending -> accepted | quarantined | review_unavailable
review_unavailable -> pending
quarantined -> accepted | rejected
```

## Transitions

| From | Event | To | Guard |
|---|---|---|---|
| `pending` | `accept` | `accepted` | review verdict clean |
| `pending` | `quarantine` | `quarantined` | verdict suspicious or malicious |
| `pending` | `review_unavailable` | `review_unavailable` | reviewer unavailable; fail closed in governed production |
| `review_unavailable` | `retry_review` | `pending` | review retried |
| `quarantined` | `resolve_accept` | `accepted` | resolution accepts |
| `quarantined` | `resolve_reject` | `rejected` | resolution rejects |

Terminal states: `accepted`, `rejected`.

## Invariants

1. Reviewer unavailability fails closed for governed production modes.
2. Quarantine evidence excludes unsafe raw display by default; content is
   referenced through a `PayloadRef`, never embedded raw in decisions.
3. An in-process reviewer may be used in development but does not satisfy
   independent isolation claims (isolation profile stays honest).
