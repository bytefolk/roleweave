# org-workbench 控制面 API 契约 v0（冻结）

状态：**v0 冻结**（D0，2026-08-23）｜ 维护：客户端开发负责人 ｜ 仲裁：产品 P9 提请、技术侧执行
契约单一来源声明：组织语义以 digital-employee #157 R3（DEC-DE-157-002）为准；执行语义以引擎 #165 为准。本契约与上游冲突时，以 digital-employee 契约为准，客户端跟随。

## 0. 冻结规则

1. v0 冻结后，新增端点走 v0 增量：只增不改，不改既有端点语义、不改既有错误码含义、不改既有响应字段含义。
2. 破坏性变更升 v1，并双轨过渡（v0/v1 并行至少一个里程碑）。
3. `/org/apply` 的变更清单形状与引擎错误码以 #157 契约为准，契约变更时客户端跟随，不自造语义。
4. 本文件与实现逐端点一致，由 `apps/server/test/contract.test.ts` 持续核对。
5. D3 `/turns` 为 v0 加法修订，代码切片已按 org-workbench #5 与 digital-employee #158 的边界实现；其外部 Issue 决策评论在发布前仍须完成登记，不以本地实现替代产品批准。

## 1. 通用约定

- 绑定面：仅 `127.0.0.1`。v1 不暴露 LAN；远程访问不在 v0 范围。
- 鉴权：`Authorization: Bearer <boot-token>`。token 为每次启动生成的 32 字节随机十六进制串；仅 `/health` 免 token（供壳探活）。
- 内容类型：请求/响应均为 UTF-8 JSON；请求体上限 1 MiB。
- 版本头：所有响应携带 `X-OrgWorkbench-API: v0`。
- 事件：走 SSE（`/events`），事件体带版本戳（seq），断线重连按版本戳补拉。
- 错误体（全端点统一）：

```json
{ "code": "<stable-code>", "message": "human-readable", "retryable": false }
```

- 状态码政策：400 形状级拒绝（请求体/清单形状不合法）；401 鉴权；404 路由/岗位缺失；405 方法不允许；422 语义级拒绝（工作区不合法、未开工作区、org apply 被拒）；503 引擎不可用/能力缺失；500 内部错误。
- 凭据边界：模型密钥等凭据只经 env 注入引擎子进程，不进 argv、日志、renderer、IPC。

## 2. 端点定义（v0 路径冻结、后续能力只做加法）

### 2.1 `GET /health` — 存活探针（唯一免鉴权端点）

响应 200：

```json
{
  "status": "ok",
  "api": "v0",
  "server": { "version": "0.0.0", "pid": 12345 },
  "engine": {
    "command": "digital-employee",
    "available": false,
    "nextStep": "pinned digital-employee CLI not found (command: ...). Install it or set ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI..."
  },
  "hosts": {
    "qoder": { "configured": false, "ready": false, "nextStep": "设置 QODER_PERSONAL_ACCESS_TOKEN 后重启工作台" },
    "claude-code": { "configured": false, "ready": false, "nextStep": "设置 ANTHROPIC_API_KEY 后重启工作台" },
    "claude-local": { "configured": false, "ready": false, "nextStep": "安装 Claude Code 并确保 claude 在 PATH 上…" }
  },
  "workspace": { "open": false }
}
```

约束：`engine.available` 为对已配置引擎命令的 `--version` 探针结果；不可用时必须给出可执行的 `nextStep`（"失败也有路"）。普通 `digital-employee` 的 Qoder model port 保持 service-token 门禁：`configured` 仅表示 `QODER_PERSONAL_ACCESS_TOKEN` 非空。仅当引擎精确宣布 `qoder-engine <semver>` 时，Qoder Host 才使用与 turn adapter 相同的无 shell executable resolver：非空 `ORG_WORKBENCH_QODER_BIN` 优先，其次为 `DIGITAL_EMPLOYEE_QODER_COMMAND`（无效显式覆盖均 fail closed），否则查 PATH 的 `qodercli` / `qoderclicn` / `qoder` 与 macOS 已支持的精确用户安装位置；符号链接的最终目标必须是可执行普通文件。解析出的绝对路径接受有界 `--version` 探针；探针以 CLI 主进程退出为完成条件，不等待后代继承的 stdio，并在超时或异常时清理独立进程组；当前支持 1.1.x，缺失、不可执行、超时、无法解析或版本越界均 fail closed。adapter spawn 同一绝对路径并保持继承 PATH 不变；Finder 登录 PATH 恢复和打包验收由 #110 的 macOS arm64 foundation partial 承接，不是本修复的完成依赖。该探针不读取账号、登录态或凭据存储，`ready` 也只表示本地执行前置满足，不代表远端 provider 接受了账号或具备 entitlement；一次真实回合仍是唯一的运行证据。响应只含布尔值与非敏感 `nextStep`，绝不返回凭据值、绝对 Qoder 路径或原始探针输出。Claude 各 Host 的判定独立，不得成为 bundled Qoder ready 的门槛。客户端必须以 Host 状态控制选择和发送，不得以 `engine.available` 代替 Host ready。

### 2.2 `GET /workspace` — 当前工作区信息

响应 200：未打开时 `{ "open": false }`；已打开时：

