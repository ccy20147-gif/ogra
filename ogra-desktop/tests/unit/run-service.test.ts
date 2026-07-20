import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { RunService, ResolvedAdapter, AdapterResolver } from '../../src/core/run-service';
import { DataClassification, RunStatus, WorkspaceType } from '../../src/shared/types';
import { AuditService } from '../../src/core/audit-service';
import { DatabaseService } from '../../src/core/database-service';
import { ProviderService } from '../../src/core/provider-service';
import { RouteService } from '../../src/core/route-service';
import { PolicyService } from '../../src/core/policy-service';
import { RagEngine } from '../../src/edge/rag-engine';
import { WorkspaceService } from '../../src/core/workspace-service';
import { InternalAgentAdapter } from '../../src/edge/internal-agent-adapter';
import { RedactionService } from '../../src/core/redaction-service';
import { OgraSecretBroker } from '../../src/core/secret-broker';
import { OgraCoreConfig } from '../../src/core';
import { BaseModelAdapter, ModelRequest, ModelResult, ModelCapabilities, ProviderHealth } from '../../src/core/model-adapter';
import { OgraError, OgraErrorCode } from '../../src/shared/errors';

class TestModelAdapter extends BaseModelAdapter {
  readonly id = 'run_service_test_adapter';
  readonly providerId = 'run_service_test_provider';
  readonly isLocal = true;
  readonly capabilities: ModelCapabilities = { streaming: false, toolCalling: false, fileUpload: false };
  callbackCount = 0;
  public failWith?: { code: OgraErrorCode; message: string };

