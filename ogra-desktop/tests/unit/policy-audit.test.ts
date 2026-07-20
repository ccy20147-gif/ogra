import { describe, it, expect } from 'vitest';
import { PolicyService } from '../../src/core/policy-service';
import { PolicyEvaluationInput } from '../../src/core/policy-service';
import { AuditService } from '../../src/core/audit-service';
import { DataClassification } from '../../src/shared/types';

describe('Policy Engine', () => {
  const auditService = new AuditService();
  const policyService = new PolicyService(auditService);

  it('should require approval for Confidential data cloud egress (default)', async () => {
    const input: PolicyEvaluationInput = {
      workspaceId: 'ws_test',
      dataClassification: DataClassification.Confidential,
      requestedCompute: 'cloud',
      requiresCloud: true,
    };
    const result = await policyService.evaluate(input);
    // Sequence 0 (Plan 03 §3.6): Confidential + cloud no-approval
    // is require_approval (route=blocked), not decision=blocked.
    // The redact_then_egress tier takes over when an approved row
    // exists; without it, the run is held at require_approval.
    expect(result.decision).toBe('require_approval');
    expect(result.route).toBe('blocked');
    expect(result.requiredApprovals).toContain('allow_confidential_redacted_cloud');
  });

  it('Confidential + cloud + approved approval → redact_then_egress', async () => {
    const result = await policyService.evaluate({
      workspaceId: 'ws_test',
      dataClassification: DataClassification.Confidential,
      requestedCompute: 'cloud',
      requiresCloud: true,
      hasUserApproval: true,
      providerIsLocal: false,
    });
    expect(result.decision).toBe('allow');
    expect(result.route).toBe('redact_then_egress');
  });

  it('blocks Restricted data from cloud', async () => {
    const input: PolicyEvaluationInput = {
      workspaceId: 'ws_test',
      dataClassification: DataClassification.Restricted,
      requestedCompute: 'cloud',
    };
    const result = await policyService.evaluate(input);
    expect(result.decision).toBe('blocked');
  });

  it('should route Confidential data local only', async () => {
    const input: PolicyEvaluationInput = {
      workspaceId: 'ws_test',
      dataClassification: DataClassification.Confidential,
      requestedCompute: 'local',
    };
    const result = await policyService.evaluate(input);
    expect(result.decision).toBe('local_only');
    expect(result.route).toBe('local');
  });

  it('should block Restricted data from cloud', async () => {
    const input: PolicyEvaluationInput = {
      workspaceId: 'ws_test',
      dataClassification: DataClassification.Restricted,
      requestedCompute: 'cloud',
    };
    const result = await policyService.evaluate(input);
    expect(result.decision).toBe('blocked');
    expect(result.route).toBe('blocked');
  });

  it('should require approval for Internal cloud compute', async () => {
    const input: PolicyEvaluationInput = {
      workspaceId: 'ws_test',
      dataClassification: DataClassification.Internal,
      requestedCompute: 'cloud',
    };
    const result = await policyService.evaluate(input);
    expect(result.decision).toBe('require_approval');
    expect(result.requiredApprovals).toContain('allow_internal_redacted_cloud');
  });

  it('should allow Public cloud compute with provider', async () => {
    const input: PolicyEvaluationInput = {
      workspaceId: 'ws_test',
      dataClassification: DataClassification.Public,
      requestedCompute: 'cloud',
      providerId: 'openai_test',
    };
    const result = await policyService.evaluate(input);
    expect(result.decision).toBe('allow');
    expect(result.route).toBe('cloud');
  });

  it('should default unknown classification to local-only', async () => {
    const input: PolicyEvaluationInput = {
      workspaceId: 'ws_test',
      dataClassification: 'Unknown' as DataClassification,
      requestedCompute: 'cloud',
    };
    const result = await policyService.evaluate(input);
    expect(result.decision).toBe('allow');
    expect(result.route).toBe('local');
    expect(result.reasons.some(r => r.toLowerCase().includes('default'))).toBe(true);
  });

  it('should implement require_approval priority for Confidential', async () => {
    const input: PolicyEvaluationInput = {
      workspaceId: 'ws_test',
      dataClassification: DataClassification.Confidential,
      requestedCompute: 'cloud',
      providerId: 'any_provider',
    };
    const result = await policyService.evaluate(input);
    // Sequence 0 (Plan 03 §3.6): no approved approval → require_approval.
    expect(result.decision).toBe('require_approval');
  });
});

describe('Audit Hash Chain', () => {
  const auditService = new AuditService();
  const runId = 'test_run_001';

  it('should create first event with genesis hash', async () => {
    const event1 = await auditService.appendEvent({
      runId,
      workspaceId: 'ws_test',
      eventType: 'run_created',
      eventPayload: { task: 'test task' },
    });
    expect(event1.sequence).toBe(1);
    expect(event1.previousHash).toBe('0000000000000000000000000000000000000000000000000000000000000000');
    expect(event1.eventHash).toBeTruthy();
    expect(event1.payloadHash).toBeTruthy();
  });

  it('should chain second event after first', async () => {
    const event2 = await auditService.appendEvent({
      runId,
      workspaceId: 'ws_test',
      eventType: 'policy_precheck',
      eventPayload: { classification: 'confidential' },
    });
    expect(event2.sequence).toBe(2);
    expect(event2.previousHash).not.toBe('0000000000000000000000000000000000000000000000000000000000000000');
  });

  it('should verify the chain successfully', async () => {
    const result = await auditService.verifyChain(runId);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should have monotonic sequence per run', async () => {
    const events = await auditService.getEvents(runId);
    for (let i = 0; i < events.length; i++) {
      expect(events[i].sequence).toBe(i + 1);
    }
  });
});
