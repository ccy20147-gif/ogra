import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { DatabaseService } from '../../src/core/database-service';
import { DataClassification, WorkspaceType } from '../../src/shared/types';

export interface TestDbFixture {
  db: DatabaseService;
  workspaceId: string;
  runId: string;
  testDir: string;
}

/**
 * Creates a temporary DatabaseService with a workspace and test agent run.
 * Caller MUST invoke cleanup() when done to remove temp files.
 */
export function createTestDb(): TestDbFixture & { cleanup: () => void } {
  const testDir = path.join(os.tmpdir(), `ogra-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(testDir, { recursive: true });
  const db = new DatabaseService(testDir);

  const now = new Date().toISOString();
  const ws = db.createWorkspace('Test Workspace', WorkspaceType.Personal, DataClassification.Internal);
  const runId = `test-run-${Date.now()}`;
  db.storeRun({ id: runId, workspaceId: ws.id, task: 'Test run', status: 'completed', startedAt: now, completedAt: now });

  return {
    db,
    workspaceId: ws.id,
    runId,
    testDir,
    cleanup: () => {
      db.close();
      try {
        fs.rmSync(testDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    },
  };
}
