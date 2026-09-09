# Workflow / Handoff v1 设计稿

状态：设计稿，仅用于拆分下一阶段 Issue；本次不改现有实现、API、README 或文件。

目标：在 D0-D4 的组织治理和本地执行之上，补齐“工作可继续、结果可引用、方法可复用”的最小闭环。

## 1. 现状与边界

### 1.1 D0-D4 已有能力

- D0：Electron 壳 + 本地控制面，`127.0.0.1`、Bearer boot token、枚举式 IPC。
- D1/D2：`workspace.json`、`organization.v1alpha1.json`、`positions/` 组织树；岗位移动、招聘、预算、裁撤恢复和审计均经过控制面与 `digital-employee`。
- D3：`Session`、`TurnRecord`、Qoder/Claude 本地回合、SSE 流、审批、不确定终态和历史回读。
- D4：只读上报、回合证据、资产基础层、岗位文档、外部文档/网盘代理、上下文导出接缝。

当前缺口不是再增加岗位表单，而是缺少四个一等对象：

1. 一次具体工作的 `Task`；
2. 可复用的工作方法 `Workflow`；
3. 可继续加工的结果 `Artifact`；
4. 将工作安全交给下一个角色的 `Handoff`。

### 1.2 本设计明确不做什么

本阶段不扩张到：

- 移动端独立执行；
- 完整的多人实时协作、远程文件系统和跨设备实时编辑；
- 员工/Workflow 市场、租用、Credit 计费、分成和商业结算；
- 一次性重写现有 `hire-request.v1alpha1`、`turn-envelope.v1`、`turn-record.v1` 或组织树契约；
- 让 Agent 自动获得整个 Workspace、项目目录、网络或凭据；
- 把隐藏思考过程作为交接材料。交接只传可验证的结论、证据和下一步。

市场化仍是后续方向，但商品应优先是可复用的 Workflow Template，而不是孤立的“员工”。

## 2. 借鉴结论

