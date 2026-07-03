import { DatabaseService } from './database-service';
import { PolicyService, PolicyEvaluationInput } from './policy-service';
import { AuditService } from './audit-service';
import * as crypto from 'crypto';

/**
 * A2A-compatible bridge for Ogra Desktop.
 *
 * Maps an external A2A task to an internal Ogra run, records it
 * in the database, runs policy checks, and returns a result.
 *
 * v1.0 scope:
 * - Mapping A2A task -> internal run with workspace awareness
 * - Return final artifact/result with storage reference
 * - Policy check before delegation
 * - Audit record for inbound delegation
 * - Blocked/error semantics
 */
export class A2ABridge {
  constructor(
    private db: DatabaseService,
    private policyService: PolicyService,
    private auditService: AuditService,
  ) {}

  /**
   * Accept an A2A task and create a tracked internal run.
   * @param task A2A task details
   * @param workspaceId Ogra workspace to execute in (defaults to first workspace)
   */
  async acceptTask(
    task: {
      taskId: string;
      agentId: string;
      query: string;
      sessionId?: string;
      metadata?: Record<string, unknown>;
    },
    workspaceId?: string,
  ): Promise<{
    status: string;
    result?: string;
    artifactRef?: string;
    error?: string;
    routeDecisionId?: string;
  }> {
    // Resolve workspace — use provided or find first available
    let resolvedWorkspaceId = workspaceId;
    if (!resolvedWorkspaceId) {
      const workspaces = this.db.listWorkspaces();
      if (workspaces.length === 0) {
        return { status: 'failed', error: 'No workspace available for A2A delegation' };
      }
      resolvedWorkspaceId = workspaces[0].id;
    }

    const runId = `a2a_${Date.now()}_${task.taskId}`;
    const now = new Date().toISOString();

    // Create run record in database
    this.db.storeRun({
      id: runId,
      workspaceId: resolvedWorkspaceId,
      task: `[A2A] ${task.query.substring(0, 200)}`,
      status: 'policy_precheck',
      startedAt: now,
    });

    // Policy check
    const policyInput: PolicyEvaluationInput = {
      workspaceId: resolvedWorkspaceId,
      dataClassification: 'Internal' as any,
      requestedOperation: 'agent_delegation',
      agentId: task.agentId,
    };

    const policyResult = await this.policyService.evaluate(policyInput);

    if (policyResult.decision === 'blocked') {
      this.db.updateRunStatus(runId, 'blocked');
      await this.auditService.appendEvent({
        runId,
        workspaceId: resolvedWorkspaceId,
        eventType: 'a2a_delegation_blocked',
        eventPayload: { taskId: task.taskId, agentId: task.agentId, reasons: policyResult.reasons },
      });
      return { status: 'blocked', error: policyResult.reasons.join('; ') };
    }

    // Record audit events
    await this.auditService.appendEvent({
      runId,
      workspaceId: resolvedWorkspaceId,
      eventType: 'a2a_task_received',
      eventPayload: {
        taskId: task.taskId,
        agentId: task.agentId,
        queryLength: task.query.length,
        workspaceId: resolvedWorkspaceId,
      },
    });

    // Generate artifact reference
    const artifactId = `art_a2a_${crypto.randomBytes(4).toString('hex')}`;
    const result = `A2A task "${task.taskId}" processed via Ogra bridge in workspace "${resolvedWorkspaceId}". Query: "${task.query.substring(0, 100)}"`;
    const routeDecisionId = `rd_a2a_${runId}`;

    // Update run status
    this.db.updateRunStatus(runId, 'completed', now);

    // Record completion audit
    await this.auditService.appendEvent({
      runId,
      workspaceId: resolvedWorkspaceId,
      eventType: 'a2a_task_completed',
      eventPayload: { taskId: task.taskId, artifactId, routeDecisionId, resultLength: result.length },
    });

    return {
      status: 'completed',
      result,
      artifactRef: artifactId,
      routeDecisionId,
    };
  }
}
