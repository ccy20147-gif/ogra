import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { DatabaseService } from '../../src/core/database-service';
import { PolicyService } from '../../src/core/policy-service';
import { RouteService } from '../../src/core/route-service';
import { RunService } from '../../src/core/run-service';
import { RagEngine } from '../../src/edge/rag-engine';
import { InternalAgentAdapter } from '../../src/edge/internal-agent-adapter';
import { DataClassification, WorkspaceType } from '../../src/shared/types';
import { BaseModelAdapter, ModelRequest, ModelResult, ModelCapabilities, ProviderHealth } from '../../src/core/model-adapter';

/**
 * Mock model adapter that doesn't require a real Ollama instance.
 */
class MockModelAdapter extends BaseModelAdapter {
  readonly id = 'mock_adapter';
  readonly providerId = 'mock_provider';
  readonly isLocal: boolean;
  readonly capabilities: ModelCapabilities = { streaming: false, toolCalling: false, fileUpload: false };

  constructor(isLocal: boolean) {
    super();
    this.isLocal = isLocal;
  }

  async generate(request: ModelRequest): Promise<ModelResult> {
    this.validatePolicyGate(request);
    const id = `mock_call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return {
      id,
      content: 'This is a mock response about the project budget of $500K.',
      finishReason: 'stop',
      tokenUsage: { prompt: 50, completion: 20, total: 70 },
      modelId: request.allowedModelId,
      providerId: this.providerId,
      responseHash: 'mock_hash',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
  }

  async testConnection(): Promise<ProviderHealth> {
    return { ok: true, message: 'Mock OK' };
  }
}

describe('InternalAgentAdapter', () => {
  const testDir = path.join(os.tmpdir(), `ogra-agent-test-${Date.now()}`);
  let db: DatabaseService;
  let policyService: PolicyService;
  let routeService: RouteService;
  let runService: RunService;
  let ragEngine: RagEngine;
  let agent: InternalAgentAdapter;
  let wsId: string;

  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });
    db = new DatabaseService(testDir);
    policyService = new PolicyService({ appendEvent: () => {} } as any);
    routeService = new RouteService(policyService);
    runService = new RunService(
      { getCurrentId: () => wsId, get: async (id: string) => ({ id, defaultClassification: DataClassification.Internal }) } as any,
      routeService,
      { appendEvent: async () => ({ id: 'evt_test', previousHash: '0', eventHash: 'hash' }) } as any,
      policyService,
      { appDataDir: testDir } as any,
    );
    ragEngine = new RagEngine(db);
    agent = new InternalAgentAdapter(db, policyService, routeService, runService, ragEngine);

    // Create workspace for tests
    const ws = db.createWorkspace('Agent Test', WorkspaceType.Project, DataClassification.Public);
    wsId = ws.id;

    // Create test docs
    const docsDir = path.join(testDir, 'agent-docs');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'info.md'), '# Project Info\n\nThe project budget is $500K for Q2.\nKey deliverables include API integration and dashboard.');

    // Index docs
    db.createKnowledgeBase({
      id: 'kb_agent_test',
      workspaceId: ws.id,
      name: 'Agent KB',
      rootPath: docsDir,
      classification: DataClassification.Public,
    });
    ragEngine.indexFolder(ws.id, 'kb_agent_test', docsDir, DataClassification.Public);
  });

  afterAll(() => {
    db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should run a complete agent cycle with local model', async () => {
    const mockAdapter = new MockModelAdapter(true);
    const result = await agent.run(
      'What is the project budget?',
      wsId,
      ['kb_agent_test'],
      mockAdapter,
      'mock_model',
      DataClassification.Public,
    );
    expect(result.routeDecision).toBeDefined();
    expect(result.citations).toBeDefined();
    expect(result.answer).toContain('mock response');
  });

  it('should route Confidential data to local model', async () => {
    const mockAdapter = new MockModelAdapter(true);
    const result = await agent.run(
      'Test confidential query',
      wsId,
      ['kb_agent_test'],
      mockAdapter,
      'mock_model',
      DataClassification.Confidential,
    );
    expect(result.routeDecision.route).toBe('local');
    expect(result.routeDecision.reasons.some((r: string) => r.toLowerCase().includes('confidential'))).toBe(true);
  });

  it('should produce citations when sources are available', async () => {
    const mockAdapter = new MockModelAdapter(true);
    const result = await agent.run(
      'Tell me about the project budget',
      wsId,
      ['kb_agent_test'],
      mockAdapter,
      'mock_model',
      DataClassification.Public,
    );
    expect(result.citations.length).toBeGreaterThanOrEqual(1);
    expect(result.citations[0].file).toBeTruthy();
    expect(result.citations[0].classification).toBeTruthy();
  });

  it('should record audit events for each step', async () => {
    const mockAdapter = new MockModelAdapter(true);
    const result = await agent.run(
      'Test audit trail',
      wsId,
      ['kb_agent_test'],
      mockAdapter,
      'mock_model',
      DataClassification.Public,
    );
    const events = db.getRunEvents(result.routeDecision.runId, 100);
    const eventTypes = events.map(e => e.event_type);
    expect(eventTypes).toContain('run_created');
    expect(eventTypes).toContain('route_decision');
    expect(eventTypes).toContain('audit_complete');
  });

  it('should block Confidential data from cloud adapter', async () => {
    const cloudAdapter = new MockModelAdapter(false); // isLocal = false (cloud)
    const result = await agent.run(
      'Test confidential on cloud',
      wsId,
      ['kb_agent_test'],
      cloudAdapter,
      'mock_model',
      DataClassification.Confidential,
    );
    expect(result.routeDecision.route).toBe('blocked');
    expect(result.answer).toContain('blocked');
  });
});
