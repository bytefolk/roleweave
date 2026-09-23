# RoleWeave 关系图谱与领域本体设计草案

文档日期：2026-09-22；状态：本体设计与首版实现说明；执行结果见交付包 VALIDATION.md。
基线审计：`8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b`。
P0 契约：新工作树 `packages/shared/src/relationship-graph.ts`，`relationship-graph.v1`。
本文的“可做/计划”不等于已实现、已部署、已连接真实来源或已通过用户验收。

## 1. 产品目标与交付边界

用户应能回答：某个 Agent 是谁、用什么宿主、声明了哪些来源和能力、资源从哪里来、为何出现这条关系、下一步去哪里查证。
后续应能回答：某次任务实际读了什么、经过什么变换、产生什么结果，以及这次访问采用哪个授权决定。
本体定义对象、身份、关系、约束、证据和动作边界；画布是本体的一种交互投影。
“画出节点和连线”不能替代连接器、权限校验、实体解析或事实采集。

| 层次 | 本轮状态 | 交付口径 |
| --- | --- | --- |
| 旧组织总览 | 已有源码 | 组织汇报树与岗位包文件投影，不能解释完整来源和使用关系 |
| 统一只读图响应 | P0 已实现，待 PR 评审 | 按现有记录投影；以构建、测试、UI 和实际响应回读后确认交付 |
| G6 探索界面 | P0 已实现，待 PR 评审 | 搜索/筛选、邻域聚焦、原位详情、明确打开动作；以最终验收为准 |
| 通用来源接入、Mapping、运行血缘 | Planned | 需要新增持久化、API、连接器和事件证据 |
| 授权求值、跨来源身份、跨机身份迁移 | Planned | 不能由 P0 声明边或局部状态直接推导 |

成功标准是用户完成查证任务的路径清晰、证据真实、状态准确；stars 和动画数量不是验收结果。
性能数字在第 11 节均是待测目标，不能写进发布文案成为实测成绩。

## 2. 用户任务与业务闭环

| 用户 | 触发问题 | 图谱内任务 | 可回读结果 |
| --- | --- | --- | --- |
| 工作区 Owner | “这个 Agent 到底接了什么？” | 找岗位→看宿主→区分绑定/可用来源→查看声明证据 | 一组带出处、范围和更新时间的关系 |
| Agent 使用者 | “这个回答依据哪份材料？” | 找任务/执行→定位资源与版本→打开引用 | P0 不提供虚构使用链；后续返回真实事件/引用 |
| 数据负责人 | “来源坏了会影响谁？” | 找来源→看绑定岗位→区分配置依赖与实际调用 | 绑定影响范围；有运行证据后才列实际影响 |
| 权限负责人 | “为什么这里显示可访问？” | 看声明规则→查授权决定→看访问结果 | 声明、决定、执行结果分别解释 |
| 产品/研发 | “接一个新来源要做什么？” | 注册连接→映射主键和字段→预览→受控启用→回读 | 可审计配置版本、同步结果和覆盖范围 |

默认闭环：发现实体→理解关系→查看证据→明确动作→目标页面回读→返回原探索上下文。
单击节点或关系只做选择和解释；P0 提供“打开文档”“进入 Agent 会话”独立按钮；“查看任务”按钮为后续规格。
P0 不在图谱提供直接授予权限、编辑组织关系、触发任务执行或上传外部数据的隐式动作。
后续若增加写操作，应进入原业务服务的校验和确认流程，成功后回读权威结果更新图谱。

## 3. 当前事实、数据缺口与可复用能力

