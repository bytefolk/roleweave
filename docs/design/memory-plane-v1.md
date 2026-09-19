# Memory plane v1 — schemas, policy, receipts, child-issue DAG

状态：R1 设计稿，对应 [ADR-0008](../adr/0008-memory-plane.md) 与 [#327](https://github.com/bytefolk/roleweave/issues/327)。  
本文件不改变运行时行为。运行时 PR 必须 pin 已接受的修订。

Schema 版本字符串是契约名。后续 digital-employee 子 issue 将把同一形状升级为可校验的包内 schema。

## 1. Lifecycle

```
active → archived → expired | superseded
                   ↘ explicitly forgotten
```

- `active`：可被召回（通过范围、digest、权限检查之后）。
- `archived`：源日志/segment 仍在，默认不进下一 turn。
- `expired`：`expiresAt` 已过；**召回不合格**；源证据仍按保留策略存在。
- `superseded`：被更新的确认决策替换；默认不注入，可作证据引用。
- `forgotten`：走 mem 授权 forget；RoleWeave UI 只能发起，不能本地假装删除成功。

## 2. Versioned records

### 2.1 Context segment — `context-segment.v1`

```json
{
  "schemaVersion": "context-segment.v1",
  "segmentId": "seg_01",
  "parentSegmentId": "seg_00",
  "chainRootId": "chain_session_9",
  "headKind": "snapshot",
  "workspaceId": "ws_1",
  "positionId": "repo-owner",
  "sessionId": "sess_1",
  "taskId": "task_1",
  "producerAgentId": "position.repo-owner",
  "sourceEventRange": { "fromTurnId": "t10", "toTurnId": "t40" },
  "artifactRefs": [{ "uri": "owb-doc://repo-owner/knowledge/decision.md", "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
  "currentStateSummary": "PR #12 is waiting for a non-author approval.",
  "userGoal": "Land the bounded search patch.",
  "constraints": ["Do not force-push.", "Keep the hard context budget."],
  "decisions": [{ "text": "Use contains fallback, not live tsvector in unit tests.", "evidenceRefs": ["ev_1"] }],
  "unresolved": ["Confirm CI docker-build on the replacement PR."],
  "nextActions": ["Push branch and request review."],
  "activeResources": [{ "kind": "file", "locator": "src/lib/document-search.ts" }],
  "sourceDigest": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  "segmentDigest": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  "createdAt": "2026-09-17T12:00:00.000Z",
  "byteLength": 4096
}
```

压缩必须保留：当前目标、约束、已确认决策、证据、未完成工作、下一步、重要资源引用、Agent 身份、权限边界、citation 与 source digest。  
可以丢掉：寒暄、重复工具输出、过期中间猜测、已经物化的大 artifact 正文。

### 2.2 Durable memory — `durable-memory.v1`

```json
{
  "schemaVersion": "durable-memory.v1",
  "memoryId": "mem_dec_01",
  "kind": "project_decision",
  "workspaceId": "ws_1",
  "principal": "employee.hire_01",
  "memoryScope": "employee-private",
  "grantId": "grant_01",
  "grantVersion": 3,
  "revocationVersion": 0,
  "permissionDigest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "sourceRef": { "kind": "segment", "id": "seg_01" },
  "sourceDigest": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  "citations": ["turn:t33"],
  "producerAgentId": "position.repo-owner",
  "sessionId": "sess_1",
  "taskId": "task_1",
  "eventAt": "2026-09-17T11:58:00.000Z",
  "createdAt": "2026-09-17T12:00:00.000Z",
  "expiresAt": "2026-12-17T12:00:00.000Z",
  "importance": "high",
  "confidence": 0.7,
  "stateVersion": 1,
  "pinned": false,
  "lifecycle": "active",
  "trust": "untrusted",
  "authority": "none",
  "text": "Search APIs must match title OR body and return matchField."
}
```

长 transcript 留在 log/archive。mem 只接收派生的决策、偏好、事实、成功工作流、负向信号、artifact 引用。

**授权绑定（P1）：** `durable-memory.v1` 不得用自由字符串 `scope` 当授权边界。隔离键是 `workspaceId` + `principal` + `memoryScope` + `permissionDigest`，并携带 `grantId`/`grantVersion`/`revocationVersion`。principal 引用 `capability-grant.v1` / MemoryPort 的同一主体：employee-private 用不可复用的 `employee.<hire_id>`（不能用可换人的 `position.<id>` 表示私人记忆，见 #349）。`grantVersion` 或 `revocationVersion` 前进则旧记录立即 ineligible。跨 principal 默认拒绝；revoked / expired grant 的记录不得注入，也不得写进 receipt 的 `selected`。

### 2.3 Compaction receipt — `compaction-receipt.v1`

```json
{
  "schemaVersion": "compaction-receipt.v1",
  "turnId": "t41",
  "softBudgetBytes": 65536,
  "hardBudgetBytes": 262144,
  "trigger": "soft_budget_exceeded",
  "inputDigest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "outputSegmentId": "seg_01",
  "previousHeadId": "seg_00",
  "omitted": [{ "id": "turn:t12", "reason": "fifo_rotated" }],
  "preserved": ["goal", "constraints", "decisions", "nextActions"],
  "createdAt": "2026-09-17T12:00:00.000Z"
}
```

### 2.4 Recall / assembly receipt — `recall-receipt.v1`

```json
{
  "schemaVersion": "recall-receipt.v1",
  "turnId": "t42",
  "hardBudgetBytes": 262144,
  "admittedBytes": 18144,
  "selected": [
    { "id": "mem_dec_01", "reason": "task_similarity", "bytes": 420 }
  ],
  "omitted": [
    { "id": "mem_old_01", "reason": "expired" },
    { "id": "mem_other_agent", "reason": "out_of_scope" },
    { "id": "mem_low", "reason": "budget" }
  ],
  "degraded": false,
  "unavailable": false,
  "digest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "retrievedAt": "2026-09-17T12:01:00.000Z"
}
```

UI 只能展示与该 receipt 一致的计数。`unavailable` 或跳过召回时，禁止显示「记忆已启用且已使用」。

**预算单位（P1）：** 准入权威是 **UTF-8 bytes**（`hardBudgetBytes` / `admittedBytes` / `byteLength`），与现有 context receipt 一致。模型 **token** 是并行的成本上限（`tokenCostCap` / `admittedTokens`），只用于计费与 D4 净成本，不决定能否注入。两套单位都记录，禁止用估算换算互相冒充。超限：bytes 触顶则停止准入并在 receipt `omitted.reason=budget`；token 触顶则 `degraded=true` 且不得再追加高成本条目，但已准入的 bytes 仍以 receipt 为准。

示例里的 `sha256:` digest 均为 **64-hex placeholder**，不是真实内容哈希；实现/fixture 必须按完整 SHA-256 校验，不得把短示例当合法 digest。


### 2.5 Multi-agent branch / merge — `memory-branch.v1`

```json
{
  "schemaVersion": "memory-branch.v1",
  "branchId": "br_review",
  "parentHeadId": "seg_01",
  "ownerAgentId": "position.pr-gatekeeper",
  "createdAt": "2026-09-17T12:05:00.000Z"
}
```

```json
{
  "schemaVersion": "memory-merge.v1",
  "mergeId": "mg_1",
  "fromBranchIds": ["br_impl", "br_review"],
  "resultHeadId": "seg_09",
  "evidence": ["handoff:h_3"],
  "createdAt": "2026-09-17T13:00:00.000Z"
}
```

## 3. Admission order

1. 强制 workspace / position / principal / permission 范围。  
2. 去掉 expired、revoked、malformed、digest 不匹配。  
3. 混合相关度：当前任务相似、显式 key/实体、近因、importance、confidence、多样性。  
4. 按 canonical subject 去重。  
5. 冲突：显式确认 > 来源强度 > version > recency；败者标 superseded。  
6. 按优先级逐条准入直到硬预算。  
7. 超过软预算则在下一次模型调用前生成新 segment。  
8. 写出 receipt。

优先级默认（可修订）：

1. 当前用户输入与岗位说明书  
2. 当前 task checkpoint（pinned）  
3. 最新 chain head  
4. #143 短窗可信摘录  
5. 高 importance 且未过期的 project_decision  
6. 其他 durable memory  
7. context-plane 摘录  

## 4. Policy table (initial, revisable)

| 类别 | 默认召回 TTL | Pin | 超时时 | Forget |
| --- | --- | --- | --- | --- |
| ephemeral_turn_fact | 本 session / 短窗 | 否 | FIFO 轮转；不写 mem | 不适用 |
| active_task_state | 任务结束 + 7d | 可 | 归档为 checkpoint | 任务所有者 |
| project_decision | 90d | 默认可 | superseded 或 expire；源 segment 保留 | 岗位写权限 + mem forget |
| user_preference | 180d | 是 | 显式更新才替换 | 用户本人 |
| reusable_workflow | 365d | 是 | 版本替换 | 组织管理员 |
| negative_signal | 30d | 否 | expire | 岗位写权限 |
| compliance_retained | 策略表 | 是 | 不因 TTL 删除源 | 仅合规流程 |

FIFO 作用于 Layer D 短窗；LRU 作用于进程缓存；TTL 作用于 Layer C 召回资格。

## 5. Security

- 范围键：`workspaceId` + `principal` + `memoryScope` + `permissionDigest`，并校验 grant/revocation 版本。跨 principal 默认拒绝。自由字符串 path/`scope` 非法。  
- 凭据、审批 payload、隐藏 CoT 不得写入 durable memory。  
- 召回文本 `trust: untrusted`、`authority: none`。  
- RoleWeave 不持有 mem token；沿用 MemoryPort 的 env 引用。  
- 遗忘是 mem 的授权操作；失败必须在 UI 显示为失败，不得本地假删。

## 6. Metrics (Gate D4; R1 只定口径)

禁止编造基线数字。R1 接受的是测量协议，实测在 R5/D4。

同模型、等价任务，对比 cold（无记忆平面）与 warm（本平面启用）：

| 指标 | 口径 |
| --- | --- |
| 任务质量 / 成功率 | 人工或固定评分器，同一套用例 |
| 关键事实保留 | 压缩/交接后仍能回答的必保事实比例 |
| 过期记忆注入率 | receipt 中本应 omitted 却被 admitted 的条数 / 总 admitted |
| 召回精确率 | admitted 中与当前任务相关的比例 |
| 有用记忆率 | 操作者标记为有用的 admitted 比例 |
| p50/p95 时延 | 组装 + 召回，不含模型采样也可分列 |
| 准入 bytes 全账 | hardBudgetBytes 内 admittedBytes；超限 omitted |
| 净节省 | warm 全账 − cold 全账；毛 prompt 缩短单独列、不得当作成功 |
| 归档增长 | segment + memory 字节 / 天 |
| 恢复时间 | 从 head 恢复到可继续的墙钟时间 |

## 7. Child-issue DAG（先设计，接受后再建 GitHub issue）

```
#327 R1 (this ADR + this file)
        │
        ├─ DE-1  digital-employee: context-segment.v1 + 逐条准入 + hard budget
        │         依赖：本修订被接受
        ├─ DE-2  digital-employee: compaction trigger + chain head recovery
        │         依赖：DE-1
        ├─ CTX-1 context: archive reference + occurrence digest 对齐 segment.sourceEventRange
        │         依赖：本修订；不改 ADR-0006 导出边界
        ├─ MEM-1 mem: durable-memory.v1 additive 契约（expiry/supersede/pin/forget/readback）
        │         依赖：本修订；E3 活证据，夹具不得替代
        ├─ RW-1  RoleWeave: 组装改为消费 receipt；UI 用量/降级/省略原因
        │         依赖：DE-1
        ├─ RW-2  RoleWeave: pin / disable / inspect / forget 控件与权限
        │         依赖：MEM-1, RW-1
        └─ RW-3  RoleWeave: 多 Agent branch head 与 handoff 携带 checkpoint
                  依赖：DE-2, workflow-handoff-v1 不破坏
```

回滚：每个子 PR 可独立关记忆开关（`enabled: false`）回到 #143 短窗 + 无 durable 召回。不得留下「UI 显示已使用记忆但 receipt.unavailable=true」的中间态。

## 8. Gate mapping

| Gate | 本文件对应 |
| --- | --- |
| D0 | ADR-0008 + 本文；基线数字留空直至 R5 实测 |
| D1 | DE-1, DE-2, RW-1 |
| D2 | MEM-1, CTX-1 |
| D3 | RW-1, RW-2, RW-3 |
| D4 | 第 6 节指标 + 产品负责人接受 |

## 9. 非目标（再强调）

不实现向量数据库选型、不把 #143 标完成、不在未接受修订上合并运行时 PR。
