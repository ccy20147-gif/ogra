# ADR-007: LangChain Middleware Order, Approval, Streaming, and Cancellation

- **Status**: Accepted
- **Date**: 2026-08-17
- **Applies to**: M0 Protocol Freeze; M4 LangChain Governed Alpha
- **Related**: quickstart contract §4, §6, §11; handbook §7

## Context

The drop-in LangChain integration must preserve framework return values,
compose with user middleware, and govern model and tool calls without
reordering user behavior. Streaming and cancellation must not leak ungoverned
content.

## Decision

1. **Ogra is the outermost governance middleware** in `create_ogra_agent`;
   the factory documents ordering and composes with user middleware
   deterministically (sync and async equivalent semantics).
2. **Mapping**: Agent start → Run creation/correlation; model request →
   classify/route/redact/approve + durable ActionIntent BEFORE send; model
   response → receipt metadata + ingress review before observation; tool
   call → schema/scope validation + policy/approval + durable intent; tool
   result → receipt + ingress review; interrupt/resume → bound approval or
   escalation; completion → sealed summary and evidence packet.
3. **Approval**: an interrupt surfaces a human decision that maps to an
   `ApprovalBinding` decision; resume uses the binding, never a fresh
   re-approval of different payload.
4. **Streaming**: output is buffered or gated until governed content is safe
   to release; no token/chunk reaches the Agent before its ingress review
   verdict applies.
5. **Cancellation**: user/model cancellation maps to legal machine events
   (`cancel` before dispatch; `unknown_outcome` after possible dispatch);
   cancellation is never interpreted as authoritative external failure.
6. **Correlation, not conflation**: framework checkpoint/thread IDs go into
   `CorrelationRef`; they never satisfy Attempt or receipt transitions
   (PROT-014). Coverage is reported honestly: provider-native tools and
   direct SDK calls are visibly out of scope.

## Alternatives

- **Deep framework hooks instead of outermost middleware**: rejected —
  ordering would be implicit and ungovernable.
- **Streaming pass-through then govern after**: rejected — content would
  reach the Agent before review, violating the ingress invariant.
- **Cancellation as failure**: rejected — a timeout or user cancel is not
  authoritative external failure (PROT-012).

## Consequences

- Positive: ordinary LangChain return values remain compatible; governance
  order is deterministic; streaming is safe by construction; cancellation
  produces honest states.
- Negative: buffered streaming adds latency vs pass-through; middleware
  composition order must be documented and enforced by tests (M4 exit gate).
