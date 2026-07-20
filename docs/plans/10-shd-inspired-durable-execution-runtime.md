# 10 SHD-Inspired Durable Execution Runtime

> Status: active implementation plan
>
> Phase coverage: Alpha foundation, Beta/v1 expansion
>
> Depends on: [02 Local Data, Audit, and Governance Store](02-local-data-audit-governance-store.md), [03 Policy, Routing, and Safety Engine](03-policy-routing-safety-engine.md), [05 Model and Agent Orchestration](05-model-agent-orchestration.md)

## 1. Goal

Build an Ogra-native durable execution kernel that can recover tool-using Agent
runs without losing effect ownership, repeating unsafe side effects, repairing
the wrong task branch, or treating stale approval and memory as current truth.

The design is informed by the local SHD research project, especially its
effect-scoped task frames, repair overlays, branch-local revisions, typed repair
verification, recovery capsules, and bidirectional audit indexes.

The implementation decision is:

> Adopt the SHD runtime invariants, but implement them in Ogra's existing
> TypeScript and SQLite stack. Do not make the Python research prototype a
> production dependency or sidecar.

## 2. Decision Boundary

Ogra adopts these ideas:

- persistent task-frame lineage;
- one owning frame for every externally visible effect;
- separate effect identity, payload fingerprint, and idempotency identity;
- explicit effect states and allowed repair actions;
- effect dependencies and typed repair-plan verification;
- target-subtree revisions and authorized cross-frame effect revisions;
- local recovery lease/CAS before a crashed run is resumed;
- recovery capsules containing the evidence needed to decide safely;
- local audit packets that recover frame, effect, route, approval, and repair lineage.

Ogra does not adopt these claims or dependencies:

- SHD is not a new planner and does not replace Plan + ReAct;
- SHD does not guarantee exactly-once invocation or automatic rollback;
- SHD is not proven superior to a complete Saga or durable workflow engine;
- the Python prototype is not a packaged or licensed Ogra dependency;
- LangGraph remains a useful verification baseline, not an Alpha desktop runtime dependency.

The local SHD evidence explicitly shows that complete SHD and packaged-Saga
recovery capsules can tie. The product requirement is therefore
representation-neutral: preserve the complete recovery evidence and enforce the
invariants, regardless of whether the internal implementation is described as
task frames, a typed Saga, or both.

## 3. Runtime Objects

### 3.1 Execution Frame

An execution frame is the durable owner of one bounded unit of work. It may
represent a plan step, a ReAct iteration group, an Agent Group member step, or a
repair attempt.

Required fields:

```text
run_frames
  id
  run_id
  parent_frame_id
  run_step_id
  frame_kind: root | plan_step | react | repair | synthesis
  status: pending | running | awaiting_approval | completed | failed | cancelled
  path_json
  node_revision
  subtree_revision
  input_hash
  output_hash
  created_event_id
  terminal_event_id
  created_at
  updated_at
```

`run_steps` remains the user-visible plan/group step. `run_frames` is the finer
runtime and repair structure. A simple run may map one step to one frame; nested
repair must not be flattened into an unrelated global retry.

### 3.2 Effect Ledger

An effect is any action whose outcome matters to recovery or audit, including:

- cloud model egress;
- file write or export;
- MCP/A2A/tool invocation;
- local command execution;
- approval-bound action;
- ingress acceptance or quarantine decision;
- memory proposal, confirmation, edit, or deletion.

Core-internal retrieval and file reads that are not exposed through Tool Broker
may remain observations, but they still produce access evidence and can raise
the run high-water classification. Every capability exposed through Tool Broker,
including read-only `knowledge.search`, owns an effect under plan 11.

Required fields:

```text
run_effects
  id
  run_id
  owner_frame_id
  effect_type
  adapter_kind
  payload_fingerprint
  callback_capsule_ref
  callback_capsule_hash
  callback_capsule_format_version
  idempotency_key_ref
  idempotency_key_hash
  state: planned | in_flight | unknown | received | committed |
         quarantined | compensating | compensated | failed |
         cancelled_before_send
  allowed_repair_actions_json
  dependency_effect_ids_json
  effect_revision
  route_decision_id
  policy_evaluation_id
  current_approval_id
  egress_record_id
  ingress_finding_id
  external_request_id
  authoritative_receipt_id
  external_receipt_hash
  created_event_id
  terminal_event_id
  created_at
  updated_at
```

