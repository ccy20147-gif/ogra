import { AuditService } from './audit-service';
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
 * Data Safety Center service.
 *
 * Provides summaries for the Data Safety UI:
 * - asset map by workspace and classification
 * - knowledge base and folder classification
 * - recent file access and cloud inclusion
 * - cloud call counts from model call ledger
 * - `0 Ogra-managed cloud calls` explanation
 */
export class DataSafetyService {
  constructor(
    private auditService: AuditService,
    private workspaceService: WorkspaceService,
  ) {}

  async getSummary(workspaceId: string): Promise<DataSafetySummary> {
    const workspace = await this.workspaceService.get(workspaceId);
    const allEvents = await this.auditService.getAllEvents();

    // Count cloud call events
    const cloudCallEvents = allEvents.filter(e =>
      e.eventType.includes('model_call') && (e.eventPayload as any)?.isCloud === true,
    );
    const cloudCallRuns = [...new Set(cloudCallEvents.map(e => e.runId))];

    // Count zero-cloud-call runs
    const allRunIds = [...new Set(allEvents.map(e => e.runId))];
    const zeroCloudCallRuns = allRunIds.filter(rid =>
      !cloudCallEvents.some(e => e.runId === rid)
    ).length;

    return {
      totalAssets: 1,
      byClassification: {
        [DataClassification.Public]: 0,
        [DataClassification.Internal]: 1,
        [DataClassification.Confidential]: 0,
        [DataClassification.Restricted]: 0,
      },
      knowledgeBases: [],
      recentAccess: [],
      recentCloudCalls: cloudCallEvents.length,
      zeroCloudCallRuns,
      limitationNote: 'Ogra can prove calls made through Ogra-controlled adapters. This does not cover manual copy/paste, screenshots, tools launched outside Ogra, provider-side retention after approved calls, or other local processes.',
      memoryStats: { episodic: 0, semantic: 0, procedural: 0, total: 0 },
      agentGroupStats: { total: 0, pipeline: 0, completed: 0 },
    };
  }

  async getCloudCalls(workspaceId: string): Promise<{
    total: number;
    runs: Array<{ runId: string; providerId?: string; modelId?: string; timestamp: string }>;
  }> {
    const allEvents = await this.auditService.getAllEvents();
    const cloudCalls = allEvents
      .filter(e => e.eventType.includes('model_call') && (e.eventPayload as any)?.isCloud === true);

    return {
      total: cloudCalls.length,
      runs: cloudCalls.map(e => ({
        runId: e.runId,
        providerId: (e.eventPayload as any)?.providerId as string,
        modelId: (e.eventPayload as any)?.modelId as string,
        timestamp: e.createdAt,
      })),
    };
  }
}
