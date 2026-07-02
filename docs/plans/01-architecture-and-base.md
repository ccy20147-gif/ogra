# Ogra Alpha - 架构蓝图与开发计划 (Phase 1)

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 构建 Ogra Desktop Alpha 版本的核心“端云透明路由与本地轻量审计”闭环。

**Architecture:** 
采用 Electron (React/Vite) 架构。Renderer (前端) 负责交互、组件状态与数据可视化；Main (主进程) 负责 IPC 桥接、权限控制；Ogra Core (本地核心) 负责路由策略与审计日志写入。核心业务逻辑由 SQLite 持久化，RAG 采用基于 FTS5 的轻量级实现。

**Tech Stack:** 
- 前端：React 18, TypeScript, Vite, Tailwind CSS, Lucide React (图标)
- 桌面端：Electron, IPC (Preload contextBridge)
- 存储：SQLite (better-sqlite3), FTS5
- 测试：Vitest

---

## Task 1.1: 初始化 Node.js 基础依赖与配置
**Objective:** 搭建最基础的 `package.json` 并安装测试脚手架 (Vitest)，确保 TDD 环境就绪。

**Files:**
- Create: `package.json`

**Step 1: Write initial configuration**
Run this command to initialize project:
```bash
npm init -y
npm install --save-dev typescript @types/node vitest
```

**Step 2: Setup minimal TS config**
Create: `tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ESNext",
    "useDefineForClassFields": true,
    "lib": ["DOM", "DOM.Iterable", "ESNext"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "moduleResolution": "Node",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["src", "electron", "tests"]
}
```

**Step 3: Run quick sanity test**
Run: `npx vitest run --passWithNoTests`
Expected: Passes with no tests found.

**Step 4: Commit**
```bash
git add package.json package-lock.json tsconfig.json
git commit -m "chore: init node project with typescript and vitest"
```

---

## Task 1.2: 设计 SQLite 核心表结构 (TDD)
**Objective:** 定义并实现支撑 Workspace 和 Document 存储的底层数据模型，确保 FTS5 与外键生效。

**Files:**
- Create: `tests/database/schema.test.ts`
- Create: `src/database/schema.ts`
- Create: `src/database/index.ts`

**Step 1: Write failing test**
Create: `tests/database/schema.test.ts`
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA } from '../../src/database/schema';
import { initDB } from '../../src/database/index';

describe('Database Schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    // Use in-memory DB for tests
    db = new Database(':memory:');
    db.exec(SCHEMA);
  });

  it('should create workspaces and documents tables', () => {
    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workspaces', 'documents')").all();
    expect(tableCheck.length).toBe(2);
  });

  it('should create FTS5 virtual table for chunks', () => {
    const ftsCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='document_chunks'").get();
    expect(ftsCheck).toBeDefined();
  });
});
```

**Step 2: Run test to verify failure**
Run: `npm install better-sqlite3 && npm install --save-dev @types/better-sqlite3 && npx vitest run tests/database/schema.test.ts`
Expected: FAIL — Cannot find module '../../src/database/schema'

**Step 3: Write minimal implementation**
Create: `src/database/schema.ts`
```typescript
export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    default_classification TEXT DEFAULT 'Public'
  );

  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    file_path TEXT NOT NULL,
    classification TEXT NOT NULL,
    indexed_at DATETIME,
    FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
  );
  
  CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks USING fts5(
    document_id,
    content,
    classification
  );

  CREATE TABLE IF NOT EXISTS run_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_hash TEXT,
    route_decision TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;
```

Create: `src/database/index.ts`
```typescript
import Database from 'better-sqlite3';
import { SCHEMA } from './schema';
import path from 'path';

export function initDB(dbPath: string = ':memory:') {
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  return db;
}
```

**Step 4: Run test to verify pass**
Run: `npx vitest run tests/database/schema.test.ts`
Expected: PASS

**Step 5: Commit**
```bash
git add src/database/ tests/database/ package.json package-lock.json
git commit -m "feat: init sqlite database and schema with FTS5"
```

---

## Task 1.3: 实现主进程与渲染进程的安全 IPC 桥接 (TDD)
**Objective:** 通过 contextBridge 暴露安全的 API 给前端，并实现后端的 ipcMain.handle 监听，跑通双向通信测试。

**Files:**
- Create: `tests/electron/ipc.test.ts`
- Create: `electron/preload.ts`
- Create: `electron/main-ipc.ts`

**Step 1: Write failing test (Mocking IPC)**
Create: `tests/electron/ipc.test.ts`
```typescript
import { describe, it, expect, vi } from 'vitest';
import { setupIpcHandlers } from '../../electron/main-ipc';
import { initDB } from '../../src/database/index';

// Mock electron ipcMain
const ipcMainMock = {
  handle: vi.fn(),
};
vi.mock('electron', () => ({
  ipcMain: ipcMainMock
}));

describe('IPC Handlers', () => {
  it('should register workspace:init handler', () => {
    const db = initDB(':memory:');
    setupIpcHandlers(db);
    expect(ipcMainMock.handle).toHaveBeenCalledWith('workspace:init', expect.any(Function));
  });
});
```

**Step 2: Run test to verify failure**
Run: `npx vitest run tests/electron/ipc.test.ts`
Expected: FAIL — Cannot find module '../../electron/main-ipc'

**Step 3: Write minimal implementation**
Create: `electron/preload.ts`
```typescript
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('ograAPI', {
  initWorkspace: (name: string) => ipcRenderer.invoke('workspace:init', name),
  getWorkspaces: () => ipcRenderer.invoke('workspace:list'),
});
```

Create: `electron/main-ipc.ts`
```typescript
import { ipcMain } from 'electron';
import Database from 'better-sqlite3';

export function setupIpcHandlers(db: Database.Database) {
  ipcMain.handle('workspace:init', async (_event, name: string) => {
    const id = Date.now().toString(); // simple ID generation for Alpha
    const stmt = db.prepare('INSERT INTO workspaces (id, name) VALUES (?, ?)');
    stmt.run(id, name);
    return id;
  });

  ipcMain.handle('workspace:list', async () => {
    const stmt = db.prepare('SELECT * FROM workspaces');
    return stmt.all();
  });
}
```

**Step 4: Run test to verify pass**
Run: `npx vitest run tests/electron/ipc.test.ts`
Expected: PASS

**Step 5: Commit**
```bash
git add electron/ tests/electron/
git commit -m "feat: implement secure IPC bridge and main handlers"
```
