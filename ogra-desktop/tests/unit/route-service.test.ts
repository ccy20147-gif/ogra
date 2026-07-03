import { describe, it, expect, beforeEach } from 'vitest';
import { PolicyService, PolicyEvaluationInput } from '../../src/core/policy-service';
import { RouteService } from '../../src/core/route-service';
import { AuditService } from '../../src/core/audit-service';
import { DataClassification } from '../../src/shared/types';

describe('RouteService', () => {
  let routeService: RouteService;
  let policyService: PolicyService;

  beforeEach(() => {
    const auditService = new AuditService(); // In-memory for tests
    policyService = new PolicyService(auditService);
    routeService = new RouteService(policyService);
  });

  it('should route public data to cloud', async () => {
    const decision = await routeService.evaluateRoute({
      workspaceId: 'ws_test',
      dataClassification: DataClassification.Public,
      requestedCompute: 'cloud',
      providerId: 'test-provider',
    });

    expect(decision.route).toBe('cloud');
    expect(decision.assignedAdapter).toBe('cloud');
    expect(decision.policyVersionHash).toBeTruthy();
  });

  it('should block confidential data from cloud', async () => {
    const decision = await routeService.evaluateRoute({
      workspaceId: 'ws_test',
      dataClassification: DataClassification.Confidential,
      requestedCompute: 'cloud',
    });

    expect(decision.route).toBe('blocked');
    expect(decision.assignedAdapter).toBe('none');
  });

  it('should block restricted data from cloud', async () => {
    const decision = await routeService.evaluateRoute({
      workspaceId: 'ws_test',
      dataClassification: DataClassification.Restricted,
      requestedCompute: 'cloud',
    });

    expect(decision.route).toBe('blocked');
    expect(decision.assignedAdapter).toBe('none');
  });

  it('should route internal data to local-only when no cloud requested', async () => {
    const decision = await routeService.evaluateRoute({
      workspaceId: 'ws_test',
      dataClassification: DataClassification.Internal,
      requestedCompute: 'local',
    });

    expect(decision.route).toBe('local');
    expect(decision.assignedAdapter).toBe('internal');
  });

  it('should require approval for internal data with cloud request', async () => {
    const decision = await routeService.evaluateRoute({
      workspaceId: 'ws_test',
      dataClassification: DataClassification.Internal,
      requestedCompute: 'cloud',
    });

    expect(decision.requiresUserApproval).toBe(true);
    expect(decision.reasons.length).toBeGreaterThan(0);
  });

  it('should block agent without cloud permission', async () => {
    const decision = await routeService.evaluateRoute({
      workspaceId: 'ws_test',
      dataClassification: DataClassification.Public,
      requestedCompute: 'cloud',
      agentId: 'no-cloud-agent',
      agentPermissions: { canUseCloud: false, canWriteToDisk: false, canAccessNetwork: false },
    });

    expect(decision.route).toBe('blocked');
    expect(decision.assignedAdapter).toBe('none');
  });

  it('should set taskId and policyVersionHash on route decision', async () => {
    const decision = await routeService.evaluateRoute({
      workspaceId: 'ws_test',
      dataClassification: DataClassification.Internal,
    });

    expect(decision).toHaveProperty('taskId');
    expect(decision).toHaveProperty('policyVersionHash');
    expect(decision.policyVersionHash).toBeTruthy();
    expect(typeof decision.policyVersionHash).toBe('string');
  });
});
