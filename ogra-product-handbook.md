# Ogra / Ogra Edge 产品手册

> 版本：v0.1
>
> 日期：2026-07-02
>
> 定位：后续产品设计、技术实现、路线规划的最高指导文件

---

# 0. 核心结论

Ogra 不是另一个通用聊天客户端，也不是一开始就做完整 SaaS 平台。

Ogra 的长期方向是：

> **Ogra Desktop 是一个本地优先、端云混部、透明路由、可审计的个人 / 小团队 Agent 工作空间。**
>
> 它把用户的本地文件、个人知识库、长期记忆、Agent Group、多模型能力和 Ogra Edge 本地运行时统一起来，让用户在处理企业数据、代码、合同、财务资料等敏感信息时，明确知道：哪些数据留在本地，哪些数据上云，为什么上云，是否脱敏，调用了哪个模型，留下了什么审计记录。

Ogra 的差异化不是“大而全”，而是七个关键词：

1. **Local-first residency**：数据、知识库、记忆、审计默认本地。
2. **Hybrid-default compute**：同一任务默认按"本地读取 + 脱敏 + 云端推理 + 本地合成"分阶段执行；纯本地仅作为高安全选项保留。
3. **Three-tier egress**：所有出云动作必须经过 Auto-Filter-then-Egress / Log-then-Egress / Approve-then-Egress 三档确定性策略；Confidential 默认 Approve-then-Egress，Restricted 一律 Blocked。
4. **Independent ingress review**：每个云响应、工具返回、A2A 消息、MCP 结果都要经过独立于发起请求的 InternalAgentAdapter 的 Ingress Review Agent；可疑或恶意内容进入 quarantine 隔离表，附 incident。
5. **Transparent routing**：每次路由决策、出境模式、入境结论、re-sanitize 迭代历史都可见、可解释、可复盘。
6. **Auditable agent runs**：每次 Agent 协作都有本地审计轨迹和可导出的运行证据；Plan + ReAct 中间件强制 sanitize / policy / route / audit。
7. **White-box memory and orchestration**：记忆和多 Agent 编排对用户透明、可编辑、可中断；自组织 Agent Group 仍需用户明确确认。

Ogra Edge 是 Ogra 的本地运行时与端侧协同层，不是独立做成另一个产品线。第一阶段，Ogra Edge 内嵌在桌面端；后续可以演进为独立 edge daemon，支持多设备和边缘服务器。

---

# 1. 产品定位

## 1.1 一句话定位

**Ogra Desktop = 带数据治理和端云调度能力的本地 AI Agent 工作空间。**

更完整的定义：

> Ogra Desktop 让用户把个人知识库、企业资料、代码仓库、长期记忆和多 Agent 团队放在本地统一管理，并通过 Ogra Edge 的透明路由机制，在本地模型、云端模型、A2A Agent 和工具之间安全调度任务。

## 1.2 Ogra 要解决的问题

当前 Agent 产品常见问题：

1. 用户把企业数据交给 AI 时，不知道数据是否上云。
2. 多 Agent 协作过程黑盒，不知道哪个 Agent 读了什么、调用了什么、花了多少钱。
3. RAG 知识库和长期记忆割裂，Agent 不知道项目上下文，也无法解释记忆来源。
4. 本地模型和云端模型切换依赖用户手动判断，缺少策略化路由。
5. 现有巨型产品功能丰富，但对“隐私、安全、审计、端云混部”的表达不够强。

Ogra 的解决方式：

1. 所有知识库、记忆、审计日志默认本地保存。
2. 所有任务经过 Policy Engine 和 Router。
3. 所有 Agent 运行生成 Run Trace 和 Audit Log。
4. 敏感数据默认本地处理，必要上云时先脱敏、预览、确认。
5. 多 Agent 编排可见、可暂停、可编辑、可复用。

## 1.3 产品边界

Ogra 是桌面产品，不是纯 Web SaaS。

推荐形态：

```text
Ogra Desktop
  = Electron desktop shell
  + Web UI
  + Local Runtime
  + Ogra Edge
  + Optional Cloud Providers
```

Alpha 固定使用 Electron。Tauri 只作为未来轻量化 port / experimental runtime 评估，不进入第一阶段架构抽象。

第一阶段主形态是独立桌面应用。Web 形态只作为未来 companion：

- 查看同步数据
- 下载 recipes
- 浏览文档
- 远程查看审计报告

纯 Web 不是第一优先级，因为 Ogra 的核心能力依赖本地文件访问、后台索引、本地模型、本地审计、系统权限和数据安全心智。

---

# 2. 产品核心模块

## 2.1 用户空间

Ogra 第一阶段不做 SaaS 多租户，但必须有本地用户空间。

用户空间的最小模型：

```text
Workspace
  - id
  - name
  - type: personal / project / company
  - default_data_classification
  - knowledge_bases[]
  - agents[]
  - memories[]
  - policies[]
  - audit_logs[]
```

典型空间：

1. 个人空间：日常写作、研究、个人资料。
2. 项目空间：某个软件项目、论文项目、内容项目。
3. 企业资料空间：合同、代码、财务、内部文档。

关键原则：

- 空间之间默认隔离。
- 记忆默认只在当前空间生效。
- 知识库默认只被当前空间 Agent 读取。
- 用户可以显式开启跨空间共享。

## 2.2 RAG 个人知识库

RAG 是 Ogra Desktop 的一等能力，不是附属插件。

第一版支持：

- 文件夹导入
- Markdown / TXT / 常见代码文件
- 手动 reindex
- SQLite FTS 全文检索
- 可选本地 embedding 向量检索
- 引用来源展示
- 文件级数据分级

后置能力：

- PDF
- 自动增量索引
- 删除同步
- OCR
- Notion / 飞书 / Google Drive 同步
- 网页定时抓取
- 图片 / 音频知识库
- 团队共享知识库

RAG 输出必须带来源：

```text
答案
  - 引用文件
  - 引用片段
  - 检索方式：全文 / 向量 / 混合
  - 数据级别
  - 是否进入云端上下文
```

