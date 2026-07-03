import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import { ALLOWED_IPC_CHANNELS, IpcChannel, IpcResult, RunStartRequest, SecretCreateRequest } from '../../src/shared/ipc-channels';
import { OgraErrorCode, OgraError } from '../../src/shared/errors';
import { OgraCore } from '../../src/core/index';
import { OgraSecretBroker } from '../../src/core/secret-broker';
import { PolicyEvaluationInput } from '../../src/core/policy-service';

let mainWindow: BrowserWindow | null = null;
let ograCore: OgraCore | null = null;
let secretBroker: OgraSecretBroker | null = null;

const isDev = !app.isPackaged;
const APP_DATA_DIR = path.join(app.getPath('appData'), 'Ogra');

function ensureAppDataDir(): void {
  if (!fs.existsSync(APP_DATA_DIR)) {
    fs.mkdirSync(APP_DATA_DIR, { recursive: true });
  }
}

function validateIpcChannel(channel: string): void {
  if (!ALLOWED_IPC_CHANNELS.includes(channel)) {
    throw new OgraError(
      OgraErrorCode.IPC_CHANNEL_REJECTED,
      `IPC channel "${channel}" is not allowed`,
    );
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    title: 'Ogra Desktop',
    show: false,
  });

  // Load renderer
  const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
  if (isDev) {
    mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'bottom' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/renderer/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Restricted navigation
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isDev && url.startsWith('http://localhost:5173')) return;
    if (!isDev && url.startsWith('file://')) return;
    event.preventDefault();
  });

  // Restricted window.open — global handler at 'web-contents-created' covers all windows

  // Content Security Policy — production has stricter connect-src
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const csp = isDev
      ? "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:* http://localhost:*; img-src 'self' data:; font-src 'self' data:;"
      : "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self';";
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}

// ---- IPC Handler Setup ----