| 范围 | 已确认事实 | 可投影内容 | 不得声称 |
| --- | --- | --- | --- |
| 组织 | role.id/reportTo/package/mode 等已存在 | 岗位、汇报、包与声明 | 上下级就是协作或实际访问 |
| 宿主 | binding sidecar 与 Host catalog 已存在 | 已落盘 engine 绑定、宿主状态摘要 | 无 binding 时默认宿主就是事实 |
| 来源摘要 | 固定 workspace_docs、mem_drive、context_provider | 槽位、声明绑定/可用、配置状态 | 已有通用 Connector registry |
| mem | workspace 级代理；available；ready 仅配置存在 | 来源可用/未配置提示 | 已授予每岗位访问所有文件 |
| 文档 | 岗位文件 list/read；目录元数据可读 | 文件包含、路径、可预览能力 | 文件被 Agent 实际读过或由它创作 |
| 能力与规则 | toolAllow/toolDeny、permissions、catalog | 允许/拒绝声明与策略事实 | 当前真实调用已获授权 |
| MCP | bundled Host catalog 暂无 mcp；非空 grants 被 gate 拒绝 | 明确不支持/仅遗留声明 | MCP 已连接、可运行 |
| AgentTask | 持久化分配/请求/预算归属和状态 | 三类责任边与任务状态 | task 已自动运行；task→turn 真实关联 |
| Goal | summary 可读；既有 branch 可读 | 目标对象、已存在且可解析引用 | 常规创建 API 已支持新增 branch |
| Context export | Session/Turn→Occurrence 有落盘回执 | 后续可做导出血缘 | occurrence 被下一次 recall 实际使用 |
| Semantic runtime/workflow | shared 中有契约 | 设计复用参考 | 已有服务端工作流执行闭环 |

P0 新投影另读 workspace 的 doc 服务配置，形成 `doc_plane` 可用摘要；这不是旧 contextSources 新增通用接入能力。
`hire.memorySources` 当前写入 SKILL 文本，不构成来源注册、认证或同步成功证据。
Turn 的公开 trace 缺稳定 tool/resource ID，不能靠 title/path 字符串猜权限目标或实际访问对象。
mem 当前只取上游第一页最多 200 项；该页过滤不是全库搜索，也不是完整资源清单。
本节依据 [data-audit.md](./data-audit.md)，未检查用户工作区或外部实连状态。

## 4. 本体实体：身份、作用域、生命周期

### 4.1 身份规则

规范实体身份由 `scope + entityType + authoritativeNativeId` 构成；展示名、模型生成摘要和布局坐标不进入主键。
外部对象 scope 至少含 tenant、connection/source instance、remote workspace；nativeId 相同不代表跨连接同实体。
前端使用服务端返回的 opaque ID；不得重新用 basename、URL 展示串或姓名拼主键。
实体改名保持 ID；来源原生 ID 变化仅在有显式 alias/migration 证据时合并。
路径型资源使用规范 POSIX 相对路径，并保留工作区与岗位 namespace；默认不跨岗位合并同路径文件。
内容 digest 表示版本/内容相同，不直接证明两个业务实体相同。
凭据、带 token URL、原始工具参数、文件正文、绝对宿主路径不得进入图 ID、标签或日志。

### 4.2 实体目录

