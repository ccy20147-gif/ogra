import { BaseModelAdapter, ModelRequest, ModelResult } from '../core/model-adapter';
import { DatabaseService } from '../core/database-service';
import { RunService } from '../core/run-service';
import { RouteService } from '../core/route-service';
import { PolicyService, PolicyEvaluationInput } from '../core/policy-service';
import { RedactionService } from '../core/redaction-service';
import { RagEngine } from './rag-engine';
import { DataClassification, RunEventType, RouteDecisionType } from '../shared/types';
import { HighWaterMarkService } from '../core/high-water-mark';
import { PromptInjectionDetector } from '../core/prompt-injection-detector';
import { OgraError, OgraErrorCode } from '../shared/errors';
import { EffectProtocolService } from '../core/effect-protocol-service';
import { DurableRuntimeService } from '../core/durable-runtime-service';
import * as crypto from 'crypto';

export interface AgentRunInput {
  task: string;
  workspaceId: string;
  knowledgeBaseIds: string[];
  adapter: BaseModelAdapter;
  /** Canonical `models.name` registered with ProviderService. */
  modelId: string;
  /** Stable `models.id` from ProviderService. */
  modelInternalId: string;
  /** `model_providers.id` resolved from ProviderService. */
  providerId: string;
  requestedClassification?: DataClassification;
  /** Canonical runId owned by RunService. REQUIRED. */
  runId: string;
  /**
   * Optional approval context. Sequence 0 contract:
   *  - the agent verifies a canonical approval row against the
   *    supplied runId/workspaceId/scope/policy/payload fingerprint
   *    inside ModelRequest.approvalId.
   *  - if the row is missing or binding mismatches, the agent MUST
   *    either reject the model call or pass decision='blocked' /
   *    route='blocked' back to RunService.
   */
  approvalContext?: {
    approvalIdHint: string;
    scopeHash?: string;
    payloadFingerprint?: string;
    policyVersionHash?: string;
  } | null;
  /**
   * Hook consulted before each model invocation. Returning true
   * makes the agent abort gracefully before any further work.
   * RunService uses this from `cancelRun()`.
   */
  isCancelled?: () => boolean;
  /**
   * Abort signal forwarded to BaseModelAdapter.abortSignal-style
   * adapters (none today; reserved for Sequence 1 audit).
   */
  abortSignal?: { aborted: boolean };
}

export interface AgentRunResult {
  answer: string;
  citations: any[];
  routeDecision: any;
  riskSummary: any;
  modelCall: any;
  auditEventIds: string[];
}

/**
 * InternalAgentAdapter — Sequence 0 canonical Plan + ReAct execution
 * engine. Single owner of run_events for retrieval / policy / route /
 * model-call steps. The agent does NOT write its own run_created,
 * audit_complete, or run_failed events — RunService writes those in
 * a single terminal transaction so the lifecycle is single-canonical.
 *
 * Failure surface: errors are normalised to `(code, sanitizedMessage)`.
 * The agent does not include prompt content, raw adapter stack traces,
 * or full provider payloads in any audit event.
 */
export class InternalAgentAdapter {
  /**
   * P1 fix: single source of truth for retrieval result limits.
   * RunService.prepareExecutionSnapshot() MUST use this same value
   * when computing the approval fingerprint at park time, so
   * the retrieval results are byte-identical between park and
   * resume (otherwise the redactor hashes diverge and the agent's
   * fail-closed hash equality check rejects the run).
   */
  static readonly MAX_RETRIEVAL_RESULTS = 10;

  private highWaterMark = new HighWaterMarkService();
  private piDetector = new PromptInjectionDetector();

  constructor(
    private db: DatabaseService,
    private policyService: PolicyService,
    private routeService: RouteService,
    /** Sequence 0: RunService that owns the canonical approval rows.
     *  OgraCore wires this AFTER both services are constructed so
     *  the agent can read `loadApproval` for binding. Internal-only
     *  tests that never call agent.run() with an approvalContext may
     *  pass null and bypass the approval gate. */
    private runService: RunService | null,
    private ragEngine: RagEngine,
    private redactionService: RedactionService,
  ) {}

  /**
   * Sequence 1B Milestone 1 — wire the durable effect kernel into
   * the agent. When `protocol` is non-null, the model call goes
   * through prepare → casToInFlight → recordReceipt /
   * recordUnknownOutcome → commitToTerminal (all atomic via
   * `transactionalAppend`). When `protocol` is null, the agent
   * falls back to the Sequence 0 write path (direct model_calls
   * table), which is preserved for backwards compatibility.
   *
   * OgraCore wires this AFTER both the runtime and the protocol
   * service are constructed. Idempotent.
   */
  bindKernel(deps: {
    runtime: DurableRuntimeService;
    protocol: EffectProtocolService;
  }): void {
    (this as unknown as { runtime: DurableRuntimeService }).runtime = deps.runtime;
    (this as unknown as { protocol: EffectProtocolService }).protocol = deps.protocol;
  }
  private runtime: DurableRuntimeService | null = null;
  private protocol: EffectProtocolService | null = null;

