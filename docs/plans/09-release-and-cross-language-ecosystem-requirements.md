# Release and Cross-Language Ecosystem Requirements

> Milestones: M6 and M7
>
> Requirement prefix: `REL`

## 1. Scope

This document defines the public Alpha release gate, package and repository
policy, website proof, compatibility governance, extension ecosystem, and first
cross-language validation.

## 2. Initial Distribution

The first user-facing installation remains:

```bash
pip install "ogra[langchain]"
```

One `ogra` distribution SHOULD initially contain the SDK, local runtime, SQLite,
CLI, and protocol projection. `ogra[langchain]` adds the framework integration
and MUST contain the complete development Quickstart dependency closure.
`ogra[conformance]` adds Crash Lab and adapter-authoring fixtures;
`ogra[server]` adds explicitly hosted production-server dependencies.

- **REL-001**: Package names and project identity MUST be registered only after
  availability and trademark review.
- **REL-002**: Publishing MUST use trusted identity, provenance, and protected
  release environments.
- **REL-003**: Release artifacts MUST include checksums, SBOM, and supported
  Python/framework/protocol matrix.
- **REL-004**: Runtime, SDK, protocol, and adapters MUST publish machine-readable
  compatibility metadata even if initially distributed together.
- **REL-024**: `spec/compatibility.json` MUST publish protocol range, runtime
  version, SDK ranges, adapter API range, required capabilities, and schema URLs.
- **REL-025**: Negotiation MUST select the highest mutually supported minor in a
  shared major, fail on unknown required capabilities, and ignore only explicitly
  optional unsupported capabilities.

## 3. Repository Release Gate

Before public Alpha, the repository MUST include:

- an explicit license decision;
- `SECURITY.md`, `CONTRIBUTING.md`, code of conduct, and support policy;
- versioning and deprecation policy;
- release, rollback, and vulnerability-response procedures;
- dependency review, secret scan, artifact build, and provenance CI;
- schema, golden-vector, compatibility, Crash Lab, and package smoke tests.

- **REL-005**: A failed M4 or M5 gate MUST block public release.
- **REL-006**: Documentation snippets MUST execute in CI from a clean environment.
- **REL-026**: Release CI MUST run both the two-to-five-line integration delta
  and a complete copyable example with model, tools, input, credentials
  prerequisite, visible default policy, and evidence inspection command.
- **REL-007**: The local verifier and core governed runtime MUST remain useful
  without Ogra Cloud.

## 4. Homepage and Examples

The homepage first viewport MUST show the generic few-line LangChain code and a
truthful normal-run result. It MUST NOT require a refund, finance, healthcare,
RAG, or Desktop scenario.

Required examples:

1. ordinary model invocation;
2. read-only tool;
3. redacted outbound data;
4. exact-payload approval;
5. idempotent side effect;
6. outcome-queryable side effect;
7. unsupported `unknown_outcome`;
8. async, parallel tools, and governed streaming;
9. provider authoring and conformance.

- **REL-008**: Examples MUST use the published public API.
- **REL-009**: Capability tables MUST be generated from manifests and CI results.
- **REL-010**: Product copy MUST state coverage and execution profile boundaries.
- **REL-011**: The normal-run example MUST provide visible value without fault
  injection; Crash Lab demonstrates recovery separately.

## 5. External Validation

Before expanding Beta scope, target:

- at least 10 external developers across three Agent/tool categories;
- at least 80% reaching a governed run in five minutes;
- at least 70% naming a concrete normal-run benefit without Crash Lab;
- all participants distinguishing `committed` from `unknown_outcome`;
- at least five developers testing their own adapter or tool in Crash Lab;
- zero blind replay in unresolved conformance cases.

- **REL-012**: Feedback MUST capture setup time, bypass confusion, evidence
  usefulness, false-positive policy burden, and recovery understanding.
- **REL-013**: Failure to communicate normal-run value MUST block ecosystem scope
  expansion and trigger Quickstart/product correction.

## 6. Extension Ecosystem

Extension ports MAY include:

- classifiers and redactors;
- policy sources and packs;
- model, tool, and delegation adapters;
- ingress scanners;
- receipt and outcome reconcilers;
- audit exporters and storage backends.

- **REL-014**: Extensions MUST return typed findings or operations; they MUST NOT
  mutate authoritative Edge state directly.
- **REL-015**: Secret access MUST be least-privilege and operation-scoped.
- **REL-016**: Third-party recovery claims MUST use the same public conformance
  suite as first-party adapters.
- **REL-017**: Ogra Cloud MAY add hosting and coordination but MUST NOT redefine
  local Action, policy, evidence, or recovery semantics.
- **REL-027**: Python extensions MUST use an explicit installed-package entry
  point such as `ogra.providers`, a versioned manifest, compatibility range,
  lifecycle hooks, and conformance reference.
- **REL-028**: Third-party extensions MUST be disabled unless permitted by local
  trust policy; provenance, revocation status, and capability degradation MUST be
  visible without requiring a marketplace.

## 7. Cross-Language Proof

The first proof SHOULD be a TypeScript SDK followed by a second framework
integration selected from demonstrated user demand.

The LangGraph-native custom `StateGraph` example belongs to this milestone; the
public Alpha covers LangChain Agents and their supported internal LangGraph path.

- **REL-018**: SDK models MUST derive from the same schemas and golden vectors.
- **REL-019**: Python-created runs MUST be queryable and administratively
  resolvable from TypeScript, and vice versa.
- **REL-020**: Canonical hashes and capability evaluation MUST match across SDKs.
- **REL-021**: Node clients MUST connect to Edge rather than copy the Python
  state machine.
- **REL-022**: Protocol minor upgrades MUST be backward-compatible according to
  the published negotiation table.
- **REL-023**: Breaking protocol changes require migration fixtures and explicit
  release notes during v0.x; stable major versions require a defined support term.

## 8. Acceptance Gates

### Public Alpha

- clean install and Quickstart pass on supported operating systems;
- M2 governance, M4 LangChain, and M5 Crash Lab gates pass in release CI;
- at least five independent pre-release developers satisfy the Quickstart and
  normal-run value thresholds;
- documentation links and executable snippets pass;
- secret scan, dependency review, provenance, and package smoke tests pass;
- release notes state unsupported paths and known recovery limitations.

### Ecosystem Beta

- one external adapter completes contribution and conformance;
- one TypeScript client passes protocol and canonical-hash vectors;
- compatibility matrix is generated rather than hand-maintained;
- local OSS semantics remain identical with Cloud disabled.

## 9. Non-Goals

- many packages before the initial API stabilizes;
- a marketplace before extension trust and conformance exist;
- selecting every future Agent framework in advance;
- making Cloud the evidence or policy authority for local-only users;
- claiming multi-language support from schema files alone.