| 实体 | 定义与身份 | Scope/生命周期 | P0 映射 |
| --- | --- | --- | --- |
| Workspace | 组织与数据隔离容器；既有 durable identity 优先 | 克隆/迁移策略需显式约定 | workspace |
| Position | 岗位及持续职责身份，UI 可称 Agent | workspace + role.id；移动岗位目录不换身份 | agent |
| EmployeePackage | 岗位能力包及版本 | package identity + version/digest | facts/证据，独立节点 planned |
| HostKind | Qoder/Codex 等执行宿主类型 | platform catalog；不是员工 | host |
| HostInstance | 某设备/环境中的宿主安装和版本 | machine/runtime scope | planned；不可拿 HostKind 冒充实例 |
| AgentBinding | Position 与 Host 的配置绑定 | workspace + position；版本化声明 | bound_to 边及证据 |
| SourceSystem | 产生或管理业务数据的系统实例 | tenant + system instance | planned；当前 source 不自动等价此实体 |
| Connector | RoleWeave 对某系统的一次接入实例 | connectionId；凭据仅保存 secret reference | planned；P0 source 是受限摘要 |
| SourceBinding | 岗位对来源的绑定/发现槽位 | workspace + position + source slot | 岗位 source 与 declares_source；workspace 可用服务另做 source 摘要 |
| Resource | 文件、表、页面、知识条目等可定位对象 | connector/source scope + nativeId | resource，主要限真实可列本地资源 |
| ResourceVersion | 资源一次内容/元数据版本 | resourceId + source version/digest | facts/证据；完整版本实体 planned |
| Capability | 技能/工具/能力定义或声明目标 | catalog namespace + id/version | capability；声明不代表在线可运行 |
| Policy | 可执行/可审计的规则版本 | policyId + version + target selector | policy；P0 仅展示已有声明 |
| Grant | 对 actor、action、resource scope 的授权记录 | authority + grantId + 有效时间 | planned；不等价 allow 字符串 |
| AccessDecision | 一次针对资源/动作的允许或拒绝求值 | decisionId + actor/resource/action/context | planned；审批记录可作证据输入 |
| Goal | 用户想取得的业务结果 | workspace + goalId | goal |
| AgentTask | 一次可分配工作及队列状态 | workspace + taskId | task；与未来 WorkflowTask 区分 |
| Session/Turn | 会话容器与一次用户/系统请求 | workspace + sessionId/turnId | planned 按需探索 |
| Run | 引擎执行流的一次尝试，含 runId | turnId + runId，重试是新尝试 | planned |
| Execution | 一次具体操作及回执的领域事实 | executionId，关联 Run/actor/目标 | planned；成功/失败/未知分开 |
| Evidence | 支持实体或关系的一份可追溯记录 | evidenceId + authority + version | P0 内嵌 RelationshipEvidence |
| Mapping | 字段、主键、对象和关系映射规则版本 | mappingId + version + schema refs | planned |

Position、Host、Run 不能合并为一个“Agent”节点：同一岗位可跨多次 Run 持续存在，同一 HostKind 可服务多个岗位。
SourceSystem、Connector、Resource 不能合并：同系统可有多个凭据/范围不同的连接，一条资源可有多个观察入口。
当前无 durable workspace ID 时，P0 可使用规范路径的服务端 opaque fallback；它仅在本机且身份来源不变时稳定；后续 session 身份出现会改变 ID，当前没有自动 alias 迁移，不能承诺跨克隆/跨机稳定。
图 GET 不得为了获得身份新建 session identity 文件；后续身份迁移应是独立显式过程。

## 5. 关系目录：方向、约束、证据

关系采用单一规范方向；逆向浏览是查询/文案，不复制一条相反事实。
同类边 ID 由 `scope + relationType + from + to + qualifier` 稳定派生，不用本次读取时间造新边。

| 关系（主语→宾语） | Domain → Range | 约束/证据 | 阶段 |
| --- | --- | --- | --- |
| contains | Workspace → Position/Goal/Task | 同工作区；权威索引中存在 | P0 |
| reports_to | Position → Position | 下属→上级；最多一个当前上级；无自环/环 | P0 |
| bound_to | Position → HostKind | 仅已有绑定；0..1 当前绑定 | P0 |
| declares_source | Position → SourceBinding | 有 bound 声明；不是运行访问 | P0 |
| available_in | 来源摘要 → Workspace | mem/doc 服务可供发现/配置；不冒充岗位已绑定 | P0 |
| contains_resource | SourceBinding → Resource | 实际 list/元数据证明包含；不证明所有权 | P0 |
| declares_allow / declares_deny | Position → Capability；Policy → Resource(selector) | 保留 allow/deny 原始语义；selector 不是实际文件；不计算最终许可 | P0 |
| has_policy | Position → Policy | 关联已读取规则声明；含来源定位 | P0 |
| assigned_to | AgentTask/Goal → Position | Task 取 assigneePositionId；Goal 仅取既有 branch.positionId 并保留 branch locator | P0 |
| requested_by | AgentTask → Position | 请求者；不等于执行者 | P0 |
| budget_owner | AgentTask → Position | 预算归属声明；不证明实际扣款 | P0 |
| connects_to | Connector → SourceSystem | 指向明确远端实例；探活和配置状态分别保存 | Planned |
| exposes | Connector → Resource | 操作者经连接实际可见；不推出岗位权限 | Planned |
| targets | Policy/Grant → ResourceSelector | selector 是范围表达式，不是实际文件集合 | Planned |
| authorizes | Grant → Actor/Action/Resource scope | 多元关系经 Grant 实体表达；校验有效期/撤销 | Planned |
| has_branch / assigned_to | Goal → Branch → Position | 独立 Branch 节点及完整生命周期；P0 仅直连 Goal 与岗位 | Planned |
| executed_as | AgentTask → Run | 必须新增显式 taskId/runId 关联记录 | Planned |
| in_turn / executed_by / uses_host | Run → Turn/Position/HostInstance | durable runtime 记录；requested model 不是 actual model | Planned |
| attempts / accessed | Execution → ResourceVersion | 前者仅有尝试；后者须真实成功回执 | Planned |
| evaluated_by | Execution → AccessDecision | 同 actor/action/resource/version/context | Planned |
| derived_from | ResourceVersion → ResourceVersion | 产物→输入；映射版本和运行证据齐全 | Planned |
| exported_from | ContextOccurrence → Turn | 导出落盘记录及 ingest/distill 回执 | Planned，可复用已有证据 |
| references | Asset/Execution → Resource/Turn | 显式 locator，可解析；引用不等于读取成功 | Planned |

