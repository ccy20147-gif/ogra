# Ogra 项目全量代码审查报告

> 审查日期: 2026-07-03
> 审查方式: 8 层独立子代理并行审查 + 手动合并
> 审查依据: `docs/plans/` 目录下 9 份规范文档（00~08）
> 审查范围: 58 个源文件 + 20 个测试文件 + CI + fixtures
> 编译状态: `tsc --noEmit` 通过 | `vitest run` 191/191 通过

---

## 总体统计

| 分层 | 🔴 阻断级 | 🟡 主要级 | 🟢 建议级 | 合计 |
|------|:---------:|:---------:|:---------:|:----:|
| 1. Desktop Runtime Foundation | 11 | 9 | 8 | 28 |
| 2. Local Data, Audit, Governance Store | 9 | 10 | 8 | 27 |
| 3. Policy, Routing, Safety Engine | 13 | 10 | 7 | 30 |
| 4. RAG and Knowledge Engine | 9 | 10 | 8 | 27 |
| 5. Model & Agent Orchestration | 6 | 10 | 7 | 23 |
| 6. Application UI/UX | 14 | 15 | 10 | 39 |
| 7. Tests & Verification | 8 | 10 | 0 | 18 |
| 8. Memory/AgentGroup/Beta scope | 5 | 6 | 7 | 18 |
| **总计** | **75** | **80** | **55** | **210** |

---

## Layer 1: Desktop Runtime Foundation (28 项)

### 🔴 阻断级 (11 项)

#### B1. 预加载脚本暴露动态 IPC 逃逸通道
- **文件**: `electron/preload/preload.ts:14-20, 54-55`
- **违反条款**: 01-desktop-runtime-foundation.md §2.2 "Preload MUST ... Avoid exposing generic ipcRenderer.send or arbitrary channel access"
- **问题**: 第 14-20 行从 `ALLOWED_IPC_CHANNELS` 遍历生成动态 API，将 `channel.replace(':', '_')` 作为键名平铺到 `window.ogra` 根对象上（第 55 行 `...api`）。渲染器可通过 `window.ogra.secret_create(req)`、`window.ogra.secret_delete(id)`、`window.ogra.provider_update(req)` 等调用所有通道——包括秘密管理、提供商更新等特权操作——完全绕过第 59-122 行的嵌套类型封装。
- **修复建议**: 删除 `...api` 动态展开（第 55 行）和对应的生成循环（第 14-20 行）。只用第 59-122 行的手写类型化 API 对象。

#### B2. AuditExport 通道无处理器注册
- **文件**: `electron/preload/preload.ts:91` → `electron/main/main.ts`
- **违反条款**: 01-desktop-runtime-foundation.md §3.2 "Every IPC handler MUST call Ogra Core service"
- **问题**: preload.ts 第 91 行 `audit.export` 调用 `IpcChannel.AuditExport`（`'audit:export'`），但 `main.ts` 中未注册任何 `AuditExport` 处理函数。调用时将抛出 "No handler registered for 'audit:export'" 运行时错误。
- **修复建议**: 在 `main.ts` 中为 `IpcChannel.AuditExport` 添加 handler；或在 Beta 前移除 preload 中对应入口。

#### B3. Permission/Approval 通道定义但全无处理器
- **文件**: `src/shared/ipc-channels.ts:59-64`
- **违反条款**: 01-desktop-runtime-foundation.md §3.2 "Alpha MUST define typed APIs for ... permission request and decision, approval request and decision"
- **问题**: `PermissionRequest`、`PermissionDecision`、`ApprovalRequest`、`ApprovalDecision` 四个通道在 `main.ts` 中没有任何 handler 注册。权限决策和审批流程完全缺失。
- **修复建议**: 在 `main.ts` 中注册对应的 IPC handler（至少是占位实现 + audit 写入），或从通道定义中移除并标记为 Beta。

#### B4. 秘密使用无审计事件写入
- **文件**: `src/core/secret-broker.ts` (全文)
- **违反条款**: 00-development-requirements-index.md §8 "secret use writes audit events"
- **问题**: `OgraSecretBroker` 类完全未依赖 `AuditService`。`create()`、`update()`、`delete()`、`getValue()` 方法均未写入任何审计事件。秘密的创建、使用、删除都无法追溯。
- **修复建议**: 给 `OgraSecretBroker` 构造函数添加 `AuditService` 参数，在每个秘密操作中调用 `auditService.writeEvent()`。

#### B5. 缺少 workspaceId 服务器端校验
- **文件**: `electron/main/main.ts:155-163`(WorkspaceSelect), `166-174`(WorkspaceUpdateClassification), `286-293`(DataSafetySummary) 等多处
- **违反条款**: 01-desktop-runtime-foundation.md §2.3 "Main MUST NOT trust renderer-supplied workspace ids ... without server-side validation"
- **问题**: 多个 handler 将渲染器传入的 `workspaceId` 直接传递给 Ogra Core 服务，未验证该 ID 是否真实存在于数据库中。可被用于枚举攻击或越权访问。
- **修复建议**: 添加统一的 `validateWorkspaceId(workspaceId: string)` 方法，在进入 handler 业务逻辑前校验 workspace 存在性。

#### B6. 索引进度事件从未发送
- **文件**: `electron/main/main.ts` + `electron/preload/preload.ts:26-27,57,175`
- **违反条款**: 01-desktop-runtime-foundation.md §3.2 "Index and run jobs report progress"
- **问题**: Preload 定义了 `onIndexingProgress` 订阅 `IpcChannel.IndexingProgress`，但 `main.ts`（及整个代码库）中没有任何地方调用 `mainWindow.webContents.send('indexing:progress', ...)`。进度通道是一个空监听器，前端永远收不到进度事件。
- **修复建议**: 在 knowledgeService 的索引方法中，通过回调或 EventEmitter 将进度发送到 mainWindow.webContents。

