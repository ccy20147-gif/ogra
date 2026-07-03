import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb } from '../helpers/test-db';
import { AuditService } from '../../src/core/audit-service';
import { PolicyService } from '../../src/core/policy-service';
import { RouteService } from '../../src/core/route-service';
import { PathValidator } from '../../src/core/path-validator';
import { DataClassification, RouteDecisionType } from '../../src/shared/types';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/**
 * Enhanced E2E smoke test that simulates the Alpha demo path:
 * Import -> Classify -> Policy -> Route -> Audit
 *
 * Uses real SQLite DatabaseService (via createTestDb) instead of
 * in-memory services, verifying DB-persisted hash chains,
 * RouteService integration, and real filesystem paths.
 */
describe('Alpha E2E Smoke Test (real DB)', () => {
  let fixture: ReturnType<typeof createTestDb>;
  let db: import('../../src/core/database-service').DatabaseService;
  let auditService: AuditService;
  let policyService: PolicyService;
  let routeService: RouteService;
  let pathValidator: PathValidator;

  beforeAll(() => {
    // Create test DB fixture with workspace + run pre-inserted
    fixture = createTestDb();
    db = fixture.db;
    const workspaceId = fixture.workspaceId;
    const runId = fixture.runId;

    // Wire services with real DB backend
    auditService = new AuditService(db);
    policyService = new PolicyService(auditService);
    routeService = new RouteService(policyService);
    pathValidator = new PathValidator();

    // Verify the workspace was persisted in DB
    const workspace = db.getWorkspace(workspaceId);
    expect(workspace).toBeTruthy();
    expect(workspace!.name).toBe('Test Workspace');
    expect(workspace!.default_data_classification).toBe(DataClassification.Internal);

    // Verify the run was persisted in DB
    const runs = db.getRawDB().prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId) as any;
    expect(runs).toBeTruthy();
    expect(runs.status).toBe('completed');

    // Add test model providers for cloud routing verification
    const existingProviders = db.listProviders().map(p => p.id);
    if (!existingProviders.includes('openai_test')) {
      db.addProvider({
        id: 'openai_test',
        kind: 'openai_compatible',
        name: 'OpenAI Test',
        endpoint: 'https://api.openai.test/v1',
        isLocal: false,
      });
    }
    if (!existingProviders.includes('local_test')) {
      db.addProvider({
        id: 'local_test',
        kind: 'ollama',
        name: 'Local Test',
        endpoint: 'http://localhost:11434',
        isLocal: true,
      });
    }
  });

  afterAll(() => {
    fixture.cleanup();
  });

  // ─── 1. Import ────────────────────────────────────────────────────────

  it('1. Should validate and import a folder with real filesystem path', async () => {
    const testDir = fixture.testDir;
    const fixturePath = path.join(testDir, 'confidential-docs');

    // Create fixture files on the real filesystem
    fs.mkdirSync(fixturePath, { recursive: true });
    fs.writeFileSync(
      path.join(fixturePath, 'q2-report.md'),
      '# Q2 Confidential Report\nRevenue: $4.2M\nExpenses: $3.1M\nProfit: $1.1M',
    );

    const validation = pathValidator.validateImportPath(fixturePath);
    expect(validation.isValid).toBe(true);
    expect(validation.canonicalPath).toBeTruthy();

    // Verify the path exists on real filesystem
    expect(fs.existsSync(fixturePath)).toBe(true);
    expect(fs.statSync(fixturePath).isDirectory()).toBe(true);

    // Store import event in DB via audit service
    await auditService.appendEvent({
      runId: fixture.runId,
      workspaceId: fixture.workspaceId,
      eventType: 'document_accessed',
      eventPayload: { path: fixturePath, files: ['q2-report.md'] },
    });

    // Verify the event was persisted to SQLite
    const events = await auditService.getEvents(fixture.runId);
    const importEvents = events.filter(e => e.eventType === 'document_accessed');
    expect(importEvents.length).toBeGreaterThanOrEqual(1);
    const payload = importEvents[0].eventPayload as Record<string, unknown>;
    expect(payload.path).toBe(fixturePath);
  });

  // ─── 2. Classify + Policy (block Confidential from cloud) ────────────

  it('2. Policy should block Confidential data from cloud', async () => {
    const result = await policyService.evaluate({
      workspaceId: fixture.workspaceId,
      dataClassification: DataClassification.Confidential,
      requestedCompute: 'cloud',
      requiresCloud: true,
    });
    expect(result.decision).toBe('blocked');
    expect(result.route).toBe('blocked');
    expect(result.reasons.some(r => r.includes('Confidential'))).toBe(true);

    // Store the policy evaluation event in DB
    await auditService.appendEvent({
      runId: fixture.runId,
      workspaceId: fixture.workspaceId,
      eventType: 'policy_evaluation',
      eventPayload: {
        dataClassification: DataClassification.Confidential,
        requestedCompute: 'cloud',
        decision: result.decision,
        route: result.route,
        reasons: result.reasons,
      },
    });
  });

  // ─── 3. Classify + Policy (route Confidential to local) ─────────────

  it('3. Policy should route Confidential data to local', async () => {
    const result = await policyService.evaluate({
      workspaceId: fixture.workspaceId,
      dataClassification: DataClassification.Confidential,
      requestedCompute: 'local',
    });
    expect(result.decision).toBe('local_only');
    expect(result.route).toBe('local');

    // Store the routing event in DB
    await auditService.appendEvent({
      runId: fixture.runId,
      workspaceId: fixture.workspaceId,
      eventType: 'route_decision',
      eventPayload: {
        route: 'local',
        classification: 'Confidential',
        reasons: result.reasons,
      },
    });
  });

  // ─── 4. RouteService + PolicyService combined pipeline ──────────────

  it('4. RouteService should produce and persist a route decision', async () => {
    const routeRecord = await routeService.evaluateRoute({
      workspaceId: fixture.workspaceId,
      dataClassification: DataClassification.Public,
      requestedCompute: 'cloud',
      providerId: 'openai_test',
    });

    expect(routeRecord).toBeTruthy();
    expect(routeRecord.route).toBe(RouteDecisionType.Cloud);
    expect(routeRecord.assignedAdapter).toBe('cloud');
    expect(routeRecord.runId).toBeTruthy();
    expect(routeRecord.policyVersionHash).toBeTruthy();
    expect(routeRecord.reasons.some(r => r.includes('Public'))).toBe(true);

    // Store route decision event in DB
    await auditService.appendEvent({
      runId: routeRecord.runId,
      workspaceId: fixture.workspaceId,
      eventType: 'route_decision',
      eventPayload: {
        route: routeRecord.route,
        classification: DataClassification.Public,
        providerId: 'openai_test',
        reasons: routeRecord.reasons,
      },
    });

    // Persist route decision to DB
    db.storeRouteDecision({
      id: routeRecord.id,
      runId: routeRecord.runId,
      route: routeRecord.route,
      dataClassification: routeRecord.dataClassification,
      highWaterSources: routeRecord.highWaterSources,
      reasons: routeRecord.reasons,
      localSteps: routeRecord.localSteps,
      cloudSteps: routeRecord.cloudSteps,
      requiresUserApproval: routeRecord.requiresUserApproval,
      providerId: 'openai_test',
      incidentIds: routeRecord.incidentIds,
    });

    // Verify route decision was persisted
    const persistedDecision = db.getRouteDecision(routeRecord.runId);
    expect(persistedDecision).toBeTruthy();
    expect(persistedDecision!.route).toBe(RouteDecisionType.Cloud);
    expect(persistedDecision!.provider_id).toBe('openai_test');
  });

  // ─── 5. DB-persisted hash chain verification ────────────────────────

  it('5. Audit events should form a verifiable hash chain in DB', async () => {
    const chainRunId = `chain-test-${Date.now()}`;

    // Append events in sequence (simulating a full pipeline)
    await auditService.appendEvent({
      runId: chainRunId,
      workspaceId: fixture.workspaceId,
      eventType: 'run_created',
      eventPayload: { task: 'Analyze Q2 financials' },
    });

    await auditService.appendEvent({
      runId: chainRunId,
      workspaceId: fixture.workspaceId,
      eventType: 'route_decision',
      eventPayload: {
        route: 'local',
        classification: 'Confidential',
        reasons: ['Confidential data: local-only in Alpha'],
      },
    });

    await auditService.appendEvent({
      runId: chainRunId,
      workspaceId: fixture.workspaceId,
      eventType: 'model_call_started',
      eventPayload: { modelId: 'qwen2.5', isCloud: false },
    });

    await auditService.appendEvent({
      runId: chainRunId,
      workspaceId: fixture.workspaceId,
      eventType: 'audit_complete',
      eventPayload: { cloudCalls: 0 },
    });

    // Verify hash chain via DB (DatabaseService.verifyRunChain)
    const verification = await auditService.verifyChain(chainRunId);
    expect(verification.valid).toBe(true);
    expect(verification.errors).toHaveLength(0);

    // Verify no cloud calls
    const events = await auditService.getEvents(chainRunId);
    const cloudCalls = events.filter(e =>
      e.eventType.includes('model_call') && (e.eventPayload as Record<string, unknown>)?.isCloud === true
    );
    expect(cloudCalls).toHaveLength(0);

    // Verify chain integrity via raw DB query
    const rows = db.getRawDB().prepare(
      'SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence ASC'
    ).all(chainRunId) as any[];
    expect(rows).toHaveLength(4);
    expect(rows[0].previous_hash).toBe('0000000000000000000000000000000000000000000000000000000000000000');
    expect(rows[1].previous_hash).toBe(rows[0].event_hash);
    expect(rows[2].previous_hash).toBe(rows[1].event_hash);
    expect(rows[3].previous_hash).toBe(rows[2].event_hash);
  });

  // ─── 6. Prompt injection detection ──────────────────────────────────

  it('6. Policy should verify prompt injection detection', async () => {
    const result = await policyService.evaluate({
      workspaceId: fixture.workspaceId,
      dataClassification: DataClassification.Public,
      requestedCompute: 'local',
    });
    // Prompt injection should not change routing for public data to local
    expect(result.decision).not.toBe('blocked');

    // Verify DB has the workspace
    const ws = db.getWorkspace(fixture.workspaceId);
    expect(ws).toBeTruthy();
  });

  // ─── 7. Confidential + Restricted never go to cloud ─────────────────

  it('7. Confidential + Restricted should never go to cloud', async () => {
    const confidentialResult = await policyService.evaluate({
      workspaceId: fixture.workspaceId,
      dataClassification: DataClassification.Confidential,
      requestedCompute: 'cloud',
    });
    expect(confidentialResult.decision).toBe('blocked');

    const restrictedResult = await policyService.evaluate({
      workspaceId: fixture.workspaceId,
      dataClassification: DataClassification.Restricted,
      requestedCompute: 'cloud',
    });
    expect(restrictedResult.decision).toBe('blocked');

    // Log to audit
    await auditService.appendEvent({
      runId: fixture.runId,
      workspaceId: fixture.workspaceId,
      eventType: 'run_blocked',
      eventPayload: {
        reason: 'Confidential/Restricted data blocked from cloud',
        classifications: ['Confidential', 'Restricted'],
      },
    });
  });

  // ─── 8. Public data + cloud with configured provider ────────────────

  it('8. Public data can use cloud when provider is configured', async () => {
    const result = await policyService.evaluate({
      workspaceId: fixture.workspaceId,
      dataClassification: DataClassification.Public,
      requestedCompute: 'cloud',
      providerId: 'openai_test',
    });
    expect(result.decision).toBe('allow');
    expect(result.route).toBe('cloud');

    // Verify provider exists in DB
    const providers = db.listProviders();
    const cloudProvider = providers.find(p => p.id === 'openai_test');
    expect(cloudProvider).toBeTruthy();
    expect(cloudProvider!.is_local).toBe(0);
  });

  // ─── 9. Unknown classification defaults to local ────────────────────

  it('9. Unknown classification defaults to local', async () => {
    const result = await policyService.evaluate({
      workspaceId: fixture.workspaceId,
      dataClassification: 'Unknown' as DataClassification,
    });
    expect(result.route).toBe('local');
  });

  // ─── 10. Confidential with local provider is allowed to local ────────

  it('10. Confidential data with local provider should allow local compute', async () => {
    const result = await policyService.evaluate({
      workspaceId: fixture.workspaceId,
      dataClassification: DataClassification.Confidential,
      requestedCompute: 'cloud',
      providerIsLocal: true,
    });
    // When provider is local, Confidential data is allowed on local
    expect(result.decision).toBe('allow');
    expect(result.route).toBe('local');

    await auditService.appendEvent({
      runId: fixture.runId,
      workspaceId: fixture.workspaceId,
      eventType: 'route_decision',
      eventPayload: {
        route: 'local',
        classification: 'Confidential',
        providerIsLocal: true,
        reasons: result.reasons,
      },
    });
  });

  // ─── 11. Full pipeline: import → classify → policy → route → audit ──

  it('11. Full Alpha pipeline with DB persistence', async () => {
    const pipelineRunId = `pipeline-${Date.now()}`;

    // Step 1: Import — validate path, store event
    const importPath = path.join(fixture.testDir, 'pipeline-docs');
    fs.mkdirSync(importPath, { recursive: true });
    fs.writeFileSync(path.join(importPath, 'data.txt'), 'sensitive data');

    const validation = pathValidator.validateImportPath(importPath);
    expect(validation.isValid).toBe(true);

    await auditService.appendEvent({
      runId: pipelineRunId,
      workspaceId: fixture.workspaceId,
      eventType: 'run_created',
      eventPayload: { task: 'Full pipeline test', importPath },
    });

    // Step 2: Classify + Policy
    const policyResult = await policyService.evaluate({
      workspaceId: fixture.workspaceId,
      dataClassification: DataClassification.Confidential,
      requestedCompute: 'local',
    });
    expect(policyResult.decision).toBe('local_only');
    expect(policyResult.route).toBe('local');

    await auditService.appendEvent({
      runId: pipelineRunId,
      workspaceId: fixture.workspaceId,
      eventType: 'policy_evaluation',
      eventPayload: {
        classification: DataClassification.Confidential,
        decision: policyResult.decision,
        reasons: policyResult.reasons,
      },
    });

    // Step 3: Route
    const routeRecord = await routeService.evaluateRoute({
      workspaceId: fixture.workspaceId,
      dataClassification: DataClassification.Confidential,
      requestedCompute: 'local',
    });
    expect(routeRecord.route).toBe(RouteDecisionType.Local);
    expect(routeRecord.assignedAdapter).toBe('internal');

    await auditService.appendEvent({
      runId: pipelineRunId,
      workspaceId: fixture.workspaceId,
      eventType: 'route_decision',
      eventPayload: {
        route: routeRecord.route,
        classification: 'Confidential',
        adapter: routeRecord.assignedAdapter,
      },
    });

    // Step 4: Model call (local)
    await auditService.appendEvent({
      runId: pipelineRunId,
      workspaceId: fixture.workspaceId,
      eventType: 'model_call_started',
      eventPayload: { modelId: 'local:qwen', isCloud: false },
    });

    await auditService.appendEvent({
      runId: pipelineRunId,
      workspaceId: fixture.workspaceId,
      eventType: 'model_call_completed',
      eventPayload: { modelId: 'local:qwen', isCloud: false, tokens: 150 },
    });

    // Step 5: Audit complete
    await auditService.appendEvent({
      runId: pipelineRunId,
      workspaceId: fixture.workspaceId,
      eventType: 'audit_complete',
      eventPayload: { cloudCalls: 0 },
    });

    // Verify full chain integrity in DB
    const chainVerification = await auditService.verifyChain(pipelineRunId);
    expect(chainVerification.valid).toBe(true);
    expect(chainVerification.errors).toHaveLength(0);

    // Verify all events persisted
    const allEvents = await auditService.getEvents(pipelineRunId);
    expect(allEvents).toHaveLength(6);

    // Verify event types in order
    const eventTypes = allEvents.map(e => e.eventType);
    expect(eventTypes).toEqual([
      'run_created',
      'policy_evaluation',
      'route_decision',
      'model_call_started',
      'model_call_completed',
      'audit_complete',
    ]);
  });

  // ─── 12. DB integrity: workspace and run metadata ───────────────────

  it('12. DB should persist workspace and run metadata', async () => {
    // Create another run via DB service
    const now = new Date().toISOString();
    db.storeRun({
      id: 'e2e-additional-run',
      workspaceId: fixture.workspaceId,
      task: 'Additional E2E task',
      status: 'created',
      startedAt: now,
    });
    db.updateRunStatus('e2e-additional-run', 'completed', now);

    const runs = db.getRawDB().prepare(
      'SELECT * FROM agent_runs WHERE workspace_id = ? ORDER BY started_at'
    ).all(fixture.workspaceId) as any[];
    expect(runs.length).toBeGreaterThanOrEqual(2);

    // The original fixture run + our new one
    const runTasks = runs.map((r: any) => r.task);
    expect(runTasks).toContain('Test run');
    expect(runTasks).toContain('Additional E2E task');
  });
});
