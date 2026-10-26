# Orca 监督驾驶舱集成指南

状态：参考实现指南 ｜ 适用契约：`docs/api-contract-v0.md`（v0 冻结形状） ｜ 维护：随契约演进

## 1. 定位

[Orca](https://github.com/stablyai/orca)（stablyai，MIT）是一个 AI 代理舰队编排器：并行 worktree、移动端伴侣 App、SSH 远程运行时。RoleWeave 是数字员工的组织面（文件树即组织架构）。二者对接后：

```text
┌─────────────────────────────── 本机 ───────────────────────────────┐
│                                                                    │
│  Orca 桌面端（监督驾驶舱）                                          │
│   └─ 监督插件 ──Bearer token──▶ RoleWeave 控制面（127.0.0.1）       │
│                                  ├─ GET /org/tree    组织树快照     │
│                                  ├─ GET /reports     预算与证据      │
│                                  ├─ GET /events      SSE 事件流      │
│                                  └─ GET /positions/:id  岗位卡片     │
│                                         │                          │
│                                         ▼ spawn                     │
│                                  digital-employee 引擎子进程         │
│                                  （Qoder / Claude Code / Codex …）   │
└────────────────────────────────────────────────────────────────────┘
```

- RoleWeave 控制面**只绑定 `127.0.0.1`**，Orca 插件与控制面在同一台机器上运行，天然满足网络边界（§4 安全基线第 2 条）。
- Orca 侧负责展示、通知与多工作区聚合；RoleWeave 侧保持最小暴露面，不为监督需求新增任何写路径。
- 参考客户端：`examples/orca-supervisor-client.mjs`（零依赖，可直接运行验证连通性）。

## 2. 凭据与配对流程

控制面唯一凭据是 **boot-token**：每次启动生成的 32 字节随机 hex，仅经父子进程 stdout 管道交付（`apps/server/src/index.ts` 的 ready 协议行）：

```text
org-workbench-server ready {"port":N,"api":"v0","token":"<64 hex>"}
```

安全纪律（§4 基线，集成时必须遵守）：

1. boot-token 是 **operator 凭据**，只允许落在本机进程内存；
2. 不写文件、不进日志、不进 argv、不发送到任何远端；
3. Electron 桌面壳持有 token；插件**永远不读文件、不猜端口**，token 经操作员显式批准的受信任通道转发：

```text
插件请求配对
   → Electron 主进程弹出确认对话框（显示插件身份与请求的只读范围）
   → 操作员点「批准」
   → 主进程经受信任 IPC 把 {port, token} 交给该插件一次
```

> 正在进行的改进：[#635](https://github.com/bytefolk/roleweave/issues/635) 提议把"直接转发 operator boot-token"升级为**一次性监督者配对 token**（只读、内存态、可吊销）。该面落地后，插件应改用 `POST /supervisor/pair` 流程，本节的直接转发仅作为过渡姿势。

## 3. 快照轮询

监督面板启动时先拉全量快照，再靠 SSE 增量更新。

### 组织树（§2.4 `GET /org/tree`）

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/org/tree
```

```json
{
  "schemaVersion": "org-tree.v1",
  "business": "oss-maintainer-demo",
  "owner": "repo-owner",
  "positionCount": 4,
  "depth": 2,
  "tree": [
    { "id": "repo-owner", "reportTo": null, "budget": {...}, "children": [...] }
  ]
}
```

未打开工作区时返回 422 `workspace_not_open`——插件应把该状态渲染为「等待打开工作区」，而不是报错。

### 工作区信息（§2.2 `GET /workspace`）

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/workspace
```

`{"open":true,"path":"...","business":"...","owner":"...","version":{"seq":3,...}}`——`version.seq` 与 SSE 事件 `seq` 同源，可用于检测快照过期。

### 预算与证据（§2.9 `GET /reports`）

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/reports
```

`budgets[]` 给出每岗位 `declared` / `recorded` / `state`（`within` 或超限），`evidence[]` 给出最近回合的 `status`、`engine`、`usage` 与 `envelopeDigest`。注意：该端点只返回标识与计数，**不含对话正文**，适合直接展示。

### 岗位卡片（§2.8 `GET /positions/:id`）

返回岗位的 `mode`（`read_only` / `approval_required`）、`permissions`、`contextSources` 等。监督面板展示岗位详情时使用。

## 4. SSE 事件流（§2.10 `GET /events`）

```bash
curl -N -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/events
```

帧格式：

```text
id: 4
event: org.updated
data: {"seq":4,"type":"org.updated","at":"...","payload":{...}}
```

### 事件词汇（v0 冻结 + 加法，与 `packages/shared/src/api.ts` 的 `sseEventTypes` 一致）

| 事件 | 监督面板用途 |
|---|---|
| `org.updated` | 刷新组织树快照 |
| `turn.started` / `turn.progress` | 岗位运行状态灯 |
| `turn.usage` | token 消耗累计 |
| `turn.completed` / `turn.failed` / `turn.indeterminate` | **移动端通知候选**（终态三兄弟） |
| `turn.approval.requested` | **移动端通知候选**（等待操作员裁决） |
| `escalation.created` / `evidence.created` | 上报中心角标 |
| `hire.progress` | 招聘进行中 |
| `group.turn.spawned` / `group.updated` | 群协作状态 |

### 断线补拉与心跳

- 客户端记录最近收到的 `seq`，重连时携带 `Last-Event-ID: <seq>` 请求头，服务端从环形缓冲（≥256 条）回放其后的事件；
- 每 15 秒一帧 `: ping` 注释——客户端 45 秒未收到任何字节应视为断流并重连；
- 新连接（无 `Last-Event-ID`）不回放历史，历史事实以 `GET /reports` 等快照端点收敛。

## 5. 边界声明

- **凭据不落盘**：插件进程退出即丢弃 token；重启控制面后旧 token 全部失效（boot-token 每次启动重新生成），插件必须实现"token 失效 → 重新请求配对"的引导流程。
- **移动端扩展**：把通知转发到手机需要一条配对中继通道（参考 Orca 自身的 mobile pairing relay 架构）。v0 控制面不提供出站推送（网络面保持仅 loopback），中继属于监督端（Orca 侧）的能力，本指南不展开。
- **mem 记忆面**：给 Orca 内直接托管的 CLI 代理接持久记忆，使用 [bytefolk/mem](https://github.com/bytefolk/mem) 的 MCP 适配器（在其 GitHub Releases 的 `mcp-client` 渠道发布；RoleWeave 侧可用 `GET /services/release?kind=mem` 查询当前版本）。该路径与 RoleWeave 员工的 mem 绑定（`permissions.json`）互不相干。
- **契约一致性**：本文所有请求/响应示例逐字段镜像 `docs/api-contract-v0.md` 冻结形状；若二者冲突，以契约为准并提 issue。

## 6. Orca 插件打包提示

Orca 的插件机制与本地进程模型以 Orca 官方文档（onorca.dev/docs）为准；本节只约定与 RoleWeave 相关的部分：

1. 插件以本机子进程/宿主进程运行，对 `127.0.0.1` 的调用属于 loopback 流量；
2. 插件清单中声明所需权限时，只需要"本机 loopback HTTP 客户端"能力，不需要文件系统与 shell；
3. 建议把配对确认做成 Orca 侧的一次性卡片（显示 RoleWeave 工作区名 + 控制面版本头 `X-OrgWorkbench-API`），避免静默取 token。

## 7. 快速验证

```bash
# 终端 1：独立模式启动控制面（ready 行含 port 与 token）
npm run dev:server

# 终端 2：参考客户端
node examples/orca-supervisor-client.mjs --port <N> --token <ready行中的token>
```

客户端会打印组织树，随后实时打印回合终态摘要（不含任务正文），`Ctrl-C` 退出。