## 2.3 Agent Group 编排

Agent Group 是 Ogra 的主工作界面。

第一版只做三种编排模式：

1. **Pipeline**：顺序流，例如研究 -> 写作 -> 审阅。
2. **Parallel**：并行流，例如多个 Agent 同时分析同一问题。
3. **Debate**：辩论流，例如正方 / 反方 / 裁判。

暂不做无限自由对话。每次 Group Run 必须有边界：

- 最大轮次
- 最大 token
- 最大耗时
- 可暂停
- 可取消
- 可强制汇总
- 可查看中间结果

Agent Group 的核心不是“像群聊一样热闹”，而是让用户看清楚：

- 谁负责什么
- 读了哪些资料
- 调用了哪些模型
- 使用了哪些工具
- 哪些内容进入了云端
- 最终结论如何形成

## 2.4 M3 记忆

Ogra 的记忆系统不追求神秘化，必须白盒、可编辑、可追溯。

M3 在 Ogra 中定义为三类记忆：

1. **Episodic Memory（情景记忆）**
   - 记录发生过什么。
   - 字段：事件、时间、空间、参与 Agent、使用资料、结果、引用 Run。

2. **Semantic Memory（语义记忆）**
   - 记录稳定事实和偏好。
   - 字段：事实、主体、关系、来源、置信度、更新时间。

3. **Procedural Memory（程序记忆）**
   - 记录可复用流程。
   - 字段：任务类型、推荐 Agent Group、工具链、路由策略、失败经验。

记忆系统必须支持：

- 来源追踪
- 置信度
- 用户编辑
- 用户删除
- 生效范围
- Agent 读取权限
- 重要记忆确认

Beta v0 只自动写入 Episodic Memory，即 run summaries。Semantic Memory 和 Procedural Memory 必须经过用户确认后写入。M3 的差异化不是三分类本身，而是每条记忆都能追溯到 run、文件、route decision 和用户确认。

禁止设计：

- 静默写入高影响记忆
- 无来源记忆
- 全局默认注入所有 Agent
- 记忆不可删除

## 2.5 自构建组织

自构建组织是 Ogra 的高级差异化，但第一阶段必须“人类确认优先”。

定义：

> 当 Coordinator 判断当前 Agent Group 缺少某种能力时，Ogra 可以从本地 recipes / agents 中推荐候选 Agent，由用户确认后加入当前任务。

第一版流程：

```text
1. 用户发起任务
2. Coordinator 分析能力缺口
3. 搜索本地 Agent recipes
4. 推荐 1-3 个候选 Agent
5. 用户确认
6. Agent 加入 Group
7. 协作完成
8. 可保存为新 workflow
```

不做：

- 自动下载安装未知插件
- 自动拉取 GitHub repo 执行
- 自动开启 shell 权限
- 自动访问高敏数据
- 无用户确认的跨空间招募

## 2.6 Data Safety Center

Data Safety Center 是 Ogra 的数据安全操作台，关注“数据能不能出去、如何出去、有没有记录”。

它管理：

- 数据资产地图
- 数据分级
- 文件夹 / 知识库敏感级别
- 模型白名单
- 云端 provider 允许策略
- 上云审批规则
- 脱敏规则
- 审计日志
- 最近上云记录
- 0 Ogra-managed cloud calls 记录

数据资产地图必须覆盖：

- workspace
- knowledge base
- folder
- file
- memory
- embedding index
- 数据级别
- 继承来源
- 最近访问
- 最近上云
- 关联策略
- 可访问 Agent

“0 Ogra-managed cloud calls” 的口径：

> Ogra 只能证明通过 Ogra-controlled adapters 发起的外部模型调用为 0。它不覆盖用户手动复制、第三方 Agent 绕过 Ogra、系统级网络流量、外部工具自身遥测或本机其他进程的网络行为。

典型界面信息：

```text
任务：分析 Q2 财务异常
数据级别：Confidential
路由结果：Local only
使用模型：Qwen local via Ollama
原因：财务数据策略禁止上云
云端调用：0
审计状态：已记录
```

混合任务界面：

```text
本地阶段：读取原始财务表，提取匿名异常模式
云端阶段：仅发送脱敏摘要给 Claude / GPT / Qwen Cloud
上传内容：不包含账户名、地址、金额明细
用户确认：已确认
审计状态：已记录 payload hash
```

## 2.7 Local Agent Control Plane

Local Agent Control Plane 是 Ogra Desktop 的本机多 Agent 统一入口。

定义：

> Ogra Desktop 提供统一入口，用 supervised launcher + transcript/audit wrapper 的方式注册、授权、运行和审计本机 Agent runtime。Codex、Claude Code、Hermes Agent、Aider、Open Interpreter、本地脚本 Agent 等可以逐步作为 Ogra Agent Group 的成员参与任务。

这使 Ogra 不只是“又一个 Agent”，而是用户本机 Agent 的控制平面。

第一版不承诺完整控制第三方 Agent 的内部状态，只定义本地 Agent 接入契约。

AgentAdapter contract：

- `capabilities`
- `run(input)`
- `stream events`
- `cancel`
- `permission requests`
- `artifacts`
- `audit level`

本地 Agent 运行时示例：

```text
CodexAdapter
ClaudeCodeAdapter
HermesAdapter
AiderAdapter
OpenInterpreterAdapter
LocalCommandAgentAdapter
A2ALocalAgentAdapter
```

第一阶段不要求完全控制这些工具的内部状态，只要求能安全地把它们作为可授权、可审计、可编排的本地执行者接入 Ogra。

审计等级：

```text
Level 1
  - process start / stop
  - stdout / stderr transcript
  - input / output hash

Level 2
  - declared file access
  - declared tool request
  - permission prompts

Level 3
  - structured tool trace
  - structured artifacts
  - cancellable structured run
```

不同 AgentAdapter 可以支持不同审计等级。Ogra 只能审计和约束通过 Ogra adapter 发起的动作；外部工具若直接运行或绕过 adapter，不应被产品承诺为受控。

禁止设计：

