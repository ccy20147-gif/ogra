import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannel } from '../../src/shared/ipc-channels';
import { ALLOWED_IPC_CHANNELS } from '../../src/shared/ipc-channels';

/**
 * Typed preload bridge for Ogra Desktop.
 *
 * Exposes a minimal `window.ogra` API through contextBridge.
 * All IPC calls go through typed channel names. No generic
 * ipcRenderer.send or channel access is exposed.
 */

// Build a typed invocation helper only for allowed channels
const api: Record<string, (...args: unknown[]) => Promise<unknown>> = {};

for (const channel of ALLOWED_IPC_CHANNELS) {
  api[channel.replace(':', '_')] = (...args: unknown[]) => {
    return ipcRenderer.invoke(channel, ...args);
  };
}

// Progress event subscriptions (approved streams only)
const progressListeners = new Map<string, Set<(data: unknown) => void>>();

const ALLOWED_PROGRESS_CHANNELS: readonly string[] = [
  IpcChannel.IndexingProgress,
];

function subscribeProgress(channel: string, callback: (data: unknown) => void): () => void {
  if (!ALLOWED_PROGRESS_CHANNELS.includes(channel)) {
    throw new Error(`Progress channel "${channel}" is not allowed`);
  }

  if (!progressListeners.has(channel)) {
    progressListeners.set(channel, new Set());
    ipcRenderer.on(channel, (_event, data) => {
      const listeners = progressListeners.get(channel);
      if (listeners) {
        for (const cb of listeners) {
          cb(data);
        }
      }
    });
  }

  progressListeners.get(channel)!.add(callback);

  return () => {
    progressListeners.get(channel)?.delete(callback);
  };
}

// Expose typed API
contextBridge.exposeInMainWorld('ogra', {
  ...api,
  // Indexing progress subscription
  onIndexingProgress: (callback: (data: unknown) => void) => subscribeProgress(IpcChannel.IndexingProgress, callback),
  // Workspace API
  workspace: {
    create: (req: unknown) => ipcRenderer.invoke(IpcChannel.WorkspaceCreate, req),
    list: () => ipcRenderer.invoke(IpcChannel.WorkspaceList),
    select: (id: string) => ipcRenderer.invoke(IpcChannel.WorkspaceSelect, id),
    updateClassification: (workspaceId: string, classification: string) =>
      ipcRenderer.invoke(IpcChannel.WorkspaceUpdateClassification, { workspaceId, classification }),
  },
  // Folder API
  folder: {
    import: (req: unknown) => ipcRenderer.invoke(IpcChannel.FolderImport, req),
    validate: (path: string) => ipcRenderer.invoke(IpcChannel.FolderValidate, path),
  },
  // Indexing API
  indexing: {
    start: (kbId: string) => ipcRenderer.invoke(IpcChannel.IndexingStart, kbId),
    status: (kbId: string) => ipcRenderer.invoke(IpcChannel.IndexingStatus, kbId),
    cancel: (kbId: string) => ipcRenderer.invoke(IpcChannel.IndexingCancel, kbId),
  },
  // Run API
  run: {
    start: (req: unknown) => ipcRenderer.invoke(IpcChannel.RunStart, req),
    status: (runId: string) => ipcRenderer.invoke(IpcChannel.RunStatus, runId),
    cancel: (runId: string) => ipcRenderer.invoke(IpcChannel.RunCancel, runId),
  },
  // Route decision
  route: {
    fetch: (runId: string) => ipcRenderer.invoke(IpcChannel.RouteDecisionFetch, runId),
  },
  // Audit
  audit: {
    events: (runId: string, limit?: number, offset?: number) =>
      ipcRenderer.invoke(IpcChannel.AuditEventFetch, { runId, limit, offset }),
  },
  // Data Safety
  dataSafety: {
    summary: (workspaceId: string) => ipcRenderer.invoke(IpcChannel.DataSafetySummary, workspaceId),
    cloudCalls: (workspaceId: string) => ipcRenderer.invoke(IpcChannel.DataSafetyCloudCalls, workspaceId),
  },
  // Governance
  governance: {
    runRisk: (runId: string) => ipcRenderer.invoke(IpcChannel.GovernanceRunRisk, runId),
  },
  // Providers
  provider: {
    list: () => ipcRenderer.invoke(IpcChannel.ProviderList),
    testConnection: (id: string) => ipcRenderer.invoke(IpcChannel.ProviderConnectTest, id),
  },
  // Secrets
  secret: {
    list: () => ipcRenderer.invoke(IpcChannel.SecretList),
    create: (req: unknown) => ipcRenderer.invoke(IpcChannel.SecretCreate, req),
  },
  // Policy
  policy: {
    dryRun: (input: unknown) => ipcRenderer.invoke(IpcChannel.PolicyDryRun, input),
    list: () => ipcRenderer.invoke(IpcChannel.PolicyList),
  },
  // Knowledge
  knowledge: {
    listBases: (workspaceId: string) => ipcRenderer.invoke(IpcChannel.KnowledgeBaseList, workspaceId),
  },
});

// Type declaration for renderer
export interface OgraAPI {
  workspace: {
    create: (req: unknown) => Promise<unknown>;
    list: () => Promise<unknown>;
    select: (id: string) => Promise<unknown>;
    updateClassification: (workspaceId: string, classification: string) => Promise<unknown>;
  };
  folder: {
    import: (req: unknown) => Promise<unknown>;
    validate: (path: string) => Promise<unknown>;
  };
  indexing: {
    start: (kbId: string) => Promise<unknown>;
    status: (kbId: string) => Promise<unknown>;
    cancel: (kbId: string) => Promise<unknown>;
  };
  run: {
    start: (req: unknown) => Promise<unknown>;
    status: (runId: string) => Promise<unknown>;
    cancel: (runId: string) => Promise<unknown>;
  };
  route: {
    fetch: (runId: string) => Promise<unknown>;
  };
  audit: {
    events: (runId: string, limit?: number, offset?: number) => Promise<unknown>;
  };
  dataSafety: {
    summary: (workspaceId: string) => Promise<unknown>;
    cloudCalls: (workspaceId: string) => Promise<unknown>;
  };
  governance: {
    runRisk: (runId: string) => Promise<unknown>;
  };
  provider: {
    list: () => Promise<unknown>;
    testConnection: (id: string) => Promise<unknown>;
  };
  secret: {
    list: () => Promise<unknown>;
    create: (req: unknown) => Promise<unknown>;
  };
  policy: {
    dryRun: (input: unknown) => Promise<unknown>;
    list: () => Promise<unknown>;
  };
  knowledge: {
    listBases: (workspaceId: string) => Promise<unknown>;
  };
  onIndexingProgress: (callback: (data: unknown) => void) => () => void;
}
