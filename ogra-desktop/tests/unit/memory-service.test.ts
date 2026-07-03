import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { DatabaseService } from '../../src/core/database-service';
import { MemoryService } from '../../src/core/memory-service';
import { DataClassification, WorkspaceType } from '../../src/shared/types';

describe('M3 MemoryService', () => {
  const testDir = path.join(os.tmpdir(), `ogra-m3-test-${Date.now()}`);
  let db: DatabaseService;
  let memory: MemoryService;
  let wsId: string;

  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });
    db = new DatabaseService(testDir);
    memory = new MemoryService(db);
    const ws = db.createWorkspace('Memory Test', WorkspaceType.Personal, DataClassification.Internal);
    wsId = ws.id;
  });

  afterAll(() => {
    db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should auto-write episodic memory', async () => {
    const mem = await memory.writeEpisodic({
      workspaceId: wsId,
      eventSummary: 'Analyzed Q2 financial report with InternalAgent',
      participatingAgentIds: ['internal_agent'],
      sourceRunId: 'run_123',
      sourceFileIds: ['doc_finance_q2'],
      sourceRouteDecisionId: 'rd_123',
      sourceEventIds: ['evt_1', 'evt_2'],
    });
    expect(mem.id).toBeTruthy();
    expect(mem.eventSummary).toContain('Analyzed Q2');
    expect(mem.participatingAgentIds).toContain('internal_agent');
  });

  it('should list episodic memories', () => {
    const list = memory.listEpisodic(wsId);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0].eventSummary).toContain('Analyzed Q2');
  });

  it('should propose semantic memory without auto-confirming', async () => {
    const mem = await memory.proposeSemantic({
      workspaceId: wsId,
      subject: 'Q2 Financial Report',
      relation: 'contains_anomaly',
      object: 'Vendor XYZ Corp overpayment',
      sourceRunId: 'run_123',
      sourceFileIds: ['doc_q2_anomalies'],
    });
    expect(mem.userConfirmed).toBe(false);
    expect(mem.confidence).toBeLessThan(1);
  });

  it('should confirm semantic memory', async () => {
    const list = await memory.listConfirmedSemantic(wsId);
    expect(list.length).toBe(0); // Not yet confirmed

    // Get the pending one
    const stats = memory.getMemoryStats(wsId);
    expect(stats.semanticPending).toBe(1);

    // We need the ID of the pending memory
    // Let's create a new one and confirm it
    const mem = await memory.proposeSemantic({
      workspaceId: wsId,
      subject: 'Test',
      relation: 'is',
      object: 'confirmed',
      sourceRunId: 'run_456',
      sourceFileIds: [],
    });
    await memory.confirmSemantic(mem.id);

    const confirmed = await memory.listConfirmedSemantic(wsId);
    expect(confirmed.length).toBeGreaterThanOrEqual(1);
    expect(confirmed[0].userConfirmed).toBe(true);
  });

  it('should propose procedural memory', async () => {
    const mem = await memory.proposeProcedural({
      workspaceId: wsId,
      taskType: 'financial_analysis',
      toolchain: ['rag_retrieve', 'ollama_generate'],
      routePolicyId: 'confidential-local-only',
      failureNotes: 'Ollama timeout on first attempt',
      sourceRunId: 'run_789',
    });
    expect(mem.userConfirmed).toBe(false);
    expect(mem.taskType).toBe('financial_analysis');
  });

  it('should confirm procedural memory', async () => {
    const mem = await memory.proposeProcedural({
      workspaceId: wsId,
      taskType: 'code_review',
      toolchain: ['rag_retrieve', 'ollama_generate'],
      sourceRunId: 'run_999',
    });
    await memory.confirmProcedural(mem.id);

    const stats = memory.getMemoryStats(wsId);
    expect(stats.proceduralConfirmed).toBeGreaterThanOrEqual(1);
  });

  it('should soft-delete memories (tombstone)', async () => {
    // Create a memory then delete it
    const mem = await memory.writeEpisodic({
      workspaceId: wsId,
      eventSummary: 'Temporary memory to delete',
      participatingAgentIds: ['test'],
      sourceFileIds: [],
      sourceEventIds: [],
    });

    await memory.deleteMemory('episodic', mem.id);

    // Should not appear in list
    const list = memory.listEpisodic(wsId);
    expect(list.some(m => m.id === mem.id)).toBe(false);
  });

  it('should report memory stats', () => {
    const stats = memory.getMemoryStats(wsId);
    expect(stats.episodic).toBeGreaterThanOrEqual(1);
    expect(stats.semanticPending).toBeGreaterThan(0);
    expect(stats.semanticConfirmed).toBeGreaterThanOrEqual(1);
    expect(stats.proceduralConfirmed).toBeGreaterThanOrEqual(1);
  });
});