#### B7. 秘密加密密钥与密文并存
- **文件**: `src/core/secret-broker.ts:30-37, 40-57`
- **违反条款**: 01-desktop-runtime-foundation.md §2.3 "Broker secrets through OS secure storage or a dedicated secret module"
- **问题**: 加密密钥存储在 `{appDataDir}/secrets/key.bin`，加密密文存储在 `{appDataDir}/secrets/secrets.enc.json`。两者位于同一目录，只要攻击者获得文件系统访问权限即可同时获取密钥和密文。
- **修复建议**: 使用 Electron 的 `safeStorage` API 加密密钥，或将密钥存储在 OS 原生的凭据管理器（Keychain/Windows Credential Manager）中。

#### B8. Provider 路由/数据保留元数据缺失
- **文件**: `src/shared/types.ts:114`
- **违反条款**: 00-development-requirements-index.md §8 "provider registry records data-retention/training/region/ZDR/file-upload/tool-calling/streaming-log risk metadata when known"
- **问题**: `ProviderKind` 枚举只有 `Ollama` 和 `OpenAICompatible`，缺少内部/local/localCommand 等类型，且没有注册机制关联风险元数据。
- **修复建议**: 添加风险元数据注册机制，在 provider 创建时从已知适配器表格填充风险元数据。

#### B9. 渲染器 types.ts 中 IpcResult 类型错误
- **文件**: `src/renderer/types.ts:8-12` 与 `src/shared/ipc-channels.ts:87-95`
- **违反条款**: 01-desktop-runtime-foundation.md §2.2 "Return structured errors with stable codes"
- **问题**: 渲染器版本的 `IpcResult.error` 类型为 `string`，而实际运行时返回的 `error` 是 `{ code: string; message: string; details?: Record<string, unknown> }` 对象。TypeScript 类型检查无法发现此不匹配。
- **修复建议**: 将 `src/renderer/types.ts:11` 的 `error?: string` 改为 `error?: { code: string; message: string; details?: Record<string, unknown> }`，从 `src/shared/ipc-channels.ts` 复用。

#### B10. 预加载 OgraAPI 接口中第三方 API 缺失
- **文件**: `electron/preload/preload.ts:126-176`（OgraAPI 接口）与 `:88-92`（实际暴露对象）不一致
- **违反条款**: 01-desktop-runtime-foundation.md §2.2 "Export TypeScript types shared with the renderer"
- **问题**: 接口定义中 `audit` 没有 `export` 方法（第 150-152 行），但运行时对象有（第 91 行）。同时渲染器的 `src/renderer/types.ts:39-40` 有 `export`。三个地方的类型定义互相矛盾。

#### B11. 路径遍历检测可能误报
- **文件**: `src/core/path-validator.ts:39`
- **违反条款**: 01-desktop-runtime-foundation.md Anti-Pattern
- **问题**: `forwardNormalized.includes('..')` 会拒绝任何包含 `..` 子串的路径，包括合法路径如 `/home/user/some..project/docs`。
- **修复建议**: 改用改进的遍历检测：规范化后比较规范化前后的路径是否指向不同位置。

### 🟡 主要级 (9 项)

#### M1. SecretUpdate 处理器已注册但 preload 未暴露
- **文件**: `electron/main/main.ts:369-377`（有 handler） vs `electron/preload/preload.ts:109-113`（无 `secret.update`）
- **问题**: main.ts 注册了 `SecretUpdate` 通道，但 preload 没有暴露 `secret.update` 入口。
- **修复建议**: 在 preload.ts 中添加 `update: (id, req) => ...` 到 `secret` 命名空间。

#### M2. ProviderUpdate 中 id 和 updates 参数逻辑模糊
- **文件**: `electron/main/main.ts:331-341`
- **问题**: 第 335 行 `if (req.id)` 用 truthy 判断而非类型检查；第 338 行 `addOpenAICompatible(req)` 将整个 req 传递给添加方法。
- **修复建议**: 显式区分 `updateProvider` 和 `addOpenAICompatible` 的参数模式，添加 schema 校验。

#### M3. OgraCore 初始化不完整
- **文件**: `src/core/index.ts:63-65`
- **问题**: `initialize()` 只设置了 `this.initialized = true`，没有实际的数据库迁移、服务初始化或验证。
- **修复建议**: 在 initialize() 中添加数据库迁移调用、服务启动验证、以及必要的预热步骤。

#### M4. shutdown() 方法为空
- **文件**: `src/core/index.ts:68-70`
- **问题**: shutdown() 是空函数。应用退出时不会关闭数据库连接、清空秘密缓存或取消正在运行的任务。
- **修复建议**: 实现服务的优雅关闭。

#### M5. 开发环境 CSP 允许 `http://localhost:*` 连接
- **文件**: `electron/main/main.ts:77`
- **问题**: 开发 CSP 中 `connect-src 'self' ws://localhost:* http://localhost:*` 允许渲染器通过 `fetch` 直接访问本地服务。
- **修复建议**: 限制具体端口而非使用通配符 `:*`。

#### M6. 渲染器 types.ts 的 OgraAPI 与 preload 接口不同步
- **文件**: `src/renderer/types.ts:14-67` vs `electron/preload/preload.ts:126-176`
- **问题**: 渲染器类型定义与 preload 的真实 API 形状不匹配。
- **修复建议**: 统一从 `src/shared/` 共享类型。

#### M7. 秘密值在错误消息中可能暴露
- **文件**: `src/core/secret-broker.ts:132`
- **问题**: `SECRET_ACCESS_DENIED` 代码不够稳定。
- **修复建议**: 确认 error details 永远不会包含 secret value。

#### M8. ALLOWED_EXTERNAL_URLS 未审计
- **文件**: `electron/main/main.ts:425-428`
- **问题**: `url.startsWith()` 匹配，`https://ogra-desktop.dev.evil.com` 也会被放行。
- **修复建议**: 使用精确匹配（`===`）或用 URL 解析器验证 hostname 完全匹配。

#### M9. validateCallerContext 校验可能因窗口重建失败
- **文件**: `electron/main/main.ts:416-421`
- **问题**: 通过 `event.sender.id !== mainWindow.webContents.id` 验证调用者。窗口重建后误拒绝。
- **修复建议**: 使用 `BrowserWindow.fromWebContents(event.sender)` 获取调用者窗口。

### 🟢 建议级 (8 项)

