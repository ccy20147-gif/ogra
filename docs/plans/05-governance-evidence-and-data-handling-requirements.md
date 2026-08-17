# Governance, Evidence, and Data-Handling Requirements

> Milestone: M2
>
> Requirement prefix: `GOV`

## 1. Scope

This milestone governs data before every Ogra-controlled model or tool call,
reviews returned content before Agent observation, and persists enough sanctioned
state for evidence and explicitly eligible recovery.

## 2. Egress Pipeline

```text
derive destination and operation
  -> classify payload high-water mark
  -> evaluate deterministic policy and route
  -> allow, redact, request approval, or block
  -> bind exact sanctioned payload
  -> persist intent and payload reference
  -> authorize dispatch
```

## 3. Normative Requirements

- **GOV-001**: Policy MUST complete before dispatch authorization.
- **GOV-002**: Classification MUST use a versioned rule set and record its
  confidence and high-water result.
- **GOV-003**: No policy match MUST fail closed in governed mode.
- **GOV-004**: Policy outcomes MUST be `allow`, `redact`, `approve`, or `block`.
- **GOV-005**: Redaction MUST operate on the actual serialized outbound shape,
  not only a display preview.
- **GOV-006**: The recording sink MUST be able to assert exact outbound bytes.
- **GOV-007**: Blocked Actions MUST produce zero provider callback attempts.
- **GOV-008**: Policy and classifier failure MUST fail closed in governed mode.

## 4. Approval Binding

Approval MUST bind:

- canonical sanctioned payload hash;
- Action and Attempt identity;
- destination and operation;
- policy, classifier, and redaction versions;
- principal, tenant/workspace scope, and execution profile;
- revision, expiry, and one authorized dispatch use.

- **GOV-009**: Any binding change MUST invalidate approval.
- **GOV-010**: Approval consumption MUST be atomic with dispatch authorization.
- **GOV-011**: Re-sanitization MUST create a new payload hash and approval.
- **GOV-012**: Approval secrets MUST never enter framework callbacks or ordinary
  evidence output.
- **GOV-029**: A retry MUST use a new recovery approval bound to the new Attempt,
  the original sanctioned payload, stable identity, and verified recovery
  decision. A consumed approval MUST never authorize another dispatch.

## 5. Payload Persistence

Runtime payload storage and audit evidence are separate concerns.

- **GOV-013**: `hash_only` MUST be the default when replay is unnecessary.
- **GOV-014**: Replayable bytes MUST use authenticated encryption, an explicit
  retention class, key ID, expiry, and deletion status.
- **GOV-015**: Decryption MUST require a typed operation and produce an audit event.
- **GOV-016**: Expired or deleted payload material MUST make replay ineligible.
- **GOV-017**: Logs, summaries, traces, and error envelopes MUST not contain raw
  secrets or replayable payloads by default.
- **GOV-018**: Key loss MUST fail closed and surface a non-replayable reason.

## 6. Ingress Pipeline

```text
external result
  -> persist receipt/result reference
  -> deterministic and configured scanner review
  -> accept, quarantine, or review_unavailable
  -> expose accepted observation or stop
```

- **GOV-019**: External content MUST be untrusted until accepted.
- **GOV-020**: Quarantined content MUST not enter Agent state or normal UI output.
- **GOV-021**: Reviewer unavailable MUST fail closed in governed production mode.
- **GOV-022**: Development overrides MUST be explicit, visible, and recorded.
- **GOV-023**: Scanner findings MUST use bounded evidence and stable rule IDs.
- **GOV-024**: Streaming content MUST be buffered or gated until safe release.

## 7. Evidence Projection

Every Action summary MUST answer:

- destination and operation;
- governance and execution profiles;
- policy outcome and rule versions;
- what categories were redacted, without exposing values;
- approval status when applicable;
- receipt, failure, or `unknown_outcome`;
- ingress decision;
- recovery capabilities and evidence link.

- **GOV-025**: Evidence MUST state the Ogra-controlled coverage boundary.
- **GOV-026**: A normal no-redaction run MUST report `allowed`, not fabricate
  redaction or approval activity.
- **GOV-027**: Audit verification MUST be available offline.
- **GOV-028**: Development Quickstart MUST ship a visible, versioned default
  policy that allows classified low-risk data to known configured destinations,
  redacts supported sensitive patterns, and blocks restricted data and unknown
  destinations. Production MUST require explicit policy ownership.

## 8. Acceptance Matrix

| Case | Required result |
|---|---|
| public payload, allowed destination | authorized and recorded |
| sensitive field with redaction rule | exact sent bytes are sanitized |
| approval-required payload | no dispatch before valid approval |
| payload mutated after approval | binding rejection |
| blocked destination | zero callback count |
| suspicious result | quarantine, no Agent observation |
| reviewer unavailable in production | fail closed |
| hash-only payload after crash | no replay eligibility |

## 9. Non-Goals

- perfect or system-wide DLP;
- control of calls that bypass Ogra;
- storing raw payloads in ordinary audit records;
- claiming independent isolation for an in-process development scanner;
- releasing unreviewed streaming tokens for latency alone.
