import { AuditService } from './audit-service';
import { DataClassification, WorkspaceType } from '../shared/types';
import { OgraError, OgraErrorCode } from '../shared/errors';

export interface WorkspaceRecord {
  id: string;
  name: string;
  type: WorkspaceType;
  defaultClassification: DataClassification;
  createdAt: string;
  updatedAt: string;
}

/**
 * Workspace management service.
 * Alpha uses in-memory storage. Plan 02 will migrate to SQLite.
 */
export class WorkspaceService {
  private workspaces: Map<string, WorkspaceRecord> = new Map();
  private currentWorkspaceId: string | null = null;

  constructor(private auditService: AuditService) {}

  async create(req: {
    name: string;
    type: WorkspaceType;
    defaultClassification: DataClassification;
  }): Promise<WorkspaceRecord> {
    const id = `ws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const workspace: WorkspaceRecord = {
      id,
      name: req.name,
      type: req.type,
      defaultClassification: req.defaultClassification || DataClassification.Internal,
      createdAt: now,
      updatedAt: now,
    };
    this.workspaces.set(id, workspace);
    this.currentWorkspaceId = id;
    return workspace;
  }

  async list(): Promise<WorkspaceRecord[]> {
    return Array.from(this.workspaces.values());
  }

  async select(id: string): Promise<WorkspaceRecord> {
    const ws = this.workspaces.get(id);
    if (!ws) throw new OgraError(OgraErrorCode.WORKSPACE_NOT_FOUND, `Workspace ${id} not found`);
    this.currentWorkspaceId = id;
    return ws;
  }

  async get(id: string): Promise<WorkspaceRecord> {
    const ws = this.workspaces.get(id);
    if (!ws) throw new OgraError(OgraErrorCode.WORKSPACE_NOT_FOUND, `Workspace ${id} not found`);
    return ws;
  }

  async getCurrent(): Promise<WorkspaceRecord | null> {
    if (!this.currentWorkspaceId) return null;
    return this.get(this.currentWorkspaceId);
  }

  async updateClassification(workspaceId: string, classification: DataClassification): Promise<WorkspaceRecord> {
    const ws = await this.get(workspaceId);
    ws.defaultClassification = classification;
    ws.updatedAt = new Date().toISOString();
    return ws;
  }

  getCurrentId(): string | null {
    return this.currentWorkspaceId;
  }
}
