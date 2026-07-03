import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { DatabaseService } from '../../src/core/database-service';
import { DataClassification, WorkspaceType } from '../../src/shared/types';

describe('DatabaseService', () => {
  const testDir = path.join(os.tmpdir(), `ogra-db-test-${Date.now()}`);
  let db: DatabaseService;

  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });
    db = new DatabaseService(testDir);
  });

  afterAll(() => {
    db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('Workspace CRUD', () => {
    it('should create a workspace', () => {
      const ws = db.createWorkspace('Test Workspace', WorkspaceType.Personal, DataClassification.Internal);
      expect(ws.id).toBeTruthy();
      expect(ws.name).toBe('Test Workspace');
      expect(ws.type).toBe('personal');
      expect(ws.default_data_classification).toBe('Internal');
    });

    it('should list workspaces', () => {
      const workspaces = db.listWorkspaces();
      expect(workspaces.length).toBeGreaterThanOrEqual(1);
    });

    it('should get workspace by id', () => {
      const workspaces = db.listWorkspaces();
      const ws = db.getWorkspace(workspaces[0].id);
      expect(ws).toBeDefined();
      expect(ws!.name).toBe('Test Workspace');
    });

    it('should update workspace classification', () => {
      const workspaces = db.listWorkspaces();
      db.updateWorkspaceClassification(workspaces[0].id, DataClassification.Confidential);
      const updated = db.getWorkspace(workspaces[0].id);
      expect(updated!.default_data_classification).toBe('Confidential');
    });
  });

  describe('Run Event Hash Chain', () => {
    const runId = 'test_chain_run';
    const wsId = 'ws_chain_test';

    beforeAll(() => {
      db.createWorkspace('Chain Test', WorkspaceType.Personal, DataClassification.Internal);
    });

    it('should append events with hash chain', () => {
      const event1 = db.appendRunEvent(runId, wsId, 'run_created', { task: 'test' });
      expect(event1.sequence).toBe(1);
      expect(event1.previous_hash).toBe('0000000000000000000000000000000000000000000000000000000000000000');
      expect(event1.event_hash).toBeTruthy();

      const event2 = db.appendRunEvent(runId, wsId, 'route_decision', { route: 'local' });
      expect(event2.sequence).toBe(2);
      expect(event2.previous_hash).toBe(event1.event_hash);
    });

    it('should verify chain integrity', () => {
      const result = db.verifyRunChain(runId);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should retrieve events in order', () => {
      const events = db.getRunEvents(runId);
      expect(events.length).toBe(2);
      expect(events[0].sequence).toBe(1);
      expect(events[1].sequence).toBe(2);
    });
  });

  describe('Route Decisions', () => {
    it('should store and retrieve route decisions', () => {
      const ws = db.createWorkspace('Route Test', WorkspaceType.Project, DataClassification.Confidential);
      const decision = {
        id: 'rd_test_1',
        runId: 'test_route_run',
        route: 'local',
        dataClassification: 'Confidential',
        highWaterSources: ['ws_1'],
        reasons: ['Confidential data local-only'],
        localSteps: ['retrieve', 'generate'],
        cloudSteps: [],
        requiresUserApproval: false,
        incidentIds: [],
      };
      // Create corresponding agent run entry to satisfy FK
      const wsRow = db.getWorkspace(ws.id);
      db.storeRouteDecision(decision);

      const retrieved = db.getRouteDecision('test_route_run');
      expect(retrieved).toBeDefined();
      expect(retrieved!.route).toBe('local');
    });
  });

  describe('Model Providers', () => {
    it('should add and list providers', () => {
      db.addProvider({
        id: 'ollama_test',
        kind: 'ollama',
        name: 'Ollama',
        endpoint: 'http://localhost:11434',
        isLocal: true,
      });

      const providers = db.listProviders();
      expect(providers.length).toBeGreaterThanOrEqual(1);
      expect(providers.some((p: any) => p.kind === 'ollama')).toBe(true);
    });
  });

  describe('Knowledge Bases', () => {
    it('should create and list knowledge bases', () => {
      const ws = db.createWorkspace('KB Test', WorkspaceType.Project, DataClassification.Confidential);
      db.createKnowledgeBase({
        id: 'kb_test_1',
        workspaceId: ws.id,
        name: 'Confidential Docs',
        rootPath: '/test/path',
        classification: DataClassification.Confidential,
      });

      const kbs = db.listKnowledgeBases(ws.id);
      expect(kbs.length).toBe(1);
      expect(kbs[0].name).toBe('Confidential Docs');
    });
  });

  describe('Incidents', () => {
    it('should create and list incidents', () => {
      const ws = db.createWorkspace('Incident Test', WorkspaceType.Company, DataClassification.Internal);
      db.createIncident({
        id: 'inc_test_1',
        workspaceId: ws.id,
        runId: 'run_blocked_1',
        incidentType: 'policy_block',
        severity: 'high',
        summary: 'Confidential data cloud call blocked',
        evidenceEventIds: ['evt_1', 'evt_2'],
      });

      const incidents = db.listIncidents(ws.id);
      expect(incidents.length).toBe(1);
      expect(incidents[0].incident_type).toBe('policy_block');
    });
  });
});
