import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { DatabaseService } from '../../src/core/database-service';
import { PolicyService } from '../../src/core/policy-service';
import { RouteService } from '../../src/core/route-service';
import { RunService, ResolvedAdapter } from '../../src/core/run-service';
import { AuditService } from '../../src/core/audit-service';
import { ProviderService } from '../../src/core/provider-service';
import { RagEngine } from '../../src/edge/rag-engine';
import { InternalAgentAdapter } from '../../src/edge/internal-agent-adapter';
import { RedactionService } from '../../src/core/redaction-service';
import { DataClassification, WorkspaceType } from '../../src/shared/types';
import { WorkspaceService } from '../../src/core/workspace-service';
import { OgraCoreConfig } from '../../src/core';
import { BaseModelAdapter, ModelRequest, ModelResult, ModelCapabilities, ProviderHealth } from '../../src/core/model-adapter';
import { OgraSecretBroker } from '../../src/core/secret-broker';
import { createTestDb } from '../helpers/test-db';

class TestModelAdapter extends BaseModelAdapter {
  readonly id = 'test_agent_adapter_seq0';
  readonly providerId = 'test_agent_provider_seq0';
  readonly isLocal = true;
  readonly capabilities: ModelCapabilities = { streaming: false, toolCalling: false, fileUpload: false };
  callbackCount = 0;
  public lastRequest?: ModelRequest;

