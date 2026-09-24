# Negotiation channel v1 — 多员工共享协商通道（设计冻结）

状态：**R1 设计冻结**，对应 [#452](https://github.com/bytefolk/roleweave/issues/452)。  
主干快照：[`acdc0fc`](https://github.com/bytefolk/roleweave/commit/acdc0fc417b60cd4c7abb272e2fff3b3327f94d0)。  
本文**不改变运行时**。后续 runtime PR 必须 pin 本修订，不得在未接受冻结前写通道存储或唤醒。

本文件冻结 #452 的开放问题，并划出与 [#327 记忆平面](https://github.com/bytefolk/roleweave/issues/327) / [memory-plane-v1](./memory-plane-v1.md) 的边界。

## 0. 冻结决议（必须遵守）

| 议题 | 冻结选择 | 不采用 |
| --- | --- | --- |
| 投递范围 | **作者 + 显式 `@` mention + 显式订阅**；**operator 全量可见** | 对所有参与员工广播每一条 |
| `@` 唤醒 | mention **唤醒**该员工在**同一通道**续写 | 一次 fan-out 后结束 |
| 多轮上限 | 每个 collaboration **最多 12 次 mention-wake**；达上限后必须 human 消息才能再唤醒 | 无上限 `@` 循环 |
| Human 插话 | **排队到当前 turn 的 trusted terminal** 之后再对后续 wake 可见 | 打断 in-flight 模型回合 |
| 存储 | **append-only** 消息；禁止改写已落盘 body | 原地 edit / silent delete |
| 模型输入 | **全量持久化，按需投影**；每次 spawn 有界子集 | 把整段日志塞进每次 spawn |
| 与 #327 | **禁止 silent dual-write**；晋升记忆必须显式 checkpoint | 通道即记忆 |
| 失败可见 | `failed` / `blocked` / `cancelled` **必须作为通道消息可见** | 用“没有最终 artifact”暗示失败 |

## 1. 问题与非目标

### 1.1 要解决的

同一 assignment 上多名员工目前只有各自 terminal 和最终 artifact。员工不能 `@` 同事提问；operator 变成交换机。需要：

1. 同一 collaboration 上的共享、可写通道；
2. mention 能唤醒多轮协商；
3. operator 实时看见同一条 transcript，并能以 `role: human` 插入。

### 1.2 明确不是

| 已有能力 | 为什么不是本通道 |
| --- | --- |
| #214 并发个人 turn + operator 排序的 **relay 已完成结果** | 调度，不是现场协商 |
| #333 goal → branch → agent → evidence | 结果地图，不是争论 transcript |
| #327 / memory-plane-v1 | 耐久、带权限的召回；不是 live log |
| Groups `#mentions` fan-out（#431 overlay 只预填） | 一次派遣，不是同一通道多轮 |
| #491 / #492 Jev/Laya overlay | 发送前/裁撤建议，不替代通道 |

不在 R1 设计冻结内：跨 workspace 通道、实时 CRDT 编辑、把通道当 mem 适配器、自动执行 `decision`。

## 2. 投递范围（冻结）

一条消息的 **employee 投递集** = 

```
{ 作者 positionId } ∪ mentions[] ∪ explicitSubscribers[]
```

- 未订阅、未被 `@`、不是作者的参与员工 **收不到** 该条（UI 默认过滤；存储仍 append 全量）。
- **Operator（工作区负责人会话）始终可见全量**，不受投递集过滤。这是“像群聊一样看见谁说了什么”的人机面，不是对员工的广播。
- 显式订阅：员工或 operator 对 `channelId` 登记 `subscribe`；退订是一条 append-only 的 `system` 消息，不删除历史。
- 默认：被 `@` 一次即进入该 channel 的 subscriber 集，直到显式退订或 collaboration 关闭。

禁止把“参加过该 assignment”理解成广播。

## 3. `@` 唤醒与多轮上限（冻结）

- 消息 `mentions` 含某 `positionId` 时，控制面在 **trusted terminal 之后** 为该员工排队 **一次** follow-up turn，input 为 **有界投影**（§6），不是整段 log。
- 同一员工连续被 `@`：合并到该员工已排队的下一次 wake，不并行堆叠（与 `RunningTurnRegistry` 互斥一致）。
- **Cap：** 每个 collaboration（`channelId`）累计 **12** 次 mention-wake。计数只含因 mention 触发的 wake，不含 operator 手动 dispatch、不含 human 插话本身。
- 达到 12：再 `@` 只落盘消息并标记 `status: blocked` + 可见原因 `wake_cap_reached`，**不再唤醒**，直到出现一条 `role: human` 消息（重置 **该 channel 的剩余 wake 预算为 4**，仍不得超过生涯 12+4=16 的硬顶，见下）。
- **硬顶 16** mention-wake / channel：human 重置不能无限续命。之后必须新开 collaboration 或 operator 手动单人 turn。
- 禁止通道实现调用 `cancelTurn` 来“给 `@` 腾位置”。

## 4. Human 插话与 trusted terminal（冻结）

Open question 3 冻结为：**排队，不打断 in-flight。**

Trusted terminal = 该员工当前 turn 进入 `completed` | `failed` | `blocked` | `cancelled` | `indeterminate` 之一（现有 turn 终态，不新造）。

- Human 消息立即 **append** 到通道（operator 立刻看见）。
- 对 **正在 running** 的员工：本条 human 消息 **不** 成为其当前模型输入，**不** abort。
- 该员工下一次 wake（mention-wake 或人工 dispatch）的有界投影 **必须包含** 排队中、且 `createdAt` 早于 wake 的 human 消息。
- 若无 in-flight turn：human 消息对后续 wake 立即可见，仍不自动开新 turn，除非消息同时 `@` 了某人。

## 5. Append-only schema（冻结）

通道对象：`negotiation-channel.v1`。消息对象：`negotiation-message.v1`。只追加，禁止 update body。

### 5.1 Channel

```json
{
  "schemaVersion": "negotiation-channel.v1",
  "channelId": "nch_01",
  "workspaceId": "ws_1",
  "collaborationRef": "group:uuid-or-run:id",
  "participantIds": ["planner", "executor", "reviewer"],
  "subscriberIds": ["planner", "executor"],
  "mentionWakeCount": 0,
  "mentionWakeHardCap": 16,
  "createdAt": "2026-09-24T16:00:00.000Z",
  "closedAt": null
}
```

`collaborationRef` 绑定已有 group conversation 或明确的 multi-agent run，**不**新造第三套 org 树。R1 优先挂在 **group conversationRef**（#214 已有房间），避免与个人 turn transcript 混文件。

### 5.2 Message（append-only）

```json
{
  "schemaVersion": "negotiation-message.v1",
  "channelId": "nch_01",
  "messageId": "nm_07",
  "prevMessageId": "nm_06",
  "role": "agent",
  "positionId": "executor",
  "intent": "blocked",
  "mentions": ["planner"],
  "refs": [{ "kind": "turn", "id": "t33" }],
  "status": "posted",
  "body": { "text": "HNSW and lexical share a migration number.", "byteLength": 48 },
  "errorCode": null,
  "createdAt": "2026-09-24T16:05:00.000Z"
}
```

| 字段 | 允许值 | 约束 |
| --- | --- | --- |
| `role` | `agent` \| `human` \| `system` | human 仅 operator；system 仅控制面 |
| `intent` | `propose` \| `question` \| `answer` \| `challenge` \| `decision` \| `blocked` \| `report` \| `cancelled` \| `failed` | 失败态必须用 intent 或 status，见 §7 |
| `status` | `posted` \| `blocked` \| `cancelled` \| `failed` | 一旦写入不可改；纠错发新消息 `refs` 指向旧 id |
| `body.text` | UTF-8 | 单条 ≤ 8 KiB；超限拒绝，不截断静默 |
| `mentions` | positionId[] | 上限 8；必须是本 channel `participantIds` |
| `prevMessageId` | id 或 null | 哈希链；fork 禁止 |

落盘路径建议（runtime 时再实现）：`.roleweave/negotiations/<channelId>/messages/<messageId>.json`，只创建不覆盖。

## 6. Bounded model input（冻结）

持久化 = 通道内全部消息。  
**每次 wake 的模型输入**是投影，不是 dump。

投影算法（R1 必须文档化并测试，本 PR 只冻结规则）：

1. 固定预算：**≤ 8 KiB** 或 **最近 20 条**（先到为止）。
2. **必须包含：** 全部 `role: human` 且尚未被该员工 wake 消费的消息；全部 `intent` ∈ {`decision`,`blocked`,`cancelled`,`failed`} 的消息（不受 20 条窗口裁掉；若仍超 8 KiB，从最旧的 `propose/question/answer` 开始丢，**永不丢 human / 失败态**）。
3. **默认不包含：** 其他员工未被投递给自己的消息正文（投递范围，§2）。Operator UI 不受此限。
4. **禁止包含：** 工具 raw output、secret、完整 memory 正文、#327 segment 全文。
5. 投影带 `sourceDigest`（所含 messageId 排序后的 sha256），写入该次 turn envelope，便于审计。

“Persist everything, feed on demand” 以此为准。

## 7. 失败 / blocked / cancelled 可见（冻结）

不允许用“最终 artifact 缺失”表达失败。

| 事件 | 通道上必须出现 |
| --- | --- |
| 员工自称做不下去 | `intent: blocked` + `status: posted`，可 `@` 决策者 |
| 控制面拒绝 wake（cap、权限） | `role: system`，`intent: blocked`，`errorCode` 稳定（如 `wake_cap_reached`） |
| 员工 turn `failed` | `role: system`，`intent: failed`，`refs.turnId` |
| operator 或策略取消 | `intent: cancelled`，`status: posted` |
| collaboration 关闭 | channel `closedAt` 设置；再写拒绝 |

这些消息走与普通 propose 相同的 append 与 operator 可见性。

## 8. 与 #327 记忆平面（冻结：无 silent dual-write）

| | 协商通道 (#452) | 记忆平面 (#327) |
| --- | --- | --- |
| 问题 | 这一次 assignment 里谁说了什么 | 跨 session / 压缩 / handoff 后召回什么 |
| 寿命 | collaboration 关闭后归档；默认不进下一无关 turn | `active → archived → expired\|superseded\|forgotten` |
| 权限 | 通道参与者 + operator | grant / scope / digest（memory-plane-v1） |
| 写入 | 本通道 append | mem/context 适配器，需授权 |

**禁止：** 落盘 `negotiation-message.v1` 时自动 `durable-memory.v1` 或 context-segment。  
**允许的后续（单独 issue）：** operator 或显式 `intent: decision` **checkpoint** 动作，经 UI 确认后 **复制摘要** 到 #327。复制必须有 receipt，失败可见，不得在通道写入路径里“顺手”调用 mem。

Checkpoints 可以是通道的只读切片，仍然不是 memory plane。

## 9. 依赖与后续 runtime slices

### 9.1 依赖（设计已假定存在，本 PR 不改）

- Group conversationRef 与 `#214` 并发 turn / relay（通道挂在 group 上，不替代 relay）。
- Turn 终态与 `RunningTurnRegistry`（#463 overlay 不实现通道）。
- Trusted terminal 语义与现有 executeTurn finally。
- #327 设计稿（memory-plane-v1）保持独立。

### 9.2 Runtime 切片（后续独立 issue/PR，禁止本设计 PR 掺代码）

| Slice | 内容 | 依赖 |
| --- | --- | --- |
| **S1 persist** | channel + append-only 文件、API 只读 list/append（无 wake） | 本冻结 |
| **S2 operator UI** | 群聊式 transcript、按 employee/intent 过滤、human 插入排队 | S1 |
| **S3 mention-wake** | `@` 排队、12/16 cap、与 running mutex | S1、turn 终态 |
| **S4 projection** | §6 有界投影接入 spawn envelope | S3 |
| **S5 checkpoint（可选）** | 显式晋升 #327，带 receipt | S1、#327 实现 |

S1 之前不得做模型唤醒。S5 不得并进 S1。

## 10. 验收对照（设计层）

相对 #452 AC，本冻结给出可实施口径：

- 共享 append-only 通道：§5，挂 group collaborationRef。
- mention 多轮同一通道：§3，cap 12/硬顶 16。
- operator 实时 transcript + 过滤：S2；全量可见 §2。
- human 插入同一 stream：§4 排队到 trusted terminal。
- 全量持久 + 有界模型输入：§6。
- 与 #327 边界、无 silent dual-write：§8。
- failed/blocked/cancelled 可见：§7。

## 11. 非目标再声明

- 不实现 runtime、IPC、UI、schema 校验器（那些属 S1+）。
- 不关闭 #452、#327、#214、#422。
- 不把 Groups 的一次 fan-out 改成默认广播。
- 不在本文件授权任何自动 `decision` 执行。