```json
{
  "open": true,
  "path": "/abs/path/to/workspace",
  "business": "oss-maintainer-demo",
  "owner": "repo-owner",
  "version": { "seq": 3, "updatedAt": "2026-08-23T08:00:00.000Z" }
}
```

### 2.3 `POST /workspace/open` — 打开/切换工作区

请求：`{ "path": "/abs/dir" }`。
目录必须含合法骨架：`workspace.json`（workspace.v1alpha1）＋ `organization.v1alpha1.json`（workspace-org.v1）＋ `positions/` 目录，否则 422 `workspace_invalid`。
成功响应 200（同 2.2 已打开形状）；成功后广播一次 `org.updated`。

### 2.4 `GET /org/tree` — 组织树快照

响应 200：

```json
{
  "schemaVersion": "org-tree.v1",
  "business": "oss-maintainer-demo",
  "owner": "repo-owner",
  "updatedAt": "...",
  "positionCount": 4,
  "depth": 2,
  "tree": [
    {
      "id": "repo-owner",
      "reportTo": null,
      "budget": { "perTask": { "tokens": 40000 }, "perDay": { "iterations": 96 } },
      "children": []
    }
  ]
}
```

约束：响应镜像 digital-employee org-tree.v1 冻结形状；`updatedAt` 来自引擎应用态，控制面 seq 不进入树快照。预算单位仅令牌/迭代次数，无货币。未开工作区时 422 `workspace_not_open`。

### 2.5 `POST /org/apply` — 提交变更清单

请求：变更清单（change-manifest.v1）：

```json
{
  "schemaVersion": "change-manifest.v1",
  "changes": [
    { "op": "move", "id": "issue-researcher", "reportTo": "docs-writer" },
    { "op": "delete", "id": "community-operator" },
    { "op": "reorder", "parentId": "repo-owner", "order": ["release-engineer", "community-operator", "issue-researcher"] }
  ]
}
```

语义：清单只接受 `move` / `delete` / `reorder` 三种操作。招聘（原 `add`）已于 #33 迁移到 `POST /hire`（§2.14，hire-request.v1alpha1 契约面）；携带 `add` 的清单按未知操作 400 `manifest_invalid` 拒绝。move=改汇报线（`reportTo:null` 表示直挂 `positions/` 根）；delete=裁撤；reorder=同级兄弟顺序调整（#32 加法，`parentId:null` 表示 `positions/` 根，`order` 必须恰好等于该父级当前全部子岗位集合）。组织/预算合法性由 digital-employee（`org apply`）裁决；客户端只做请求形状和目录操作可执行性预检。

reorder 语义补充（#32）：兄弟顺序是 org-workbench 自治语义，不属于引擎组织契约。顺序持久化在控制面自有的 `.digital-employee/org-layout.v1.json` 覆盖层（原子 tmp+rename，0600），引擎与 qoder sync 永不触碰该文件。纯 reorder 清单不调用引擎、不改 `.digital-employee/org.json`；集合校验失败 → 422 `org_reorder_set_mismatch`。reorder 可与结构操作混排，结构部分仍走引擎原子应用，成功后再落覆盖层。每次成功的 reorder/move 调整保存单步 undo 条目；delete 会清空该条目（结构恢复走 2.6 裁撤恢复区）。

执行序列（目录提案＋引擎应用态）：

1. 完整预检清单（重名/缺位/环/owner/`maxDepth=8`）→ 2. 直接物化 `positions/` 提案树（move rename；delete 移入 `.digital-employee/backup/`）→ 3. spawn 钉版 `digital-employee org apply <workspace> --json` → 4. 成功：重载 `.digital-employee/org.json` 并广播 `org.updated`；失败：稳定码透传、提案树保留，不自动回滚（被拒的 delete 包保留在裁撤恢复区，走 2.6 显式恢复）。

应用态纪律：`.digital-employee/org.json`、`org-audit.jsonl`、`permissions.json` 只由引擎写。拒绝时三者字节级零变更。旧 staging 与 `apply-log.ndjson` 停写。

成功响应 200：

```json
{ "status": "applied", "version": { "seq": 4, "updatedAt": "..." }, "changesApplied": 3 }
```

失败响应 422（引擎拒绝/留档冲突）或 503（引擎不可用）：

```json
{
  "status": "failed",
  "code": "workspace_org_budget_missing",
  "message": "...",
  "retryable": false
}
```

错误码透传纪律：引擎稳定错误码（如 `workspace_org_budget_missing` / `workspace_org_budget_not_allocated` / `workspace_org_budget_invalid`）原样透传，客户端不重命名、不吞并。

### 2.6 `GET /org/backups` / `POST /org/restore` — 裁撤恢复区

`GET /org/backups` 返回树外 `.digital-employee/backup` 中、可由 `org-audit.v1` 裁撤记录追溯的岗位包：

```json
{ "schemaVersion": "org-backups.v1", "backups": [
  { "backupId": "community-operator-1756000000000-abcdef", "positionId": "community-operator", "dismissedAt": "...", "reportTo": "repo-owner", "name": "Community Operator" }
] }
```