The same idempotency key hash MUST NOT be reused for a different owner frame or
a different payload fingerprint. The exact sanitized callback request and raw
idempotency key, when one exists, MUST be recoverable from workspace-scoped,
authenticated-encrypted sealed storage. They are not stored in the effect row,
audit, renderer state, logs, or telemetry. The callback capsule excludes auth
tokens and binds its format version, payload fingerprint, effect/owner ids,
adapter identity/version, and target scope as authenticated data.

External attempts and receipts MUST be retained separately from the logical
effect so verification can distinguish callback attempts from physical
application evidence:

```text
effect_receipts
  id
  effect_id
  attempt_no
  request_id
  request_hash
  response_hash
  result_capsule_ref
  result_capsule_hash
  result_capsule_format_version
  provider_status
  application_status: not_applied | applied | unknown
  receipt_hash
  received_at
  event_id
  UNIQUE(effect_id, attempt_no)
```

A new callback attempt appends a receipt row; it MUST NOT overwrite evidence
from an earlier attempt.

Each physical callback attempt has immutable approval lineage:

```text
effect_approval_bindings
  id
  effect_id
  callback_attempt_no
  approval_id
  approval_revision
  binding_kind: initial | recovery_retry
  created_event_id
  UNIQUE(effect_id, callback_attempt_no)
```

`run_effects.current_approval_id` is a convenience pointer only. It may advance
to a recovery approval but MUST NOT overwrite or replace bindings and
consumptions from earlier attempts.

The exact returned value needed for ingress recovery is stored as a
workspace-scoped authenticated-encrypted result capsule. It binds workspace,
effect, receipt/attempt, adapter version, and response hash as authenticated
data. The result is never copied into audit, renderer state, logs, or telemetry.

### 3.2.1 Sealed Capsule Durability Protocol

When capsules use filesystem-backed sealed storage, SQLite and the filesystem
are coordinated by this write-ahead protocol; Ogra MUST NOT claim a cross-store
atomic transaction:

```text
1. Generate stable effect/attempt ids and bound the payload size.
2. AEAD-seal the versioned capsule into a workspace-scoped temporary file in
   the same filesystem/directory durability domain as the final path.
3. fsync the completed temporary file.
4. Atomically rename with no-replace semantics to the immutable
   content-addressed path.
5. fsync the destination directory after rename (and the source directory when
   distinct), then reopen, decrypt/verify authenticated data, and compare hash.
6. In one SQLite transaction, write the capsule ref/hash/version and owning
   effect or receipt, plus the corresponding state/event transition.
7. Only after DB commit may callback begin (outbound capsule) or adapter
   completion become visible to the orchestrator (result capsule).
```

A crash before step 6 may leave an unreferenced immutable orphan but MUST NOT
leave a DB row pointing to a non-durable capsule. A bounded, policy-gated,
audited garbage collector removes unreferenced capsules only after a grace
period; orphan presence is never outcome evidence. A failure before durable
result receipt commit leaves a sent effect `unknown`. A failure after DB commit
leaves `received` and recovery reruns ingress without callback. An implementation
may instead use a dedicated authenticated-encrypted SQLite BLOB table, in which
case capsule, receipt/effect, state, and event commit in the same SQLite
transaction and the same integrity/retention rules apply.
If the platform cannot provide the required same-filesystem atomic no-replace
rename and directory durability primitives, filesystem capsules fail closed and
Ogra uses the same-transaction encrypted-BLOB backend instead.

Allowed effect transitions are:

```text
planned   -> in_flight | cancelled_before_send | failed
in_flight -> received | unknown | failed (only with trusted not_applied evidence)
received  -> committed | quarantined | failed
unknown   -> received | committed | quarantined | failed | in_flight
committed -> compensating (only when verified compensation is supported)
compensating -> compensated | failed | unknown
```

Every `unknown` transition requires recovery lease plus typed reconciliation;
`unknown -> in_flight` additionally requires verified idempotent retry, a valid
sealed callback capsule, current policy/approval, and a new attempt number.
`cancelled_before_send` is terminal evidence that callback did not start.
Cancellation after send cannot use that state and does not prove `not_applied`.

### 3.3 Repair Transaction

```text
repair_transactions
  id
  run_id
  target_frame_id
  target_subtree_revision
  authorized_effect_revisions_json
  proposed_plan_json
  verification_result_json
  status: open | accepted | rejected | committed | aborted
  rejection_reason
  created_event_id
  terminal_event_id
  created_at
  updated_at

repair_steps
  id
  repair_transaction_id
  step_index
  effect_id
  action: retry | compensate | preserve | amend | reconcile | escalate
  status
  outcome_hash
  event_id
```

Before commit, the verifier MUST check:

