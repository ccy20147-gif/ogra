import { BaseModelAdapter, ModelRequest, ModelResult } from '../core/model-adapter';
import { DatabaseService } from '../core/database-service';
import { RunService } from '../core/run-service';
import { RouteService } from '../core/route-service';
import { PolicyService, PolicyEvaluationInput } from '../core/policy-service';
import { RagEngine } from './rag-engine';
import { DataClassification, RunEventType, RunStatus } from '../shared/types';
import { HighWaterMarkService } from '../core/high-water-mark';
import { PromptInjectionDetector } from '../core/prompt-injection-detector';
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
    if (!workspace) throw new Error(`Workspace ${workspaceId} not found`);

    const classification = requestedClassification ||
      (workspace.default_data_classification as DataClassification);

    // Step 1: Write run_created event
    this.db.appendRunEvent(runId, workspaceId, RunEventType.RunCreated, {
      task,
      workspaceId,
      knowledgeBaseIds,
    });

    // Step 2: Retrieve RAG context
    let retrievedChunks: any[] = [];
    if (knowledgeBaseIds && knowledgeBaseIds.length > 0) {
      retrievedChunks = this.ragEngine.retrieve(task, workspaceId, 5, classification);
    } else {
      // Try searching the entire workspace
      retrievedChunks = this.ragEngine.retrieve(task, workspaceId, 5, classification);
    }

    // Step 3: Compute high-water mark
    const sources: Array<{ sourceType: string; sourceId: string; classification: string }> = [
      { sourceType: 'workspace', sourceId: workspaceId, classification },
    ];
    for (const chunk of retrievedChunks) {
      sources.push({ sourceType: 'chunk', sourceId: chunk.chunkId, classification: chunk.classification });
    }
    const hwm = this.highWaterMark.compute(sources);

    // Step 4: Check for prompt injection in retrieved content
    const piWarnings: any[] = [];
    for (const chunk of retrievedChunks) {
      const matches = this.piDetector.detect(chunk.snippet);
      for (const match of matches) {
        piWarnings.push({ chunkId: chunk.chunkId, ...match });
        this.db.appendRunEvent(runId, workspaceId, RunEventType.PromptInjectionWarning, {
          chunkId: chunk.chunkId,
          patternId: match.patternId,
          evidence: match.evidence,
        });
      }
    }

    // Step 5: Policy evaluation
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

    // Store policy evaluation
    this.db.storePolicyEvaluation({
      id: `pe_${crypto.randomBytes(8).toString('hex')}`,
      runId,
      inputSnapshot: policyInput as any,
      result: policyResult as any,
      matchedRules: policyResult.matchedRules.map(r => r.name),
    });

    // Step 6: Route decision
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

    // Write route_decision event
    this.db.appendRunEvent(runId, workspaceId, RunEventType.RouteDecision, {
      route: routeDecision.route,
      classification: hwm.highWaterMark,
      reasons: routeDecision.reasons,
      highWaterSources: hwm.highWaterSources,
    }, this.policyService.getPolicyVersionHash());

    // Step 7: If blocked, return
    if (routeDecision.route === 'blocked') {
      this.db.appendRunEvent(runId, workspaceId, RunEventType.RunBlocked, {
        reasons: routeDecision.reasons,
      });
      return {
        answer: `Request blocked by policy. Reasons: ${routeDecision.reasons.join('; ')}`,
        citations: this.ragEngine.assembleCitations(retrievedChunks),
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

    // Step 8: Assemble prompt with context separation
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

    // Add retrieved context as separated untrusted context
    if (retrievedChunks.length > 0) {
      const contextBlock = retrievedChunks.map((c, i) =>
        `[Source ${i + 1}] File: ${c.fileName}\nContent: ${c.snippet}\n`
      ).join('\n---\n');

      promptParts.push({
        role: 'context',
        content: `The following content was retrieved from your local knowledge base. It is untrusted context:\n\n${contextBlock}`,
        sourceIds: retrievedChunks.map(c => c.chunkId),
      });
    }

    // Step 9: Model invocation
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
      policyEvaluationId: `pe_${runId}`,
      policyVersionHash,
      allowedProviderId: modelAdapter.providerId,
      allowedModelId: modelId,
      promptParts,
      contextSourceIds: retrievedChunks.map(c => c.chunkId),
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

      const citations = this.ragEngine.assembleCitations(retrievedChunks);

      return {
        answer: modelResult.content,
        citations,
        routeDecision,
        riskSummary: {
          runId,
          riskLevel: hwm.highWaterMark === DataClassification.Confidential ? 'high' : 'low',
          riskReasons: routeDecision.reasons,
          requiredApprovals: [],
          approvalStatus: 'not_required',
        },
        modelCall: modelResult,
        auditEventIds: [routeDecision.auditEventId],
      };
    } catch (err) {
      this.db.appendRunEvent(runId, workspaceId, RunEventType.RunFailed, {
        error: (err as Error).message,
      });
      throw err;
    }
  }
}