P0 关系 domain/range 是约定的投影规则，服务端与测试应校验；当前 shared union 本身不能保证端点类型正确。
P0 若 policy/allow 数据只有模式文本，应展示声明事实或声明目标，不能扩张成所有匹配 Resource 的“可访问”边。
每条返回边必须有存在的返回端点；缺目标记录形成 coverage 缺口，不能生成正常节点掩盖缺失。
汇报边不能标“协作”；文件在岗位包中不能标“作者”；绑定来源不能标“已使用”；审批允许不能标“执行成功”。

## 6. 来源到来源的血缘：证据先于连线

### 6.1 三个不同事实

1. Mapping 声明：“CRM.customer_id 映射为 Customer.id”；它证明规则存在，不证明同步已发生。
2. Sync/Execution 记录：“映射 v3 的 run R 读了输入版本 A，写了输出版本 B”；它证明一次处理。
3. Reconciliation/Receipt：“远端写回 ID、版本、摘要与预期一致”；它证明目标回读成功。

SourceSystem A 与 B 的汇总血缘只能由资源级可证实链聚合：A→Connector A→输入资源版本→Execution→输出资源版本→Connector B→B。
映射未运行时最多展示“计划映射”；不能展示动态数据流或成功同步数量。
若证据只能定位来源，不能定位资源，标“来源级处理记录”，不能伪造字段级血缘。
相同名称、字段相似、文件路径相似、同一 Host 使用、LLM 语义猜测均不足以建立真实血缘。
模型可以提出候选映射，但候选必须标待确认；用户确认保存规则后仍只是声明，直至有执行和回执。

### 6.2 Mapping 最低契约（Planned）

- `mappingId/version`、源/目标 Connector ID、schema version、实体类型与主键规则。
- 字段映射、类型变换、null 语义、枚举转换、时区、单位、过滤条件和删除策略。
- 主键复合方式、唯一性约束、外键解析、跨来源 alias 规则和冲突处理责任人。
- 版本生效时间、审核人、变更说明、样本验证结果；禁止规则更新覆盖既有证据版本。
- 一次运行记录 input/output resource version、mapping version、connector config version、counts 与 watermark。
- 回执记录 upstream ID/version/digest、成功/拒绝/失败/未知，并附可安全打开的定位引用。

不存在稳定输入版本或回执时，相关关系为证据不足；不得由“HTTP 200”补出数据完整性或因果结论。

## 7. 时态、版本、去重和冲突

### 7.1 事实记录

