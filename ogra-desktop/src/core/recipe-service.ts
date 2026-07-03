import { DatabaseService } from './database-service';
import * as crypto from 'crypto';

export interface Recipe {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  requiredCapabilities: string[];
  agentGroupTemplate: any;
  policyRequirements: any;
  source: string;
  trusted: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Recipe service — save and reuse workflow templates.
 */
export class RecipeService {
  constructor(private db: DatabaseService) {}

  saveRecipe(recipe: {
    workspaceId: string;
    name: string;
    description: string;
    requiredCapabilities: string[];
    agentGroupTemplate: any;
    policyRequirements: any;
  }): Recipe {
    const id = `recipe_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    this.db.getRawDB().prepare(`
      INSERT INTO recipes (id, workspace_id, name, description, required_capabilities_json,
        agent_group_template_json, policy_requirements_json, source, trusted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'local', 1, ?, ?)
    `).run(id, recipe.workspaceId, recipe.name, recipe.description,
      JSON.stringify(recipe.requiredCapabilities),
      JSON.stringify(recipe.agentGroupTemplate),
      JSON.stringify(recipe.policyRequirements),
      now, now);

    return this.getRecipe(id)!;
  }

  getRecipe(id: string): Recipe | null {
    const row = this.db.getRawDB().prepare('SELECT * FROM recipes WHERE id = ?').get(id) as any;
    if (!row) return null;
    return this.toRecipe(row);
  }

  listRecipes(workspaceId: string): Recipe[] {
    const rows = this.db.getRawDB().prepare(
      'SELECT * FROM recipes WHERE workspace_id = ? ORDER BY updated_at DESC'
    ).all(workspaceId) as any[];
    return rows.map(r => this.toRecipe(r));
  }

  private toRecipe(row: any): Recipe {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      description: row.description || '',
      requiredCapabilities: JSON.parse(row.required_capabilities_json || '[]'),
      agentGroupTemplate: JSON.parse(row.agent_group_template_json || '{}'),
      policyRequirements: JSON.parse(row.policy_requirements_json || '{}'),
      source: row.source || 'local',
      trusted: row.trusted === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ---- Self-Build Process (Phase 8) ----

  /**
   * Find recipes that provide all of the requested capabilities.
   */
  findRecipesByCapability(workspaceId: string, requiredCapabilities: string[]): Recipe[] {
    const all = this.listRecipes(workspaceId);
    return all.filter(r =>
      requiredCapabilities.every(c => r.requiredCapabilities.includes(c))
    );
  }

  /**
   * Analyze the gap between capabilities a task requires and
   * what the workspace's existing agents and recipes provide.
   */
  analyzeCapabilityGap(
    workspaceId: string,
    requiredCapabilities: string[],
    existingAgentCapabilities: string[],
  ): {
    missingCapabilities: string[];
    matchingRecipes: Recipe[];
    fillRate: number; // 0.0 to 1.0
  } {
    const missing = requiredCapabilities.filter(c => !existingAgentCapabilities.includes(c));
    const matchingRecipes = this.findRecipesByCapability(workspaceId, missing);
    const fillRate = missing.length === 0
      ? 1.0
      : (requiredCapabilities.length - missing.length) / requiredCapabilities.length;

    return { missingCapabilities: missing, matchingRecipes, fillRate };
  }

  /**
   * Record a self-build recommendation with user decision.
   */
  recordSelfBuildDecision(params: {
    runId?: string;
    workspaceId: string;
    missingCapability: string;
    candidateRecipeIds: string[];
    candidateAgentIds: string[];
    rationale: string;
    decision: 'pending' | 'accepted' | 'rejected';
  }): void {
    const id = `sbr_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    this.db.getRawDB().prepare(`
      INSERT INTO self_build_recommendations
        (id, run_id, workspace_id, missing_capability,
         candidate_recipe_ids_json, candidate_agent_ids_json,
         rationale, decision, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, params.runId || null, params.workspaceId, params.missingCapability,
      JSON.stringify(params.candidateRecipeIds),
      JSON.stringify(params.candidateAgentIds),
      params.rationale, params.decision,
      params.decision !== 'pending' ? now : null,
    );
  }
}
