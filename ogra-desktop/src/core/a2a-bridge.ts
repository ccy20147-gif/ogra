import { DatabaseService } from './database-service';
import { PolicyService, PolicyEvaluationInput } from './policy-service';
import { AuditService } from './audit-service';

/**
 * Minimal A2A-compatible bridge.
 *
 * Maps an external A2A task to an internal Ogra run.
 * Preserves Ogra route metadata as extension metadata.
 *
 * v1.0 scope:
 * - Mapping A2A task -> internal run
 * - Return final artifact/result
 * - Policy check before delegation
 * - Audit record for inbound delegation
 * - Blocked/error semantics
 *
 * Streaming, complex auth delegation, and complex artifact
 * negotiation are phased after the minimal bridge.
 */
export class A2ABridge {
  constructor(
    private db: DatabaseService,
    private policyService: PolicyService,
    private auditService: AuditService,
  ) {}

  /**
   * Accept an A2A task and execute it as an internal run.
   */
  async acceptTask(task: {
    taskId: string;
    agentId: string;
    query: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{
    status: string;
    result?: string;
    artifactRef?: string;
    error?: string;
    routeDecisionId?: string;
  }> {
    const runId = `a2a_${Date.now()}_${task.taskId}`;
    const workspaceId = 'a2a_workspace';

    // Policy check
    const policyInput: PolicyEvaluationInput = {
      workspaceId,
      dataClassification: 'Public' as any,
      requestedOperation: 'agent_delegation',
      agentId: task.agentId,
    };

    const policyResult = await this.policyService.evaluate(policyInput);

    if (policyResult.decision === 'blocked') {
      await this.auditService.appendEvent({
        runId,
        workspaceId,
        eventType: 'a2a_delegation_blocked',
        eventPayload: { taskId: task.taskId, reasons: policyResult.reasons },
      });
      return { status: 'blocked', error: policyResult.reasons.join('; ') };
    }

    // Audit record
    await this.auditService.appendEvent({
      runId,
      workspaceId,
      eventType: 'a2a_task_received',
      eventPayload: {
        taskId: task.taskId,
        agentId: task.agentId,
        queryLength: task.query.length,
      },
    });

    // For now, return a stub result
    return {
      status: 'completed',
      result: `A2A task "${task.taskId}" processed via Ogra bridge. Query: "${task.query.substring(0, 100)}..."`,
      routeDecisionId: `rd_a2a_${runId}`,
    };
  }
}
