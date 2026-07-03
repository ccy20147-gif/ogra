import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseService } from '../../src/core/database-service';
import { MemoryService } from '../../src/core/memory-service';
import { DataClassification, WorkspaceType } from '../../src/shared/types';
import { createTestDb } from '../helpers/test-db';

describe('M3 MemoryService', () => {
  let fixture: ReturnType<typeof createTestDb>;
  let db: DatabaseService;
  let memory: MemoryService;
  let wsId: string;

  beforeAll(() => {
    fixture = createTestDb();
    db = fixture.db;
    wsId = fixture.workspaceId;
    memory = new MemoryService(db);
  });

  afterAll(() => {
    fixture.cleanup();
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
