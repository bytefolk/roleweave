# Orca 监督驾驶舱集成指南

状态：参考实现指南 ｜ 适用契约：`docs/api-contract-v0.md`（v0 冻结形状） ｜ 维护：随契约演进

> **凭据模式已升级（#635 / #639）**：本指南现以**一次性监督者配对 token** 为唯一推荐凭据，快照统一走
> `GET /supervisor/snapshot`。旧版"直接转发 operator boot-token"的做法已删除——监督端不需要、也不应该持有
> operator 全权凭据。监督凭据的 SSE 流在服务端按字段白名单投影，正文在离开控制面之前就被剥掉。

## 1. 定位

[Orca](https://github.com/stablyai/orca)（stablyai，MIT）是一个 AI 代理舰队编排器：并行 worktree、移动端伴侣 App、SSH 远程运行时。RoleWeave 是数字员工的组织面（文件树即组织架构）。二者对接后：

```text
┌────────────────────────────────── 本机 ──────────────────────────────────┐
│                                                                          │
│  Orca 桌面端（监督驾驶舱）                                                │
│   └─ 监督插件 ──supervisor token──▶ RoleWeave 控制面（127.0.0.1）          │
│                                    ├─ GET /supervisor/snapshot  只读快照  │
│                                    └─ GET /events  SSE（服务端已投影）    │
│                                           │                              │
│                                           ▼ spawn                        │
│                                    digital-employee 引擎子进程            │
│                                    （Qoder / Claude Code / Codex …）     │
└──────────────────────────────────────────────────────────────────────────┘
```

- RoleWeave 控制面**只绑定 `127.0.0.1`**，Orca 插件与控制面在同一台机器上运行，天然满足网络边界（§4 安全基线第 2 条）。
- 监督插件持的是**只读、可吊销、内存态**的配对 token，不是 operator boot-token；它解锁的只有 `GET /supervisor/snapshot` 与 `GET /events` 两个 GET 路径，其余一律 401。
- 参考客户端：`examples/orca-supervisor-client.mjs`（零依赖，可直接运行验证连通性）。

## 2. 凭据与配对流程

监督端凭据是**一次性配对 token**：32 字节随机 hex，由 operator（或 Electron 桌面壳代为）通过 `POST /supervisor/pair` 创建，仅创建时返回一次；只存 SHA-256 于控制面内存，重启即失效，可随时吊销（吊销会立即切断该配对已建立的 SSE 连接）。

```text
插件请求配对
   → Electron 主进程弹出确认对话框（显示插件身份与只读范围）
   → 操作员点「批准」，主进程调 POST /supervisor/pair（boot-token，operator 侧）
   → 主进程经受信任 IPC 或继承管道把 supervisor token 交给该插件一次
```

安全纪律（§4 基线，集成时必须遵守）：

1. **operator boot-token 永远不离开控制面与桌面壳**：插件不持有、不转发、不读取它；
2. supervisor token 只落监督端进程内存；不写文件、不进日志、**不进 argv**（命令行参数对本机其它进程可见——参考客户端会直接拒绝 `--token`）；
3. 交付通道必须是受信任 IPC 或继承管道（stdin / fd），参考客户端支持 stdin 管道与 `ROLEWEAVE_SUPERVISOR_TOKEN` 环境变量两种注入方式；
4. 控制面重启后旧 token 全部失效：插件必须实现"token 失效（401）→ 重新请求配对"的引导流程。

## 3. 快照轮询

监督面板启动时先拉全量快照，再靠 SSE 增量更新。

### 只读快照（§2.18 `GET /supervisor/snapshot`）

```bash
curl -s -H "Authorization: Bearer $SUPERVISOR_TOKEN" http://127.0.0.1:$PORT/supervisor/snapshot
```

```json
{
  "schemaVersion": "supervisor-snapshot.v1alpha1",
  "workspace": { "open": true, "path": "...", "business": "...", "owner": "...", "version": { "seq": 3, "updatedAt": "..." } },
  "orgTree": { "schemaVersion": "org-tree.v1", "business": "oss-maintainer-demo", "owner": "repo-owner", "positionCount": 4, "depth": 2, "tree": [ "…§2.4 快照原样镜像…" ] },
  "positions": [
    {
      "id": "repo-owner", "name": "Repo Owner", "mode": "read_only", "reportTo": null,
      "engineBinding": "qoder", "activeSessionId": "<uuid|null>",
      "runningTurn": { "turnId": "<uuid|null>" },
      "budget": { "declared": {...}, "recorded": {...}, "latestTurn": {...}, "state": "within" }
    }
  ]
}
```

一次读取同时覆盖组织树、岗位状态与预算口径：

- `orgTree` 逐字段镜像 §2.4 `org-tree.v1`；`budget` 复用 §2.9 预算投影语义；`runningTurn` 仅在进程内有活跃预留时非空；
- 未打开工作区时返回 200（`workspace.open=false`、`orgTree=null`、`positions=[]`）——插件应把该状态渲染为「等待打开工作区」，而不是报错；
- 不返回凭据、stderr、事件正文、任务文本、prompt。

注意：operator 专用的 `GET /workspace`、`GET /org/tree`、`GET /reports`、`GET /positions/:id` 对 supervisor token 一律 401——监督面板不要调用它们，快照字段已按监督视角聚合。

## 4. SSE 事件流（§2.10 `GET /events`，supervisor 凭据）

```bash
curl -N -H "Authorization: Bearer $SUPERVISOR_TOKEN" http://127.0.0.1:$PORT/events
```

帧格式：

```text
id: 4
event: turn.completed
data: {"seq":4,"type":"turn.completed","at":"...","payload":{...}}
```

### 服务端字段白名单投影（#639）

supervisor 凭据的 `/events` **在服务端**做 payload 投影，正文在离开控制面前就被剥掉：

- 按事件类型的字段白名单投影，且只放行标量值（string/number/boolean/null）；
- 模型输出（`turn.model.delta` 整类不下发）、任务标题与步骤消息、审批动作描述与理由、trace 详情、失败诊断**不会出现在监督流里**；
- Last-Event-ID 环形缓冲**回放与实时推送走同一投影**，重连也读不到被投影掉的字段；
- operator 凭据的 `/events` 保持 §2.10 冻结形状，不受影响。

监督面板因此只能看到"发生了什么"（哪个岗位、什么状态、什么阶段），看不到"说了什么"。

### 事件词汇（投影后保留的元数据）

| 事件 | 监督面板用途 |
|---|---|
| `org.updated` | 刷新组织树快照（workspace/version） |
| `turn.started` / `turn.progress` | 岗位运行状态灯（positionId/progress/overallStatus） |
| `turn.usage` | token 消耗累计（inputTokens/outputTokens/totalTokens） |
| `turn.completed` / `turn.failed` / `turn.indeterminate` | **移动端通知候选**（终态三兄弟，标识与状态） |
| `turn.approval.requested` / `granted` / `denied` | **通知候选**（approvalId + 到期时间，无动作描述） |
| `escalation.created` / `evidence.created` | 上报中心角标 |
| `hire.progress` | 招聘进行中（positionId/phase） |
| `group.turn.spawned` / `group.updated` | 群协作状态 |

### 断线补拉与心跳

- 客户端记录最近收到的 `seq`，重连时携带 `Last-Event-ID: <seq>` 请求头，服务端从环形缓冲（≥256 条）回放其后的事件（同样经过投影）；
- 每 15 秒一帧 `: ping` 注释——客户端 45 秒未收到任何字节应视为断流并重连；**静默超时必须用接入 fetch 的 `AbortController` 实现**（在 fetch 前创建、`signal` 传入请求），否则 abort 中止不了读取，重连不会发生（参考客户端已按此实现）；
- 新连接（无 `Last-Event-ID`）不回放历史，历史事实以 `GET /supervisor/snapshot` 收敛；
- **吊销即时生效**：operator 删除配对后，该配对已建立的 SSE 连接会被服务端立即关闭，插件应把连接被远端关闭视为"需要重新配对"的信号；
- **401 是凭据失效终态**：重连后若 SSE 请求返回 401，说明配对已被吊销或控制面已重启——旧 token 不可能凭重试恢复授权。此时必须**停止重连**、释放响应与计时器、提示重新配对并以非零码退出；网络故障与可恢复的服务端错误才走退避重连（参考客户端已按此实现）。

## 5. 边界声明

- **凭据不落盘**：插件进程退出即丢弃 token；重启控制面后旧 token 全部失效（配对是内存态），插件必须实现"token 失效 → 重新请求配对"的引导流程。
- **最小权限**：监督端持配对 token，不是 operator boot-token；被吊销时损失面只有两个只读 GET，操作员还可以在 `GET /supervisor/pairings` 里审计每个配对的 `lastUsedAt`。
- **移动端扩展**：把通知转发到手机需要一条配对中继通道（参考 Orca 自身的 mobile pairing relay 架构）。v0 控制面不提供出站推送（网络面保持仅 loopback），中继属于监督端（Orca 侧）的能力，本指南不展开。
- **mem 记忆面**：给 Orca 内直接托管的 CLI 代理接持久记忆，使用 [bytefolk/mem](https://github.com/bytefolk/mem) 的 MCP 适配器（在其 GitHub Releases 的 `mcp-client` 渠道发布；RoleWeave 侧可用 `GET /services/release?kind=mem` 查询当前版本）。该路径与 RoleWeave 员工的 mem 绑定（`permissions.json`）互不相干。
- **契约一致性**：本文所有请求/响应示例逐字段镜像 `docs/api-contract-v0.md` 冻结形状；若二者冲突，以契约为准并提 issue。

## 6. Orca 插件打包提示

Orca 的插件机制与本地进程模型以 Orca 官方文档（onorca.dev/docs）为准；本节只约定与 RoleWeave 相关的部分：

1. 插件以本机子进程/宿主进程运行，对 `127.0.0.1` 的调用属于 loopback 流量；
2. 插件清单中声明所需权限时，只需要"本机 loopback HTTP 客户端"能力，不需要文件系统与 shell；
3. 建议把配对确认做成 Orca 侧的一次性卡片（显示 RoleWeave 工作区名 + 控制面版本头 `X-OrgWorkbench-API`），避免静默取 token；
4. supervisor token 经受信任 IPC 或继承管道传入插件进程；若 Orca 插件模型只支持环境变量注入，使用 `ROLEWEAVE_SUPERVISOR_TOKEN`，不要拼进命令行。

## 7. 快速验证

```bash
# 终端 1：独立模式启动控制面（ready 行含 port 与 boot-token）
npm run dev:server

# 终端 2：operator 配对一个监督端（boot-token 来自 ready 行）
curl -s -X POST \
     -H "Authorization: Bearer $BOOT_TOKEN" \
     -H "content-type: application/json" \
     -d '{"label":"orca-supervisor"}' \
     http://127.0.0.1:$PORT/supervisor/pair
# 记下响应中的 token 字段（64 hex，仅返回这一次）

# 终端 3：以监督凭据运行参考客户端（token 经 stdin 管道注入，不进 argv）
printf '%s' "$SUPERVISOR_TOKEN" | node examples/orca-supervisor-client.mjs --port <N>
```

客户端会打印监督快照（工作区、组织树、运行中的岗位数），随后实时打印回合元数据摘要（服务端已投影，不含任务正文），`Ctrl-C` 退出。吊销配对可验证连接被即时切断：

```bash
curl -s -X DELETE -H "Authorization: Bearer $BOOT_TOKEN" \
     http://127.0.0.1:$PORT/supervisor/pairings/<pairing-id>
# 终端 3 的 SSE 连接应立即断开
```
