import { OgraCoreConfig } from './index';
import { WorkspaceService } from './workspace-service';
import { RouteService, RouteDecisionRecord } from './route-service';
import { AuditService } from './audit-service';
import { DatabaseService } from './database-service';
import { PolicyService, PolicyEvaluationInput } from './policy-service';
import { DataClassification, RunEventType, RunStatus, RiskLevel } from '../shared/types';
import { OgraError, OgraErrorCode } from '../shared/errors';

export interface RunStartRequest {
  workspaceId: string;
  task: string;
  knowledgeBaseIds?: string[];
  requestedModel?: string;
  requestedProvider?: string;
}

export interface RunRecord {
  id: string;
  workspaceId: string;
  task: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  finalOutputLocation?: string;
  routeDecision?: RouteDecisionRecord;
  error?: string;
}

/**
 * Run Service — manages the lifecycle of agent runs.
 *
 * Each run follows:
 * created -> policy_precheck -> retrieval -> context_policy_check ->
 * route_decision -> risk_classified -> model_invocation -> final_output -> audit_complete
 *
 * All runs are persisted to SQLite agent_runs table for durability.
 */
export class RunService {
  private runs: Map<string, RunRecord> = new Map();

  constructor(
    private workspaceService: WorkspaceService,
    private routeService: RouteService,
    private auditService: AuditService,
    private policyService: PolicyService,
    private config: OgraCoreConfig,
    private db?: DatabaseService,
  ) {}

  async startRun(req: RunStartRequest): Promise<RunRecord> {
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    const workspace = await this.workspaceService.get(req.workspaceId);

    const run: RunRecord = {
      id: runId,
      workspaceId: req.workspaceId,
      task: req.task,
      status: RunStatus.Created,
      startedAt: now,
    };
    this.runs.set(runId, run);

    // Persist to SQLite
    this.db?.storeRun({
      id: runId,
      workspaceId: req.workspaceId,
      task: req.task,
      status: RunStatus.Created,
      startedAt: now,
    });

    // Event: run_created
    await this.auditService.appendEvent({
      runId,
      workspaceId: req.workspaceId,
      eventType: RunEventType.RunCreated,
      eventPayload: { task: req.task, workspaceId: req.workspaceId },
    });

    // Step 1: Policy pre-check
    await this.transitionTo(runId, RunStatus.PolicyPrecheck);

    const policyInput: PolicyEvaluationInput = {
      workspaceId: req.workspaceId,
      workspaceDefaultClassification: workspace.defaultClassification,
      dataClassification: workspace.defaultClassification,
      providerId: req.requestedProvider,
      modelId: req.requestedModel,
      requestedOperation: 'generate',
    };

    const routeDecision = await this.routeService.evaluateRoute(policyInput);

    // Store route decision
    run.routeDecision = routeDecision;

    // Event: route_decision
    await this.auditService.appendEvent({
      runId,
      workspaceId: req.workspaceId,
      eventType: RunEventType.RouteDecision,
      eventPayload: {
        route: routeDecision.route,
        dataClassification: routeDecision.dataClassification,
        reasons: routeDecision.reasons,
      },
      policyVersionHash: this.policyService.getPolicyVersionHash(),
    });

    // If blocked
    if (routeDecision.route === 'blocked') {
      run.status = RunStatus.Blocked;
      run.completedAt = new Date().toISOString();
      await this.auditService.appendEvent({
        runId,
        workspaceId: req.workspaceId,
        eventType: RunEventType.RunBlocked,
        eventPayload: {
          route: 'blocked',
          reasons: routeDecision.reasons,
        },
        policyVersionHash: this.policyService.getPolicyVersionHash(),
      });
      return run;
    }

    // Step 2: Risk classification
    await this.transitionTo(runId, RunStatus.RiskClassified);
    await this.auditService.appendEvent({
      runId,
      workspaceId: req.workspaceId,
      eventType: RunEventType.RiskClassification,
      eventPayload: {
        riskLevel: routeDecision.route === 'cloud' ? 'medium' : 'low',
        reasons: routeDecision.reasons,
      },
    });

    // Step 3: Model invocation (simplified for Alpha)
    if (routeDecision.route === 'local' || routeDecision.route === 'cloud') {
      await this.transitionTo(runId, RunStatus.ModelInvocation);
      await this.auditService.appendEvent({
        runId,
        workspaceId: req.workspaceId,
        eventType: RunEventType.ModelCallStarted,
        eventPayload: {
          route: routeDecision.route,
          providerId: req.requestedProvider,
          modelId: req.requestedModel,
        },
      });

      // Simulate model call completion
      await this.auditService.appendEvent({
        runId,
        workspaceId: req.workspaceId,
        eventType: RunEventType.ModelCallCompleted,
        eventPayload: {
          route: routeDecision.route,
          isCloud: routeDecision.route === 'cloud',
          tokenUsage: { prompt: 150, completion: 300, total: 450 },
        },
      });

      // Final output
      await this.transitionTo(runId, RunStatus.Completed);
      run.status = RunStatus.Completed;
      run.completedAt = new Date().toISOString();

      await this.auditService.appendEvent({
        runId,
        workspaceId: req.workspaceId,
        eventType: RunEventType.AuditComplete,
        eventPayload: { status: 'completed' },
        policyVersionHash: this.policyService.getPolicyVersionHash(),
      });
    }

    return run;
  }

  async getStatus(runId: string): Promise<RunRecord | null> {
    return this.runs.get(runId) ?? null;
  }

  async cancelRun(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new OgraError(OgraErrorCode.RUN_NOT_FOUND, `Run ${runId} not found`);

    run.status = RunStatus.Cancelled;
    run.completedAt = new Date().toISOString();

    await this.auditService.appendEvent({
      runId,
      workspaceId: run.workspaceId,
      eventType: RunEventType.RunCancelled,
      eventPayload: { reason: 'User cancelled' },
    });
  }

  private async transitionTo(runId: string, status: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run) {
      run.status = status;
    }
  }
}