- S1: IPC 处理函数参数个数校验 `!==` 应改为 `!==` 精确匹配 → `electron/main/main.ts:112-118`
- S2: 全局变量应封装在 AppContext 单例中 → `electron/main/main.ts:10-12`
- S3: IPC 通道命名风格不统一 → `src/shared/ipc-channels.ts`
- S4: PathValidator 缺少隐藏目录控制 → `src/core/path-validator.ts`
- S5: 秘密 masking 可能泄露长度信息 → `secret-broker.ts:178-181`
- S6: IPC handler 参数类型应改为 `unknown` → `electron/main/main.ts:104`
- S7: 预加载订阅管理器不清理 → `electron/preload/preload.ts:23-51`
- S8: 错误码 `INVALID_INPUT` vs `INVALID_ARGUMENT` 语义重叠 → `src/shared/errors.ts:10-11`

---

## Layer 2: Local Data, Audit, Governance Store (27 项)

### 🔴 阻断级 (9 项)

#### 1. `INSERT OR REPLACE` 会静默覆盖 Run 证据
- **文件**: `src/core/database-service.ts:410-412`
- **违反条款**: 02-local-data-audit-governance-store.md §2 "MUST NOT silently delete run evidence"
- **问题**: `INSERT OR REPLACE INTO agent_runs` 如果相同的 `id` 被重用会静默删除并重建该行，导致之前的 run 证据永久丢失。
- **修复建议**: 改用 `INSERT ... ON CONFLICT(id) DO UPDATE` 明确只更新特定字段。

#### 2. Hash Chain 追加操作不在单一事务中
- **文件**: `src/core/database-service.ts:116-159`
- **违反条款**: 02-local-data-audit-governance-store.md §3.3 "event append and hash calculation MUST happen in one transaction"
- **问题**: 三个独立查询（`SELECT MAX(sequence)`, `SELECT event_hash`, `INSERT INTO run_events`）没有包裹在事务中。
- **修复建议**: 将整个方法体包裹在 `this.db.getDB().transaction(() => { ... })()` 中。

#### 3. `canonicalJSON` 不递归排序嵌套键
- **文件**: `src/core/audit-service.ts:26-28`
- **违反条款**: 02-local-data-audit-governance-store.md §3.3 "canonical JSON MUST use deterministic key ordering"
- **问题**: `Object.keys(obj).sort()` 只排序顶层键。嵌套对象的键排序取决于 JS 引擎。
- **修复建议**: 使用递归 canonical 序列化方案（如 `fast-json-stable-stringify`）。

#### 4. `document_chunks_fts` FTS5 缺少内容同步保障
- **文件**: `src/core/database.ts:163-167`
- **违反条款**: 02-local-data-audit-governance-store.md §3.1 "document_chunks MUST have an FTS5-backed search path"
- **问题**: FTS5 虚拟表创建时未使用 `content=` 选项指向真正的 `document_chunks` 表。对 `document_chunks` 的更改不会自动同步到 FTS 索引。
- **修复建议**: 使用具有 `content=document_chunks` 的外部内容 FTS5 表，或添加同步触发器。

#### 5. `(this.dbService as any).db` 破坏封装
- **文件**: `src/core/audit-service.ts:126`
- **违反条款**: 02-local-data-audit-governance-store.md §2 "只能由 Ogra Core/Edge 服务访问"
- **问题**: `AuditService` 通过 `(this.dbService as any)` 访问 `DatabaseService` 的私有成员 `db`。
- **修复建议**: 在 `DatabaseService` 中添加公开方法。

#### 6. `GENESIS_HASH` 两处重复定义
- **文件**: `src/core/database-service.ts:45` 和 `src/core/audit-service.ts:20`
- **违反条款**: 02-local-data-audit-governance-store.md §3.3 "genesis previous_hash MUST use a documented constant"
- **问题**: 同一个常量在两个文件中分别定义。
- **修复建议**: 将 `GENESIS_HASH` 定义在一个公共位置并 import。

#### 7. `run_events.event_hash UNIQUE` 约束不必要
- **文件**: `src/core/database.ts:215`
- **违反条款**: 02-local-data-audit-governance-store.md §3.3 只要求 `(run_id, sequence)` 唯一
- **问题**: `event_hash` 的全局 UNIQUE 约束增加了不必要的插入失败风险。
- **修复建议**: 移除 `event_hash` 上的 `UNIQUE` 约束。

#### 8. `model_calls` 缺少多个关键字段
- **文件**: `src/core/database-service.ts:424-453`
- **违反条款**: 02-local-data-audit-governance-store.md §3.5 schema
- **问题**: `storeModelCall` 参数类型不接受 `response_hash`、`redaction_rule_version`、`approval_id`。
- **修复建议**: 在 `storeModelCall` 参数类型和 SQL INSERT 语句中添加这些字段。

#### 9. FK 约束缺失——9 个核心表缺少外键
- **文件**: `src/core/database.ts:726-728` (V5 迁移为空)
- **问题**: `run_events.run_id`, `route_decisions.run_id`, `model_calls.run_id`, `policies.workspace_id`, `incidents.workspace_id` 等均无 FK 约束。允许孤立记录。
- **修复建议**: 添加真正的 FK 约束或 `database-service.ts` 中的引用完整性检查。

### 🟡 主要级 (10 项)

#### 1. `RouteDecisionRow` 类型缺失多个 schema 字段
- **文件**: `src/core/database-service.ts:31-43`
- **问题**: 缺少 `local_steps_json`、`cloud_steps_json`、`approval_id`、`policy_evaluation_id`。
- **修复建议**: 在 `RouteDecisionRow` 中添加这些字段。

#### 2. `route_decisions` 初始 schema 缺少 `audit_event_id`
- **文件**: `src/core/database.ts:185-203`
- **问题**: 直到 V3 迁移才添加 `audit_event_id` 列。
- **修复建议**: 将 `audit_event_id` 列移至 V1 初始 schema。

#### 3-10. 其他数据库问题
- policies.workspace_id 无 FK 约束 → `database.ts:225`
- storeRouteDecision 忽略 approvalId 和 policyEvaluationId → `database-service.ts:209-244`
- model_calls(is_cloud) 无索引 → `database-service.ts:461-469`
- incidents.workspace_id 无 FK 约束 → `database.ts:325`
- route_decisions.run_id 允许 NULL → `database.ts:187`

