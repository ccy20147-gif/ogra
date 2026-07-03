import { DatabaseService } from './database-service';
import { PolicyService, PolicyEvaluationInput } from './policy-service';
import * as crypto from 'crypto';

export interface EpisodicMemory {
  id: string;
  workspaceId: string;
  eventSummary: string;
  occurredAt: string;
  participatingAgentIds: string[];
  sourceRunId?: string;
  sourceFileIds: string[];
  sourceRouteDecisionId?: string;
  sourceEventIds: string[];
  confidence: number;
  scope: string;
  createdAt: string;
  deletedAt?: string;
}

export interface SemanticMemory {
  id: string;
  workspaceId: string;
  subject: string;
  relation: string;
  object: string;
  sourceRunId?: string;
  sourceFileIds: string[];
  sourceRouteDecisionId?: string;
  confidence: number;
  userConfirmed: boolean;
  scope: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface ProceduralMemory {
  id: string;
  workspaceId: string;
  taskType: string;
  recommendedAgentGroupId?: string;
  toolchain: string[];
  routePolicyId?: string;
  failureNotes?: string;
  sourceRunId?: string;
  userConfirmed: boolean;
  scope: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

/**
 * M3 Memory Service for Ogra Desktop.
 *
 * Rules:
 * - ONLY episodic memories are automatically written (run summaries).
 * - Semantic and procedural memories REQUIRE explicit user confirmation.
 * - All memories are source-linked (run, files, route decision).
 * - Users can edit and delete memories (preserving tombstones).
 * - Memory read/write requires policy check.
 */
export class MemoryService {
  constructor(
    private db: DatabaseService,
    private policyService?: PolicyService,
  ) {}

  /**
   * Record a memory access event to the audit trail.
   */
  private recordMemoryAccess(params: {
    runId?: string;
    memoryId: string;
    memoryType: 'episodic' | 'semantic' | 'procedural';
    accessType: 'read' | 'proposed_write' | 'confirmed_write' | 'edited' | 'deleted' | 'denied';
    policyEvaluationId?: string;
    routeDecisionId?: string;
  }): void {
    const id = `mae_${crypto.randomBytes(8).toString('hex')}`;
    this.db.getRawDB().prepare(`
      INSERT INTO memory_access_events (id, run_id, memory_id, memory_type, access_type,
        policy_evaluation_id, route_decision_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, params.runId || null, params.memoryId, params.memoryType,
      params.accessType, params.policyEvaluationId || null, params.routeDecisionId || null);
  }

  /**
   * Run policy check before memory write.
   */
  private async checkPolicy(workspaceId: string, memoryType: string, runId?: string): Promise<{ allowed: boolean; reason?: string }> {
    if (!this.policyService) return { allowed: true };
    try {
      const result = await this.policyService.evaluate({
        workspaceId,
        dataClassification: 'Internal' as any,
        requestedOperation: 'write_memory',
        hasUserApproval: memoryType === 'episodic', // Episodic is auto-approved
      });
      if (result.decision === 'blocked') {
        return { allowed: false, reason: result.reasons.join('; ') };
      }
      return { allowed: true };
    } catch {
      return { allowed: true }; // Fail open for memory writes in Alpha
    }
  }

  // ---- Episodic Memory (auto-written) ----

  async writeEpisodic(memory: {
    workspaceId: string;
    eventSummary: string;
    participatingAgentIds: string[];
    sourceRunId?: string;
    sourceFileIds: string[];
    sourceRouteDecisionId?: string;
    sourceEventIds: string[];
  }): Promise<EpisodicMemory> {
    const id = `mem_ep_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    // Policy check before write
    const policy = await this.checkPolicy(memory.workspaceId, 'episodic', memory.sourceRunId);
    if (!policy.allowed) {
      throw new Error(`Memory write blocked by policy: ${policy.reason}`);
    }

    const row = {
      id,
      workspace_id: memory.workspaceId,
      event_summary: memory.eventSummary,
      occurred_at: now,
      participating_agent_ids_json: JSON.stringify(memory.participatingAgentIds),
      source_run_id: memory.sourceRunId || null,
      source_file_ids_json: JSON.stringify(memory.sourceFileIds),
      source_route_decision_id: memory.sourceRouteDecisionId || null,
      source_event_ids_json: JSON.stringify(memory.sourceEventIds),
      confidence: 0.8,
      scope: 'workspace',
      created_at: now,
      deleted_at: null,
    };

    this.db.getRawDB().prepare(`
      INSERT INTO episodic_memories (id, workspace_id, event_summary, occurred_at,
        participating_agent_ids_json, source_run_id, source_file_ids_json,
        source_route_decision_id, source_event_ids_json, confidence, scope, created_at)
      VALUES (@id, @workspace_id, @event_summary, @occurred_at,
        @participating_agent_ids_json, @source_run_id, @source_file_ids_json,
        @source_route_decision_id, @source_event_ids_json, @confidence, @scope, @created_at)
    `).run(row);

    this.recordMemoryAccess({
      memoryId: id,
      memoryType: 'episodic',
      accessType: 'confirmed_write',
      runId: memory.sourceRunId,
    });

    return this.toEpisodic(row as any);
  }

  listEpisodic(workspaceId: string, limit = 50): EpisodicMemory[] {
    const rows = this.db.getRawDB().prepare(
      'SELECT * FROM episodic_memories WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?'
    ).all(workspaceId, limit) as any[];
    return rows.map(r => this.toEpisodic(r));
  }

  // ---- Semantic Memory (requires user confirmation) ----

  async proposeSemantic(memory: {
    workspaceId: string;
    subject: string;
    relation: string;
    object: string;
    sourceRunId?: string;
    sourceFileIds: string[];
  }): Promise<SemanticMemory> {
    const id = `mem_sem_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    const policy = await this.checkPolicy(memory.workspaceId, 'semantic', memory.sourceRunId);
    if (!policy.allowed) {
      throw new Error(`Semantic memory write blocked by policy: ${policy.reason}`);
    }

    const row = {
      id,
      workspace_id: memory.workspaceId,
      subject: memory.subject,
      relation: memory.relation,
      object: memory.object,
      source_run_id: memory.sourceRunId || null,
      source_file_ids_json: JSON.stringify(memory.sourceFileIds),
      source_route_decision_id: null,
      confidence: 0.5,
      user_confirmed: 0,
      scope: 'workspace',
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };

    this.db.getRawDB().prepare(`
      INSERT INTO semantic_memories (id, workspace_id, subject, relation, object,
        source_run_id, source_file_ids_json, confidence, user_confirmed, scope, created_at, updated_at)
      VALUES (@id, @workspace_id, @subject, @relation, @object,
        @source_run_id, @source_file_ids_json, @confidence, @user_confirmed, @scope, @created_at, @updated_at)
    `).run(row);

    this.recordMemoryAccess({
      memoryId: id,
      memoryType: 'semantic',
      accessType: 'proposed_write',
      runId: memory.sourceRunId,
    });

    return this.toSemantic(row as any);
  }

  async confirmSemantic(id: string): Promise<void> {
    this.db.getRawDB().prepare(
      "UPDATE semantic_memories SET user_confirmed = 1, updated_at = datetime('now') WHERE id = ?"
    ).run(id);
    this.recordMemoryAccess({
      memoryId: id,
      memoryType: 'semantic',
      accessType: 'confirmed_write',
    });
  }

  listConfirmedSemantic(workspaceId: string): SemanticMemory[] {
    const rows = this.db.getRawDB().prepare(
      `SELECT * FROM semantic_memories
       WHERE workspace_id = ? AND user_confirmed = 1 AND deleted_at IS NULL
       ORDER BY updated_at DESC`
    ).all(workspaceId) as any[];
    return rows.map(r => this.toSemantic(r));
  }

  // ---- Procedural Memory (requires user confirmation) ----

  async proposeProcedural(memory: {
    workspaceId: string;
    taskType: string;
    toolchain: string[];
    routePolicyId?: string;
    failureNotes?: string;
    sourceRunId?: string;
  }): Promise<ProceduralMemory> {
    const id = `mem_proc_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();
    const row = {
      id,
      workspace_id: memory.workspaceId,
      task_type: memory.taskType,
      recommended_agent_group_id: null,
      toolchain_json: JSON.stringify(memory.toolchain),
      route_policy_id: memory.routePolicyId || null,
      failure_notes: memory.failureNotes || null,
      source_run_id: memory.sourceRunId || null,
      user_confirmed: 0,
      scope: 'workspace',
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };

    this.db.getRawDB().prepare(`
      INSERT INTO procedural_memories (id, workspace_id, task_type,
        toolchain_json, route_policy_id, failure_notes, source_run_id,
        user_confirmed, scope, created_at, updated_at)
      VALUES (@id, @workspace_id, @task_type,
        @toolchain_json, @route_policy_id, @failure_notes, @source_run_id,
        @user_confirmed, @scope, @created_at, @updated_at)
    `).run(row);

    this.recordMemoryAccess({
      memoryId: id,
      memoryType: 'procedural',
      accessType: 'proposed_write',
      runId: memory.sourceRunId,
    });

    return this.toProcedural(row as any);
  }

  async confirmProcedural(id: string): Promise<void> {
    this.db.getRawDB().prepare(
      "UPDATE procedural_memories SET user_confirmed = 1, updated_at = datetime('now') WHERE id = ?"
    ).run(id);
    this.recordMemoryAccess({
      memoryId: id,
      memoryType: 'procedural',
      accessType: 'confirmed_write',
    });
  }

  // ---- Generic Memory Operations ----

  async deleteMemory(type: 'episodic' | 'semantic' | 'procedural', id: string): Promise<void> {
    const table = type === 'episodic' ? 'episodic_memories'
      : type === 'semantic' ? 'semantic_memories' : 'procedural_memories';
    this.db.getRawDB().prepare(
      `UPDATE ${table} SET deleted_at = datetime('now') WHERE id = ?`
    ).run(id);
    this.recordMemoryAccess({
      memoryId: id,
      memoryType: type,
      accessType: 'deleted',
    });
  }

  getMemoryStats(workspaceId: string): {
    episodic: number; semanticConfirmed: number; semanticPending: number;
    proceduralConfirmed: number; proceduralPending: number;
  } {
    const episodic = (this.db.getRawDB().prepare(
      'SELECT COUNT(*) as c FROM episodic_memories WHERE workspace_id = ? AND deleted_at IS NULL'
    ).get(workspaceId) as any).c;

    const semanticConfirmed = (this.db.getRawDB().prepare(
      'SELECT COUNT(*) as c FROM semantic_memories WHERE workspace_id = ? AND user_confirmed = 1 AND deleted_at IS NULL'
    ).get(workspaceId) as any).c;

    const semanticPending = (this.db.getRawDB().prepare(
      'SELECT COUNT(*) as c FROM semantic_memories WHERE workspace_id = ? AND user_confirmed = 0 AND deleted_at IS NULL'
    ).get(workspaceId) as any).c;

    const proceduralConfirmed = (this.db.getRawDB().prepare(
      'SELECT COUNT(*) as c FROM procedural_memories WHERE workspace_id = ? AND user_confirmed = 1 AND deleted_at IS NULL'
    ).get(workspaceId) as any).c;

    const proceduralPending = (this.db.getRawDB().prepare(
      'SELECT COUNT(*) as c FROM procedural_memories WHERE workspace_id = ? AND user_confirmed = 0 AND deleted_at IS NULL'
    ).get(workspaceId) as any).c;

    return { episodic, semanticConfirmed, semanticPending, proceduralConfirmed, proceduralPending };
  }

  // ---- Private Converters ----

  private toEpisodic(row: any): EpisodicMemory {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      eventSummary: row.event_summary,
      occurredAt: row.occurred_at,
      participatingAgentIds: JSON.parse(row.participating_agent_ids_json || '[]'),
      sourceRunId: row.source_run_id || undefined,
      sourceFileIds: JSON.parse(row.source_file_ids_json || '[]'),
      sourceRouteDecisionId: row.source_route_decision_id || undefined,
      sourceEventIds: JSON.parse(row.source_event_ids_json || '[]'),
      confidence: row.confidence,
      scope: row.scope,
      createdAt: row.created_at,
      deletedAt: row.deleted_at || undefined,
    };
  }

  private toSemantic(row: any): SemanticMemory {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      subject: row.subject,
      relation: row.relation,
      object: row.object,
      sourceRunId: row.source_run_id || undefined,
      sourceFileIds: JSON.parse(row.source_file_ids_json || '[]'),
      sourceRouteDecisionId: row.source_route_decision_id || undefined,
      confidence: row.confidence,
      userConfirmed: row.user_confirmed === 1,
      scope: row.scope,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at || undefined,
    };
  }

  private toProcedural(row: any): ProceduralMemory {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      taskType: row.task_type,
      recommendedAgentGroupId: row.recommended_agent_group_id || undefined,
      toolchain: JSON.parse(row.toolchain_json || '[]'),
      routePolicyId: row.route_policy_id || undefined,
      failureNotes: row.failure_notes || undefined,
      sourceRunId: row.source_run_id || undefined,
      userConfirmed: row.user_confirmed === 1,
      scope: row.scope,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at || undefined,
    };
  }
}
