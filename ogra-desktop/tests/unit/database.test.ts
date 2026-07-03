import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseService } from '../../src/core/database-service';
import { DataClassification, WorkspaceType } from '../../src/shared/types';
import { createTestDb } from '../helpers/test-db';

describe('DatabaseService', () => {
  let fixture: ReturnType<typeof createTestDb>;
  let db: DatabaseService;
  let wsId: string;

  beforeAll(() => {
    fixture = createTestDb();
    db = fixture.db;
    wsId = fixture.workspaceId;
  });

  afterAll(() => {
    fixture.cleanup();
  });

  it('should create and retrieve a workspace', () => {
    const workspaces = db.listWorkspaces();
    expect(workspaces.length).toBeGreaterThanOrEqual(1);
    expect(workspaces[0].name).toBe('Test Workspace');
  });

  describe('Run Event Hash Chain', () => {
    const runId = 'hash_test_run';

    beforeAll(() => {
      const now = new Date().toISOString();
      db.storeRun({ id: runId, workspaceId: wsId, task: 'Hash test', status: 'created', startedAt: now });
    });

    it('should append events with hash chain', () => {
      for (let i = 1; i <= 3; i++) {
        db.appendRunEvent(runId, wsId, 'test_event', { step: i });
      }
      const events = db.getRunEvents(runId);
      expect(events).toHaveLength(3);
      expect(events[0].previous_hash).toBe('0000000000000000000000000000000000000000000000000000000000000000');
      expect(events[0].event_hash).toBeTruthy();
      expect(events[1].previous_hash).toBe(events[0].event_hash);
    });

    it('should retrieve events in order', () => {
      const events = db.getRunEvents(runId);
      expect(events.length).toBeGreaterThanOrEqual(3);
      for (let i = 0; i < events.length; i++) {
        expect(events[i].sequence).toBe(i + 1);
      }
    });

    it('should verify chain integrity', () => {
      const result = db.verifyRunChain(runId);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });
});
