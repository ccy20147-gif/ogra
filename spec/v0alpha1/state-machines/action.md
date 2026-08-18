# Action State Machine

> Machine-readable authority: [action.json](action.json). Implements PROT-011,
> PROT-012, PROT-015. See [ADR-002](../../adr/adr-002-action-attempt-ingress-decision-state-separation.md).

The Action is the user-visible aggregate. `safe_retry` and `reconciled` are
NOT Action states; `reconcile`, `retry_with_same_key`, `compensate`,
`manual_review`, and `stop` are RecoveryDecision values, not Action terminal
states.

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

## Transitions

| From | Event | To | Guard |
|---|---|---|---|
| `proposed` | `authorize` | `authorized` | policy allowed; approval bound when required |
| `proposed` | `block` | `blocked` | policy blocked |
| `authorized` | `begin_execution` | `executing` | dispatch grant issued |
| `authorized` | `cancel` | `cancelled` | no grant consumed |
| `executing` | `result_received` | `result_received` | external result content received |
| `executing` | `fail_authoritative` | `failed_authoritative` | authoritative failure receipt |
| `executing` | `unknown_outcome` | `unknown_outcome` | no authoritative outcome evidence |
| `result_received` | `commit` | `committed` | ingress accepted |
| `result_received` | `quarantine` | `quarantined` | ingress verdict suspicious/malicious |
| `result_received` | `review_unavailable` | `review_unavailable` | reviewer unavailable; fail closed |
| `review_unavailable` | `retry_review` | `result_received` | review retried |
| `quarantined` | `commit` | `committed` | ingress resolved accepted |
| `quarantined` | `fail_authoritative` | `failed_authoritative` | ingress resolved rejected |
| `unknown_outcome` | `reconcile_retry` | `executing` | verified recovery decision `retry_with_same_key` AND new dispatch grant AND recovery approval |
| `unknown_outcome` | `reconcile_committed` | `committed` | authoritative completion evidence |
| `unknown_outcome` | `reconcile_failed` | `failed_authoritative` | authoritative failure evidence |

Terminal states: `committed`, `blocked`, `cancelled`, `failed_authoritative`.

## Invariants

1. Illegal transitions fail without partial state mutation (PROT-011).
2. Timeout or transport loss is never authoritative external failure
   (PROT-012); it produces `unknown_outcome`.
3. An expired dispatch grant without authoritative acknowledgement produces
   an unknown Attempt (PROT-013) and, at Action level, `unknown_outcome`.
4. Framework checkpoints correlate with Actions but never satisfy Attempt or
   receipt transitions (PROT-014).
5. `unknown_outcome` becomes `committed` or `failed_authoritative` only from
   authoritative reconciliation; a retry creates a NEW Attempt under a
   verified recovery decision (PROT-015).
6. An advisory receipt never drives `result_received -> committed` or
   `executing -> failed_authoritative` (PROT-029).
