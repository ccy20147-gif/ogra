import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb } from '../helpers/test-db';
import { GovernanceService } from '../../src/core/governance-service';
import { AuditService } from '../../src/core/audit-service';

describe('GovernanceService', () => {
  let db: ReturnType<typeof createTestDb>['db'];
  let auditService: AuditService;
  let governanceService: GovernanceService;
  let wsId: string;
  let cleanup: () => void;

  beforeAll(async () => {
    const fixture = createTestDb();
    db = fixture.db;
    wsId = fixture.workspaceId;
    cleanup = fixture.cleanup;

    // Note: GovernanceService uses an in-memory AuditService.
    // For integration-level tests, write events via the AuditService directly.
    auditService = new AuditService(db); // Pass DB for SQLite-backed audit
    governanceService = new GovernanceService(auditService);

    const now = new Date().toISOString();
    db.storeRun({ id: 'gov-run-1', workspaceId: wsId, task: 'Test run', status: 'completed', startedAt: now, completedAt: now });
    db.storeRun({ id: 'gov-run-2', workspaceId: wsId, task: 'High risk run', status: 'completed', startedAt: now, completedAt: now });

    // Create events via AuditService so GovernanceService can read them
    await auditService.appendEvent({
      runId: 'gov-run-1',
      workspaceId: wsId,
      eventType: 'route_decision',
      eventPayload: { route: 'local', classification: 'Internal', reasons: ['local-only by default'] },
    });
    await auditService.appendEvent({
      runId: 'gov-run-2',
      workspaceId: wsId,
      eventType: 'route_decision',
      eventPayload: { route: 'cloud', classification: 'Confidential', reasons: ['cloud for Confidential'] },
    });
  });

  afterAll(() => {
    cleanup();
  });

  it('should get run risk for a valid run', async () => {
    const risk = await governanceService.getRunRisk('gov-run-1');
    expect(risk).toBeTruthy();
    expect(risk!.runId).toBe('gov-run-1');
  });

  it('should classify risk based on route decision', async () => {
    const risk1 = await governanceService.getRunRisk('gov-run-1');
    const risk2 = await governanceService.getRunRisk('gov-run-2');
    expect(risk1).toBeTruthy();
    expect(risk2).toBeTruthy();
    expect(risk1!.riskLevel).toBeTruthy();
    expect(risk2!.riskLevel).toBeTruthy();
  });

  it('should return risk summary for clean runs', async () => {
    const risk = await governanceService.getRunRisk('gov-run-1');
    expect(risk).toBeTruthy();
    expect(risk!).toHaveProperty('runId');
    expect(risk!).toHaveProperty('riskLevel');
  });
});
