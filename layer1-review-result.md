# Layer 1 审查结果：仍存在问题清单

> 审查日期: 2026-07-03 | 依据: review-report.md + HEAD + 工作树变动 (git diff HEAD)

---

## 总览

| 严重级别 | 报告数量 | 工作树已修复 | 仍存在 |
|:--------:|:--------:|:-----------:|:-----:|
| 🔴 阻断级 | 11 | 2 (B1, B4) | **9** |
| 🟡 主要级 | 9 | 1 (M1) | **8** |
| 🟢 建议级 | 8 | 0 | **8** |
| **合计** | **28** | **3** | **25** |

---

## 工作树已修复的问题（3 项）

### ✅ B1. 预加载脚本暴露动态 IPC 逃逸通道
- **文件**: `ogra-desktop/electron/preload/preload.ts`
- **修复**: 删除了 `ALLOWED_IPC_CHANNELS` 遍历生成动态 API 的循环（原 14-20 行）和 `...api` 展开（原 55 行）
- **当前状态**: 只保留手写类型化 API 对象，`window.ogra` 不再暴露动态通道

### ✅ B4. 秘密使用无审计事件写入
- **文件**: `ogra-desktop/src/core/secret-broker.ts`
- **修复**: 构造函数添加可选的 `AuditService` 参数；新增 `setAuditService()` 方法；main.ts 中调用 `secretBroker.setAuditService(ograCore!.auditService)`；create/update/delete/getValue 四个方法均写入 `SecretUsed` 审计事件

### ✅ M1. SecretUpdate 处理器已注册但 preload 未暴露
- **文件**: `ogra-desktop/electron/preload/preload.ts`
- **修复**: preload 添加了 `secret.update` 入口（已存在对应 handler）

---

## 工作树新增的问题（1 项）

### ⚠️ 新问题: secret.delete 调用缺少传参
- **文件**: `ogra-desktop/electron/preload/preload.ts:94`
- **问题**: `secret.delete: (id: string) => ipcRenderer.invoke(IpcChannel.SecretDelete)` — 未将 `id` 参数传递给 `invoke`，预期是 `ipcRenderer.invoke(IpcChannel.SecretDelete, id)`
- **严重性**: 🔴 阻断级 — secret.delete 功能完全不可用

### ⚠️ 新问题: renderer/types.ts 缺少 secret.update
- **文件**: `ogra-desktop/src/renderer/types.ts:56`
- **问题**: preload 接口和运行时对象都有 `secret.update`，但 `renderer/types.ts` 中 `OgraAPI.secret` 缺少 `update` 方法
- **严重性**: 🟡 主要级 — 类型定义与运行时不一致

---

## 🔴 阻断级 — 仍存在问题（9 项）

### B2. AuditExport 通道无处理器注册
- **文件**: `ogra-desktop/electron/preload/preload.ts:80` → `ogra-desktop/electron/main/main.ts`
- **HEAD**: preload 无 audit.export，main.ts 也无 handler
- **工作树**: preload 已添加 `audit.export` 调用 `IpcChannel.AuditExport`（即 `audit:export`），但 **main.ts 仍未注册任何 AuditExport handler**
- **后果**: 调用 `window.ogra.audit.export(format)` 时将抛出 `"No handler registered for 'audit:export'"` 运行时错误
- **修复**: 在 main.ts 中添加 `IpcChannel.AuditExport` handler

### B3. Permission/Approval 通道定义但全无处理器
- **文件**: `ogra-desktop/src/shared/ipc-channels.ts:59-64`
- **问题**: `PermissionRequest`、`PermissionDecision`、`ApprovalRequest`、`ApprovalDecision` 四个通道定义在 `IpcChannel` 枚举和 `ALLOWED_IPC_CHANNELS` 中，但 `main.ts` 没有任何 handler 注册
- **工作树**: 未做任何修改
- **修复**: 注册 handler（至少占位 + audit），或从通道定义中移除

### B5. 缺少 workspaceId 服务器端校验
- **文件**: `ogra-desktop/electron/main/main.ts:WorkspaceSelect/WorkspaceUpdateClassification/DataSafetySummary/DataSafetyCloudCalls/KnowledgeBaseList/FolderImport` 等多个 handler
- **问题**: 多个 handler 将渲染器传入的 `workspaceId` 直接传递给 Ogra Core 服务，$未验证该 ID 是否真实存在于数据库中。可被用于枚举攻击或越权访问
- **工作树**: 未添加任何 `validateWorkspaceId()` 方法
- **修复**: 添加统一的 `validateWorkspaceId(workspaceId: string)` 方法，进入 handler 业务逻辑前查 DB 校验