- 默认授予所有本地 Agent 全盘文件权限
- 默认允许本地 Agent 执行 shell
- 默认允许本地 Agent 读取所有 workspace
- 在无 trace 的情况下调用外部 Agent
- 在无审计记录的情况下让外部 Agent 读取敏感知识库

## 2.8 AI Governance Center

AI Governance Center 是 Ogra 的 AI 安全治理入口，关注“Agent 能不能这么做、风险是否被接受、证据是否可导出”。

它管理：

- Model Registry
- Policy Registry
- Data Classification Registry
- Agent Risk Profile
- Approval Workflow
- Audit Reports
- Incident Review
- Governance Dashboard
- Risk Exceptions
- Compliance Export

Data Safety Center 是数据安全操作台；AI Governance Center 是治理和审批入口。第一阶段可以在同一个 UI 中实现，但文档和架构上必须区分职责。

第一阶段不声称满足 ISO / EU AI Act / 企业合规认证。Ogra 提供的是 AI governance primitives：

- policy
- permissions
- routing
- audit trail
- human approval
- incident records
- exportable run evidence

---

# 3. Ogra Edge

## 3.1 一句话定位

**Ogra Edge = Ogra Desktop 的本地运行时、端侧模型节点和端云路由执行层。**

第一阶段，Ogra Edge 是 Desktop 内部 runtime 名称，不作为独立产品线对外宣传。后续当本地 runtime 被真实复用后，再拆成独立 daemon。

```text
Ogra Desktop UI
  -> Ogra Core
  -> Ogra Edge Runtime
     - local model adapter
     - local RAG indexer
     - local memory engine
     - local policy engine
     - local audit log
```

## 3.2 Ogra Edge 负责什么

Ogra Edge v0 暴露以下最小接口：

```text
planTask(input)                       -> Plan
evaluatePolicy(input)                 -> PolicyEvaluationResult
selectEgressMode(classification)      -> auto_redact | log_and_proceed | approve_then_egress | blocked
runRedactionEngine(payload, version)  -> RedactedPayload
awaitApproval(redaction)              -> approved | rejected
reSanitize(payload)                   -> RedactedPayload  (stricter rule version)
invokeModel(request)                  -> ModelResult
reviewIngress(response)               -> IngressFinding  (separate process)
quarantineIngress(finding, content)   -> QuarantineId
retrieveContext(query, scope)         -> RetrievedContext
writeAuditEvent(event)                -> AuditEventId
manageSkills(query)                   -> Skill[]
invokeSkill(skillId, params)          -> SkillResult
```

Ogra Edge 负责：

1. 本地模型调用
   - Ollama
   - llama.cpp
   - OpenAI-compatible local endpoint

2. 本地知识库索引
   - 文件扫描
   - chunk
   - embedding
   - FTS
   - 向量检索

3. 本地策略执行
   - 数据分级
   - 出境模式选择（auto_redact / log_and_proceed / approve_then_egress / blocked）
   - 脱敏引擎调用与版本管理
   - Approve-then-Egress 用户审批与 re-sanitize 循环
   - Ingress Review Agent 调用（独立进程）
   - Quarantine 隔离与处理

4. 本地审计
   - Run Trace
   - Agent Tool Calls
   - Cloud Payload Hash（含出境模式与脱敏规则版本）
   - Ingress Findings
   - Re-sanitize 迭代历史
   - Route Decision

5. 端云路由
   - local
   - cloud
   - hybrid
   - blocked

6. Plan + ReAct 执行
   - 本地 LLM 生成 Plan（只读任务抽象与能力清单）
   - 每个 step 走 ReAct 循环，强制经过 sanitize / policy / route / audit 中间件
   - run_step_actions 强持久化，支持 crash / 断电 / 用户中断后从最后 Observation 恢复

7. Skills Market
   - built-in 技能（报告生成、代码审查、数据分析）
   - local-recipe 技能
   - 每次 use_skill 写入 skill_invocations

8. 本地 Agent 控制
   - 发现本机 Agent runtime
   - 注册 Agent capabilities
   - 启动 / 停止本地 Agent
   - 管理工作目录和权限
   - 将本地 Agent 纳入 Agent Group
   - 对本地 Agent 执行过程生成 trace 和 audit

本地 Agent runtime control 不进入 Alpha 核心闭环。Alpha 只做 InternalAgentAdapter 和 LocalCommandAgentAdapter（read-only supervised）；v1.0 再做 Codex / Claude Code / Aider / Open Interpreter 等外部 Agent adapter。

## 3.3 端云混部

端云混部不是“用户手动选本地模型或云端模型”，而是任务级分阶段执行，并显式选择出境模式。

典型混部模式：

```text
Local-only
  - 严格受限数据
  - 用户工作区策略强制
  - 离线场景

Cloud-only
  - 公开研究
  - 通用写作
  - 不含私有上下文的复杂推理
  - 出境模式：Auto-Filter-then-Egress（Public / Internal 标准）

Hybrid
  - 本地读取原始资料
  - 本地脱敏 / 摘要 / 特征提取
  - 云端复杂分析
  - 本地合成最终报告
  - 出境模式取决于数据级别：
      * Public / Internal(标准)       -> Auto-Filter-then-Egress
      * Internal(高敏感)             -> Log-then-Egress
      * Confidential                 -> Approve-then-Egress（预览 + 用户确认后出云）
      * Restricted                   -> Blocked

Blocked
  - 策略禁止
  - 用户未确认（Approve 模式）
  - 模型不在白名单
  - Restricted 触发
```

### 3.3.1 出境三档

```text
Task requires cloud compute
  -> Policy engine evaluates data classification
    -> Public                       -> Auto-Filter-then-Egress
    -> Internal(standard)           -> Auto-Filter-then-Egress
    -> Internal(high-sensitivity)   -> Log-then-Egress
    -> Confidential                 -> Approve-then-Egress
    -> Restricted                   -> Blocked
```