  async generate(request: ModelRequest): Promise<ModelResult> {
    this.validatePolicyGate(request);
    this.callbackCount += 1;
    if (this.failWith) throw new OgraError(this.failWith.code, this.failWith.message);
    const id = `call_${this.callbackCount}_${Date.now()}`;
    return {
      id,
      content: 'test completion',
      finishReason: 'stop',
      tokenUsage: { prompt: 10, completion: 20, total: 30 },
      modelId: request.allowedModelId,
      providerId: this.providerId,
      responseHash: 'rh',
      httpBodyHash: 'test_body_hash',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
  }
  async testConnection(): Promise<ProviderHealth> { return { ok: true, message: 'ok' }; }
}

describe('RunService — Sequence 0 real run path', () => {
  let db: DatabaseService;
  let workspaceService: WorkspaceService;
  let policyService: PolicyService;
  let routeService: RouteService;
  let ragEngine: RagEngine;
  let providerService: ProviderService;
  let secretBroker: OgraSecretBroker;
  let auditService: AuditService;
  let adapter: TestModelAdapter;
  let resolveAdapter: AdapterResolver;
  let agent: InternalAgentAdapter;
  let runService: RunService;
  let wsId: string;
  const testDirs: string[] = [];

  function newTestDir(): string {
    const d = path.join(os.tmpdir(), `ogra-rs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(d, { recursive: true });
    testDirs.push(d);
    return d;
  }

  beforeEach(() => {
    const testDir = newTestDir();
    db = new DatabaseService(testDir);
    wsId = db.createWorkspace('Mock', WorkspaceType.Personal, DataClassification.Internal).id;
    auditService = new AuditService(db);
    policyService = new PolicyService(auditService);
    routeService = new RouteService(policyService);
    providerService = new ProviderService(auditService);
    workspaceService = new WorkspaceService(auditService, db);
    secretBroker = new OgraSecretBroker(testDir, auditService);
    ragEngine = new RagEngine(db);

    adapter = new TestModelAdapter();
    resolveAdapter = async () => ({
      adapter,
      modelInternalId: 'run_service_test_model',
      modelName: 'run_service_test_model',
      providerId: adapter.providerId,
    } satisfies ResolvedAdapter);

    const redaction = new RedactionService(db);
    agent = new InternalAgentAdapter(db, policyService, routeService, null, ragEngine, redaction);
    runService = new RunService(
      workspaceService, routeService, auditService, policyService, db,
      providerService, secretBroker,
      { appDataDir: testDir, secretBroker, isDev: true } as OgraCoreConfig,
      ragEngine, resolveAdapter, agent,
      redaction,
    );
    agent.bindRunService(runService);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    for (const d of testDirs.splice(0)) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  it('persists the run row before any other step', async () => {
    const before = (db.getRawDB().prepare('SELECT COUNT(*) as c FROM agent_runs').get() as any).c;
    const run = await runService.startRun({ workspaceId: wsId, task: 'T1', adapterOverride: adapter });
    const after = (db.getRawDB().prepare('SELECT COUNT(*) as c FROM agent_runs').get() as any).c;
    expect(after - before).toBeGreaterThanOrEqual(1);
    expect(run.id).toMatch(/^run_/);
    expect(run.workspaceId).toBe(wsId);
  });

  it('saves a terminal status to agent_runs after success', async () => {
    const run = await runService.startRun({ workspaceId: wsId, task: 'T2', adapterOverride: adapter });
    const row = db.getRawDB().prepare('SELECT * FROM agent_runs WHERE id = ?').get(run.id) as any;
    expect(row.status).toBe(RunStatus.Completed);
    expect(row.completed_at).toBeTruthy();
    expect(row.final_output_location).toBeTruthy();
    const parsed = JSON.parse(row.final_output_location);
    expect(parsed.answer).toBeTruthy();
  });

  it('persists sanitized failure on adapter rejection', async () => {
    adapter.failWith = { code: OgraErrorCode.PROVIDER_UNREACHABLE, message: 'adapter unreachable' };
    let threw = false;
    try {
      await runService.startRun({ workspaceId: wsId, task: 'fail', adapterOverride: adapter });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    const rows = db.getRawDB().prepare(
      "SELECT * FROM agent_runs WHERE workspace_id = ? AND task = 'fail' ORDER BY started_at DESC LIMIT 5",
    ).all(wsId) as any[];
    expect(rows.length).toBeGreaterThan(0);
    const failedRows = rows.filter(r => r.status === RunStatus.Failed);
    expect(failedRows.length).toBeGreaterThan(0);
    const last = failedRows[0];
    expect(last.error_message).toContain('PROVIDER_UNREACHABLE');
    expect(last.error_message.length).toBeLessThanOrEqual(200);
  });

  it('emits a verifiable hash chain for the run', async () => {
    const run = await runService.startRun({ workspaceId: wsId, task: 'chain', adapterOverride: adapter });
    const verification = await runService.verifyRunChain(run.id);
    expect(verification.valid).toBe(true);
    expect(verification.errors).toEqual([]);
  });

  it('returns null from getStatus for an unknown run id', async () => {
    expect(await runService.getStatus('run_does_not_exist')).toBeNull();
  });

  it('reads back the same run after a fresh service instance (SQLite durability)', async () => {
    const run = await runService.startRun({ workspaceId: wsId, task: 'persist-test', adapterOverride: adapter });
    const status = await runService.getStatus(run.id);
    expect(status).toBeTruthy();
    expect(status!.id).toBe(run.id);
    expect(status!.status).toBe(RunStatus.Completed);

    const dir = testDirs[testDirs.length - 1];
    const dbPath = path.join(dir, 'ogra.db');
    db.close();

    const newDb = new DatabaseService(dir);
    const rebuildAdapter = new TestModelAdapter();
    const agent2 = new InternalAgentAdapter(
      newDb, policyService, routeService, null, ragEngine, new RedactionService(newDb),
    );
    const auditService2 = new AuditService(newDb);
    const policyService2 = new PolicyService(auditService2);
    const routeService2 = new RouteService(policyService2);
    const providerService2 = new ProviderService(auditService2);
    const workspaceService2 = new WorkspaceService(auditService2, newDb);
    const ragEngine2 = new RagEngine(newDb);
    const runService2 = new RunService(
      workspaceService2, routeService2, auditService2, policyService2, newDb,
      providerService2, secretBroker,
      { appDataDir: dir, secretBroker, isDev: true } as OgraCoreConfig,
      ragEngine2,
      async () => ({
        adapter: rebuildAdapter,
        modelInternalId: 'run_service_test_model',
        modelName: 'run_service_test_model',
        providerId: rebuildAdapter.providerId,
      } satisfies ResolvedAdapter),
      agent2,
      new RedactionService(newDb),
    );
    agent2.bindRunService(runService2);
    const status2 = await runService2.getStatus(run.id);
    expect(status2).toBeTruthy();
    expect(status2!.id).toBe(run.id);
    expect(status2!.status).toBe(RunStatus.Completed);
    newDb.close();
  });
});

describe('RunService — fail-closed construction', () => {
  it('throws if DatabaseService is missing', () => {
    expect(() => new RunService(
      null as any, null as any, null as any, null as any,
      null as any, null as any, null as any,
      null as any, null as any, null as any, null as any, null as any,
    )).toThrow(/DatabaseService/);
  });
});

describe('RunService — approval persistence (canonical binding)', () => {
  let db: DatabaseService;
  let runService: RunService;
  let wsId: string;
  let auditService: AuditService;
  let adapter: TestModelAdapter;

  beforeEach(() => {
    const testDir = path.join(os.tmpdir(), `ogra-approve-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(testDir, { recursive: true });
    db = new DatabaseService(testDir);
    wsId = db.createWorkspace('Approve', WorkspaceType.Personal, DataClassification.Internal).id;
    auditService = new AuditService(db);
    const policyService = new PolicyService(auditService);
    const routeService = new RouteService(policyService);
    const providerService = new ProviderService(auditService);
    const workspaceService = new WorkspaceService(auditService, db);
    const ragEngine = new RagEngine(db);
    const secretBroker = new OgraSecretBroker(testDir, auditService);
    adapter = new TestModelAdapter();
    const redaction = new RedactionService(db);
    const agent = new InternalAgentAdapter(db, policyService, routeService, null, ragEngine, redaction);
    runService = new RunService(
      workspaceService, routeService, auditService, policyService, db,
      providerService, secretBroker,
      { appDataDir: testDir, secretBroker, isDev: true } as OgraCoreConfig,
      ragEngine, async () => ({
        adapter, modelInternalId: 'run_service_test_model',
        modelName: 'run_service_test_model', providerId: adapter.providerId,
      } satisfies ResolvedAdapter), agent,
      redaction,
    );
    db.storeRun({
      id: 'run_approve_test', workspaceId: wsId, task: 'approval test',
      status: RunStatus.Created, startedAt: new Date().toISOString(),
    });
    runId: 'run_approve_test';
  });

  it('records ApprovalRequest as pending — never auto-approves', async () => {
    const created = await runService.requestApproval({
      runId: 'run_approve_test', workspaceId: wsId,
      approvalType: 'egress', requestedScope: { foo: 'bar' },
      policyVersionHash: 'ph-test', payloadFingerprint: 'fp-test',
    });
    expect(created.status).toBe('pending');
    const row = db.getRawDB().prepare('SELECT * FROM approvals WHERE id = ?').get(created.id) as any;
    expect(row.decision).toBe('pending');
    expect(row.scope_hash).toBeTruthy();
  });

  it('loadApproval returns null for forged approval ids', async () => {
    const policyVersionHash = 'ph';
    const result = await runService.loadApproval({
      approvalId: 'apr_forged_999',
      runId: 'run_approve_test', workspaceId: wsId,
      policyVersionHash, payloadFingerprint: 'fp', scopeHash: 'sh',
    });
    expect(result).toBeNull();
  });

  it('loadApproval returns null when the row decision is not approved', async () => {
    const created = await runService.requestApproval({
      runId: 'run_approve_test', workspaceId: wsId,
      approvalType: 'egress', requestedScope: { foo: 'bar' },
      policyVersionHash: 'ph-test', payloadFingerprint: 'fp-test',
    });
    const policyVersionHash = 'ph';
    const pending = await runService.loadApproval({
      approvalId: created.id, runId: 'run_approve_test', workspaceId: wsId,
      policyVersionHash, payloadFingerprint: 'fp', scopeHash: 'sh',
    });
    expect(pending).toBeNull();
    const decided = await runService.submitApprovalDecision({
      approvalId: created.id, runId: 'run_approve_test', workspaceId: wsId,
      decision: 'denied', decidedBy: 'tester',
    });
    expect(decided.decision).toBe('denied');
    const stillNot = await runService.loadApproval({
      approvalId: created.id, runId: 'run_approve_test', workspaceId: wsId,
      policyVersionHash, payloadFingerprint: 'fp', scopeHash: 'sh',
    });
    expect(stillNot).toBeNull();
  });

  it('loadApproval returns the row only after an explicit approved decision with bound run/ws', async () => {
    const created = await runService.requestApproval({
      runId: 'run_approve_test', workspaceId: wsId,
      approvalType: 'egress', requestedScope: { ok: 1 },
      policyVersionHash: 'ph-test', payloadFingerprint: 'fp-test',
    });
    await runService.submitApprovalDecision({
      approvalId: created.id, runId: 'run_approve_test', workspaceId: wsId,
      decision: 'approved', decidedBy: 'tester',
    });
    const eventsBeforeRetry = db.getRunEvents('run_approve_test').length;
    const retry = await runService.submitApprovalDecision({
      approvalId: created.id, runId: 'run_approve_test', workspaceId: wsId,
      decision: 'approved', decidedBy: 'tester',
    });
    expect(retry.decision).toBe('approved');
    expect(db.getRunEvents('run_approve_test')).toHaveLength(eventsBeforeRetry);
    const expectedScopeHash = (require('crypto') as typeof import('crypto'))
      .createHash('sha256').update(JSON.stringify({ ok: 1 })).digest('hex');
    const loaded = await runService.loadApproval({
      approvalId: created.id, runId: 'run_approve_test', workspaceId: wsId,
      policyVersionHash: 'ph-test', payloadFingerprint: 'fp-test', scopeHash: expectedScopeHash,
    });
    expect(loaded).toBeTruthy();
    expect(loaded!.decision).toBe('approved');
  });
});
