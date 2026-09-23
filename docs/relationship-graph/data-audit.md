# RoleWeave 关系图谱数据与本体审计

审计基准：`bytefolk/roleweave@8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b`，2026-09-22。范围为 shared/server 源码静态审计；没有检查用户运行工作区、外部服务实连或真实业务结果。代码中存在字段/API，不代表当前用户已配置、有数据或已授权。

> 本文模型/API 是审计阶段建议，不是最终 P0 wire contract。初稿中的 derived、contract_only、verified、empty/unavailable 等不得直接作为当前接口枚举；实际类型以 shared/relationship-graph.ts 和 ONTOLOGY_DESIGN.md 第 8 节为准。

## 1. 结论与首版边界

建议从「岗位/Agent — 宿主 — 来源/资源 — 权限声明 — 任务/目标」构建只读图谱投影。关系必须有字段级来源，点击关系可解释为什么存在、何时观测、是否只是声明。首版可复用已有组织、绑定、文档元数据、权限包、任务和目标记录；执行/上下文血缘按需展开。

必须分开五种状态：`declared`（配置或计划）、`observed`（读取到的实际记录/运行事件）、`derived`（有规则的投影）、`unavailable`（未配置/查询失败）、`contract_only`（只有接口定义）。权限边的“声明允许”不能标成“已经授权/实际可调用”。

特别发现：