Approve-then-Egress 的拒绝处理走 re-sanitize 循环：用户拒绝后系统记录 `rejected` 事件，应用更严格的脱敏规则版本（或用户指定的排除项），生成新预览，继续直到 `approved` 或 `aborted`。每一次迭代都写入审计。这是 "send back for rework" 循环，不是 "deny and block"。

### 3.3.2 入境审核

每个云响应、工具返回、A2A 消息、MCP 结果都要经过 Ingress Review Agent（独立于发起请求的 InternalAgentAdapter 进程）。Ingress Review Agent 产出 `clean / suspicious / malicious` 三类结论：

- clean：进入本地合成；写入 `log` 入境记录。
- suspicious：进入 quarantine 隔离表，触发 incident，用户通过受限沙箱视图查看 sanitized summary。
- malicious：丢弃、incident、用户可尝试 "clean and proceed"（剥离注入、保留合法内容、过程计入审计）。

## 3.4 透明路由

每次任务必须生成 Route Decision 和 Egress Record：

```json
{
  "task_id": "run_123",
  "route": "hybrid",
  "data_classification": "confidential",
  "egress_mode": "approve_then_egress",
  "redaction_rule_version": "rule_set_a_v3",
  "reason": [
    "knowledge base contains confidential files",
    "redaction policy enabled",
    "user approval required for confidential egress"
  ],
  "local_steps": ["retrieve", "redact", "await_approval", "synthesize"],
  "cloud_steps": ["reason"],
  "requires_user_approval": true,
  "approval_id": "approval_456",
  "ingress_findings": ["ingress_789"],
  "audit_log_id": "audit_123"
}
```

透明路由是产品承诺。用户不能只看到最终答案，必须能看到决策路径、出境模式、脱敏规则版本、审批记录、入境审核结论、re-sanitize 迭代历史。

---

# 4. 数据治理与审计

## 4.1 数据分级

Ogra 内置四级数据分类：

| 级别 | 含义 | Alpha 默认出境模式 |
|---|---|---|
| Public | 公开信息 | Auto-Filter-then-Egress（自动脱敏可放行；可上云） |
| Internal(标准) | 一般内部信息 | Auto-Filter-then-Egress（自动脱敏后上云） |
| Internal(高敏感) | 高敏感内部信息 | Log-then-Egress（脱敏后上云，全审计） |
| Confidential | 机密信息 | Approve-then-Egress（脱敏 + 用户预览 + 用户批准） |
| Restricted | 严格受限 | Blocked（只允许指定本地模型和指定 Agent） |

数据分级来源：

1. 用户手动标记。
2. Workspace 默认级别。
3. 文件夹继承。
4. 简单敏感信息检测。
5. Agent / Policy 运行时升级。

第一版不要依赖 LLM 自动判断敏感级别，因为敏感判断本身可能导致数据外泄。优先用用户标记和本地 detector。

## 4.2 Policy Engine

Policy Engine 是 Ogra 的治理核心。

Policy 必须在以下执行点生效：

- RAG 检索前
- 上下文组装前
- embedding 请求前
- 模型调用前
- 工具调用前
- Agent delegation 前
- 文件导出前
- 记忆写入前
- 审计查看和导出前

示例：

```yaml
policies:
  - name: confidential-local-only
    match:
      data_classification: confidential
    route:
      allowed_compute: local
      cloud_upload: false

  - name: internal-redacted-cloud
    match:
      data_classification: internal
      task_complexity: high
    route:
      allowed_compute: hybrid
      require_redaction: true
      require_user_approval: true

  - name: restricted-model-whitelist
    match:
      data_classification: restricted
    route:
      allowed_models:
        - local:qwen
        - local:llama
      cloud_upload: false
```

策略优先级：

1. Restricted / Confidential 规则
2. deny 优先
3. 用户显式禁用上云
4. Workspace 策略
5. 文件 / 知识库策略
6. 工具 / Agent 权限
7. 用户批准
8. 默认 local-only 或 blocked

策略冲突处理：

- 高敏级别优先。
- deny 优先于 allow。
- Workspace owner override 必须写审计。
- 无匹配策略时不得默认 public/cloud。
- Alpha 只支持确定性字段：workspace、file classification、provider、model、tool、requires_cloud、user approval。
- `task_complexity` 等启发式路由只进入 Beta 或更晚版本。

Policy Simulator / Dry Run：

> 用户可以输入任务、数据级别、Agent、模型、工具，预览 route、blocked reason、将上传 payload 摘要和需要的批准项。

## 4.3 Audit Log

每次运行都必须记录：

- run_id
- workspace_id
- task
- participating_agents
- accessed_files
- accessed_memories
- data_classification
- route_decision
- local_model_calls
- cloud_model_calls
- cloud_provider
- redaction_summary
- uploaded_payload_hash
- user_approval
- tool_calls
- final_output_location
- timestamps

审计日志第一阶段保存在本地 SQLite，不做中心化合规系统。

审计实现原则：

- 使用 append-only `run_events`，而不是只写最终 `audit_logs`。
- 每条事件记录 previous_hash 和 event_hash，形成本地 hash chain。
- 记录 payload hash、policy version hash、redaction rule version。
- 审计日志删除、导出、清理也必须生成事件。
- 审计日志默认不保存完整 prompt / payload，只保存摘要、hash、分类、来源引用和用户可选的加密快照。
- 审计日志本身也有数据分级和访问权限。
- 删除后保留 tombstone 记录。
- Alpha 只承诺 local audit trail，不承诺合规级不可抵赖。

## 4.4 AI Run Risk Classification

每次 Agent run 必须生成风险分类。

风险分类输入：

- workspace 默认级别
- 知识库 / 文件数据级别
- Agent 权限
- 工具权限
- 是否读取长期记忆
- 是否调用本地 Agent runtime
- 是否调用云端模型
- 是否涉及文件写入 / shell / 网络访问
- 是否触发 prompt injection warning

风险分类输出：

```json
{
  "run_id": "run_123",
  "risk_level": "high",
  "risk_reasons": [
    "confidential knowledge base accessed",
    "external agent requested",
    "file write permission requested"
  ],
  "required_approvals": [
    "allow_external_agent",
    "allow_file_write"
  ],
  "status": "awaiting_user_approval"
}
```