完整模型后续保留 `eventAt`（源事件时间）、`observedAt`（采集时间）、`validFrom/validTo`（有效区间）与 `ingestedAt`。
源时间未知则留空并标原因；不能把 observedAt 当成事件发生时间。
源时间存在偏差时保留原始时间/时区及标准化结果，排序不擅自重写事实。
配置被读取仍是 declared；成功采集到声明，不会把该声明变成实际操作 observed。
derived 仅用于有版本化推导规则的后续模型；记录输入 Evidence IDs 和 rule version，可重算。
P0 只允许 `declared | observed`，不能擅自扩充前端枚举为 derived 或 verified。

### 7.2 版本与一致性

实体身份与资源版本分离；快照 revision 基于稳定内容与源版本摘要，不包含 generatedAt 的机械变化。
所有异步读取捕获同一 workspace generation；若工作区切换，丢弃旧结果，不能拼接两个作用域。
来源单次失败不会证明对象被删除；只有有删除语义的事件或权威完整快照对账才能 tombstone。
保留过期/撤销事实用于审计，当前视图按有效区间过滤；撤销后缓存必须失效。
SSE seq 仅用于短期增量/失效通知，不是永久事件身份；重连或缺口回到有界快照读取。

### 7.3 去重与缺数

优先使用来源原生稳定 ID；只在同 namespace 内去重，多证据附于同一关系，不能按刷新次数累计关系数。
显式跨来源 same_as 需要主数据映射或人工确认记录，并保留可撤销 alias；不静默合并名称相同对象。
冲突优先级来自字段级 authority 策略，不是简单“最后写入覆盖”；保留双方证据与冲突状态。
缺主键、缺端点、不可读、未连接、不支持、超限截断、权限过滤和已确认空集分别表达。
`count=0` 仅表示该已授权、已读取范围确实为空；未知总数省略 count，局部页不能标全集完整。

## 8. P0 实施契约与只读投影

以 [relationship-graph.ts](../../packages/shared/src/relationship-graph.ts) 为当前字段事实；后续变更需同步文档与测试。

| 字段 | 当前 P0 定义 | 展示/实现约束 |
| --- | --- | --- |
| schemaVersion | relationship-graph.v1 | 客户端先校验版本；不把 planned 对象塞进现有 kind |
| workspaceId | 工作区 opaque ID | 非文件路径；用于缓存、选择和异步隔离 |
| generatedAt/revision | 生成时间与内容版本 | 时间用于新鲜度，revision 用于差量判断 |
| nodes.kind | workspace/agent/host/source/resource/capability/policy/goal/task | agent 对应 Position；source 对应当前摘要，不代表统一 Connector 已实现 |
| nodes.state | ready/configured/available/not_configured/unknown/error | 每种对象解释其含义，ready 不能统一翻译为已授权 |
| nodes.facts | key/value 展示事实 | 不是可执行策略表达式；不夹带秘密、正文或绝对路径 |
| evidence | source/locator/basis/observedAt | 每节点、每边一份安全证据；多证据/版本/有效期为后续扩展 |
| edges.permission | not_applicable/declaration_only/unknown | P0 没有 verified/allowed 枚举，不推导实际授权 |
| coverage | source/state/count?/reason? | complete/partial/not_connected/unsupported/error；P0 展示 state/count；reason 本地化详情为后续规格 |
| truncated/limits | 截断标记及节点/边限额 | 显示覆盖不足；不能把没返回的对象说成不存在 |

投影 pipeline：捕获作用域→只读采集→白名单归一→身份解析→验证端点/类型→安全过滤→稳定排序/截断→计算 revision→返回。
新增 GET surface 和 IPC 只承载读取；前端不得重放为 source 配置/权限修改。
优先复用纯读函数；TaskBoardStore.list 会 mkdir、SessionStore.list 可能创建身份、Goal detail 可能更新 health，不直接拿来实现无副作用 GET。
文件读取使用 stable bounded read，检查目录边界；不能再新增 lstat→readFile 竞态。
默认不访问外部 doc/mem，也不探活宿主来“装饰”首屏；外部按需探查是明确动作且应有超时/范围限制。
节点数、边数、岗位文件数采用有界配置；当前 projector 常量为 400/800 图上限、每岗位 20 文件、100 岗位，已由边界回归核对。
单个来源失败记录 coverage，保留其他可证明事实；身份、授权或整个作用域不可信时整次请求失败。
本轮不建图数据库、不创建通用事件总线或通用工作流引擎；读投影保持可替换。

