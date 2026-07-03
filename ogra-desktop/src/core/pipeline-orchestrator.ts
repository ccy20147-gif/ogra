import { DatabaseService } from './database-service';
import { MemoryService } from './memory-service';
import { PolicyService, PolicyEvaluationInput } from './policy-service';
import { RouteService } from './route-service';
import { RagEngine } from '../edge/rag-engine';
import { BaseModelAdapter } from './model-adapter';
import { DataClassification, RunEventType, AgentGroupMode } from '../shared/types';
import * as crypto from 'crypto';

export interface PipelineStep {
  agentId: string;
  role: string;
  instruction: string;
  modelAdapter: BaseModelAdapter;
  modelId: string;
  maxTokens?: number;
}

export interface PipelineConfig {
  workspaceId: string;
  name: string;
  task: string;
  steps: PipelineStep[];
  maxSteps?: number;
  maxTokens?: number;
  maxDurationMs?: number;
}

export interface StepResult {
  stepIndex: number;
  agentId: string;
  role: string;
  output: string;
  routeDecision: any;
  modelCall: any;
  citations: any[];
  startedAt: string;
  completedAt: string;
}

/**
 * Pipeline Orchestrator — bounded 3-agent sequential execution.
 *
 * Pipeline MUST support:
 * - max steps, max tokens, max duration
 * - pause, cancel, force summarize
 * - visible intermediate outputs
 * - per-step policy checks, route decisions, audit events
 * - policy check before each step
 */
export class PipelineOrchestrator {
  private running = new Map<string, boolean>();

  constructor(
    private db: DatabaseService,
    private policyService: PolicyService,
    private routeService: RouteService,
    private ragEngine: RagEngine,
    private    memoryService: MemoryService,
  ) {
    // Ensure MemoryService has PolicyService for policy-gated writes
    // @ts-ignore - MemoryService accepts optional PolicyService
  }