风险分类不是法律结论，而是 Ogra 的运行时治理信号。它用于决定是否继续、是否需要用户确认、是否记录 incident。

## 4.5 Data Egress And Leakage Paths

Ogra 必须显式建模数据外泄路径：

**Ogra 受控的出/入境路径：**

- 模型 payload（含出境模式、脱敏规则版本、payload hash、approval id）
- embedding 请求
- 入境审核结论（Ingress Review Agent 输出）
- Quarantine 隔离内容与 incident
- Ogra-managed exports
- Ogra-managed tool calls
- Ogra-launched local agent inputs/outputs

**Ogra 不可控的出/入境路径：**

- provider 日志保留
- provider 端云模型内部 chain-of-thought 与 provider 端 tool calls
- crash report
- telemetry
- export
- clipboard
- screenshots
- browser tools
- MCP tools / remote A2A agents（超出 Ogra 适配器外）
- 本地 Agent 网络请求（适配器未做网络限制时）
- Agent stdout / stderr（Ogra 未捕获的部分）
- 用户 copy/paste

Data Safety Center 和 AI Governance Center 必须能解释 Ogra 管控了哪些路径、没有管控哪些路径。产品文案必须诚实：

> Ogra 记录跨越你机器和云端之间边界的全部内容。它无法——也不会——记录数据抵达云供应商后，在供应商基础设施内部发生的事。你送出了什么、为什么送、送回的是什么：这些可审计。模型内部的思考链：那是供应商的事。

---

# 5. 商业分析

## 5.1 市场定位

Ogra 面向高知识密度、高隐私敏感、高本地文件依赖的用户：

1. 独立开发者 / 工程师
   - 代码仓库 RAG
   - 本地模型
   - 多 Agent code review / planning

2. 产品经理 / 研究者 / 写作者
   - 个人知识库
   - 多 Agent 分析 / 写作 / 审阅
   - 可复用流程

3. 财务 / 法律 / 咨询等专业人士
   - 敏感文档
   - 本地审计
   - 不轻易上云

4. 小团队 / 企业内部早期用户
   - 不是为了完整团队 SaaS
   - 是为了本地可控地使用企业资料

## 5.2 与 LobeHub 的关系

LobeHub 是巨型 Agent 工作空间，公开 README 中已经明确描述了 Chief Agent Operator、Agent Builder、Agent Groups、Schedule、Project、10,000+ skills / MCP-compatible plugins 等能力。

Ogra 不避免重叠，但不正面拼“大而全”。

| 维度 | LobeHub | Ogra |
|---|---|---|
| 主定位 | Chief Agent Operator | Local-first Agent Workspace |
| 核心卖点 | Agent 团队、调度、生态 | 端云混部、透明路由、数据安全审计 |
| 产品形态 | Web / self-host / desktop 生态 | 独立桌面优先 |
| 知识库 | 产品能力之一 | 核心工作对象 |
| 记忆 | Personal Memory | M3 白盒记忆，来源可追溯 |
| 多 Agent | Agent Groups | 可观察编排 + Policy-aware routing |
| 数据治理 | 不是核心叙事 | 核心叙事 |
| Edge | 非主叙事 | Ogra Edge 是基础层 |
| 用户心智 | 组织 Agent 工作 | 安全地用本地和企业数据跑 Agent |

Ogra 的商业切口：

> **LobeHub 帮用户组织 Agent；Ogra 帮用户在本地和云端之间安全、透明、可审计地运行 Agent。**

## 5.3 商业模式

第一阶段是开源桌面产品，不以 SaaS 收入为目标。

可选商业路径：

1. Open Core
   - 免费：个人桌面版、本地 RAG、Agent Group、Ogra Edge。
   - 付费：团队同步、企业策略包、审计导出、集中管理。

2. Pro Desktop
   - 高级本地模型管理
   - 高级知识库连接器
   - 高级审计报告
   - 高级 recipes

3. Managed Control Plane
   - 多设备同步
   - 团队策略下发
   - 审计日志集中查看
   - Edge 节点管理

4. 企业部署 / 咨询
   - 私有部署
   - 数据治理适配
   - 内部知识库接入

不进入第一阶段：

- Stripe 订阅
- 企业销售
- SSO / SAML
- 多租户 SaaS
- 模板市场分成

## 5.4 开源价值

Ogra 作为开源项目的传播点：

1. 本地优先 Agent 工作空间。
2. 端云混部路由器。
3. 可审计的 Agent runs。
4. 白盒记忆系统。
5. 可复用 Agent Group recipes。

README 的主张应该简短：

> Run agents over your private knowledge base with local-first memory, transparent edge/cloud routing, and auditable traces.

---

# 6. 技术架构

## 6.1 推荐技术形态

第一阶段推荐：

```text
Electron Desktop
  - React / Vite UI
  - Main Process
  - Preload IPC
  - Local Runtime
```

原因：

- Ogra 需要大量本地能力：文件访问、后台索引、SQLite、模型适配、审计落盘。
- Electron 的 main / renderer / preload 模型适合把系统权限和 UI 隔离。
- Web UI 能快速构建复杂工作台。

Tauri 可作为中长期替代或第二实现，不进入 Alpha：

- 优点：轻量、安全边界清晰、Rust 后端。
- 风险：早期会增加 TypeScript + Rust 双栈复杂度。

第一阶段不要做纯 Web，因为纯 Web 对本地文件长期索引、本地模型、本地审计和后台任务支持不足。

## 6.2 进程架构

```text
Renderer Process
  - Chat Workspace
  - Agent Group Board
  - Knowledge Base
  - Memory Center
  - Data Safety Center
  - AI Governance Center
  - Route Trace Viewer

Preload
  - Safe IPC bridge
  - Typed APIs

Main Process
  - App lifecycle
  - IPC gateway
  - Permission gate
  - Window / tray / updater
  - Secret access broker

Ogra Core
  - Policy Engine
  - Router
  - Orchestrator
  - Memory Engine
  - RAG Engine
  - Audit Logger

Ogra Edge
  - Local model execution
  - Local indexing
  - Local-only task execution
  - Local agent runtime control
```

