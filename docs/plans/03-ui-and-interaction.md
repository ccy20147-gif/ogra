# Ogra Alpha - 用户界面与交互层开发计划 (Phase 3)

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 构建 Chat 界面，集成 RAG、策略降级提示和“就地审计 (In-context Audit)” 盾牌。

**Architecture:** 
React 18 单页面应用，使用 Tailwind CSS 构建。直接通过 `window.ograAPI` 与后端的 SQLite 及 Policy Engine 交互。

---

## Task 3.1: 构建 Chat 基础组件与降级提示 UI (TDD)
**Objective:** 搭建聊天气泡，若消息的路由策略是被降级（`isDowngraded = true`），则显示系统级拦截警告。

**Files:**
- Create: `src/components/ChatMessage.tsx`
- Create: `tests/ui/ChatMessage.test.tsx`

**Step 1: Write failing test**
Create: `tests/ui/ChatMessage.test.tsx`
```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatMessage } from '../../src/components/ChatMessage';
import React from 'react';

describe('ChatMessage', () => {
  it('should render standard message', () => {
    render(<ChatMessage content="Hello world" role="assistant" isDowngraded={false} />);
    expect(screen.getByText('Hello world')).toBeDefined();
  });

  // vitest test for downgrade UI
  it('should render warning if downgraded to local', () => {
    render(<ChatMessage content="Local answer" role="assistant" isDowngraded={true} />);
    expect(screen.getByText(/为保护机密数据，本次请求已自动切换至本地模型处理/)).toBeDefined();
  });
});
```

**Step 2: Run test to verify failure**
Run: `npm install react react-dom && npm install --save-dev @types/react @types/react-dom jsdom @testing-library/react @testing-library/dom && npx vitest run tests/ui/ChatMessage.test.tsx --environment jsdom`
Expected: FAIL — Cannot find module '../../src/components/ChatMessage'

**Step 3: Write minimal implementation**
Create: `src/components/ChatMessage.tsx`
```tsx
import React from 'react';

interface ChatMessageProps {
  content: string;
  role: 'user' | 'assistant';
  isDowngraded?: boolean;
}

export function ChatMessage({ content, role, isDowngraded }: ChatMessageProps) {
  return (
    <div className={`flex flex-col p-4 mb-2 rounded ${role === 'user' ? 'bg-blue-100' : 'bg-gray-100'}`}>
      <span className="font-bold mb-1">{role === 'user' ? 'You' : 'Ogra'}</span>
      {isDowngraded && (
        <div className="text-xs text-orange-600 bg-orange-100 border border-orange-300 p-2 rounded mb-2 flex items-center">
          <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          为保护机密数据，本次请求已自动切换至本地模型处理。
        </div>
      )}
      <div className="text-gray-800 whitespace-pre-wrap">{content}</div>
    </div>
  );
}
```

**Step 4: Run test to verify pass**
Run: `npx vitest run tests/ui/ChatMessage.test.tsx --environment jsdom`
Expected: PASS

**Step 5: Commit**
```bash
git add tests/ui/ src/components/
git commit -m "feat: create ChatMessage UI with downgrade warning"
```

---

## Task 3.2: 构建就地审计面板 (In-context Audit Shield) (TDD)
**Objective:** 在消息旁增加一个盾牌图标，点击展开显示 `RouteDecision` 和 `0 Ogra-managed cloud calls` 证据。

**Files:**
- Create: `src/components/AuditShield.tsx`
- Create: `tests/ui/AuditShield.test.tsx`

**Step 1: Write failing test**
Create: `tests/ui/AuditShield.test.tsx`
```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AuditShield } from '../../src/components/AuditShield';
import React from 'react';

describe('AuditShield', () => {
  it('should toggle audit details when clicked', () => {
    render(<AuditShield route="local-only" cloudCalls={0} />);
    
    // initially hidden
    expect(screen.queryByText(/Route Decision: local-only/)).toBeNull();
    
    // click button
    fireEvent.click(screen.getByRole('button', { name: /audit/i }));
    
    // details visible
    expect(screen.getByText(/Route Decision: local-only/)).toBeDefined();
    expect(screen.getByText(/0 Ogra-managed cloud calls/)).toBeDefined();
  });
});
```

**Step 2: Run test to verify failure**
Run: `npx vitest run tests/ui/AuditShield.test.tsx --environment jsdom`
Expected: FAIL — Cannot find module '../../src/components/AuditShield'

**Step 3: Write minimal implementation**
Create: `src/components/AuditShield.tsx`
```tsx
import React, { useState } from 'react';

interface AuditShieldProps {
  route: string;
  cloudCalls: number;
}

export function AuditShield({ route, cloudCalls }: AuditShieldProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="mt-2 relative">
      <button 
        aria-label="audit"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center text-xs text-green-700 bg-green-100 hover:bg-green-200 px-2 py-1 rounded transition-colors"
      >
        <svg className="w-3 h-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
        Audit Trail
      </button>

      {isOpen && (
        <div className="absolute left-0 mt-1 p-3 bg-gray-900 text-green-400 text-xs font-mono rounded shadow-lg z-10 w-64">
          <div>Route Decision: {route}</div>
          <div className="mt-1 font-bold text-white bg-green-800 px-1 inline-block">
            {cloudCalls} Ogra-managed cloud calls
          </div>
          <div className="mt-2 text-gray-400 text-[10px]">Source: Local SQLite Hash Chain</div>
        </div>
      )}
    </div>
  );
}
```

**Step 4: Run test to verify pass**
Run: `npx vitest run tests/ui/AuditShield.test.tsx --environment jsdom`
Expected: PASS

**Step 5: Commit**
```bash
git add tests/ui/ src/components/
git commit -m "feat: create In-context Audit Shield UI component"
```