### B6. 索引进度事件从未发送
- **文件**: `ogra-desktop/electron/main/main.ts` + `ogra-desktop/electron/preload/preload.ts:26-27,46,169`
- **问题**: Preload 定义了 `onIndexingProgress` 订阅 `IpcChannel.IndexingProgress`，但 `main.ts`（及整个代码库）中没有任何地方调用 `mainWindow.webContents.send('indexing:progress', ...)`
- **工作树**: `knowledge-service.ts` 修改后调用 `RagEngine.indexFolder()`，但该方法也未发送进度事件
- **修复**: 在 knowledgeService/knowledgeEngine 的索引方法中通过 `mainWindow.webContents.send('indexing:progress', ...)` 推送进度

### B7. 秘密加密密钥与密文并存
- **文件**: `ogra-desktop/src/core/secret-broker.ts:40-57`
- **问题**: 加密密钥存储在 `{appDataDir}/secrets/key.bin`，加密密文存储在 `{appDataDir}/secrets/secrets.enc.json`。两者位于同一目录
- **工作树**: 不涉及此问题
- **修复**: 使用 Electron 的 `safeStorage` API 加密密钥，或将密钥存储在 OS 原生的凭据管理器

### B8. Provider 路由/数据保留元数据缺失
- **文件**: `ogra-desktop/src/shared/types.ts:114`
- **问题**: `ProviderKind` 枚举只有 `Ollama` 和 `OpenAICompatible`，缺少内部/local/localCommand 等类型，且没有注册机制关联风险元数据（data-retention/training/region等）
- **工作树**: 不涉及此问题
- **修复**: 扩展 ProviderKind，添加风险元数据注册机制

### B9. 渲染器 types.ts 中 IpcResult 类型错误
- **文件**: `ogra-desktop/src/renderer/types.ts:11`
- **问题**: `IpcResult.error` 类型为 `string`，但实际运行时返回的 `error` 是 `{ code: string; message: string; details?: Record<string, unknown> }` 对象（定义在 `shared/ipc-channels.ts:87-95`）
- **工作树**: 未修复
- **修复**: 将 `error?: string` 改为 `error?: { code: string; message: string; details?: Record<string, unknown> }`

### B11. 路径遍历检测可能误报
- **文件**: `ogra-desktop/src/core/path-validator.ts:39`
- **问题**: `forwardNormalized.includes('..')` 会拒绝任何包含 `..` 子串的路径，如 `/home/user/some..project/docs`
- **工作树**: 不涉及此问题
- **修复**: 改用规范化前后路径比较的检测策略

---

## 🟡 主要级 — 仍存在问题（8 项）

### M2. ProviderUpdate 中 id 和 updates 参数逻辑模糊
- **文件**: `ogra-desktop/electron/main/main.ts:331-341`
- **问题**: `if (req.id)` 用 truthy 判断而非类型校验；`addOpenAICompatible(req)` 将整个 req 传递给添加方法
- **工作树**: 不涉及此问题
- **修复**: 显式区分 update/add 参数模式，添加 schema 校验

### M3. OgraCore 初始化不完整
- **文件**: `ogra-desktop/src/core/index.ts:63-65`
- **问题**: `initialize()` 只设置 `this.initialized = true`，无实际服务初始化或 DB 迁移
- **工作树**: 仅构造函数添加了 `ragEngine` 初始化和 `knowledgeService` 参数变更，`initialize()` 本身未变
- **修复**: 在 initialize() 中添加 DB 迁移调用、服务启动验证

### M4. shutdown() 方法为空
- **文件**: `ogra-desktop/src/core/index.ts:68-70`
- **问题**: shutdown() 是空函数，不会关闭数据库连接、清空秘密缓存或取消运行中任务
- **工作树**: 不涉及此问题
- **修复**: 实现服务优雅关闭（DB close, secret cache clear, abort in-flight runs）

### M5. 开发环境 CSP 允许 `http://localhost:*` 连接
- **文件**: `ogra-desktop/electron/main/main.ts:77`
- **问题**: 开发 CSP 中 `connect-src 'self' ws://localhost:* http://localhost:*` 允许渲染器通过 `fetch` 直接访问本地服务
- **工作树**: 不涉及此问题
- **修复**: 限制具体端口而非使用 `:*`

