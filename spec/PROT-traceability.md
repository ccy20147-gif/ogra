# PROT Requirements Traceability

> Milestone: M0 — Protocol and Architecture Freeze.
>
> Authority for requirement text: [docs/plans/03-protocol-and-state-machine-requirements.md](../docs/plans/03-protocol-and-state-machine-requirements.md).
> This table maps every `PROT-*` requirement to its schema, ADR, golden
> vector, and acceptance evidence. Coverage is verified by
> `tools/verify-m0.sh`.

Legend: S = schema file under `spec/v0alpha1/schemas/`; SM = state machine
under `spec/v0alpha1/state-machines/`; V = vector under
`spec/v0alpha1/vectors/`; ADR = `spec/adr/`.

| ID | Requirement (summary) | Schema / file | ADR | Golden vector | Acceptance evidence |
|---|---|---|---|---|---|
| PROT-001 | JSON Schema 2020-12 is the data-shape authority | all `S/*.schema.json` | ADR-001 | `schema-valid`, `schema-invalid` | meta-schema gate (`gates.py`) |
| PROT-002 | OpenAPI defines the first command/query transport | `spec/v0alpha1/openapi.yaml` | ADR-001 | — | OpenAPI load + drift gate (`gates.py`) |
| PROT-003 | Schema identifiers include protocol major and minor | `$id` in every schema | ADR-009 | — | meta-schema gate; `compatibility.json` |
| PROT-004 | Canonical JSON rules (keys, UTF-8, numbers, timestamps, null, omitted) | `canonical.md` | ADR-001 | `canonical-hash`, `timestamp-normalization` | dual-language hash equality |
| PROT-005 | Hashes identify canonicalization + algorithm | `_defs.schema.json` (`HashRef`) | ADR-001 | `canonical-hash` | dual-language hash equality |
| PROT-006 | IDs opaque, stable format, no Python/PID identity | `canonical.md` §7; `_defs` (`GeneratedId`, `SubmissionKey`) | ADR-001 | `schema-invalid` (bad IDs) | schema gate + vectors |
| PROT-007 | Deterministic behavior for unknown fields/enums/versions | `canonical.md` §5, §8 | ADR-009 | `schema-invalid`, `minor-version` | vector suite |
| PROT-008 | Mutating commands carry command identity + expected positive revision | `openapi.yaml` (`X-Ogra-Command-Id`, `X-Ogra-Expected-Revision` -> `RevisionRef`); creation commands carry command id only and MUST NOT carry expected revision (P1-4) | ADR-001 | — | OpenAPI header matrix gate |
| PROT-009 | Errors typed, sanitized, retry-classified | `error-envelope.schema.json` | ADR-001 | `schema-valid` (`error-envelope`) | schema gate |
| PROT-010 | Golden vectors cover valid/invalid/boundary/upgrade/hash | `vectors/` manifest | ADR-001, ADR-009 | all vector files | dual-language identical verdicts |
| PROT-011 | Illegal transitions fail without partial mutation | `SM/*.json` | ADR-002 | `transitions-invalid` | vector suite |
| PROT-012 | Timeout/transport loss is not authoritative failure | `receipts.md`; `SM/action.json` | ADR-002, ADR-004 | `receipt-authority` (`ra-timeout-*`) | vector suite |
| PROT-013 | Expired grant without authoritative ack -> unknown Attempt | `SM/attempt.json` (`expiry`) | ADR-002, ADR-004 | `transitions-valid` (`tv-attempt-expiry-unknown`) | vector suite |
| PROT-014 | Framework checkpoints never satisfy Attempt/receipt transitions | `_defs.schema.json` (`CorrelationRef`) | ADR-002, ADR-007 | — | schema purity + ADR |
| PROT-015 | Unknown resolves only via authoritative reconciliation; retry = new Attempt | `SM/action.json` (`reconcile_*`), `SM/attempt.json` | ADR-002 | `transitions-valid` (`tv-action-reconcile-*`), `transitions-invalid` (`tx-attempt-unknown-*`) | vector suite + no-auto-replay gate |
| PROT-016 | `governance_profile` is `observe` or `govern` | `_defs.schema.json` (`GovernanceProfile`) | ADR-004 | `schema-invalid` (`sx-server-hello-unknown-governance`) | schema gate |
| PROT-017 | `execution_profile` is `inline` or `edge_mediated` | `_defs.schema.json` (`ExecutionProfile`) | ADR-004 | `schema-invalid` (`sx-action-intent-unknown-execution-profile`) | schema gate |
| PROT-018 | Recovery capabilities operation-scoped, 4 values | `capability-manifest.schema.json` | ADR-008 | `unknown-capability` (`uc-operation-scoped-trust`, `uc-missing-conformance-ref-fails-closed`) | vector suite |
| PROT-019 | `isolation_profile` is development/supervised/hardened | `_defs.schema.json` (`IsolationProfile`) | ADR-005 | — | schema gate |
| PROT-020 | Profiles reported independently in API and evidence | `_defs.schema.json` (`Profiles`), `server-hello.schema.json` | ADR-004 | `schema-valid` (`sv-server-hello-valid`) | schema gate |
| PROT-021 | Manifest claim enables recovery only after trusted conformance (per operation); duplicate operation/conformance ids rejected (DUPLICATE_ID) | `capability-manifest.schema.json` (`conformance`, `conformance_refs`); `error-envelope.schema.json` (`DUPLICATE_ID`) | ADR-008 | `unknown-capability` (`uc-untrusted-conformance-no-enable`, `uc-operation-scoped-trust`, `uc-multiple-refs-all-must-be-trusted`, `uc-duplicate-*`) | vector suite |
| PROT-022 | Every receipt identifies execution profile | `external-receipt.schema.json` (`execution_profile`) | ADR-004 | `schema-valid` (`sv-external-receipt-valid`) | schema gate |
| PROT-023 | Inline never advertised as Edge-isolated | `profiles.md` §2 | ADR-004 | — | ADR + profile doc |
| PROT-024 | Edge-mediated never implies exactly-once | `profiles.md` §2, `spec/README.md` | ADR-004 | — | ADR + no-replay gates |
| PROT-025 | Replay eligibility machine-readable | `payload-ref.schema.json` (`replay_eligible`) | ADR-006 | `hash-only-replay` | vector suite |
| PROT-026 | Hash-only payload never in automatic retry path | `payload-ref.schema.json` (if/then), `SM/attempt.json` | ADR-006 | `hash-only-replay` (`rp-hash-only-*`), `transitions-invalid` | vector suite + no-auto-replay gate |
| PROT-027 | Evidence excludes encrypted material, key ids, secrets | `audit-event.schema.json` (`summary`), `canonical.md` | ADR-006, ADR-010 | — | schema purity + ADR |
| PROT-028 | HTTP success / provider request ID advisory by default; authority is not self-declared | `external-receipt.schema.json` (kind/authority if-then), `receipts.md` §5 | ADR-004 | `receipt-authority` (`ra-http-2xx-advisory`, `ra-provider-request-id-advisory`, `ra-transport-ack-self-declared-authoritative`), `schema-invalid` (`sx-receipt-*`) | vector suite |
| PROT-029 | Only authoritative completion/failure resolves executing/unknown; trusted context and a matching server-persisted Attempt are required (fail-closed) | `receipts.md` §5; `SM/action.json` | ADR-004 | `receipt-authority` (incl. missing Attempt, Attempt/Action identity, and destination mismatch vectors) | vector suite + `gates.py` `receipt-resolution-binding` |
| PROT-030 | `submission_key` caller-stable, scoped, unique mapping | `_defs.schema.json` (`SubmissionKey`), `action-intent.schema.json` | ADR-001 | `submission-reattach` | vector suite |
| PROT-031 | Repeated key returns existing identity; conflicting request rejected | `openapi.yaml` (POST /actions, /runs) | ADR-001 | `submission-reattach` (`re-same-key-*`) | vector suite + OpenAPI |

