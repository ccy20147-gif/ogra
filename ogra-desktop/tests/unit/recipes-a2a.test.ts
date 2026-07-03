import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseService } from '../../src/core/database-service';
import { RecipeService } from '../../src/core/recipe-service';
import { A2ABridge } from '../../src/core/a2a-bridge';
import { PolicyService } from '../../src/core/policy-service';
import { AuditService } from '../../src/core/audit-service';
import { DataClassification, WorkspaceType } from '../../src/shared/types';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { createTestDb } from '../helpers/test-db';

describe('RecipeService', () => {
  let fixture: ReturnType<typeof createTestDb>;
  let db: DatabaseService;
  let recipes: RecipeService;
  let wsId: string;

  beforeAll(() => {
    fixture = createTestDb();
    db = fixture.db;
    wsId = fixture.workspaceId;
    recipes = new RecipeService(db);
  });

  afterAll(() => {
    fixture.cleanup();
  });

  it('should save a recipe', () => {
    const recipe = recipes.saveRecipe({
      workspaceId: wsId,
      name: 'Financial Analysis Pipeline',
      description: 'Research, analyze, and report on financial documents',
      requiredCapabilities: ['rag_retrieve', 'ollama_generate'],
      agentGroupTemplate: {
        mode: 'pipeline',
        agents: [
          { role: 'Research', instruction: 'Research financial data' },
          { role: 'Analyst', instruction: 'Analyze the findings' },
          { role: 'Reporter', instruction: 'Generate final report' },
        ],
      },
      policyRequirements: {
        defaultRoute: 'local',
        dataClassification: 'Confidential',
      },
    });

    expect(recipe.id).toBeTruthy();
    expect(recipe.name).toBe('Financial Analysis Pipeline');
    expect(recipe.trusted).toBe(true);
  });

  it('should list recipes', () => {
    const list = recipes.listRecipes(wsId);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0].name).toBe('Financial Analysis Pipeline');
  });

  it('should retrieve a recipe by id', () => {
    const list = recipes.listRecipes(wsId);
    const recipe = recipes.getRecipe(list[0].id);
    expect(recipe).toBeDefined();
    expect(recipe!.requiredCapabilities).toContain('rag_retrieve');
  });
});

describe('A2ABridge', () => {
  const testDir = path.join(os.tmpdir(), `ogra-a2a-test-${Date.now()}`);
  let db: DatabaseService;
  let auditService: AuditService;
  let policyService: PolicyService;
  let bridge: A2ABridge;
  let wsId: string;

  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });
    db = new DatabaseService(testDir);
    auditService = new AuditService();
    policyService = new PolicyService(auditService);
    bridge = new A2ABridge(db, policyService, auditService);
    const ws = db.createWorkspace('A2A Test', WorkspaceType.Personal, DataClassification.Internal);
    wsId = ws.id;
  });

  afterAll(() => {
    db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should accept and process an A2A task', async () => {
    const result = await bridge.acceptTask({
      taskId: 'a2a_task_001',
      agentId: 'external_agent',
      query: 'Analyze the market trends for Q3 2026',
      sessionId: 'session_abc',
    });

    expect(result.status).toBe('completed');
    expect(result.result).toContain('A2A task');
    expect(result.routeDecisionId).toBeTruthy();
  });
});
