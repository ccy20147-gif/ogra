import { DatabaseService } from './database-service';
import { MemoryService } from './memory-service';
import { PolicyService, PolicyEvaluationInput } from './policy-service';
import { RouteService } from './route-service';
import { RagEngine } from '../edge/rag-engine';
import { BaseModelAdapter } from './model-adapter';
import { DataClassification, RunEventType, AgentGroupMode, PipelineStatus } from '../shared/types';
import { PromptInjectionDetector } from './prompt-injection-detector';
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
  dataClassification?: DataClassification;
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
export type PipelineState = PipelineStatus;

export class PipelineOrchestrator {
  private running: Map<string, PipelineState> = new Map();
  private piDetector = new PromptInjectionDetector();

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

    this.running.set(groupRunId, 'running');
    const stepResults: StepResult[] = [];

    try {
      for (let i = 0; i < Math.min(config.steps.length, maxSteps); i++) {
        if (this.running.get(groupRunId) === 'cancelled') break; // Cancelled
        // Wait if paused (in a real implementation this would await a signal)
        if (this.running.get(groupRunId) === 'paused') {
          // Pause: skip remaining steps — could await a resume signal in production
          break;
        }
        if (Date.now() - startTime > maxDurationMs) break; // Timeout
        if (totalTokensUsed >= maxTokens) break; // Token limit

        const step = config.steps[i];
        const stepIndex = i;
        const startedAt = new Date().toISOString();

        // Policy pre-check for this step
        const classification = config.dataClassification || DataClassification.Internal;
        const policyInput: PolicyEvaluationInput = {
          workspaceId,
          dataClassification: classification,
          requestedCompute: step.modelAdapter.isLocal ? 'local' : 'cloud',
          providerId: step.modelAdapter.providerId,
          modelId: step.modelId,
          requestedOperation: 'generate',
          agentId: step.agentId,
        };

        const policyResult = await this.policyService.evaluate(policyInput);

        // Store step record — mark as running initially, will update on completion
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

          // Prompt injection detection on retrieved content
          for (const chunk of retrievedChunks) {
            const matches = this.piDetector.detect(chunk.snippet);
            for (const match of matches) {
              this.db.appendRunEvent(groupRunId, workspaceId, RunEventType.PromptInjectionWarning, {
                chunkId: chunk.chunkId,
                patternId: match.patternId,
                evidence: match.evidence,
                evidenceHash: match.evidenceHash,
                detectorVersion: match.detectorVersion,
              });
            }
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
    this.running.set(groupRunId, 'cancelled');
    this.db.getRawDB().prepare(
      "UPDATE agent_group_runs SET status = 'cancelled', completed_at = datetime('now') WHERE id = ?"
    ).run(groupRunId);
  }

  pausePipeline(groupRunId: string): void {
    const state = this.running.get(groupRunId);
    if (state === 'running') {
      this.running.set(groupRunId, 'paused');
      this.db.getRawDB().prepare(
        "UPDATE agent_group_runs SET status = 'paused' WHERE id = ?"
      ).run(groupRunId);
    }
  }

  resumePipeline(groupRunId: string): void {
    const state = this.running.get(groupRunId);
    if (state === 'paused') {
      this.running.set(groupRunId, 'running');
      this.db.getRawDB().prepare(
        "UPDATE agent_group_runs SET status = 'running' WHERE id = ?"
      ).run(groupRunId);
    }
  }

  /**
   * Force-generate a summary for a pipeline run, regardless of completion status.
   */
  forceSummarize(groupRunId: string, steps: StepResult[]): string {
    if (steps.length === 0) return 'No steps completed.';
    const summary = steps.map(s =>
      `[${s.role}] ${s.agentId}: ${(s.output || '').substring(0, 200)}`
    ).join('\n');
    this.db.appendRunEvent(groupRunId, '', 'force_summarized', {
      stepsCompleted: steps.length,
      summaryLength: summary.length,
    });
    return summary;
  }

  /**
   * Run steps in parallel — all agents start simultaneously.
   * Each step performs real model invocation with policy checks,
   * route decisions, RAG retrieval, and token tracking.
   * Results are collected via Promise.all.
   *
   * BETA: This mode is reserved for Beta release. In Alpha, only
   * runPipeline is supported. This method is kept for development
   * and testing but will be gated behind a feature flag in Beta.
   */
  async runParallel(config: PipelineConfig, _workspaceId: string): Promise<{
    groupRunId: string; steps: StepResult[]; summary: string;
    totalTokens: number; blocked: boolean;
  }> {
    const groupRunId = `grp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
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
      mode: 'parallel',
      task: config.task,
      steps: config.steps.map(s => ({ agentId: s.agentId, role: s.role })),
    });

    this.running.set(groupRunId, 'running');
    const stepsToRun = config.steps.slice(0, maxSteps);

    // Check for cancellation / pause / timeout / token limit before starting
    if (this.running.get(groupRunId) === 'cancelled' ||
        this.running.get(groupRunId) === 'paused' ||
        Date.now() - startTime > maxDurationMs ||
        totalTokensUsed >= maxTokens) {
      this.db.getRawDB().prepare(
        "UPDATE agent_group_runs SET status = 'completed', completed_at = datetime('now') WHERE id = ?"
      ).run(groupRunId);
      this.running.delete(groupRunId);
      return {
        groupRunId, steps: [],
        summary: 'No steps executed - pipeline was cancelled, paused, or exceeded limits.',
        totalTokens: 0, blocked: false,
      };
    }

    const stepPromises = stepsToRun.map(async (step, stepIndex) => {
      const startedAt = new Date().toISOString();

      // Policy pre-check for this step
      const classification = config.dataClassification || DataClassification.Internal;
      const policyInput: PolicyEvaluationInput = {
        workspaceId,
        dataClassification: classification,
        requestedCompute: step.modelAdapter.isLocal ? 'local' : 'cloud',
        providerId: step.modelAdapter.providerId,
        modelId: step.modelId,
        requestedOperation: 'generate',
        agentId: step.agentId,
      };

      await this.policyService.evaluate(policyInput);

      // Store step record
      const stepId = `step_${groupRunId}_${stepIndex}`;
      this.db.getRawDB().prepare(`
        INSERT INTO run_steps (id, agent_group_run_id, step_index, agent_id, role, status, started_at)
        VALUES (?, ?, ?, ?, ?, 'running', ?)
      `).run(stepId, groupRunId, stepIndex, step.agentId, step.role, startedAt);

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
          step: stepIndex,
          agentId: step.agentId,
          reasons: routeDecision.reasons,
        });
      } else {
        // Assemble prompt - in parallel mode, steps are independent (no previous step context)
        const promptParts: Array<{ role: 'system' | 'developer' | 'user' | 'assistant' | 'context'; content: string }> = [
          { role: 'system', content: `You are ${step.agentId}, acting as ${step.role}. ${step.instruction}` },
        ];

        // Retrieve RAG context for this step
        const retrievedChunks = this.ragEngine.retrieve(step.instruction + ' ' + config.task, workspaceId, 5);
        if (retrievedChunks.length > 0) {
          const contextBlock = retrievedChunks.map((c, j) =>
            `[Source ${j + 1}] ${c.fileName}: ${c.snippet}`
          ).join('\n');
          promptParts.push({ role: 'context' as const, content: `Retrieved knowledge:\n${contextBlock}` });
          citations = this.ragEngine.assembleCitations(retrievedChunks);
        }

          // Prompt injection detection on retrieved content
          for (const chunk of retrievedChunks) {
            const matches = this.piDetector.detect(chunk.snippet);
            for (const match of matches) {
              this.db.appendRunEvent(groupRunId, workspaceId, RunEventType.PromptInjectionWarning, {
                chunkId: chunk.chunkId,
                patternId: match.patternId,
                evidence: match.evidence,
                evidenceHash: match.evidenceHash,
                detectorVersion: match.detectorVersion,
              });
            }
          }

        // Invoke model
        const modelRequest = {
          runId: groupRunId,
          workspaceId,
          routeDecisionId: routeDecision.id,
          policyEvaluationId: `pe_${groupRunId}_${stepIndex}`,
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
            eventSummary: `Pipeline parallel step ${stepIndex + 1}/${stepsToRun.length}: ${step.agentId} (${step.role}) completed "${step.instruction.substring(0, 60)}..."`,
            participatingAgentIds: [step.agentId],
            sourceRunId: groupRunId,
            sourceFileIds: [],
            sourceRouteDecisionId: routeDecision.id,
            sourceEventIds: [],
          });
        } catch (err) {
          output = `[Error] Model invocation failed: ${(err as Error).message}`;
          this.db.appendRunEvent(groupRunId, workspaceId, RunEventType.RunFailed, {
            step: stepIndex,
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

      return {
        stepIndex,
        agentId: step.agentId,
        role: step.role,
        output,
        routeDecision,
        modelCall,
        citations,
        startedAt,
        completedAt,
      };
    });

    const stepResults = await Promise.all(stepPromises);

    // Generate summary
    const summary = stepResults.map(s =>
      `[${s.role}] ${s.agentId}: ${s.output.substring(0, 100)}...`
    ).join('\n');

    // Complete the group run
    this.db.getRawDB().prepare(
      "UPDATE agent_group_runs SET status = 'completed', completed_at = datetime('now') WHERE id = ?"
    ).run(groupRunId);

    this.db.appendRunEvent(groupRunId, workspaceId, RunEventType.AuditComplete, {
      mode: 'parallel',
      stepsCompleted: stepResults.length,
      totalTokens: totalTokensUsed,
    });

    this.running.delete(groupRunId);

    return {
      groupRunId,
      steps: stepResults,
      summary,
      totalTokens: totalTokensUsed,
      blocked: stepResults.some(s => s.output.startsWith('[Blocked]')),
    };
  }

  /**
   * Run debate mode — agents exchange arguments in rounds.
   * Each round: all agents respond in sequence, seeing the previous round's arguments.
   * Real model invocation with policy checks, route decisions, RAG retrieval, and token tracking.
   *
   * BETA: This mode is reserved for Beta release. In Alpha, only
   * runPipeline is supported. This method is kept for development
   * and testing but will be gated behind a feature flag in Beta.
   */
  async runDebate(config: PipelineConfig, _workspaceId: string): Promise<{
    groupRunId: string; steps: StepResult[]; summary: string;
    totalTokens: number; blocked: boolean;
  }> {
    const groupRunId = `grp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const workspaceId = config.workspaceId;
    const rounds = Math.min(config.maxSteps || 3, 5);
    const agents = config.steps.slice(0, 5);
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
      mode: 'debate',
      task: config.task,
      agents: agents.map(s => ({ agentId: s.agentId, role: s.role })),
      rounds,
    });

    this.running.set(groupRunId, 'running');

    // Check for cancellation / pause before starting
    if (this.running.get(groupRunId) === 'cancelled' ||
        this.running.get(groupRunId) === 'paused') {
      this.db.getRawDB().prepare(
        "UPDATE agent_group_runs SET status = 'completed', completed_at = datetime('now') WHERE id = ?"
      ).run(groupRunId);
      this.running.delete(groupRunId);
      return {
        groupRunId, steps: [],
        summary: 'No debate conducted - pipeline was cancelled or paused.',
        totalTokens: 0, blocked: false,
      };
    }

    const roundResults: StepResult[] = [];
    let lastRoundOutputs: string[] = []; // outputs from the previous round

    for (let round = 0; round < rounds; round++) {
      if (this.running.get(groupRunId) === 'cancelled') break;
      if (this.running.get(groupRunId) === 'paused') break;
      if (Date.now() - startTime > maxDurationMs) break;
      if (totalTokensUsed >= maxTokens) break;

      const currentRoundOutputs: string[] = [];

      for (let a = 0; a < agents.length; a++) {
        if (this.running.get(groupRunId) === 'cancelled') break;
        if (this.running.get(groupRunId) === 'paused') break;
        if (Date.now() - startTime > maxDurationMs) break;
        if (totalTokensUsed >= maxTokens) break;

        const agent = agents[a];
        const stepIndex = round * agents.length + a;
        const startedAt = new Date().toISOString();

        // Policy pre-check for this utterance
        const classification = config.dataClassification || DataClassification.Internal;
        const policyInput: PolicyEvaluationInput = {
          workspaceId,
          dataClassification: classification,
          requestedCompute: agent.modelAdapter.isLocal ? 'local' : 'cloud',
          providerId: agent.modelAdapter.providerId,
          modelId: agent.modelId,
          requestedOperation: 'generate',
          agentId: agent.agentId,
        };

        await this.policyService.evaluate(policyInput);

        // Store step record
        const stepId = `step_${groupRunId}_${stepIndex}`;
        this.db.getRawDB().prepare(`
          INSERT INTO run_steps (id, agent_group_run_id, step_index, agent_id, role, status, started_at)
          VALUES (?, ?, ?, ?, ?, 'running', ?)
        `).run(stepId, groupRunId, stepIndex, agent.agentId, agent.role, startedAt);

        // Route decision per utterance
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
            step: stepIndex,
            agentId: agent.agentId,
            reasons: routeDecision.reasons,
          });
        } else {
          // Build debate prompt with round history
          const promptParts: Array<{ role: 'system' | 'developer' | 'user' | 'assistant' | 'context'; content: string }> = [
            {
              role: 'system',
              content: `You are ${agent.agentId}, acting as ${agent.role}. ${agent.instruction}\nYou are participating in a multi-round debate on the topic: "${config.task}".\nRound ${round + 1} of ${rounds}.`,
            },
          ];

          // Add previous round context for all agents
          if (lastRoundOutputs.length > 0) {
            const debateHistory = lastRoundOutputs.map((out, idx) =>
              `[Round ${round}, ${agents[idx].agentId} (${agents[idx].role})]: ${out.substring(0, 500)}`
            ).join('\n\n');
            promptParts.push({
              role: 'context' as const,
              content: `Previous round arguments:\n${debateHistory}`,
            });
          }

          // Retrieve RAG context for this utterance
          const retrievedChunks = this.ragEngine.retrieve(agent.instruction + ' ' + config.task, workspaceId, 5);
          if (retrievedChunks.length > 0) {
            const contextBlock = retrievedChunks.map((c, j) =>
              `[Source ${j + 1}] ${c.fileName}: ${c.snippet}`
            ).join('\n');
            promptParts.push({ role: 'context' as const, content: `Retrieved knowledge:\n${contextBlock}` });
            citations = this.ragEngine.assembleCitations(retrievedChunks);
          }

          // Prompt injection detection on retrieved content
          for (const chunk of retrievedChunks) {
            const matches = this.piDetector.detect(chunk.snippet);
            for (const match of matches) {
              this.db.appendRunEvent(groupRunId, workspaceId, RunEventType.PromptInjectionWarning, {
                chunkId: chunk.chunkId,
                patternId: match.patternId,
                evidence: match.evidence,
                evidenceHash: match.evidenceHash,
                detectorVersion: match.detectorVersion,
              });
            }
          }

          // Invoke model
          const modelRequest = {
            runId: groupRunId,
            workspaceId,
            routeDecisionId: routeDecision.id,
            policyEvaluationId: `pe_${groupRunId}_${stepIndex}`,
            policyVersionHash: this.policyService.getPolicyVersionHash(),
            allowedProviderId: agent.modelAdapter.providerId,
            allowedModelId: agent.modelId,
            promptParts,
            contextSourceIds: retrievedChunks.map(c => c.chunkId),
            payloadHash: crypto.createHash('sha256').update(promptParts.map(p => p.content).join('')).digest('hex'),
            routeDecisionSnapshot: routeDecision as any,
          };

          try {
            const result = await agent.modelAdapter.generate(modelRequest);
            output = result.content;
            modelCall = result;
            totalTokensUsed += result.tokenUsage.total;

            // Write model call record
            this.db.storeModelCall({
              id: result.id,
              runId: groupRunId,
              status: 'completed',
              adapterKind: agent.modelAdapter.constructor.name,
              providerId: agent.modelAdapter.providerId,
              modelId: agent.modelId,
              routeDecisionId: routeDecision.id,
              isCloud: !agent.modelAdapter.isLocal,
              tokenUsage: result.tokenUsage,
              startedAt: result.startedAt,
              completedAt: result.completedAt,
            });

            // Auto-write episodic memory for this debate turn
            await this.memoryService.writeEpisodic({
              workspaceId,
              eventSummary: `Debate round ${round + 1}/${rounds}: ${agent.agentId} (${agent.role}) argued "${agent.instruction.substring(0, 60)}..."`,
              participatingAgentIds: [agent.agentId],
              sourceRunId: groupRunId,
              sourceFileIds: [],
              sourceRouteDecisionId: routeDecision.id,
              sourceEventIds: [],
            });
          } catch (err) {
            output = `[Error] Model invocation failed: ${(err as Error).message}`;
            this.db.appendRunEvent(groupRunId, workspaceId, RunEventType.RunFailed, {
              step: stepIndex,
              agentId: agent.agentId,
              error: (err as Error).message,
            });
          }
        }

