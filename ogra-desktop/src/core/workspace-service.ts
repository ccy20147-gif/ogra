import { DatabaseService } from './database-service';
import { AuditService } from './audit-service';
import { DataClassification, RunEventType, WorkspaceType } from '../shared/types';
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
 * Workspace management service — persists to SQLite via DatabaseService.
 */
export class WorkspaceService {
  private currentWorkspaceId: string | null = null;

  constructor(
    private auditService: AuditService,
    private db: DatabaseService,
  ) {}

  async create(req: {
    name: string;
    type: WorkspaceType;
    defaultClassification: DataClassification;
  }): Promise<WorkspaceRecord> {
    const row = this.db.createWorkspace(
      req.name,
      req.type,
      req.defaultClassification || DataClassification.Internal,
    );
    this.currentWorkspaceId = row.id;
    // Record audit event for workspace creation
    await this.auditService.appendEvent({
      runId: 'system',
      workspaceId: row.id,
      eventType: RunEventType.WorkspaceCreated,
      eventPayload: {
        workspaceId: row.id,
        name: row.name,
        type: row.type,
        classification: row.default_data_classification,
      },
    });
    return this.rowToRecord(row);
  }

  async list(): Promise<WorkspaceRecord[]> {
    return this.db.listWorkspaces().map(r => this.rowToRecord(r));
  }

  async select(id: string): Promise<WorkspaceRecord> {
    const ws = await this.get(id);
    this.currentWorkspaceId = id;
    return ws;
  }

  async get(id: string): Promise<WorkspaceRecord> {
    const row = this.db.getWorkspace(id);
    if (!row) throw new OgraError(OgraErrorCode.WORKSPACE_NOT_FOUND, `Workspace ${id} not found`);
    return this.rowToRecord(row);
  }

  async getCurrent(): Promise<WorkspaceRecord | null> {
    if (!this.currentWorkspaceId) return null;
    return this.get(this.currentWorkspaceId);
  }

  async updateClassification(workspaceId: string, classification: DataClassification): Promise<WorkspaceRecord> {
    this.db.updateWorkspaceClassification(workspaceId, classification);
    return this.get(workspaceId);
  }

  getCurrentId(): string | null {
    return this.currentWorkspaceId;
  }

  private rowToRecord(row: any): WorkspaceRecord {
    return {
      id: row.id,
      name: row.name,
      type: row.type as WorkspaceType,
      defaultClassification: row.default_data_classification as DataClassification,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
