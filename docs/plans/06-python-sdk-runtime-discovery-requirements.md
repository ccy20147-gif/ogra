# Python SDK and Runtime Discovery Requirements

> Milestone: M3
>
> Requirement prefix: `SDK`

## 1. Scope

The Python SDK is the first client implementation of the Ogra Protocol. It
provides framework-neutral commands, development runtime discovery, production
connection, CLI inspection, and stable sync/async behavior.

Python is not protocol authority. Python DTOs MUST be generated from or tested
against the schemas and golden vectors under `spec/`.

## 2. Public SDK Surface

The minimum framework-neutral API SHOULD expose:

```python
client = OgraClient.local()             # development discovery
client = OgraClient(endpoint=..., token=...)

run = client.runs.create(...)
decision = client.actions.authorize(...)
client.attempts.record_result(...)
evidence = client.runs.get_evidence(run.id)
```

Exact names may change before Alpha, but framework adapters MUST use this client
rather than Edge storage or domain internals.

## 3. Normative Requirements

- **SDK-001**: Supported Python versions MUST be explicit and tested.
- **SDK-002**: Sync and async clients MUST provide equivalent state semantics.
- **SDK-003**: Client retries MUST reuse command identity and expected revision.
- **SDK-004**: Protocol negotiation MUST occur before mutation.
- **SDK-005**: Unsupported major version MUST fail with an actionable error.
- **SDK-006**: SDK exceptions MUST preserve typed protocol errors without
  exposing secrets or payload material.
- **SDK-007**: Framework integrations MUST depend only on public SDK APIs.
- **SDK-008**: The SDK MUST expose actual governance, execution, recovery, and
  isolation profiles for every run.
- **SDK-022**: Creation APIs MUST accept a caller-stable submission key and return
  an existing Run or Action after server commit and client-response loss.

## 4. Discovery Order

Development discovery MUST use this order:

1. explicit endpoint and credentials;
2. healthy registered daemon for the selected data directory;
3. lock-protected start of one local daemon;
4. actionable failure without an in-process fallback.

- **SDK-009**: `OGRA_ENDPOINT` MUST take precedence over auto-start.
- **SDK-010**: The registry MUST include runtime identity, PID, process start
  identity, endpoint, data directory, protocol version, and health timestamp.
- **SDK-011**: Discovery MUST detect stale registry, PID reuse, unhealthy daemon,
  incompatible protocol, and interrupted migration.
- **SDK-012**: Concurrent clients MUST use a cross-process lock and converge on
  one healthy runtime.
- **SDK-013**: Local transport MUST authenticate the expected user/runtime scope;
  loopback binding alone is not sufficient authority.
- **SDK-014**: Auto-start MUST report `development` isolation.

## 5. Production Behavior

- **SDK-015**: Production mode MUST require an explicit endpoint, credentials,
  lifecycle owner, and health policy.
- **SDK-016**: Production MUST never silently start a development daemon or
  downgrade from governed to observe mode.
- **SDK-017**: Connection loss before dispatch authorization MUST not invoke the
  application callback.
- **SDK-018**: Connection loss after a dispatch grant MUST be reported as an
  ambiguity that Edge resolves according to Attempt state.

## 6. CLI Requirements

The initial CLI MUST include:

- `ogra dev`: start or reuse development Edge and print endpoint/storage status;
- `ogra doctor`: endpoint, health, protocol, migration, profiles, and storage;
- `ogra run show <id>`: bounded Action and recovery state;
- `ogra approval list|approve|deny`: complete payload-bound development approval;
- `ogra audit verify`: offline evidence-chain verification;
- `ogra edge start`: explicit development start for diagnostics;
- `ogra lab`: Crash Lab entry point when `ogra[conformance]` is installed.

- **SDK-019**: CLI output MUST be scriptable with a structured format.
- **SDK-020**: Human output MUST not print raw payloads or tokens by default.
- **SDK-021**: Exit codes MUST distinguish policy denial, runtime unavailable,
  protocol mismatch, unknown outcome, and verification failure.

## 7. Acceptance Tests

1. Twenty simultaneous clean-start clients create or reuse one daemon.
2. Stale registry and PID reuse never attach to an unrelated process.
3. Client process restart can query the same run and evidence.
4. Sync and async fixtures produce equivalent protocol transitions.
5. Protocol major mismatch performs no mutation.
6. Production configuration never falls back to development behavior.
7. CLI JSON output contains no fixture secrets.
8. Server commit followed by response loss reattaches using the same submission
   key and creates no duplicate Action.

## 8. Non-Goals

- making Pydantic models the protocol specification;
- hiding production lifecycle management behind auto-start;
- implementing LangChain behavior in the base client;
- remote multi-tenant Ogra Cloud concerns in the first SDK.