## 9. 可配置来源接入 SOP（Planned，P0 仅解释现有配置）

| 步骤 | 操作者与输入 | 执行动作 | 必须回读/留证 |
| --- | --- | --- | --- |
| 1 范围定义 | 数据负责人：业务问题、系统、租户、数据范围、责任人 | 明确读/写、对象和权限边界 | scope、责任人、允许动作、验收样本 |
| 2 注册连接 | 管理员：Connector 类型、endpoint、secret reference | 校验地址/namespace；秘密进入受控凭据存储 | connectorId、配置版本；图仅显示安全摘要 |
| 3 测试连接 | 明确的测试动作 | 超时有界探活，用实际身份读最小范围 | 状态、时间、远端身份、可见范围；配置存在不算成功 |
| 4 目录发现 | 数据负责人确认的对象集合 | 分页读取元数据和 schema，记录水位 | 完整/局部/错误、页数、已读范围；不默认抓正文 |
| 5 映射定义 | 主键、类型、字段、关系、转换规则 | 保存 Mapping draft，运行样本校验 | 主键唯一性、外键解析、null/单位/时区结果 |
| 6 预览审阅 | 产品/数据负责人 | 看新增/更新/删除/冲突的差异 | 具体变更预览与规则版本；候选关系仍标声明 |
| 7 受控启用 | 获授权的操作人 | 启用该版本同步；首批限定范围 | runId、配置与映射版本、输入/输出计数、错误清单 |
| 8 回读对账 | 系统执行、负责人验收 | 从目标源重新读取 ID/version/digest | 写回回执与重读吻合；仅调用返回成功不算完整交付 |
| 9 绑定岗位 | Owner/授权管理入口 | 设置 SourceBinding/Grant，独立求值 | 绑定声明、有效授权与一次实际访问结果分开显示 |
| 10 运行维护 | 来源责任人 | 增量同步、重试、schema drift、撤销、恢复 | checkpoint、延迟、失败原因、冲突处置、撤销失效 |

幂等重试使用 connector scope + source event ID/版本 + mapping version；不能重复生成实体或重复执行写操作。
接入失败时可保存 draft；保持未连接状态，不画成功依赖或实际使用边。
切换 endpoint、远端 workspace 或身份视为作用域变化；旧缓存与映射必须重新验证，不能复用跨租户 ID。
写权限最小化；图谱只提供跳转到该 SOP 的入口，不绕过服务端和上游 ACL。

## 10. 探索界面与状态规格

首屏为当前工作区的岗位/来源摘要，资源按来源分组；上方显示更新时间、覆盖状态和截断提示。
搜索对象名称、稳定 ID 和已授权相对路径；同名资源显示来源和路径，不能只给 basename。
对象类型、关系类型和一/二跳范围是三组独立筛选；焦点对象保持可见，筛选空态说明被筛范围。
单击节点打开 Inspector；边的 Inspector 展示“主语—关系—宾语”、声明/观测、证据和限制。
P0 已支持搜索、筛选、一/二跳 focus、可见键盘列表、明确打开动作；最终完成项需按 UI 回读记录。
分页邻居加载、跨来源查询、长期视口恢复、历史时点与冲突处理是后续增强，未验证前不称已交付。
对 available、configured、ready、unknown/error 显示明确文案；外部配置存在应写“已配置，未验证连接”。
外部来源故障不能显示“暂无资源”；不可预览文件应说明格式/大小/失效原因并提供可用动作。
P0“打开文档”回调传 positionId 和 resourcePath，工作区由 App 当前作用域与请求 CAS 隔离；“与 Agent 对话”使用独立动作。显式携带 workspaceId 的跨页导航契约为后续扩展。
P0 提供“适应当前内容”和“重置布局”，后台刷新不自动 fitView；独立“定位选中对象”操作为后续规格。
控制缩放/拖拽只留一套事件层；若节点可拖动，必须接受坐标变化，否则明确仅画布可拖。
布局采用稳定位置和局部增量，避免新邻居让全图跳动；静态声明边不持续流动动画。
visible list 使用同一过滤数据和同一选择 ID，不用隐藏的一像素按钮替代键盘体验。
P0 提供原生 Tab/Enter 列表操作、Escape 关闭详情并把焦点返回列表、reduced-motion 样式；方向键游走节点是后续规格。键盘与焦点体验仍按实际浏览器验收，不以 DOM 存在判定可用。
窄窗口允许列表/详情覆盖层；缩小窗口时操作条和关闭入口仍可到达。
G6 选型与 React Flow/Sigma/Cytoscape 的替代条件见 [library-research.md](./library-research.md)。

