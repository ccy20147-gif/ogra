import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannel, IpcResult } from '../../src/shared/ipc-channels';

/**
 * Typed preload bridge for Ogra Desktop.
 *
 * Exposes a minimal `window.ogra` API through contextBridge.
 * All IPC calls go through typed channel names. No generic
 * ipcRenderer.send or channel access is exposed.
 */

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
    const listeners = progressListeners.get(channel);
    if (!listeners) return;
    listeners.delete(callback);
    // Clean up ipcRenderer listener when no more callbacks remain
    if (listeners.size === 0) {
      ipcRenderer.removeAllListeners(channel);
      progressListeners.delete(channel);
    }
  };
}

// Expose typed API
contextBridge.exposeInMainWorld('ogra', {
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
    createId: (req: { workspaceId: string; task: string }) => ipcRenderer.invoke(IpcChannel.RunCreateId, req),
  },
  // Approval API (Sequence 0 Plan 03 §3.6)
  approval: {
    request: (req: { runId: string; workspaceId: string; approvalType: string;
                       requestedScope: Record<string, unknown>; reason?: string }) =>
      ipcRenderer.invoke(IpcChannel.ApprovalRequest, req),
    decision: (req: { approvalId: string; runId: string; workspaceId: string;
                        decision: 'approved' | 'denied'; decidedBy?: string;
                        reason?: string }) =>
      ipcRenderer.invoke(IpcChannel.ApprovalDecision, req),
    list: (workspaceId: string) =>
      ipcRenderer.invoke(IpcChannel.ApprovalList, { workspaceId }),
  },
  // Route decision
  route: {
    fetch: (runId: string) => ipcRenderer.invoke(IpcChannel.RouteDecisionFetch, runId),
  },
  // Audit
  audit: {
    events: (runId: string, limit?: number, offset?: number) =>
      ipcRenderer.invoke(IpcChannel.AuditEventFetch, { runId, limit, offset }),
    export: (format: string) => ipcRenderer.invoke(IpcChannel.AuditExport, format),
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
    update: (req: unknown) => ipcRenderer.invoke(IpcChannel.ProviderUpdate, req),
    testConnection: (id: string) => ipcRenderer.invoke(IpcChannel.ProviderConnectTest, id),
  },
  // Secrets
  secret: {
    list: () => ipcRenderer.invoke(IpcChannel.SecretList),
    create: (req: unknown) => ipcRenderer.invoke(IpcChannel.SecretCreate, req),
    update: (req: unknown) => ipcRenderer.invoke(IpcChannel.SecretUpdate, req),
    delete: (id: string) => ipcRenderer.invoke(IpcChannel.SecretDelete, id),
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
    create: (req: unknown) => Promise<IpcResult>;
    list: () => Promise<IpcResult>;
    select: (id: string) => Promise<IpcResult>;
    updateClassification: (workspaceId: string, classification: string) => Promise<IpcResult>;
  };
  folder: {
    import: (req: unknown) => Promise<IpcResult>;
    validate: (path: string) => Promise<IpcResult>;
  };
  indexing: {
    start: (kbId: string) => Promise<IpcResult>;
    status: (kbId: string) => Promise<IpcResult>;
    cancel: (kbId: string) => Promise<IpcResult>;
  };
  run: {
    start: (req: unknown) => Promise<IpcResult>;
    status: (runId: string) => Promise<IpcResult>;
    cancel: (runId: string) => Promise<IpcResult>;
  };
  approval: {
    request: (req: { runId: string; workspaceId: string; approvalType: string;
                       requestedScope: Record<string, unknown>; reason?: string }) =>
      Promise<IpcResult>;
    decision: (req: { approvalId: string; runId: string; workspaceId: string;
                        decision: 'approved' | 'denied'; decidedBy?: string;
                        reason?: string }) => Promise<IpcResult>;
    list: (workspaceId: string) => Promise<IpcResult>;
  };
  route: {
    fetch: (runId: string) => Promise<IpcResult>;
  };
  audit: {
    events: (runId: string, limit?: number, offset?: number) => Promise<IpcResult>;
    export: (format: string) => Promise<IpcResult>;
  };
  dataSafety: {
    summary: (workspaceId: string) => Promise<IpcResult>;
    cloudCalls: (workspaceId: string) => Promise<IpcResult>;
  };
  governance: {
    runRisk: (runId: string) => Promise<IpcResult>;
  };
  provider: {
    list: () => Promise<IpcResult>;
    update: (req: unknown) => Promise<IpcResult>;
    testConnection: (id: string) => Promise<IpcResult>;
  };
  secret: {
    list: () => Promise<IpcResult>;
    create: (req: unknown) => Promise<IpcResult>;
    update: (req: unknown) => Promise<IpcResult>;
    delete: (id: string) => Promise<IpcResult>;
  };
  policy: {
    dryRun: (input: unknown) => Promise<IpcResult>;
    list: () => Promise<IpcResult>;
  };
  knowledge: {
    listBases: (workspaceId: string) => Promise<IpcResult>;
  };
  onIndexingProgress: (callback: (data: unknown) => void) => () => void;
}