  /** Wire the canonical RunService after both services are constructed
   *  (breaks the constructor cycle). Idempotent; only the first call
   *  has effect because the field is held directly. */
  bindRunService(rs: RunService): void {
    (this as unknown as { runService: RunService }).runService = rs;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    if (!input || !input.runId) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, 'agent.run requires a canonical runId');
    }
    const runId = input.runId;
    const {
      task,
      workspaceId,
      knowledgeBaseIds,
      adapter,
      modelId,
      modelInternalId,
      providerId,
      approvalContext,
      isCancelled,
      abortSignal,
    } = input;

    const workspace = this.db.getWorkspace(workspaceId);
    if (!workspace) {
      throw new OgraError(OgraErrorCode.WORKSPACE_NOT_FOUND, `Workspace ${workspaceId} not found`);
    }
    const classification = input.requestedClassification ||
      (workspace.default_data_classification as DataClassification);

    // Step 1: Preliminary high-water mark (workspace only).
    const preliminaryHwm = this.highWaterMark.compute([
      { sourceType: 'workspace', sourceId: workspaceId, classification },
    ]);

    // Step 2a: Resolve the canonical approval row BEFORE any policy
    // evaluation, so the engine can pick the redact_then_egress
    // branch when a scope-bound approval exists. The approval row
    // is the only authority that lets Confidential + cloud cross
    // the policy gate.
    let approvalRecord: any = null;
    if (approvalContext?.approvalIdHint) {
      approvalRecord = await this.resolveApprovalBinding({
        runId, workspaceId,
        approvalId: approvalContext.approvalIdHint,
        scopeHash: approvalContext.scopeHash ?? '',
        payloadFingerprint: approvalContext.payloadFingerprint ?? '',
        policyVersionHash: approvalContext.policyVersionHash ?? '',
      });
    }

    // Step 3: Preliminary policy evaluation for the retrieve stage.
    const preliminaryPolicyInput: PolicyEvaluationInput = {
      workspaceId,
      dataClassification: preliminaryHwm.highWaterMark as DataClassification,
      requestedCompute: adapter.isLocal ? 'local' : 'cloud',
      providerId,
      modelId,
      providerIsLocal: adapter.isLocal,
      requestedOperation: 'retrieve',
      hasUserApproval: !!approvalRecord && approvalRecord.decision === 'approved',
    };
    const preliminaryPolicyResult = await this.policyService.evaluate(preliminaryPolicyInput);
    this.db.storePolicyEvaluation({
      id: `pe_prelim_${crypto.randomBytes(8).toString('hex')}`,
      runId,
      inputSnapshot: preliminaryPolicyInput as any,
      result: preliminaryPolicyResult as any,
      matchedRules: preliminaryPolicyResult.matchedRules.map((r: any) => r.name),
    });

    // Step 3: Preliminary route decision.
    const preliminaryRouteDecision = await this.routeService.evaluateRoute(preliminaryPolicyInput);
    preliminaryRouteDecision.highWaterSources = preliminaryHwm.highWaterSources;
    preliminaryRouteDecision.runId = runId;
    this.db.storeRouteDecision({
      id: preliminaryRouteDecision.id,
      runId,
      route: preliminaryRouteDecision.route,
      dataClassification: preliminaryRouteDecision.dataClassification,
      highWaterSources: preliminaryRouteDecision.highWaterSources,
      reasons: preliminaryRouteDecision.reasons,
      localSteps: preliminaryRouteDecision.localSteps,
      cloudSteps: preliminaryRouteDecision.cloudSteps,
      requiresUserApproval: preliminaryRouteDecision.requiresUserApproval,
      providerId,
      modelId,
      incidentIds: preliminaryRouteDecision.incidentIds,
    });
    this.db.appendRunEvent(runId, workspaceId, RunEventType.RouteDecision, {
      route: preliminaryRouteDecision.route,
      classification: preliminaryHwm.highWaterMark,
      reasons: preliminaryRouteDecision.reasons,
      highWaterSources: preliminaryHwm.highWaterSources,
      stage: 'preliminary',
    }, this.policyService.getPolicyVersionHash());

    // Step 4: Retrieval (skip when preliminary route is blocked).
    const retrievedChunks = preliminaryRouteDecision.route !== RouteDecisionType.Blocked
      ? this.runRetrieval(runId, workspaceId, task, knowledgeBaseIds, classification)
      : [];

    // Step 4b: Resolve the canonical approval row BEFORE the final
    // real retrieved classifications (high-water re-evaluation).
    const sources = [
      { sourceType: 'workspace', sourceId: workspaceId, classification },
      ...retrievedChunks.map((c: any) => ({
        sourceType: 'chunk', sourceId: c.chunkId, classification: c.classification,
      })),
    ];
    const hwm = this.highWaterMark.compute(sources);
    const policyInput: PolicyEvaluationInput = {
      workspaceId,
      dataClassification: hwm.highWaterMark as DataClassification,
      requestedCompute: adapter.isLocal ? 'local' : 'cloud',
      providerId,
      modelId,
      providerIsLocal: adapter.isLocal,
      requestedOperation: 'generate',
      // Plan 03 §3.6 — when a scope-bound approval row is bound to
      // this run, the agent asks the policy engine to re-evaluate
      // assuming the user has approved the egress. Without this hint
      // the engine returns `require_approval` and the run is
      // blocked before the redaction engine can run, so the agent
      // gate would never see a redact_then_egress route.
      hasUserApproval: !!approvalRecord && approvalRecord.decision === 'approved',
    };
    const policyResult = await this.policyService.evaluate(policyInput);
    this.db.storePolicyEvaluation({
      id: `pe_final_${crypto.randomBytes(8).toString('hex')}`,
      runId,
      inputSnapshot: policyInput as any,
      result: policyResult as any,
      matchedRules: policyResult.matchedRules.map((r: any) => r.name),
    });
    this.db.appendRunEvent(runId, workspaceId, RunEventType.ContextPolicyCheck, {
      highWaterClassification: hwm.highWaterMark,
      chunkCount: retrievedChunks.length,
      policyDecision: policyResult.decision,
      matchedRules: policyResult.matchedRules.map((r: any) => r.name),
      reasons: policyResult.reasons,
    });

    const routeDecision = await this.routeService.evaluateRoute(policyInput);
    routeDecision.highWaterSources = hwm.highWaterSources;
    routeDecision.runId = runId;
    this.db.storeRouteDecision({
      id: routeDecision.id,
      runId,
      route: routeDecision.route,
      dataClassification: routeDecision.dataClassification,
      highWaterSources: routeDecision.highWaterSources,
      reasons: routeDecision.reasons,
      localSteps: routeDecision.localSteps,
      cloudSteps: routeDecision.cloudSteps,
      requiresUserApproval: routeDecision.requiresUserApproval,
      providerId,
      modelId,
      incidentIds: routeDecision.incidentIds,
    });
    this.db.appendRunEvent(runId, workspaceId, RunEventType.RouteDecision, {
      route: routeDecision.route,
      classification: hwm.highWaterMark,
      reasons: routeDecision.reasons,
      highWaterSources: hwm.highWaterSources,
      stage: 'final',
      approvalIdHint: approvalContext?.approvalIdHint ?? null,
    }, this.policyService.getPolicyVersionHash());

    // Step 6: Prompt-injection detection. Only the structural shape
    // (patternId, evidenceHash) is recorded; raw matched text is
    // bounded and never includes the full matched chunk.
    for (const chunk of retrievedChunks) {
      const matches = this.piDetector.detect(chunk.snippet);
      for (const match of matches) {
        this.db.appendRunEvent(runId, workspaceId, RunEventType.PromptInjectionWarning, {
          chunkId: chunk.chunkId,
          patternId: match.patternId,
          evidenceHash: match.evidenceHash,
          detectorVersion: match.detectorVersion,
        });
      }
    }

    // Step 7: Assemble prompt with untrusted-context separation.
    const contextAssembly = retrievedChunks.length > 0
      ? this.ragEngine.assembleContext(retrievedChunks, task)
      : { contextBlock: '', highWaterClassification: 'Internal', citationCount: 0, citations: [] };
    this.db.appendRunEvent(runId, workspaceId, RunEventType.RiskClassification, {
      highWaterClassification: contextAssembly.highWaterClassification,
      chunkCount: retrievedChunks.length,
    });

    if (routeDecision.route === RouteDecisionType.Blocked) {
      const blockedEvent = this.db.appendRunEvent(runId, workspaceId, RunEventType.RunBlocked, {
        reasons: routeDecision.reasons,
      });
      this.db.createIncident({
        id: `inc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        workspaceId,
        runId,
        incidentType: 'policy_block',
        severity: 'high',
        summary: `Run blocked by policy: ${routeDecision.reasons.join('; ')}`,
        evidenceEventIds: blockedEvent ? [blockedEvent.id] : [],
      });
      return {
        answer: `Request blocked by policy. Reasons: ${routeDecision.reasons.join('; ')}`,
        citations: contextAssembly.citations,
        routeDecision,
        riskSummary: {
          runId,
          riskLevel: 'blocked',
          riskReasons: routeDecision.reasons,
          requiredApprovals: [],
          approvalStatus: 'not_required',
        },
        modelCall: null,
        auditEventIds: [],
      };
    }

    // Step 8: Cancellation poll before model invocation.
    if (isCancelled && isCancelled()) {
      const cancelledEvent = this.db.appendRunEvent(runId, workspaceId, RunEventType.RunCancelled, {
        reason: 'cancelled before model invocation',
      });
      void cancelledEvent;
      return {
        answer: 'Run cancelled before model invocation.',
        citations: contextAssembly.citations,
        routeDecision,
        riskSummary: {
          runId,
          riskLevel: routeDecision.route === RouteDecisionType.Cloud ? 'medium' : 'low',
          riskReasons: routeDecision.reasons,
          requiredApprovals: [],
          approvalStatus: 'not_required',
        },
        modelCall: null,
        auditEventIds: [],
      };
    }

    // Step 9: Model invocation.
    const policyVersionHash = this.policyService.getPolicyVersionHash();
    // P0 #1: payloadHash is INITIALIZED from the raw inputs but
    // will be OVERWRITTEN by the redacted egress afterHash once
    // the redactor runs. The final value that flows into
    // ModelRequest.payloadHash, egress_record.payloadHash, and the
    // approval-row comparison MUST be the same hash. For local
    // routes (no redaction) the raw hash is fine because nothing
    // leaves the machine.
    let payloadHash = crypto.createHash('sha256')
      .update(JSON.stringify({
        task,
        workspaceId,
        classification: hwm.highWaterMark,
        contextChunkIds: retrievedChunks.map((c: any) => c.chunkId),
      }))
      .digest('hex');
    let egressPayloadHash: string | undefined;

    // Plan 03 §3.6 + Plan 02 §3.8.1 — Approve-then-Egress tier:
    // the redactor MUST run on the egress payload and a redaction_record
    // MUST be persisted before the model adapter is invoked. The
    // adapter's prompt content MUST use the redacted preview, not the
    // raw high-water content. If the approval is missing or mismatched,
    // we block without invoking the model adapter.
    //
    // egressPayload is the shape that will actually leave the
    // machine. For local routes it is the original task + context;
    // for any cloud route it is the post-redaction text. The prompt
    // parts forwarded to the adapter are derived from this same
    // structure so HTTP and audit cannot diverge.
    const baseEgress: { task: string; contextBlock: string; chunkIds: string[] } = {
      task,
      contextBlock: contextAssembly.contextBlock,
      chunkIds: retrievedChunks.map((c: any) => c.chunkId),
    };
    let egressText = JSON.stringify(baseEgress);
    let egressPayloadEgress: { task: string; contextBlock: string; chunkIds?: string[] } = baseEgress;
    let redactionRecordId: string | undefined;
    // Carry the live service authority through every durable effect. The
    // recovery checker compares this persisted evidence with the same
    // provider, so no production path invents a rule version.
    const redactionRuleVersion = this.redactionService.getCurrentRuleVersion();
    let redactedContextBlock = contextAssembly.contextBlock;
    if (routeDecision.route === RouteDecisionType.Redact_Then_Egress) {
      // Approve-then-Egress: an approved canonical approval row is
      // REQUIRED for any cloud egress.
      if (!approvalRecord || approvalRecord.decision !== 'approved') {
        const blockedEvent = this.db.appendRunEvent(runId, workspaceId, RunEventType.RunBlocked, {
          route: 'blocked',
          reasons: [
            'redact_then_egress requires an approved canonical approval row',
            ...routeDecision.reasons,
          ],
          approvalIdHint: approvalContext?.approvalIdHint ?? null,
        });
        this.db.createIncident({
          id: `inc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          workspaceId,
          runId,
          incidentType: 'policy_block',
          severity: 'high',
          summary: 'redact_then_egress blocked: no canonical approved approval',
          evidenceEventIds: blockedEvent ? [blockedEvent.id] : [],
        });
        return {
          answer: `Request blocked: redact_then_egress requires an approved canonical approval row.`,
          citations: contextAssembly.citations,
          routeDecision,
          riskSummary: {
            runId,
            riskLevel: 'high',
            riskReasons: ['redact_then_egress: approval required'],
            requiredApprovals: ['allow_confidential_redacted_cloud'],
            approvalStatus: 'awaiting_user',
          },
          modelCall: null,
          auditEventIds: [],
        };
      }

      // Run the deterministic redactor over the egress text. The
      // post-redaction string is the ONLY egress payload forwarded
      // to the model adapter — there is no other code path that
      // could leak the original `task` or `contextBlock` to /api/chat.
      const result = this.redactionService.redact({
        runId,
        ruleSetId: 'builtin-core-v1',
        ruleVersion: redactionRuleVersion,
        beforeText: egressText,
        classification: hwm.highWaterMark,
        approvalId: approvalRecord.id,
      });
      redactionRecordId = undefined; // service uses its own id; we look up later
      egressText = result.redactedText;
      // P0 #1: overwrite payloadHash with the redacted egress
      // afterHash so ModelRequest.payloadHash, egress_record.
      // payloadHash, and the approval-row payloadFingerprint all
      // reference the SAME hash — the hash of the actual bytes
      // that will leave the machine.
      payloadHash = result.afterHash;
      egressPayloadHash = result.afterHash;
      // P0 #1: fail-closed comparison. The approval row was bound
      // to a redacted preview hash at park time. The redactor is
      // deterministic, so if the inputs match the preview inputs
      // the hashes MUST be equal. If they differ (e.g. RAG content
      // changed between park and resume, or the redaction rule
      // version changed), the run is blocked — the user approved a
      // different payload than what we are about to send.
      if (approvalRecord && approvalRecord.payloadFingerprint
        && approvalRecord.payloadFingerprint !== result.afterHash) {
        const mismatchEvent = this.db.appendRunEvent(
          runId, workspaceId, RunEventType.RunBlocked, {
            route: 'blocked',
            reasons: [
              'egress payload hash does not match the approved fingerprint',
              `approved=${approvalRecord.payloadFingerprint.slice(0, 16)}…`,
              `actual=${result.afterHash.slice(0, 16)}…`,
            ],
            approvalId: approvalRecord.id,
          },
        );
        this.db.createIncident({
          id: `inc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          workspaceId,
          runId,
          incidentType: 'policy_block',
          severity: 'critical',
          summary: 'egress payload hash mismatch: approved fingerprint != actual redacted hash',
          evidenceEventIds: mismatchEvent ? [mismatchEvent.id] : [],
        });
        return {
          answer: 'Request blocked: egress payload hash does not match the approved fingerprint.',
          citations: contextAssembly.citations,
          routeDecision,
          riskSummary: {
            runId,
            riskLevel: 'critical',
            riskReasons: ['hash mismatch: approved payload != actual egress'],
            requiredApprovals: ['allow_confidential_redacted_cloud'],
            approvalStatus: 'mismatched',
          },
          modelCall: null,
          auditEventIds: [],
        };
      }
      try {
        egressPayloadEgress = JSON.parse(result.redactedText);
        redactedContextBlock = egressPayloadEgress.contextBlock
          ?? contextAssembly.contextBlock;
      } catch {
        egressPayloadEgress = { task, contextBlock: result.redactedText };
        redactedContextBlock = result.redactedText;
      }
      // Persist egress_record binding to the model call we'll make.
      this.redactionService.recordEgress({
        runId,
        routeDecisionId: routeDecision.id,
        approvalId: approvalRecord.id,
        egressMode: 'approve_then_egress',
        payloadHash: result.afterHash,
        payloadSummary: `[REDACTED ${result.matches.length} matches]`,
        redactionRuleVersion,
        payloadClassification: hwm.highWaterMark,
      });
    } else if (!adapter.isLocal && routeDecision.route !== RouteDecisionType.Local) {
      // Other cloud paths (Public, Internal) — auto-redact mode today
      // in Sequence 0. Plan 02 §2 maps them to `auto_redact`.
      const result = this.redactionService.redact({
        runId,
        ruleSetId: 'builtin-core-v1',
        ruleVersion: redactionRuleVersion,
        beforeText: egressText,
        classification: hwm.highWaterMark,
      });
      egressText = result.redactedText;
      // P0 #1: overwrite payloadHash with the redacted egress
      // afterHash for auto-redact cloud paths too.
      payloadHash = result.afterHash;
      egressPayloadHash = result.afterHash;
      try {
        egressPayloadEgress = JSON.parse(result.redactedText);
        redactedContextBlock = (egressPayloadEgress as any).contextBlock
          ?? contextAssembly.contextBlock;
      } catch {
        egressPayloadEgress = { task, contextBlock: result.redactedText };
        redactedContextBlock = result.redactedText;
      }
      this.redactionService.recordEgress({
        runId,
        routeDecisionId: routeDecision.id,
        egressMode: hwm.highWaterMark === DataClassification.Confidential ? 'log_and_proceed' : 'auto_redact',
        payloadHash: result.afterHash,
        payloadSummary: `[REDACTED ${result.matches.length} matches]`,
        redactionRuleVersion,
        payloadClassification: hwm.highWaterMark,
      });
    }

    this.db.appendRunEvent(runId, workspaceId, RunEventType.ModelCallStarted, {
      providerId,
      modelId,
      modelInternalId,
      isCloud: !adapter.isLocal,
      routeDecisionId: routeDecision.id,
      approvalId: approvalRecord?.id ?? null,
      approvalScopeHash: approvalRecord?.scopeHash ?? null,
    });

    // Sequence 1B Milestone 1 — when the durable kernel is wired,
    // the model call is wrapped by the effect protocol:
    //   prepare (seals callback capsule) -> casToInFlight
    //   (pre-callback CAS) -> adapter.generate (real call) ->
    //   recordReceipt (seals result capsule) | recordUnknownOutcome
    //   (no receipt, transitions to `unknown`) -> commitToTerminal
    //   (terminal CAS to `committed`).
    //
    // The kernel is optional. If OgraCore has not wired it (e.g.
    // unit tests for the Sequence 0 path), we fall back to the
    // direct model_calls write. This preserves Sequence 0 backwards
    // compatibility while making M1 the canonical production
    // path.
    let durableEffectId: string | null = null;
    let durableAttemptNo: number | null = null;
    let durableReceiptId: string | null = null;
    let durableHolderId: string | null = null;
    let durableLeaseVersion: number | null = null;
    let durableRootFrameId: string | null = null;
    let durablePlanFrameId: string | null = null;
    if (this.protocol && this.runtime && routeDecision.route !== RouteDecisionType.Blocked) {
      // 1. Resolve (or create) the root frame. The kernel
      // de-dupes via UNIQUE(run_id) on root frames, so a
      // second call to run() with the same runId reuses
      // the existing root.
      let rootFrame = this.runtime.rootFrameForRun(runId);
      if (!rootFrame) {
        rootFrame = this.runtime.createRootFrame({ runId });
      }
      durableRootFrameId = rootFrame.id;
      durableHolderId = `agent_${rootFrame.id}`;
      // 2. Acquire the recovery lease. If the lease is
      // currently held by another holder we either take it
      // back over (if expired) or fail closed.
      try {
        this.runtime.acquireLease({
          runId, holderId: durableHolderId, ttlMs: 5 * 60 * 1000,
        });
      } catch (err) {
        if ((err as { code?: string })?.code
            !== OgraErrorCode.LEASE_VERSION_CONFLICT) {
          throw err;
        }
        const existing = this.runtime.readLease(runId);
        if (this.runtime.leaseExpired(existing)) {
          this.runtime.renewLease({
            runId, holderId: durableHolderId,
            expectedLeaseVersion: existing.leaseVersion,
            ttlMs: 5 * 60 * 1000,
          });
        } else {
          throw err;
        }
      }
      durableLeaseVersion = this.runtime.readLease(runId).leaseVersion;
    }
    const abortController = new AbortController();
    let modelRequest: ModelRequest = {
      runId,
      workspaceId,
      routeDecisionId: routeDecision.id,
      policyEvaluationId: `pe_final_${runId}`,
      policyVersionHash,
      allowedProviderId: providerId,
      allowedModelId: modelId,
      // Sequence 0 — Plan 03 §3.6 / plan 02 §3.8.1 contract:
      // The prompt parts forwarded to the model adapter are derived
      // from the post-redaction egress payload. The HTTP body and
      // the audit chain therefore agree on what was sent.
      promptParts: [
        {
          role: 'system',
          content: 'You are Ogra, a helpful AI agent operating in a privacy-aware workspace. ' +
            'Use only the redacted context below; do not infer removed content. ' +
            'Cite sources when using them. If you are unsure, say so.',
        },
        {
          role: 'user',
          content: ((egressPayloadEgress as any).task ?? task) as string,
        },
        // P1 #3: the [REDACTED PREVIEW] header MUST appear in the
        // prompt parts for ANY redact_then_egress route, even when
        // no RAG chunks were retrieved. The OpenAI-compatible adapter
        // validates its presence before sending the HTTP body; without
        // it, a no-RAG Confidential+cloud run would be rejected.
        ...(redactionRuleVersion ? [{
          role: 'context' as const,
          content: `[REDACTED PREVIEW — redaction_rule_version=${redactionRuleVersion}]\n${redactedContextBlock}`,
          sourceIds: retrievedChunks.map((c: any) => c.chunkId),
        }] : retrievedChunks.length > 0 ? [{
          role: 'context' as const,
          content: contextAssembly.contextBlock,
          sourceIds: retrievedChunks.map((c: any) => c.chunkId),
        }] : []),
      ],
      contextSourceIds: retrievedChunks.map((c: any) => c.chunkId),
      approvalId: approvalRecord?.id ?? undefined,
      approvalScopeHash: approvalRecord?.scopeHash ?? undefined,
      payloadHash,
      routeDecisionSnapshot: routeDecision as any,
      signal: abortController.signal,
    };
    // Plan 03 §3.6 contract — the model adapter receives the
    // REDACTED context block (not the raw high-water content).
    // For local non-redact routes we still pass the original
    // context, which is fine because local adapters never see
    // cloud egress.
    // Forward RunService-level cancel signals to the adapter's request.
    if (abortSignal) {
      Object.defineProperty(abortSignal, 'aborted', {
        get() { return abortController.signal.aborted; },
      });
    }

    // Sequence 1B Milestone 1 — `prepare` (seals callback
    // capsule) + `casToInFlight` (pre-callback CAS). The adapter
    // is not allowed to run until this CAS succeeds. Capsule
    // integrity is verified here, not later — so a
    // corrupt/missing/wrong-workspace/expired callback capsule
    // fails closed BEFORE the adapter is invoked. The
    // `payload` of the sealed capsule is a sanitized summary
    // (no raw modelRequest body); the protocol includes only
    // the request hash + prompt sizes + adapter identity.
    if (this.protocol && this.runtime && durableHolderId
        && routeDecision.route !== RouteDecisionType.Blocked) {
      let rootFrame = this.runtime.rootFrameForRun(runId);
      if (!rootFrame) {
        rootFrame = this.runtime.createRootFrame({ runId });
        durableHolderId = `agent_${rootFrame.id}`;
      }
      const childFrame = this.runtime.createChildFrame({
        runId, parentFrameId: rootFrame.id, frameKind: 'plan_step',
      });
      durablePlanFrameId = childFrame.id;
      this.runtime.transitionFrame({
        frameId: childFrame.id, expectedStatus: 'pending', nextStatus: 'running',
      });
      const idempotencyKey = `idem_${runId}_${rootFrame.id}_${childFrame.id}`;
      // Sequence 1B Milestone 1 fail-closed gate: the sealed
      // callback capsule MUST contain exactly the bytes that
      // produced `payloadFingerprint`. Otherwise recovery
      // would refuse to re-callback because the capsule's
      // canonical hash != the effect's approved fingerprint.
      //
      // Sequence 1B M1 Round 5: the agent seals a callback
      // capsule whose canonical bytes are the canonical
      // envelope below. The capsule fingerprint is the hash
      // of that envelope and is stored on the EFFECT as a
      // separate column (`capsule_fingerprint`), distinct
      // from the redactor's egress hash stored on
      // `payload_fingerprint`. The Two Hash columns have two
      // intents:
      //   - `payload_fingerprint` is the Sequence-0 approval
      //     anchor (binds to the actual egress bytes the user
      //     approved). It MUST stay == the redactor's
      //     afterHash.
      //   - `capsule_fingerprint` is the Round-5 recovery
      //     anchor (proves the capsule would re-apply the
      //     canonical capsule bytes).
      const capsulePayload = {
        runId, workspaceId,
        allowedProviderId: routeDecision.providerId,
        allowedModelId: routeDecision.modelId,
        modelRequest, // includes promptParts + contextSourceIds + payloadHash
        route: routeDecision.route,
        classification: hwm.highWaterMark,
        approvalId: approvalRecord?.id ?? null,
        approvalScopeHash: approvalRecord?.scopeHash ?? null,
      };
      const prepared = this.protocol.prepare({
        runId,
        ownerFrameId: childFrame.id,
        effectType: 'model.generate',
        adapterKind: adapter.constructor.name,
        adapterVersion: 'M1-fixture',
        payload: capsulePayload,
        // Sequence-0 approval anchor stays INTACT.
        payloadFingerprint: payloadHash,
        // Round 5 recovery anchor: written to the new
        // `run_effects.capsule_fingerprint` column. The
        // recovery layer proves the capsule would re-apply
        // the canonical capsule bytes by comparing against
        // this column.
        // Also persist the current approval row id so that
        // recovery can prove the capsule is bound to a real
        // approval. Sequence-0 approval stays the binding
        // reference for the egress payload.
        currentApprovalId: approvalRecord?.id ?? null,
        idempotencyKey,
        scopeHash: approvalRecord?.scopeHash ?? '',
        routeDecisionId: routeDecision.id,
        policyEvaluationId: `pe_final_for_${runId}`,
        policyVersionHash,
        redactionRuleVersion,
        classification: hwm.highWaterMark,
        // Seal the concrete adapter declaration with the callback. Recovery
        // must never rely on a caller asserting stronger capabilities after a
        // crash.
        recoveryCapabilities: adapter.recoveryCapabilities(),
      });
      durableEffectId = prepared.effectId;
      durableAttemptNo = prepared.attemptNo;
      const callbackIntent = this.protocol.casToInFlight({
        effectId: durableEffectId,
        expectedRevision: 1,
        expectedAttemptNo: durableAttemptNo,
        leaseHolder: durableHolderId,
        expectedLeaseVersion: durableLeaseVersion ?? undefined,
        // Only the opaque approval id crosses into the durable callback
        // protocol. The protocol reloads and validates its canonical scope /
        // fingerprint / policy revision before atomically consuming it.
        approvalId: approvalRecord?.id ?? null,
      });
      // The CAS result contains the only callback command that may be sent.
      // Never use the pre-prepare in-memory request here: a caller can alter
      // it after prepare, while this object was decrypted and fingerprinted
      // against the durable effect inside casToInFlight.
      const command = callbackIntent.callbackPayload as {
        payload?: { modelRequest?: unknown };
        idempotencyKey?: unknown;
      };
      const sealedRequest = command.payload?.modelRequest;
      if (!sealedRequest || typeof sealedRequest !== 'object'
          || typeof command.idempotencyKey !== 'string') {
        throw new OgraError(OgraErrorCode.CAPSULE_INVALID,
          'callback capsule has no valid model request or idempotency key');
      }
      const authoritativeRequest = sealedRequest as ModelRequest;
      if (authoritativeRequest.runId !== runId
          || authoritativeRequest.workspaceId !== workspaceId
          || authoritativeRequest.routeDecisionId !== routeDecision.id
          || authoritativeRequest.policyVersionHash !== policyVersionHash
          || authoritativeRequest.allowedProviderId !== providerId
          || authoritativeRequest.allowedModelId !== modelId
          || authoritativeRequest.payloadHash !== payloadHash
          || !Array.isArray(authoritativeRequest.promptParts)
          || !Array.isArray(authoritativeRequest.contextSourceIds)) {
        throw new OgraError(OgraErrorCode.CAPSULE_INVALID,
          'callback capsule model request does not match current durable authority');
      }
      // AbortSignal cannot be serialized; it is process-local control, not
      // callback content. Every other adapter input comes from the capsule.
      modelRequest = {
        ...authoritativeRequest,
        idempotencyKey: command.idempotencyKey,
        signal: abortController.signal,
      };
    }

    let modelResult: ModelResult;
    try {
      modelResult = await adapter.generate(modelRequest);
    } catch (err) {
      // Sequence 0 invariant: never persist raw provider text, stack,
      // or full payloads. Drop the error to (code, sanitized-message)
      // and let RunService.commit via persistRunTerminal.
      const errorCode = (err as any)?.code || OgraErrorCode.ADAPTER_ERROR;
      const sanitized = ((err as Error)?.message ?? 'model failed').slice(0, 200);
      // Audit a sanitized record; redact anything that smells like
      // a payload hash for the cloud side is left to Sequence 1.
      this.db.appendRunEvent(runId, workspaceId, RunEventType.ModelCallFailed, {
        errorCode,
        providerId,
        modelId,
        // explicitly omit errorMessage/details; payload fingerprint
        // would be the right field here, kept for Sequence 1.
      });
      // Sequence 1B Milestone 1: when the durable kernel is wired,
      // a failed adapter call means the effect is `unknown` —
      // we transition the effect to `unknown` with an incident
      // log entry. The recovery layer is then responsible for
      // either outcome-query reconciliation or a controlled
      // idempotent retry. We DO NOT auto-commit the effect as
      // `failed` from inside a single call.
      if (this.protocol && durableEffectId && durableAttemptNo !== null) {
        try {
          this.protocol.recordUnknownOutcome({
            effectId: durableEffectId,
            attemptNo: durableAttemptNo,
            providerStatus: `error:${errorCode}`,
            resolvedOutcome: 'not_applied',
          });
        } catch {
          // best-effort: the effect is already in a transitional
          // state; the recovery layer will reconcile.
        }
      }
      if (this.runtime && durablePlanFrameId) {
        try {
          // A callback with an unresolved outcome is not a completed frame;
          // it waits for durable recovery/renewed authority.
          this.runtime.transitionFrame({
            frameId: durablePlanFrameId, expectedStatus: 'running',
            nextStatus: 'awaiting_approval',
          });
        } catch { /* preserve the original adapter error */ }
      }
      throw new OgraError(errorCode as OgraErrorCode, sanitized);
    } finally {
      // No-op placeholder: cancellation hook is registered below.
    }

    // Sequence 1B Milestone 1 — record a trusted receipt in the
    // same transaction that seals the result capsule. The
    // modelResult.httpBodyHash was already written by the adapter
    // before the HTTP body was sent; we re-use it as the
    // response hash so the receipt and the audit chain agree on
    // what was sent. If the durable kernel is wired, this is
    // the SOLE receipt — recovery will use it directly.
    if (this.protocol && durableEffectId && durableAttemptNo !== null) {
      try {
        const receipt = this.protocol.recordReceipt({
          effectId: durableEffectId,
          attemptNo: durableAttemptNo,
          requestId: `req_${durableEffectId}_${durableAttemptNo}`,
          requestHash: payloadHash,
          result: {
            answerPreview: modelResult.content.slice(0, 200),
            responseHash: modelResult.responseHash,
            httpBodyHash: modelResult.httpBodyHash,
            tokenUsage: modelResult.tokenUsage,
          },
          applicationStatus: 'applied',
          providerStatus: 'ok',
        });
        durableReceiptId = receipt.receiptId;
      } catch (err) {
        // Record-receipt must not eat the model output. The
        // recovery layer will reconcile on restart.
        this.db.appendRunEvent(runId, workspaceId, RunEventType.ModelCallFailed, {
          errorCode: OgraErrorCode.ADAPTER_ERROR,
          providerId,
          modelId,
        });
        if (this.runtime && durablePlanFrameId) {
          try {
            this.runtime.transitionFrame({
              frameId: durablePlanFrameId, expectedStatus: 'running',
              nextStatus: 'awaiting_approval',
            });
          } catch { /* durable recovery owns the remaining state */ }
        }
        throw err;
      }
    }

    // Cancellation mid-flight: if the run was cancelled while the
    // model adapter was executing (but the adapter returned a
    // result anyway), we MUST NOT proceed to write
    // ModelCallCompleted or storeModelCall. Return a cancelled
    // result so RunService's success path sees the cancellation
    // and writes `cancelled` instead of `completed`.
    if (isCancelled && isCancelled()) {
      if (this.runtime && durablePlanFrameId) {
        try {
          this.runtime.transitionFrame({
            frameId: durablePlanFrameId, expectedStatus: 'running', nextStatus: 'cancelled',
          });
        } catch { /* cancellation remains the terminal result */ }
      }
      this.db.appendRunEvent(runId, workspaceId, RunEventType.RunCancelled, {
        reason: 'cancelled mid-call (adapter returned but run was cancelled)',
      });
      return {
        answer: '',
        citations: contextAssembly.citations,
        routeDecision,
        riskSummary: {
          runId,
          riskLevel: 'low',
          riskReasons: ['cancelled'],
          requiredApprovals: [],
          approvalStatus: 'not_required',
        },
        modelCall: null,
        auditEventIds: [],
      };
    }

    this.db.appendRunEvent(runId, workspaceId, RunEventType.ModelCallCompleted, {
      providerId,
      modelInternalId,
      modelId,
      isCloud: !adapter.isLocal,
      tokenUsage: modelResult.tokenUsage,
      responseHash: modelResult.responseHash,
      egressPayloadHash,
      httpBodyHash: modelResult.httpBodyHash,
    });

    this.db.storeModelCall({
      id: modelResult.id,
      runId,
      status: 'completed',
      adapterKind: adapter.constructor.name,
      providerId,
      modelId,
      modelInternalId,
      routeDecisionId: routeDecision.id,
      isCloud: !adapter.isLocal,
      approvalId: approvalRecord?.id ?? undefined,
      promptHash: payloadHash,
      requestPayloadHash: payloadHash,
      uploadedPayloadHash: egressPayloadHash,
      httpBodyHash: modelResult.httpBodyHash,
      responseHash: modelResult.responseHash,
      tokenUsage: modelResult.tokenUsage,
      startedAt: modelResult.startedAt,
      completedAt: modelResult.completedAt,
      policyVersionHash,
      redactionRuleVersion: modelResult.redactionRuleVersion ?? undefined,
    });

    // Sequence 1B Milestone 1 — commit the durable effect to
    // the terminal `committed` state. The CAS enforces that
    // only one process (or one retry) can win the terminal
    // write; a second commit on the same receipt with the same
    // effect_revision loses to REVISION_CONFLICT and the
    // process that lost re-reads the row instead.
    if (this.protocol && durableEffectId && durableReceiptId) {
      const refreshed = this.runtime?.readEffect(durableEffectId);
      if (refreshed && refreshed.state === 'received') {
        try {
          this.protocol.commitToTerminal({
            effectId: durableEffectId,
            expectedRevision: refreshed.effectRevision,
            expectedAttemptNo: durableAttemptNo ?? 1,
            receiptId: durableReceiptId,
            leaseHolder: durableHolderId ?? '',
            expectedLeaseVersion: durableLeaseVersion ?? -1,
          });
        } catch (err) {
          if ((err as { code?: string })?.code !== OgraErrorCode.REVISION_CONFLICT) {
            if (this.runtime && durablePlanFrameId) {
              try {
                this.runtime.transitionFrame({
                  frameId: durablePlanFrameId, expectedStatus: 'running',
                  nextStatus: 'awaiting_approval',
                });
              } catch { /* retain the finalization error */ }
            }
            throw err;
          }
          // CAS lost — another process already committed.
        }
      }
    }

    if (this.runtime && durablePlanFrameId) {
      this.runtime.transitionFrame({
        frameId: durablePlanFrameId, expectedStatus: 'running', nextStatus: 'completed',
        outputHash: modelResult.responseHash,
      });
    }

    return {
      answer: modelResult.content,
      citations: contextAssembly.citations,
      routeDecision,
      riskSummary: {
        runId,
        riskLevel: hwm.highWaterMark === DataClassification.Confidential ||
                    hwm.highWaterMark === DataClassification.Restricted ? 'high'
                  : hwm.highWaterMark === DataClassification.Internal ? 'medium' : 'low',
        riskReasons: routeDecision.reasons,
        requiredApprovals: routeDecision.requiresUserApproval ? ['user approval'] : [],
        approvalStatus: approvalRecord?.decision === 'approved'
          ? 'approved'
          : (routeDecision.requiresUserApproval ? 'awaiting_user' : 'not_required'),
      },
      modelCall: modelResult,
      auditEventIds: [modelResult.id],
    };
  }

  private runRetrieval(
    runId: string,
    workspaceId: string,
    task: string,
    knowledgeBaseIds: string[],
    classification: DataClassification,
  ): any[] {
    // P1 fix: RetrievalStarted MUST NOT carry the raw task or the
    // raw query into the audit chain. The chain records a taskHash
    // + queryHash + queryLength so an auditor can verify a query
    // existed and what bucket it fits in without ever seeing the
    // raw user text.
    const taskHash = crypto.createHash('sha256').update(task).digest('hex');
    const queryText = task.substring(0, 200);
    const queryHash = crypto.createHash('sha256').update(queryText).digest('hex');
    this.db.appendRunEvent(runId, workspaceId, RunEventType.RetrievalStarted, {
      taskHash,
      taskLength: task.length,
      queryHash,
      queryLength: queryText.length,
      workspaceId,
      knowledgeBaseIdsCount: knowledgeBaseIds?.length ?? 0,
      classification,
    });
    // P1 fix: maxResults MUST match RunService.prepareExecutionSnapshot
    // (used at park time). Otherwise retrieval results differ
    // between park and resume, and assembleContext() builds a
    // different contextBlock on each path, breaking hash equality.
    const chunks = this.ragEngine.retrieve(
      task, workspaceId, InternalAgentAdapter.MAX_RETRIEVAL_RESULTS, classification,
    );
    this.db.appendRunEvent(runId, workspaceId, RunEventType.RetrievalCompleted, {
      chunkCount: chunks.length,
      chunkIds: chunks.map((c: any) => c.chunkId ?? c.id ?? '').slice(0, 10),
      workspaceId,
      // knowledgeBaseIdsCount is a non-sensitive aggregate already
      // present in RetrievalStarted — do not repeat it here.
    });
    return chunks;
  }

  /**
   * Sequence 0 approval binding. Query the canonical approvals row
   * and return the bound metadata that flows into ModelRequest.
   * Cross-run / cross-workspace reuse is rejected by `loadApproval`
   * itself; this method enforces that the binding's policy/version
   * hash matches the current policy registry.
   */
  private async resolveApprovalBinding(input: {
    runId: string;
    workspaceId: string;
    approvalId: string;
    scopeHash: string;
    payloadFingerprint: string;
    policyVersionHash: string;
  }): Promise<{
    id: string;
    scopeHash: string;
    payloadFingerprint: string;
    policyVersionHash: string;
    decision: 'approved';
    revision: number;
  } | null> {
    if (!this.runService) return null;
    return this.runService.loadApproval({
      approvalId: input.approvalId,
      runId: input.runId,
      workspaceId: input.workspaceId,
      policyVersionHash: input.policyVersionHash,
      payloadFingerprint: input.payloadFingerprint,
      scopeHash: input.scopeHash,
    });
  }
}