- every referenced effect exists;
- each effect appears at most once in the repair plan;
- the effect belongs to the target frame subtree or has explicit authorization;
- the action is permitted for the effect type and current state;
- dependencies appear before dependent effects;
- the target subtree revision has not changed;
- every authorized external effect still has the snapshotted revision;
- approval still matches the current payload fingerprint and rule version;
- the sealed callback capsule and idempotency reference are intact and match
  their hashes, format version, owner/effect, adapter, and approved payload;
- policy and route checks still allow the action.

### 3.4 Recovery Lease

```text
recovery_leases
  run_id
  holder_id
  lease_version
  acquired_at
  expires_at
  renewed_at
  released_at
```

Recovery uses SQLite transaction/CAS semantics. Only the lease holder may move
an interrupted effect out of `unknown`, finalize a recovered `received` effect,
or commit a repair transaction. Alpha only claims local single-device
coordination, not distributed consensus.

## 4. Effect Execution Protocol

Every effect follows this two-phase runtime-enforced protocol:

```text
1. Sanitize and validate the exact callback payload; evaluate policy and route.
2. In one SQLite transaction:
   - create/update the owner frame;
   - create the effect in planned state;
   - persist references/hashes for the sealed callback capsule and idempotency key;
   - append the prepare intent event.
3. If approval is required, request it against effect id/revision, payload
   fingerprint, scope, and rule/policy revisions; keep the effect planned and
   the frame awaiting approval. Persist a new attempt-specific
   `effect_approval_bindings` row; never overwrite an earlier attempt's approval.
4. Immediately before callback, one CAS transaction:
   - verifies effect/frame, capsule hash, policy/route, adapter, target revisions,
     and current approval;
   - atomically reserves/consumes the permitted approval use;
   - transitions the effect to in_flight and appends callback intent.
5. Invoke the adapter callback with the sealed stable idempotency key where supported.
6. After a result arrives, in one transaction append the receipt and sealed
   result capsule, then transition `in_flight -> received` before the adapter
   reports completion to the orchestrator or releases the session.
7. Run independent ingress review against the verified result capsule.
8. In one SQLite transaction:
   - CAS `state = received`, effect revision, and authoritative receipt id;
   - persist ingress finding/incident and accepted Observation exactly once;
   - transition effect to committed, quarantined, or failed;
   - append post-audit event;
   - expose no result when the CAS loses; reload authoritative state instead.
```

Alpha combines all policy obligations for one callback attempt into one exact
approval decision. Approval consumption is recorded by approval, effect, and
callback attempt number and is not refunded after send, including when the
result becomes `unknown`. Recovery operates on the same effect; when policy
permits another attempt it obtains a new explicitly scoped approval and attempt
number. It never resets a prior one-use approval counter.

The external callback cannot be atomic with local SQLite. A crash after remote
application but before local acknowledgment therefore produces `unknown`, not
`failed`. Recovery must reconcile the external outcome or retry with the same
idempotency key. When an adapter cannot query outcome or guarantee idempotent
application, Ogra must fail closed or request a user decision.

A restart from `received` decrypts/verifies the result capsule and reruns ingress
review; it MUST NOT invoke the external callback again. A sent attempt lacking a
complete trusted receipt/result capsule transaction is `unknown`. Missing,
corrupt, expired, wrong-workspace, or hash-mismatched result material fails
closed and creates an incident rather than silently becoming a retry.
Recovered ingress requires the run recovery lease. Normal and recovery
finalizers both use the same effect/receipt/revision CAS; a losing reviewer
discards its uncommitted result and reloads, so findings, incidents,
Observations, terminal state, and events are persisted exactly once.

Before a permitted retry, recovery decrypts the sealed callback capsule,
revalidates its schema, policy, approval, adapter/version, target revisions, and
scope, and requires its canonical hash to equal the approved payload
fingerprint. A missing, expired, corrupt, undecryptable, or mismatched capsule or
idempotency-key reference prohibits automatic retry and creates an incident.

## 5. Adapter Recovery Capabilities

Every model, tool, Agent, MCP, and A2A adapter MUST declare:

```text
recovery_capabilities
  supports_idempotency_key
  supports_outcome_query
  supports_cancel
  supports_compensation
  compensation_is_lossless
  retry_cost_risk
  duplicate_effect_risk
  audit_level
```

Tool and MCP adapters additionally follow
[11 Tool Broker and MCP Integration Runtime](11-tool-broker-mcp-integration-runtime.md).
Every tool invocation, including a read-only invocation, owns one effect. MCP
request/session identifiers are correlation evidence only and cannot satisfy
idempotency or outcome-query capability.

Default recovery behavior:

