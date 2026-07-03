import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import { ALLOWED_IPC_CHANNELS, IpcChannel, IpcResult } from '../../src/shared/ipc-channels';
import { OgraErrorCode, OgraError } from '../../src/shared/errors';
import { OgraCore } from '../../src/core/index';
import { OgraSecretBroker } from '../../src/core/secret-broker';

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
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
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

  // Restricted window.open
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Content Security Policy
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:* http://localhost:*; img-src 'self' data:; font-src 'self' data:;",
        ],
      },
    });
  });
}

// ---- IPC Handler Setup ----

function registerIpcHandlers(): void {
  if (!ograCore || !secretBroker) {
    throw new Error('OgraCore not initialized before IPC handler registration');
  }

  // Safe wrapper that validates channel and caller context
  function registerHandler<T>(channel: string, handler: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<T>): void {
    ipcMain.handle(channel, async (event, ...args) => {
      validateIpcChannel(channel);
      return handler(event, ...args);
    });
  }

  // Workspace handlers
  registerHandler(IpcChannel.WorkspaceCreate, async (_event, req: any) => {
    validateCallerContext(_event);
    const { name, type, defaultClassification } = req;
    return ograCore!.workspaceService.create({ name, type, defaultClassification });
  });

  ipcMain.handle(IpcChannel.WorkspaceList, async () => {
    return ograCore!.workspaceService.list();
  });

  ipcMain.handle(IpcChannel.WorkspaceSelect, async (_event, workspaceId: string) => {
    validateCallerContext(_event);
    return ograCore!.workspaceService.select(workspaceId);
  });

  ipcMain.handle(IpcChannel.WorkspaceUpdateClassification, async (_event, { workspaceId, classification }) => {
    validateCallerContext(_event);
    return ograCore!.workspaceService.updateClassification(workspaceId, classification);
  });

  // Folder import
  ipcMain.handle(IpcChannel.FolderImport, async (_event, req) => {
    validateCallerContext(_event);
    // Validate path first
    const valid = await ograCore!.pathValidator.validateImportPath(req.folderPath);
    if (!valid.isValid) {
      return { success: false, error: { code: OgraErrorCode.INVALID_PATH, message: valid.reason! } };
    }
    return ograCore!.knowledgeService.importFolder(req);
  });

  ipcMain.handle(IpcChannel.FolderValidate, async (_event, folderPath: string) => {
    return ograCore!.pathValidator.validateImportPath(folderPath);
  });

  // Indexing
  ipcMain.handle(IpcChannel.IndexingStart, async (_event, knowledgeBaseId: string) => {
    validateCallerContext(_event);
    return ograCore!.knowledgeService.startIndexing(knowledgeBaseId);
  });

  ipcMain.handle(IpcChannel.IndexingStatus, async (_event, knowledgeBaseId: string) => {
    return ograCore!.knowledgeService.getIndexingStatus(knowledgeBaseId);
  });

  ipcMain.handle(IpcChannel.IndexingCancel, async (_event, knowledgeBaseId: string) => {
    validateCallerContext(_event);
    return ograCore!.knowledgeService.cancelIndexing(knowledgeBaseId);
  });

  // Run
  ipcMain.handle(IpcChannel.RunStart, async (_event, req) => {
    validateCallerContext(_event);
    return ograCore!.runService.startRun(req);
  });

  ipcMain.handle(IpcChannel.RunStatus, async (_event, runId: string) => {
    return ograCore!.runService.getStatus(runId);
  });

  ipcMain.handle(IpcChannel.RunCancel, async (_event, runId: string) => {
    validateCallerContext(_event);
    return ograCore!.runService.cancelRun(runId);
  });

  // Route Decision
  ipcMain.handle(IpcChannel.RouteDecisionFetch, async (_event, runId: string) => {
    return ograCore!.routeService.getRouteDecision(runId);
  });

  // Audit
  ipcMain.handle(IpcChannel.AuditEventFetch, async (_event, { runId, limit, offset }) => {
    return ograCore!.auditService.getEvents(runId, limit, offset);
  });

  // Data Safety
  ipcMain.handle(IpcChannel.DataSafetySummary, async (_event, workspaceId: string) => {
    return ograCore!.dataSafetyService.getSummary(workspaceId);
  });

  ipcMain.handle(IpcChannel.DataSafetyCloudCalls, async (_event, workspaceId: string) => {
    return ograCore!.dataSafetyService.getCloudCalls(workspaceId);
  });

  // Governance
  ipcMain.handle(IpcChannel.GovernanceRunRisk, async (_event, runId: string) => {
    return ograCore!.governanceService.getRunRisk(runId);
  });

  // Provider
  ipcMain.handle(IpcChannel.ProviderList, async () => {
    return ograCore!.providerService.list();
  });

  ipcMain.handle(IpcChannel.ProviderConnectTest, async (_event, providerId: string) => {
    validateCallerContext(_event);
    return ograCore!.providerService.testConnection(providerId);
  });

  // Secrets (via secret broker)
  ipcMain.handle(IpcChannel.SecretList, async () => {
    return secretBroker!.listMetadata();
  });

  ipcMain.handle(IpcChannel.SecretCreate, async (_event, req) => {
    validateCallerContext(_event);
    return secretBroker!.create(req);
  });

  // Policy
  ipcMain.handle(IpcChannel.PolicyDryRun, async (_event, input) => {
    validateCallerContext(_event);
    return ograCore!.policyService.dryRun(input);
  });

  ipcMain.handle(IpcChannel.PolicyList, async () => {
    return ograCore!.policyService.list();
  });

  // Knowledge
  ipcMain.handle(IpcChannel.KnowledgeBaseList, async (_event, workspaceId: string) => {
    return ograCore!.knowledgeService.listBases(workspaceId);
  });
}

function validateCallerContext(event: Electron.IpcMainInvokeEvent): void {
  // Main process validates that the caller is from the correct renderer
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    throw new OgraError(OgraErrorCode.PERMISSION_DENIED, 'Caller is not the main renderer');
  }
}

// ---- Shell open restrictions ----
const ALLOWED_EXTERNAL_PROTOCOLS = ['https:', 'mailto:'];

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));

  contents.on('will-navigate', (navEvent, url) => {
    if (isDev && url.startsWith('http://localhost:5173')) return;
    if (!isDev && url.startsWith('file://')) return;
    navEvent.preventDefault();
  });
});

// Allowlisted shell.openExternal
const allowlistedExternalUrls = [
  'https://github.com/ccy20147-gif/ogra',
  'https://ogra-desktop.dev',
];

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