`POST /org/restore` 仅接受 `{ "backupId": "..." }`。控制面将备份恢复到原汇报位置形成目录提案，再调用同一个 `digital-employee org apply <workspace> --json` 边界；renderer 不直接移动文件。成功响应中的 `restored:false` 表示重复请求发现该岗位已经应用，因而幂等返回。目标岗位/原上级冲突返回 409 `restore_conflict`；无效或损坏备份返回 `restore_invalid` 并 fail closed。恢复必须由用户显式触发，不自动恢复。

### 2.7 `POST /org/undo` — 单步撤销最近一次拖拽调整（#32 加法）

请求体忽略（传 `{}` 即可）。撤销最近一次成功的 reorder/move 调整：若有逆向 move，则经同一 `digital-employee org apply` 边界回放，再恢复调整前的布局覆盖层；随后消费（删除）undo 条目。add/delete 不入 undo（结构恢复走 2.6 裁撤恢复区），故被 add/delete 清空条目后本端点无可撤销内容。

成功响应 200：

```json
{ "status": "undone", "version": { "seq": 6, "updatedAt": "..." } }
```

无可撤销条目 → 404 `not_found`；引擎拒绝逆向回放 → 422（失败体同 2.5），undo 条目保留可重试。成功后广播 `org.updated`（payload.changes 为 `[{ "op": "undo" }]`）。

### 2.8 `GET /positions/:id` — 岗位卡片（只读）

响应 200：

```json
{
  "schemaVersion": "position-card.v1",
  "position": {
    "id": "repo-owner", "name": "Repo Owner", "description": "...",
    "reportTo": null, "mode": "read_only",
    "contextScope": "/",
    "contextSources": [
      {
        "id": "workspace-position-docs",
        "kind": "workspace_docs",
        "name": "岗位知识库",
        "locator": "positions/repo-owner/SKILL.md + knowledge/**",
        "binding": "bound",
        "state": "ready",
        "readOnly": true,
        "itemCount": 2
      },
      {
        "id": "mem-drive",
        "kind": "mem_drive",
        "name": "统一网盘",
        "locator": "mem://workspace",
        "binding": "available",
        "state": "not_configured",
        "readOnly": true
      },
      {
        "id": "context-provider",
        "kind": "context_provider",
        "name": "岗位运行上下文",
        "locator": "context://position/repo-owner",
        "binding": "bound",
        "state": "not_configured",
        "readOnly": true
      }
    ],
    "permissions": { "toolAllow": ["Read", "Grep", "Glob"], "toolDeny": [] },
    "capabilities": {
      "skills": [{ "id": "issue-research", "name": "Issue 调研" }],
      "mcpServers": [{ "id": "workspace-drive", "name": "工作区网盘", "tools": ["read"] }]
    },
    "budget": { "perTask": { "...": "..." }, "perDay": { "...": "..." } },
    "metadata": {}
  }
}
```

未找到 → 404 `position_missing`。

`contextSources` 是 `position-card.v1` 的加法字段。它是 Workbench 的来源摘要，
不把 mem/context 的内部存储暴露给 renderer：`workspace_docs` 指向岗位包，
`mem_drive` 表示统一网盘接入状态，`context_provider` 表示岗位级运行上下文。
`binding=available` 只代表可接入，不代表该岗位已经获得访问授权；`state` 为
`ready`、`empty`、`not_configured` 或 `error`。旧客户端可以继续使用
`contextScope`，新客户端应优先渲染 `contextSources`。

招聘请求中的 `permissions` 是 Workbench 的附加策略面，不扩展冻结的
`hire-request.v1alpha1` envelope。`permissions.skills` 只允许引用平台登记的
Skill，`permissions.mcpServers` 只允许引用平台登记的 MCP，并为每个服务携带
工具级 allowlist。绑定本身不授予文件、工作区、项目或网络访问；控制面会将
`skill://<id>` / `mcp://<id>` 的 `execute` 规则和资源的查/新建/修改/删除规则一并
写入岗位包 `permissions.json`，同时生成 `skills.json`、`mcp.json`。MCP 工具白名单
还会落到 `employee.json.policy.mcpTools`，因此运行时可以继续按最小权限收敛。

### 2.9 `GET /reports` — 上报中心数据（只读，分页）

响应 200：

```json
{
  "schemaVersion": "reports.v1",
  "streams": {
    "escalations": [],
    "audits": [ {
      "schemaVersion": "org-audit.v1",
      "at": "...",
      "actor": "digital-employee org apply",
      "bootstrapped": false,
      "changes": { "hired": [], "moved": [], "dismissed": [], "budgetUpdated": [] },
      "positionCount": 4
    } ],
    "evidence": [ {
      "schemaVersion": "turn-evidence.v1", "positionId": "repo-owner",
      "turnId": "...", "conversationId": "...", "engine": "qoder",
      "status": "completed", "createdAt": "...", "updatedAt": "...",
      "envelopeDigest": "sha256:...",
      "usage": { "inputTokens": 100, "outputTokens": 50, "totalTokens": 150 }
    } ]
  },
  "budgets": [ {
    "positionId": "repo-owner", "declared": { "perTask": { "tokens": 40000 }, "perDay": { "iterations": 96 } },
    "recorded": { "inputTokens": 100, "outputTokens": 50, "totalTokens": 150 },
    "latestTurn": { "inputTokens": 100, "outputTokens": 50, "totalTokens": 150 }, "state": "within"
  } ],
  "page": { "cursor": null, "hasMore": false }
}
```

