# Ontology Runtime R2（#328）

状态：设计冻结提案 + 合同切片。不是产品验收，不是 CI 绿就等于业务成功。

本文件回填 [issue #328](https://github.com/bytefolk/roleweave/issues/328) 的 R2 增量（Ontology Runtime seam）。实现只覆盖契约、不变量测试和 github-ops 示例载荷。不建设图数据库、不把 Sales Workbench 写进开源核心词汇。

## 1. 进展台账（对照 AC）

| ID | 要求 | 本切片 | 证据 |
| --- | --- | --- | --- |
| AC-001 | 冻结 glossary / 边界 / 试点 / 负责人 | 提案已写入下文；**产品负责人尚未在 Issue 上点名拍板** | 本文 §2–§3；Issue 评论 |
| AC-002 | 只读分析 + 可写行动的示例载荷 | 已发布 | `examples/github-ops/semantic/*.v1.json` |
| AC-003 | 权限/审批、幂等、目标版本、indeterminate | 纯函数测试 | `apps/server/test/semantic-runtime.test.ts` |
| AC-004 | 技术 proof 端到端可跟随 | **未跑通 live GitHub 执行**。只提供合同轨迹示例 | 示例 JSON 把 object→evidence→decision→proposal→receipt 串起来 |
| AC-005 | 与 #327 / #143 / handoff 对账 | 下文 §3 | 明确 reuse / extend / 不改 |
| AC-006 | 试点度量 | 定义了指标，**没有实测数字** | §6 |
| AC-007 | 数据/安全边界 | 写入合同字段约束 | §7 |
| R2-1 | OntologyRuntime / DerivedState / Lifecycle / BusinessAction | 已定义 | §2 |
| R2-2 | 只读 semantic-runtime proof | 合同级；无新存储 | 只读示例 |
| R2-3 | 低风险 write proof | 合同级；未接 `gh pr merge` | 可写示例 |
| R2-4 | 跨仓边界 | 已写 | §3 |

## 2. Glossary（提案冻结）

| 名称 | 定义 | 不负责 |
| --- | --- | --- |
| Position | 组织树上的岗位；权限/预算/模式的组织主语 | 不是一次任务，不是 Agent |
| Goal | 用户目标脊骨（已有 Goals 模块） | 不是 Ontology 对象目录 |
| TurnRecord | 一次宿主回合的持久记录，含终态与 digest | 不承载业务对象生命周期 |
| Approval | 引擎/工作台审批事件；执行前的人闸 | 不替代执行时权限重检 |
| Artifact | 可引用结果（digest + locator） | 不是原始数据湖 |
| Handoff | 不可变交接包 | 不转移凭据或目录 |
| BusinessObjectRef | 业务对象/关系/指标/事件的有界引用：来源、范围、时间、版本/digest | 不内嵌原始 payload |
| EvidenceRef | 支撑断言的出处发生 | 不复制私聊或密钥 |
| DecisionRecord | 员工有界结论，带不确定度与证据 ID | 不是隐藏思维链 |
| ActionProposal | 拟执行动作：目标、前置、权限、审批、幂等键、过期、目标版本 | 不是已经发生的执行 |
| ExecutionReceipt | 实际跑了什么、对谁、权限是否重检、精确回读 | 客户端猜测不能写成 succeeded |
| OntologyRuntime | 把绑定后的对象变成可查询/可派生/可提案行动的运行时缝 | 不是本体编辑器 |
| DerivedState | 由证据和规则算出的状态，必须可复算 | 不是缓存的随便标签 |
| Lifecycle | 对象允许的状态迁移；终态不可复活 | 不与 TurnRecord 状态混用 |
| BusinessAction | 类型化行动入口（Agent 调用它，而不是每次直接 SQL/API） | 不绕过审批/幂等 |

## 3. 跨仓边界（reuse / extend / 不改）

| 平面 | 拥有 | 本切片 |
| --- | --- | --- |
| digital-employee | 可移植 turn/approval/employee-package 契约 | **不改**；可写 proof 最终应 pin 其 revision |
| RoleWeave | 工作台呈现、编排、回执导航、本仓合同切片 | **扩展**：`semantic-runtime.v1alpha1` |
| context | 原始 occurrence / recall | **不改**；EvidenceRef.locator 指向它 |
| mem | 持久记忆 | **不改**；不在合同里塞原始客户数据 |
| #327 memory plane | 有界上下文、归档、多员工召回 | **reuse** 召回窗口；本层不替代记忆平面 |
| #143 follow-up context | 受信完成回合窗口 | **reuse**；语义对象不把 failed/running 当证据 |
| workflow-handoff-v1 | Task / Workflow / Artifact / Handoff | **reuse** Artifact/Handoff；ActionProposal 挂在 Task 上，不重写模板 |

技术 proof（推荐，未 live 验收）：在已关闭的 [#302](https://github.com/bytefolk/roleweave/issues/302) `examples/github-ops` 上叠加提案/审批/幂等/回读。业务候选 Sales Workbench **仍未承诺**。

## 4. 示例

- 只读：`examples/github-ops/semantic/read-only-analysis.v1.json`
- 可写：`examples/github-ops/semantic/write-pr-merge.v1.json`（squash merge 提案；真正 `gh pr merge` 不在本 PR）

## 5. 安全不变量（已测纯函数）

1. `state !== approved` 或缺少 `approvalId`（当 `approvalRequired`）→ 不可执行。
2. `expiresAt` 无法解析为有限时间值 → `proposal_expiry_invalid`，不得执行；已过期 → `proposal_expired`。
3. 重试必须同一 `id` + `idempotencyKey` + `target.id` + `target.version`，目标版本变化不得复用重试身份。
4. 观察到的目标版本 ≠ `target.version` → stale，作废提案。
5. 状态迁移与 #346 对齐：`proposed` 只能进入 `approved/cancelled`，`approved` 只能进入 `running/cancelled`；不能在运行前直接进入 `failed`。
6. `indeterminate → succeeded` 非法；`succeeded` 且 `readback.ok !== true` 且无 exception → 非法。

## 6. 试点度量（尚无实测）

执行成功率、回读完整率、重复动作率、indeterminate 率、审批时延、操作员纠正率。未跑 live 前全部记 `NOT MEASURED`。

## 7. 数据/安全

- 范围：当前 Workspace + Position；执行时重检有效权限。
- 合同禁止：凭据、私聊原文、原始客户字段。
- 保留：提案 `expiresAt`；回执随审计时间线。
- 已知缺口（#302 README）：`policy.network/filesystem/mode` 今天只记录不执行；GitHub 能力边界在 PAT，不在本层。本切片不假装已经修好。
