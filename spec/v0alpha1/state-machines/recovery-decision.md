# RecoveryDecision State Machine

> Machine-readable authority: [recovery-decision.json](recovery-decision.json).
> Implements PROT-015, PROT-021. See
> [ADR-002](../../adr/adr-002-action-attempt-ingress-decision-state-separation.md)
> and [ADR-008](../../adr/adr-008-operation-scoped-capability-and-conformance.md).

Recovery decisions are governed decision records, NOT Action terminal states.
Allowed decision values:

```text
reconcile
retry_with_same_key
compensate
manual_review
stop
```

```text
pending -> decided -> executed
decided -> superseded | expired
pending -> cancelled
```

## Transitions

| From | Event | To | Guard |
|---|---|---|---|
| `pending` | `decide` | `decided` | decision, evidence refs, actor, revision, lease token, and reason present |
| `pending` | `withdraw` | `cancelled` | decision never applied |
| `decided` | `apply` | `executed` | applied against referenced revision and lease |
| `decided` | `supersede` | `superseded` | a newer decision replaced this one |
| `decided` | `expiry` | `expired` | lease or decision validity expired before apply |

Terminal states: `executed`, `superseded`, `expired`, `cancelled`.

## Semantics

- `reconcile`: query the external outcome BEFORE any retry.
- `retry_with_same_key`: create a NEW Attempt under the verified stable
  identity; requires a new recovery approval and a new dispatch grant bound
  to the original sanctioned payload (handbook §7.2).
- `compensate`: issue a typed, scoped compensation Action.
- `manual_review`: hand the uncertainty to a human or operator.
- `stop`: remain `unknown_outcome`; no automatic action.
- Uncertainty itself is never retry authority (handbook §8.2).
- A manifest claim never enables recovery until its conformance result is
  trusted by Edge (PROT-021).