## 11. 验收矩阵

| 编号 | 场景 | 可观测通过条件 | 阶段/证据 |
| --- | --- | --- | --- |
| A01 | 同快照重复读取 | ID/排序/revision 一致；仅 generatedAt 可变化 | P0 API 测试 |
| A02 | 空/已有工作区读取 | 文件集合、内容和 mtime 不变；不创建身份/目录 | P0 文件前后快照 |
| A03 | 关系真实性 | 所有边端点存在、domain/range 有效、证据非空 | P0 契约/投影测试 |
| A04 | 声明与执行 | 没有伪 Task→Run、MCP 执行或实际资源访问边 | P0 正反例测试 |
| A05 | 来源状态 | 未配置/未知/失败/空/部分分别呈现，未知不填 0 | P0 API+UI |
| A06 | 安全投影 | 无 token、原始参数、正文、绝对路径、私有审批 roster | P0 schema+敏感夹具 |
| A07 | 切工作区竞态 | A 的晚回包不能污染 B；同 role.id 不混显 | P0 延迟回包测试 |
| A08 | 截断和故障 | 稳定截断有提示；单源失败不吞没其余事实 | P0 上限/坏记录夹具 |
| A09 | 查证资源 | 选中不离图；明确按钮打开正确 path/岗位 | P0 浏览器真实操作 |
| A10 | 关系解释 | 汇报非协作；包含非作者；allow 非最终授权 | P0 产品逐条验收 |
| A11 | 键盘/窄窗 | 可见列表与筛选一致；焦点可返回；无不可达控制 | P0 浏览器+读屏抽查 |
| A12 | 视图稳定 | 刷新不乱跳，选择/布局无重复或泄漏，卸载释放实例 | P0 浏览器/性能记录 |
| A13 | 性能夹具 | 300/1,000 节点与 1,000/5,000 边；同硬件记录 TTI、帧间隔、内存 | 目标，尚未测量 |
| A14 | 交互性能 | 候选目标：拖动帧间隔 p95≤20ms、点击反馈 p95≤100ms | 需确认环境并实测 |
| A15 | 来源接入 | 实际身份探活、分页覆盖、schema 与版本回读 | P1 真实连接验收 |
| A16 | Mapping/血缘 | 改映射版本可追溯；只有执行/回执齐全才出现真实血缘 | P2 正反例+故障注入 |
| A17 | 权限与撤销 | 图不授予权限；读取仍经权威ACL；撤销后无旧缓存泄漏 | P1/P2 服务端测试 |
| A18 | 交付 | 本地测试、CI、浏览器、真实数据回读分别记录 | 每阶段交付清单 |

A13/A14 的夹具规模是验证场景，不是库上限；若 P0 响应上限更小，用独立性能夹具验证，不突破生产边界。
未做真实业务数据、Windows/低配设备或原生 Electron 验收时，明确标“未验证”，不得用单元测试替代。

## 12. 增量实现与交付计划