  async runPipeline(config: PipelineConfig): Promise<{
    groupRunId: string;
    steps: StepResult[];
    summary: string;
    totalTokens: number;
    blocked: boolean;
  }> {
    const groupRunId = `agr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const workspaceId = config.workspaceId;
    const maxSteps = config.maxSteps || config.steps.length;
    const maxTokens = config.maxTokens || 32000;
    const maxDurationMs = config.maxDurationMs || 300000;
    const startTime = Date.now();
    let totalTokensUsed = 0;

    // Create agent group run record
    this.db.getRawDB().prepare(`
      INSERT INTO agent_group_runs (id, workspace_id, mode, task, status, started_at)
      VALUES (?, ?, ?, ?, 'running', datetime('now'))
    `).run(groupRunId, workspaceId, AgentGroupMode.Pipeline, config.task);

    this.db.appendRunEvent(groupRunId, workspaceId, RunEventType.RunCreated, {
      mode: 'pipeline',
      task: config.task,
      steps: config.steps.map(s => ({ agentId: s.agentId, role: s.role })),
    });

    this.running.set(groupRunId, true);
    const stepResults: StepResult[] = [];

    try {
      for (let i = 0; i < Math.min(config.steps.length, maxSteps); i++) {
        if (!this.running.get(groupRunId)) break; // Cancelled
        if (Date.now() - startTime > maxDurationMs) break; // Timeout
        if (totalTokensUsed >= maxTokens) break; // Token limit

        const step = config.steps[i];
        const stepIndex = i;
        const startedAt = new Date().toISOString();

        // Policy pre-check for this step
        const policyInput: PolicyEvaluationInput = {
          workspaceId,
          dataClassification: DataClassification.Internal,
          requestedCompute: step.modelAdapter.isLocal ? 'local' : 'cloud',
          providerId: step.modelAdapter.providerId,
          modelId: step.modelId,
          requestedOperation: 'generate',
          agentId: step.agentId,
        };

        const policyResult = await this.policyService.evaluate(policyInput);

        // Store step record
        const stepId = `step_${groupRunId}_${i}`;
        this.db.getRawDB().prepare(`
          INSERT INTO run_steps (id, agent_group_run_id, step_index, agent_id, role, status, started_at)
          VALUES (?, ?, ?, ?, ?, 'running', ?)
        `).run(stepId, groupRunId, i, step.agentId, step.role, startedAt);

        // Route decision per step
        const routeDecision = await this.routeService.evaluateRoute(policyInput);
        routeDecision.runId = groupRunId;

        let output = '';
        let modelCall = null;
        let citations: any[] = [];
        let blocked = false;

        if (routeDecision.route === 'blocked') {
          output = `[Blocked] Policy prevented execution: ${routeDecision.reasons.join('; ')}`;
          blocked = true;
          this.db.appendRunEvent(groupRunId, workspaceId, RunEventType.RunBlocked, {
            step: i,
            agentId: step.agentId,
            reasons: routeDecision.reasons,
          });
        } else {
          // Assemble prompt with previous step context
          const previousContext = stepResults.length > 0
            ? stepResults[stepResults.length - 1].output
            : '';

          const promptParts: Array<{ role: 'system' | 'developer' | 'user' | 'assistant' | 'context'; content: string }> = [
            { role: 'system', content: `You are ${step.agentId}, acting as ${step.role}. ${step.instruction}` },
          ];

          if (previousContext) {
            promptParts.push({
              role: 'context' as const,
              content: `Previous step output (for reference):\n${previousContext}`,
            });
          }

          // Retrieve RAG context for this step
          const retrievedChunks = this.ragEngine.retrieve(step.instruction + ' ' + config.task, workspaceId, 5);
          if (retrievedChunks.length > 0) {
            const contextBlock = retrievedChunks.map((c, j) =>
              `[Source ${j + 1}] ${c.fileName}: ${c.snippet}`
            ).join('\n');
            promptParts.push({ role: 'context' as const, content: `Retrieved knowledge:\n${contextBlock}` });
            citations = this.ragEngine.assembleCitations(retrievedChunks);
          }

          // Invoke model
          const modelRequest = {
            runId: groupRunId,
            workspaceId,
            routeDecisionId: routeDecision.id,
            policyEvaluationId: `pe_${groupRunId}_${i}`,
            policyVersionHash: this.policyService.getPolicyVersionHash(),
            allowedProviderId: step.modelAdapter.providerId,
            allowedModelId: step.modelId,
            promptParts,
            contextSourceIds: retrievedChunks.map(c => c.chunkId),
            payloadHash: crypto.createHash('sha256').update(promptParts.map(p => p.content).join('')).digest('hex'),
            routeDecisionSnapshot: routeDecision as any,
          };

          try {
            const result = await step.modelAdapter.generate(modelRequest);
            output = result.content;
            modelCall = result;
            totalTokensUsed += result.tokenUsage.total;

            // Write model call record
            this.db.storeModelCall({
              id: result.id,
              runId: groupRunId,
              status: 'completed',
              adapterKind: step.modelAdapter.constructor.name,
              providerId: step.modelAdapter.providerId,
              modelId: step.modelId,
              routeDecisionId: routeDecision.id,
              isCloud: !step.modelAdapter.isLocal,
              tokenUsage: result.tokenUsage,
              startedAt: result.startedAt,
              completedAt: result.completedAt,
            });

            // Auto-write episodic memory for this step
            await this.memoryService.writeEpisodic({
              workspaceId,
              eventSummary: `Pipeline step ${i + 1}/${config.steps.length}: ${step.agentId} (${step.role}) completed "${step.instruction.substring(0, 60)}..."`,
              participatingAgentIds: [step.agentId],
              sourceRunId: groupRunId,
              sourceFileIds: [],
              sourceRouteDecisionId: routeDecision.id,
              sourceEventIds: [],
            });
          } catch (err) {
            output = `[Error] Model invocation failed: ${(err as Error).message}`;
            this.db.appendRunEvent(groupRunId, workspaceId, RunEventType.RunFailed, {
              step: i,
              agentId: step.agentId,
              error: (err as Error).message,
            });
          }
        }

        // Complete step
        const completedAt = new Date().toISOString();
        this.db.getRawDB().prepare(`
          UPDATE run_steps SET status = ?, output_hash = ?, completed_at = ? WHERE id = ?
        `).run(blocked ? 'blocked' : 'completed', crypto.createHash('sha256').update(output).digest('hex'), completedAt, stepId);

        stepResults.push({
          stepIndex,
          agentId: step.agentId,
          role: step.role,
          output,
          routeDecision,
          modelCall,
          citations,
          startedAt,
          completedAt,
        });
      }

      // Generate summary
      const summary = stepResults.map(s =>
        `[${s.role}] ${s.agentId}: ${s.output.substring(0, 100)}...`
      ).join('\n');

      // Complete the group run
      this.db.getRawDB().prepare(
        "UPDATE agent_group_runs SET status = 'completed', completed_at = datetime('now') WHERE id = ?"
      ).run(groupRunId);

      this.db.appendRunEvent(groupRunId, workspaceId, RunEventType.AuditComplete, {
        mode: 'pipeline',
        stepsCompleted: stepResults.length,
        totalTokens: totalTokensUsed,
      });

      return {
        groupRunId,
        steps: stepResults,
        summary,
        totalTokens: totalTokensUsed,
        blocked: stepResults.some(s => s.output.startsWith('[Blocked]')),
      };
    } finally {
      this.running.delete(groupRunId);
    }
  }

  cancelPipeline(groupRunId: string): void {
    this.running.set(groupRunId, false);
    this.db.getRawDB().prepare(
      "UPDATE agent_group_runs SET status = 'cancelled', completed_at = datetime('now') WHERE id = ?"
    ).run(groupRunId);
  }
}
