# Ogra Alpha - 原始需求文档 (PRD)

> **版本**：v0.1.1 (Re-reviewed)
> **日期**：2026-07-02
> **基于**：[Ogra / Ogra Edge 产品手册 v0.1](../../ogra-product-handbook.md)
> **阶段**：Alpha 核心闭环验证

## 1. 目标与定位

Ogra Alpha 的唯一目标是验证其最核心的假设：**端云透明路由与本地轻量审计**。
它不是一个功能完备的商业产品，而是一个能跑通“导入机密文件 -> 提问 -> 触发本地降级 -> 本地问答 -> 就地查阅审计”故事线的桌面沙盒。

**Alpha 核心体验路径 (The Demo Journey)：**
0. 基础配置：连接并验证本地 Ollama 实例，设置系统默认模型。
1. 导入敏感文件夹。
2. 将该文件夹标记为 Confidential (机密)。
3. 用户在 Chat 界面对该机密数据发起提问。
4. 触发本地 RAG 检索。
5. Policy Engine 发现高水位敏感数据，触发本地重路由 (Re-route)（若默认非本地，则自动降级到本地并给提示）。
6. 本地模型回答，UI 明确提示降级状态。
7. 在对话气泡就地展开 (In-context) 展示 `0 Ogra-managed cloud calls` (0 次云端调用) 的审计证据。
8. 查看完整的 Route Decision 与 Local Audit Trail 事件。

## 2. 核心功能范围 (Scope)

根据《产品手册》，Alpha 范围被严格限定在以下模块的最小可行子集：

### 2.1 桌面底座 (Desktop Shell)
- **形态**：Electron 桌面应用 (React/Vite UI + Main IPC)。
- **数据存储**：本地 SQLite 数据库（存储 Workspace、Run 事件、Audit 日志等）。
- **用户空间 (Workspace)**：单用户、本地 Workspace 管理（暂不支持多租户/同步）。

### 2.2 RAG 个人知识库 (RAG Engine)
- **输入支持**：Markdown、TXT、代码文件的文件夹导入。
- **检索能力**：SQLite FTS5 纯文本检索 (Alpha 阶段本地向量检索作为可选体验，优先保证 FTS 通畅)。
- **索引机制**：手动触发 Reindex，**必须提供明确的索引进度/就绪状态指示器 (Status Indicator)**。
- **引用展示**：RAG 结果必须展示引用文件、片段及**数据分级标签**。
- **继承逻辑**：文本 chunks 严格继承其来源文件夹的数据分级属性。

### 2.3 核心路由与适配器 (Router & Adapters)
- **Model Adapter**：支持 Ollama (本地) 与兼容 OpenAI 的 API 端点。
- **Agent Adapter**：仅支持 `InternalAgentAdapter` (内部基础问答)。
- **透明路由**：根据策略，每次请求生成 `RouteDecision` 对象（记录 Task、Data Classification、Route 等）。

### 2.4 数据分级与策略引擎 (Data Safety & Policy)
- **数据分级 (Data Classification)**：支持文件夹级别的标记（如 Public, Internal, Confidential, Restricted）。Alpha 重点验证 Confidential 级别的管控。
- **策略引擎 (Policy Engine)**：实现基于 YAML 的基础规则。
- **高水位原则 (High-Water Mark)**：当组装上下文的任意 chunk 包含高级别（如 Confidential）标签时，整个会话请求的水位强制提升至最高，并触发阻断或本地降级策略。
- **降级交互**：支持自动路由重定向（Re-route to Local Model），并在聊天流中生成明确的系统提示（如：“为保护机密数据，本次请求已自动切换至本地模型处理”）。若无本地模型可用，再执行硬阻断。

### 2.5 审计治理 (Audit & Governance)
- **本地审计轨迹 (Local Audit Trail)**：以 Append-only 形式记录 `run_events`。
- **就地审计 (In-context Audit)**：在单条消息气泡处提供一键展开面板（如盾牌图标），直接向用户展示该请求的 `RouteDecision` 及 0 云端调用的证据。
- **集中视图**：保留一个基础的独立 Audit 日志查看器。

## 3. 非功能性与体验要求

- **本地优先**：未经策略引擎允许，任何字节不得发送至云端。
- **透明性**：即便任务成功，也必须能点开查看该任务的“路由决策”和“审计轨迹”。
- **白盒限制**：不做静默记忆注入，不做无迹可寻的提示词修改。

## 4. 暂不包含 (Out of Scope for Alpha)
*(严格遵守产品手册第 9 节)*
- PDF/OCR 解析。
- Agent Group 并行/辩论编排（Alpha 仅跑通单线问答）。
- 多设备同步、云端备份。
- M3 三层记忆系统的语义/程序记忆（仅保留最基础的 Run summaries 即可）。
- 外部复杂 Agent 接入（如 Aider, Claude Code）。
- MCP 工具与复杂插件调用。