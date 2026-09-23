# RoleWeave 关系图谱：现状审计与交互规格

审计时间：2026-09-22。代码基准：`8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b`。只读检查了 `OrgChart.tsx`、`App.tsx`、文档与记忆模块、共享契约、样式和已有测试；没有修改仓库或执行远程写入。

**判断：现有图谱是“组织汇报树 + 岗位包文件”的投影，尚不能解释 Agent、数据源和资源之间的完整关系。优先补足对象身份、可证明的关系、局部探索和原位详情，再改善画布。** 仅增加节点种类或重新配色，无法解决现在的导航中断、文件重叠和数据状态失真。

本文区分三个证据级别：**已确认**为源码可直接证明；**待交互复现**为源码暴露风险但仍需真实浏览器验证；**建议/目标**为拟定规格，均非已交付能力或实测结果。

## 1. 当前实现和可复用能力

| 范围 | 当前事实 | 证据 |
| --- | --- | --- |
| 入口 | 组织模块在“工作台 / 总览”间切换；总览传入 resources，即使为空对象也使用 KnowledgeGraph | [App.tsx](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/App.tsx#L2152)、[OrgChart.tsx](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/org/OrgChart.tsx#L480) |
| 对象 | 只有 `agent`、`document`；Agent 来自组织树，所有列出的岗位包文件被投影为 document | [OrgChart.tsx](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/org/OrgChart.tsx#L89) |
| 关系 | `reports` 从上级指向下级，`owns` 从 Agent 指向岗位包文件；无数据源实体和使用/引用证据 | [OrgChart.tsx](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/org/OrgChart.tsx#L94) |
| 导航 | 所有节点点击都只回传 agentId；App 统一打开负责人会话并卸载图谱 | [OrgChart.tsx](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/org/OrgChart.tsx#L118)、[App.tsx](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/App.tsx#L1054) |
| 数据源契约 | 已有 `workspace_docs / mem_drive / context_provider`、`bound / available`、`ready / empty / not_configured / error`；可作为图谱来源摘要的基础，不能据此虚构资源详情或实际使用关系 | [context-sources.ts](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/packages/shared/src/context-sources.ts#L11) |
| 文档详情 | 已有 `positionDocFile(id, path)`，DocsPanel 支持 requestedPath、读失败、重试和请求版本隔离；图谱尚未接入该导航 | [DocsModule.tsx](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/docs/DocsModule.tsx#L126)、[DocsPanel.tsx](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/docs/DocsPanel.tsx#L118) |
| 已有保护 | App 的 refreshReadVersion 会丢弃旧刷新完成结果；岗位详情也有 selectionVersion；切工作区恢复会话状态有既有机制 | [App.tsx](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/App.tsx#L538)、[App.tsx](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/App.tsx#L698) |

## 2. 实际问题与影响

优先级：P1 为会阻断核心任务、误导含义或明显破坏可用性；P2 为状态完整性、规模和操作效率问题。以下为审计建议优先级，不是 GitHub 已登记状态。

| ID / 优先级 | 发现与证据 | 用户影响 / 处理方向 |
| --- | --- | --- |
| I01 / P1 已确认 | ReactFlow 使用受控 `nodes={nodes}` 并启用 `nodesDraggable`，却没有 `onNodesChange` 或持久化坐标状态。节点每次渲染都按固定公式重建。[OrgChart:148–165](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/org/OrgChart.tsx#L148)。本机依赖的 triggerNodeChanges 只会在 defaultNodes 模式自行 applyNodeChanges，否则调用 onNodesChange。 | 没有可工作的受控坐标更新闭环。明确选择“固定布局、只拖画布”，或实现拖动坐标、停止时记忆和重置布局；不能显示可拖动能力却不接收变更。 |
| I02 / P1 已确认 | 同一 Agent 的文档 x 坐标只增 45px，宽度为 190px，y 完全相同；相邻文件横向重叠 145px。这是公式计算，不是性能测量。[OrgChart:149–154](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/org/OrgChart.tsx#L149)、[app.css:5610](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/app.css#L5610)。 | 两个以上文件就互相遮挡；更多文件侵入邻近 Agent 区域。默认折叠资源集合，展开时用已测量节点尺寸进行无重叠布局。 |
| I03 / P1 已确认 | 点击文档没有使用 path，而是调用 `onSelect(agentId)`；App 随即关闭总览并打开会话。[OrgChart:123、172](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/org/OrgChart.tsx#L123)、[App:2168](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/App.tsx#L2168)。 | “从关系查证文件”任务中断。单击在原位查看对象，明确“打开文档”和“与 Agent 对话”两个动作，跳转携带资源身份和返回上下文。 |
| I04 / P1 已确认 | “Agent 协作”筛选实际选择 `reports` 汇报边。边没有可见关系名和箭头。`owns` 仅由文件所在目录生成，ARIA 却说“由某 Agent 负责”。[OrgChart:102、110、157–162](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/org/OrgChart.tsx#L102)、[zh.ts:379–386](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/packages/ui/src/locales/zh.ts#L379)。 | 把汇报当协作，把位置关联当责任或所有权，用户会读错关系。关系名、方向、逆关系与证据一并定义；岗位文件首先标“包含于岗位包”，协作必须来自任务/委派记录。 |
| I05 / P1 已确认 | 图谱没有数据源节点，也不消费已有 contextSources；将所有文件统一当 document。[OrgChart:89–113](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/org/OrgChart.tsx#L89)。 | 无法回答“Agent 接了什么来源”“数据源里有哪些资源”“来源故障影响谁”。引入数据源、资源的独立身份，保留绑定和可用状态区别。 |
| I06 / P2 已确认 | App 每次组织 refresh 对所有 N 个岗位执行 positionDocs；完成全部文档请求后才开始 N 个 position 元数据请求，即使没打开图谱、或仅移动/重排组织也读取文档。[App:589–605](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/App.tsx#L589)。服务端每个文件列表会递归遍历岗位包，无分页。[docs.ts:75–115](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/server/src/routes/docs.ts#L75)。 | 全量扇出和最慢目录阻塞名字加载；组织操作与资源扫描耦合。先读轻量摘要，打开图谱后按需扩展；设置并发上限、分页和局部失效。 |
| I07 / P1 已确认 | positionDocs 的非 200/异常统一变成空数组，丢失错误与未配置状态。[App:591–600](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/App.tsx#L591)。OrgChart 只有 loading 与 empty，无 error/partial 状态。[OrgChart:474–481](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/org/OrgChart.tsx#L474)。 | 读取失败被展示为“没有资源”。保留来源级 loading/error/empty/unavailable 状态，展示可重试失败项，同时允许探索其余数据。 |
| I08 / P2 已确认，混显需复现 | 刷新版本校验确实存在，不能报告成“晚回包一定覆盖新工作区”。但在新的 snapshot 提交到全部 resources 提交之间，resources/names 仍是旧值；切工作区没有立即清空或为三者绑定同一 workspace generation。[App:576–624](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/App.tsx#L576)。常用 openWorkspace 路径会设置 treeLoading 遮盖这段窗口，但普通 refresh 没有统一重置 loading。[App:1377–1381](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/App.tsx#L1377)。 | 需要验证刷新失败、外部工作区变化及同名 Agent 场景中的旧资源混显；不能只测成功快路径。所有图谱状态带 workspaceId + generation，同一作用域内渐进提交；新作用域首帧不保留旧实体。 |
| I09 / P2 已确认 | 筛选通过边端点集合决定节点是否显示；独立 Agent 在“Agent 协作”视图消失，没有文档时“文档资源”呈空画布，无筛选空态。[OrgChart:140–148](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/org/OrgChart.tsx#L140)。 | 用户难分“没有对象”和“没有该关系”。对象类型、关系类型、邻域范围三种控制应分开；当前焦点实体始终可见，空态说明当前筛选。 |
| I10 / P2 已确认 | Agent 和其每个文档都用 `selectedId === agentId` 高亮，不能单独选中文档；KnowledgeFlowNode 没有像旧 ChartNode 那样提供 aria-pressed。[OrgChart:120、155](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/org/OrgChart.tsx#L120)。 | 选择状态表达“整组”而非用户点中的对象。独立保存 selectedEntityId；邻居高亮另设 related 状态，关系可单独选择。 |
| I11 / P2 已确认 | 为文档额外渲染一套被 CSS 裁成 1px 的 button；它们仍可聚焦，且始终来自所有 graph.nodes，不跟随筛选。[OrgChart:169–172](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/org/OrgChart.tsx#L169)、[app.css:5618](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/app.css#L5618)。 | Tab 会进入看不见的文件按钮；实际节点存在时有重复可访问入口；筛掉的文件仍可被操作。提供真正可见、与筛选一致的关系列表模式，不以隐藏按钮替代可访问设计。 |
| I12 / P2 待交互复现 | KnowledgeGraph 内的 ReactFlow 与外层旧 OrgChart pointer 捕获、wheel 缩放监听同时存在；旧监听仍改 view，图谱却不用该 view。[OrgChart:270–337、465–481](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/org/OrgChart.tsx#L270)。 | 存在重复事件处理、指针捕获和无效重渲染风险。需真实鼠标/触控板验证；新图谱应拥有唯一手势处理层，旧 CSS 画布只在旧树模式绑定。 |
| I13 / P2 已确认 | 切模块/工作区会重置 orgOverview；离开总览时图谱卸载，filter 和 ReactFlow viewport 无外部存储；selectedId 不是按 workspace 保存。[App:276–285、590、2158](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/App.tsx#L276)。 | 看完详情返回后丢失浏览位置、筛选和展开路径；两个工作区同 ID 也不是独立选择。图谱状态以 workspace 为键保存，跳转有明确返回点。 |
| I14 / P2 已确认 | 用全局 DFS 次序安排所有 Agent 的 x，而非子树居中；新增节点会平移其后所有 Agent。最小缩放为 .35，且资源全展开；未配置 onlyRenderVisibleElements。[OrgChart:142–165](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/org/OrgChart.tsx#L142)。 | 大图无法仅靠 fitView 解决可读性；局部更新扰乱空间记忆。首屏采用摘要/邻域和稳定布局，明确“还有 N 项”，增量加入而不重排所有节点。 |
| I15 / P2 已确认 | 文档仅显示 basename；没有完整路径提示、类型/大小/修改时间和可读能力。列表可含任意常规文件，而读取端只接受指定文本扩展名且上限 256KB。[OrgChart:109、126](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/org/OrgChart.tsx#L109)、[docs.ts:141–146](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/server/src/routes/docs.ts#L141)。 | 多个 README 难以区分，文件被画成“文档”不代表能读取。卡片区分资源类型，详情提供完整来源路径与能力状态；不可预览显示原因。 |
| I16 / P2 已确认 | 文档新增/修改没有专门驱动 positionResources 刷新；App 事件处理在 org.updated 时全刷，在 turn.* 终态只更新报告/会话。[App:985–1016](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/App.tsx#L985)。 | 资源视图可能持续陈旧直到下一次组织刷新。来源变更按 entity/source 失效；显示抓取时间和手动重试，不用动画暗示实时。 |
| I17 / P2 已确认 | 所有 owns 边持续 animated，动画不代表运行或数据流；图谱没有针对这类边的 reduced-motion 控制。画布 min-height 420px 且父级隐藏溢出。[OrgChart:157](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/org/OrgChart.tsx#L157)、[app.css:5608](https://github.com/bytefolk/roleweave/blob/8f5f8fe41488fd785806ea7c6f369b7e1cb3e55b/apps/desktop/renderer/src/app.css#L5608)。 | 静态所属关系显得像实时传输；小窗口控制区是否裁切需浏览器复现。静态关系默认静止，动画仅表达可证实运行事件；尊重减少动态效果，画布使用实际剩余空间。 |

## 3. 本体如何变成用户能操作的关系

以下是建议契约，需与服务端当前可提供的真实证据对齐后实现。

| 实体/关系 | 用户可理解的含义 | 不能越过的证据边界 |
| --- | --- | --- |
| Agent | 组织中的数字员工，详情包含岗位、直接上级、运行状态、绑定来源数量 | displayName 不是身份；使用 workspace + positionId 形成稳定身份 |
| 数据源 Source | 一个可连接、可配置、可失效的来源实例，例如岗位包、某个 mem drive、context provider | `available` 不等于已绑定；没有上游条目总数时显示未知，不填 0 |
| 资源 Resource | 来源里的具体条目，如文档、文件、技能定义等；区分可预览与不可预览 | 源种类与资源种类分开；同名不去重，只有相同来源和权威 ID 才合并 |
| A 汇报给 B | 子级 → 上级，反向读作 B 管理 A | 当前数据来自组织 reportTo，不能称为“协作” |
| Agent 绑定来源 | Agent → Source，详情显示绑定状态、来源配置和观测时间 | 对仅 available 的来源展示“可用，未绑定”状态或发现入口，不画成已绑定 |
| 来源包含资源 | Source → Resource | 岗位包文件列表只能证明包含；不能推出作者、负责关系或最近使用 |
| Agent 使用/引用资源 | Agent → Resource，详情有发生时间和事件/文档证据 | 没有使用事件时不画；绑定和可见不代表用过 |
| Agent 协作 Agent | 一次委派/协作任务及状态，可从关系转到任务 | 组织上下级和通讯录共现不构成协作证据 |

每条边至少携带：关系类型、sourceId、targetId、证据来源、观测时间、证据引用、可用状态。UI 展示自然语言“谁—怎样关联—什么”，点击关系查看证据。关系方向只有一套规范，反向文字是展示规则而非另一份事实。

实体主键应含 workspaceId / sourceId / upstreamId 或规范相对路径。选择、缓存、展开状态都用同一主键；不可用 basename 或展示名作为 key。路径只做来源定位，不向页面泄露非必要绝对本地路径或凭据。

## 4. 完整用户任务与交互规格

### 4.1 找到 Agent，理解它依赖什么

1. 进入图谱看到当前工作区、数据更新时间、Agent/来源/资源的可用摘要。首屏先呈组织/来源摘要，资源默认按来源折叠，不自动展开全量文件。
2. 搜索 Agent 名称或 ID；结果显示类型、所属工作区/来源的简短信息，选中后定位实体并打开右侧详情。
3. 单击对象只选中并打开详情，不离开画布。相关一跳节点和边强调显示，其余降低对比但仍可辨认。
4. 详情显示该 Agent 的上级、来源绑定、资源数量（未知则明说）及失败来源。关系行可“在图中定位”或“展开”。
5. 点击明确的“打开工作台/开始对话”才跳转。回来恢复原焦点、展开路径、过滤器和视口。

### 4.2 找到资源，确认来源，再阅读

1. 搜索文件名或来源内路径；同名结果显示完整相对路径和来源名称。
2. 选中资源展示名称、类型、所在来源、可读状态、修改时间（标明它是文件修改时间）、关联 Agent 和关系证据。
3. “预览”在右侧展开内容；“打开文档”跳转现有记忆/文档页面并精确选中 requestedPath。岗位文件导航至少携带 workspaceId、positionId、path；上游资源导航使用其 sourceId 和 upstreamId。
4. 大文件、二进制、已删除、无权限、来源离线分别展示具体原因与可行动入口，不都显示“空”。
5. 返回图谱恢复资源选择并将焦点还给原对象；详情内的“联系关联 Agent”作为独立次级动作。

### 4.3 从数据源看影响范围

1. 点击来源节点，看到绑定状态、连接状态、资源摘要、更新时间和使用该来源的 Agent。
2. “展开资源”按页加载，首批建议 25 项；保留“继续加载 N 项/更多结果”集合节点，数量未知时不捏造剩余数量。
3. 来源异常时仍能查看已知绑定关系；缓存资源清楚标“上次成功同步”，只对该来源重试。
4. 反向浏览哪些 Agent 绑定该来源。若无使用事件，文案为“绑定的 Agent”，不得称为“受实际调用影响的 Agent”。

### 4.4 查关系证据并跟进任务

1. 点击边或列表中的关系行，在详情展示主语、关系、宾语及证据。
2. 汇报关系显示组织配置来源；资源包含关系显示来源定位；协作关系显示具体任务和状态；使用关系显示实际调用/引用记录。
3. 可从证据跳转对应任务/事件。图谱不自动推断成功、权限、因果、责任归属。
4. 没有证据的关系类型在筛选中标“当前未接入”，不能用虚构边填满演示。

### 4.5 筛选、展开和导航

- 分开提供对象类型（Agent/来源/资源）、关系类型（汇报/绑定/包含/使用/协作）和范围（当前邻域/组织概览）。“Agent 协作”只筛真实协作事件。
- 焦点实体不因关系筛选悄悄消失；被筛掉的邻居在详情显示数量并提供清除筛选。未关联对象在类型视图仍能被找到。
- 一次操作只扩展当前对象的一跳关系；扩展前显示范围或摘要，支持折叠与回到上一焦点。
- “适应当前内容”“定位当前对象”“重置布局”是独立操作。后台更新不自动 fitView，不把用户从正在读的位置拉走。
- 同工作区返回恢复视口与过滤；切工作区立即使用新状态，A→B→A 恢复 A 的独立状态；实体已删除时解释原因并落到最近有效上下文。
- 手机/窄窗口可切列表视图或详情覆盖层；覆盖层关闭后焦点回到原节点。

### 4.6 画布操作和布局

- 建议首版采用自动稳定布局、节点不自由拖动，鼠标拖空白平移；若交付自由拖动，则必须有受控坐标更新、工作区范围记忆和重置。两种能力都不暗示拖动会修改组织关系。
- 只保留一套画布 pointer/wheel 处理；节点按钮/详情滚动不触发画布拖拽。拖动超过阈值不触发点击跳转。
- 鼠标滚轮、触控板双指移动/捏合行为写成帮助提示并分别验收；提供可点击的缩放和适应按钮。
- 布局基于节点测量尺寸和关系层级，Agent/来源/资源分组呈现；新加入的邻域在局部腾出空间，已有不相关节点尽量保持位置。
- 卡片长期保持可辨认名称；低缩放时使用摘要而不是将数千张卡缩成点。资源集合节点是有计数和展开动作的真实 UI。
- 线条颜色之外同时使用方向、标签和类型图例。静态关系默认不动画，真实进行中的任务可短暂强调并受 reduced-motion 控制。

### 4.7 键盘和辅助技术

- 主工具栏、搜索、图谱/关系列表切换、详情具有清晰的 Tab 顺序；不允许键盘落到不可见克隆节点。
- 可见节点使用 roving tabindex，方向键在邻近可见节点间移动；Enter 打开原位详情，Escape 关闭详情或回到画布，均不抢输入框按键。
- 选中对象提供 selected/pressed 语义；每条关系可读为“文档 A 包含于数据源 B”，不仅朗读边 ID。
- 提供可见关系列表模式，内容与当前筛选/权限一致；所有核心任务可仅用键盘完成，不要求拖拽。
- 加载与错误结果有适度 live region 通知；详情打开/关闭、跳出/返回后焦点有明确落点。减少动态效果时关闭边动画和非必要相机过渡。

## 5. 数据和状态规格

| 状态 | 应有呈现 | 行为 |
| --- | --- | --- |
| 未打开工作区 | 工作区入口 | 不发图谱资源请求 |
| 初次加载摘要 | 容器骨架及明确文案 | 搜索/菜单框架稳定；不渲染旧工作区对象 |
| 正常、没有对象 | 解释“当前工作区还没有 Agent/来源” | 给实际可用的创建/连接入口 |
| 没有筛选结果 | 当前筛选条件、清除入口 | 不伪装成工作区为空 |
| 来源待展开 | 来源摘要/集合数量 | 用户展开时读第一页 |
| 局部加载 | 集合节点局部进度 | 已有画布仍能平移、选中 |
| 部分来源失败 | “已加载 X 个来源，Y 个失败”及失败来源状态 | 单项重试，不回退整个图谱 |
| 缓存过期/离线 | 上次成功时间、缓存标记 | 可查看已有数据；不能宣称实时完整 |
| 无权限/未配置 | 分开标识，不泄露无权查看的对象详情 | 使用真实配置/申请入口，无入口时解释 |
| 切工作区/快速重试 | 作用域切换，旧请求取消或忽略 | workspace generation + request version 双重校验 |

建议把图谱加载从 App 全局 refresh 拆出：摘要先到，资源按需读取；缓存键包含 workspace、source、query、page、版本；同请求去重，并发上限和取消贯穿 IPC/服务边界可支持的范围。若底层无法取消，则仍须丢弃过期结果。

更新按来源/实体失效，避免每次组织移动重新扫描所有文件。首次打开图谱前，不为图谱新增全量 positionDocs 请求；元数据读取不能依赖最慢的资源列表完成。服务端若暂无分页或聚合接口，UI 不能假装已经获得“全局总量”或“完整搜索”。

## 6. 验收用例与性能目标

**本节所有时间、规模、FPS 和请求数门槛都是建议验收目标，不是当前实测能力。** 先在确定的桌面测试机、版本、窗口和数据集上记录基线，再由实现方确认门槛。真实浏览器/打包应用的交互结果必须与单元测试区分。

| 验收场景 | 通过条件 |
| --- | --- |
| 一个 Agent、没有任何边 | 类型视图仍可见、可搜索；关系视图清楚说明没有该关系 |
| 一个 Agent 有 2/25/1,000 个资源 | 首次仅摘要/分页；展开卡片无交叠；更多资源有明确入口，不把全部文件塞入首屏 |
| 同名 README、同 positionId 不同工作区 | 正确区分身份、路径和来源；A/B 资源不串用 |
| 资源点击和返回 | 单击原位详情；打开文档命中正确文件；返回恢复资源、过滤器、展开路径和视口 |
| 汇报、绑定、包含、协作、使用 | 每种方向、标签和证据一致；无事件时不出现“使用/协作”伪边 |
| 慢/失败来源 | 1 个来源延迟或失败不阻塞其他 Agent 名称与可用来源；失败不显示成 0 项 |
| A→B→A + 请求乱序 | 任意延迟顺序不展示异工作区实体；同作用域旧重试不能覆盖新结果；最终加载状态正确结束 |
| 拖画布、点击节点、缩放 | 无双重平移/缩放、拖后无误点击；若支持节点拖动，坐标在重渲染及返回后保持 |
| 搜索和筛选 | 筛选无结果可恢复；不可见项不残留可聚焦按钮；焦点实体和图例含义一致 |
| 刷新与资源新增/删除 | 局部来源更新，画布不整体跳位；被删除选中项显示明确状态并可返回 |
| 键盘完整任务 | 不使用鼠标完成找 Agent → 来源 → 文件 → 阅读 → 返回；焦点始终可见，无陷阱或克隆入口 |
| 1280×800、1024×768、小窗口与 200% 缩放 | 核心控件可达；图谱与详情可滚动/切换，不被固定高度裁掉 |
| 减少动态效果、中文/英文 | 无强制动画；控件提示与屏幕阅读标签对应当前语言 |

建议性能测试集：小型 20 Agent / 40 来源 / 200 资源；中型 200 Agent / 400 来源 / 10,000 资源；大目录 1,000 Agent / 2,000 来源 / 100,000 资源。后三类实体总数是后端目录规模，**不要求全部同时上屏**。记录可见节点数、边数、响应体大小和缓存冷暖状态。

| 指标 | 建议目标与测量方法 |
| --- | --- |
| 首次可交互摘要 | 参考机本地服务冷读 p95 ≤ 1.5s，暖读 ≤ 500ms；从进入图谱到首屏可搜索/选中计时 |
| 点击反馈 | 选中/局部加载反馈 p95 ≤ 100ms；详情网络完成时间另报，不混为一项 |
| 局部展开 | 25 个资源/一跳结果可见 p95 ≤ 500ms（本地来源）；慢上游 100ms 内先有局部反馈 |
| 画布交互 | 300 可见节点 / 600 边时，平移缩放以 60fps 为目标，95% 帧 ≤ 20ms；记录实际 dropped frames，不以 jsdom 时间代替 |
| 渲染边界 | 默认可见节点预算建议 ≤ 300，超过改集合/分页；仅渲染视口及必要缓冲范围 |
| 全局影响 | 不进入图谱时，无图谱新增全量目录读取；组织纯移动不会全量重扫文件 |
| 请求控制 | 资源展开并发建议 ≤ 4；同键在途请求合并；失败只重试对应页/来源 |
| 搜索 | 索引/缓存命中的首批结果 p95 ≤ 300ms，输入防抖约 150–250ms；后台目录未完整时明确搜索范围 |
| 稳定性 | 20 次切模块/工作区、展开折叠后无持续增长的监听器/挂起请求；堆内存回收后趋势稳定，具体预算在基线后确定 |

## 7. 已验证、未验证与交付拆分

本次运行 `npm run test:renderer -- renderer/test/org-chart.test.tsx`：**15/15 通过，退出码 0**。这是当前单元测试通过，不代表上述交互已验收。现有图谱测试主要断言 builder 节点/边、隐藏 edge probes 的计数和隐藏文档按钮的回调；它没有验证真实可见节点拖动、布局遮挡、浏览器焦点或数据扇出性能。旧 CSS 树的缩放/拖动测试也不能替代 ReactFlow 图谱验收。

本次未启动真实浏览器，未测 FPS、首屏耗时、跨工作区可见闪烁或触控板手感；相应项已经标为待复现/目标。无基准测试数字被当作结果。

建议无论最终选择代码落地还是设计原型，都先交付相同的三项：实体/关系映射表、六条用户任务的状态流、包含错误和局部加载的交互示例。

若选择代码落地：先完成可信关系与数据状态、文档精确导航、稳定局部布局和工作区隔离，再做来源适配、搜索/分页、性能与真实浏览器验收。复用现有文档读取及来源摘要能力，避免建立第二套文档查看器。

若选择设计原型：需要可操作演示“Agent → 来源 → 资源 → 详情 → 阅读 → 返回”“失败来源单项重试”“工作区切换恢复”三条闭环，至少含小/中规模、同名文件、未配置/离线/部分失败样本；所有样本标为演示数据。原型可证明交互意图与信息架构，不能宣称真实权限、持久化、性能或接口已接通。