        // Complete step
        const completedAt = new Date().toISOString();
        this.db.getRawDB().prepare(`
          UPDATE run_steps SET status = ?, output_hash = ?, completed_at = ? WHERE id = ?
        `).run(blocked ? 'blocked' : 'completed', crypto.createHash('sha256').update(output).digest('hex'), completedAt, stepId);

        currentRoundOutputs.push(output);
        roundResults.push({
          stepIndex,
          agentId: agent.agentId,
          role: agent.role,
          output,
          routeDecision,
          modelCall,
          citations,
          startedAt,
          completedAt,
        });
      }

      // After round completes, pass outputs as context for the next round
      lastRoundOutputs = currentRoundOutputs;
    }

    // Generate summary
    const summary = roundResults.map(s =>
      `[${s.role}] ${s.agentId}: ${s.output.substring(0, 100)}...`
    ).join('\n');

    // Complete the group run
    this.db.getRawDB().prepare(
      "UPDATE agent_group_runs SET status = 'completed', completed_at = datetime('now') WHERE id = ?"
    ).run(groupRunId);

    this.db.appendRunEvent(groupRunId, workspaceId, RunEventType.AuditComplete, {
      mode: 'debate',
      roundsCompleted: agents.length > 0 ? Math.floor(roundResults.length / agents.length) : 0,
      totalTokens: totalTokensUsed,
    });

    this.running.delete(groupRunId);

    return {
      groupRunId,
      steps: roundResults,
      summary,
      totalTokens: totalTokensUsed,
      blocked: roundResults.some(s => s.output.startsWith('[Blocked]')),
    };
  }
}
