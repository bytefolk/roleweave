# RoleWeave 关系探索图谱：开源库选型研究

查询时间：**2026-09-22 15:28–15:34 UTC（北京时间 23:28–23:34）**。Stars、push 和 release 来自实时 GitHub REST API；能力来自项目官方文档、源码许可及维护者说明。本文是技术选型研究，未修改 RoleWeave 仓库，也未做项目性能实测。

## 结论

**建议用 AntV G6 5.x 作为 Agent—数据源—资源关系探索图谱的首选，并用现有 React Flow 做同数据对照验证。** G6 已有关系方向/邻居层数高亮、Combo 分组折叠、多种关系布局和多渲染器，较贴合“看关系、追来源、解释为什么有权限”的业务探索。此判断基于能力匹配，**不是已经证实它在 RoleWeave 比其他库快**。[G6 邻居高亮](https://g6.antv.antgroup.com/en/manual/behavior/hover-activate)、[折叠展开](https://g6.antv.antgroup.com/en/manual/behavior/collapse-expand)、[布局示例](https://g6.antv.antgroup.com/en/examples)

选型需要接受两个成本：G6 最近的公开仓库 push 距查询约 69 天，维护节奏慢于另外三个候选；React 生命周期、键盘关系导航和屏幕阅读器体验需要应用层补齐。若同数据验证不能体现关系探索优势，保留现有 React Flow 更合理。

## 实时热度和维护证据

| 候选 | 实时 stars | 仓库最近 push（UTC） | 查询到的版本/发布时间 | 维护判断 |
| --- | ---: | --- | --- | --- |
| [AntV/G6](https://github.com/antvis/G6) | **12,300** | 2026-07-15 06:02 | [5.1.1](https://github.com/antvis/G6/releases/tag/5.1.1)，2026-04-17 | 未归档；仍有 2026 年更新，但本组近期节奏最慢 |
| [xyflow/xyflow](https://github.com/xyflow/xyflow) | **38,471** | 2026-09-22 13:56 | [@xyflow/react@12.11.6](https://github.com/xyflow/xyflow/releases/tag/%40xyflow/react%4012.11.6)，2026-09-01 | 未归档；当日有 push，近期有 React 包发布 |
| [cytoscape/cytoscape.js](https://github.com/cytoscape/cytoscape.js) | **11,221** | 2026-09-16 14:47 | [v3.34.3](https://github.com/cytoscape/cytoscape.js/releases/tag/v3.34.3)，2026-09-07 | 未归档；近期 push 和稳定版发布均有证据 |
| [jacomyal/sigma.js](https://github.com/jacomyal/sigma.js) | **12,169** | 2026-09-16 09:47 | [稳定版 3.0.3](https://github.com/jacomyal/sigma.js/releases/tag/sigma%403.0.3)，2026-04-30；[4.0.0-beta.6](https://github.com/jacomyal/sigma.js/releases/tag/sigma%404.0.0-beta.6)，2026-09-16 | 未归档；近期工作集中于 v4 预发布，不能把 v4 能力直接计入稳定 v3 |

数据接口：[G6](https://api.github.com/repos/antvis/G6)、[xyflow](https://api.github.com/repos/xyflow/xyflow)、[Cytoscape.js](https://api.github.com/repos/cytoscape/cytoscape.js)、[Sigma.js](https://api.github.com/repos/jacomyal/sigma.js)。采集字段为 `stargazers_count`、`pushed_at`、`archived`，版本来自各仓库 `releases`。

说明：xyflow 的 stars 是包含 React Flow 和 Svelte Flow 的整个仓库数字，并非 React 包独立数字；`pushed_at` 是仓库 push 时间，不等同于最后稳定发布或维护者响应 SLA；stars 也不能证明渲染速度。Sigma v4 beta release 的 GitHub `prerelease` 字段实际为 false，但 tag 含 beta，官方站点也明确区分 v3 和 v4 预发布，本文按版本语义处理。[Sigma v3 官方入口](https://www.sigmajs.org/)、[v4 入口](https://v4.sigmajs.org/)

## 能力比较

| 维度 | AntV G6 | React Flow / @xyflow/react | Cytoscape.js | Sigma.js 稳定 v3 |
| --- | --- | --- | --- | --- |
| 核心定位 | 图可视化和关系交互，适合异构业务图 | React 节点式 UI、流程和交互编辑；也能做关系图 | 图论分析与网络可视化 | 大型网络的显示与探索 |
| 渲染 | 默认 Canvas，可切换 SVG/WebGL，可按层组合 | HTML/React 节点与 SVG 边，DOM/CSS 定制便利 | 默认 Canvas；另有 WebGL 预览模式 | 节点/边 WebGL；v3 标签和悬停绘制仍含 Canvas 层 |
| React 接入 | 用 effect/ref 管理 Graph 创建、更新、销毁；官方另有 ReactNode 扩展 | 原生 React 组件、hooks 与状态管理；当前方案迁移成本最低 | 框架无关；官方文档列出 react-cytoscapejs 等包装，或自己管理实例 | 官方推荐生态包装 @react-sigma，图数据使用 Graphology |
| 布局 | Force、D3 Force、ForceAtlas2、Dagre、Radial、Combo 等；有 Worker/GPU 示例 | 自身没有自动布局引擎；接 Dagre、D3 Force、ELK 等 | 多种内置布局，扩展生态支持更多布局；图查询和分析较强 | 布局由 Graphology 等负责；ForceAtlas2 支持 Worker |
| 邻居/过滤 | degree 与方向高亮；状态、过滤和业务扩展可组合 | 可用图工具函数，但邻域交互、过滤与状态组合由应用组织 | selectors、集合、邻域和路径算法适合探索分析 | Graphology 负责邻域/算法，Sigma 负责交互和视觉状态 |
| 分组/展开 | Combo 与树节点折叠原语较直接 | 子流程/分组支持，自动布局与复杂展开需自己集成 | compound nodes 与扩展适合复合图，仍需设计展开策略 | 业务分组、折叠和局部展开需要应用层组织 |
| 主要代价 | 版本/扩展兼容、实例生命周期和应用级无障碍 | 复杂节点 DOM 成本、频繁 React 重渲染、布局及探索逻辑自建 | 业务卡片和 DOM 控件集成不如 React Flow 直接；WebGL 有样式限制 | 丰富节点/边视觉更难定制，领域交互与无障碍工作较多 |

渲染和集成依据：[G6 渲染器](https://g6.antv.antgroup.com/en/manual/further-reading/renderer)、[G6 React 集成](https://g6.antv.antgroup.com/manual/getting-started/integration/react)、[ReactNode](https://g6.antv.antgroup.com/en/manual/element/node/react-node)、[React Flow 样式与 SVG 元素](https://reactflow.dev/learn/customization/theming)、[React Flow 布局说明](https://reactflow.dev/learn/layouting/layouting)、[Cytoscape.js 文档](https://js.cytoscape.org/)、[Sigma 渲染器](https://www.sigmajs.org/docs/advanced/renderers/)、[Sigma v3 渲染架构说明](https://www.sigmajs.org/docs/advanced/migration-v2-v3/)、[Graphology ForceAtlas2 Worker](https://graphology.github.io/standard-library/layout-forceatlas2.html)、[React Sigma](https://sim51.github.io/react-sigma/)。

**四个库都不提供 RoleWeave 的本体、来源证据或权限裁决。** 它们能画关系、响应交互；关系是否存在、是否可见、来自哪次采集、哪个授权规则允许访问，必须由领域模型和服务端提供。把邻居节点展开到画布，也不等于库已经实现了后端分页、权限过滤或证据链查询。

## “丝滑”有哪些已知证据

| 候选 | 官方证据 | 对本项目能得出的结论 |
| --- | --- | --- |
| G6 | 官方支持多渲染器；部分布局可使用独立加速包，示例包含 Worker/GPU | 有优化手段；没有查到可与另外三者在同硬件、同图和同视觉样式下直接比较的官方基准，不能宣称某节点数必定 60 FPS |
| React Flow | 官方明确频繁状态更新/重渲染、复杂 CSS 会影响性能，建议 memo、拆分订阅、折叠节点、简化样式 | 当前实现能否流畅，取决于可见节点和组件成本；不能把 DOM 路线直接判定为一定慢，也没有通用硬上限 |
| Cytoscape.js | 2025-01-13 官方 WebGL 预览文章：M1 MacBook Pro / Chrome，约 1,200 节点、16,000 边从 Canvas 约 20 FPS 到 WebGL 超过 100 FPS；另一组约 3,200 节点、68,000 边为约 3→10 FPS | 这是旧版预览的作者实验，不是本项目实测；同一技术在不同密度下差异显著。官方同时列出边样式等限制 |
| Sigma v3 | 官方定位为数千节点/边的 WebGL 网络可视化，说明更大图和自定义渲染复杂度之间的取舍 | 值得作为“大量可见元素”的替代；没有证据可承诺 RoleWeave 的业务卡片、中文长标签和多种关系边同样流畅 |

来源：[G6 5.0 性能相关能力](https://g6.antv.antgroup.com/en/manual/whats-new/feature)、[React Flow 性能指南](https://reactflow.dev/learn/advanced-use/performance)、[Cytoscape WebGL 官方实验及限制](https://blog.js.cytoscape.org/2025/01/13/webgl-preview/)、[Cytoscape 性能指南](https://js.cytoscape.org/#performance)、[Sigma 官方 FAQ](https://www.sigmajs.org/)。Cytoscape 当前 API 首页未给出解除 WebGL 预览限制的明确声明，本研究保守把它作为须单独验证的模式，不把默认 Canvas 能力和 WebGL 能力混为一谈。

## 可访问性和商业使用

**React Flow 的已文档化默认无障碍能力最好：**节点/边可聚焦，Tab、Enter/Space、Escape、方向键、聚焦时自动平移、ARIA 说明和文案本地化均有官方接口。自定义节点仍需检查焦点顺序、按钮语义和读屏效果，库能力不等于整个应用自动合规。[React Flow Accessibility](https://reactflow.dev/learn/advanced-use/accessibility)

G6 底层 G 项目有 `g-plugin-a11y`，但这不代表 G6 已默认提供与 React Flow 等价的业务关系键盘导航；需要验证与所选渲染器、ReactNode 的组合。Cytoscape 维护者明确把图探索的 Tab 顺序、焦点目标等视为应用级设计。对 G6 和 Sigma，本次查阅的核心文档没有找到足以承诺默认读屏/完整键盘关系导航的证据。[AntV G 插件列表](https://github.com/antvis/G)、[Cytoscape 维护者关于无障碍的说明](https://github.com/cytoscape/cytoscape.js/discussions/3125)

因此无论选择哪个库，建议同步提供“关系列表/表格”入口：搜索节点、按关系类型和方向筛选、展开邻居、打开来源和权限说明全部可用键盘完成；图中选择与列表焦点联动，并支持减少动画。这是本项目建议，不是已实现功能。

四个核心项目均为 **MIT**，许可允许使用、修改、分发和商业销售，分发副本或实质部分时需保留版权及许可声明；不要求把 RoleWeave 的业务代码开源。需分别核对另引入的布局包、React wrapper、图标/字体和示例素材许可，不能从主库 MIT 推导整个组合都同许可。[G6 LICENSE](https://raw.githubusercontent.com/antvis/G6/v5/LICENSE)、[xyflow LICENSE](https://raw.githubusercontent.com/xyflow/xyflow/main/LICENSE)、[Cytoscape LICENSE](https://raw.githubusercontent.com/cytoscape/cytoscape.js/unstable/LICENSE)、[Sigma LICENSE](https://raw.githubusercontent.com/jacomyal/sigma.js/main/LICENSE.txt)

React Flow 核心 MIT 与其 Pro 付费示例/支持是两件事；商业项目使用核心库无需订阅，若要复制 Pro 示例或模板则按对应订阅条款处理。不能把“某能力的官方示例标为 Pro”理解成“该能力只能付费实现”。[React Flow Pro 官方说明](https://reactflow.dev/pro)

## 针对 RoleWeave 的落地建议和替代条件

首选方案是 **G6 5.x + React 外围界面 + 独立领域图模型**。主图优先使用轻量图形节点，完整表单、权限规则和来源材料放在侧栏，避免让每个节点都成为复杂 React 卡片。先按 `Agent`、`DataSource`、`Resource` 建立稳定 ID 和类型，再区分“可访问”“实际使用”“来源于”“拥有/维护”等有方向的关系。`permissionEvidence`、`provenance`、时间和原始记录引用由服务端返回；画布仅投影已授权子图。

推荐的探索路径是：搜索/选中一个实体 → 展示一跳邻居 → 按类型和方向过滤 → 分页扩展 → 选边解释来源和权限依据。展开时尽量保留已有节点坐标、选中态和视口，不因每次取到新数据而全图重排。不要把 Combo 的树式折叠直接当成任意多对多关系的后端展开协议。

| 改选条件 | 替代方案 |
| --- | --- |
| 现有 React Flow 经同数据验证已满足体验，首版侧重少量可见实体和丰富卡片，或键盘/读屏为最紧约束 | **继续 React Flow**；补本体、邻域接口、布局和焦点模型即可，避免无收益迁移 |
| 核心需求变为路径分析、子图查询、图算法、复杂 compound 图，且不依赖大量节点内 DOM 控件 | **Cytoscape.js**；优先验证稳定 Canvas 路线，WebGL 单独验样式和性能 |
| 真实工作集要求同时显示很大的网络，节点视觉可以简化，且 G6 经优化仍达不到交互目标 | **Sigma 3.x + Graphology**；v4 beta 另做实验，不能直接继承 v3 的稳定性判断 |

**建议验收目标，不是已测结果：**同一套授权数据、同一硬件、同一 Electron/Chromium 版本，以 300 节点/1,000 边和 1,000 节点/5,000 边作为对照夹具，加入中文长标签、多个数据源分组、同一资源的多条权限/来源边。比较首次可交互时间、拖拽/缩放帧间隔 p95、点击到反馈 p95、一次邻居扩展后的布局稳定性、长任务和内存。可先将持续拖拽 p95 帧间隔 ≤20ms、点击反馈 p95 ≤100ms 作为待确认目标；任何数量都只是验证场景，不是库性能上限。

若实际需要 5,000 节点/20,000 边同屏，再增加压力夹具及 Sigma 对照，而不是把首次页面默认做成全量关系网。除视觉外，必须验证：过滤不暴露无权节点及数量、来源材料能打开、权限解释能回指实际规则、撤销/失效关系不会被旧缓存继续呈现、键盘可完成同样的探索任务。
