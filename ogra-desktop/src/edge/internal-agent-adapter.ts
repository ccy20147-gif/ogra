import { BaseModelAdapter, ModelRequest, ModelResult } from '../core/model-adapter';
import { DatabaseService } from '../core/database-service';
import { RunService } from '../core/run-service';
import { RouteService } from '../core/route-service';
import { PolicyService, PolicyEvaluationInput } from '../core/policy-service';
import { RagEngine } from './rag-engine';
import { DataClassification, RunEventType, RunStatus } from '../shared/types';
import { HighWaterMarkService } from '../core/high-water-mark';
import { PromptInjectionDetector } from '../core/prompt-injection-detector';
import { OgraError, OgraErrorCode } from '../shared/errors';
import * as crypto from 'crypto';

/**
 * InternalAgentAdapter — the built-in Ogra agent.
 *
 * Responsibilities:
 * - accept a bounded user task
 * - retrieve RAG context
 * - invoke policy and router
 * - assemble prompt with untrusted context separation
 * - invoke selected model adapter
 * - record everything to audit
 */
export class InternalAgentAdapter {
  private highWaterMark = new HighWaterMarkService();
  private piDetector = new PromptInjectionDetector();

  constructor(
    private db: DatabaseService,
    private policyService: PolicyService,
    private routeService: RouteService,
    private runService: RunService,
    private ragEngine: RagEngine,
  ) {}