D4 首版：`audits` 以 no-follow、有界读取引擎 `.digital-employee/org-audit.jsonl`（最新在前，最多 200 条），并逐字段投影 allowlist，源文件额外字段不进入响应；`evidence` 从已持久化 `turn-record.v1` 只摘录标识、状态、digest、稳定错误码和精确 usage，不返回 input/output/message；`escalations` 仅映射真实 failed/indeterminate 回合和当前应用态可验证的汇报链；`budgets` 比较最近回合的 token usage 与声明的 per-task token 上限，不预测未来用量。当前没有 per-day 时间桶事实，客户端单日 lane 明确显示用量不可用，不复用 per-task 比例。任何损坏审计/回合数据使整个端点以 500 `reports_data_invalid` fail closed。

### 2.10 `GET /events` — SSE 事件流

响应 200，`Content-Type: text/event-stream`。帧格式：

```
id: 4
event: org.updated
data: {"seq":4,"type":"org.updated","at":"...","payload":{...}}
```

事件词汇（v0 冻结 + D3 加法 + #25 加法 + #33 加法）：`org.updated` / `turn.started` / `turn.model.delta` / `turn.usage` / `turn.completed` / `turn.failed` / `turn.indeterminate` / `turn.approval.requested` / `turn.approval.granted` / `turn.approval.denied` / `escalation.created` / `evidence.created` / `hire.progress`（#33 加法）。D3 的前五类引擎事件以已严格校验的 `engine.v1` 原始事件作为 `payload`；`turn.approval.*` 三类逐字镜像上游 #187 加法引入的 `engine.v1` `approval.requested` / `approval.granted` / `approval.denied` 事件（#25 Slice B 加法），经控制面同一严格校验后作为 `payload` 广播，不引入新词汇形态。进程级不确定结果使用控制面 `turn.indeterminate`，不会伪造 engine 终态，也不会自动重试。`hire.progress` 是控制面自产进展提示，`payload` 只含 `positionId` 与 `phase`（`validate` / `stage` / `apply`），不含百分比与终态；缺事件时前端停留上一相位，60 秒无任何事件按本地诊断码 `hire_timeout` 失败（不进入 §3 稳定码表，同 `turn_cancelled` 惯例）。

### 2.11 `POST /turns` / `GET /turns` — D3 本地回合控制面

`POST /turns` 请求（只允许下列三个字段；#25 Slice B 加法允许可选 `pendingApproval`，见 2.11.2）：

```json
{ "positionId": "repo-owner", "input": "Summarize the open issues.", "engine": "qoder" }
```

- `engine` 只允许 `qoder` / `claude-code` / `claude-local`；不接受凭据字段，凭据只从控制面进程环境的对应变量传给子进程。
- 控制面构造 `turn-envelope.v1`，其 `envelopeDigest` 与 digital-employee canonical JSON + SHA-256 算法逐字节一致。
- 唯一调用形态：`digital-employee turn run <workspace> --position <id> --stdin`；信封从 stdin 输入，凭据和用户输入均不进 argv。
- stdout 必须是严格、同 runId、以 `run.started` 开始且恰有一个末尾终态的 `engine.v1` NDJSON；UTF-8 按流解码，模型文本边界镜像上游 1,048,576 字符；未知字段、超界行、多个终态或终态后事件均产生 `indeterminate`。
- 退出码 1 记录为 `indeterminate`，绝不自动重试；仅安全透传 `engine.*` / `workspace_org_*` 稳定 spawn 码，其余保持 `turn_process_exit_1`。用户显式重试必须创建新的 turnId/attempt。
- `turn.completed` / `turn.failed` / `turn.indeterminate` 只在最终 turn record 原子持久化成功后广播；超时后冻结事件并清理子进程，不接受迟到终态。
- 响应 200 为单个 `turn-record.v1`，包含 `turnId`、`positionId`、`engine`、`status`、`envelopeDigest`、有界事件与可信终态输出/错误。

`GET /turns?positionId=<id>` 响应 200：

```json
{
  "schemaVersion": "turn-history.v1",
  "conversationId": "uuid",
  "positionId": "repo-owner",
  "turns": []
}
```

本地状态位于 `<workspace>/.digital-employee/workbench/conversations/<positionId>/`：元数据和每回合独立 JSON 均为 0600 原子写，目录为 0700；启动后读到不属于当前进程活跃集合的遗留 `running` 回合时恢复为 `indeterminate/turn_interrupted`。岗位 ID 规则逐字镜像引擎组织契约并由 D2、turn server 与 Desktop IPC 共用同一 validator。内部路径拒绝符号链接；持久化记录的 turn ID 在路径构造前必须满足上游有界 ID 约束、本地文件名安全约束且与所在文件名一致，否则整段历史 fail closed。历史记录数、总大小、输入、输出、事件与诊断全部有界。凭据与原始 stderr 不持久化。

本切片只建立 workbench 本地会话/回合连续性与未来 recall 接缝，不声称已经接入 mem recall，也不依赖 Host 原生 resume。

Electron renderer 只通过枚举式 `createTurn({positionId,input,engine})` 与 `turnHistory(positionId)` IPC 消费这两个端点；main process 持有 boot token 并代理请求，renderer 不获得 token 或通用 HTTP/IPC 能力。服务端 `turn-record.v1` / `turn-history.v1` 是持久化单一来源，renderer 只做显式展示适配，不建立第二套会话或回合存储语义。

