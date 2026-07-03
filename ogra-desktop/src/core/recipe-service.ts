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
}
