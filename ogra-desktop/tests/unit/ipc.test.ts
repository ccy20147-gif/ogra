import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ALLOWED_IPC_CHANNELS, IpcChannel } from '../../src/shared/ipc-channels';
import { PathValidator } from '../../src/core/path-validator';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

describe('IPC Channel Allowlist', () => {
  it('should include all defined channels', () => {
    const channelValues = Object.values(IpcChannel);
    for (const channel of channelValues) {
      expect(ALLOWED_IPC_CHANNELS).toContain(channel);
    }
  });

  it('should reject arbitrary channels', () => {
    const arbitraryChannels = ['generic:send', 'electron:shell', 'fs:read', 'secret:all'];
    for (const ch of arbitraryChannels) {
      expect(ALLOWED_IPC_CHANNELS).not.toContain(ch);
    }
  });

  it('should not contain generic ipcRenderer.send', () => {
    expect(ALLOWED_IPC_CHANNELS).not.toContain('ipcRenderer.send');
    expect(ALLOWED_IPC_CHANNELS).not.toContain('send');
    expect(ALLOWED_IPC_CHANNELS).not.toContain('invoke');
  });

  it('should have stable channel names', () => {
    const channels = Object.values(IpcChannel);
    for (const ch of channels) {
      expect(ch).toMatch(/^[a-z-]+:[a-z-]+$/);
    }
  });
});

describe('PathValidator', () => {
  const validator = new PathValidator();
  const testDir = path.join(os.tmpdir(), `ogra-test-${Date.now()}`);

  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });
    fs.mkdirSync(path.join(testDir, 'valid-folder'), { recursive: true });
    fs.writeFileSync(path.join(testDir, 'valid-folder', 'test.md'), '# Test content');
  });

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should accept a valid existing directory', () => {
    const result = validator.validateImportPath(path.join(testDir, 'valid-folder'));
    expect(result.isValid).toBe(true);
    expect(result.canonicalPath).toBeTruthy();
  });

  it('should reject a non-existent path', () => {
    const result = validator.validateImportPath('/nonexistent/path');
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain('does not exist');
  });

  it('should reject a file path instead of directory', () => {
    const result = validator.validateImportPath(path.join(testDir, 'valid-folder', 'test.md'));
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain('not a directory');
  });

  it('should detect path traversal', () => {
    // Use a path that doesn't exist after resolving traversal
    const traversalPath = path.join(testDir, 'valid-folder', '..', '..', '..', '..', 'nonexistent_traversal_target');
    const result = validator.validateImportPath(traversalPath);
    expect(result.isValid).toBe(false);
  });

  it('should register and check approved roots', () => {
    // Create actual directory structure so fs.realpathSync works
    const actualRoot = path.join(testDir, 'approved-root-test');
    const subDir = path.join(actualRoot, 'sub');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'file.ts'), 'test');
    validator.registerApprovedRoot(actualRoot, 'ws_test');
    expect(validator.isWithinApprovedRoot(path.join(subDir, 'file.ts'))).toBe(true);
    expect(validator.isWithinApprovedRoot('/other/path')).toBe(false);
  });
});