function registerIpcHandlers(): void {
  if (!ograCore || !secretBroker) {
    throw new OgraError(OgraErrorCode.INTERNAL_ERROR, 'OgraCore not initialized before IPC handler registration');
  }

  /**
   * Type-safe IPC handler that:
   * 1. Validates the channel name
   * 2. Validates caller context for mutation operations
   * 3. Wraps all responses in IpcResult<T> (success/error)
   * 4. Catches all errors and returns structured error responses
   */
  function registerHandler<T>(
    channel: string,
    handler: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => Promise<T>,
    options?: { requiresCaller?: boolean; argCount?: number },
  ): void {
    ipcMain.handle(channel, async (event: Electron.IpcMainInvokeEvent, ...args: any[]): Promise<IpcResult<T>> => {
      try {
        validateIpcChannel(channel);

        // Validate argument count to catch mismatched IPC calls
        const expectedArgs = options?.argCount ?? 0;
        if (expectedArgs > 0 && args.length < expectedArgs) {
          return {
            success: false,
            error: { code: OgraErrorCode.INVALID_ARGUMENT, message: `Expected ${expectedArgs} arguments, got ${args.length}` },
          };
        }

        if (options?.requiresCaller !== false) {
          validateCallerContext(event);
        }

        const data = await handler(event, ...args);
        return { success: true as const, data };
      } catch (err) {
        if (err instanceof OgraError) {
          return { success: false, error: { code: err.code, message: err.message } };
        }
        const message = (err as Error)?.message || 'Unknown IPC error';
        return { success: false, error: { code: OgraErrorCode.INTERNAL_ERROR, message } };
      }
    });
  }

  // Workspace handlers
  registerHandler(
    IpcChannel.WorkspaceCreate,
    async (_event, req: any) => {
      const { name, type, defaultClassification } = req || {};
      if (!name || typeof name !== 'string') {
        throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, 'Workspace name is required');
      }
      return ograCore!.workspaceService.create({ name, type, defaultClassification });
    },
    { argCount: 1 },
  );

  registerHandler(
    IpcChannel.WorkspaceList,
    async () => ograCore!.workspaceService.list(),
    { requiresCaller: false },
  );

  registerHandler(
    IpcChannel.WorkspaceSelect,
    async (_event, workspaceId: string) => {
      if (typeof workspaceId !== 'string') {
        throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, 'workspaceId is required');
      }
      return ograCore!.workspaceService.select(workspaceId);
    },
    { argCount: 1 },
  );

  registerHandler(
    IpcChannel.WorkspaceUpdateClassification,
    async (_event, req: any) => {
      const { workspaceId, classification } = req || {};
      if (!workspaceId) throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, 'workspaceId is required');
      return ograCore!.workspaceService.updateClassification(workspaceId, classification);
    },
    { argCount: 1 },
  );

  // Folder import
  registerHandler(
    IpcChannel.FolderImport,
    async (_event, req: any) => {
      if (!req || !req.folderPath || typeof req.folderPath !== 'string') {
        throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, 'folderPath is required');
      }
      const valid = await ograCore!.pathValidator.validateImportPath(req.folderPath);
      if (!valid.isValid) {
        return { success: false as const, error: { code: OgraErrorCode.INVALID_PATH, message: valid.reason! } };
      }
      return ograCore!.knowledgeService.importFolder(req);
    },
    { argCount: 1 },
  );

  registerHandler(
    IpcChannel.FolderValidate,
    async (_event, folderPath: string) => {
      if (typeof folderPath !== 'string') {
        throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, 'folderPath is required');
      }
      return ograCore!.pathValidator.validateImportPath(folderPath);
    },
    { argCount: 1 },
  );

  // Indexing
  registerHandler(
    IpcChannel.IndexingStart,
    async (_event, knowledgeBaseId: string) => {
      if (typeof knowledgeBaseId !== 'string') {
        throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, 'knowledgeBaseId is required');
      }
      return ograCore!.knowledgeService.startIndexing(knowledgeBaseId);
    },
    { argCount: 1 },
  );

  registerHandler(
    IpcChannel.IndexingStatus,
    async (_event, knowledgeBaseId: string) => {
      if (typeof knowledgeBaseId !== 'string') {
        throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, 'knowledgeBaseId is required');
      }
      return ograCore!.knowledgeService.getIndexingStatus(knowledgeBaseId);
    },
    { argCount: 1, requiresCaller: false },
  );

  registerHandler(
    IpcChannel.IndexingCancel,
    async (_event, knowledgeBaseId: string) => {
      if (typeof knowledgeBaseId !== 'string') {
        throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, 'knowledgeBaseId is required');
      }
      return ograCore!.knowledgeService.cancelIndexing(knowledgeBaseId);
    },
    { argCount: 1 },
  );

  // Run
  registerHandler(
    IpcChannel.RunStart,
    async (_event, req: RunStartRequest) => {
      if (!req) throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, 'Run request body is required');
      return ograCore!.runService.startRun(req);
    },
    { argCount: 1 },
  );

  registerHandler(
    IpcChannel.RunStatus,
    async (_event, runId: string) => {
      if (typeof runId !== 'string') throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, 'runId is required');
      return ograCore!.runService.getStatus(runId);
    },
    { argCount: 1, requiresCaller: false },
  );

  registerHandler(
    IpcChannel.RunCancel,
    async (_event, runId: string) => {
      if (typeof runId !== 'string') throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, 'runId is required');
      return ograCore!.runService.cancelRun(runId);
    },
    { argCount: 1 },
  );

  // Route Decision
  registerHandler(
    IpcChannel.RouteDecisionFetch,
    async (_event, runId: string) => {
      if (typeof runId !== 'string') throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, 'runId is required');
      return ograCore!.routeService.getRouteDecision(runId);
    },
    { argCount: 1, requiresCaller: false },
  );

  // Audit
  registerHandler(
    IpcChannel.AuditEventFetch,
    async (_event, req: any) => {
      if (!req || !req.runId) throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, 'runId is required in request');
      return ograCore!.auditService.getEvents(req.runId, req.limit, req.offset);
    },
    { argCount: 1, requiresCaller: false },
  );

  // Data Safety
  registerHandler(
    IpcChannel.DataSafetySummary,
    async (_event, workspaceId: string) => {
      if (typeof workspaceId !== 'string') throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, 'workspaceId is required');
      return ograCore!.dataSafetyService.getSummary(workspaceId);
    },
    { argCount: 1, requiresCaller: false },
  );

  registerHandler(
    IpcChannel.DataSafetyCloudCalls,
    async (_event, workspaceId: string) => {
      if (typeof workspaceId !== 'string') throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, 'workspaceId is required');
      return ograCore!.dataSafetyService.getCloudCalls(workspaceId);
    },
    { argCount: 1, requiresCaller: false },
  );

  // Governance
  registerHandler(
    IpcChannel.GovernanceRunRisk,
    async (_event, runId: string) => {
      if (typeof runId !== 'string') throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, 'runId is required');
      return ograCore!.governanceService.getRunRisk(runId);
    },
    { argCount: 1, requiresCaller: false },
  );

  // Provider
  registerHandler(
    IpcChannel.ProviderList,
    async () => ograCore!.providerService.list(),
    { requiresCaller: false },
  );

  registerHandler(
    IpcChannel.ProviderConnectTest,
    async (_event, providerId: string) => {
      if (typeof providerId !== 'string') throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, 'providerId is required');
      return ograCore!.providerService.testConnection(providerId);
    },
    { argCount: 1 },
  );

  // Provider Update (add or modify provider)
  registerHandler(
    IpcChannel.ProviderUpdate,
    async (_event, req: any) => {
      if (!req) throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, 'Provider update body is required');
      if (req.id) {
        return ograCore!.providerService.updateProvider(req.id, req.updates || req);
      }
      return ograCore!.providerService.addOpenAICompatible(req);
    },
    { argCount: 1 },
  );

  // Model List
  registerHandler(
    IpcChannel.ModelList,
    async () => {
      const result = await ograCore!.providerService.list();
      return result.models;
    },
    { requiresCaller: false },
  );

  // Secrets (via secret broker)
  registerHandler(
    IpcChannel.SecretList,
    async () => secretBroker!.listMetadata(),
    { requiresCaller: false },
  );

  registerHandler(
    IpcChannel.SecretCreate,
    async (_event, req: SecretCreateRequest) => {
      if (!req) throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, 'Secret body is required');
      return secretBroker!.create(req);
    },
    { argCount: 1 },
  );

  registerHandler(
    IpcChannel.SecretUpdate,
    async (_event, req: any) => {
      if (!req || !req.id) throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, 'Secret id and updates are required');
      await secretBroker!.update(req.id, req);
      return { success: true };
    },
    { argCount: 1 },
  );

  registerHandler(
    IpcChannel.SecretDelete,
    async (_event, id: string) => {
      if (typeof id !== 'string') throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, 'Secret id is required');
      await secretBroker!.delete(id);
      return { success: true };
    },
    { argCount: 1 },
  );

  // Policy
  registerHandler(
    IpcChannel.PolicyDryRun,
    async (_event, input: PolicyEvaluationInput) => {
      if (!input) throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, 'Policy dry-run input is required');
      return ograCore!.policyService.dryRun(input);
    },
    { argCount: 1 },
  );

  registerHandler(
    IpcChannel.PolicyList,
    async () => ograCore!.policyService.list(),
    { requiresCaller: false },
  );

  // Knowledge
  registerHandler(
    IpcChannel.KnowledgeBaseList,
    async (_event, workspaceId: string) => {
      if (typeof workspaceId !== 'string') throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, 'workspaceId is required');
      return ograCore!.knowledgeService.listBases(workspaceId);
    },
    { argCount: 1, requiresCaller: false },
  );
}

