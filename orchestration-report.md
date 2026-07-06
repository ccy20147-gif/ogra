# Phase 5: Model & Agent Orchestration Codebase Review

## 1. Pipeline Execution Flow (Pre-Flight -> Route -> Exec -> Audit)

**Status:** Implementation is largely aligned with Phase 5 requirements. The pipeline execution flow correctly implements bounded execution with intermediate policy checks.

*   `PipelineOrchestrator.runPipeline` in `ogra-desktop/src/core/pipeline-orchestrator.ts:96-242` iterates through `config.steps` supporting limits on steps, tokens, and duration.
*   **Pre-Flight / Policy:** Checks are explicitly performed per-step `ogra-desktop/src/core/pipeline-orchestrator.ts:106-116`.
*   **Route:** Routes are evaluated per-step `ogra-desktop/src/core/pipeline-orchestrator.ts:125-127`.
*   **Audit:** Audit events are appended on step outcomes `ogra-desktop/src/core/pipeline-orchestrator.ts:137-141` and step runs are written to `run_steps` database `ogra-desktop/src/core/pipeline-orchestrator.ts:119-123`.

🟢建议(Minor): Consider extracting the step execution block inside the loop (`ogra-desktop/src/core/pipeline-orchestrator.ts:101-241`) into a private method to improve readability of `PipelineOrchestrator.runPipeline`.

## 2. Agent Adapter Isolation

**Status:** The system clearly segregates internal operations from command executions.

*   `InternalAgentAdapter` (`ogra-desktop/src/edge/internal-agent-adapter.ts`) acts as a secure facade. It coordinates RAG context retrieval (line 64), computes high-water marks (line 73), handles prompt injection detection (line 82), evaluates policy/routing (line 96-119), separates context in the prompt (line 167), and finally invokes the model.
*   It explicitly binds the adapter to workspace data without directly exposing shell or system access.

🟡主要(Major): While `InternalAgentAdapter` isolates model invocation, it defaults to catching any exceptions in the pipeline and swallowing them into `RunFailed` without clear mechanisms to report specific sub-system failures (e.g. RAG failure vs Policy failure) back to the caller gracefully (`ogra-desktop/src/edge/internal-agent-adapter.ts:272-277`). The error is thrown, but standard error shapes could improve client handling.

## 3. Provider Key Management

**Status:** Requires attention. The `ProviderService` implementation is stubbed but lacks secret broker integration for API keys.

*   `ProviderService` (`ogra-desktop/src/core/provider-service.ts`) currently manages hardcoded configuration for Ollama models (lines 45-77).
*   `ProviderService.addOpenAICompatible` (`ogra-desktop/src/core/provider-service.ts:105-129`) does not accept, store, or manage an API key. The plan states: "- secret broker integration. - masked key metadata in UI." This is a gap for any cloud or API-key dependent local provider.

🔴阻断(Blocking): `ProviderService` (`ogra-desktop/src/core/provider-service.ts`) does not implement integration with `SecretBroker` to securely manage, retrieve, or inject API credentials during model invocation. This violates the Alpha/Beta requirement for OpenAI-Compatible adapter handling.

## 4. Separation between internal/local command execution

**Status:** Implemented as requested.

*   `InternalAgentAdapter` (`ogra-desktop/src/edge/internal-agent-adapter.ts`) has no capability to run local shell commands.
*   `LocalCommandAgentAdapter` (`ogra-desktop/src/edge/local-command-agent-adapter.ts`) provides a highly constrained `executeReadOnly` using `child_process.execSync` (line 57).
*   The execution creates hashes of input/output (lines 42, 66) and generates audit trails (lines 45, 68) mapping closely to Phase 5 requirements for "supervised mode", "stdout/stderr transcript", and "hash input and output".

🟡主要(Major): `LocalCommandAgentAdapter.cancel` (`ogra-desktop/src/edge/local-command-agent-adapter.ts:93-98`) only sets a boolean flag on a memory map (`handle.cancelled = true;`), but `execSync` is synchronous and blocks the event loop. The cancellation signal does not actually terminate the running process. To implement real cancellation and timeout effectively (as required by "cancelation support"), `child_process.exec` (or `spawn`) should be used asynchronously so the process can be killed via signals (e.g. `SIGTERM`).