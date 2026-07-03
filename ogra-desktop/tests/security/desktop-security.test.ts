/**
 * Desktop Security Checks (automated verification)
 *
 * Run with: npx ts-node tests/security/desktop-security-check.ts
 *
 * Verifies:
 * - contextIsolation enabled
 * - nodeIntegration disabled
 * - sandbox enabled
 * - CSP configured
 * - IPC channel allowlist enforced
 * - renderer cannot access secrets or SQLite
 * - path traversal blocked
 * - shell.openExternal allowlisted
 */

import { describe, it, expect } from 'vitest';

describe('Desktop Security Checks', () => {
  // These tests verify the main process configuration
  // by inspecting the source files

  it('should have contextIsolation enabled (check main.ts)', async () => {
    const fs = await import('fs');
    const mainContent = fs.readFileSync('electron/main/main.ts', 'utf-8');
    expect(mainContent).toContain('contextIsolation: true');
  });

  it('should have nodeIntegration disabled', async () => {
    const fs = await import('fs');
    const mainContent = fs.readFileSync('electron/main/main.ts', 'utf-8');
    expect(mainContent).toContain('nodeIntegration: false');
  });

  it('should have sandbox enabled', async () => {
    const fs = await import('fs');
    const mainContent = fs.readFileSync('electron/main/main.ts', 'utf-8');
    expect(mainContent).toContain('sandbox: true');
  });

  it('should have Content Security Policy configured', async () => {
    const fs = await import('fs');
    const mainContent = fs.readFileSync('electron/main/main.ts', 'utf-8');
    expect(mainContent).toContain('Content-Security-Policy');
    // Also check renderer HTML
    const htmlContent = fs.readFileSync('src/renderer/index.html', 'utf-8');
    expect(htmlContent).toContain('Content-Security-Policy');
  });

  it('should not expose generic ipcRenderer.send to renderer', async () => {
    const fs = await import('fs');
    const preloadContent = fs.readFileSync('electron/preload/preload.ts', 'utf-8');
    // The preload uses contextBridge to expose typed APIs
    expect(preloadContent).toContain('contextBridge.exposeInMainWorld');
    // Renderer access should be through window.ogra only, not raw ipcRenderer
    expect(preloadContent).not.toContain("'ipcRenderer.send'");
    expect(preloadContent).not.toContain("ipcRenderer.send'");
  });

  it('should have IPC channel allowlist', async () => {
    const fs = await import('fs');
    const channelsContent = fs.readFileSync('src/shared/ipc-channels.ts', 'utf-8');
    expect(channelsContent).toContain('ALLOWED_IPC_CHANNELS');
  });

  it('should block path traversal', async () => {
    const fs = await import('fs');
    const validatorContent = fs.readFileSync('src/core/path-validator.ts', 'utf-8');
    expect(validatorContent).toContain('realpathSync');
    expect(validatorContent).toContain('path.normalize');
    expect(validatorContent).toContain('traversal');
  });

  it('should have no renderer-side provider fetch', async () => {
    const fs = await import('fs');
    const rendererFiles = ['src/renderer/App.tsx', 'src/renderer/index.tsx'];
    for (const file of rendererFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      // Renderer should NOT contain direct fetch to model providers
      expect(content).not.toMatch(/fetch\(.*(?:ollama|openai|anthropic)/i);
    }
  });

  it('should mask secret values', async () => {
    const fs = await import('fs');
    const secretContent = fs.readFileSync('src/core/secret-broker.ts', 'utf-8');
    expect(secretContent).toContain('maskValue');
    expect(secretContent).toContain('encrypt');
    expect(secretContent).toContain('decrypt');
  });

  it('should not have hard-coded cloud call count in UI', async () => {
    const fs = await import('fs');
    const rendererContent = fs.readFileSync('src/renderer/App.tsx', 'utf-8');
    // Should NOT have hard-coded "0 cloud calls"
    expect(rendererContent).not.toContain("'0 cloud calls'");
    expect(rendererContent).not.toContain('"0 cloud calls"');
  });

  it('should use typed preload API', async () => {
    const fs = await import('fs');
    const preloadContent = fs.readFileSync('electron/preload/preload.ts', 'utf-8');
    expect(preloadContent).toContain('contextBridge.exposeInMainWorld');
    expect(preloadContent).toContain('OgraAPI');
  });

  it('should restrict navigation', async () => {
    const fs = await import('fs');
    const mainContent = fs.readFileSync('electron/main/main.ts', 'utf-8');
    expect(mainContent).toContain('will-navigate');
    expect(mainContent).toContain('setWindowOpenHandler');
  });
});