| Effect | Default recovery |
|---|---|
| Local retrieval/read | retry after policy and source revision check |
| Local file write | content-hash check; use temp file + atomic rename where possible |
| Memory write | transaction/upsert by stable operation id |
| Cloud model call | reconcile by provider request id; otherwise surface cost/duplicate risk |
| Egress/upload/export | require stable payload hash and idempotency/receipt evidence |
| MCP/A2A/tool call | follow declared adapter capability; fail closed when unknown |
| Local command | never auto-retry a side-effecting command without a verified manifest and idempotency contract |

## 6. Audit Integration

`run_events` remains the append-only, hash-chained audit source of truth.
Frame/effect/repair tables are durable operational state and query projections.
Every state transition MUST link to a run event.

Audit events add these causal fields when applicable:

```text
frame_id
effect_id
repair_transaction_id
caused_by_event_id
payload_fingerprint
effect_revision
target_subtree_revision
idempotency_key_hash
external_receipt_hash
```

The rebuildable bidirectional index uses explicit edges:

```text
audit_edges
  id
  run_id
  from_kind: run | frame | effect | repair | memory | event
  from_id
  relation
  to_kind: run | frame | effect | repair | route | policy | approval |
           egress | ingress | receipt | memory | event
  to_id
  source_event_id
  created_at
```

`audit_edges` is a query projection, not independent recovery authority. Missing
or extra edges are repaired from L0 state and L1 events, and the rebuild itself
is audited.

The raw idempotency key, secret, full sensitive payload, and hidden model
chain-of-thought MUST NOT be written to audit. Store hashes and structured action
rationales instead.

Bidirectional audit indexes MUST support:

- frame -> owned effects;
- effect -> owner frame;
- frame -> repair transactions;
- effect -> route/policy/approval/egress/ingress evidence;
- frame/effect -> path to run root;
- memory -> source frames/effects/events;
- local audit packet generation without scanning the entire run log.

Indexes are rebuildable from authoritative state and run events. Index drift
must be detectable by a consistency verifier.

## 7. Memory Integration

SHD-style execution state and M3 Memory have different authority and MUST NOT be
merged into one store or retrieval path.

```text
L0 Runtime State   frames, effects, revisions, approvals, receipts
L1 Audit Evidence  hash-chain events and local audit packets
L2 Episodic        source-linked run/frame outcome summaries
L3 Semantic        user-confirmed facts derived from accepted evidence
L4 Procedural      user-confirmed reusable tool/route/repair patterns
```

Rules:

- L0/L1 are authoritative for recovery; L2-L4 are not.
- terminal frames may automatically produce episodic candidates.
- semantic candidates may use only accepted ingress observations and must retain source links.
- procedural candidates may summarize successful toolchains or repairs, but cannot copy concrete idempotency keys, approvals, or live effect state.
- every derived memory links to source frame ids, effect ids, event ids, and source revision/hash.
- memory retrieval may inform planning, but every side effect revalidates current policy, approval, source revision, and effect state immediately before callback.
- edited or stale memory cannot silently change an open recovery transaction.
- memory never authorizes cross-frame effects; authorization remains a first-class approval/policy record.

## 8. Recovery Flow

On application startup or worker restart:

```text
1. Find runs/frames in running, awaiting_approval, or interrupted states.
2. Acquire the local recovery lease.
3. Load the recovery capsule:
   - target frame and subtree revision;
   - effects, owners, states, dependencies, and revisions;
   - applied/idempotency evidence and external receipts;
   - route, policy, approval, egress, and ingress references;
   - last accepted Observation and artifact hashes.
4. Re-run policy and high-water classification.
5. Reconcile unknown external outcomes.
6. Verify a typed recovery decision.
7. Execute resume, retry, compensate, replan, or escalate.
8. Append recovery events and release/renew the lease.
```

Approval-bound effects return to `awaiting_approval` when payload fingerprint,
redaction rule version, target revision, policy version, or approval scope has
changed.

## 9. Implementation Sequence

### Milestone 0: Contract and Migration

- define TypeScript frame/effect/recovery types and state machines;
- add SQLite migration and constraints;
- add atomic service methods that append run events with state changes;
- add adapter recovery capability declarations;
- add consistency verifier and schema tests.

Exit gate: invalid state transitions, changed idempotency payloads, broken owner
links, and missing audit events fail deterministically.

### Milestone 1: Single-Run Durable Kernel

- connect InternalAgentAdapter Plan/ReAct steps to frames;
- execute one mocked external effect through the full protocol;
- implement unknown-outcome reconciliation and local recovery lease;
- implement typed repair verification and local audit packet query;
- add crash injection before callback, after callback, and before local commit.

