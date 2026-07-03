/**
 * Renderer Smoke Tests
 *
 * Verifies that all UI components can be imported without errors.
 * This is a basic smoke test to ensure no module resolution failures.
 *
 * Note: Full DOM rendering tests require @testing-library/react setup
 * with jsdom environment, which is a planned enhancement (Beta+).
 */

import { describe, it, expect } from 'vitest';

describe('UI Component Smoke Tests', () => {
  it('should import App component', async () => {
    const mod = await import('../../src/renderer/App');
    expect(mod.default).toBeDefined();
  });

  it('should import WorkspaceOverviewTab', async () => {
    const mod = await import('../../src/renderer/components/WorkspaceOverviewTab');
    expect(mod.default).toBeDefined();
  });

  it('should import RunWorkspaceTab', async () => {
    const mod = await import('../../src/renderer/components/RunWorkspaceTab');
    expect(mod.default).toBeDefined();
  });

  it('should import KnowledgeBaseTab', async () => {
    const mod = await import('../../src/renderer/components/KnowledgeBaseTab');
    expect(mod.default).toBeDefined();
  });

  it('should import DataSafetyCenter', async () => {
    const mod = await import('../../src/renderer/components/DataSafetyCenter');
    expect(mod.DataSafetyCenter).toBeDefined();
  });

  it('should import AiGovernanceCenter', async () => {
    const mod = await import('../../src/renderer/components/AiGovernanceCenter');
    expect(mod.AiGovernanceCenter).toBeDefined();
  });

  it('should import SettingsTab', async () => {
    const mod = await import('../../src/renderer/components/SettingsTab');
    expect(mod.default).toBeDefined();
  });

  it('should import RouteTraceViewer', async () => {
    const mod = await import('../../src/renderer/components/RouteTraceViewer');
    expect(mod.RouteTraceViewer).toBeDefined();
  });
});