重连补拉：客户端带 `Last-Event-ID: <seq>` 重连，服务端从环形缓冲（≥256 条）回放该版本戳之后的事件；新连接不回放历史。心跳：每 15 秒注释帧 `: ping`。

#### 2.11.1 `POST /turns/cancel` — 中断在途回合（#25 加法修订）

```json
{ "positionId": "repo-owner" }
```

- 请求只允许 `positionId` 一个字段；该岗位没有正在运行的回合时返回 404 `not_found`（不新增错误码）。
- 命中时控制面终止引擎子进程（SIGTERM，250ms 后 SIGKILL），回合经既有路径落为 `indeterminate`，诊断码 `turn_cancelled`（与 `turn_timeout` 同类的本地诊断码，不属于 `errorCodes` 稳定码表），并复用冻结的 `turn.indeterminate` SSE 词汇广播；不新增 SSE 事件类型。
- 响应 200：`{ "cancelled": true, "positionId": "<id>" }`。
- 同一 `POST /turns` 请求语义不变：被中断的回合仍以完整 `turn-record.v1`（status `indeterminate`）作为该请求的 200 响应返回。

#### 2.11.2 `pendingApproval` — 审批裁决随回合传入（#25 Slice B 加法修订）

`POST /turns` 与 `POST /sessions/:sessionId/turns` 在既有字段之外允许一个可选字段 `pendingApproval`，逐字镜像上游 #193 加法的 `turn-envelope.v1` 可选字段（其形状即引擎 `TurnPendingApprovalInput`）：

```json
{
  "positionId": "repo-owner",
  "input": "[审批裁决] 请继续执行上一回合暂停的动作",
  "engine": "qoder",
  "pendingApproval": {
    "approvalId": "<≤256 非空，来自 approval.requested>",
    "decision": "granted",
    "decidedBy": "operator",
    "scope": "once",
    "reason": "<可选，非空，≤1024 字节>",
    "expiresAt": "<可选，ISO 8601>"
  }
}
```

- 必填：`approvalId`（非空、≤256）、`decision`（`granted`|`denied`）、`decidedBy`（常量 `"operator"`）；可选：`scope`（`once`|`run`）、`reason`（非空、≤1024 字节）、`expiresAt`（ISO 8601）。`additionalProperties: false`；字段集合按「必填 + 可选」键集校验（与 driver-cli `exactKeys` 同构），等价于上游信封首门接受的字段集，额外字段一律拒绝。
- 边界校验 fail closed：任何形状违例（缺字段、额外字段、越界、`decidedBy` 非 `"operator"`、非法枚举、非法时间戳）在 spawn 之前以 400 `turn_request_invalid` 拒绝（不新增错误码，不新增 SSE 事件类型）。
- 校验通过的 `pendingApproval` 进入 `turn-envelope.v1` 正文并参与 `envelopeDigest`（canonical JSON + SHA-256，与上游逐字节一致）；未携带时信封与摘要与既有行为逐字节不变。
- 控制面不解释裁决语义、不在途注入、不自动重试；裁决只随下一个新回合的信封传递，引擎首门校验失败（`engine.input_invalid`）按既有 spawn 前失败路径处理。
- Electron renderer 的审批卡片（批准/拒绝）即经既有 `createTurn` / session turn IPC 携带该字段发起续跑回合；IPC 层执行同一镜像校验，不新增通用通道。`input` 为自由文本，renderer 按裁决分支出不同措辞：批准用「[审批裁决] 请继续执行上一回合暂停的动作」；拒绝用「[审批裁决] 已拒绝上一回合暂停的动作」（附理由时为「[审批裁决] 已拒绝：<理由>」），避免拒绝分支的续跑回合被误读为继续执行。同一审批的裁决一旦随续跑回合创建成功发出，renderer 将该卡片置为「已裁决」终态，不接受重复或矛盾裁决。

### 2.12 `/sessions` — 显式 Workbench session（#12 R2 加法）

```text
POST /sessions                         {"positionId":"repo-owner"}
GET  /sessions?positionId=repo-owner
GET  /sessions/:sessionId
POST /sessions/:sessionId/rotate       {}
POST /sessions/:sessionId/turns        {"input":"...","engine":"qoder|claude-code|claude-local"}
GET  /sessions/:sessionId/turns
```

`POST /sessions` 返回 201 `workbench-session.v1`。`workspaceInstanceId` 和 `sessionId` 是服务端生成的 opaque UUID；`principal` 固定派生为 `position.<positionId>`，客户端不能传入或覆盖。每岗位至多一个 active session；已有 active 时必须显式 rotate。

rotate 以一个 0600 position state 原子替换同时封存 source、创建 successor 和切换 activeSessionId。并发双 rotate 至多创建一个 successor：首次 201，幂等重放 200 同一 successor。运行中回合返回 409 `session_conflict`；重启遗留 running 先按既有规则恢复为 indeterminate，再允许轮换。source 的 turns 不复制到 successor，旧 session 的 GET/history 保持可读，POST turn 被拒。

