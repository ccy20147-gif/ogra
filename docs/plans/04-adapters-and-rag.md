# Ogra Alpha - 连接与适配层开发计划 (Phase 4)

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 实现 RAG 文档切片索引、本地 Ollama 模型适配器，以及串联整个数据流的核心 Orchestrator (Internal Agent)。

**Architecture:** 
Node.js 运行时执行环境。利用 SQLite FTS5 存储切片，原生的 `fetch` 调用 Ollama。

---

## Task 4.1: 实现基础 RAG Indexer (TDD)
**Objective:** 读取指定的本地 TXT/Markdown 文件夹，对内容按段落进行基础切片 (Chunking)，并连同所属工作空间的 classification 一并存入 `document_chunks`。

**Files:**
- Create: `tests/engine/rag.test.ts`
- Create: `src/engine/rag.ts`

**Step 1: Write failing test**
Create: `tests/engine/rag.test.ts`
```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initDB } from '../../src/database/index';
import { RAGIndexer } from '../../src/engine/rag';
import Database from 'better-sqlite3';
import fs from 'fs';

vi.mock('fs');

describe('RAG Indexer', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDB(':memory:');
    db.exec("INSERT INTO workspaces (id, name, default_classification) VALUES ('ws_1', 'Test', 'Confidential')");
  });

  it('should chunk and index file content into FTS5', () => {
    vi.spyOn(fs, 'readdirSync').mockReturnValue(['test.md'] as any);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('Line 1\n\nLine 2');
    vi.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => false } as any);

    const indexer = new RAGIndexer(db);
    indexer.indexFolder('ws_1', '/fake/path', 'Confidential');

    const chunks = db.prepare('SELECT * FROM document_chunks').all() as any[];
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].classification).toBe('Confidential');
    expect(chunks[0].content).toContain('Line 1');
  });
});
```

**Step 2: Run test to verify failure**
Run: `npx vitest run tests/engine/rag.test.ts`
Expected: FAIL — Cannot find module '../../src/engine/rag'

**Step 3: Write minimal implementation**
Create: `src/engine/rag.ts`
```typescript
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export class RAGIndexer {
  constructor(private db: Database.Database) {}

  indexFolder(workspaceId: string, folderPath: string, classification: string) {
    const files = fs.readdirSync(folderPath);
    
    const insertDoc = this.db.prepare('INSERT INTO documents (id, workspace_id, file_path, classification) VALUES (?, ?, ?, ?)');
    const insertChunk = this.db.prepare('INSERT INTO document_chunks (document_id, content, classification) VALUES (?, ?, ?)');

    for (const file of files) {
      const fullPath = path.join(folderPath, file);
      if (fs.statSync(fullPath).isDirectory()) continue;
      if (!fullPath.endsWith('.md') && !fullPath.endsWith('.txt')) continue;

      const docId = crypto.randomUUID();
      insertDoc.run(docId, workspaceId, fullPath, classification);

      const content = fs.readFileSync(fullPath, 'utf-8');
      // Minimal naive chunker for Alpha: split by double newline
      const chunks = content.split('\n\n').filter(c => c.trim().length > 0);
      
      for (const chunk of chunks) {
        insertChunk.run(docId, chunk.trim(), classification);
      }
    }
  }

  search(query: string, limit: number = 3) {
    const stmt = this.db.prepare(`
      SELECT document_id, content, classification 
      FROM document_chunks 
      WHERE content MATCH ? 
      ORDER BY rank LIMIT ?
    `);
    // simple FTS5 syntax wrap
    return stmt.all(`"${query}"`, limit);
  }
}
```

**Step 4: Run test to verify pass**
Run: `npx vitest run tests/engine/rag.test.ts`
Expected: PASS

**Step 5: Commit**
```bash
git add tests/engine/rag.test.ts src/engine/rag.ts
git commit -m "feat: implement basic RAG Indexer and FTS5 search"
```

---

## Task 4.2: 实现 Ollama 本地模型适配器 (TDD)
**Objective:** 编写简单的 HTTP Client 请求本地 Ollama 的 API (`/api/generate`)。

**Files:**
- Create: `tests/adapters/ollama.test.ts`
- Create: `src/adapters/ollama.ts`

**Step 1: Write failing test**
Create: `tests/adapters/ollama.test.ts`
```typescript
import { describe, it, expect, vi } from 'vitest';
import { OllamaAdapter } from '../../src/adapters/ollama';

// Mock global fetch
global.fetch = vi.fn();

describe('Ollama Adapter', () => {
  it('should call ollama api and return text', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ response: 'Hello from local LLM' })
    });

    const adapter = new OllamaAdapter('http://localhost:11434', 'qwen');
    const result = await adapter.generate('Say hi');
    
    expect(result).toBe('Hello from local LLM');
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/generate',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('Say hi')
      })
    );
  });
});
```