### 🟢 建议级 (8 项)

- incidents 未强制要求 run_id → `database.ts:326`
- document_chunks.content_hash 索引缺失 → `database.ts:148-160`
- run_events 上 `UNIQUE(run_id, sequence)` + `UNIQUE(event_hash)` 冗余
- WorkspaceService.create() 不记录 audit 事件 → `workspace-service.ts:31-38`
- 迁移 V7 记忆表 FTS5 无同步触发器 → `database.ts:739-758`
- V6 迁移 `DROP TABLE IF EXISTS memories` 会静默删除已有数据 → `database.ts:731-736`

---

## Layer 3: Policy, Routing, Safety Engine (30 项)

### 🔴 阻断级 (13 项)

#### B1. RAG 检索在策略评估之前执行——完全的策略绕过
- **文件**: `internal-agent-adapter.ts:66-72` → `:100-110`
- **违反条款**: 03-policy-routing-safety-engine.md §3, 00-development-requirements-index.md Cross-Document Invariants
- **问题**: Step 2 先执行 `ragEngine.retrieve()`，Step 5 才执行 `policyService.evaluate()`。检索的内容可能包含 Confidential/Restricted 数据，但在策略评估之前就已经被读取和加载到内存中。
- **修复建议**: 将策略评估移到检索之前。先通过策略确定允许的操作和路线，再执行检索。

#### B2. Pipeline 同样在策略评估之前执行 RAG 检索
- **文件**: `pipeline-orchestrator.ts:167` (检索) 对比 `:113-123` (策略评估)
- **违反条款**: 03-policy-routing-safety-engine.md §3
- **问题**: 策略评估时使用硬编码的 `DataClassification.Internal`，未使用实际检索内容的分类。丧失高水位策略的意义。
- **修复建议**: 先将有效分类传入策略评估，确认检索操作被允许，再执行检索，最后用高水位分类重新评估。

#### B3. 缺少上下文组装前的策略检查
- **文件**: `internal-agent-adapter.ts:150-152`
- **违反条款**: 03-policy-routing-safety-engine.md §3 ("before context assembly")
- **修复建议**: 在调用 `ragEngine.assembleContext()` 前，用高水位分类重新执行策略检查。

#### B4. 缺少嵌入请求前的策略检查
- **文件**: 整个代码库未实现
- **违反条款**: 03-policy-routing-safety-engine.md §3 ("before embedding requests")
- **修复建议**: 添加嵌入策略检查点。

#### B5. 缺少工具调用的策略检查
- **文件**: 整个代码库未实现
- **违反条款**: 03-policy-routing-safety-engine.md §3 ("before tool invocation")
- **修复建议**: 添加 `requirePolicyForTool()` 方法。

#### B6. 缺少 Agent 委派的策略检查
- **违反条款**: 03-policy-routing-safety-engine.md §3 ("before agent delegation")

#### B7. 缺少本地 Agent 启动的策略检查
- **违反条款**: 03-policy-routing-safety-engine.md §3 ("before local agent runtime launch")

#### B8. 缺少文件导出的策略检查
- **违反条款**: 03-policy-routing-safety-engine.md §3 ("before file export")

#### B9. 缺少审计视图和审计导出的策略检查
- **违反条款**: 03-policy-routing-safety-engine.md §3 ("before audit view and audit export")

#### B10. 程序化记忆写入缺少策略检查
- **文件**: `memory-service.ts:260-309`
- **违反条款**: 03-policy-routing-safety-engine.md §3 ("before memory write")
- **问题**: `proposeProcedural` 完全跳过了策略检查，直接写入数据库。
- **修复建议**: 在 `proposeProcedural` 中添加 `this.checkPolicy()` 调用。

#### B11. 阻止运行未创建事件记录
- **文件**: `run-service.ts:114-128`, `internal-agent-adapter.ts:160-178`
- **违反条款**: 03-policy-routing-safety-engine.md §11 "Incidents MUST be created for policy block..."
- **问题**: 从未调用 `GovernanceService.createIncident()` 创建正式的事件记录。
- **修复建议**: 在阻止路径中调用 `governanceService.createIncident()`。

#### B12. 影响执行路径的提示注入未创建事件
- **文件**: `internal-agent-adapter.ts:84-97`, `pipeline-orchestrator.ts`
- **违反条款**: 03-policy-routing-safety-engine.md §9
- **问题**: 提示注入警告被记录到运行事件中，但从未创建正式事件。
- **修复建议**: 在 PI 影响决策的路径中添加 `createIncident()` 调用。

#### B13. Pipeline 完全没有提示注入检测
- **文件**: `pipeline-orchestrator.ts:167-174`
- **违反条款**: 03-policy-routing-safety-engine.md §9
- **问题**: Pipeline 完全没有调用 `PromptInjectionDetector`。
- **修复建议**: 将 `PromptInjectionDetector` 注入到 `PipelineOrchestrator` 构造函数中。

### 🟡 主要级 (10 项)

#### M1. 未知分类未显式提升为 Internal
- **文件**: `policy-service.ts:133-134, 138, 339-344`
- **问题**: 未将未知分类映射为 Internal。语义上不匹配规范要求。
- **修复建议**: 在 `evaluate()` 开头添加显式检查。

#### M2. 策略优先级未完整实现
- **文件**: `policy-service.ts:156-344`
- **问题**: 8 级优先级中仅实现约 4 级。缺失：用户云偏好覆盖、工作区策略、文件/文件夹/KB 策略。
- **修复建议**: 添加用户云偏好覆盖、工作区策略、优先级处理。

#### M3. 路由决策中的 `dataClassification` 未反映真实高水位
- **文件**: `route-service.ts:101`, `internal-agent-adapter.ts:100-108`
- **修复建议**: 确保 RouteDecisionRecord 的 dataClassification 字段始终使用高水位分类。

#### M4. 缺少云负载哈希和摘要
- **文件**: `route-service.ts:95-113`
- **修复建议**: 在云路由决策中生成并填充负载摘要和哈希。

#### M5. Pipeline 的检索内容未包装为引用的上下文块
- **文件**: `pipeline-orchestrator.ts:169-172`
- **修复建议**: 使用 `ragEngine.assembleContext()` 而非直接连接。