持久化位于 `<workspace>/.digital-employee/workbench/sessions/`：workspace identity、每岗位有界 session state 与每 session 独立 conversation/turn 目录均拒绝 symlink/路径穿越/错 workspace/错 position/损坏或无界记录，目录 0700、文件 0600、临时文件 fsync 后 rename 并同步目录。session API/IPC 不返回绝对路径、boot token、模型凭据、mem/context service ID 或 admin capability。

这些端点不改变 legacy `/turns` 兼容行为。Workbench session 不是浏览器登录会话、Host-native resume、mem session 或授权凭据；本切片不实现 memory write/recall、Context 蒸馏或委派。

### 2.13 Durable session turn → Context occurrence（#15 R1 加法）

只有显式 session 内、严格通过 `turn-record.v1` validator 且已完成 0600 原子替换的 `completed` 回合可以进入导出。`failed`、`indeterminate`、遗留 `running`、损坏记录和 legacy `/turns` 均不导出。输入与可信 `run.completed.output` 分别生成 user/assistant 两条 `context-occurrence.v1`；不读取或解析 Qoder/Claude Code 私有 transcript。

scope 全部由服务端 session 状态派生：`workspaceId=workspaceInstanceId`、`positionId`、`principal=position.<positionId>`、`conversationId=sessionId`。`occurrenceId` 使用 Context R3 冻结 tuple `(workspaceId,positionId,principal,conversationId,turnId,role)`；content 按 provider 的 64 KiB UTF-8 边界确定性截断并记录安全 `truncated` 证据。

导出状态位于 `<workspace>/.digital-employee/workbench/context-exports/<sessionId>/<turnId>.json`，目录 0700、文件 0600、fsync + rename + parent fsync，拒绝 symlink、路径穿越、错 identity、额外字段、无界或损坏记录。状态只含 `pending|done|failed`、attempt、digest、occurrence ID/content digest/source audit reference 与截断标志，不含原始 user/assistant 文本、token、绝对 vault 路径或 adapter stderr。

Workbench 只 spawn 钉定 `context@f63f57f`（或兼容后续 main）的公共 `context adapter ingest|distill`。子进程只从 env 取得 `CONTEXT_VAULT` / `CONTEXT_RUNTIME_TOKEN`；operator token、boot-token 与 Host 凭据不在 argv、不进入 renderer/preload/IPC/turn record/evidence。相同 occurrence replay 是幂等 no-op；部分成功后重启会重放导出并跳过 provider 已 `done` 的 occurrence。adapter failure 只把本地 export state 置 `failed`；下一次 workspace-open/restart 最多重试导出，不调用 `turnDriver`，不改变已持久的 Host 终态。

`sourceLocator=context://occurrences/<occurrenceId>@1` 只是 source audit reference，不冒充 `context read` 所需的 item-unique `/artifacts/<artifactId>` locator。Workbench 不打开或共享 Context SQLite，也不做 recall/model injection/memory write。

### 2.14 `POST /hire` — 创建员工（#33 加法，hire-request.v1alpha1 契约面）

唯一创建通道：招聘不再经变更清单（§2.5 已移除 `add`）。消费 digital-employee #194/#198（merge b3d54bf）的 hire-request.v1alpha1 **静态参考信封面**；CLI 形态只有 `hire validate <file> [--json]`，无 spawn/run/审批事件，本端点不虚构任何上游不存在的调用形态。#113 起，桌面默认 bundled `qoder-engine` 也实现同一静态面：只读一个不超过 256 KiB 的普通非符号链接 JSON 文件，按冻结词表/字段约束校验；上游将 `envelopeDigest` 冻结为长度至少 16 的 opaque sealed-turn reference，adapter 不重新计算或改写其语义。该子命令不解析或启动 Qoder、不访问 provider，也不写工作区。

请求（只允许下列字段，缺一即 400 `hire_request_invalid`）：

```json
{
  "positionId": "docs-writer",
  "name": "Docs Writer",
  "description": "Keeps documentation current.",
  "reportTo": "repo-owner",
  "mode": "approval_required",
  "budget": { "perTask": { "tokens": 20000 }, "perDay": { "tokens": 200000, "iterations": 64 } },
  "deadline": "2026-08-27T00:00:00.000Z"
}
```

- `positionId` 镜像 digital-employee 岗位 ID 契约（`^[a-z0-9]+(?:-[a-z0-9]+)*$`，≤64）；`reportTo` 为岗位 ID 或 `null`（`null` 解析为企业负责人，`targetParentId=owner`）。
- `budget.perTask.tokens` / `perDay.tokens` 必填正整数且 ≤1,000,000,000；`iterations` 选填；`mode` 只允许 `read_only` / `approval_required`；`deadline` 选填 ISO 时间。
- `description` 必填、非空，去除首尾空白后 **≤1024 字符**（按 UTF-16 code unit 计，非字节）。该上限镜像上游 digital-employee `validateSkillFrontmatter` 对 SKILL.md frontmatter `description` 的约束——它比 `employee.json` 自身的 2000 字符上限更严，是真正的瓶颈。控制面在请求闸门按此拒绝，避免 staging 之后才在 `org apply` 阶段撞上 `employee_skill_description_required`（#92）。`name` 仍按 ≤128 **字节** 校验：它只进入 SKILL.md 正文，不受上游 frontmatter 约束。

