# ActionAttempt State Machine

> Machine-readable authority: [attempt.json](attempt.json). Implements
> PROT-011, PROT-013, PROT-014. See [ADR-002](../../adr/adr-002-action-attempt-ingress-decision-state-separation.md).

Each physical callback has exactly one Attempt. A new callback requires a new
Attempt that retains the Action identity and, when applicable, the verified
idempotency identity.

```text
prepared -> dispatch_authorized | cancelled | failed_local
dispatch_authorized -> acknowledged | cancelled | unknown
acknowledged -> response_received | failed_authoritative | unknown
```

## Transitions

| From | Event | To | Guard |
|---|---|---|---|
| `prepared` | `grant` | `dispatch_authorized` | dispatch grant issued and bound |
| `prepared` | `cancel` | `cancelled` | no grant issued |
| `prepared` | `local_error` | `failed_local` | local exception before dispatch |
| `dispatch_authorized` | `ack` | `acknowledged` | authoritative acknowledgement persisted |
| `dispatch_authorized` | `cancel` | `cancelled` | provider provably not called |
| `dispatch_authorized` | `expiry` | `unknown` | grant expired without authoritative acknowledgement (PROT-013) |
| `acknowledged` | `response` | `response_received` | external result content received |
| `acknowledged` | `fail_authoritative` | `failed_authoritative` | authoritative failure receipt |
| `acknowledged` | `unknown` | `unknown` | no authoritative outcome evidence |

Terminal states: `cancelled`, `failed_local`, `response_received`,
`failed_authoritative`, `unknown`.

## Invariants

1. `unknown` is terminal for an Attempt. Action-level recovery proceeds
   through NEW Attempts, never by mutating an unknown Attempt.
2. A non-idempotent, non-queryable `unknown` Attempt has no automatic replay
   path (M0 exit gate): no transition from `unknown` exists.
3. Local exceptions, transport errors, HTTP success, and provider request IDs
   are not authoritative effect outcomes by default.