function validateCallerContext(event: Electron.IpcMainInvokeEvent): void {
  // Main process validates that the caller is from the correct renderer
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    throw new OgraError(OgraErrorCode.PERMISSION_DENIED, 'Caller is not the main renderer');
  }
}

// ---- Shell open restrictions ----
// Only these URLs may open in external browser via shell.openExternal
const ALLOWED_EXTERNAL_URLS = [
  'https://github.com/ccy20147-gif/ogra',
  'https://ogra-desktop.dev',
];

app.on('web-contents-created', (_event, contents) => {
  // Allow external URLs from the allowlist via shell.openExternal
  contents.setWindowOpenHandler(({ url }) => {
    for (const allowedUrl of ALLOWED_EXTERNAL_URLS) {
      if (url.startsWith(allowedUrl)) {
        shell.openExternal(url);
        return { action: 'deny' }; // deny window, already opened externally
      }
    }
    // Block all other popups
    return { action: 'deny' };
  });

  contents.on('will-navigate', (navEvent, url) => {
    if (isDev && url.startsWith('http://localhost:5173')) return;
    if (!isDev && url.startsWith('file://')) return;
    navEvent.preventDefault();
  });
});

app.on('before-quit', () => {
  ograCore?.shutdown();
});

// ---- App Lifecycle ----

app.whenReady().then(async () => {
  ensureAppDataDir();

  // Initialize secret broker
  secretBroker = new OgraSecretBroker(APP_DATA_DIR);

  // Initialize Ogra Core
  ograCore = new OgraCore({
    appDataDir: APP_DATA_DIR,
    secretBroker,
    isDev,
  });

  await ograCore.initialize();

  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Security: Disable remote module — deprecated in Electron 28, no-op for safety
// @ts-expect-error - remote events may not exist in all Electron versions
app.on('remote-get-global', (event: any) => {
  event.preventDefault();
});
// @ts-expect-error
app.on('remote-get-current-window', (event: any) => {
  event.preventDefault();
});
// @ts-expect-error
app.on('remote-get-current-web-contents', (event: any) => {
  event.preventDefault();
});