`permissions.tools`、`permissions.rules`、`permissions.skills`、`permissions.mcpServers` 都是有界数组；Skill / MCP 标识必须来自平台目录，MCP `tools` 必须是该服务登记工具的子集。未知能力或未知 `skill://` / `mcp://` 资源规则在请求闸门直接拒绝。

执行序列（两道静态闸门，全部 fail-closed）：

1. 形状/冲突预检 → 重名 409 `hire_position_exists`；`reportTo` 幽灵岗位 400。
2. 控制面组装岗位骨架并封装 hire-request.v1alpha1 信封：`workspaceRef`、`packageRef{name, version:"v1alpha1", digest}`（digest 为骨架 `employee.json` 字节的 SHA-256，先于 staging 计算）、`targetParentId`、`budget`、`requestedBy:"operator"`、`deadline?`、`envelopeDigest`（canonical JSON + SHA-256，与 turn-envelope.v1 同算法）。信封词表只由控制面组装，renderer 不构造、不扩展。
3. 闸门一：`digital-employee hire validate <envelope> --json`（bundled 包中命令为同形态的 `qoder-engine`；静态校验，先于任何副作用）。引擎不可用 → 503 `engine_unavailable`（retryable=true）；构建缺 hire 面 → 503 `engine_capability_missing`；校验拒绝 → 422 原样透传稳定码。`envelopeDigest` 非字符串或长度小于 16 时稳定拒绝码为 `hire_request_invalid_field:envelopeDigest`；不做 canonical body equality 检查。
4. 闸门二：staging 骨架到 `positions/` 提案树（0600 `budget.json`），再走与 move/delete 同一接缝的 `digital-employee org apply <workspace> --json` 引擎裁决；失败 → 422 透传稳定码并回滚已 staging 的目录，不留半吊子岗位。
5. 成功：重载 `.digital-employee/org.json`、追加 org-layout 兄弟序、广播 `org.updated`（changes 含 `{op:"hire"}`），并在全程按相位广播 `hire.progress`。

成功响应 200：

```json
{ "status": "hired", "positionId": "docs-writer", "version": { "seq": 5, "updatedAt": "..." } }
```

失败响应 400/409/422/503 遵循 §1 统一错误体；上游稳定码原样透传，客户端不重命名。执行中不可取消（上游静态面无中止语义）；renderer 四态机（发起/执行/审批/结果）中审批相位为保留位——hire 通道上游无 approval 语义，永不触发，turn 内审批归 #25 Slice B。

### 2.15 `/groups` — S2 群聊面（#52 加法，DS-34-001 rev-1 §1.2）

```text
POST /groups                                  {"memberPositionIds":["repo-owner","release-engineer"]}
GET  /groups
GET  /groups/:conversationRef
POST /groups/:conversationRef/members         {"positionId":"issue-researcher"}
POST /groups/:conversationRef/turns           {"input":"...","engine":"qoder|claude-code|claude-local","mentions":["repo-owner"]}
GET  /groups/:conversationRef/turns
```

显式路由、禁广播：群回合只按 `mentions` 逐成员 spawn，每个被 @ 的成员生成一个独立的 `turn-envelope.v1`；`mentions` 为空或含非成员一律 400。

- `POST /groups` 返回 201 `conversation-group.v1`：`memberPositionIds` 恰为 2–32 个唯一合法 positionId，额外字段拒绝（400 `group_request_invalid`）。每个群同时绑定一个真实 #12 session（`sessionId` 服务端生成，锚定首个成员的岗位生命周期，AC-004 双形态召回）；`conversationRef` 是服务端生成的本地 uuid，满足 `[a-z0-9]+(?:-[a-z0-9]+)*`。**过渡债登记**：conversationRef 为工作台侧本地映射，缺口① v1alpha2 契约级回链合入后切换并清账。
- 锚 session 的取得方式为**复用优先**（#116）：首个成员岗位已有 active session 时直接以该会话为锚——不轮换、不改写、不复制其生命周期，也不追加会话；仅当该岗位无 active session 时才新建。故 `POST /groups` 不再因成员已有个人会话而回 409 `session_conflict`，多个群可共用同一锚。锚只是绑定：群回合记录仍按成员落 position conversation store（见下条），不落锚会话的 session store。显式 `POST /sessions` 的 409 语义与轮换规则不变。
- `GET /groups` 返回 `conversation-group-list.v1`（按 `updatedAt` 倒序）；`GET /groups/:conversationRef` 返回单群；不存在 404 `group_missing`，非法 ref 400 `group_request_invalid`。
- `POST /groups/:conversationRef/members` 追加成员（已存在 409 `group_conflict`，达到 32 上限 409），返回更新后的群记录。
- `POST /groups/:conversationRef/turns`：先持久化 `group-message.v1` 用户消息回显，再以 202 应答 `{"conversationRef","messageId","spawns":[{"turnId","positionId"}]}`；`turnId` 由服务端预分配，spawn 在后台顺序执行，逐成员记录经既有 position conversation store 持久化，`turn-record.v1` 只增一个可选字段 `groupRef`（不影响既有记录逐字节兼容）。
- 事件面：同一条 `/events` SSE 通道新增 `group.turn.spawned`（每个被 @ 成员一条，payload `{groupRef,messageId,turnId,positionId,engine}`）；群内成员的 `turn.*` 事件 payload 附加同一组归属字段，renderer 只按 exact message/turn/position/engine 分流和结算。终态 SSE 是刷新提示；若监听晚建或断流，renderer 会以有界轮询从群时间线的持久化事实收敛，并按持久化 `turnId` 去重。不新增独立 SSE 通道、不新增广播语义。
- `GET /groups/:conversationRef/turns` 返回 `group-timeline.v1`：用户消息（`kind:"user"`）与成员回合（`kind:"member"`，内嵌完整 `turn-record.v1`）按 `createdAt` 归并排序。
- 持久化位于 `<workspace>/.digital-employee/workbench/groups/<conversationRef>/`（`group.json` + `messages/<messageId>.json`）：目录 0700、文件 0600、原子替换，拒绝 symlink/路径穿越/损坏或无界记录；群数上限 64、单群消息上限 256、`input` ≤256 KiB。存储失败 500 `group_storage_failed`，不回显记录内容。
- 1:1 面不变：legacy `/turns` 与 session turn 的请求键集校验拒绝任何 wire 侧 `groupRef`；群回合不进入 1:1 展示面，反之亦然。

