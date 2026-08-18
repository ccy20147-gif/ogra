# Ogra Protocol Specification (spec/)

This directory is the normative source of truth for the Ogra Action Protocol.
Python classes, TypeScript types, SQLite rows, and framework state are
projections, never authorities.

## Layout

```text
spec/
├── compatibility.json          machine-readable protocol compatibility matrix
├── PROT-traceability.md        PROT-001..PROT-031 -> schema/ADR/vector mapping
├── adr/                        ADR-001..ADR-010 decision records
└── v0alpha1/                   protocol version 0.1 (alpha)
    ├── README.md               index of the versioned protocol
    ├── canonical.md            ogra-jcs-1, hashing, time, numbers, null, IDs
    ├── profiles.md             governance / execution / recovery / isolation
    ├── receipts.md             receipt kind, authority, effect status
    ├── state-machines/         Action, Attempt, Ingress, RecoveryDecision
    ├── schemas/                JSON Schema 2020-12 objects (the authority)
    ├── openapi.yaml            command/query transport contract (generated)
    └── vectors/                golden vectors (cross-language contract)
```

## Validation

```bash
tools/verify-m0.sh
```

runs every M0 exit gate (meta-schema, OpenAPI load, dual-language vectors,
canonical-hash agreement, replay-path absence, purity, links, `git diff
--check`).