Main Process 不直接承载长任务。RAG indexer、embedding、model calls、agent runners 必须运行在 worker thread / child process / sidecar service 中，避免 UI 生命周期、权限门禁和外部进程控制混在一起。

Alpha IPC 边界：

- Renderer 只能通过 typed IPC 请求能力。
- Main 只做权限校验和任务转发。
- Ogra Core / Ogra Edge 执行任务并写事件。
- Renderer 不能直接读取 API keys。
- Renderer 不能直接访问数据库文件。

## 6.3 本地存储

第一阶段：

- SQLite：核心数据、workspace、agent、memory、runs、audit。
- SQLite FTS5：全文检索。
- sqlite-vec：本地向量检索。
- 文件系统：原始文档、索引缓存、导出文件。
- OS secret store：API keys。

后置：

- DuckDB：结构化数据分析。
- LanceDB：大规模知识库后续评估。
- Postgres：团队 / 云同步。
- Object storage：多设备同步。

## 6.4 核心数据模型

```text
workspaces
knowledge_bases
documents
document_chunks
agents
agent_groups
agent_group_runs
messages
memories
policies
route_decisions
audit_logs
model_providers
tool_calls
recipes
run_events
policy_evaluations
approvals
permissions
artifacts
secrets_metadata
```

RAG 索引字段必须支持可复现审计：

- `content_hash`
- `parser_version`
- `chunker_version`
- `embedding_model_id`
- `embedding_dim`
- `source_offsets`
- `classification_snapshot`
- `indexed_at`
- `source_trust_level`
- `instructional_content_detected`
- `allowed_for_context`

## 6.5 Provider / Adapter

模型适配必须插件化：

```text
ModelAdapter
  - OpenAI
  - Anthropic
  - Gemini
  - OpenRouter
  - Ollama
  - llama.cpp
  - any OpenAI-compatible endpoint
```

Agent / protocol 适配：

```text
AgentAdapter
  - internal agent
  - A2A-compatible agent
  - MCP tool-backed agent
  - local script agent
  - Codex agent
  - Claude Code agent
  - Hermes agent
  - Aider agent
  - Open Interpreter agent
```

不要把系统绑定在单一 Hermes / LobeHub / LangChain 之上。可以借鉴，但不能成为不可替换核心依赖。

AgentAdapter 必须声明 capability matrix：

- can_start
- can_cancel
- can_stream_output
- can_limit_workdir
- can_capture_tool_calls
- can_report_artifacts
- can_enforce_network
- can_enforce_shell
- audit_level: 1 / 2 / 3

Alpha 只实现 `InternalAgentAdapter`。Beta 可增加 `LocalCommandAgentAdapter` 的 read-only 模式。外部 Agent adapter 进入 v1.0 或更晚版本。

## 6.6 A2A 策略

Ogra 应兼容 A2A，而不是自创封闭 A2A v2。

产品表达：

> Ogra supports A2A-compatible agents and adds local policy, route trace, and audit metadata around agent delegation.

实现策略：

- 内部先用 Ogra Run / Message schema。
- v1.0 前先做 adapter mapping 文档。
- 最小可行桥接：接收 A2A task -> 转内部 run -> 返回 final artifact。
- streaming、远程工具调用、复杂 artifact、auth delegation 后置。
- 路由元数据作为 Ogra extension，不破坏 A2A 基础模型。

---

# 7. 安全模型

## 7.1 默认安全原则

1. 私有数据默认不出本地。
2. 上云前必须经过 Policy Engine。
3. 高敏数据上云必须用户确认。
4. 工具权限最小化。
5. shell / 文件写入 / 网络访问必须显式授权。
6. Agent 不能默认读取所有知识库和所有记忆。
7. 所有关键行为写审计日志。

## 7.2 插件和工具安全

第一阶段只允许内置工具：

- 文件读取
- 文件搜索
- RAG 检索
- 文本生成
- 摘要
- 简单导出

后置开放：

- shell
- git
- browser
- MCP tools
- remote A2A agents

高风险工具必须带权限弹窗和审计。

## 7.3 脱敏

第一版脱敏只做明确规则，但所有规则都属于版本化的 `redaction_rule_sets` / `redaction_rule_versions`：

- email
- phone
- address pattern
- API keys
- private keys
- ID numbers
- account numbers
- company-specific keywords

不承诺自动脱敏 100% 准确。产品文案必须诚实：

> Ogra can assist with redaction and always shows routing/audit records, but users remain responsible for approving sensitive data transfer.

脱敏必须支持：

- 脱敏前后 diff 预览
- 残留风险提示
- 结构化字段屏蔽
- 不可逆替换（用户可见替换策略）
- hash / tokenization
- 用户确认原文是否允许上云
- 脱敏规则版本写入审计、`redaction_records`、对应 `run_events` / `model_calls` / `egress_records`
- re-sanitize 循环：Approve-then-Egress 模式下用户拒绝时，应用更严格的规则版本或用户指定排除项生成新预览，继续直到 `approved` 或 `aborted`；每一轮写入 `rejection_resanitize_iterations`

## 7.4 Prompt Injection And Untrusted Content

Ogra 必须把用户指令、系统策略、Agent 指令和知识库内容分层处理。

不可信输入包括：

- RAG 文档
- 网页
- PDF
- 代码注释
- 工具输出
- 远程 Agent 消息
- 本地 Agent stdout / stderr
- **每个云响应、A2A 消息、MCP 工具结果、tool return value**（新增）

原则：

