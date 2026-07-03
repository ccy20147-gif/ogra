import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { OgraSecretBroker } from '../../src/core/secret-broker';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

describe('SecretBroker', () => {
  const testDir = path.join(os.tmpdir(), `ogra-test-secrets-${Date.now()}`);
  let broker: OgraSecretBroker;

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
    broker = new OgraSecretBroker(testDir);
  });

  afterAll(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  it('should create a secret and return masked value', async () => {
    const result = await broker.create({
      providerId: 'test-provider',
      value: 'sk-test-key-12345',
      displayName: 'Test Provider Key',
    });

    expect(result.id).toBeTruthy();
    expect(result.maskedValue).toContain('****');
    expect(result.maskedValue).not.toContain('sk-test-key-12345');
    expect(result.createdAt).toBeTruthy();
  });

  it('should retrieve the original value by provider ID', async () => {
    await broker.create({
      providerId: 'my-provider',
      value: 'secret-value-456',
      displayName: 'My Key',
    });

    const value = await broker.getValue('my-provider');
    expect(value).toBe('secret-value-456');
  });

  it('should return null for unknown provider', async () => {
    const value = await broker.getValue('nonexistent');
    expect(value).toBeNull();
  });

  it('should list metadata without exposing values', async () => {
    await broker.create({
      providerId: 'p1',
      value: 'super-secret',
      displayName: 'Provider 1',
    });

    const metadata = await broker.listMetadata();
    expect(metadata.length).toBe(1);
    expect(metadata[0].displayName).toBe('Provider 1');
    expect(metadata[0].maskedValue).not.toContain('super-secret');
    expect((metadata[0] as Record<string, unknown>).value).toBeUndefined();
  });

  it('should update a secret', async () => {
    const created = await broker.create({
      providerId: 'updatable',
      value: 'old-value',
      displayName: 'Old',
    });

    await broker.update(created.id, { displayName: 'Updated' });
    const metadata = await broker.listMetadata();
    expect(metadata[0].displayName).toBe('Updated');
  });

  it('should delete a secret', async () => {
    const created = await broker.create({
      providerId: 'deletable',
      value: 'delete-me',
      displayName: 'Delete Me',
    });

    await broker.delete(created.id);
    const metadata = await broker.listMetadata();
    expect(metadata.length).toBe(0);
  });

  it('should persist secrets across instances', async () => {
    await broker.create({
      providerId: 'persistent',
      value: 'persist-value',
      displayName: 'Persistent',
    });

    // Create a new broker instance pointing to same directory
    const broker2 = new OgraSecretBroker(testDir);
    const value = await broker2.getValue('persistent');
    expect(value).toBe('persist-value');
  });
});
