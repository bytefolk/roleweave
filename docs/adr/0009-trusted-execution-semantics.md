# ADR-0009: Business semantic contract for trusted Agent execution

状态：提议（R1→R2 设计决策，待产品负责人接受）｜ 日期：2026-09-17  
消费：[RoleWeave #328](https://github.com/bytefolk/roleweave/issues/328) R1  
依赖：[RoleWeave #327](https://github.com/bytefolk/roleweave/issues/327)、[#143](https://github.com/bytefolk/roleweave/issues/143)、`docs/design/workflow-handoff-v1.md`  
产品负责人：待维护者分诊  
技术负责人：待跨仓设计指派

## 决策

在现有可信运行时（岗位/员工、Goal、bounded turn、parallel/relay、审批、审计时间线）之上，增加一层 **可执行的业务语义契约**，而不是通用本体编辑器或 Palantir 克隆。

R2 冻结下列词汇。名字在 R2 内可微调，但合并前必须把最终名与版本记入本 ADR 修订。

| 术语 | 含义 | 不是 |
| --- | --- | --- |
| Position | 组织树上的岗位与权限边界 | 一次任务；一个 Agent Host |
| Goal | 用户/组织声明的目标 | 自动调度队列 |
| TurnRecord | Workbench 对一次模型回合的持久记录 | 业务对象；执行回执 |
| Approval | 能力门（exec/write/network/tool）的人审记录 | 业务对象变更的全部审批语义（可被 ActionProposal 引用） |
| Artifact | 可引用、带 digest 的工作结果 | 聊天最后一条消息 |
| Handoff | 不可变交接包：结论、证据、下一步、授权引用 | 本地目录/凭据/剩余权限转移 |
| BusinessObjectRef | 对对象/关系/指标/事件的有界引用：范围、时间、来源身份 | 无界数据转储 |
| EvidenceRef | 支撑断言的 occurrence/文档/查询/既有 receipt | 原始 payload 本体（payload 仍归 source/context） |
| DecisionRecord | 员工的有界结论/假说：证据、不确定度 | 已执行动作 |
| ActionProposal | 意图动作：目标、预期效果、前置、权限、审批、幂等键、过期 | 已发生的副作用 |
| ExecutionReceipt | 实际跑了什么、谁跑的、对哪个目标版本、终态与精确 readback | 客户端猜测的成功 |

执行状态机（最小）：

```
proposed → approved → running → succeeded
                 ↘         ↘ failed
                  cancelled     ↘ indeterminate
```

不变量：

1. 没有有效的 permission/approval 决策，动作不得进入 `running`。
2. 重试必须复用同一幂等身份（workspace + position + target digest + intent + key）。
3. 目标或版本变化使 proposal 失效，必须新开 proposal。
4. **没有成功 readback（或显式记录的 readback exception）不得标 `succeeded`。**
5. `indeterminate` 永远不得被客户端猜成成功。
6. parallel / relay / handoff 传递引用与 receipt，不得静默扩权或重放动作。

## 试点

- **技术证明（R2 必选）**：扩展现有 GitHub issue/PR 运营形态（#302）——在「调研 / 提交 / 把关」路径上增加 ActionProposal、审批、幂等执行与 readback。不引入新的业务域适配器。
- **业务候选（未承诺）**：Sales Workbench 商机跟进。在数据负责人、业务负责人、基线与验收路径确认前，**不得**把销售工作台写入已承诺范围。

## 所有权

| 仓库 | R2 职责 |
| --- | --- |
| digital-employee | 可移植契约与校验（后续子 issue 升级为版本化 schema） |
| RoleWeave | 工作台展示、编排、receipt 导航；不绕过 turn/permission/approval |
| context | 原始 occurrence / recall |
| mem | durable memory（#327）；本层只引用 memory/checkpoint，不把 mem 当执行总线 |

## 与既有设计的和解

| 既有 | 复用 | 扩展 | 明确不改 |
| --- | --- | --- | --- |
| #327 记忆平面 | 范围、provenance、expiry、receipt、untrusted 召回 | Decision/Action 可引用 segment/memoryId | 不把执行状态机放进 mem |
| #143 短窗 | 可信 follow-up 摘录与 byte 边界 | 语义对象不塞进短窗正文 | 不关闭 #143，不把长期记忆当短窗 |
| workflow-handoff-v1 | Task / Artifact / Handoff 对象 | Handoff 可携带 BusinessObjectRef 与 ExecutionReceipt 引用 | 不重写 hire/turn-envelope/组织树；不自动获得整个 Workspace |
| ADR-0006 context 导出 | digest 与 source ref | EvidenceRef 可指向已导出 occurrence | 不因 context 失败回滚 Host turn |
| #302 GitHub ops 示例 | 三个岗位与 `gh` 工具边界 | 作为技术证明的动作面 | 不把 `policy.*` 未执行字段假装成已执行权限 |

## 后果

- 本 ADR 是设计锚点。**记录本决策之前不得实现 #328 运行时。**
- 凭据、私聊原文、原始客户数据不得进入契约或公共仓库示例。
- 执行时重新评估权限；租户/工作区范围写在每条 ref 上。

## 非目标

通用本体编辑器、企业数仓/BI、在一个试点前建模全部企业对象、自动路由/无人值守调度、无限制 Agent 自治、绕过 digital-employee / RoleWeave 门禁。