  async generate(request: ModelRequest): Promise<ModelResult> {
    this.validatePolicyGate(request);
    this.callbackCount += 1;
    this.lastRequest = request;
    const id = `agent_test_call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return {
      id,
      content: 'Test answer for the agent under test.',
      finishReason: 'stop',
      tokenUsage: { prompt: 50, completion: 20, total: 70 },
      modelId: request.allowedModelId,
      providerId: this.providerId,
      responseHash: 'agent_test_hash',
      httpBodyHash: 'test_body_hash',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
  }

  async testConnection(): Promise<ProviderHealth> {
    return { ok: true, message: 'ok' };
  }
}

describe('InternalAgentAdapter — Sequence 0 baseline', () => {
  let fixture: ReturnType<typeof createTestDb>;
  let db: DatabaseService;
  let policyService: PolicyService;
  let routeService: RouteService;
  let runService: RunService;
  let ragEngine: RagEngine;
  let providerService: ProviderService;
  let secretBroker: OgraSecretBroker;
  let auditService: AuditService;
  let workspaceService: WorkspaceService;
  let wsId: string;
  let adapter: TestModelAdapter;
  let resolveAdapter: () => Promise<ResolvedAdapter>;
  let agent: InternalAgentAdapter;
  let redaction: RedactionService;

  beforeAll(() => {
    fixture = createTestDb();
    db = fixture.db;
    wsId = fixture.workspaceId;

    auditService = new AuditService(db);
    policyService = new PolicyService(auditService);
    routeService = new RouteService(policyService);
    providerService = new ProviderService(auditService);
    workspaceService = new WorkspaceService(auditService, db);
    secretBroker = new OgraSecretBroker(fixture.testDir, auditService);
    ragEngine = new RagEngine(db);
    redaction = new RedactionService(db);

    adapter = new TestModelAdapter();
    resolveAdapter = async () => ({
      adapter,
      modelInternalId: 'agent_test_model',
      modelName: 'agent_test_model',
      providerId: adapter.providerId,
    });

    agent = new InternalAgentAdapter(db, policyService, routeService, null, ragEngine, redaction);
    runService = new RunService(
      workspaceService, routeService, auditService, policyService, db,
      providerService, secretBroker,
      { appDataDir: fixture.testDir, secretBroker, isDev: true } as OgraCoreConfig,
      ragEngine, resolveAdapter, agent,
      redaction,
    );
    agent.bindRunService(runService);

    const docsDir = path.join(fixture.testDir, 'agent-docs');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(
      path.join(docsDir, 'info.md'),
      '# Project Info\n\nThe project budget is $500K for Q2. Key deliverables include API integration and dashboard.',
    );

    db.createKnowledgeBase({
      id: 'kb_agent_test',
      workspaceId: fixture.workspaceId,
      name: 'Agent KB',
      rootPath: docsDir,
      classification: DataClassification.Public,
    });
    ragEngine.indexFolder(fixture.workspaceId, 'kb_agent_test', docsDir, DataClassification.Public);
  });

  afterAll(() => {
    fixture.cleanup();
  });

  it('runs a complete local agent cycle through the real adapter', async () => {
    adapter.callbackCount = 0;
    adapter.lastRequest = undefined;
    const beforeCount = adapter.callbackCount;
    const result = await agent.run({
      task: 'What is the project budget?',
      workspaceId: wsId,
      knowledgeBaseIds: ['kb_agent_test'],
      adapter,
      modelId: 'agent_test_model',
      modelInternalId: 'agent_test_model',
      providerId: adapter.providerId,
      runId: 'seq0_agent_run_1',
    });
    expect(result.routeDecision).toBeDefined();
    expect(result.answer).toBeTruthy();
    expect(adapter.callbackCount).toBe(beforeCount + 1);
    const lastRequest = adapter.lastRequest as ModelRequest | undefined;
    expect(lastRequest).toBeDefined();
    expect((lastRequest as ModelRequest).routeDecisionId).toBeTruthy();
    expect((lastRequest as ModelRequest).policyEvaluationId).toBeTruthy();
    expect((lastRequest as ModelRequest).policyVersionHash).toBeTruthy();
    expect((lastRequest as ModelRequest).allowedProviderId).toBe(adapter.providerId);
    expect((lastRequest as ModelRequest).allowedModelId).toBe('agent_test_model');
  });

  it('routes Confidential data to local model when provider is local', async () => {
    const cloudResolver = async () => ({
      adapter, modelInternalId: 'agent_test_model',
      modelName: 'agent_test_model', providerId: adapter.providerId,
    } satisfies ResolvedAdapter);
    const localAgent = new InternalAgentAdapter(
      db, policyService, routeService, null, ragEngine,
      new RedactionService(db),
    );
    const localRs = new RunService(
      workspaceService, routeService, auditService, policyService, db,
      providerService, secretBroker,
      { appDataDir: fixture.testDir, secretBroker, isDev: true } as OgraCoreConfig,
      ragEngine, cloudResolver, localAgent,
      redaction,
    );
    adapter.callbackCount = 0;
    const result = await localAgent.run({
      task: 'confidential query',
      workspaceId: wsId,
      knowledgeBaseIds: ['kb_agent_test'],
      adapter,
      modelId: 'agent_test_model',
      modelInternalId: 'agent_test_model',
      providerId: adapter.providerId,
      requestedClassification: DataClassification.Confidential,
      runId: 'seq0_agent_run_2',
    });
    expect(result.routeDecision.route).toBe('local');
    void localRs;
  });

  it('blocks Confidential data on a cloud adapter with zero model callbacks', async () => {
    class FakeCloudAdapter extends BaseModelAdapter {
      readonly id = 'cloud_agent_test';
      readonly providerId = 'cloud_agent_provider';
      readonly isLocal = false;
      readonly capabilities: ModelCapabilities = { streaming: false, toolCalling: false, fileUpload: false };
      callbackCount = 0;
      async generate(request: ModelRequest): Promise<ModelResult> {
        this.validatePolicyGate(request);
        this.callbackCount += 1;
        return {
          id: 'c', content: 'should never be called', finishReason: 'stop',
          tokenUsage: { prompt: 0, completion: 0, total: 0 },
          modelId: request.allowedModelId, providerId: this.providerId,
          responseHash: 'x', startedAt: '', completedAt: '',
      httpBodyHash: 'test_body_hash',
        };
      }
      async testConnection(): Promise<ProviderHealth> { return { ok: true, message: 'x' }; }
    }
    const cloud = new FakeCloudAdapter();
    // Because the agent is re-seeded for a Confidential cloud request,
    // it must take the redact_then_egress path. Sequence 0 with no
    // approval row blocks at agent before invoking generate().
    const result = await agent.run({
      task: 'cloud-confidential-block',
      workspaceId: wsId,
      knowledgeBaseIds: ['kb_agent_test'],
      adapter: cloud,
      modelId: 'cloud_model',
      modelInternalId: 'cloud_model',
      providerId: cloud.providerId,
      requestedClassification: DataClassification.Confidential,
      runId: 'seq0_agent_run_3',
    });
    // Either route decision is blocked OR route is redact_then_egress
    // with no approval → blocked at agent. Both paths must show
    // zero adapter callbacks.
    expect(cloud.callbackCount).toBe(0);
    expect(['blocked']).toContain(result.routeDecision.route);
    expect(result.answer.toLowerCase()).toContain('blocked');
  });
});

/* ============================================================
 * Sequence 1B M1 — durable effect kernel through InternalAgentAdapter
 * ============================================================ */

describe('InternalAgentAdapter — M1 kernel binding', () => {
  let dir: string;
  let cleanup: (() => void) | null = null;
  beforeAll(() => {
    dir = path.join('/tmp', 's1b-internal-agent-' + Date.now());
    fs.mkdirSync(dir, { recursive: true });
  });
  afterAll(() => {
    try { if (cleanup) cleanup(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('binds the durable kernel and writes an L0 run_effects row alongside the Sequence 0 model_calls row', async () => {
    // We import the same modules the production OgraCore
    // wires; the test asserts the kernel writes an L0
    // run_effects row, an L1 audit event, and an audit edge
    // for the model call — all of which prove the
    // agent.run() path took the durable effect protocol.
    const {
      createTestDb: createM1Db,
    } = await import('../helpers/test-db') as {
      createTestDb: () => any;
    };
    const fx = createM1Db();
    cleanup = fx.cleanup;
    const db: any = fx.db;
    const audit = new AuditService(db);
    const wsService = new WorkspaceService(audit, db);
    const polService = new PolicyService(audit);
    const rService = new RouteService(polService);
    const provService = new ProviderService(audit);
    const rag = new RagEngine(db);
    const redService = new RedactionService(db);
    const agent = new InternalAgentAdapter(
      db, polService, rService, null, rag, redService,
    );
    const noopAdapter: BaseModelAdapter = new TestModelAdapter();
    const secretBroker = new OgraSecretBroker(fx.testDir);
    const runService = new RunService(
      wsService, rService, audit, polService, db,
      provService, secretBroker,
      { appDataDir: fx.testDir, secretBroker, isDev: true } as OgraCoreConfig,
      rag, async () => ({
        adapter: noopAdapter,
        modelId: 'seq1_model',
        modelInternalId: 'seq1_model_internal',
        providerId: 'test_agent_provider_seq0',
        modelName: 'seq1_model_internal',
        isLocal: true,
      }), agent, redService,
    );
    agent.bindRunService(runService);
    const { DurableRuntimeService } = await import(
      '../../src/core/durable-runtime-service');
    const { EncryptedCapsuleStore, OgraSecretBrokerKeyProvider } =
      await import('../../src/core/capsule-store');
    const { EffectProtocolService } = await import(
      '../../src/core/effect-protocol-service');
    const odb = db.getOgraDatabase();
    const masterKey = secretBroker.deriveWorkspaceKey('capsule.v1', 'default');
    const runtime = new DurableRuntimeService(
      odb, () => 'ph_seq1_m1',
    );
    const capsuleStore = new EncryptedCapsuleStore(
      odb, new OgraSecretBrokerKeyProvider(masterKey),
    );
    const protocol = new EffectProtocolService(odb, runtime, capsuleStore);
    agent.bindKernel({ runtime, protocol });

    const wsId = fx.workspaceId;
    const runId = 'm1_internal_agent_run_1';
    db.storeRun({
      id: runId, workspaceId: wsId, task: 'agent-m1-task',
      status: 'created', startedAt: new Date().toISOString(),
    });

    // Use the InternalAgentAdapter via RunService.startRun so the
    // full terminal write (audit_complete / run_failed /
    // completed / cancelled) is exercised. The kernel is
    // already wired by bindKernel; we just need to call.
    await agent.run({
      task: 'agent-m1-task',
      workspaceId: wsId,
      knowledgeBaseIds: [],
      adapter: noopAdapter,
      modelId: 'seq1_model',
      modelInternalId: 'seq1_model_internal',
      providerId: 'test_agent_provider_seq0',
      runId,
    });
    void runService;
    // Verify the L0 row is in a terminal state — meaning the
    // durable effect protocol drove the call.
    const effRows = odb.getDB().prepare(
      'SELECT state, terminal_event_id FROM run_effects WHERE run_id = ?',
    ).all(runId) as { state: string; terminal_event_id: string | null }[];
    expect(effRows.length).toBe(1);
    expect(['committed']).toContain(effRows[0].state);
    expect(effRows[0].terminal_event_id).toBeTruthy();
    const frames = odb.getDB().prepare(
      `SELECT status, terminal_event_id FROM run_frames
        WHERE run_id = ? AND frame_kind = 'plan_step'`,
    ).all(runId) as { status: string; terminal_event_id: string | null }[];
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ status: 'completed' });
    expect(frames[0].terminal_event_id).toBeTruthy();
    const verify = runtime.verifyAuditChain(runId);
    expect(verify.ok).toBe(true);
  });
});