## M0 exit-gate coverage

| Exit gate | Where verified |
|---|---|
| All schemas pass Draft 2020-12 meta-schema | `gates.py` `meta-schema` |
| OpenAPI loads in a standard parser | `gates.py` `openapi-load+drift` (openapi-spec-validator) |
| PROT-008 header matrix (create/mutate/read-only) and positive expected revisions | `gates.py` `openapi-headers` (`X-Ogra-Expected-Revision` must reference `RevisionRef`) |
| Receipt Action resolution requires a matching server-persisted Attempt | `receipt-authority` vectors + `gates.py` `receipt-resolution-binding` |
| Python and TypeScript validators agree on all vectors | `verify-m0.sh` (diff of PASS/FAIL lines + SUMMARY) |
| Canonical hash identical across languages | `canonical-hash` vectors run by both validators |
| Non-idempotent, non-queryable unknown Attempt has no auto-replay path | `gates.py` `no-auto-replay` + `transitions-invalid` |
| Advisory receipt cannot drive Action success; trusted context fail-closed | `receipt-authority` vectors + `gates.py` `receipt-resolution-binding` |
| No framework/language-specific types in schemas | `gates.py` `schema-purity` |
| Markdown links, formatting, `git diff --check` (tracked + untracked) | `gates.py` `markdown-links`, `files-format`; `verify-m0.sh` |
| Validators run DECLARED dependency versions; first-run repair does not retain stale failures | `verify-m0.sh` (`ensure_deps.py`, offline `test_ensure_deps.py` regression, `npm ci`) |
| One repeatable verification command | `tools/verify-m0.sh` |
