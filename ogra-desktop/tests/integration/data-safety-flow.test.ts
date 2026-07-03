import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb } from '../helpers/test-db';
import { DataSafetyService } from '../../src/core/data-safety-service';
import { AuditService } from '../../src/core/audit-service';
import { WorkspaceService } from '../../src/core/workspace-service';

describe('DataSafety integration', () => {
  let fixture: ReturnType<typeof createTestDb>;
  let dataSafety: DataSafetyService;

  beforeAll(async () => {
    fixture = createTestDb();
    const auditService = new AuditService(fixture.db);
    const workspaceService = new WorkspaceService(auditService, fixture.db);
    dataSafety = new DataSafetyService(auditService, workspaceService, fixture.db);

    // Write test events
    await auditService.appendEvent({
      runId: fixture.runId,
      workspaceId: fixture.workspaceId,
      eventType: 'model_call',
      eventPayload: { isCloud: true, providerId: 'ollama', modelId: 'qwen2.5' },
    });
  });

  afterAll(() => {
    fixture.cleanup();
  });

  it('should return summary with real data', async () => {
    const summary = await dataSafety.getSummary(fixture.workspaceId);
    expect(summary).toBeTruthy();
    expect(summary.totalAssets).toBeGreaterThanOrEqual(0);
    expect(typeof summary.recentCloudCalls).toBe('number');
    expect(summary.limitationNote).toBeTruthy();
  });

  it('should detect cloud calls', async () => {
    const cloud = await dataSafety.getCloudCalls(fixture.workspaceId);
    expect(cloud).toBeTruthy();
    expect(cloud.total).toBeGreaterThanOrEqual(1);
  });

  it('should return memory stats from DB', async () => {
    const summary = await dataSafety.getSummary(fixture.workspaceId);
    expect(summary.memoryStats).toBeDefined();
    expect(typeof summary.memoryStats.total).toBe('number');
  });
});
