import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { DatabaseService } from '../../src/core/database-service';
import { RecipeService } from '../../src/core/recipe-service';
import { A2ABridge } from '../../src/core/a2a-bridge';
import { PolicyService } from '../../src/core/policy-service';
import { AuditService } from '../../src/core/audit-service';
import { DataClassification, WorkspaceType } from '../../src/shared/types';

describe('RecipeService', () => {
  const testDir = path.join(os.tmpdir(), `ogra-recipe-test-${Date.now()}`);
  let db: DatabaseService;
  let recipes: RecipeService;
  let wsId: string;

  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });
    db = new DatabaseService(testDir);
    recipes = new RecipeService(db);
    const ws = db.createWorkspace('Recipe Test', WorkspaceType.Project, DataClassification.Internal);
    wsId = ws.id;
  });

  afterAll(() => {
    db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
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

  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });
    db = new DatabaseService(testDir);
    auditService = new AuditService();
    policyService = new PolicyService(auditService);
    bridge = new A2ABridge(db, policyService, auditService);
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