#### M6. 运行风险摘要未包含提示注入警告
- **文件**: `governance-service.ts:43-124`

#### M7. 策略版本哈希生成有缺陷
- **文件**: `policy-service.ts:367-370`
- **问题**: 仅对策略名称排序后计算哈希，不包括规则内容。
- **修复建议**: 包含所有策略规则的序列化内容和版本号。

#### M8. Agent Manifest 验证仅检查工具列表
- **文件**: `policy-service.ts:166-184`
- **修复建议**: 解析完整的 manifest 并验证所有能力字段。

#### M9. MemoryService 策略检查使用硬编码的 Internal 分类
- **文件**: `memory-service.ts:98`

#### M10. 无 YAML 策略编辑/导入支持
- **文件**: `policy-service.ts:89-117, 351-365`

### 🟢 建议级 (7 项)

- PolicySimulator 无隔离/日志 → `policy-service.ts:347-349`
- 分类优先级映射重复 → `high-water-mark.ts:15-19` 和 `policy-service.ts:141-146`
- 路由决策缺少 `policyEvaluationId` → `route-service.ts:95-113`
- DataEgressModel 纯文档无执行 → `data-egress-model.ts`
- 修正/修订功能未实现（规范 §11.1）
- Pipeline runParallel 策略评估结果未使用 → `pipeline-orchestrator.ts:384`
- RunService 策略输入缺少字段 → `run-service.ts:86-93`

---

## Layer 4: RAG and Knowledge Engine (27 项)

### 🔴 阻断级 (9 项)

#### C1. reindexFolder 误用 workspace_id 代替 knowledge_base_id 删除数据
- **文件**: `src/edge/rag-engine.ts:167-177`
- **违反条款**: 04-rag-knowledge-engine.md "手动 reindex 要求 update changed content by content hash"
- **问题**: `reindexFolder()` 使用 `workspace_id` 作为 WHERE 条件删除数据，会删除同一 workspace 下所有 KB 的数据。
- **修复建议**: 修改 WHERE 条件为 `knowledge_base_id = ?`。同时修改 FTS 删除的 subquery。

#### C2. KnowledgeService.runIndexingJob 仅是空壳——没有任何真实索引操作
- **文件**: `src/edge/knowledge-service.ts:116-160`
- **违反条款**: 04-rag-knowledge-engine.md "indexing job 启动并发送 progress"
- **问题**: `runIndexingJob()` 只扫瞄文件、读取内容、按行数估算 chunk 数量，但从未调用 RagEngine、DocumentParser 或任何数据库写入操作。
- **修复建议**: `runIndexingJob()` 必须调用 `RagEngine.indexFolder()` 来实际写入 `documents`、`document_chunks`、`document_chunks_fts` 表。

#### C3. 缺少 prompt_injection_warning 事件的写入机制
- **文件**: `src/edge/rag-engine.ts:244-279`
- **违反条款**: 04-rag-knowledge-engine.md "must write prompt_injection_warning events"
- **修复建议**: 在 schema 中创建 `prompt_injection_warnings` 表，在检索逻辑中检测到 `instructionalContentDetected` 时写入事件。

#### C4. 分类变更（classification change）完全没有实现
- **文件**: 全层
- **违反条款**: 04-rag-knowledge-engine.md 分类优先级链和变更审计机制
- **问题**: 所有文档只使用单一 `classification` 参数，无优先级计算，无分类变更 API。
- **修复建议**: 实现 `ClassificationResolver` 处理优先级链。添加 `classification_changes` 表。

#### C5. 缺少二进制文件/超大文件检测
- **文件**: `src/shared/dir-scanner.ts:30-59`, `src/edge/knowledge-service.ts:134-135`
- **违反条款**: 04-rag-knowledge-engine.md "默认忽略：.git, node_modules, dist/build/.next, binary, oversize"
- **修复建议**: 在 dir-scanner 中添加二进制检测（检查前 512 字节是否有 null bytes）和尺寸检查。

#### C6. assembleContext 未写入 document_access_events 和 run_context_sources
- **文件**: `src/edge/rag-engine.ts:293-336`
- **违反条款**: 04-rag-knowledge-engine.md "write document_access_events and run_context_sources for each lifecycle state"
- **修复建议**: 在 `assembleContext()` 中添加参数 `runId` 和 `workspaceId`，在上下文策略执行后写入。

#### C7. rag-engine.ts 直接使用 `getRawDB()` 绕过所有验证
- **文件**: `src/edge/rag-engine.ts:51-68` 及第 168-177 行
- **修复建议**: 在 `database-service.ts` 中添加 typed 方法处理 document/chunk 的批量插入。

#### C8. 无权限检查——所有 chunk 默认 `allowedForContext = true`
- **文件**: `src/edge/document-parser.ts:119`
- **违反条款**: 04-rag-knowledge-engine.md "run retrieval policy BEFORE search"
- **修复建议**: 引入基于分类的策略检查逻辑来确定 `allowedForContext`。

#### C9. FTS5 查询对用户输入做了不充分的转义
- **文件**: `src/edge/rag-engine.ts:197-200`
- **修复建议**: 使用 FTS5 的 `prefix` 参数或更严格的 tokenization。至少不要静默吞掉错误。

### 🟡 主要级 (10 项)

- 缺少 knowledge_base 持久化到数据库 → `knowledge-service.ts:76-83`
- run_context_sources 插入缺少 offset/line 字段 → `rag-engine.ts:254-258`
- 索引作业没有真正的进度推送机制 → `knowledge-service.ts:116-160`
- 取消机制不完整 → `knowledge-service.ts:129-144`
- 索引状态更新未反映在数据库 → `knowledge-service.ts:147-149`
- content hash 计算与规范格式不一致 → `document-parser.ts:87`
- 暂缺 knowledge_base scoped 检索 → `rag-engine.ts:189-286`
- Content snippet 截断方式不符合规范 → `rag-engine.ts:208`
- retrieve() 中 contextDestination 映射逻辑不一致 → `rag-engine.ts:350-359`

### 🟢 建议级 (8 项)