**Step 2: Run test to verify failure**
Run: `npx vitest run tests/adapters/ollama.test.ts`
Expected: FAIL — Cannot find module '../../src/adapters/ollama'

**Step 3: Write minimal implementation**
Create: `src/adapters/ollama.ts`
```typescript
export class OllamaAdapter {
  constructor(private baseUrl: string = 'http://localhost:11434', private model: string = 'qwen') {}

  async generate(prompt: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt: prompt,
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.response;
  }
}
```

**Step 4: Run test to verify pass**
Run: `npx vitest run tests/adapters/ollama.test.ts`
Expected: PASS

**Step 5: Commit**
```bash
git add tests/adapters/ src/adapters/
git commit -m "feat: implement local Ollama API adapter"
```

---

## Task 4.3: 实现 Internal Agent Orchestrator (TDD)
**Objective:** 将 RAG、Policy、Audit 和 Model 组合在一起。由于 Alpha 专注于本地降级，我们将验证拦截流程。

**Files:**
- Create: `tests/engine/agent.test.ts`
- Create: `src/engine/agent.ts`

**Step 1: Write failing test**
Create: `tests/engine/agent.test.ts`
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InternalAgent } from '../../src/engine/agent';
import { initDB } from '../../src/database/index';
import Database from 'better-sqlite3';

describe('Internal Agent Orchestrator', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDB(':memory:');
    // Prepare fake FTS5 data
    db.exec(`INSERT INTO document_chunks (document_id, content, classification) VALUES ('doc1', 'Secret Key 123', 'Confidential')`);
  });

  it('should route to local model when confidential data is retrieved', async () => {
    const mockModel = { generate: vi.fn().mockResolvedValue('Local Answer') };
    const agent = new InternalAgent(db, mockModel as any);
    
    const result = await agent.ask('What is the key?');
    
    expect(result.answer).toBe('Local Answer');
    expect(result.routeDecision.isDowngraded).toBe(true);
    expect(result.routeDecision.route).toBe('local-only');
    expect(mockModel.generate).toHaveBeenCalled();
    
    // Check audit log was written
    const logs = db.prepare('SELECT * FROM run_events').all();
    expect(logs.length).toBe(1);
  });
});
```

**Step 2: Run test to verify failure**
Run: `npx vitest run tests/engine/agent.test.ts`
Expected: FAIL — Cannot find module '../../src/engine/agent'

**Step 3: Write minimal implementation**
Create: `src/engine/agent.ts`
```typescript
import Database from 'better-sqlite3';
import { RAGIndexer } from './rag';
import { evaluateRoute } from './policy';
import { AuditLogger } from './audit';
import crypto from 'crypto';

export class InternalAgent {
  private rag: RAGIndexer;
  private audit: AuditLogger;

  constructor(private db: Database.Database, private localModel: any) {
    this.rag = new RAGIndexer(db);
    this.audit = new AuditLogger(db);
  }

  async ask(query: string) {
    const runId = crypto.randomUUID();
    
    // 1. Retrieve
    const contexts = this.rag.search(query, 3) as any[];
    const classifications = contexts.map(c => c.classification);
    
    // 2. Policy Engine Evaluation (High-Water Mark)
    const routeDecision = evaluateRoute(classifications);
    
    if (routeDecision.route === 'blocked') {
      this.audit.log(runId, 'request_blocked', 'blocked');
      throw new Error(`Request blocked: ${routeDecision.reason}`);
    }

    // 3. Assemble Prompt
    const contextText = contexts.map(c => c.content).join('\n---\n');
    const prompt = `Context:\n${contextText}\n\nQuestion: ${query}`;

    // 4. Model Call (Always use local for Alpha Demo to guarantee 0 cloud calls on downgrade)
    const answer = await this.localModel.generate(prompt);

    // 5. Audit Logging
    this.audit.log(runId, 'generation_complete', routeDecision.route, 'local_hash_placeholder');

    return {
      answer,
      routeDecision,
      contexts
    };
  }
}
```

**Step 4: Run test to verify pass**
Run: `npx vitest run tests/engine/agent.test.ts`
Expected: PASS

**Step 5: Commit**
```bash
git add tests/engine/agent.test.ts src/engine/agent.ts
git commit -m "feat: implement Internal Agent orchestrator with routing and audit"
```