## 3. 稳定错误码登记表

控制面自产码（本契约定义）：`unauthorized`、`body_invalid`、`workspace_invalid`、`workspace_not_open`、`manifest_invalid`、`organization_invalid`、`engine_unavailable`（retryable=true）、`engine_capability_missing`、`engine_failed`、`position_missing`、`restore_invalid`、`restore_conflict`、`reports_data_invalid`、`turn_request_invalid`、`turn_engine_unsupported`、`turn_position_invalid`、`turn_storage_failed`、`session_request_invalid`、`session_missing`、`session_conflict`、`session_storage_failed`、`not_found`、`method_not_allowed`、`internal`；turn-record 内的稳定结果码包括 `turn_process_exit_1`、`turn_process_failed`、`turn_engine_unavailable`、`turn_timeout`、`turn_protocol_invalid`、`turn_driver_failure`、`turn_interrupted`；Context export state 的稳定失败码为 `context_adapter_failed`，不进入 HTTP 错误响应；提案预检码：`org_apply_position_exists`、`org_apply_position_missing`、`org_apply_cycle`、`org_apply_owner_delete`、`org_apply_max_depth`、`org_apply_destination_exists`、`org_reorder_set_mismatch`（#32 加法）；hire 通道码（#33 加法）：`hire_request_invalid`（400 形状级）、`hire_position_exists`（409 重名）；群聊通道码（#52 加法）：`group_request_invalid`（400 形状级）、`group_missing`（404）、`group_conflict`（409 重复成员/成员上限）、`group_storage_failed`（500 fail-closed）。
引擎透传码：以 digital-employee 稳定码为准（`workspace_org_*` 等），原样透传，不在本表重定义。

## 4. 安全基线（随契约冻结）

1. renderer：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；preload 白名单逐方法枚举（D0 为 6 个方法），无通用通道。
2. 网络面：仅 127.0.0.1＋每启动随机 token；严格 CSP（`default-src 'self'`），无第三方 CDN，无远程代码加载。
3. 最小权限：壳只触达工作区目录与本地回环；组织文件权限对齐 #157 纪律（0600）。
4. 凭据边界：密钥只经 env 注入引擎子进程；boot-token 只经父子进程 stdout 管道，不进文件/日志。
5. 本地回合：只持久化对话输入、严格校验后的 engine 事件与稳定结果；不持久化凭据或原始 stderr。状态路径拒绝符号链接，文件 0600、目录 0700、原子替换。
6. 本地 session：workspace/position/principal 映射由 server 拥有；sessionId 不是授权；renderer 只拿到枚举式 session 方法和公开 DTO。
7. Context 导出：runtime token/env 与 adapter command 只在 server；本地状态不含正文或凭据，重启不重跑 Host。
8. 更新与分发：v1 不做静默自动更新；macOS 公证列 D4 后。

## 5. 与上游契约的映射

| 本契约对象 | 单一来源 |
|---|---|
| `organization` / 岗位字段 / 汇报线 | digital-employee workspace-org.v1（apps/cli/workspace/templates.ts RenderedOrganization） |
| 岗位预算声明 | #157 R3（DEC-DE-157-002）＋ V1 预算设计（perTask/perDay，令牌/迭代次数） |
| 变更清单 move/delete/reorder 语义 | #157 REQ-005（目录驱动 apply）；校验闸门在引擎；`add` 已于 #33 迁出 |
| `hire-request.v1alpha1` 信封 / `POST /hire` | digital-employee #194/#198（merge b3d54bf）静态参考信封面；`hire validate` + `org apply` 双静态闸门 |
| 引擎稳定错误码 | digital-employee fail-closed 码惯例（`workspace_*`） |
| `turn.*` / `escalation.created` / `evidence.created` | 引擎 S1 回合契约（#165）＋ #157 REQ-007 升级接缝（D3/D4 点亮） |
| `workbench-session.v1` / 显式 rotate | org-workbench #12 R2；仅本地边界，下游由 digital-employee #161 消费 |
| `context-occurrence.v1` / CLI adapter | context #1 R3；provider pin `f63f57f7b4cb7071309561f0383683017ae79eb2` |
