# ADR-0008: RoleWeave memory plane for bounded context, archival, and multi-agent recall

状态：提议（Gate D0，待产品负责人接受）｜ 日期：2026-09-17  
消费：[RoleWeave #327](https://github.com/bytefolk/roleweave/issues/327) R1  
产品负责人：@PeterGuy326  
技术负责人：待 Gate D0 接受后指派

## 决策

RoleWeave 拥有**用户可见的记忆策略与编排生命周期**，不拥有第二套会话库、原文 transcript 权威或 mem/context 的存储实现。

记忆平面分成四层协作，且 **存储资格与召回资格分离**：

```
append-only event / artifact log     (Workbench session + context 平面)
        │ 分段、摘要、快照
        ▼
linked context segments + heads      (digital-employee 契约；RoleWeave 编排)
        │ 范围、过期、digest、索引
        ▼
candidate durable memory set         (mem；派生记录，非原文)
        │ 排序、去重、冲突、UTF-8 byte 准入预算（模型 token 另作成本上限）
        ▼
bounded active context for next turn (digital-employee 组装；逐条准入)
```

FIFO/ring、LRU、TTL 不是同一个旋钮：

| 机制 | 作用对象 | 作用 | 不做什么 |
| --- | --- | --- | --- |
| FIFO / ring window | 原始活跃上下文（短窗，#143） | 软预算到达时轮转最旧的未固定 turn 摘录 | 不删除源日志，不决定 durable memory 生死 |
| LRU | 进程内召回结果、embedding、物化 segment | 热缓存，降低重复检索 | 不作为正确性来源，进程重启可丢 |
| TTL / `expiresAt` | durable memory 的**召回资格** | 过期记录默认不注入 | 不物理销毁源日志；pin / 合规保留除外 |
| Pin | 用户或策略确认的决策 | 越过 FIFO/TTL 默认驱逐 | 不扩大权限，不把摘要升格为权威 |
| Supersession | 被更新决策替换的旧记录 | 默认不注入，保留溯源 | 不改写旧 segment |
| Explicit forget | mem 权限生命周期 | 授权后的遗忘 | RoleWeave 不得静默删除 durable 数据 |

链式记忆采用 **不可变 segment + head 指针 + 索引**，而不是单靠链表遍历：

- 每次压缩产生新 segment（`parentSegmentId` + `chainRootId`），禁止原地改写。
- snapshot/head 用于快速恢复；index 用于按任务/实体检索。
- 多 Agent 使用 **branch head**；合并必须留下 merge record。任一 Agent 不得静默覆盖另一 Agent 的 checkpoint。

注入的每条记忆都是 **untrusted data**：不能授予工具、权限、身份或指令。过期、撤销、畸形、digest 不匹配、越权范围的记录不得注入。阅读一条记忆默认不续期 TTL。

## 所有权边界

| 平面 | 拥有 | 不拥有 |
| --- | --- | --- |
| RoleWeave | 何时召回、准入多少、何时压缩/归档、用户可检查/固定/禁用/遗忘的控件、用量与降级展示、策略选择 | 第二套会话库；直接读写 mem/context 数据库；把 UI 计数写成权威 |
| digital-employee | 可移植契约：segment、checkpoint、组装 manifest、compaction/recall receipt、逐条准入与硬预算 | Workbench UI；mem HTTP 实现；context vault |
| mem | durable 存储、provenance、grant、lifecycle、forget、精确 readback | transcript 仓库；Host resume handle；自动把摘要当权威 |
| context | 源 occurrence、受限 recall、ingest/distill 适配器 | Memory 写入；Host 私有 transcript 解析 |
| Workbench/session | 本地会话、TurnRecord、短窗 #143、任务历史 | 长期记忆；跨会话默认注入全文 |

本 ADR **不**关闭 #143。短窗是可信 follow-up；本平面是长期记忆、归档与压缩。二者互补。

## 与现有缝的关系

- `digital-employee` 的 `MemoryPort` / `task-state.v1` / `memory-recall.v1` 继续是 durable 写入与召回缝；RoleWeave 不把对话史拷进 mem。
- ADR-0006 的 context CLI 导出边界不变：只导出摘要与引用，不回写 Host turn。
- `docs/design/workflow-handoff-v1.md` 的 Handoff/Artifact 继续运载可验证结论；记忆平面提供可引用的 checkpoint，不替代 Handoff。
- #328 的业务语义执行层消费本平面的引用与 receipt，不替代本平面。

## 后果

- R1 只接受设计产物（本 ADR、`docs/design/memory-plane-v1.md`、子 issue DAG）。**任何运行时 PR 必须 pin 已接受的 R1 修订**，不得消费未接受设计。
- 组装必须从「槽位字符串截断」演进为「逐条准入」；硬预算不可突破。
- 成功度量是 **净成本/时延收益且任务质量不降**。准入硬预算以 UTF-8 bytes 为准（与 context receipt 一致）；模型 token 是并行成本上限，二者不互相换算冒充。禁止把毛 prompt 缩短当成成功。
- 子 issue 按仓库拆分，见 `docs/design/memory-plane-v1.md` §Child-issue DAG。GitHub 子 issue 在产品负责人接受 R1 后再开。

## 非目标

- 每次 turn 注入全文对话。
- 无 provenance 的模型摘要当作权威。
- 把 chain-of-thought、凭据、审批载荷存成 memory。
- 在契约与负载测量之前选定向量库或 Redis 部署。
- 替换 context 的 occurrence 模型或 Workbench session store。
