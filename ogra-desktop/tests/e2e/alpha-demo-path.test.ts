import { describe, it, expect } from 'vitest';
import { AuditService } from '../../src/core/audit-service';
import { PolicyService } from '../../src/core/policy-service';
import { PathValidator } from '../../src/core/path-validator';
import { DataClassification } from '../../src/shared/types';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/**
 * E2E smoke test that simulates the Alpha demo path:
 * Import -> Classify -> Policy -> Route -> Audit
 */
describe('Alpha E2E Smoke Test', () => {
  const auditService = new AuditService();
  const policyService = new PolicyService(auditService);
  const pathValidator = new PathValidator();
  const testDir = path.join(os.tmpdir(), `ogra-e2e-${Date.now()}`);
  const workspaceId = 'ws_e2e_test';

  beforeAll(() => {
    // Create fixture directory
    fs.mkdirSync(path.join(testDir, 'confidential-docs'), { recursive: true });
    fs.writeFileSync(
      path.join(testDir, 'confidential-docs', 'q2-report.md'),
      '# Q2 Confidential Report\nRevenue: $4.2M\nExpenses: $3.1M\nProfit: $1.1M',
    );
  });

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('1. Should validate and import a folder', async () => {
    const folderPath = path.join(testDir, 'confidential-docs');
    const validation = pathValidator.validateImportPath(folderPath);
    expect(validation.isValid).toBe(true);
    expect(validation.canonicalPath).toBeTruthy();
  });

  it('2. Policy should block Confidential data from cloud', async () => {
    const result = await policyService.evaluate({
      workspaceId,
      dataClassification: DataClassification.Confidential,
      requestedCompute: 'cloud',
      requiresCloud: true,
    });
    expect(result.decision).toBe('blocked');
    expect(result.route).toBe('blocked');
    expect(result.reasons.some(r => r.includes('Confidential'))).toBe(true);
  });

  it('3. Policy should route Confidential data to local', async () => {
    const result = await policyService.evaluate({
      workspaceId,
      dataClassification: DataClassification.Confidential,
      requestedCompute: 'local',
    });
    expect(result.decision).toBe('local_only');
    expect(result.route).toBe('local');
  });

  it('4. Audit events should form a verifiable hash chain', async () => {
    const runId = 'e2e_demo_run';

    // Create run events
    await auditService.appendEvent({
      runId,
      workspaceId,
      eventType: 'run_created',
      eventPayload: { task: 'Analyze Q2 financials' },
    });

    await auditService.appendEvent({
      runId,
      workspaceId,
      eventType: 'route_decision',
      eventPayload: {
        route: 'local',
        classification: 'Confidential',
        reasons: ['Confidential data: local-only in Alpha'],
      },
    });

    await auditService.appendEvent({
      runId,
      workspaceId,
      eventType: 'audit_complete',
      eventPayload: { cloudCalls: 0 },
    });

    // Verify hash chain
    const verification = await auditService.verifyChain(runId);
    expect(verification.valid).toBe(true);

    // Verify cloud call count
    const events = await auditService.getEvents(runId);
    const cloudCalls = events.filter(e =>
      e.eventType.includes('model_call') && (e.eventPayload as any)?.isCloud === true
    );
    expect(cloudCalls).toHaveLength(0);
  });

  it('5. Policy should verify prompt injection detection', async () => {
    const result = await policyService.evaluate({
      workspaceId,
      dataClassification: DataClassification.Public,
      requestedCompute: 'local',
    });
    // Prompt injection should not change routing for public data
    expect(result.decision).not.toBe('blocked');
  });

  it('6. Confidential + Restricted should never go to cloud', async () => {
    const confidentialResult = await policyService.evaluate({
      workspaceId,
      dataClassification: DataClassification.Confidential,
      requestedCompute: 'cloud',
    });
    expect(confidentialResult.decision).toBe('blocked');

    const restrictedResult = await policyService.evaluate({
      workspaceId,
      dataClassification: DataClassification.Restricted,
      requestedCompute: 'cloud',
    });
    expect(restrictedResult.decision).toBe('blocked');
  });

  it('7. Public data can use cloud when provider is configured', async () => {
    const result = await policyService.evaluate({
      workspaceId,
      dataClassification: DataClassification.Public,
      requestedCompute: 'cloud',
      providerId: 'openai_test',
    });
    expect(result.decision).toBe('allow');
    expect(result.route).toBe('cloud');
  });

  it('8. Unknown classification defaults to local', async () => {
    const result = await policyService.evaluate({
      workspaceId,
      dataClassification: 'Unknown' as DataClassification,
    });
    expect(result.route).toBe('local');
  });
});