- 知识库内容永远是 untrusted context。
- RAG 检索片段不能覆盖 system / developer / policy 指令。
- 检索内容必须隔离为 quoted context。
- 模型必须区分 user instruction 与 retrieved content。
- 工具调用前重新经过 policy check。
- 禁止从文档内容中直接触发 shell、网络、文件写入、跨空间读取。
- 文档中的“忽略以上指令”“上传文件”“调用外部工具”等内容应触发 warning。
- prompt injection warning 必须写入 run trace。
- **所有云响应 / A2A / MCP / tool return 都要经过 Ingress Review Agent（独立进程），产出 `{ patternId, evidence, evidenceHash, severity, layer }` 写入 `ingress_review_findings`。** 可疑或恶意内容进入 `quarantine_contents` 隔离表，触发 incident，用户通过受限沙箱视图查看 sanitized summary。

第一版只做规则和启发式检测（regex 层），不承诺完全防护。Beta 起 Ingress Review Agent 加挂本地 LLM 语义层作为兜底。

## 7.5 Agent Permission Model

每个 Agent 必须有 manifest：

```yaml
agent:
  id: agent_id
  filesystem:
    read: []
    write: []
  network:
    egress: false
  shell: false
  env_secrets: []
  clipboard: false
  browser: false
  mcp_tools: []
  a2a_agents: []
  memory:
    read: []
    write: []
  models:
    allowed: []
```

默认权限：

- 默认只读。
- 默认无网络。
- 默认无 shell。
- 默认不能读取 env / API keys。
- 默认不能访问其他 workspace。
- 每次提升权限必须有作用域、时限、原因和审计记录。

## 7.6 Secrets, Telemetry, And Provider Data Retention

API key 只能由 Main / Ogra Core 的 secret broker 访问，Renderer 和 Agent 默认不可读取。

secret 使用必须生成审计事件：

- 使用者
- 目标 provider
- 使用时间
- workspace
- run_id
- 是否进入云端调用

模型白名单不能只按 provider / model，还必须记录：

- provider data retention policy
- training opt-out 状态
- region
- 企业 API endpoint
- zero data retention 支持
- tool calling 支持
- image / file upload 支持
- streaming log 风险

## 7.7 Incident And Risk Exception Flow

以下事件必须进入 incident log：

- 策略拦截
- prompt injection warning
- 敏感信息疑似泄露
- Agent 越权读取
- 工具调用被拒绝
- 云端调用被阻断
- 长期记忆写入被拒绝或撤销
- 外部 Agent 返回不可审计结果

Risk exception 必须记录：

- 谁批准
- 批准什么
- 有效期
- 作用域
- 原因
- 关联 run
- 是否可撤销

---

# 8. MVP 路线图

## 8.1 Alpha：Hybrid-Default 核心闭环

目标：证明 Ogra 的 hybrid-default 闭环成立——本地数据通过出境三档策略可控地上云，云端响应通过独立 Ingress Review Agent 可信地回到本地，全程审计可复盘。

Alpha demo path：

```text
导入敏感文件夹
  -> 标记 Confidential
  -> 本地 RAG 检索（policy 评估先于检索）
  -> Policy 判定：data_classification = confidential
                egress_mode = approve_then_egress
  -> 脱敏引擎生成 sanitized preview
  -> 展示 preview + 脱敏规则版本 + payload hash
  -> 用户 approve（或走 re-sanitize 循环）
  -> 出云（云端推理）
  -> 云响应回到本地
  -> Ingress Review Agent 独立进程扫描（patternId, severity, layer）
  -> clean / suspicious / malicious 三档处理
  -> 本地合成最终答案
  -> 展示：
      * 0 Ogra-managed cloud calls（如确实没有出境）或
        出境次数 + 出境模式（approve / log / auto-filter）
      * route decision（含 egress_mode 与 redaction_rule_version）
      * re-sanitize 迭代历史（如发生）
      * ingress findings 列表
      * quarantine 提示（如发生）
      * local audit trail（hash chain 完整）
```

范围：

1. 桌面壳
2. 本地 workspace
3. Markdown / TXT / code 文件夹导入
4. 手动 reindex（带进度事件）
5. SQLite FTS5 检索
6. Ollama adapter
7. OpenAI-compatible adapter
8. InternalAgentAdapter（Plan + ReAct + 强持久化 + sanitize/policy/route/audit 中间件）
9. LocalCommandAgentAdapter（read-only supervised，Beta 起限定允许列表）
10. 基础 Policy Engine（出境三档 + 入境三档 + Restricted blocked）
11. 脱敏引擎（版本化规则集 + diff 预览 + re-sanitize 循环）
12. Ingress Review Agent（独立进程，regex 层；语义层 v1.0）
13. Quarantine 隔离表与受限沙箱视图
14. Route Decision（含 egress_mode、redaction_rule_version、ingress findings）
15. Append-only local audit trail（hash chain 完整）
16. Data Safety Center v0（含出境模式、ingress 摘要、scheduled/continuous run 摘要）
17. AI Governance Center v0（含 egress approval queue、ingress incident、per-agent ingress/egress 统计）
18. Agent Group：Pipeline + Parallel + Debate 三种模式，per-step policy/audit
19. Agent Group 调度：interval + continuous，per-iteration 与 lifetime-level bounds
20. Skills Market：built-in + local-recipe，每次 use_skill 审计
21. 审计导出（NDJSON/CSV，policy-gated）
22. M3 记忆中心（episodic 自动；semantic/procedural 需用户确认）

成功标准：

- 用户能导入一个文件夹。
- 用户能给 workspace / 文件夹标记数据级别。
- Ogra 能根据数据分级自动选择出境模式（auto_redact / log_and_proceed / approve_then_egress / blocked）。
- Confidential 数据走 Approve-then-Egress：预览 → 用户 approve → 出云；用户 reject → re-sanitize 循环 → 新预览。
- 云响应回到本地前被独立 Ingress Review Agent 扫描，clean / suspicious / malicious 分类与对应处理。
- 用户能用本地模型或云端模型完成一次私有资料问答。
- 用户能看到 route decision、出境模式、脱敏规则版本、审批记录、ingress findings、re-sanitize 迭代历史。
- 用户能看到 local audit trail。
- 用户能看到云调用次数与对应出境模式（"0 Ogra-managed cloud calls" 是其中一种状态，不再是默认口号）。
- Audit hash chain 可用 `previous_hash` / `event_hash` 重新验证。
- Agent Group 至少 Pipeline 跑通；Parallel / Debate 跑通，per-step policy/audit 完整。
- 至少一个 interval 调度和一个 continuous 调度能运行并产生 `scheduled_run_iterations`。
- 至少一个 built-in 技能和一个 local-recipe 技能能跑通并产生 `skill_invocations` 行。

