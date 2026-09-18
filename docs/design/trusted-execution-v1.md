# Trusted execution semantics v1

状态：R1 设计稿，对应 [ADR-0009](../adr/0009-trusted-execution-semantics.md) 与 [#328](https://github.com/bytefolk/roleweave/issues/328)。  
本文件不改变运行时。示例是虚构的 GitHub 运营对象，不含凭据与真实客户数据。

## 1. Glossary freeze (R2)

见 ADR-0009 表格。附加字段约定：

- 所有 ref 带 `workspaceId`（或等价 scope）与 `asOf` 时间。  
- digest 使用 `sha256:<hex>`。  
- 身份使用 position principal，例如 `position.pr-gatekeeper`。  
- 契约版本字段名：`schemaVersion`。

最终合并前若改名，在本文件修订历史追加一行，并更新 ADR-0009。

## 2. Execution state machine

合法迁移：

| from | to |
| --- | --- |
| proposed | approved, cancelled |
| approved | running, cancelled |
| running | succeeded, failed, cancelled, indeterminate |
| succeeded / failed / cancelled | （终态） |
| indeterminate | failed, cancelled（仅在人工裁定之后；**不可**到 succeeded，除非新的 proposal+readback） |

校验函数（实现子 issue 时必须测）：

- `canRun(proposal)` 当且仅当 permission 有效且 approval 状态为 granted 或策略声明不需要审批。  
- `idempotencyKey = sha256(workspaceId + positionId + actionKind + targetDigest + intent + explicitKey)`。  
- `invalidate(proposal)` 若 `targetDigest` 变化。  
- `markSucceeded(receipt)` 要求 `readback.status == "matched"` 或 `readback.status == "exception_recorded"`。

## 3. Example A — read-only analysis

操作者请调研岗判断「是否已有重复 issue」。

```json
{
  "schemaVersion": "semantic-trace.v1",
  "taskId": "task_dup_check",
  "positionId": "issue-researcher",
  "object": {
    "schemaVersion": "business-object-ref.v1",
    "kind": "github.issue_search",
    "workspaceId": "ws_github_ops",
    "locator": "github.com/bytefolk/roleweave?q=memory+plane",
    "asOf": "2026-09-17T10:00:00.000Z",
    "source": "github",
    "digest": "sha256:1111"
  },
  "evidence": [
    {
      "schemaVersion": "evidence-ref.v1",
      "evidenceId": "ev_search",
      "kind": "tool_result",
      "locator": "gh:search:issues",
      "timeRange": { "from": "2026-09-01T00:00:00.000Z", "to": "2026-09-17T10:00:00.000Z" },
      "digest": "sha256:2222",
      "provenance": "gh api search"
    }
  ],
  "decision": {
    "schemaVersion": "decision-record.v1",
    "decisionId": "dec_1",
    "summary": "Issue #327 already covers the memory-plane design; do not open a duplicate.",
    "confidence": 0.8,
    "uncertainty": "Title match only; body similarity not fully judged.",
    "evidenceIds": ["ev_search"],
    "permissionScope": "read"
  },
  "actionProposal": null,
  "executionReceipt": null
}
```

只读分析可以没有 ActionProposal。不得因此伪造 ExecutionReceipt。

## 4. Example B — write-capable action

把关岗拟 squash 合并 PR（#302 形状）。

```json
{
  "schemaVersion": "semantic-trace.v1",
  "taskId": "task_merge_pr12",
  "positionId": "pr-gatekeeper",
  "object": {
    "schemaVersion": "business-object-ref.v1",
    "kind": "github.pull_request",
    "workspaceId": "ws_github_ops",
    "locator": "github.com/bytefolk/roleweave/pull/12",
    "asOf": "2026-09-17T11:00:00.000Z",
    "source": "github",
    "digest": "sha256:aaaa",
    "targetVersion": "sha:deadbeef"
  },
  "evidence": [
    {
      "schemaVersion": "evidence-ref.v1",
      "evidenceId": "ev_checks",
      "kind": "github.check_suite",
      "locator": "github.com/bytefolk/roleweave/pull/12/checks",
      "digest": "sha256:bbbb",
      "provenance": "gh pr checks"
    }
  ],
  "decision": {
    "schemaVersion": "decision-record.v1",
    "decisionId": "dec_merge",
    "summary": "Non-author approval present, required checks green, no unresolved threads, not draft.",
    "confidence": 0.9,
    "evidenceIds": ["ev_checks"],
    "permissionScope": "merge"
  },
  "actionProposal": {
    "schemaVersion": "action-proposal.v1",
    "proposalId": "ap_merge_12",
    "intent": "squash_merge",
    "target": { "kind": "github.pull_request", "locator": "github.com/bytefolk/roleweave/pull/12" },
    "expectedEffect": "PR #12 closed as squash merge on sha:deadbeef.",
    "preconditions": [
      "non_author_approval",
      "required_checks_green",
      "no_unresolved_conversations",
      "not_draft",
      "head_sha_unchanged"
    ],
    "permissionScope": "contents:write",
    "approval": { "required": true, "approvalId": "cap_merge_1", "state": "granted" },
    "idempotencyKey": "sha256:idem_merge_12_deadbeef",
    "expiresAt": "2026-09-17T12:00:00.000Z",
    "state": "approved"
  },
  "executionReceipt": {
    "schemaVersion": "execution-receipt.v1",
    "receiptId": "rc_1",
    "proposalId": "ap_merge_12",
    "actor": "position.pr-gatekeeper",
    "startedAt": "2026-09-17T11:05:00.000Z",
    "finishedAt": "2026-09-17T11:05:08.000Z",
    "state": "succeeded",
    "targetVersionAtRun": "sha:deadbeef",
    "externalIds": { "mergeCommit": "sha:cafebabe" },
    "readback": {
      "status": "matched",
      "observed": { "merged": true, "headSha": "sha:deadbeef" },
      "digest": "sha256:cccc"
    },
    "originTurnId": "turn_99",
    "originTaskId": "task_merge_pr12"
  }
}
```

若执行后 `gh pr view` 无法确认 merged：receipt.state 必须是 `failed` 或 `indeterminate`，不得为 `succeeded`。

## 5. Safety tests to add in the implementation child issue

不在本 PR 落地运行时。子 issue 必须覆盖：

1. 无 approval → `canRun` 为假。  
2. 两次 merge 使用同一 `idempotencyKey` → 第二次成为 no-op 或返回原 receipt。  
3. head SHA 变化 → proposal 失效。  
4. readback 超时 → `indeterminate`，UI 不得画成成功。  
5. relay 后继者只拿到 receipt 引用，权限仍按后继者 Position 重评。

## 6. Workbench experience (RoleWeave)

时间线按 turn 展示：object → evidence → decision → proposal → approval → receipt。  
parallel/relay/handoff 复制 **引用**，不复制权限。  
记忆平面（#327）若启用，只作为 EvidenceRef/checkpoint 引用出现在 decision 上。

## 7. Data / security / retention

| 项 | R2 规则 |
| --- | --- |
| 租户范围 | workspaceId 必填；跨工作区拒绝 |
| 执行时权限 | running 前按 Position 现权限重评，不信任提案时的缓存 |
| 敏感字段 | 示例与契约禁止 token、私聊、原始客户 PII |
| 保留 | proposal/receipt 随 Task 审计保留；过期 proposal 不得执行 |
| 审计 | actor、position、target digest、终态、readback digest 可查询 |

## 8. Pilot measurement (technical proof only)

| 指标 | 口径 |
| --- | --- |
| 执行成功率 | succeeded / (succeeded+failed+cancelled+indeterminate) |
| readback 完整率 | 有 matched 或 exception_recorded 的比例 |
| 重复动作率 | 同一 idempotencyKey 产生两次副作用的次数（目标 0） |
| indeterminate 率 | indeterminate / 全部终态 |
| 审批时延 | requested → granted/denied |
| 操作者纠正率 | 人工改写或重开 proposal 的比例 |

这些是试点工程指标，不是业务结果。

## 9. Delivery slices (after this decision is recorded)

1. 接受 ADR-0009（本文件）。  
2. digital-employee 子 issue：把 schema 升级为包内契约。  
3. RoleWeave 只读绑定与 receipt 视图。  
4. 一条已审批、幂等、带精确 readback 的 GitHub 动作（#302）。  
5. 测量后再考虑业务适配器。

Sales Workbench 不在上述切片内。
