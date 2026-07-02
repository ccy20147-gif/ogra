# Ogra Alpha - 核心引擎层开发计划 (Phase 2)

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 实现 Ogra 的透明路由策略引擎、本地轻量审计轨迹日志以及基于 FTS5 的 RAG 检索服务。

**Architecture:** 
运行于 Node.js (Main Process/Core) 层，负责处理数据流的路由判断，并保证审计事件（Audit Trail）以 Append-only 方式落盘。

---

## Task 2.1: 实现基于高水位原则的策略引擎 (TDD)
**Objective:** 编写 `PolicyEngine`，当输入数据标签包含 `Confidential` 时，强制路由降级为 `local-only`。

**Files:**
- Create: `tests/engine/policy.test.ts`
- Create: `src/engine/policy.ts`

**Step 1: Write failing test**
Create: `tests/engine/policy.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { evaluateRoute } from '../../src/engine/policy';

describe('Policy Engine', () => {
  it('should route to cloud for Public data', () => {
    const decision = evaluateRoute(['Public']);
    expect(decision.route).toBe('cloud');
    expect(decision.isDowngraded).toBe(false);
  });

  it('should downgrade to local-only for Confidential data (High-Water Mark)', () => {
    // Mixed chunks, one is Confidential
    const decision = evaluateRoute(['Public', 'Confidential', 'Internal']);
    expect(decision.route).toBe('local-only');
    expect(decision.isDowngraded).toBe(true);
    expect(decision.reason).toContain('Confidential data detected');
  });
});
```

**Step 2: Run test to verify failure**
Run: `npx vitest run tests/engine/policy.test.ts`
Expected: FAIL — Cannot find module '../../src/engine/policy'

**Step 3: Write minimal implementation**
Create: `src/engine/policy.ts`
```typescript
export interface RouteDecision {
  route: 'cloud' | 'local-only' | 'blocked';
  isDowngraded: boolean;
  reason: string;
}

export function evaluateRoute(classifications: string[]): RouteDecision {
  if (classifications.includes('Confidential')) {
    return {
      route: 'local-only',
      isDowngraded: true,
      reason: 'Confidential data detected. Enforcing local-only route.',
    };
  }
  
  if (classifications.includes('Restricted')) {
     return {
      route: 'blocked',
      isDowngraded: true,
      reason: 'Restricted data detected. Operation blocked.',
    };
  }

  return {
    route: 'cloud',
    isDowngraded: false,
    reason: 'Data is safe for cloud processing.',
  };
}
```

**Step 4: Run test to verify pass**
Run: `npx vitest run tests/engine/policy.test.ts`
Expected: PASS

**Step 5: Commit**
```bash
git add tests/engine/ src/engine/
git commit -m "feat: implement high-water mark policy engine"
```

---

## Task 2.2: 实现追加型本地审计日志 (TDD)
**Objective:** 编写 `AuditLogger`，将带有 Route Decision 的事件不可变地追加到 SQLite。

**Files:**
- Create: `tests/engine/audit.test.ts`
- Create: `src/engine/audit.ts`

**Step 1: Write failing test**
Create: `tests/engine/audit.test.ts`
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { initDB } from '../../src/database/index';
import { AuditLogger } from '../../src/engine/audit';
import Database from 'better-sqlite3';

describe('Audit Logger', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDB(':memory:');
  });

  it('should append an audit event and read it back', () => {
    const logger = new AuditLogger(db);
    logger.log('run_123', 'route_decision', 'local-only', 'hash_abc');
    
    const events = logger.getEvents('run_123');
    expect(events.length).toBe(1);
    expect(events[0].route_decision).toBe('local-only');
    expect(events[0].payload_hash).toBe('hash_abc');
  });
});
```

**Step 2: Run test to verify failure**
Run: `npx vitest run tests/engine/audit.test.ts`
Expected: FAIL — Cannot find module '../../src/engine/audit'

**Step 3: Write minimal implementation**
Create: `src/engine/audit.ts`
```typescript
import Database from 'better-sqlite3';
import crypto from 'crypto';

export class AuditLogger {
  constructor(private db: Database.Database) {}

  log(runId: string, eventType: string, routeDecision: string, payloadHash?: string) {
    const id = crypto.randomUUID();
    const stmt = this.db.prepare(
      'INSERT INTO run_events (id, run_id, event_type, payload_hash, route_decision) VALUES (?, ?, ?, ?, ?)'
    );
    stmt.run(id, runId, eventType, payloadHash || null, routeDecision);
    return id;
  }

  getEvents(runId: string) {
    const stmt = this.db.prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY created_at ASC');
    return stmt.all(runId);
  }
}
```

**Step 4: Run test to verify pass**
Run: `npm install --save-dev @types/node && npx vitest run tests/engine/audit.test.ts`
Expected: PASS

**Step 5: Commit**
```bash
git add tests/engine/ src/engine/
git commit -m "feat: implement append-only local audit logger"
```