- FTS5 查询构造方式低效（全部 OR 关系）→ `rag-engine.ts:200`
- 代码块边界检测不完善 → `document-parser.ts:136-142`
- `assembleContext` 中高水位分类计算可以更精确 → `rag-engine.ts:308-315`
- 同步文件读取可能阻塞事件循环 → `rag-engine.ts:73`
- `source_trust_level` 字段未被利用 → `database.ts:143`
- 索引后的文件/数据验证不足 → `rag-engine.ts:120-148`
- 缺少对 `.markdown` 扩展名的支持 → `document-parser.ts:73`
- KnowledgeService 和 RagEngine 职责重叠 → `knowledge-service.ts` vs `rag-engine.ts`

---

## Layer 5: Model & Agent Orchestration (23 项)

### 🔴 阻断级 (6 项)

#### 1. `BaseModelAdapter` 缺少 `stream?()` 方法
- **文件**: `src/core/model-adapter.ts:69-76`
- **违反条款**: 05-model-agent-orchestration.md Model Adapter Contract "Every adapter MUST implement: ... stream?()"
- **修复建议**: 在 `BaseModelAdapter` 中声明 `stream?(request: ModelRequest): AsyncGenerator<ModelEvent>` 抽象方法。

#### 2. 适配器未验证 provider/model ID 与 route decision + policy evaluation 匹配
- **文件**: `src/edge/model-adapters.ts:29-85` (OllamaAdapter.generate), `:145-202` (OpenAICompatibleAdapter.generate)
- **违反条款**: 05-model-agent-orchestration.md "Adapters MUST verify provider/model ids match route decision + policy evaluation before sending"
- **修复建议**: 在 `BaseModelAdapter.validatePolicyGate()` 中添加交叉验证逻辑。

#### 3. RAG 检索在策略评估之前执行（数据泄露风险）
- **文件**: `src/edge/internal-agent-adapter.ts:66-72`
- **修复建议**: 将 RAG 检索移到策略评估和路由决策之后。

#### 4. PipelineOrchestrator 实现多智能体合作，违反 Alpha 约束
- **文件**: `src/core/pipeline-orchestrator.ts:67-277, 327-528, 535-771`
- **违反条款**: 05-model-agent-orchestration.md "Alpha MUST NOT build free-form multi-agent collaboration"
- **修复建议**: 将 `runParallel` 和 `runDebate` 标记为 Beta 预留，Alpha 只保留 `runPipeline` 且限制单步骤。

#### 5. OpenAICompatibleAdapter 未对 Confidential/Restricted 分类进行阻断
- **文件**: `src/edge/model-adapters.ts:145-202`
- **违反条款**: 05-model-agent-orchestration.md "MUST be blocked for Confidential and Restricted in Alpha"
- **修复建议**: 在 `generate()` 中检查数据分类并阻断。

#### 6. RunService 跳过多项必要的生命周期转换
- **文件**: `src/core/run-service.ts`
- **违反条款**: 05-model-agent-orchestration.md Run Lifecycle 规范
- **问题**: 生命周期中的 `retrieval`、`context_policy_check`、`route_decision` 状态转换都被跳过。
- **修复建议**: 添加缺失的状态转换和对应的 run 事件。

### 🟡 主要级 (10 项)

- InternalAgentAdapter 缺少检索事件 → `internal-agent-adapter.ts:66-72`
- OpenAICompatibleAdapter.testConnection() 未写入审计事件 → `model-adapters.ts:204-232`
- 适配器未使用 ProviderService 元数据注册表 → `model-adapters.ts:125-143`
- RunService 未持久化路线决策和策略评估 ID → `internal-agent-adapter.ts:216-228`
- 缺少 `context_policy_check` 事件和检查 → `internal-agent-adapter.ts`
- PipelineOrchestrator 使用字符串模式值而非枚举 → `pipeline-orchestrator.ts:88, 346, 555`
- PipelineOrchestrator.resumePipeline() 将状态设置为 'created' 而非 'running' → `:301`
- InternalAgentAdapter 的 policyEvaluationId 是构造值而非实际 ID → `:220`
- ProviderService.testConnection() 仅支持 Ollama 端点 → `provider-service.ts:131-144`
- LocalCommandAgentAdapter 无 Manifest → `local-command-agent-adapter.ts`

### 🟢 建议级 (7 项)

- ModelRequest 中的 approvalId 从未被填充 → `model-adapter.ts:31`
- InternalAgentAdapter 使用硬编码的分类阈值 → `internal-agent-adapter.ts:273`
- 缺失 uploadedPayloadHash 的填充 → `database-service.ts:435`
- OllamaAdapter 不支持外部取消操作 → `model-adapters.ts:29-85`
- PipelineOrchestrator 跳过模型调用时仍写入事件 → `pipeline-orchestrator.ts:141-148`
- RunService.startRun() 未从数据库读取路线决策 → `run-service.ts:95-98`
- agent_runs 表缺 routeDecisionId/policyEvaluationId 的 FK 引用

---

## Layer 6: Application UI and UX (39 项)

### 🔴 阻断级 (14 项)

#### C1. limitationNote 缺省文本截断
- **文件**: `src/renderer/App.tsx:575`
- **违反条款**: 06-application-ui-ux.md §9
- **问题**: 缺省文本丢失了规范要求的第二句关于未受控出口的说明。
- **修复建议**: 将缺省文本替换为规范要求的完整文本。

#### C2. Cancel 按钮 onClick 为空函数
- **文件**: `src/renderer/components/RunWorkspaceTab.tsx:396`
- **违反条款**: 06-application-ui-ux.md §6 "取消和超时状态"
- **问题**: Cancel 按钮 `onClick={() => {}}` 为空函数，无法实际取消。
- **修复建议**: 实现 `window.ogra.run.cancel(runId)` 调用。

#### C3. 缺少 Run History / Detail 分屏视图
- **文件**: `src/renderer/components/RunWorkspaceTab.tsx`
- **违反条款**: 06-application-ui-ux.md §6 "run history and detail split view"
- **修复建议**: 添加运行历史列表组件。