| 阶段 | 代码范围 | 完成判据 | 不包含 |
| --- | --- | --- | --- |
| P0-1 事实投影 | shared 契约、纯读 builder、GET/IPC、安全与截断测试 | A01–A08 | 新 Connector、外部同步、授权求值 |
| P0-2 关系探索 | G6 容器、搜索筛选、邻域、Inspector、列表和打开动作 | A09–A12；记录真实性能 | 自动血缘、任务执行、历史时点 |
| P0-3 交付核验 | 完整构建/CI、浏览器任务走查、文档同步 | 已完成/未完成清单与可复现证据 | 以研究稿冒充全部落地 |
| P1 来源治理 | Connector/SourceBinding registry、只读探活/发现、分页与权限投影 | 完成 SOP 1–6、A15/A17 | 无回执的写回成功认定 |
| P2 事实血缘 | Mapping 版本、Run/Execution、访问/导出回执、资源版本 | SOP 7–10、A16 | 语义猜测充当事实 |
| P3 深度探索 | 历史时点、跨来源实体解析、冲突工作台、大图/多设备优化 | 明确规模和业务样本验收 | 未定义边界的全量全知图 |

实现可以保留独立 projection adapter，使业务本体不依赖 G6 节点结构；切换渲染库不重写身份与证据逻辑。
出现身份不稳定、源版本缺失、权限不明或跨作用域引用时优先呈现缺口；先补数据契约，再增加视觉关系。

## 13. 给冯浩然的执行 Prompt

```text
你接手 RoleWeave 关系图谱。先阅读 ONTOLOGY_DESIGN.md、data-audit.md、interaction-audit.md、library-research.md，
再读取当前 packages/shared/src/relationship-graph.ts 与 Git 工作区状态；以当前代码为准，不覆盖他人未提交修改。
目标是交付可解释的 Agent—宿主—来源—资源—声明—任务只读探索，先完成 P0，再单独排 P1/P2。

第一步，列出已存在代码、正在实现代码、缺失能力及对应证据。核对 agent=Position，Host/Run 不混为岗位。
第二步，逐条核对 P0 kind/edge/basis/permission/coverage。建立 domain/range、稳定 ID、revision、安全字段白名单测试。
GET 必须无副作用：不得调用会建身份/目录、迁移绑定或刷新 health 的入口。复用稳定有界读与路径边界校验。
来源仅 available/configured 时不要标 bound/已授权；Task 没有 turnId 时不要猜执行边；不建立假 MCP 或 source lineage。
第三步，完成 G6 独立实例生命周期、搜索/类型与关系筛选、一/二跳焦点、证据 Inspector、真实可见键盘列表。
单击保持图谱；“打开文档”带正确 workspace/position/path；“与 Agent 对话”另一个明确动作。
切工作区有 generation 隔离；失败不吞成空数据；截断可见；刷新不抢视口；不渲染原始参数、秘密、正文或绝对路径。
第四步，用 A01–A12 做自动化与真实浏览器走查。A13/A14 只记录测量结果，不把建议目标当成通过成绩。
至少走完：找 Agent→看来源→选资源→看关系证据→打开正确文档；再测来源失败、同名资源和工作区快速切换。
第五步，提供代码 diff、执行命令、测试/CI、浏览器证据和未验证边界；回读最终响应确认没有凭文案造事实。
最后更新阶段状态表。P1/P2 的 Connector/Mapping/授权/Execution 必须有独立契约、真实范围和验收再实现。
不要仅凭本设计稿改外部配置、授予权限、同步或发送消息；后续操作须在已授权范围内执行并核实回执。
若获授权用 DWS 发交付材料，支持时必须显式 --ai-tag=false，并查询真实投递状态。
```

## 14. 证据材料与文档维护

- [数据审计](./data-audit.md)：实体/API/字段和真实缺口，基于审计 commit。
- [交互审计](./interaction-audit.md)：旧图谱问题、用户任务与浏览器待验证项。
- [开源库研究](./library-research.md)：2026-09-22 官方源与实时 GitHub 数据。
- [P0 shared 契约](../../packages/shared/src/relationship-graph.ts)：本次新增类型事实，尚须以最终实现验收。
- 后续 PR 必须更新“已实现/可做/Planned”状态；代码、类型、运行数据和测试证据四者不一致时明确记录差异。
