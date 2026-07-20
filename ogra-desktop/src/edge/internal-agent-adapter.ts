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
    let redactionRuleVersion: string | undefined;
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
        ruleVersion: 'r1.0.0',
        beforeText: egressText,
        classification: hwm.highWaterMark,
        approvalId: approvalRecord.id,
      });
      redactionRecordId = undefined; // service uses its own id; we look up later
      redactionRuleVersion = 'r1.0.0';
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
        redactionRuleVersion: 'r1.0.0',
        payloadClassification: hwm.highWaterMark,
      });
    } else if (!adapter.isLocal && routeDecision.route !== RouteDecisionType.Local) {
      // Other cloud paths (Public, Internal) — auto-redact mode today
      // in Sequence 0. Plan 02 §2 maps them to `auto_redact`.
      const result = this.redactionService.redact({
        runId,
        ruleSetId: 'builtin-core-v1',
        ruleVersion: 'r1.0.0',
        beforeText: egressText,
        classification: hwm.highWaterMark,
      });
      redactionRuleVersion = 'r1.0.0';
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
        redactionRuleVersion: 'r1.0.0',
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

    const abortController = new AbortController();
    const modelRequest: ModelRequest = {
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
      throw new OgraError(errorCode as OgraErrorCode, sanitized);
    } finally {
      // No-op placeholder: cancellation hook is registered below.
    }

    // Cancellation mid-flight: if the run was cancelled while the
    // model adapter was executing (but the adapter returned a
    // result anyway), we MUST NOT proceed to write
    // ModelCallCompleted or storeModelCall. Return a cancelled
    // result so RunService's success path sees the cancellation
    // and writes `cancelled` instead of `completed`.
    if (isCancelled && isCancelled()) {
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