#### C4. 缺少策略降级/阻止时的用户指引
- **文件**: `src/renderer/components/RunWorkspaceTab.tsx:98-156`
- **违反条款**: 06-application-ui-ux.md §6
- **修复建议**: 在 RouteSummaryCard 中添加政策名称字段和 actionable guidance。

#### C5. PhaseTimeline 缺失多个规范要求的阶段
- **文件**: `src/renderer/components/RunWorkspaceTab.tsx:44-50`
- **违反条款**: 06-application-ui-ux.md §6
- **问题**: `PHASES` 仅定义了 5 个阶段，缺少：`created`, `risk_classification`, `approval/redaction`, `final_output`, `audit_complete`。
- **修复建议**: 补充全部 9 个阶段。

#### C6. Workspace 切换未重置活跃运行上下文
- **文件**: `src/renderer/App.tsx:217-222`
- **违反条款**: 06-application-ui-ux.md §4
- **修复建议**: 在 handleSelectWorkspace 中添加 state 重置逻辑。

#### C7. RouteTraceViewer 缺少云调用状态区分
- **文件**: `src/renderer/components/RouteTraceViewer.tsx`
- **违反条款**: 06-application-ui-ux.md §7
- **修复建议**: 添加云调用状态说明块（4种状态）。

#### C8. Citation UI 缺少 retrieval method 和 context destination
- **文件**: `src/renderer/components/RunWorkspaceTab.tsx:289-338`
- **违反条款**: 06-application-ui-ux.md §8
- **修复建议**: 在 CitationInfo 类型和 UI 中添加。

#### C9. AI Governance Center 缺少审批操作按钮和审批详情
- **文件**: `src/renderer/components/AiGovernanceCenter.tsx:403-442`
- **违反条款**: 06-application-ui-ux.md §10 + §12
- **修复建议**: 添加 approve/deny 按钮及回调。

#### C10. Data Safety Center 缺少关键交互功能
- **文件**: `src/renderer/components/DataSafetyCenter.tsx`
- **违反条款**: 06-application-ui-ux.md §9
- **修复建议**: 添加策略关联链接、证据查看弹窗、allowlist 编辑功能。

#### C11. AI Governance risk detail 缺少规范要求的字段
- **文件**: `src/renderer/components/AiGovernanceCenter.tsx:4-9` + `App.tsx:633-636`
- **违反条款**: 06-application-ui-ux.md §10
- **修复建议**: 扩展 RiskDetail 接口覆盖全部 6 个规范要求字段。

#### C12. Connection test 和 secret changes 未创建审计事件
- **文件**: `src/renderer/components/SettingsTab.tsx`
- **违反条款**: 06-application-ui-ux.md §11
- **修复建议**: 在操作后调用审计记录 API。

#### C13. 缺少文件夹选择器按钮（folder picker）
- **文件**: `src/renderer/components/KnowledgeBaseTab.tsx:210-215`
- **违反条款**: 06-application-ui-ux.md §5
- **修复建议**: 添加 Electron dialog 调用的 folder picker 按钮。

#### C14. 缺少多个规范要求的 Error/Empty State
- **违反条款**: 06-application-ui-ux.md §13 + §12
- **问题**: 缺少 provider key missing、audit unavailable 等状态。

### 🟡 主要级 (15 项)
- RunResult 只显示状态字符串，缺少答案内容 → `RunWorkspaceTab.tsx:514-528`
- 缺少云调用计数展示（Run 页面）→ `RunWorkspaceTab.tsx`
- 缺少 audit shield / evidence button → `RunWorkspaceTab.tsx`
- 缺少 model call ledger → `RunWorkspaceTab.tsx`
- 缺少输出/artifact 位置展示 → `RunWorkspaceTab.tsx`
- RouteTraceViewer 缺少 retrieved sources、redaction status、audit event IDs
- Citation UI 默认暴露完整文件路径 → `RunWorkspaceTab.tsx:312-313`
- Data Safety Center 缺少 recent cloud-context inclusion
- AiGovernanceCenter 缺少 incident detail 打开功能 → `:454-495`
- WorkspaceOverviewTab 缺少 agents、memory status、risk/incident 和 cloud-call summary
- Workspace 创建硬编码名称 → `App.tsx:114-117`
- SettingsTab 连接测试和秘密变更无审计 → `:132-151`
- 缺少首次运行引导流程 → `App.tsx:456-504`
- 缺少 `audit unavailable` 错误状态
- Approval UX 完全未实现 → `AiGovernanceCenter.tsx`

### 🟢 建议级 (10 项)
- WorkspaceOverviewTab 缺少 workspace isolation note
- RunWorkspaceTab 中 `currentWorkspace` 为 boolean 类型
- Context sources 显示为模拟数据 → `App.tsx:180-186`
- AI Governance Center 多个区域硬编码 → `App.tsx:595-636`
- 缺少导入确认步骤中的文件类型预览 → `KnowledgeBaseTab.tsx:144-178`
- 缺少索引取消按钮 → `KnowledgeBaseTab.tsx`
- Data Safety Center 缺少 cloud provider permission status
- Provider 表单缺少 API 密钥字段 → `SettingsTab.tsx:164-195`
- runBlocked 状态时序偏离 spec → `App.tsx:157-163`
- classificationDist 缺少降级场景处理 → `WorkspaceOverviewTab.tsx:69-70`

---

## Layer 7: Tests & Verification (18 项)

### 🔴 阻断级 (8 项)

#### 1. E2E Alpha 15步路径严重不完整
- **文件**: `tests/e2e/alpha-demo-path.test.ts`
- **违反条款**: 07-verification-packaging-release-gates.md §3
- **问题**: 仅约 8/15 步覆盖。缺失：UI 交互步骤（引用展示、路由决策展示、0 cloud calls 展示、审计追踪展示、AI 治理风险摘要、数据安全资产展示）；分类继承未测试；手动重新索引未测试；prompt-injection fixture 未集成到 E2E。
- **修复建议**: 重写为准确的 15 步脚本。

#### 2. 缺少对模拟HTTP适配器的集成测试
- **违反条款**: 07-verification-packaging-release-gates.md §5
- **问题**: 使用 `MockModelAdapter` 完全绕过 HTTP。没有 `Ollama`/`OpenAI` 的 HTTP mock 测试。
- **修复建议**: 创建 `tests/integration/adapter-mock-http.test.ts`。