参考 [TabTin 产品概念](https://raw.githubusercontent.com/tabtin-ai/TabTin/main/docs/architecture/product-concepts.md)、[TabTin README](https://raw.githubusercontent.com/tabtin-ai/TabTin/main/README.md) 和 [OpenAgents Workspace / Launcher 说明](https://openagents.org/docs/en/getting-started/workspace-vs-launcher)：

- OpenAgents 将 Workspace 定义为工作发生的地方，将 Launcher 定义为本机 Agent 的安装、配置、运行和连接层；两者是两个边界，不应混成一个“员工页面”。
- TabTin 将 Agent 与 Workspace、Device 分开，并将交接定义为“冻结必要上下文 + 受权引用 + 接收方创建独立续接任务”，而不是共享发送方整个本地目录。
- 两者共同强调：工作结果、任务续接、权限和执行记录应成为产品对象，聊天只是交互入口。

因此 org-workbench 的演进原则是：

> 组织负责“谁可以做什么”，Workflow 负责“按什么方法做”，Task 负责“这一次做什么”，Artifact 负责“留下什么结果”，Handoff 负责“如何安全继续”。

## 3. 核心对象边界

| 对象 | 定义 | 拥有者 | 不负责什么 |
| --- | --- | --- | --- |
| `Agent` | 一个可被选择的 AI 执行身份/Host 实例，例如本机 Qoder 或 Claude；包含运行入口、模型配置引用、健康状态和能力声明 | Launcher/本地控制面，P2 再扩展为 Daemon | 不拥有组织权限，不代表岗位，不自动拥有文件或凭据 |
| `Workspace` | 一个执行现场和资源边界；有唯一工作根，包含项目文件、岗位包和 Workbench 状态 | 当前工作区控制面 | 不等于 Agent，不是跨成员共享整个本地目录 |
| `Position` | 组织树中的岗位；包含汇报关系、职责、预算、模式、资源权限、Memory/Capability 绑定 | 组织控制面 + `digital-employee` | 不等于一次任务，不等于可售卖商品 |
| `Memory` | 可引用的上下文来源，如岗位文档、Workspace 文档、网盘、运行上下文；保存来源引用、版本和范围 | 对应文档/网盘/Context 平面 | 不授予访问权限，不复制整个来源，不代替 Artifact |
| `Capability` | 可安装、可版本化、可授权的 `skill` / `mcp` / `cli` / `app`；带 manifest、输入输出和所需权限 | 平台能力目录 | 绑定能力不等于授予资源权限 |
| `Workflow` | 可复用的工作方法模板：输入、步骤、角色/Agent 选择、Memory/Capability 引用、权限/预算上限、输出和交接规则 | 平台/组织 | 不保存一次运行的实时状态 |
| `Task` | 某个 Workflow 或交接包的一次执行实例；拥有输入、尝试、状态、用量、Artifact 和 Handoff 引用 | 控制面 | 不改变 Workflow 模板，不绕过 Position 策略 |
| `Artifact` | 可持久化、可引用、带来源和 digest 的结果，如决策、报告、文档、代码变更引用 | 控制面/工作应用 | 不只是最后一条聊天消息，不默认复制大文件 |
| `Handoff` | 不可变的交接包；描述来源 Task 的目标、结论、证据、风险、下一步和可共享引用 | 来源 Task 产生，目标方接受 | 不转移本地目录、凭据、剩余权限或剩余预算 |

关系：

```text
Organization
├── Workspace
│   ├── Position ──绑定── Agent / Memory / Capability
│   ├── Workflow Template
│   └── Task ──产生── Artifact
│                  └──创建── Handoff ──接受── Target Task
└── Policy / Budget
```

关键拆分：

- `Agent` 是“谁执行”，`Position` 是“组织上谁负责”；一次 Task 可以由岗位选择一个可用 Agent 执行。
- `Memory` 是“可参考什么”，`Capability` 是“可调用什么”；二者都不替代权限校验。
- `Workflow` 是方法模板，`Task` 是运行实例；模板更新不得回写已经运行的 Task。
- `Artifact` 是业务结果，`Handoff` 是结果和上下文的安全传递，不是文件搬运。

## 4. 完整例子：Issue 调研 Workflow

### 4.1 模板定义

模板 ID：`issue-research.v1`。

输入：

```json
{
  "issueRef": "repo://bytefolk-oss-cn/issues/123",
  "question": "判断问题根因、影响范围和是否值得修复",
  "repoRef": "workspace://current"
}
```

默认角色：`issue-researcher`；默认执行 Agent 由用户在本地已配置的 Agent 列表中选择，不能由模板偷偷切换。

最小能力与 Memory：

- Skill：`issue-research`；
- MCP：`issue-tracker.search/read`、`repository.search/read`，仅取平台已登记且岗位已授权的工具；
- Memory：`positions/issue-researcher/SKILL.md`、`positions/issue-researcher/knowledge/**`、当前 Workspace 的仓库文档；
- 资源：项目只读，岗位包和绑定文档只读；若要写文档或执行命令，必须有独立权限和审批。

### 4.2 一次运行

1. **创建 Task**：用户在岗位对话中选择 `issue-research.v1`，确认 Issue、问题和 Agent；控制面生成 `taskId`，计算有效预算/权限。
2. **采集事实**：调研 Agent 读取 Issue、PR、CHANGELOG 和相关本地文件，记录每条事实的 `DocRef`、MCP 记录引用或文件 digest；不因为“调研”自动开放网络。
3. **形成结论**：按固定输出结构生成“结论 / 事实 / 推断 / 未知 / 风险 / 建议”，隐藏思考过程不进入记录。
4. **生成 Artifact**：创建一个 `decision` Artifact；内容可以落到已有文档或资产平面，Artifact 只保存稳定定位、digest、来源和结构化摘要，不重复复制整个仓库。
5. **校验**：检查必填结论、证据引用可解析、引用范围仍有权访问、输出大小有界；校验不通过时 Task 不能标记完成。
6. **交接给 Repo Owner**：生成 `Handoff`，目标岗位为 `repo-owner`。包内带结论、证据引用、风险、建议动作和 Artifact 引用，不带本地目录和凭据。
7. **接收并继续**：Repo Owner 查看包并显式接受，选择自己的 Agent 和 Session 创建独立 Target Task；它可以接受建议、要求补充证据、创建修复任务或拒绝交接。
8. **闭环**：Repo Owner 的决定形成新的 Artifact，并在审计中关联源 Task、源 Handoff 和目标 Task。若需要发布，再交给后续 `release-notes` Workflow。

### 4.3 失败路径

- Issue 不存在或引用无权限：`blocked`，不启动 Agent。
- Agent 需要写文件、网络或未授权 MCP：`waiting_approval`；拒绝则本次 Task `failed`，不自动放宽权限。
- 进程退出但没有可信终态：`indeterminate`；不自动重试，用户显式创建新 Attempt。
- 证据引用失效：Artifact `proposed`，Task 不得进入 `completed`。
- Handoff 未接受：来源 Task 仍保持完成；不把“已交接”冒充“已被接手”。

## 5. 状态机、权限和预算

### 5.1 最小状态机

`Task` 只保留能驱动业务动作的状态：

```text
draft → queued → running → completed
                    ├── waiting_approval → running
                    ├── blocked
                    ├── failed
                    ├── indeterminate
                    └── cancelled
```

- 终态不可原地改回运行；重试创建新的 `attemptId`，保留原记录和原因。
- `waiting_approval` 只能由明确的批准裁决回到 `running`。
- `Handoff`：`created → accepted | rejected | expired`；接受只创建新的 Target Task，不改变源 Task 历史。
- `Artifact`：`proposed → published | rejected`；新版本用新 Artifact 关联 `supersedes`，不覆盖旧结果。

### 5.2 权限继承

采用 chmod 的“默认拒绝 + 分层继承 + 显式 deny 优先”思想，但不把 Unix 三组权限直接当作完整模型。

有效权限计算：

```text
effective = workspace ceiling
          ∩ project/path policy
          ∩ position grants
          ∩ workflow requested grants
          ∩ capability tool allowlist
          ∩ task-time approval
```

规则：

1. 无规则默认 deny；`deny` 优先于同层 `allow`。
2. 资源动作至少区分 `read / create / update / delete / execute`；范围区分 `position / workspace / project`，路径必须是受校验的相对路径或稳定引用。
3. Skill/MCP/CLI 绑定只声明可用能力，不自动获得文件、项目、网络或凭据访问；MCP 必须继续做 tool-level allowlist。
4. 子岗位、Workflow、Task 只能收窄上级权限，不能扩大；写、删、执行、网络等高风险动作可要求逐次或按 Run 审批。
5. Handoff 中的引用是“证据入口”，不是授权凭证；目标 Task 必须重新按目标岗位、Workspace 和当前资源权限求交集。
6. 禁止共享发送方整个本地目录、`file://` 任意路径、环境变量、boot token、API key、cookie、原始 stderr 和凭据存储路径。
7. 任何引用解析、路径规范化、符号链接检查、越权检查失败，整体 fail closed。

### 5.3 预算继承

预算独立于权限，token 和 iteration 分开核算。

```text
effective task budget = min(
  workspace remaining pool,
  parent/position remaining ceiling,
  position declared per-task limit,
  workflow per-task cap,
  task requested limit
)
```

- 每日上限按同样规则计算；实际用量以可信 `TurnRecord` 为准，不预测未来用量。
- 启动前检查可用额度；运行中达到任一硬上限立即结束为对应预算终态。
- 子任务不能突破父岗位或 Workspace 的剩余额度；兄弟任务消耗后，后续任务看到的是扣除后的剩余值。
- Handoff 不转移剩余预算，也不重置额度；目标 Task 重新从目标岗位预算计算。若未来需要跨岗位预算转移，必须另立审计化的预算转移对象。
- 取消、失败、不确定回合保留已记录用量；重复提交不能重复扣减或重复执行。

## 6. Handoff 包与安全边界

### 6.1 `handoff-package.v1` 最小字段

```json
{
  "schemaVersion": "handoff-package.v1",
  "handoffId": "uuid",
  "source": {
    "workspaceInstanceId": "uuid",
    "positionId": "issue-researcher",
    "sessionId": "uuid",
    "taskId": "uuid",
    "turnIds": ["turn-id"]
  },
  "target": {
    "positionId": "repo-owner"
  },
  "goal": "判断 Issue 根因、影响和建议动作",
  "conclusion": "结构化的最终结论",
  "progress": ["已完成事实采集", "已完成证据核对"],
  "nextActions": ["确认是否进入修复排期"],
  "risks": ["尚未验证线上复现"],
  "references": [
    { "kind": "doc", "ref": "owb-doc://issue-researcher/knowledge/README.md", "digest": "sha256:..." },
    { "kind": "artifact", "artifactId": "uuid", "digest": "sha256:..." }
  ],
  "budget": { "declaredTokens": 20000, "usedTokens": 3200, "usedIterations": 2 },
  "provenance": {
    "sourceEnvelopeDigests": ["sha256:..."],
    "generatedAt": "2026-09-05T00:00:00.000Z"
  },
  "packageDigest": "sha256:..."
}
```

字段原则：

- `conclusion`、`progress`、`nextActions`、`risks` 只收结构化、限长、可展示内容；不收隐藏思考链。
- `references` 只允许 `owb-doc://`、已登记的 Asset/Artifact ID 和带 digest 的稳定来源；不接受任意本地绝对路径。
- `budget` 是来源事实，不是可转移额度；目标执行必须重新计算。
- `packageDigest` 覆盖包内可共享字段，作为去重、审计和防篡改依据。

### 6.2 存储与暴露

建议新增、仅追加：

```text
<workspace>/.digital-employee/workbench/
├── tasks/<taskId>/task.json
├── artifacts/<artifactId>/manifest.json
└── handoffs/<handoffId>/package.json
```

目录 0700、记录 0600、临时文件同目录原子 rename；禁止符号链接穿透；数量、单条大小、引用数量和文本长度有界。Artifact 的正文继续落已有文档/资产平面，manifest 只保存定位和 provenance，避免第二份内容真相。

## 7. 分阶段路线与可拆 Issue

### P0：交接包 + Artifact（不引入 Workflow 市场）

目标：让现有 D3/D4 的一次完成回合能够留下可验证结果，并安全交给另一个已有岗位。

| Issue | 交付物 | 依赖 |
| --- | --- | --- |
| P0-1 | 冻结 `artifact-manifest.v1`；复用 `asset-record.v1`、`doc-ref.v1alpha1`，定义 decision/report/doc 的引用关系 | D4 assets/docs |
| P0-2 | 冻结 `handoff-package.v1`；完成限长、引用、digest、敏感字段和目标权限重算校验 | P0-1、D3 TurnRecord |
| P0-3 | `Handoff` 存储与幂等读写；创建、查看、接受/拒绝/过期；接受返回独立 Target Task/Session 引用 | P0-2、D3 Session |
| P0-4 | Issue 调研样例：从完成回合生成 decision Artifact 和交接包；不改变现有岗位执行路径 | P0-1～3 |
| P0-5 | 审计与 UI 只读展示：结论、证据、风险、下一步优先；执行过程只显示少量状态标签 | P0-3 |

建议新增的端点保持加法：`POST /handoffs`、`GET /handoffs/read?id=...`、`POST /handoffs/accept`、`GET/POST /artifacts/*`。实际冻结前先按现有 `routes` 和错误码风格补契约，不改现有端点语义。

### P1：Workflow Template

目标：把“员工能力”沉淀为可复用、可验证、可交接的工作流模板。

| Issue | 交付物 | 依赖 |
| --- | --- | --- |
| P1-1 | `workflow-template.v1`：输入/输出 schema、步骤、默认岗位、Agent 选择策略、Memory/Capability 引用、权限/预算上限 | P0 Artifact/Handoff |
| P1-2 | `task-record.v1` 与 Task 状态机、Attempt、用量、Artifact/Handoff 关联；模板和运行实例隔离 | P1-1 |
| P1-3 | 模板执行器最小闭环：输入校验 → 绑定 Position/Agent → 创建 Turn → 产出 Artifact → 可选 Handoff | P1-2、D3 |
| P1-4 | Issue 调研 Workflow 正式模板和 deterministic fixture/eval；覆盖成功、审批、无证据、不确定终态、目标拒绝 | P1-3 |
| P1-5 | 模板版本、禁用、兼容性和迁移规则；历史 Task 固定引用原版本 | P1-1～4 |

P1 不做公开市场、不做 Credit 计费；模板只在当前 Workspace/Organization 内登记和复用。

### P2：Launcher / Daemon / 远程协作

目标：把当前本机 Agent 选择扩展为可管理的执行节点，但保持控制面和执行环境分离。

| Issue | 交付物 | 依赖 |
| --- | --- | --- |
| P2-1 | Launcher：安装/配置/探测 Agent，显示版本、健康和能力 manifest；凭据只进本机加密存储 | P1 稳定 |
| P2-2 | Daemon：窗口关闭后维持本机 Agent，任务队列、崩溃恢复、日志和停止边界 | P2-1 |
| P2-3 | Workspace/Node 配对：短期 pairing code、过期、撤销、节点能力声明和任务路由 | P2-2 |
| P2-4 | 远程 Task/Handoff 协作：断线恢复、多人查看、事件顺序、资源权限再次校验 | P2-3 |
| P2-5 | 跨端与安全验收：远程不暴露本地目录，不下发凭据，节点失联可审计 | P2-4 |

P2 的顶层原则借鉴 OpenAgents：Workspace 协调任务和结果，Launcher/Daemon 承担本机运行；Workspace 不直接执行用户代码。[Launcher 说明](https://openagents.org/docs/en/launcher/what-is-launcher)

## 8. 与当前 API / 文件树的兼容策略

### 8.1 API

1. `API v0` 继续作为 D0-D4 的兼容基线；新增能力只新增 schema、路由和 SSE 事件，不修改现有字段含义。
2. `Position` 仍由 `GET /positions/:id` 返回；Workflow/Task/Handoff 通过独立对象引用 `positionId`、`agentRef`、`sessionId`、`turnId`，不把它们塞进 `position-card.v1`。
3. 现有 `/turns`、`/sessions`、`/groups` 继续作为运行和对话底层；P0 只在完成回合后生成 Artifact/Handoff，不替换 TurnRecord。
4. `AssetRecord`、`DocRef`、`ContextSourceSummary` 继续做来源事实；新对象只保存引用和 digest。旧客户端忽略新端点即可正常运行。
5. 新 SSE 事件必须是加法，并在最终记录原子落盘后广播；重复事件、迟到终态和断线补拉沿用当前序列号/幂等纪律。

### 8.2 文件树

现有真实来源保持不变：

```text
workspace.json
organization.v1alpha1.json
positions/<positionId>/
├── employee.json
├── budget.json
├── SKILL.md
├── knowledge/**
└── schemas/**
```

现有 Workbench 状态继续由对应 Store 管理：

```text
.digital-employee/workbench/
├── conversations/<positionId>/       # TurnRecord / history
├── sessions/positions/<positionId>.json
├── groups/<conversationRef>/
├── drive/assets/<assetId>/
└── context-exports/<sessionId>/
```

P0/P1 只在同一根目录增加 `tasks/`、`artifacts/`、`handoffs/`。引擎拥有的 `org.json`、`org-audit.jsonl`、`permissions.json` 仍由引擎写入；Workflow/Handoff Store 不直接改组织应用态，也不绕过 `org apply`。

## 9. 分阶段验收与证据要求

所有阶段先通过当前 `npm run check`，再通过本阶段门禁；不能用 UI 截图替代契约、权限和持久化证据。

### P0 验收

- 同一完成回合重复生成只得到一个稳定 Artifact/Handoff，digest 和来源一致。
- Handoff 可创建、读取、接受、拒绝、过期；接受后目标 Task/Session 独立，源历史不被修改。
- 引用无权限、绝对路径、符号链接、超长字段、未知 schema、凭据字段均 fail closed。
- 接收方不能通过交接包获得源岗位的 MCP、文件、网络、预算或凭据权限。
- Issue 调研示例能展示结论、证据、风险和下一步；执行状态压缩为标签，不遮挡结论。

证据要求：schema/parser 单测；存储原子写、权限位、边界大小、崩溃恢复和重复请求测试；权限/预算矩阵测试；敏感字段零外泄断言；一次真实 D3 → Artifact → Handoff → 接受 → 目标 Session 的 E2E 记录，包含请求、响应、文件快照和 digest（脱敏）。

### P1 验收

- 一个版本化 Workflow 能从输入校验运行到 Artifact，失败路径准确落状态，Attempt 不覆盖旧记录。
- Workflow 请求权限和预算只能收窄 Position/Workspace 上限；模板变更不影响历史 Task。
- Issue 调研模板在成功、审批、无证据、不确定终态、拒绝交接五类 fixture 下得到稳定结果。
- Artifact、Handoff、Task、TurnRecord 能双向追溯，报告只展示 allowlist 字段。

证据要求：模板 schema/property tests；状态机转换表测试；权限与预算继承矩阵；deterministic engine fixture；中断/重启/重复提交 E2E；至少一次从模板启动到下游岗位继续的真实本地回合证据。

### P2 验收

- Launcher 能发现、安装/配置、启动/停止和报告 Agent；Daemon 退出重启后不重复执行已完成 Task。
- 配对 code 过期、撤销、错 Workspace、节点失联均 fail closed 且可审计。
- 远程协作只传授权的 Task/Handoff/Artifact 引用，不传整个本地目录和凭据；断线后事件顺序和终态不乱。
- 至少两端、两个 Agent、一个共享 Workflow 的完整 E2E 在权限边界内完成。

证据要求：各平台 Launcher/Daemon 单测与打包 smoke；配对认证与撤销测试；网络断连/重连/重复消息测试；远程权限和凭据扫描；跨端 E2E 日志、事件序列、审计记录和脱敏截图。macOS 证据不能推导 Windows 通过，必须分别运行原生验证。

## 10. 决策门槛

进入下一阶段前，必须同时满足：

1. 当前阶段的 schema、状态机、权限和预算测试全部通过；
2. 至少一条真实 Issue 调研链路形成 Artifact 并被另一个岗位显式接收；
3. 失败、不确定、越权和重复执行都有可复现证据；
4. 未引入第二套 Workspace、Session、Turn 或 Memory 真相；
5. 发现新能力时先补对象边界和安全契约，再拆 UI，避免回到“岗位卡堆字段”的实现路径。
