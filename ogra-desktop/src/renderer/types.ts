/**
 * OgraAPI type matching the preload bridge in electron/preload/preload.ts.
 * Re-exported here so renderer code can reference it without depending on
 * the Electron runtime context directly.
 */

/** Common IPC result shape returned by most backend handlers. */
export interface IpcError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface IpcResult<T = any> {
  success: boolean;
  data?: T;
  error?: IpcError;
}

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

declare global {
  interface Window {
    ogra: OgraAPI;
  }
}
