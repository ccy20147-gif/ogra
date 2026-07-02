# Ogra Alpha - 完整 UI 拼装开发计划 (Phase 5)

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 将 React UI 与后端的 Orchestrator 连通，实现从导入文件夹到对话并查看审计结果的完整 Alpha Demo 流。

**Architecture:** 
通过 `electron/main-ipc.ts` 暴露 Agent 的 `ask` 方法和 RAG 的 `index` 方法给渲染进程。React 组件管理对话流状态并渲染。

---

## Task 5.1: 扩展 IPC 接口以支持 RAG 索引与 Agent 查询 (TDD)
**Objective:** 在 Main 进程中实例化 Database 和 Agent，并通过 IPC 暴露给 Frontend。

**Files:**
- Create: `tests/electron/agent-ipc.test.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/main-ipc.ts`

**Step 1: Write failing test**
Create: `tests/electron/agent-ipc.test.ts`
```typescript
import { describe, it, expect, vi } from 'vitest';
import { setupIpcHandlers } from '../../electron/main-ipc';
import { initDB } from '../../src/database/index';

const ipcMainMock = { handle: vi.fn() };
vi.mock('electron', () => ({ ipcMain: ipcMainMock }));

describe('Agent IPC Handlers', () => {
  it('should register agent:ask and rag:index handlers', () => {
    const db = initDB(':memory:');
    setupIpcHandlers(db);
    expect(ipcMainMock.handle).toHaveBeenCalledWith('agent:ask', expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith('rag:index', expect.any(Function));
  });
});
```