1. **岗位级 MCP 尚不可执行。** 所有 bundled Host 的 capability catalog 都没有 `mcp`；hire/profile 对非空 MCP grants 拒绝。UI 可展示遗留配置/能力目录，但不得绘制实际可调用关系。[host gate](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/server/src/agent-registry.ts#L330)
2. **来源摘要不是访问血缘。** mem `binding=available`，注释明确尚未接岗位路径授权；`ready` 仅来自配置存在。Context 来源 `ready` 同样取决于环境变量存在，未执行查询探活。[source projection](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/server/src/context-sources.ts#L30)
3. **任务板尚未连接执行。** `AgentTask` 没有 goalId/turnId/sessionId，创建/更新只持久化并发事件；不能画 `Task → executed_by → Turn`。[task shape](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/packages/shared/src/task-board.ts#L8)
4. **目标分支有契约、缺常规创建闭环。** create 固定 `branches=[]`，update 不接收 branches；已有记录中的分支可投影，不能称用户已能通过 API 新建分支。[goal store](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/server/src/goals/store.ts#L195)
5. **Ontology Runtime、Workflow/Handoff 仍是纯契约。** 有类型和 validator，没有 server 持久化/执行/HTTP surface；不要与真实任务板/审批混为同一对象。[semantic-runtime](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/packages/shared/src/semantic-runtime.ts#L1), [workflows](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/packages/shared/src/workflows.ts#L1)

## 2. 真实实体、标识、API 与可用字段

| 对象 | 标识/可用字段 | 现有读取入口 | 边界与精确代码指针 |
|---|---|---|---|
| Workspace | Manifest name/template/createdAt；运行时 workspaceInstanceId | GET /workspace；session 已有 identity record | manifest 没有稳定 workspaceId；GET /workspace 暴露本地 path，图中不能直接复用该值。`packages/shared/src/org-tree.ts:97`、`health.ts:81`、`apps/server/src/sessions/store.ts:30,315,591` |
| Position / 岗位 Agent | role.id/name/description/reportTo/mode/memoryScope/toolAllow/toolDeny/budget/metadata | GET /org/tree，GET /positions/:id | role.id 仅工作区内唯一；宿主不是员工身份。包路径会随汇报关系移动，不适合主键。`shared/org-tree.ts:47`、`server/routes/positions.ts:53`、`context-sources.ts:86` |
| EmployeePackage | name/version/digest/localReference | org role.package / server 本地 package | digest 是包版本证据；localReference 是绝对路径，应只在 server 内使用。`shared/org-tree.ts:37` |
| AgentBinding / Host | binding.engine/locked/model；Host id/label/availability/capabilities/version | position card；GET /health | binding sidecar `.workbench/agent-binding.v1.json`；无 binding 时不该猜默认宿主作为事实。Host catalog 的 ready、configured、localProbe 含义不同。`shared/agent-binding.ts:17`、`server/agent-registry.ts:14,98,245` |
| ContextSourceBinding | id/kind/name/locator/binding/state/readOnly/itemCount | position.contextSources | 3 个固定 source IDs 在每岗位重复，不能直接作为全局 node ID；count 为岗位文档或本地 export-state 数量，不是实际召回条数。`shared/context-sources.ts:15`、`server/context-sources.ts:16,183` |
| LocalDocument | positionId + POSIX relative path；size/modifiedAt/version | GET /docs/list?position=<id>，GET /docs/read?position=<id>&path；POST /docs/resolve | owb-doc URI 未带 workspace namespace；mtime 是文件版本而非编辑历史；图只取 list metadata，不取全文。`shared/docs.ts:24,40,70,161`、`server/routes/docs.ts:99,119` |
| Asset | assetId/kind/title/createdAt/sourceRef/docRef | GET /assets/list，GET /assets/read | kind=doc/conversation-excerpt/decision；sourceRef 是可选引用，不证明引用对象存在；doc asset 与本地 Document 应以 represents 边连接，不重复当成同一主键。`shared/docs.ts:77`、`server/assets/store.ts:25,128` |
| ExternalConnection | kind=doc/mem、apiUrl/webUrl/workspaceId/configured/tokenConfigured | GET /services；POST /services/probe | token server-only；mem workspace UUID 会变成 X-Workspace-ID；外部身份要含 connection/service namespace。`shared/services.ts:1`、`server/services/connections.ts:42,57,84` |
| ExternalDoc | upstream id/title/icon/updatedAt/starred；source=upstream/mock | GET /doc-plane/list，GET /doc-plane/detail?id | 有显式 mock 开关，mock 不得混入实测图；TipTap detail 被 flatten，非原始完整格式。`shared/docs.ts:269`、`server/routes/doc-plane.ts:67,155` |
| MemFile | id/name/size/mime/createdAt/summary | GET /drive/list?q，GET /drive/detail?id | 只查 `/v1/files?limit=200&page=1`，q 是当前页过滤；无完整清单/语义召回/岗位ACL/跨来源血缘。upload 仍 stub。`shared/drive.ts:20`、`server/routes/drive.ts:75,115` |
| Skill / MCP / Tool | skill id/version；MCP id/tools；通用 tools string[] | position.capabilities + permissionPolicy | 平台固定目录，非当前在线 discovery；grant 不是资源授权。MCP 当前被 host gate 禁止新增。`shared/capabilities.ts:15,51`、`server/routes/positions.ts:20` |
| PermissionRule | scope/resource/actions/effect/approval；defaultEffect=deny | position.permissionPolicy；permissions.json | resource 可为 path/glob/skill:// /mcp://，不是存在的资源实例。完整规则与 employee.policy 的派生表示应分开。`shared/hire.ts:25`、`server/org/permission-artifacts.ts:58` |
| AgentTask | taskId/title/assigneePositionId/requestedByPositionId/budgetOwnerPositionId/kind/status/mainline/priority/acceptedAt | GET /tasks?positionId | 已落盘，有限状态转移；预算 owner 是责任声明，非实际扣账结果。HTTP actor 当前取 org.owner。`shared/task-board.ts:8`、`server/routes/tasks.ts:9` |
| Goal / GoalBranch | goalId；branchId/positionId/sessionId；status/health | GET /goals，GET /goals/:id | 列表是 summary 无 branches；getDetail 可写 health；分支声明缺创建API。`shared/goals.ts:43`、`server/goals/store.ts:266` |
| Session | sessionId/workspaceInstanceId/positionId/principal/status/rotatedFrom/rotatedTo | GET /sessions?positionId，GET /sessions/:id | 具有 durable identity；普通 list 可能初始化身份，图要用只读索引。`shared/sessions.ts:6`、`server/sessions/store.ts:315,591` |
| Group / Message | conversationRef/sessionId/members；messageId/mentions/mode/spawns | GET /groups，GET /groups/:id，GET /groups/:id/turns | roster 只证明成员；mentions+spawns 才证明分派，relay 顺序可留痕。`shared/groups.ts:20,27,45` |
| Turn / Run / Trace | turnId/conversationId/positionId/engine/runId/status/envelopeDigest/events；retryOf/goalId/branchId/attachments | GET /turns?positionId；GET /sessions/:id/turns；group timeline | model 是请求值不是提供方实际模型；trace 只有公开 title/detail/parentActivityId，不含结构化 tool/resource ID，不能凭 title 自动归一到权限目标。`shared/turns.ts:100,198,211` |
| Approval | record.id/approvalId/version/source/policy/decisions/execution | GET /approvals 等；server store | source 有 position/conversation/turn/run/engine，审计有 seq/hash；批准不等于执行成功。View 隐藏 policy roster/decisions，图不能绕过该投影。`shared/approvals.ts:68,86,113` |
| Attachment | id/fileName/mimeType/sizeBytes/extractedText | /attachments/read?sessionId&attachmentId；TurnRecord.attachments | 会话隔离；不能只用 filename 去重；默认图不含抽取文本。`shared/attachments.ts:19`、`server/attachments/routes.ts` |
| Evidence / Audit / ExportOccurrence | reports evidence turnId/runId/digest；Context occurrenceId/scope/source/contentSha256 | GET /reports；本地 context-exports state（无独立HTTP） | reports 派生自 turn + org audit；Context export 有落盘状态，完成 session turn 才 enqueue。`shared/health.ts:130`、`server/routes/reports.ts:22`、`context-export/exporter.ts:21,63,190` |

以上表中 `shared/...` 均指 `packages/shared/src/...`，`server/...` 均指 `apps/server/src/...`，行号以审计 commit 为准。

## 3. 可证明的血缘与明确缺口

- **真实可证明：** Session → Turn → ContextOccurrence。occurrenceId 由 workspaceInstanceId/positionId/principal/sessionId/turnId/role 派生；带 source eventAt/contentSha256/sourceDigest；export status=done 有 adapter ingest/distill 回执检查。`apps/server/src/context-export/exporter.ts:140,190,244`。
- **仍不能证明：** occurrence 被下一次 Turn recall 使用。当前 exporter 客户端只有 ingest/distill；sourceLocator 是审计引用，注释明确不等于 item-unique artifact locator。`exporter.ts:40,53`。
- **部分证据：** Turn.threadContext 有 sourceTurnCount/contextBytes/contextDigest/redacted/truncated，可说明历史上下文注入规模；没有 sourceTurnIds 清单，不足以构造逐条历史 turn→turn 血缘。`shared/turns.ts:198`。
- **引用边需解析：** Asset.sourceRef / Turn.goalId/branchId 是存储字段；图必须在当前 namespace 查目标，找不到就标 unresolved，不虚构完成的业务对象。Turn 的 goal/branch 校验主要是 ID 形状，非完整外键约束。`server/turns/store.ts:457`。
- **不存在通用 SourceMapping/Lineage runtime：** 在 shared/server 查 `lineage/sourceMapping/source_mapping` 未发现通用映射存储或API。现有 `normalizeMemFile`、`normalizeDocEntry` 只是响应字段归一；`BusinessObjectRef/EvidenceRef/DecisionRecord/ActionProposal/ExecutionReceipt` 只定义在 shared semantic-runtime，server 尚无消费者。
- **memorySources 不是真实接入登记。** Hire 接收该字段，但 skeleton 将其写为 SKILL.md 的“记忆来源”文本；position.contextSources 又独立生成三类固定摘要，不能将两者当成同一个已连接来源 registry。`server/org/apply.ts:546,606`。

## 4. 建议本体与关系约束

### 对象层次

1. 组织层：Workspace、Position（UI 可叫 Agent）、EmployeePackage、HostKind、AgentBinding。
2. 资源层：SourceConnection、SourceBinding、ResourceSelector、LocalDocument、ExternalDoc、MemFile、Asset、SkillDefinition、McpDefinition、ToolDefinition。
3. 治理层：PermissionRule、ApprovalRequest、ApprovalDecision、EvidenceReference。
4. 工作层：Goal、GoalBranch、AgentTask、Session、Group、Turn、Run、TraceActivity、ContextOccurrence。

保留 `AgentTask` 与未来 `WorkflowTask` 的不同 type/schema；Position、HostKind、Run 三者不可合并成同一个“Agent”。不为尚未接入的外部业务对象创建假节点。

| 方向 | 语义与证据 | 约束 |
|---|---|---|
| Workspace → contains → Position | org.roles | 同工作区，role.id 唯一 |
| Position → reports_to → Position | role.reportTo | 下属指向上级，0..1；无环；缺目标标异常 |
| Position → bound_to → HostKind | 已存在 binding.engine | 0..1 当前绑定；无 binding 为未绑定，不用默认补事实 |
| Position → uses_package → EmployeePackage | package name/version/digest | 包变更产生版本证据，移动目录不改岗位身份 |
| Position → declares_source → SourceBinding | contextSources binding/state | available 不能渲染成“已绑定/有访问权” |
| SourceConnection → exposes → Resource | 外部 list 的真实ID | 仅证明操作者通过该连接可见，不证明岗位可见 |
| Position → owns_document → LocalDocument | allowlisted package文件元数据 | ownership 表示归属包，不表示实际读取过 |
| Position → declares_capability → Skill/Mcp/Tool | permission/capability manifests | MCP 需 runtimeSupported=false；只有声明 |
| Position → governed_by → PermissionRule → targets → ResourceSelector | permissions.json | 保留 deny、approval、scope/action；selector 不直接等于文件集合 |
| AgentTask → assigned_to/requested_by/budget_owned_by → Position | task 三个ID | 这是三个不同关系；无 turn 执行边 |
| Goal → has_branch → Branch → assigned_to/uses_session → Position/Session | 已有 branch fields | 只读取存在字段；未落盘不画 |
| Turn → executed_by/uses_host/in_session → Position/Host/Session | durable TurnRecord | completed/failed/indeterminate 分开；model 为 requested |
| Turn → retries → Turn | retryOf | 同会话；不可因标题相同连边 |
| Group → has_member → Position；Message → dispatches → Turn | members / spawns | 成员不等于实际参与；预登记spawns不等于成功运行 |
| Approval → requested_by_turn → Turn；Approval → resumed_as → Turn | source / execution.turnId | granted 不等于 completed |
| ContextOccurrence → derived_from → Turn | export state + digest | pending/failed/done 原样保留；sourceLocator 不冒充可读artifact |
| Asset → references → Document/Session/Group | docRef/sourceRef | 先解析 namespace，再查存在性，避免重复或悬空实体冒充实测 |

### 身份、时态、证据与权限

- 节点 ID 采用 opaque canonical key：`namespace + kind + nativeId` 的稳定编码/哈希。workspace 优先读已存在 `.roleweave/sessions/workspace-instance.json`；无身份时 hash 规范化真实路径作为仅本机 fallback，标明非跨机ID，GET 不创建文件。外部 nativeId 加 service connection + remote workspace namespace，不能按 title/name 合并。
- LocalDocument 用 workspace + positionId + POSIX relative path；Asset UUID 另保留，通过 docRef 关联。ContextSourceSummary.id 只是每岗位的槽位名，不是跨岗位唯一来源。
- 边 ID 由 `kind/from/to/qualifier/scope` 稳定派生；同一关系多个证据聚合进 evidenceRefs，而不是每次刷新生成新边。版本变动更新 evidence，不让无关 observedAt 造成 graph revision 无限变化。
- 每边保留 `basis`、`sourceRef`、`sourceVersion/digest`、`observedAt`、`validFrom/validTo`（未知就省略）、`scope`、`resolution`。读取到配置是观测到的“声明”，不是观测到动作发生。
- 不能以 SSE seq 作永久 event ID：EventBus 只有每进程256条 ring，重启清空。SSE 适合刷新失效通知，事实必须从落盘状态重建；重连缺口执行 bounded snapshot reload。`server/bus.ts:3,12`。
- `permissionState=declaration_only/unknown/verified`；P0 rule 边统一 declaration_only，除非有相同 actor/resource/action/version 的真实授权/拒绝回执。图读取是本地操作者 boot token 身份，不能当成 Agent 的资源权限。`server/auth.ts:21`。
- 图不返回 raw input/output、文档正文、token、secret、完整绝对路径、approval roster。图节点 visibility 与源读取权限相交，展开时再次校验，统计也不能泄漏隐藏对象数量。

## 5. 服务端投影接口与只读约束

建议新增 `GET /graph/relationships` 返回统一 bounded snapshot，避免 renderer N+1 拉所有 position/full turns。默认只投影 workspace/position/host/source/resource-selector/capability/policy/task/goal；文档按岗位最多20条，岗位最多100，nodes≤400、edges≤800；按稳定顺序截断，并明确 `coverage=partial/empty/unavailable` 与 reason。不得把失败吞为0条/完整。

建议响应至少含：schemaVersion、workspaceId、revision、generatedAt、nodes、edges、coverage、truncated。revision 对确定性结构/源版本摘要计算，排除 generatedAt。异步响应必须捕获打开工作区快照，完成前拒绝跨工作区混合。节点选择、筛选和布局属于前端状态，不写 org 树/源数据。

只读陷阱（避免直接复用带副作用入口）：

- `SessionStore.list` 经 workspaceIdentity 可能 mkdir/chmod/创建 instance；优先 `readAuthoritativeSessionIndex`（`sessions/store.ts:315`），缺目录返回明确 empty/identity_unavailable。
- `TaskBoardStore.list` 会 mkdir tasks root（`tasks/store.ts:45`）；图应使用无副作用读取方法或已有白名单记录稳定读取。
- `GoalStore.getDetail(..., turns)` 会改写 health/updatedAt/activity（`goals/store.ts:266`）；图使用 `get()` 或纯 read/derive。
- 读取文件复用 `readStableBoundedFile/decodeStableUtf8`，有大小限制、no-follow 与 inode 稳定校验；不要新增 lstat→readFile 竞态。
- `readPositionAgentBinding` 是只读；不要为了图展示调用 first-use migration、setPositionAgentEngine 或创建 session。
- 外部 doc/mem 默认只显示配置/来源槽位；需要用户展开时再做超时有界读取。当前 mem 页上限200而无分页完整性元数据，不能标 complete inventory。

## 6. 首版验收建议

1. 相同源快照产生相同 IDs、边、排序与 revision；仅 generatedAt 变化不触发布局重排。
2. GET 前后工作区文件集合/内容/mtime 不变；空工作区不新增 `.roleweave` 或 sessions identity。
3. 所有边都有存在端点与字段证据；悬空引用显式覆盖缺口；没有 task→turn 或未绑定 MCP 的伪执行边。
4. source available、configured、bound、ready、observed 使用不同文字；外部失败不是“暂无数据”。
5. 文档/MCP/resource deny/approval 关系有解释；不返回 secret、绝对路径或正文。
6. 100岗位/文档上限、400节点/800边稳定截断；显示覆盖提示，单个坏文件不拖垮其他可验证来源。
7. 切换工作区期间旧响应不可替换新图；SSE合并刷新且保持当前筛选、选择、缩放，删除实体清理相关边。

## 7. 尚需新增而不能由现有数据推断的内容

- 通用 SourceConnection/SourceMapping registry、source object primary key 和字段级 lineage。
- 真实 MCP discovery、服务实例/工具调用 ID、岗位资源授权求值和回执。
- Task → Goal/Turn/Artifact 的显式关联与运行触发/结果写回。
- Context recall 的 item-level 证据、读权限、返回 artifact locator、版本与引用 span。
- 跨主机/克隆工作区身份迁移策略，以及图 projection watermark/持久审计。

这些应作为后续工程范围与数据缺口展示，不能通过模型猜测或文案包装补成事实。
