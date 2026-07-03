import { AuditService } from './audit-service';
import { DatabaseService } from './database-service';
import { WorkspaceService } from './workspace-service';
import { DataClassification } from '../shared/types';

export interface DataSafetySummary {
  totalAssets: number;
  byClassification: Record<string, number>;
  knowledgeBases: Array<{
    id: string;
    name: string;
    classification: DataClassification;
    fileCount: number;
    indexedStatus: string;
  }>;
  recentAccess: Array<{
    documentId: string;
    fileName: string;
    classification: DataClassification;
    accessedAt: string;
    runId: string;
  }>;
  recentCloudCalls: number;
  zeroCloudCallRuns: number;
  limitationNote: string;
  memoryStats: {
    episodic: number;
    semantic: number;
    procedural: number;
    total: number;
  };
  agentGroupStats: {
    total: number;
    pipeline: number;
    completed: number;
  };
}

/**
 * Data Safety Center service — queries real DB data.
 */
export class DataSafetyService {
  constructor(
    private auditService: AuditService,
    private workspaceService: WorkspaceService,
    private db: DatabaseService,
  ) {}

  async getSummary(workspaceId: string): Promise<DataSafetySummary> {
    const workspace = await this.workspaceService.get(workspaceId);
    const allEvents = await this.auditService.getAllEvents();

    // Cloud call stats from audit events
    const cloudCallEvents = allEvents.filter(e =>
      e.eventType.includes('model_call') && (e.eventPayload as any)?.isCloud === true,
    );
    const cloudCallRuns = [...new Set(cloudCallEvents.map(e => e.runId))] as string[];
    const allRunIds = [...new Set(allEvents.map(e => e.runId))] as string[];
    const zeroCloudCallRuns = allRunIds.filter(rid =>
      !cloudCallEvents.some(e => e.runId === rid)
    ).length;

    // Knowledge bases from DB
    const kbRows = this.db.getRawDB().prepare(
      'SELECT id, name, classification, indexing_status FROM knowledge_bases WHERE workspace_id = ?'
    ).all(workspaceId) as any[];

    const knowledgeBases = kbRows.map(kb => {
      const fileCount = (this.db.getRawDB().prepare(
        'SELECT COUNT(*) as c FROM documents WHERE knowledge_base_id = ?'
      ).get(kb.id) as any).c;
      return {
        id: kb.id,
        name: kb.name,
        classification: kb.classification as DataClassification,
        fileCount,
        indexedStatus: kb.indexing_status,
      };
    });

    // Asset counts by classification from DB
    const docCounts = this.db.getRawDB().prepare(
      'SELECT classification, COUNT(*) as c FROM documents WHERE workspace_id = ? GROUP BY classification'
    ).all(workspaceId) as any[];

    const byClassification: Record<string, number> = {
      [DataClassification.Public]: 0,
      [DataClassification.Internal]: 0,
      [DataClassification.Confidential]: 0,
      [DataClassification.Restricted]: 0,
    };
    let totalAssets = 0;
    for (const row of docCounts) {
      byClassification[row.classification] = row.c;
      totalAssets += row.c;
    }

    // Recent access from document_access_events
    const accessRows = this.db.getRawDB().prepare(`
      SELECT dae.document_id, d.file_name, d.classification, dae.created_at, dae.run_id
      FROM document_access_events dae
      JOIN documents d ON dae.document_id = d.id
      WHERE dae.workspace_id = ?
      ORDER BY dae.created_at DESC LIMIT 10
    `).all(workspaceId) as any[];

    const recentAccess = accessRows.map(r => ({
      documentId: r.document_id,
      fileName: r.file_name,
      classification: r.classification as DataClassification,
      accessedAt: r.created_at,
      runId: r.run_id,
    }));

    // Memory stats from DB
    const episodic = (this.db.getRawDB().prepare(
      "SELECT COUNT(*) as c FROM episodic_memories WHERE workspace_id = ? AND deleted_at IS NULL"
    ).get(workspaceId) as any).c;
    const semantic = (this.db.getRawDB().prepare(
      "SELECT COUNT(*) as c FROM semantic_memories WHERE workspace_id = ? AND user_confirmed = 1 AND deleted_at IS NULL"
    ).get(workspaceId) as any).c;
    const procedural = (this.db.getRawDB().prepare(
      "SELECT COUNT(*) as c FROM procedural_memories WHERE workspace_id = ? AND user_confirmed = 1 AND deleted_at IS NULL"
    ).get(workspaceId) as any).c;

    // Agent group stats from DB
    const agentGroupTotal = (this.db.getRawDB().prepare(
      'SELECT COUNT(*) as c FROM agent_groups WHERE workspace_id = ?'
    ).get(workspaceId) as any).c;
    const pipelineCount = (this.db.getRawDB().prepare(
      "SELECT COUNT(*) as c FROM agent_groups WHERE workspace_id = ? AND mode = 'pipeline'"
    ).get(workspaceId) as any).c;
    const completedCount = (this.db.getRawDB().prepare(
      "SELECT COUNT(*) as c FROM agent_group_runs WHERE workspace_id = ? AND status = 'completed'"
    ).get(workspaceId) as any).c;

    return {
      totalAssets,
      byClassification,
      knowledgeBases,
      recentAccess,
      recentCloudCalls: cloudCallEvents.length,
      zeroCloudCallRuns,
      limitationNote: 'Ogra can prove calls made through Ogra-controlled adapters. This does not cover manual copy/paste, screenshots, tools launched outside Ogra, provider-side retention after approved calls, or other local processes.',
      memoryStats: { episodic, semantic, procedural, total: episodic + semantic + procedural },
      agentGroupStats: { total: agentGroupTotal, pipeline: pipelineCount, completed: completedCount },
    };
  }

  async getCloudCalls(workspaceId: string): Promise<{
    total: number;
    runs: Array<{ runId: string; providerId?: string; modelId?: string; timestamp: string }>;
    recentAccess: Array<{
      documentId: string;
      fileName: string;
      accessType: string;
      accessedAt: string;
      runId: string;
    }>;
  }> {
    const allEvents = await this.auditService.getAllEvents();
    const cloudCalls = allEvents
      .filter(e => e.eventType.includes('model_call') && (e.eventPayload as any)?.isCloud === true);

    // Recent document access events
    const accessRows = this.db.getRawDB().prepare(`
      SELECT dae.document_id, d.file_name, dae.access_type, dae.created_at, dae.run_id
      FROM document_access_events dae
      LEFT JOIN documents d ON dae.document_id = d.id
      WHERE dae.workspace_id = ?
      ORDER BY dae.created_at DESC LIMIT 10
    `).all(workspaceId) as any[];

    const recentAccess = accessRows.map(r => ({
      documentId: r.document_id,
      fileName: r.file_name || 'unknown',
      accessType: r.access_type,
      accessedAt: r.created_at,
      runId: r.run_id,
    }));

    return {
      total: cloudCalls.length,
      runs: cloudCalls.map(e => ({
        runId: e.runId,
        providerId: (e.eventPayload as any)?.providerId as string,
        modelId: (e.eventPayload as any)?.modelId as string,
        timestamp: e.createdAt,
      })),
      recentAccess,
    };
  }
}