## 8.2 Beta：个人工作空间

范围：

1. M3 记忆中心
2. 3-Agent Pipeline
3. recipes
4. 脱敏预览
5. 审计导出
6. 更完整的本地模型管理
7. LocalCommandAgentAdapter read-only 模式
8. PDF / 自动增量索引评估

成功标准：

- 用户可以把一个真实项目放进 Ogra。
- Ogra 能跨多次任务积累可编辑记忆。
- 用户可以复用一个 workflow。
- 用户能证明某次任务没有上云。

## 8.3 v1.0：可信桌面产品

范围：

1. 自构建组织，但必须用户确认。
2. A2A-compatible bridge。
3. MCP 工具安全接入。
4. 多 workspace 策略。
5. 更稳定的索引和后台任务。
6. 自动更新。
7. Codex / Claude Code / Aider / Open Interpreter 等外部 Agent adapter 评估和分级接入。

成功标准：

- Ogra 可以作为日常 AI 工作台使用。
- 用户愿意长期保留企业资料和个人知识库。
- Ogra 的审计和透明路由成为用户信任理由。

## 8.4 后置能力

后置，不进入 MVP：

- 多设备 Edge 集群
- 云同步
- 团队协作
- SSO / RBAC
- 企业审计中心
- 模板市场
- 移动端
- 完整 SaaS

---

# 9. 不做什么

为了保持产品可实现，以下内容在第一阶段明确不做：

1. 不做 LobeHub 的完整替代品。
2. 不 fork LobeHub 做深度改造。
3. 不做 SaaS 多租户。
4. 不做企业 SSO / RBAC。
5. 不做模板市场商业化。
6. 不做无限自动 Agent 自组织。
7. 不默认自动执行 shell。
8. 不承诺自动敏感数据识别完全准确。
9. 不把所有记忆静默注入所有上下文。
10. 不在没有审计记录的情况下上云。

---

# 10. 关键风险

## 10.1 范围风险

RAG、Agent Group、M3 Memory、自构建组织、端云路由、审计，每个都可以单独成为一个项目。

控制方式：

- Alpha 只做最小闭环。
- 每个模块只做 20% 高频能力。
- 高级能力通过 recipes 演示，不产品化到极致。

## 10.2 记忆风险

错误记忆会严重伤害用户信任。

控制方式：

- 记忆有来源。
- 记忆有置信度。
- 重要记忆需确认。
- 用户可删除。
- Agent 读取记忆可控。

## 10.3 安全风险

桌面产品一旦接入文件、shell、MCP，就会有高风险。

控制方式：

- 默认只读文件。
- 默认关闭 shell。
- 工具权限逐项授权。
- 高风险工具单独审计。
- 插件后置。

## 10.4 竞品风险

LobeHub 等巨型产品会持续覆盖 Agent Group、Memory、Workspace。

控制方式：

- Ogra 不拼生态规模。
- Ogra 坚持 local-first、policy-first、audit-first。
- Ogra 把透明路由和数据治理做成第一体验。

---

# 11. 对外表达

## 11.1 推荐 tagline

```text
Local-first agent workspace with transparent edge/cloud routing.
```

中文：

```text
本地优先、端云透明路由的 AI Agent 工作空间。
```

## 11.2 README 首屏

```text
Ogra Desktop helps you run AI agents over private knowledge bases
with local-first memory, policy-based edge/cloud routing, and auditable traces.

Use local models for sensitive data.
Use cloud models when quality matters.
Know exactly what happened every time.
```

## 11.3 三个核心 demo

1. **企业文档本地问答**
   - 导入合同 / PDF
   - 标记 Confidential
   - 本地 RAG + 本地模型回答
   - 显示 0 Ogra-managed cloud calls

2. **混合研究报告**
   - 本地读取内部资料
   - 本地脱敏摘要
   - 云端做复杂推理
   - 本地生成最终报告
   - 显示上传 payload hash

3. **多 Agent 项目复盘**
   - Research Agent
   - Analyst Agent
   - Reviewer Agent
   - M3 记忆写入
   - 下次任务自动引用上次决策

---

# 12. 参考来源

以下来源用于校准当前生态现实，不代表 Ogra 依赖这些项目：

1. LobeHub GitHub：LobeHub 当前定位为 Chief Agent Operator，并公开描述 Agent Builder、Agent Groups、Schedule、Project、10,000+ skills / MCP-compatible plugins 等能力。https://github.com/lobehub/lobehub
2. A2A Protocol：A2A 是面向 Agent 互操作的公开协议，Ogra 应采用兼容策略而不是另起封闭协议。https://a2a-protocol.org/latest/
3. Electron Process Model：Electron 使用 main / renderer / preload 进程模型，适合桌面 UI 与本地系统能力隔离。https://www.electronjs.org/docs/latest/tutorial/process-model
4. Tauri Process Model：Tauri 使用 Rust core process 与 WebView 进程模型，可作为后续轻量化方案。https://v2.tauri.app/concept/process-model/

---

# 13. 最终原则

后续所有实现、PRD、README、架构文档必须遵守以下原则：

1. **桌面优先，不做纯 Web 优先。**
2. **本地优先，不默认上云。**
3. **策略先行，不靠用户临场判断。**
4. **路由透明，不做黑盒调度。**
5. **审计完整，不做不可追溯的 Agent run。**
6. **记忆白盒，不做不可编辑的长期记忆。**
7. **自构建组织必须用户确认。**
8. **Ogra Edge 是核心运行时，不是附属 demo。**
9. **不追 LobeHub 的大而全，专注安全可信地使用企业和个人数据。**
10. **先完成可信闭环，再扩展生态。**

---

文档结束。