  async run(
    task: string,
    workspaceId: string,
    knowledgeBaseIds: string[],
    modelAdapter: BaseModelAdapter,
    modelId: string,
    requestedClassification?: DataClassification,
  ): Promise<{
    answer: string;
    citations: any[];
    routeDecision: any;
    riskSummary: any;
    modelCall: any;
    auditEventIds: string[];
  }> {
    const runId = `run_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const workspace = this.db.getWorkspace(workspaceId);
    if (!workspace) throw new OgraError(OgraErrorCode.WORKSPACE_NOT_FOUND, `Workspace ${workspaceId} not found`);

    const classification = requestedClassification ||
      (workspace.default_data_classification as DataClassification);

    // Step 1: Write run_created event
    this.db.appendRunEvent(runId, workspaceId, RunEventType.RunCreated, {
      task,
      workspaceId,
      knowledgeBaseIds,
    });

    // Step 2: Compute preliminary high-water mark (workspace only — no RAG data yet)
    const preliminarySources: Array<{ sourceType: string; sourceId: string; classification: string }> = [
      { sourceType: 'workspace', sourceId: workspaceId, classification },
    ];
    const preliminaryHwm = this.highWaterMark.compute(preliminarySources);

    // Step 3: Preliminary policy evaluation — check if retrieve operation is allowed
    const preliminaryPolicyInput: PolicyEvaluationInput = {
      workspaceId,
      dataClassification: preliminaryHwm.highWaterMark as DataClassification,
      requestedCompute: modelAdapter.isLocal ? 'local' : 'cloud',
      providerId: modelAdapter.providerId,
      modelId,
      providerIsLocal: modelAdapter.isLocal,
      requestedOperation: 'retrieve',
    };

    const preliminaryPolicyResult = await this.policyService.evaluate(preliminaryPolicyInput);

    // Store preliminary policy evaluation
    this.db.storePolicyEvaluation({
      id: `pe_prelim_${crypto.randomBytes(8).toString('hex')}`,
      runId,
      inputSnapshot: preliminaryPolicyInput as any,
      result: preliminaryPolicyResult as any,
      matchedRules: preliminaryPolicyResult.matchedRules.map(r => r.name),
    });

    // Step 4: Preliminary route decision (using preliminary HWM)
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
      providerId: preliminaryRouteDecision.providerId,
      modelId: preliminaryRouteDecision.modelId,
      incidentIds: preliminaryRouteDecision.incidentIds,
    });

    // Write preliminary route_decision event
    this.db.appendRunEvent(runId, workspaceId, RunEventType.RouteDecision, {
      route: preliminaryRouteDecision.route,
      classification: preliminaryHwm.highWaterMark,
      reasons: preliminaryRouteDecision.reasons,
      highWaterSources: preliminaryHwm.highWaterSources,
      stage: 'preliminary',
    }, this.policyService.getPolicyVersionHash());

    // Step 5: Execute RAG retrieval (only if preliminary policy/route allows)
    let retrievedChunks: any[] = [];
    const retrievalAllowed = preliminaryRouteDecision.route !== 'blocked';
    if (retrievalAllowed) {
      // Write retrieval_started event
      this.db.appendRunEvent(runId, workspaceId, RunEventType.RetrievalStarted, {
        task,
        workspaceId,
        knowledgeBaseIds,
        query: task.substring(0, 200),
      });

      if (knowledgeBaseIds && knowledgeBaseIds.length > 0) {
        retrievedChunks = this.ragEngine.retrieve(task, workspaceId, 5, classification);
      } else {
        // Try searching the entire workspace
        retrievedChunks = this.ragEngine.retrieve(task, workspaceId, 5, classification);
      }

      // Write retrieval_completed event
      this.db.appendRunEvent(runId, workspaceId, RunEventType.RetrievalCompleted, {
        chunkCount: retrievedChunks.length,
        workspaceId,
        knowledgeBaseIds,
      });
    }

    // Step 6: Compute full high-water mark with retrieval results
    const sources: Array<{ sourceType: string; sourceId: string; classification: string }> = [
      { sourceType: 'workspace', sourceId: workspaceId, classification },
    ];
    for (const chunk of retrievedChunks) {
      sources.push({ sourceType: 'chunk', sourceId: chunk.chunkId, classification: chunk.classification });
    }
    const hwm = this.highWaterMark.compute(sources);

    // Step 7: Re-run policy evaluation with real HWM (generate operation)
    const policyInput: PolicyEvaluationInput = {
      workspaceId,
      dataClassification: hwm.highWaterMark as DataClassification,
      requestedCompute: modelAdapter.isLocal ? 'local' : 'cloud',
      providerId: modelAdapter.providerId,
      modelId,
      providerIsLocal: modelAdapter.isLocal,
      requestedOperation: 'generate',
    };

    const policyResult = await this.policyService.evaluate(policyInput);

    // Store final policy evaluation
    const finalPeId = `pe_final_${crypto.randomBytes(8).toString('hex')}`;
    this.db.storePolicyEvaluation({
      id: finalPeId,
      runId,
      inputSnapshot: policyInput as any,
      result: policyResult as any,
      matchedRules: policyResult.matchedRules.map(r => r.name),
    });

    // Write context_policy_check event
    this.db.appendRunEvent(runId, workspaceId, RunEventType.ContextPolicyCheck, {
      highWaterClassification: hwm.highWaterMark,
      chunkCount: retrievedChunks.length,
      policyDecision: policyResult.decision,
      matchedRules: policyResult.matchedRules.map(r => r.name),
      reasons: policyResult.reasons,
    });

    // Step 8: Re-run route decision with real HWM
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
      providerId: routeDecision.providerId,
      modelId: routeDecision.modelId,
      incidentIds: routeDecision.incidentIds,
    });

    // Write final route_decision event
    this.db.appendRunEvent(runId, workspaceId, RunEventType.RouteDecision, {
      route: routeDecision.route,
      classification: hwm.highWaterMark,
      reasons: routeDecision.reasons,
      highWaterSources: hwm.highWaterSources,
      stage: 'final',
    }, this.policyService.getPolicyVersionHash());

    // Step 9: Check for prompt injection in retrieved content
    const piWarnings: any[] = [];
    for (const chunk of retrievedChunks) {
      const matches = this.piDetector.detect(chunk.snippet);
      for (const match of matches) {
        piWarnings.push({ chunkId: chunk.chunkId, ...match });
        this.db.appendRunEvent(runId, workspaceId, RunEventType.PromptInjectionWarning, {
          chunkId: chunk.chunkId,
          patternId: match.patternId,
          evidence: match.evidence,
          evidenceHash: match.evidenceHash,
          detectorVersion: match.detectorVersion,
        });
      }
    }

    // Assemble context once using RagEngine
    const contextAssembly = retrievedChunks.length > 0
      ? this.ragEngine.assembleContext(retrievedChunks, task)
      : { contextBlock: '', highWaterClassification: 'Internal', citationCount: 0, citations: [] };

    this.db.appendRunEvent(runId, workspaceId, RunEventType.RiskClassification, {
      highWaterClassification: contextAssembly.highWaterClassification,
      chunkCount: retrievedChunks.length,
    });

    // Step 10: If blocked, return
    if (routeDecision.route === 'blocked') {
      this.db.appendRunEvent(runId, workspaceId, RunEventType.RunBlocked, {
        reasons: routeDecision.reasons,
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

    // Step 11: Assemble prompt with context separation
    const promptParts: Array<{ role: 'system' | 'developer' | 'user' | 'assistant' | 'context'; content: string; sourceIds?: string[] }> = [
      {
        role: 'system',
        content: 'You are Ogra, a helpful AI agent operating in a privacy-aware workspace. ' +
          'You have access to local knowledge base content. Cite your sources when using them. ' +
          'If you are unsure about something, say so.',
      },
      {
        role: 'user',
        content: task,
      },
    ];

    // Add retrieved context as separated untrusted context (via RagEngine.assembleContext)
    if (retrievedChunks.length > 0 && contextAssembly.contextBlock) {
      promptParts.push({
        role: 'context',
        content: contextAssembly.contextBlock,
        sourceIds: retrievedChunks.map(c => c.chunkId),
      });
    }

    // Step 12: Model invocation
    const policyVersionHash = this.policyService.getPolicyVersionHash();
    const payloadHash = crypto.createHash('sha256')
      .update(promptParts.map(p => p.content).join(''))
      .digest('hex');

    this.db.appendRunEvent(runId, workspaceId, RunEventType.ModelCallStarted, {
      providerId: modelAdapter.providerId,
      modelId,
      isCloud: !modelAdapter.isLocal,
      routeDecisionId: routeDecision.id,
    });

    const modelRequest: ModelRequest = {
      runId,
      workspaceId,
      routeDecisionId: routeDecision.id,
      policyEvaluationId: finalPeId,
      policyVersionHash,
      allowedProviderId: modelAdapter.providerId,
      allowedModelId: modelId,
      promptParts,
      contextSourceIds: retrievedChunks.map(c => c.chunkId),
      approvalId: routeDecision.approvalId,
      payloadHash,
      routeDecisionSnapshot: routeDecision as any,
    };

    try {
      const modelResult = await modelAdapter.generate(modelRequest);

      this.db.appendRunEvent(runId, workspaceId, RunEventType.ModelCallCompleted, {
        modelId,
        providerId: modelAdapter.providerId,
        isCloud: !modelAdapter.isLocal,
        tokenUsage: modelResult.tokenUsage,
        responseHash: modelResult.responseHash,
      });

      // Write model call record to SQLite for ledger tracking
      this.db.storeModelCall({
        id: modelResult.id,
        runId,
        status: 'completed',
        adapterKind: modelAdapter.constructor.name,
        providerId: modelAdapter.providerId,
        modelId,
        routeDecisionId: routeDecision.id,
        isCloud: !modelAdapter.isLocal,
        promptHash: payloadHash,
        requestPayloadHash: payloadHash,
        uploadedPayloadHash: !modelAdapter.isLocal ? payloadHash : undefined,
        tokenUsage: modelResult.tokenUsage,
        startedAt: modelResult.startedAt,
        completedAt: modelResult.completedAt,
      });

      // Step 10: Final output
      this.db.appendRunEvent(runId, workspaceId, RunEventType.AuditComplete, {
        status: 'completed',
        routeDecisionId: routeDecision.id,
        cloudCalls: modelAdapter.isLocal ? 0 : 1,
      });

      const citations = contextAssembly.citations;

      return {
        answer: modelResult.content,
        citations,
        routeDecision,
        riskSummary: {
          runId,
          riskLevel: hwm.highWaterMark === DataClassification.Confidential || hwm.highWaterMark === DataClassification.Restricted ? 'high' : 'low',
          riskReasons: routeDecision.reasons,
          requiredApprovals: [],
          approvalStatus: 'not_required',
        },
        modelCall: modelResult,
        auditEventIds: [routeDecision.auditEventId],
      };
    } catch (err) {
      const errorMessage = (err as Error).message || 'Unknown error';
      const errorCode = (err as any).code || OgraErrorCode.INTERNAL_ERROR;
      const errorStack = (err as Error).stack?.substring(0, 500);
      const errorDetails = (err as any).details as Record<string, unknown> | undefined;
      this.db.appendRunEvent(runId, workspaceId, RunEventType.RunFailed, {
        error: errorMessage,
        errorCode,
        errorStack,
        errorDetails,
        step: 'model_invocation',
        runId,
      });
      throw err;
    }
  }
}
