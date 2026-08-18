# Ogra Protocol Specification

> Authority: this directory is the normative source of truth for the Ogra
> wire contract. Python classes, TypeScript types, SQLite rows, and framework
> state are projections, never authorities.

## Versioned protocol

- Active protocol version: `0.1` (maturity `alpha`, directory `v0alpha1`).
- The active directory is `spec/v0alpha1/`.
- Version mapping is machine-readable in [`spec/compatibility.json`](../compatibility.json).
- Schema identifiers include the protocol version in their `$id`
  (e.g. `https://ogra.dev/spec/v0alpha1/schemas/action-intent.schema.json`).

## Contents

| Area | File |
|---|---|
| Canonical JSON, hashing, time, numbers, `null`, IDs | [canonical.md](canonical.md) |
| Execution / governance / recovery / isolation profiles | [profiles.md](profiles.md) |
| Receipt kind, authority, effect status | [receipts.md](receipts.md) |
| Action state machine | [state-machines/action.md](state-machines/action.md) |
| Attempt state machine | [state-machines/attempt.md](state-machines/attempt.md) |
| Ingress state machine | [state-machines/ingress.md](state-machines/ingress.md) |
| RecoveryDecision state machine | [state-machines/recovery-decision.md](state-machines/recovery-decision.md) |
| JSON Schema objects | [schemas/](schemas/) |
| Command/query transport contract | [openapi.yaml](openapi.yaml) |
| Golden vectors | [vectors/](vectors/) |
| Requirements traceability | [../PROT-traceability.md](../PROT-traceability.md) |
| Architecture decision records | [../adr/](../adr/) |

## Rules that override everything else

1. JSON Schema 2020-12 is the data-shape authority (PROT-001).
2. The protocol contains no LangChain, Electron, Pydantic, SQLite, or Python
   object semantics (M0 exit gate).
3. No exactly-once promise exists anywhere in the protocol (PROT-024).
4. `read_only` never implies `replay_safe` (handbook §8.2).
5. HTTP 2xx and provider request IDs are advisory unless an adapter contract
   proves stronger semantics (PROT-028).
6. Unknown outcomes never convert automatically to failed, success, or
   retryable (handbook §8.2, PROT-015).
7. Edge-mediated execution never creates safe retry capability (PROT-024).
8. `hash_only` payload references are mechanically ineligible for replay
   (PROT-026).

## Validation

```bash
tools/verify-m0.sh
```

runs every M0 exit gate: meta-schema validation, OpenAPI load, Python and
TypeScript vector agreement, canonical-hash agreement, replay-path absence,
markdown/link/whitespace checks, and schema purity.