#### 3. 数据库迁移测试缺失
- **违反条款**: 07-verification-packaging-release-gates.md §5
- **问题**: 没有 migration 测试。
- **修复建议**: 添加 `tests/integration/migration.test.ts`。

#### 4. Worker隔离测试缺失
- **违反条款**: 07-verification-packaging-release-gates.md §6
- **问题**: 无 worker 隔离、环境清理测试。
- **修复建议**: 创建 `tests/security/worker-isolation.test.ts`。

#### 5. 审计验证——导出/删除/清理事件缺失
- **文件**: `tests/unit/audit-verifier.test.ts`
- **违反条款**: 07-verification-packaging-release-gates.md §7

#### 6. 审计验证——并发事件追加测试缺失
- **文件**: `tests/unit/audit-verifier.test.ts`
- **违反条款**: 07-verification-packaging-release-gates.md §7 "concurrent event append tests"

#### 7. 安全检查缺失 5 项
- **文件**: `tests/security/desktop-security.test.ts`
- **缺失**: remote module 检查; shell.openExternal 检查; renderer process/require/SQLite/secret 检查; logs 秘密泄露; worker 隔离。
- **违反条款**: 07-verification-packaging-release-gates.md §6

#### 8. UI 测试零渲染验证
- **文件**: `tests/unit/renderer-smoke.test.ts`
- **违反条款**: 07-verification-packaging-release-gates.md §8 (19 项要求全缺)

### 🟡 主要级 (10 项)

- CI 测试覆盖率不足（缺集成测试和 UI 测试）
- 政策门禁执行点未完全覆盖 → `tests/unit/policy-audit.test.ts`
- Model adapter request hashing 无单元测试
- IPC runtime schema validation 无测试
- Model call ledger / cloud-call count 无集成测试
- Fixture 目录缺少 unsupported files 和 common code files
- 并发审计事件测试设计薄弱 → `pipeline-orchestrator.test.ts:131-150`
- E2E alpha-demo-path.test.ts 测试 12 不完整 → `:501-508`
- renderer-smoke.test.ts 仅验证导入
- 运行风险分类的单元测试位置不当

---

## Layer 8: Memory, AgentGroup, Recipes, A2A/MCP (18 项)

### 🔴 阻断级 (5 项)

#### 1. AgentGroupMode 枚举严重不完整
- **文件**: `src/shared/types.ts:92-94` + `pipeline-orchestrator.ts:86,343,552`
- **问题**: 枚举只有 `Pipeline = 'pipeline'`，缺少 `Parallel` 和 `Debate`。runParallel/runDebate 使用错误的枚举值。
- **修复建议**: 添加 `Parallel` 和 `Debate` 枚举值。

#### 2. Recipe 和 Self-Building 代码完全缺失
- **违反条款**: 08-memory-agentgroup-recipes-v1-requirements.md §5
- **问题**: 数据库 schema 有表但业务代码完全不存在。
- **修复建议**: 创建 `RecipeService`。

#### 3. MCP 工具访问完全缺失
- **违反条款**: 08-memory-agentgroup-recipes-v1-requirements.md §7.2

#### 4. runDebate 和 runParallel 没有收敛/合并/Judge 步骤
- **文件**: `pipeline-orchestrator.ts:327-528` (runParallel), `:535-770` (runDebate)
- **违反条款**: 08 §4.2

#### 5. Pipeline resume 设置状态为 'created' 而非 'running'
- **文件**: `pipeline-orchestrator.ts:301`

### 🟡 主要级 (6 项)

- proposeProcedural 缺少 Policy Check → `memory-service.ts:260-309`
- A2A Bridge 对 agentId 不做有效性验证 → `a2a-bridge.ts:31-125`
- LocalCommandAgentAdapter 的 allowlist 包含有写能力的命令 → `local-command-agent-adapter.ts:20-24`
- Data Safety Center 扩展未实现
- MemoryCenter UI 组件缺失
- 审计导出功能未实现

### 🟢 合规亮点 (7 项) - 已正确实现

- ✅ Memory Service 完全遵循 M3 设计原则（source-linked, user-confirmed, tombstone, policy, audit）
- ✅ Pipeline 边界约束完整（maxSteps/maxTokens/maxDuration）
- ✅ A2A Bridge 基本结构正确（任务映射、策略检查、审计）
- ✅ LocalCommandAgentAdapter 安全设计良好（spawn, shell元字符检测, allowlist, 环境限制, 哈希, 取消）
- ✅ 数据库 Schema 完整覆盖所有 Layer 8 实体
- ✅ 所有内存操作都有审计跟踪
- ✅ 搜索只返回已确认的记忆

---

## 🔴 全局 P0 优先级修复清单（Top 10）

| 优先级 | 问题 | 所属层 | 文件 |
|:------:|------|:------:|------|
| 1 | 修复 preload API 逃逸 | L1 | `electron/preload/preload.ts:14-20,54-55` |
| 2 | Secret 写入审计事件 | L1 | `src/core/secret-broker.ts` |
| 3 | RAG 检索移后到策略评估之后 | L3/L5 | `internal-agent-adapter.ts:66-72` |
| 4 | INSERT OR REPLACE → ON CONFLICT DO UPDATE | L2 | `database-service.ts:410-412` |
| 5 | Hash chain 追加加事务包裹 | L2 | `database-service.ts:116-159` |
| 6 | KnowledgeService.runIndexingJob 实现 | L4 | `knowledge-service.ts:116-160` |
| 7 | 实现 11 个策略执行检查点 | L3 | 多个文件 |
| 8 | Cancel 按钮连接真实逻辑 | L6 | `RunWorkspaceTab.tsx:396` |
| 9 | PhaseTimeline 补全 9 个阶段 | L6 | `RunWorkspaceTab.tsx:44-50` |
| 10 | reindexFolder 改 knowledge_base_id | L4 | `rag-engine.ts:167-177` |

---

> 本报告由 8 个独立子代理并行审查生成，未经人工逐条复核。
> 修复建议请按 🔴P0→🔴→🟡→🟢 优先级执行。
> 每个 batch 修复后建议重新运行 typecheck + test 验证。
