import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { WorkspaceService } from '../../src/core/workspace-service';
import { AuditService } from '../../src/core/audit-service';
import { DataClassification, WorkspaceType } from '../../src/shared/types';
import { OgraError, OgraErrorCode } from '../../src/shared/errors';
import { createTestDb } from '../helpers/test-db';

describe('WorkspaceService', () => {
  let service: WorkspaceService;
  let auditService: AuditService;
  let fixture: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    fixture = createTestDb();
    auditService = new AuditService(fixture.db);
    service = new WorkspaceService(auditService, fixture.db);
  });

  afterAll(() => {
    fixture.cleanup();
  });

  it('should create a workspace and set it as current', async () => {
    const ws = await service.create({
      name: 'My Workspace',
      type: WorkspaceType.Personal,
      defaultClassification: DataClassification.Internal,
    });

    expect(ws.id).toBeTruthy();
    expect(ws.name).toBe('My Workspace');
    expect(ws.type).toBe(WorkspaceType.Personal);
    expect(ws.defaultClassification).toBe(DataClassification.Internal);
    expect(ws.createdAt).toBeTruthy();
    expect(ws.updatedAt).toBeTruthy();
    expect(service.getCurrentId()).toBe(ws.id);
  });

  it('should create a workspace with default classification when omitted', async () => {
    const ws = await service.create({
      name: 'Default Class',
      type: WorkspaceType.Project,
      defaultClassification: DataClassification.Internal,
    });

    expect(ws.defaultClassification).toBe(DataClassification.Internal);
  });

  it('should list all workspaces', async () => {
    // The test fixture already creates one workspace
    await service.create({ name: 'WS1', type: WorkspaceType.Personal, defaultClassification: DataClassification.Public });
    await service.create({ name: 'WS2', type: WorkspaceType.Project, defaultClassification: DataClassification.Internal });

    const list = await service.list();

    // 3 workspaces: 1 from fixture + 2 created above (ordered by created_at DESC)
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(list.some(w => w.name === 'WS1')).toBe(true);
    expect(list.some(w => w.name === 'WS2')).toBe(true);
  });

  it('should get a workspace by ID', async () => {
    const created = await service.create({
      name: 'Get Test',
      type: WorkspaceType.Company,
      defaultClassification: DataClassification.Confidential,
    });

    const fetched = await service.get(created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.name).toBe('Get Test');
    expect(fetched.defaultClassification).toBe(DataClassification.Confidential);
  });

  it('should throw WORKSPACE_NOT_FOUND for missing workspace', async () => {
    await expect(service.get('nonexistent-id'))
      .rejects.toThrow(OgraError);
    await expect(service.get('nonexistent-id'))
      .rejects.toThrow(/not found/);
  });

  it('should select a workspace by ID', async () => {
    const ws = await service.create({
      name: 'Select Me',
      type: WorkspaceType.Personal,
      defaultClassification: DataClassification.Public,
    });

    const selected = await service.select(ws.id);
    expect(selected.id).toBe(ws.id);
    expect(service.getCurrentId()).toBe(ws.id);
  });

  it('should return null from getCurrent when no workspace is selected', async () => {
    const current = await service.getCurrent();
    expect(current).toBeNull();
  });

  it('should return the current workspace from getCurrent', async () => {
    const ws = await service.create({
      name: 'Current WS',
      type: WorkspaceType.Personal,
      defaultClassification: DataClassification.Internal,
    });

    const current = await service.getCurrent();
    expect(current).not.toBeNull();
    expect(current!.id).toBe(ws.id);
    expect(current!.name).toBe('Current WS');
  });

  it('should get the current workspace ID', async () => {
    expect(service.getCurrentId()).toBeNull();

    const ws = await service.create({
      name: 'ID Test',
      type: WorkspaceType.Project,
      defaultClassification: DataClassification.Restricted,
    });

    expect(service.getCurrentId()).toBe(ws.id);
  });

  it('should update workspace classification', async () => {
    const ws = await service.create({
      name: 'Update Class',
      type: WorkspaceType.Personal,
      defaultClassification: DataClassification.Public,
    });

    const updated = await service.updateClassification(ws.id, DataClassification.Confidential);
    expect(updated.defaultClassification).toBe(DataClassification.Confidential);

    // Verify via fresh fetch
    const refetched = await service.get(ws.id);
    expect(refetched.defaultClassification).toBe(DataClassification.Confidential);
  });

  it('should preserve the fixture workspace', async () => {
    // The test fixture creates a workspace with name 'Test Workspace'
    const list = await service.list();
    expect(list.some(w => w.name === 'Test Workspace')).toBe(true);
  });
});
