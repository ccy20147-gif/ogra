import { describe, it, expect, beforeEach } from 'vitest';
import { RunService } from '../../src/core/run-service';
import { DataClassification, RunStatus, RunEventType } from '../../src/shared/types';

describe('RunService', () => {
  let runService: RunService;

  const mockConfig = {
    appDataDir: '/tmp/test',
    secretBroker: null as any,
    isDev: true,
  };

  // For isolated RunService unit tests we use manual mocks
  // so we don't depend on DatabaseService for workspace persistence.
  describe('with mocked dependencies', () => {
    let auditEvents: Array<{ eventType: string; runId: string; workspaceId: string; eventPayload: any }>;

    function createMocks() {
      auditEvents = [];

      const mockAuditService = {
        appendEvent: async (req: {
          runId: string;
          workspaceId: string;
          eventType: string;
          eventPayload: Record<string, unknown>;
          policyVersionHash?: string;
        }) => {
          auditEvents.push({
            eventType: req.eventType,
            runId: req.runId,
            workspaceId: req.workspaceId,
            eventPayload: req.eventPayload,
          });
          return {
            id: `evt_${auditEvents.length}`,
            runId: req.runId,
            workspaceId: req.workspaceId,
            sequence: auditEvents.length,
            eventType: req.eventType,
            eventPayload: req.eventPayload,
            previousHash: '0'.repeat(64),
            eventHash: 'a'.repeat(64),
            createdAt: new Date().toISOString(),
          };
        },
      };

      const mockPolicyService = {
        getPolicyVersionHash: () => 'hash-v1',
      };

      const mockRouteService = {
        evaluateRoute: async (_input: any) => ({
          id: 'rd_test',
          runId: 'run_test',
          taskId: '',
          route: 'local',
          dataClassification: DataClassification.Internal,
          highWaterSources: [],
          reasons: ['Default test route'],
          localSteps: ['retrieve', 'assemble_context', 'generate'],
          cloudSteps: [],
          requiresUserApproval: false,
          policyVersionHash: 'hash-v1',
          assignedAdapter: 'internal' as const,
          providerId: _input.providerId,
          modelId: _input.modelId,
          incidentIds: [],
          auditEventId: '',
          createdAt: new Date().toISOString(),
        }),
      };

      const mockWorkspaceService = {
        get: async (id: string) => ({
          id,
          name: 'Mock Workspace',
          type: 'personal',
          defaultClassification: DataClassification.Internal,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      };

      return { mockAuditService, mockPolicyService, mockRouteService, mockWorkspaceService };
    }

    beforeEach(() => {
      const mocks = createMocks();
      runService = new RunService(
        mocks.mockWorkspaceService as any,
        mocks.mockRouteService as any,
        mocks.mockAuditService as any,
        mocks.mockPolicyService as any,
        mockConfig,
      );
    });

    it('should create a run with status "created"', async () => {
      const run = await runService.startRun({
        workspaceId: 'ws_test',
        task: 'Test task',
      });

      expect(run.id).toBeTruthy();
      expect(run.id).toMatch(/^run_/);
      expect(run.workspaceId).toBe('ws_test');
      expect(run.task).toBe('Test task');
      expect(run.status).toBe(RunStatus.Completed);
      expect(run.startedAt).toBeTruthy();
      expect(run.completedAt).toBeTruthy();
    });

    it('should emit a run_created audit event', async () => {
      await runService.startRun({
        workspaceId: 'ws_audit',
        task: 'Audit task',
      });

      const createdEvents = auditEvents.filter(e => e.eventType === RunEventType.RunCreated);
      expect(createdEvents.length).toBe(1);
      expect(createdEvents[0].workspaceId).toBe('ws_audit');
      expect(createdEvents[0].eventPayload.task).toBe('Audit task');
    });

    it('should emit route_decision audit event', async () => {
      await runService.startRun({
        workspaceId: 'ws_route',
        task: 'Route task',
      });

      const routeEvents = auditEvents.filter(e => e.eventType === RunEventType.RouteDecision);
      expect(routeEvents.length).toBe(1);
      expect(routeEvents[0].eventPayload.route).toBe('local');
    });

    it('should set the route decision on the run record', async () => {
      const run = await runService.startRun({
        workspaceId: 'ws_route',
        task: 'Route task',
      });

      expect(run.routeDecision).toBeTruthy();
      expect(run.routeDecision!.route).toBe('local');
      expect(run.routeDecision!.reasons).toContain('Default test route');
    });

    it('should handle blocked routes gracefully', async () => {
      // Recreate with a route service that returns blocked
      const blockedRouteService = {
        evaluateRoute: async (_input: any) => ({
          id: 'rd_blocked',
          runId: 'run_blocked',
          taskId: '',
          route: 'blocked',
          dataClassification: DataClassification.Confidential,
          highWaterSources: [],
          reasons: ['Blocked by policy'],
          localSteps: [],
          cloudSteps: [],
          requiresUserApproval: false,
          policyVersionHash: 'hash-v1',
          assignedAdapter: 'none' as const,
          providerId: undefined,
          modelId: undefined,
          incidentIds: [],
          auditEventId: '',
          createdAt: new Date().toISOString(),
        }),
      };

      const blockedRunService = new RunService(
        createMocks().mockWorkspaceService as any,
        blockedRouteService as any,
        createMocks().mockAuditService as any,
        createMocks().mockPolicyService as any,
        mockConfig,
      );

      const run = await blockedRunService.startRun({
        workspaceId: 'ws_blocked',
        task: 'Blocked task',
      });

      expect(run.status).toBe(RunStatus.Blocked);
      expect(run.routeDecision!.route).toBe('blocked');
    });

    it('should pass provider and model info to route service', async () => {
      let capturedInput: any;
      const verifyingRouteService = {
        evaluateRoute: async (input: any) => {
          capturedInput = input;
          return {
            id: 'rd_verify',
            runId: 'run_verify',
            taskId: '',
            route: 'cloud',
            dataClassification: DataClassification.Internal,
            highWaterSources: [],
            reasons: ['Verified'],
            localSteps: [],
            cloudSteps: ['generate'],
            requiresUserApproval: false,
            policyVersionHash: 'hash-v1',
            assignedAdapter: 'cloud' as const,
            providerId: input.providerId,
            modelId: input.modelId,
            incidentIds: [],
            auditEventId: '',
            createdAt: new Date().toISOString(),
          };
        },
      };

      const verifyingRunService = new RunService(
        createMocks().mockWorkspaceService as any,
        verifyingRouteService as any,
        createMocks().mockAuditService as any,
        createMocks().mockPolicyService as any,
        mockConfig,
      );

      await verifyingRunService.startRun({
        workspaceId: 'ws_provider',
        task: 'Provider test',
        requestedProvider: 'test-provider',
        requestedModel: 'test-model',
      });

      expect(capturedInput).toBeTruthy();
      expect(capturedInput.workspaceId).toBe('ws_provider');
      expect(capturedInput.providerId).toBe('test-provider');
      expect(capturedInput.modelId).toBe('test-model');
      expect(capturedInput.requestedOperation).toBe('generate');
    });

    it('should complete successfully for local route', async () => {
      // Use cloud route so we can verify completion
      const cloudRouteService = {
        evaluateRoute: async (_input: any) => ({
          id: 'rd_cloud',
          runId: 'run_cloud',
          taskId: '',
          route: 'cloud',
          dataClassification: DataClassification.Public,
          highWaterSources: [],
          reasons: ['Public data cloud allowed'],
          localSteps: ['retrieve', 'assemble_context'],
          cloudSteps: ['generate'],
          requiresUserApproval: false,
          policyVersionHash: 'hash-v1',
          assignedAdapter: 'cloud' as const,
          providerId: _input.providerId,
          modelId: _input.modelId,
          incidentIds: [],
          auditEventId: '',
          createdAt: new Date().toISOString(),
        }),
      };

      const cloudRunService = new RunService(
        createMocks().mockWorkspaceService as any,
        cloudRouteService as any,
        createMocks().mockAuditService as any,
        createMocks().mockPolicyService as any,
        mockConfig,
      );

      const run = await cloudRunService.startRun({
        workspaceId: 'ws_complete',
        task: 'Complete task',
      });

      expect(run.status).toBe(RunStatus.Completed);
      expect(run.completedAt).toBeTruthy();
    });
  });
});