### M6. 渲染器 types.ts 的 OgraAPI 与 preload 接口不同步
- **文件**: `ogra-desktop/src/renderer/types.ts:14-67` vs `ogra-desktop/electron/preload/preload.ts:126-176`
- **问题**: 
  - preload 返回类型为 `Promise<unknown>`，renderer 为 `Promise<IpcResult>` — 类型不一致
  - renderer 的 `secret` 缺少 `update` 方法（工作树新增的不一致）
- **工作树**: 部分修复（添加了 audit.export / provider.update / secret.delete），但引入了新的不一致
- **修复**: 统一从 `src/shared/` 导出共享类型，消除 preload 和 renderer 的类型差异

### M7. 秘密值在错误消息中可能暴露
- **文件**: `ogra-desktop/src/core/secret-broker.ts:132`
- **问题**: `SECRET_ACCESS_DENIED` 错误代码不够稳定；`update()` 中 `req.value` 可能出现在错误消息中
- **工作树**: 不涉及此问题
- **修复**: 确认 error details 永远不会包含 secret value

### M8. ALLOWED_EXTERNAL_URLS 未审计
- **文件**: `ogra-desktop/electron/main/main.ts:425-428`
- **问题**: `url.startsWith(allowedUrl)` 匹配，`https://ogra-desktop.dev.evil.com` 也会被放行
- **工作树**: 不涉及此问题
- **修复**: 使用 URL 解析器验证 hostname 完全匹配

### M9. validateCallerContext 校验可能因窗口重建失败
- **文件**: `ogra-desktop/electron/main/main.ts:416-421`
- **问题**: 通过 `event.sender.id !== mainWindow.webContents.id` 验证调用者。窗口重建后（`mainWindow` 被赋新对象），旧 id 与新 id 不匹配
- **工作树**: 不涉及此问题
- **修复**: 使用 `BrowserWindow.fromWebContents(event.sender)` 获取调用者窗口

---

## 🟢 建议级 — 仍存在问题（8 项）

| ID | 文件 | 问题描述 | 当前状态 |
|:--:|:----|:---------|:--------:|
| S1 | `electron/main/main.ts:112-118` | IPC argCount 校验用 `>` 而非 `!==` | 工作树未变 |
| S2 | `electron/main/main.ts:10-12` | 全局变量 `mainWindow/ograCore/secretBroker` 应封装在 AppContext 单例 | 工作树未变 |
| S3 | `src/shared/ipc-channels.ts` | IPC 通道命名风格不统一（`workspace:create` vs `route-decision:fetch`） | 工作树未变 |
| S4 | `src/core/path-validator.ts` | PathValidator 缺少隐藏目录控制（未拒绝 `.git`、`node_modules` 等） | 工作树未变 |
| S5 | `secret-broker.ts:178-181` | `maskValue()` 暴露前4后4字符，可能泄露长度信息 | 工作树未变 |
| S6 | `electron/main/main.ts:104` | IPC handler 参数类型 `...args: any[]` 应改为 `unknown` | 工作树未变 |
| S7 | `electron/preload/preload.ts:23-51` | 订阅管理器当所有 listener 移除后，`ipcRenderer.on` listener 仍残留 | 工作树未变 |
| S8 | `src/shared/errors.ts:10-11` | `INVALID_INPUT` vs `INVALID_ARGUMENT` 语义重叠 | 工作树未变 |

---

## 总结

| 分类 | 原有问题数 | 工作树已修复 | 仍存在 | 工作树新引入 |
|:----:|:----------:|:-----------:|:-----:|:----------:|
| 🔴 阻断级 | 11 | 2 (B1, B4) | **9** | **1** (secret.delete 缺少传参) |
| 🟡 主要级 | 9 | 1 (M1) | **8** | **1** (renderer/types.ts 缺少 secret.update) |
| 🟢 建议级 | 8 | 0 | **8** | 0 |
| **合计** | **28** | **3** | **25** | **2** |

工作树已成功修复 3 个原始问题（B1、B4、M1），但引入了 2 个新问题（secret.delete 缺少传参、renderer/types.ts 缺 secret.update）。其余 25 个问题（含 9 个 🔴 阻断级、8 个 🟡 主要级、8 个 🟢 建议级）在 HEAD 和工作树中均未修复。