**Step 2: Run test to verify failure**
Run: `npx vitest run tests/electron/agent-ipc.test.ts`
Expected: FAIL (because we haven't added these to main-ipc.ts yet)

**Step 3: Write minimal implementation**
Modify: `electron/preload.ts`
```typescript
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('ograAPI', {
  initWorkspace: (name: string) => ipcRenderer.invoke('workspace:init', name),
  getWorkspaces: () => ipcRenderer.invoke('workspace:list'),
  indexFolder: (workspaceId: string, folderPath: string, classification: string) => 
    ipcRenderer.invoke('rag:index', workspaceId, folderPath, classification),
  askAgent: (query: string) => ipcRenderer.invoke('agent:ask', query)
});
```

Modify: `electron/main-ipc.ts` (Append to existing)
```typescript
import { ipcMain } from 'electron';
import Database from 'better-sqlite3';
import { RAGIndexer } from '../src/engine/rag';
import { InternalAgent } from '../src/engine/agent';
import { OllamaAdapter } from '../src/adapters/ollama';

export function setupIpcHandlers(db: Database.Database) {
  // ... existing handlers (workspace:init, workspace:list) ...
  ipcMain.handle('workspace:init', async (_event, name: string) => {
    const id = Date.now().toString();
    const stmt = db.prepare('INSERT INTO workspaces (id, name) VALUES (?, ?)');
    stmt.run(id, name);
    return id;
  });

  ipcMain.handle('workspace:list', async () => {
    const stmt = db.prepare('SELECT * FROM workspaces');
    return stmt.all();
  });

  const indexer = new RAGIndexer(db);
  const ollama = new OllamaAdapter('http://localhost:11434', 'qwen');
  const agent = new InternalAgent(db, ollama);

  ipcMain.handle('rag:index', async (_event, workspaceId: string, folderPath: string, classification: string) => {
    indexer.indexFolder(workspaceId, folderPath, classification);
    return { success: true };
  });

  ipcMain.handle('agent:ask', async (_event, query: string) => {
    return await agent.ask(query);
  });
}
```

**Step 4: Run test to verify pass**
Run: `npx vitest run tests/electron/agent-ipc.test.ts`
Expected: PASS

**Step 5: Commit**
```bash
git add tests/electron/ electron/
git commit -m "feat: expose RAG and Agent APIs via IPC"
```

---

## Task 5.2: 组装主聊天界面 (Main App UI) (TDD)
**Objective:** 编写 `App.tsx`，将 Sidebar（控制 RAG 导入）和主聊天流结合。

**Files:**
- Create: `tests/ui/App.test.tsx`
- Create: `src/App.tsx`

**Step 1: Write failing test**
Create: `tests/ui/App.test.tsx`
```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import App from '../../src/App';
import React from 'react';

// Mock window.ograAPI
(global.window as any).ograAPI = {
  askAgent: vi.fn().mockResolvedValue({
    answer: 'Mock answer',
    routeDecision: { isDowngraded: true, route: 'local-only' },
    contexts: []
  }),
  indexFolder: vi.fn().mockResolvedValue({ success: true })
};

describe('App Integration', () => {
  it('should send message and display response with audit shield', async () => {
    render(<App />);
    
    const input = screen.getByPlaceholderText('Ask Ogra...');
    fireEvent.change(input, { target: { value: 'test query' } });
    fireEvent.click(screen.getByText('Send'));

    await waitFor(() => {
      expect(screen.getByText('Mock answer')).toBeDefined();
      expect(screen.getByText(/为保护机密数据/)).toBeDefined(); // Downgrade warning
      expect(screen.getByText('Audit Trail')).toBeDefined(); // Shield button
    });
  });
});
```

**Step 2: Run test to verify failure**
Run: `npx vitest run tests/ui/App.test.tsx --environment jsdom`
Expected: FAIL — Cannot find module '../../src/App'

**Step 3: Write minimal implementation**
Create: `src/App.tsx`
```tsx
import React, { useState } from 'react';
import { ChatMessage } from './components/ChatMessage';
import { AuditShield } from './components/AuditShield';

export default function App() {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<any[]>([]);
  const [folderPath, setFolderPath] = useState('');
  const [indexing, setIndexing] = useState(false);

  const handleIndex = async () => {
    setIndexing(true);
    // Hardcoded workspace 'ws_1' and classification 'Confidential' for Alpha Demo
    await (window as any).ograAPI.indexFolder('ws_1', folderPath, 'Confidential');
    setIndexing(false);
    alert('Indexed successfully as Confidential!');
  };

  const handleSend = async () => {
    if (!input.trim()) return;
    const userQuery = input;
    setMessages(prev => [...prev, { role: 'user', content: userQuery }]);
    setInput('');

    try {
      const result = await (window as any).ograAPI.askAgent(userQuery);
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: result.answer,
        isDowngraded: result.routeDecision.isDowngraded,
        routeDecision: result.routeDecision
      }]);
    } catch (err: any) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err.message}` }]);
    }
  };

  return (
    <div className="flex h-screen bg-white text-sm">
      {/* Sidebar for Indexing */}
      <div className="w-64 border-r bg-gray-50 p-4">
        <h2 className="font-bold mb-4">Workspace (Alpha)</h2>
        <div className="mb-2">
          <label className="block text-xs text-gray-500 mb-1">Folder Path:</label>
          <input 
            type="text" 
            className="w-full border rounded p-1"
            value={folderPath}
            onChange={e => setFolderPath(e.target.value)}
            placeholder="/path/to/markdowns"
          />
        </div>
        <button 
          onClick={handleIndex}
          disabled={indexing}
          className="bg-blue-600 text-white w-full rounded p-1 hover:bg-blue-700"
        >
          {indexing ? 'Indexing...' : 'Index as Confidential'}
        </button>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col relative">
        <div className="flex-1 overflow-y-auto p-4 pb-24">
          {messages.map((msg, i) => (
            <div key={i} className="mb-4">
              <ChatMessage 
                role={msg.role} 
                content={msg.content} 
                isDowngraded={msg.isDowngraded} 
              />
              {msg.role === 'assistant' && msg.routeDecision && (
                <AuditShield 
                  route={msg.routeDecision.route} 
                  cloudCalls={0} 
                />
              )}
            </div>
          ))}
        </div>

        {/* Input Area */}
        <div className="absolute bottom-0 left-0 right-0 p-4 bg-white border-t">
          <div className="flex">
            <input 
              type="text" 
              className="flex-1 border rounded-l p-2"
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="Ask Ogra..."
              onKeyDown={e => e.key === 'Enter' && handleSend()}
            />
            <button 
              onClick={handleSend}
              className="bg-blue-600 text-white rounded-r px-4"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

**Step 4: Run test to verify pass**
Run: `npx vitest run tests/ui/App.test.tsx --environment jsdom`
Expected: PASS

**Step 5: Commit**
```bash
git add tests/ui/ src/App.tsx
git commit -m "feat: assemble main App UI with RAG indexing and Agent chat flow"
```
EOF