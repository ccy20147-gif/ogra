# LangChain Integration Requirements

> Milestone: M4
>
> Requirement prefix: `LC`

## 1. Scope

The first framework integration adds Ogra to an ordinary LangChain Agent through
a two-to-five-line change while preserving framework behavior. LangGraph is
supported where it is part of LangChain Agent execution; a broader native graph
adapter follows after the public Alpha.

## 2. Public Experience

```python
from ogra.langchain import create_ogra_agent

agent = create_ogra_agent(model=model, tools=tools)
result = agent.invoke(input)
```

An equivalent `OgraMiddleware()` API MAY be public for advanced composition.
The factory MUST establish safe ordering and sensible governed defaults.

## 3. Interception Contract

The integration MUST govern:

- model request and response;
- client-side tool call and result;
- Agent/run/thread correlation;
- approval interrupt and resume;
- observations released back to the Agent loop.

It MUST report as uncovered unless separately adapted:

- direct provider SDK calls;
- provider-native server-side tools;
- unwrapped subgraphs and delegated processes;
- unrelated telemetry, memory, RAG, or network calls.

## 4. Normative Requirements

- **LC-001**: LangChain types MUST remain inside the integration module.
- **LC-002**: Middleware ordering relative to user middleware MUST be documented
  and tested.
- **LC-003**: Policy and durable intent MUST complete before the intercepted
  callback.
- **LC-004**: The default Python callable path MUST declare `inline` execution.
- **LC-005**: Edge-mediated adapters MUST be explicit and MUST NOT be selected
  merely because Edge is running.
- **LC-006**: Original return shapes, tool schemas, callback contracts, and
  supported tracing behavior MUST remain compatible.
- **LC-007**: Sync, async, parallel tool calls, cancellation, and supported
  streaming modes MUST have defined semantics.
- **LC-008**: Governed streaming MUST buffer or gate unreviewed output.
- **LC-009**: Approval resume MUST use a payload-bound Ogra approval; a generic
  LangGraph resume signal is insufficient.
- **LC-010**: LangGraph checkpoint IDs MUST only correlate with Ogra run and
  Action IDs.
- **LC-011**: An SDK-side exception after dispatch authorization MUST not be
  translated to authoritative provider failure.
- **LC-012**: Every completion summary MUST include a coverage statement and
  evidence reference.

## 5. Tool Recovery Declaration

An advanced tool MAY declare capabilities through an API equivalent to:

```python
@ogra.action(
    idempotency=stable_action_key,
    reconcile=query_external_outcome,
)
def external_action(...):
    ...
```

- **LC-013**: Capabilities MUST be scoped to the specific operation.
- **LC-014**: Declaration alone MUST not enable a recovery claim; conformance is
  required.
- **LC-015**: Tools without verified capability remain governed and durable but
  become unknown after an ambiguous dispatch.
- **LC-016**: Stable identity MUST derive from canonical sanctioned inputs, not a
  process-local call counter.

## 6. User-Visible Result

A successful normal run MUST preserve the Agent result and emit one concise
summary such as:

```text
OGRA governed | destination=openai:gpt-4.1-mini + tools:1 |
classification=public | policy=allowed | execution=inline |
recovery=unknown_if_interrupted | isolation=development |
coverage=model+client_tools | ingress=clean |
audit=chain_valid | anchor=none | run=run_123
inspect: ogra run show run_123
```

- **LC-017**: Zero redactions or approvals MUST be reported truthfully.
- **LC-018**: Summary generation MUST not require a domain-specific scenario.
- **LC-019**: Expanded evidence MUST identify bypass limitations and per-operation
  recovery capability.
- **LC-020**: The integration MUST derive or accept a stable submission key that
  survives client-response loss and framework process restart.

## 7. Compatibility Matrix

CI MUST test:

- the minimum and maximum supported LangChain/LangGraph versions;
- supported Python versions;
- sync and async invocation;
- single and parallel tool calls;
- streaming and cancellation;
- user middleware before and after Ogra where supported;
- checkpoint resume without conflating graph and effect state.

## 8. Acceptance Gates

1. A documented existing Agent changes no more than two to five lines.
2. Clean environment to first governed run is under five minutes.
3. Blocked requests never reach the model or tool callback.
4. A suspicious result never reaches Agent observation.
5. Return compatibility tests pass across the supported matrix.
6. Direct SDK and provider-native tool fixtures are visibly marked uncovered.
7. A killed inline tool process produces `unknown_outcome`, not automatic retry.
8. A payload-bound approval can be completed through the documented callback or
   CLI flow and resumed within five minutes.

## 9. Non-Goals

- replacing LangGraph persistence;
- building a custom Agent loop;
- claiming interception of provider-internal execution;
- making every Python callable recoverable;
- releasing unreviewed tokens to preserve streaming latency.