Exit gate: a fresh process can resume without duplicate physical application in
the idempotent fixture and blocks stale or out-of-scope repair before callback.

### Milestone 2: Alpha Trust Loop

- apply the kernel to Confidential redaction/approval/cloud egress;
- bind approval to sanitized payload fingerprint and rule version;
- route cloud response through independent ingress review before Observation commit;
- surface interrupted/unknown/recovery states in Run Workspace and Governance;
- include frame/effect lineage in route trace and audit export.

Exit gate: the Alpha demo survives each specified crash point and preserves
egress, ingress, approval, and audit evidence.

### Milestone 3: Memory Projection

- generate episodic memory from terminal audit packets;
- propose semantic/procedural memory with frame/effect/event provenance;
- implement source revision and stale-memory indicators;
- prevent M3 retrieval from authorizing or mutating recovery state.

Exit gate: memory can explain its source and inform a later plan, while stale or
edited memory cannot change an open effect or approval.

### Milestone 4: Agent Group and External Adapters

- give Pipeline/Parallel/Debate steps their own frame subtrees;
- isolate sibling-owned effects during repair;
- add per-adapter recovery behavior for LocalCommand and A2A, and integrate MCP
  only after plan 11 T4/T5 gates;
- add interval/continuous run lease and lifetime-bound recovery tests.

Exit gate: failure in one branch preserves safe sibling effects and repair
lineage remains visible.

## 10. Verification Matrix

Alpha MUST test at least:

- crash before callback;
- crash after external apply but before local acknowledgment;
- process restart with an `unknown` effect;
- duplicate resume attempts with the same idempotency key;
- missing, corrupt, expired, wrong-workspace, and hash-mismatched callback
  capsule or idempotency-key material;
- two concurrent callbacks competing to consume a one-use approval;
- initial approval followed by `unknown -> in_flight` attempt 2 with a new
  recovery approval, preserving both immutable approval lineages;
- approval expiry/revocation between prepare and pre-callback CAS;
- two recovery readers competing for one lease;
- expired lease takeover;
- sibling-owned repair overreach;
- explicitly authorized cross-frame effect;
- dependency reversal;
- target subtree revision change;
- approved payload or redaction rule change before callback;
- policy/high-water classification change after restore;
- ingress quarantine before Observation commit;
- crash after transactional `received` but before ingress/Observation commit;
- missing, corrupt, expired, wrong-workspace, or mismatched result capsule;
- duplicate receipt insertion for one effect/attempt and two ingress finalizers
  racing on one `received` effect; exactly one terminal evidence set commits;
- crash before capsule durability, after immutable rename/before DB commit, and
  after DB commit/before callback or orchestrator acknowledgment; no DB row may
  reference a non-durable capsule and orphan cleanup is audited;
- power loss after rename but before destination-directory fsync cannot produce
  a committed SQLite reference; unsupported primitives fail closed or use BLOB;
- audit index rebuild and consistency check;
- memory source revision change during a later run.

The test suite MUST distinguish callback attempts from physical external
applications. Zero duplicate applications does not imply exactly-once invocation.

## 11. Non-Goals and Guardrails

- Do not copy SHD prototype source until ownership/license is explicit.
- Do not add a Python sidecar solely for SHD semantics.
- Do not store the entire runtime as one mutable JSON checkpoint.
- Do not reconstruct an external retry from mutable Agent context or a payload
  hash alone; use the verified sealed callback capsule.
- Do not reconstruct or skip ingress from a response hash alone; use the
  verified sealed result capsule.
- Do not treat a graph checkpoint without effect evidence as sufficient recovery state.
- Do not auto-compensate when compensation semantics are unknown or lossy.
- Do not use editable M3 memories as outcome, approval, or authorization evidence.
- Do not persist hidden chain-of-thought as an audit requirement.
- Do not claim exactly-once, automatic rollback, distributed consensus, or production durability from Alpha tests.

## 12. Research Provenance

The design judgment is based on the local SHD research workspace:

- [SHD current status](../../../shd-agent-paper/START_HERE.md)
- [SHD-v2 claim boundaries](../../../shd-agent-paper/claim_defense.md)
- [SHD-v3 runtime prototype](../../../shd-agent-paper/prototype_v3/README.md)
- [Recovery-state sufficiency prototype](../../../shd-agent-paper/prototype_recovery/README.md)

These sources are research evidence and behavioral references, not runtime
dependencies. Ogra owns its product semantics, TypeScript implementation,
security boundary, and release claims.
