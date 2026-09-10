# Changelog

本仓库采用 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式。
早期开发记录以里程碑（D0/D1/D2…）标注，安装包发布使用语义化版本。

## [0.1.2] — 2026-09-10

### Changed

- #214：同一会话的后续回合可携带有界、脱敏的可信历史，并展示实际注入摘要、数量、字节数和 digest；上下文开关按会话持久化。
- #214：不同员工可同时处理任务；群聊支持显式并行和有序接力，前序失败时停止后续执行并保留可查询的状态。
- Rewrote the README in English with customer onboarding, desktop downloads, AI integration guidance, and source development instructions.

### Fixed

- GitHub Release 正文从冻结发布提交中的同版本说明文件自动载入；缺失、空白、版本不符或传输后改变的说明会在创建草稿前被拒绝，说明文件不会混入安装包资产。
- #170：工作区自动打开的失败诊断保持 best-effort；即使 stderr 不可写也不会把启动变成失败，并补充 main.js 调用边界回归覆盖。
- #215 review：群历史和接力结果先脱敏后截断；落盘失败释放运行标记，坏历史来源与失败事件订阅者不再连带中断其他成员。
- #215 review：取消绑定原工作区及已知回合；个人与群组执行共同阻止会话轮换和上下文策略变更，前端按工作区、岗位、引擎隔离事件。
- #215 review：补足最大群消息的持久化空间，接力只保留有界结果，恢复记录保留原接受时间并保证并发恢复幂等。
- #155：Windows 目录 fsync 的 EPERM 判断收回唯一的原子写入口（context export 不再自带第二份），裸 errno 通过 `cause` 穿过 groups/assets/sessions/turns 各自的存储错误包装；平台改为可注入后，这批回归在 POSIX runner 上真正执行而不是 skip。

## [0.1.1] — 2026-09-08

### Changed

- 产品与仓库统一为 RoleWeave / `bytefolk/roleweave`，使用带透明安全边距的 R/W 应用图标。
- 岗位文档采用左右分栏阅读，组织共享文档对接 `bytefolk/doc` v1 API；访问凭据仅留在服务端。
- 优化项目切换、员工创建、群聊成员搜索以及记忆来源展示。

### Fixed

- 修复 macOS 发布时误拒绝签名更新清单的问题，发布前校验清单签名、版本及 ZIP 大小和哈希。
- 安装包文件名、GitHub 发布坐标与 macOS 签名更新清单统一使用 `roleweave`，避免更新器寻找旧名称安装包。
- 保留旧环境变量、工作区数据迁移和应用 ID；旧开发包需手动安装新版一次，不放宽更新信任校验。

## [Unreleased] — D2 组织操作 + D3 对话控制面 + D4 本地上报

### Changed

- #206：RoleWeave 内置引擎新增 Codex 服务凭据与本地登录两种 Agent Host；本地登录不依赖服务 API key。
- 以 RoleWeave 标识的紫蓝色建立 light / dark 双主题，逐组件统一组织、会话、群聊、招聘、文档、网盘、报表、审批和设置；简化嵌套卡片与装饰标签，改善正文、长路径、超限数值及暗色表单的可读性，保留业务行为。
- 会话使用可折叠的执行状态行与连续正文：运行时展开公开里程碑并显示真实耗时，结束时默认收起，手动开合不受流式输出刷新影响；审批与错误保持可见，不推断工具次数，缺失的时间不补零。

含 PR #3（feat(d1): 组织树只读）与 PR #7（fix(examples)）。

### Fixed

- #221 review：Codex 就绪状态要求内置引擎边界；使用外部 digital-employee CLI 时，即使已安装 Codex 并配置凭据，两种 Codex Host 仍显示不可用并说明原因。
- #135：新增免费 macOS GitHub 自动更新通道：发布 workflow 使用 `OWB_UPDATE_SIGNING_PRIVATE_KEY` 为 ZIP 元数据生成 Ed25519 签名，客户端校验后后台下载，并在正常退出时自动替换、重启；应用本身仍为 unsigned，Gatekeeper/Developer ID 方案保留为后续切换路径。

### Added
### Added

- #127 AC-004 跨平台布局一致性证据：新增 layout smoke 模式（macOS arm64 / Windows x64 双平台，全应用渲染两栏组织工作区并由 main 进程度量列矩形写报告），verify.yml 新增 layout-parity job 下载双平台报告比对（per-platform bottomDelta ≤2px、per-platform 两列高差 ≤2px、跨平台宽差 ≤4px、跨平台 chrome overhead 差 ≤8px，阈值声明在 scripts/check-layout-parity.mjs）。跨平台一项自 #190 起比的是 chrome overhead（`viewport.innerHeight - 列高`）而非绝对列高：runner 给两侧的窗口高度本就不同，比绝对高度量到的是 runner 而不是布局，#190 之前的「高差 ≤8px」写法已随之作废。顺带修 #150 打包缺口：doc-plane.js 未登记 SERVER_RUNTIME_FILES 导致打包 server 启动即崩、main CI 红。
### Added

- #146 国际化骨架与全量迁移：`@org-workbench/ui` 新增 `OwbI18nProvider` / `useT` / `zhText` 与 zh-CN/en 双目录（440 key，parity 门强制 key 集合一致）；标题栏新增语言切换钮（恰好两态，持久化，默认 zh-CN，antd ConfigProvider locale 同步切换）；renderer 与 ui 包全部用户可见文案迁入目录，`i18n-cjk-gate` 测试扫描源码字符串字面量内的 CJK 防绕过；数据层（turn 原文、信封、组织文件、裁决输入）不翻译。

- #167 组织图画布化收尾：视口 overflow:hidden 零滚动条，平移纯拖拽（transform translate + pointer capture，4px 点击阈值保留），缩放（按钮/捏合）以光标为锚；选中岗位 translate 居中替代 scrollIntoView；布局不再随滚动条跳动。描述语精简到标题：图表头部只留标题、空态只留标题行、composer 空闲提示行移除（运行态/禁用原因保留）。

- 上下文来源与统一网盘入口：岗位卡片展示岗位知识库、mem 统一网盘和岗位级 context 来源；新增 Workbench 内网盘模块，支持清单、搜索与详情查看，不引入 Obsidian 客户端。
- #132：新增 macOS arm64 DMG/ZIP 与 Windows x64 NSIS 安装包构建；保持无签名、Windows per-user 和 `--publish never`。安装/启动/卸载行为验证仍待后续切片。
- **D2 目录提案编排**：招聘直接生成嵌套岗位包与 0600 原子写 `budget.json`，调岗整目录 rename，裁撤移至树外 `.digital-employee/backup/<id>-<stamp>/`；支持移至根和 `maxDepth=8` 防御上限。
- **引擎 org-audit 报告流**：`GET /reports` 改读 `.digital-employee/org-audit.jsonl`（org-audit.v1）。
- **真实引擎契约测试**：覆盖 workspace 参数、严格 status/payload 解析、拒绝时应用态字节零变更与提案保留。

- **`packages/ui` 组件包**：OrgTree / OrgTreeNode / PositionCard / BudgetBar 四组件，消费 design-system 语义 token；OrgTree 支持键盘树导航（↑↓ 移动、←→ 折叠展开）。
- **React/Vite 渲染层**：桌面壳 renderer 重写为 AppShell 四区布局（Sidebar 288px / 主区 / 岗位卡片 / 预算条），SSE `org.updated` 驱动自动刷新。
- **冻结契约类型**：`packages/shared/src/org-tree.ts` 提供 org-tree.v1 类型与运行时守卫。
- **workspace-state**：服务端工作区状态管理，`/org/tree` 返回冻结形状快照。
- 测试：ui 14 用例（vitest）+ server 侧 workspace/apply 断言扩展。
- D3 `POST /turns` / `GET /turns?positionId=...` 控制面，只允许 Qoder 与 Claude Code；密封 `turn-envelope.v1`、严格 `engine.v1` NDJSON、turn SSE 与退出码 1 不自动重试。
- 工作区本地 `turn-record.v1` / `turn-history.v1`：0600 原子文件、0700 目录、崩溃遗留 running 回合恢复为 indeterminate，拒绝符号链接与无界历史。
- D3 `@岗位` 对话面板：组织树与岗位选择器联动，本地历史加载、回合发送与服务端 readback、Host idle 禁用、API 失败保留输入、信封 digest 展示；委派链与长期 Context 继续诚实标记为 Planned。
- `/health` 增加 Qoder/Claude Code 各自的 `configured` / `ready` / `nextStep` 本地预检，仅返回布尔值和非敏感操作提示；bundled `qoder-engine` 以本地 Qoder 1.1.x 的有界版本探针作为前置，普通 `digital-employee` 仍保持 service-token 门禁。renderer 不读取凭据，也不从引擎可达性推断远端 Host entitlement。
- D2 工作台交互：组织树拖拽只生成 move 清单；招聘弹窗强制声明 token 预算；裁撤二次确认；`.digital-employee/backup` 恢复区支持显式幂等恢复和冲突保护。
- D4 上报中心：从真实 org-audit 和本地 turn record 派生脱敏证据、失败/不确定升级链及已记录预算用量；空状态与损坏数据均 fail closed，不显示原始输入/输出。
- 枚举式 `orgBackups` / `orgRestore` / `reports` IPC 与恢复 ID 边界验证；renderer 仍无通用请求或文件写能力。
- org-workbench #12 R2 显式 session：`workbench-session.v1`、create/list/get/rotate/session-turn API，server-owned principal/workspace mapping、每岗位单 active、多 session 只读历史和 zero-history-copy successor。
- Desktop 枚举式 session IPC 与岗位会话选择器：显式新建/轮换、旧 session 只读切换、session-scoped turn/readback；不暴露 boot token、绝对路径或 mem/context 能力。
- Session 持久化安全门禁：0700/0600、单文件原子 rotate、并发双 rotate 幂等、running-turn conflict、重启恢复、symlink/路径/损坏/错 workspace/无界状态 fail closed。
- org-workbench #15 R1 Context exporter：可信 session `completed` 回合落盘后异步生成两条 scoped `context-occurrence.v1`，持久 `pending|done|failed` 与跨重启幂等恢复；固定消费 `context@f63f57f` 公共 CLI/stdio adapter，失败不重跑 Host。
- Context exporter E3：真实临时 SQLite vault 通过 provider grant → ingest/distill → recall/readback 验证两条 raw occurrence，另覆盖 partial replay、wrong scope、revoked token、adapter outage、symlink/corrupt state 与 failed/indeterminate 不导出。
- #32 组织树真实拖拽：body 投放生成 move 提案，上/下四分位插入线生成同级排序（`change-manifest.v1` 新增 `reorder` op，跨级插入以 move+reorder 单清单原子提交）；投放到自身/下属 dropEffect=none 拒绝并轻提示；⌘↑/⌘↓ 同级排序、⌘←/⌘→ 调级，企业负责人拦截提示。
- #32 排序持久化：`org-layout.v1` 覆盖层（`.digital-employee/org-layout.v1.json`，0600 原子写，零迁移、引擎不触），reorder-only 清单不调引擎；快照同级顺序覆盖层优先、字母序兜底，open/reload 时自动修剪与补齐。
- #32 单步撤销：`POST /org/undo` 回放 inverseMoves 并还原覆盖层（404 `not_found` 表示无可撤销）；renderer「撤销」按钮与树聚焦时 ⌘/Ctrl+Z。
- #32 创建入口：组织树行 hover「+」与空态按钮打开招聘弹窗并预置汇报对象。
- #73 Control Plane v2：组织树连接线（guide-rail，选中即递推点亮祖先链路）、岗位状态灯（仅映射真实在途回合）、42×6px 微型预算条；对话面板改证据时间线（`.owb-tc` 控制台卡：状态圆点/状态行/证据印章 chip/内嵌审批卡），群聊仍保留气泡布局。
- #73 无边框窗口自定义标题栏：`owb:window:minimize` / `owb:window:toggle-maximize` / `owb:window:close` 三个枚举式 IPC；每个 handler 均校验 `event.senderFrame` 是 mainWindow 自身主 frame 且仍在展示打包渲染层（`window-ipc.cjs` 纯函数 + 6 条负向单测），并对 mainWindow 加 `will-navigate`/`setWindowOpenHandler` 拦截，拒绝导航到打包文件之外的任何地址与新窗口。
- `apps/desktop/test/contrast.test.cjs`：对 `--ui-foreground-subtle` 在亮/暗两套主题的全部 5 个背景阶做真实 WCAG 对比度计算断言（≥4.5:1），而非仅检查 token 字符串存在。
- #94 主题切换入口：自定义标题栏新增亮/暗切换按钮（`aria-pressed` + 目标态 `title`/`aria-label`），`theme-mode.ts` 提供唯一的 `data-theme` 写入路径与 `localStorage` 持久化，`main.tsx` 在 `createRoot()` 前种子化。未显式选择过时跟随系统 `prefers-color-scheme`（含运行时变化），首次点击即固化为显式选择并停止跟随。`antd-skin.css` 的暗色调色板与 antd `darkAlgorithm`/`ANTD_SEED.dark` 自 #73 起已完备，此前只是无人可达。
- #110 Lane A：新增 macOS arm64 / Windows x64 原生无产品签名的 unpacked staging、逐文件字节精确的运行时 inventory/拒绝清单、架构与签名状态核验，以及从源码树外 clean staging 启动后证明静态 renderer、控制面 ready 和严格 process-ownership 边界归零的 smoke；command/staging path 不授予 signal 权限。只扩展只读验证工作流，不含安装器、分发签名、发布或自动更新。#111 的 Finder PATH → Qoder/MCP fixture → turn/history 行为资格验证保留为独立 macOS-only command/schema，不与 static smoke 混称。Windows 原生结果已由 `windows-latest` 在 head `59b7eaf` 实际运行验证（run 33601662786：package / verify / smoke 全绿，verifier 报告 33 required entries、189 packaged files、`authenticode-not-signed`）；该结果不外推到安装包、签名与自动更新路径，Windows 上的 Qoder 残留断言按构造未被执行，见 #131。并入 #122 中未被本分支取代的部分：Windows 下 `.bat`/`.cmd` 启动脚本的 shell 路由（Node 因 CVE-2024-27980 加固拒绝无 shell 执行，缺此项打包后的 Windows 应用无法启动 Qoder）、Qoder 子进程环境补入 `PATHEXT`/`ComSpec`/`SystemRoot`/`WINDIR`，以及测试可移植性辅助（NTFS 合成权限位改用 `assertPosixMode` 跳过、exec `#!/bin/sh` fixture 的用例在 win32 跳过）。曾一并并入的 `windows-latest` check 矩阵腿**已撤回** —— 该套件按 POSIX 进程与文件系统语义编写，在 Windows 上跑 `npm run check` 挂起逾一小时且无有界失败可定位；Windows 改由专门的 staging package/verify/smoke 腿覆盖（与 cc-haha 同形：其全部质量 job 均在 ubuntu 上，Windows 只跑针对性检查）。撤回时保留了这次尝试的两项产物：所有 `node --test` 的 `--test-timeout` 上限与 check job 的 `timeout-minutes`；#122 的打包面（两条目 `WIN_APP_REQUIRED_ENTRIES`、`signAndEditExecutable`、重复的 package-windows job）已被本分支取代而未并入。

### Changed

- #35 文档模块视觉整理：增加岗位文档上下文、文件类型与大小信息，优化文件选择/复制引用/解析引用的层级，并补齐加载、空状态、错误状态及窄窗口适配；文档引用契约与读写行为不变。
- **D4 上报中心视觉层级**：首屏优先展示有事实的数据流，预算快照集中呈现单任务/单日指标并提供成本看板入口；同时补齐只读边界提示、空态容器、选项卡语义和窄窗响应式布局。
- GitHub repository and raw-content coordinates now target the `bytefolk` organization while the published `@fullstack-ai-infra/*` npm scope and desktop application ID remain unchanged.
- `DigitalEmployeeCliDriver` 调用翻转为 `digital-employee org apply <workspace> --json`；成功后控制面从 `.digital-employee/org.json` 重载应用态，`org.updated.updatedAt` 与引擎时间戳对齐。
- oss-maintainer 示例改为目录表达汇报线的嵌套布局，并为每个岗位增加 `budget.json`。
- 桌面壳 IPC 白名单新增渲染层所需通道（preload）。
- 桌面壳新增枚举式 `createTurn` / `turnHistory` IPC；没有通用 HTTP/IPC 请求入口，boot token 继续只留在 main process。
- README：状态更新为 "D0 骨架 + D1 组织树只读"，补充 design-system 开发期 `file:` 链接说明（同级克隆 + `npm run build:package`）。
- #73 token 层：暖纸画布/圆角 6·10·14·18/动效三档 120·160·240ms 统一（含 design-system 原生 duration/ease 一并收敛）；新增 Space Grotesk 展示字体 + JetBrains Mono；PositionCard 从 antd Card 改造为自定义 `owb-panel`。
- BrowserWindow `minWidth` 980→640：原值使 `@media (max-width:680px)` 断点（侧栏隐藏、单栏堆叠）在真实窗口不可达，只能靠 DevTools 视口模拟验证，现在拖窗边缘就能触发。

### Removed

- 旧 staging/rejected/applied 发布机制、客户端 `apply-log.ndjson` 写入和 `archive/` 裁撤路径。
- 旧原生 renderer（app.js / index.html / style.css）。

### Fixed

- #194（Refs #127 AC-004、#190、#180）layout-parity job 在同一份代码上非确定性变红：run 33781690234（`d89ceb5`）macOS 列高 565px、chrome overhead 116px 通过；run 33782374969 第二次尝试（`fbff520`）同一平台量到 515px、overhead 166px，跨平台 overhead 差 50px 而失败；对同一 commit 做完整重跑（第三次尝试）又回到 565px / 116px 通过。`d89ceb5` 与 `fbff520` 共享同一 tree `23443b161487417bd0228852f1f70d66c28597ba`，即渲染层与样式完全相同——变的是量测时机，不是布局。Windows 侧 604px、两侧列宽 314px、`bottomDelta` 0、viewport（mac 1024×681 / win 1024×720）在全部三次采样中恒定，失败那次报告自身仍是 `ok: true`。根因：`LAYOUT_MEASURE_SCRIPT` 只轮询两栏**是否出现**，出现的那一瞬间就量一次；presence 不等于 settled geometry，webfont swap 会在两栏首次出现之后再次回流列高，而脚本既没有 `await document.fonts.ready`，也没有 rAF 或任何收敛条件，于是量到的是 runner 那一刻恰好看到的中间态。修复分两半：① 量测端在挂载轮询之后先 best-effort 等 `document.fonts.ready`（reject 不得让一次本来正常的量测失败），再按最多 60 个采样点取样，直到连续 3 次采样间五个字段的最大漂移 ≤0.5px 才判定 settled，并把 `settled` 写进报告；每次迭代用 `requestAnimationFrame` 与 50ms 定时器**互相 race**，因此 CI runner 上一个被遮挡、始终没有合成的窗口不会把脚本挂到预算之外。② 校验端 `readLayout` 拒绝 `settled !== true` 的报告——与 #190 拒绝无 viewport 同理，refused 而非 compared：一份没收敛的量测是"那个 runner 何时看了一眼"的样本，两份这样的样本比的是两个任意时刻。该检查排在 viewport 检查之后，因此两者都缺的报告仍然报更旧、更具体的那条缺失。**四条阈值（bottomDelta ≤2px、两列高差 ≤2px、跨平台宽差 ≤4px、跨平台 chrome overhead 差 ≤8px）未被触碰**：settle 预算只决定何时停止等待，从不决定什么算一致；0.5px epsilon 落在全部四条阈值之内，遮蔽不了真实失配，并有专门用例锁定"已 settled 但确实失配的报告照旧失败"。`schemaVersion` 保持 `org-workbench-layout-smoke.v1` 不变（#190 新增的 viewport 也是在 `.v1` 下成为必需字段的，且无代码校验该串）。排障坑：对 layout-parity 用 `gh run rerun --failed` 是 no-op——它只会重新下载同一批缓存 artifact，只有完整重跑 workflow 才会重新量测，本次诊断因此白跑了两次。测试：校验端新增 5 例（拒绝未收敛、拒绝 #194 之前的旧报告而非默认其已收敛、错误信息点名未收敛的那一侧、两者皆缺时的检查次序、settle 门不遮蔽真实失配），量测端新增 4 例——在 vm 里以 stub DOM **实际执行**注入脚本，因为 #183 那道守卫只解析脚本不运行它，此前没有任何测试能证明渲染端真的产出 `settled`；一个仍返回 #194 之前形状的渲染端不会让任何单元测试失败，只会让 parity job 在 CI 上永久变红。两半都做了 mutation 验证（把渲染端改成恒报 settled、把校验端的拒绝短路，各自只有预期的用例失败）。同时修正本文件 #127 AC-004 条目中自 #190 起就已作废的「跨平台高差 ≤8px」表述。
- #156：WSL 拓扑下桌面壳向控制面服务端发送工作区路径时，Windows 盘符路径（`C:\...`）现在经 `serverPathForWorkspace` 转换为 `/mnt/c/...` 再 POST 到 `/workspace/open`；native 模式与非 win32 主机原样不动。`main.js` 全部四处 POST（`ORG_WORKBENCH_DEFAULT_WORKSPACE`、#145 的持久化上次工作区、demo 兜底、目录选择器 IPC）都已接线；转换只发生在跨边界的这一处，服务端因此不必解析盘符，仍只接受自身原生绝对路径——`wsl` 模式下跑在 ext4 上、根本没有 Windows 表示的工作区照旧可用（AC-003）。持久化刻意不转换：`last-workspace.json` 存原始 Windows 路径，因为开机重开时的 `fs.existsSync` 在 Windows 侧执行，`/mnt/c/...` 在那里永远解析不到（AC-005 的可执行形式）。`openDefaultWorkspace` 的 `existsSync` 早退与 HTTP 非 200 响应均写 stderr（含当前 mode 与原始 dir），不再静默丢弃（AC-006）。新增源码接线断言：`main.js` 中每处 `/workspace/open` POST 必须经过 `serverPathForWorkspace`，后续再加站点会被同一条测试拦住（AC-004）。
- 审批中心现在明确说明用途与数据接入状态；未接入回合历史/事件流时不再把空列表误报为“所有回合都在界内运行”，并提供返回组织模块的入口。审批岗位、动作描述与目标中的多层 Unicode 转义也会在展示层恢复为可读中文。
- #137 组织页主区重构为两列工作区：左列上下堆叠组织图与岗位档案（同宽对齐），右列由本地对话面板独占整列高度，回合流拿回被全宽组织图压掉的纵向空间。`.owb-workspace-grid` 包装层移除，布局单源挂在 `.owb-org-module`（grid 两列 + `__left` flex 列）；组织图在半宽左列内横向溢出改为列内滚动（`overflow-x: auto`），纵向仍自然撑开；980px 单栏堆叠与 720px 竖向压缩断点按新选择器等价重述。`org-panel-sizing` / `panel-parity` 两套 CSS 契约测试同步换选择器，并新增 #137 左列配对断言（chart flex none + 档案卡 flex 1 + 模块级 stretch）。契约面未触碰。

- #128 桌面本地对话模块 UX 收敛：① 导轨「记忆」项曾无 `onSelect` 也无渲染分支，用户点击后毫无反馈；在 mem plane 未接入桌面前，直接从导轨移除该假入口而非保留占位（AC-004）。② 对话文本框 `onKeyDown` 现在识别 `nativeEvent.isComposing` 与 legacy `keyCode === 229`，中文候选窗提交 Enter 时即便手指还在 ⌘/Ctrl 上，也不会误发送回合；提示条 `⌘↵ 发送` 与非组合期行为保持不变（AC-003）。③ `TurnThread` 空态首行不再固定读作「从一个明确任务开始」，改由 caller 传入 `emptyPrompt`，`TurnPanel` 将其绑定到 `disabledReason`，因此空态与下方 composer 提示不再互相打脸（AC-002）。④ 新增 vitest 用例锁定：树点岗位→对话面板 combobox 同步、IME 组合期 ⌘↵ 不发送、空态口径与 disabledReason 一致（AC-001/002/003）。契约不变（`turn-envelope.v1` / `workbench-session.v1` 未触碰），后端 D3 主链路仍是 `smoke:package:macos` 的既有绿证。
- #127 桌面主区双面板视觉一致性：① 单源化 `.owb-workspace-grid` 与 `.owb-workspace-grid > .owb-turn-panel`——之前它们分别在两个块里被声明为 `align-items: start` + `height: calc(100vh - 116px)` 与 `align-items: stretch` + `height: auto`，级联胜出的是后者，但早期声明作为死代码留在 stylesheet 里，混淆了 cascade 追踪；现在删除早期块，layout 意图只在"主区：14px padding + 两栏"处单点定义（AC-001）。② `.owb-position-column` 由 `align-self: start` 改为 `align-self: stretch`，让岗位档案卡与本地对话面板真正等高，而不是空态时明显矮一截（AC-001）。③ 新增 `apps/desktop/test/panel-parity.test.cjs`——用 postcss AST 断言两条顶层规则各自唯一、位置列 stretch、`@media (max-width: 980px)` 单栏堆叠保住 380px 最小高度、`@media (max-height: 720px)` 竖向压缩降为 0 转由内滚（AC-001/002）。契约面未触碰。AC-003（对话文本框中文 IME `⌘↵` 抑制）已在 #128 落地；AC-004（Windows 视觉一致性证据）继续挂在 #122 后。
- #120: the Org page's lower-left position region read materially smaller than the adjacent local-conversation panel. Two declarations caused it independently: `.owb-workspace-grid` still sized its tracks `minmax(300px, .92fr) minmax(360px, 1.14fr)`, so the left column was permanently a step narrower — and because the two px floors were unequal, they, not the `fr` ratio, decided the width wherever the grid ran out of room (300px vs 360px at 981px) — while #98's `align-self: start` + `grid-template-rows: auto auto` made it shorter as well. Above the 980px breakpoint the two regions are now one equal pair: both tracks are `minmax(0, 1fr)` with `min-width: 0` on the items, and the column stretches to the row again, with the card taking the column's remaining height, `.owb-pos-body` growing and scrolling, and the 裁撤 action staying at the column bottom. This supersedes only #98's panel-sizing choice; the org-chart expansion, collapse and scroll-to-selection work from #99 is unchanged. Measured in headless Chromium against the built renderer bundle at 1280×900 / 981×900 / 1280×700 / 1600×1000, the width, top and bottom deltas between the two regions are all 0.00px, against 94.44 / 60.00 / 94.44 / 128.59px wide and 232.80 / 137.94 / 32.80 / 352.80px tall before. Under vertical pressure the body scrolls instead of overflowing (at 1280×560: 288px of content in a 181px box, dismiss still inside the column; before, the column overran its own row by 107.20px). At 980px and below the stack and its horizontal reachability are unchanged. Stretching the column exposed one consequence, which product called in during review: with no position selected the guidance row sat in a 79px box with 486.55px of empty card under it at 1280×900 (146.55px at 1280×560), so it now grows into the card and centres — 0.51px off the vertical centre of the free space, with the equal-pair deltas still 0.00px — covering the 已裁撤 notice state the same way. Two more review points, plus a regression the rebase onto main exposed. (a) #130 (which implements #127) declares `align-self: stretch` explicitly inside the single-sourced `.owb-position-column` block, and AC-002 rejected it because it only accepted the inherited `null`/`auto` — so the two gates contradicted each other on one rendering-equivalent value. The contract is the stretched state, not which rule declares it, so AC-002 now accepts `stretch` and still fails on an opt-out value such as `start`, matching `panel-parity.test.cjs`. (b) The duplicate adjacent `#120` entry is folded into this one. (c) #130 also deleted the block that carried `display: grid`, and no other `.owb-workspace-grid` rule in the file declares a display type, so the element fell back to `display: block`: both regions spanned the full 898px grid width stacked vertically, `grid-template-columns` was inert, and AC-001 still reported 0.00px because two equal full widths are trivially equal. The declaration is restored and AC-001 now pins `display: grid` before it asserts anything about the tracks. Re-measured in headless Chromium on the rebased tree: before, 898.00×338.58 against 898.00×274.89, stacked, with 338.58px / 274.89px top and bottom deltas and the regions overlapping; after, 442.00×631.38 against 442.00×631.38 side by side, all three deltas 0.00px, no overlap — holding at 981×900 (292.50px), 1280×700 and 1600×1000 (602.00px).
- #116: 用过个人会话的成员现在能正常建群。`POST /groups` 的锚 session 改为**复用优先**——首个成员岗位已有 active session 时直接以该会话为锚（只读绑定：不写岗位状态文件、不轮换、不追加会话），只有无 active session 时才新建，于是建群不再回 409 `session_conflict`；同岗位的多个群与并发创建共用同一锚，不会为每个群额外造会话。renderer 侧创建失败原先落在 `panelError` 却只在已选中群时才渲染，点「创建群聊」看着毫无反应；告警现在置于会话区顶部，一个群都还没有时同样可见（`role="alert"`，展示服务端原文）。显式 `POST /sessions` 的 409 与轮换语义不变。
- #112: `GET /reports` now aggregates bounded, validated `turn-record.v1` facts from both legacy position conversations and durable session conversations, so completed session turns remain visible as public-safe evidence, derived timeline entries, and observed budget usage after rotation or restart. Session facts must bind to the existing authoritative workspace/position/session state; file-handle-stable reads, shared byte/entry/temp limits, ordinal ordering, and cross-root identity checks make orphaned, duplicated, raced, unsafe, unbounded, or inconsistent local facts fail closed.
- #113: the bundled `qoder-engine` now implements the existing `hire validate <file> --json` gate used by `POST /hire`. It accepts only a bounded regular non-symlink `hire-request.v1alpha1` file, mirrors the frozen field/budget/deadline constraints, and preserves upstream's opaque minLength-16 `envelopeDigest` semantics without spawning Qoder or touching the workspace. Cross-platform path/handle identity and size checks plus a fixed MAX+1 positional read reject replacement and growth races. A valid static result still only opens gate one: the control plane stages the exact skeleton and requires the existing `org apply` gate before publishing the employee, with rollback on rejection.
- #114: 群聊实时态按 exact message/turn/position/engine 归属结算；202/SSE 竞态、乱序终态或事件流断开时，通过有界持久化时间线对账恢复完成输出与在线状态，并按稳定 `turnId` 去重，无需重新选择群聊。
- #125 review follow-up：Windows `.cmd`/`.bat` Qoder launcher now goes through an explicitly escaped `cmd.exe` invocation with `shell: false`; prompt metacharacters remain argv data instead of becoming shell commands.
- #110 independent review：进程清理只信任当前验证的 root/descendant、已绑定 identity，以及 POSIX 上来源代际未歧义的预期 detached group；Windows null-root fail closed，路径/command 只作诊断。static/behavior controls 按 Windows 大小写语义在任何 report reservation 前互斥检测，并从实际 child env 剥离；两种 smoke 共享 load/renderer/window lifecycle gate，失败报告 nonce/stage 绑定且 descriptor take-and-null，覆盖 post-report crash、重复事件与四个 production renderer timeout mutants。Windows native 仍为 **NOT VERIFIED**。
- #110 current-main integration：显式 server runtime inventory 新增 #119 生产依赖 `dist/src/stable-read.js`，缺文件时 layout 与 production verifier 均 fail closed；独立 macOS behavior qualification 改走 durable session create → session turn → session-history readback，实际加载该打包模块。#119 的 session/turn/report production code 与 tests 保持逐字节不变，Lane A static smoke 的结论不扩张。
- #104: 桌面默认的 bundled `qoder-engine` 已能真实执行本机 Qoder 回合，但 `/health` 仍只检查 `QODER_PERSONAL_ACCESS_TOKEN`，导致 renderer 把可用 Host 错误禁用。现在仅在引擎精确宣布 `qoder-engine <semver>` 时，以 health/turn 共用的无 shell resolver 解析绝对 Qoder executable：显式覆盖无效即 fail closed，否则查 PATH 与 macOS 已支持的用户安装位置；有界版本探针支持 1.1.x，缺失、非普通文件、不可执行、超时和版本越界均有非敏感下一步。turn 子进程保留继承 PATH；Finder 登录 PATH 恢复与打包验收由 #110 的 macOS arm64 foundation partial 承接，不是 #104 的完成依赖。普通 `digital-employee` 的 Qoder service-token 规则、Claude 判定和远端 entitlement 边界不变。
- Renderer verification now isolates Vitest workers from Node 26's experimental global Web Storage, so Node 24 and Node 26 both exercise jsdom-owned `localStorage` without changing Electron theme persistence.
- #110 macOS arm64 foundation（partial）：Finder/LaunchServices 的最小 PATH 无法发现用户 Qoder/MCP 命令。桌面 main 现在用固定 argv、单行 marker、绝对路径校验、输出上限和 `SIGKILL` 硬超时只恢复登录 PATH；失败保留原 PATH，不导入其他 shell 环境。`ELECTRON_RUN_AS_NODE=1` 只到桌面默认 bundled engine；health/hire/org 的普通 operator CLI 使用无凭据运行时 allowlist，turn 只携所选 Host 的明确授权，真实 Qoder/Claude probe 同样不读凭据。bundled Qoder adapter 只接收受支持的 binary/permission 配置，真实 Qoder/MCP 后代只接收 Qoder 运行时/凭据 allowlist，server boot token、internal marker、Context authority 与任意 secret 均不会跨越各自边界。
- #100: restore the two missing renderer stylesheet block closures so approval and audit-timeline styles parse in their intended scopes; add a focused PostCSS regression guard.
- D4 rejects symlinked/oversized org-audit sources before bounded reads, projects audit entries through an exact allowlist, and no longer reuses the latest per-task ratio as a per-day percentage when no day bucket exists.
- D3 turn control plane now preserves split UTF-8 output, accepts the upstream 1,048,576-character model boundary, reaps timed-out engine processes without late SSE, and safely preserves allowlisted spawn error codes.
- Active turns are no longer recovered as interrupted; trusted terminal SSE is emitted only after the final turn record is durably persisted, and position IDs mirror the engine organization contract.
- Persisted turn recovery now rejects unsafe or filename-mismatched turn IDs before path construction, and D2/shared/server/Desktop consume one position-ID validator (`7x` valid; repeated or trailing hyphens invalid).
- 桌面壳从 Vite 的实际输出目录加载 renderer，干净构建不再依赖被忽略的旧产物。
- renderer 按 IPC 的真实响应结构读取引擎健康状态，不再把可用引擎恒显为离线。
- renderer 可读取当前 SSE 连接状态，避免窗口加载晚于连接事件时一直显示“事件流重连中”。
- Electron 从 33 升级到 43.4.1，清除当前依赖审计中的高危漏洞；新增 Linux/macOS 双平台源码门禁。
- oss-maintainer 示例工作区：去除机器专属的 `localReference`，改用可移植占位路径；真实绝对绑定由引擎 apply 时重算。
- #73（`a47a803`，先于 PR #77 review，非本轮修复）：`antd-skin.css` 头注释里 `--ui-duration-*/--ui-ease` 中的 `*/` 提前闭合整块 light token（CSSOM 解析丢弃，仅 CDP 计算值能看出，静态检查看不出），改写措辞避开 `*/` 组合。
- PR #77 review：`--ui-foreground-subtle` 对卡面对比度只有 3.49:1/3.81:1（9-11px 文本不适用 large-text 的 3:1 门槛），调整为 `#66685f`/`#92958b`，全部背景阶 ≥4.62:1。
- PR #77 review：预算仪表 `>100%` 时宽度被夹到 100%、且 `aria-valuenow` 可超出固定的 `aria-valuemax=100`（非法 meter）——改为不夹宽度（轨道 `overflow:hidden` 移除，允许圆角端帽出界）、`aria-valuemax` 随读数动态取 `max(100, 当前值)`，保证 `valuenow <= valuemax` 恒成立。
- #86: `buildPositionSkeletonFiles` now JSON-quotes the generated SKILL.md frontmatter's `name` field (matching `description`'s existing escaping), so a purely numeric or YAML-reserved-word position ID (e.g. `1234`) no longer parses as a non-string YAML scalar and fails `org apply` with `employee_skill_name_mismatch`.
- #92: the `POST /hire` description bound now mirrors the real upstream constraint — at most 1024 **characters** (UTF-16 code units) on the trimmed value, matching digital-employee's `validateSkillFrontmatter` SKILL.md frontmatter check, which is stricter than `employee.json`'s own 2000-character bound. It previously allowed 2048 **bytes**, so a 1025-2048 character ASCII description passed every org-workbench gate, was staged to disk, and only failed at `org apply` with an opaque `employee_skill_description_required` (same defect class as #86, which fixed the sibling `name` field). The desktop IPC gate, which had no length check at all, now mirrors the same bound, and `docs/api-contract-v0.md` §2.14 documents it for the first time.
- #94: the composer's send button (and the cancel button in the same slot) went nearly invisible when disabled — reported directly ("看不清标志了") with the composer in its default empty state, which is disabled by default. Root cause: `.owb-turn-composer__surface button:disabled` dimmed the *whole button* via `opacity: 0.45`, and because both the white icon and its saturated `--ui-ai` (#722ed1) background were dimmed toward the same backdrop together, they collapsed toward each other rather than fading evenly — measured ~2.2:1, under the 3:1 WCAG floor for a UI icon. Fixed by swapping to `--ui-surface-raised` / `--ui-foreground-subtle` instead of opacity: the same pair `contrast.test.cjs` already holds to ≥4.5:1 on every surface tier in both themes.
- #94: the three real window-control buttons in the custom title bar (`.owb-wctl`, added in #73) rendered their close/minimize/maximize glyphs at `opacity: 0` by default, only reaching `opacity: 1` on `:hover`/`:focus-visible` of the *entire* title bar. Unlike a decorative macOS traffic light, these are the only way to close/minimize/maximize a frameless window, so shipping them with zero default affordance was a discoverability defect for first-time and keyboard-adjacent users, not a stylistic choice (reported directly by a reviewer while testing this same PR). The glyph now renders at full opacity always, in a theme-aware `var(--ui-foreground-muted)` stroke instead of the old hardcoded `rgba(0, 0, 0, 0.62)` (which only worked because it used to appear exclusively over the light hover backgrounds); hover/focus still swap in the semantic danger/warning/success background and switch the stroke back to the dark tone for contrast against it.
- #94: the Agent Host `Select` was narrower than its own longest option (`Claude Code · 本地登录 · Configured`), so the trigger ellipsised the selected host mid-CJK — and because `popupMatchSelectWidth` was unset, `@rc-component/select` pinned the popup to the trigger's `width` rather than its `min-width`, leaving no interaction that revealed the full text. `GroupsPanel` was the worse of the two: a *fixed* `150px` track that never widened at any window size. Both call sites now share one `EngineSelect`: the popup sizes to its content and keeps the readiness suffix, the trigger renders a compact `icon + host name` label (readiness is already stated in prose below the control and in the group engine chip), and both grid tracks get a `220px` floor. Host selection decides which engine runs the turn and which credential path `claude-local` vs `claude-code` uses, so choosing it from truncated labels was an operator-error path, not a cosmetic one.
- #98: the Org page's chart panel capped `.owb-org-chart__body` at a fixed `max-height: 240px` with no way to reach the hidden content except manual scroll, and no scroll-to-selection existed anywhere in `OrgChart.tsx`. A 4-level, 5-position organization needs roughly 430px to render, so the root node scrolled out of view by default and switching positions gave no hint where the newly selected card was. The cap is gone — the panel now sizes to its actual depth — and a header toggle (default expanded) lets the user collapse it back down for room instead of the layout silently deciding for them. A `scrollIntoView` effect keyed on `selectedId` now brings the selected card into view on every switch, honoring `prefers-reduced-motion`.
- #98: the position card (`.owb-position-column`) was force-stretched to the conversation panel's height via `align-items: stretch` + `grid-template-rows: minmax(0, 1fr) auto`, but the card's own content (`.owb-pos-body { align-content: start }`) has no section designed to absorb extra height — everything past "Context Scope" was blank white space with no semantic meaning, unlike the conversation panel's own flexible row, which fills leftover height with a designed empty state. The column no longer stretches (`align-self: start`, `grid-template-rows: auto auto`); the card sizes to its own content and the conversation panel keeps the full row height.

### Verification

- #110 Lane A 原始候选 `2645033`（old base `764bfe0`）：macOS 15.5 arm64 本机以单一前台串行链从 cold `npm ci` 开始，通过 focused scripts 15/15、desktop behavior 17/17、packaged renderer 2/2、完整 `npm run check`、无产品签名的 unpacked staging、manifest/arm64 核验及 static clean-staging smoke；该证据只属于原始固定 SHA，不自动覆盖后续 current-main 集成。主 executable 的签名口径是 `unsealed-linker-adhoc`，不是产品/分发签名。Windows x64 原生结果仍为 **NOT VERIFIED**；current-main 集成链见 `docs/evidence/issue-110/lane-a/README.md`。
- #110 旧 current-main evidence SHA `e8afd2c` 经 independent review 为 **REQUEST CHANGES**：process ownership、Windows env casing、behavior lifecycle 与 D6 command ledger 均需修复；它此前的绿色记录仅保留为历史，不是新 SHA gate。
- #110 historical hardened code head `3897329`（base `24ce31a`）：bundled Node 24 cold `npm ci` 保持当时 current-main lock 字节不变；exact focused integrated 68/68、packaged renderer 2/2 与完整 `npm run check` 全绿（scripts 20、UI 31、server 156+1 expected skip、renderer 157、desktop 89、audit 0）。macOS arm64 unpacked staging 通过当时的 33-entry/188-file verifier、Lane A static smoke 与独立 behavior smoke；main 后续前移后该记录只作历史 provenance，不能 gate 新 SHA。
- #110 current-main code head `4f9a983`（base `ff878d8` / PR #119）：bundled Node 24 cold `npm ci` 保持 current-main lock 字节不变；exact focused integrated 71/71、packaged renderer 2/2 与完整 `npm run check` 全绿（scripts 21、UI 31、server 181+1 expected skip、renderer 157、desktop 91、audit 0）。macOS arm64 unpacked staging 通过含 `stable-read.js` 的 34-entry/189-file exact-byte verifier、Lane A static clean-staging smoke，以及独立的 Finder PATH → Qoder/MCP fixture → durable session turn/history behavior smoke；`sessionHistoryReadback=true`，两种 smoke 的 known/bound residual 均为 0、临时 staging 均删除。25 个 #111/#119 protected paths 相对 base 逐字节不变。Windows x64 原生 staging/verify/smoke、安装器、签名、发布与更新仍为 **NOT VERIFIED / 未实现**。
- 本地 `npm run check` 全绿（ui 15/15、server 46/46、renderer 13/13、desktop-main 4/4，依赖审计 0 漏洞）；Ubuntu/macOS required checks 以 PR CI 为准。
- 真实本地引擎 E2E：digital-employee `7a92690` 成功招聘后 `/org/tree` 重载 5 岗位；非法预算拒绝码透传，`org.json`/`org-audit.jsonl`/`permissions.json` 前后 SHA-256 一致，提案和 0600 `budget.json` 保留。
- macOS 桌面壳实测：组织树渲染、岗位卡片、SSE 刷新、关窗进程退出全部通过（issue #4 验收，证据见 issue #1/#2 评论）。
- D3 后端以 fixture CLI 和 HTTP 集成测试验证；renderer 以 IPC fixture 验证“打开工作区 → 选岗位 → 加载本地历史 → 发送 → readback”、idle 禁用和 API failure。bundled Qoder 已在 macOS 本机完成真实 `POST /turns` → `completed` turn-record → `GET /turns` readback；响应正文不进入仓库。Claude Code live Host、委派与 mem recall 不在本切片范围。
- Fix for #104: Node 24.13.0 的完整 `npm run check` 通过（scripts 4/4、UI 31/31、server 148 pass + 1 expected skip、renderer 155/155、desktop-main 39/39、依赖审计 0 漏洞）；真实 bundled Qoder health、direct engine turn 与 Workbench HTTP E4 的公开安全事实见 `docs/evidence/issue-104/README.md`。
- Session E3 以真实临时 workspace 覆盖 create → turn → rotate → restart → old/read-only + successor/zero-turn，另覆盖双 rotate、running conflict、错误请求不触发 Host 和持久化攻击面。Memory recall/write 与 live Host E4 明确未实现/未验证。
- PR #77：`tsc -b`、`typecheck:ui`、`typecheck:renderer` 全绿；`test:ui` 31/31、`test:renderer` 97/97、`test:desktop-main` 27/27（含新增 `window-ipc.test.cjs` 6 例负向安全测试、`contrast.test.cjs` 1 例真实 WCAG 计算）；`npm audit --audit-level=high` 0 漏洞。`apps/server/*` 未改动，其测试套件本地重跑两次分别为 17 / 20 个失败（非确定性、失败数不稳定，`git diff apps/server/` 为空），系既有 test 隔离问题，非本 PR 引入，CI（干净环境）按 reviewer 记录为全绿；未在本 PR 内处理（越出 AC-005 边界）。窗口边缘拖拽缩放：CDP 视口模拟 940/680/1680 三档均验证通过，真实 WM 交互（WSLg）未验证，已在 macOS 实机验证通过（见 PR review）。
- Fix for #92: `tsc -b` and `typecheck:renderer` clean. The new regression test derives the boundary instead of restating a constant — it binary-searches the description length the live request gate actually accepts, then asserts the resulting SKILL.md frontmatter and `employee.json` both satisfy the upstream bounds; reverting the fix makes it fail with `accepted description of 2048 chars yields 2048 in SKILL.md frontmatter, over the upstream 1024 bound`, confirming it catches the original defect. `hire.test.ts` + `apply.test.ts` 17/18 pass (the 1 failure is the pre-existing `hire/move/dismiss` isolation flake). `test:desktop-main` 34/34. Full `apps/server` suite: 124/142 pass, 17 fail, 1 skipped — a `git stash` A/B against unmodified `main` produced 37 failures on the baseline run, so the flake's failure *count* is itself non-deterministic (as this file already records); the meaningful check is that the failing-test-name set under this change is a strict **subset** of the baseline set, with zero failures unique to the change. `test:renderer` 125/136 with the same 11 pre-existing duplicate-React failures; no renderer source is touched by this diff. `test:ui` / `security:check` not rerun locally — untouched trees, CI is the gate of record.
- Fix for #94: `npm run build` / `test:scripts` 4/4 / `typecheck:ui` / `test:ui` 31/31 / `typecheck:renderer` / `test:renderer` 155/155 / `test:desktop-main` 35/35 / `npm audit --audit-level=high` 0 漏洞，全部本地绿。新增 19 条 renderer 用例（`theme-mode` 9、`theme-toggle` 5、`agent-host-select` 4、`groups-panel` +1）与 1 条 `agent-host-width.test.cjs`。宽度门禁做过反向验证：把两条 grid track 改回 `150px` 并重新构建，断言以 `Agent Host track floor is 150px, below the 200px the compact label needs` 失败，确认它真的能捕获原缺陷。`apps/server` 未改动，其套件本地 124/142 pass、17 fail、1 skipped——与 `git stash` 后干净 `main` 的失败用例名集合**完全相同**（0 条为本次变更独有），系本文件上文已记录的既有 test 隔离 flake。桌面壳双主题的真实观感（WSLg 实机）本轮**未**由我执行，仅有 jsdom 层的属性/可访问性断言与既有 `contrast.test.cjs` 覆盖；实机确认留给 review。
- Fix for #86: `tsc -b` clean; new `buildPositionSkeletonFiles` regression test (numeric position ID stays quoted in SKILL.md) passes. `node --test apps/server/dist/test/*.test.js` locally: 112/130 pass, 17 fail, 1 skipped — the 17 failures reproduce identically against unmodified `main` (verified via a `git stash`/rebuild A/B check isolating this change), matching the pre-existing, already-documented test-isolation flake noted in the PR #77 verification entry above (not introduced by this change; CI clean-environment runs are the gate of record). Renderer/desktop suites are untouched by this diff and were not rerun locally.
- Fix for #98: `npm run build` / `typecheck:ui` / `typecheck:renderer` clean, `test:scripts` 4/4, `test:ui` 31/31, `test:renderer` 155/155, `test:desktop-main` 37/37, `npm audit --audit-level=high` 0 vulnerabilities, all local green. No new test file was added — both fixes are covered by the existing `org-chart.test.tsx` / `position-card.test.tsx` / `App.test.tsx` suites, none of which assert the removed pixel cap or the stretch behavior directly (they assert selection state, node structure, and card content, all unaffected by the layout change); a pixel-level regression guard was judged not worth adding for two CSS layout properties — flagged for reviewer judgment. `apps/server` untouched by this diff (`git diff --stat` confirms zero overlap): 124/142 pass, 17 fail, 1 skipped, the exact same shape already recorded against unmodified `main` in the #94 entry above, so it was not independently re-verified via a fresh `git stash` A/B this time. Real-window confirmation on WSLg: performed by the requester after each of the two fixes (screenshots reviewed in the linked issue), not captured as an automated check.

## [D0] — 骨架

提交 0db36fe（feat(d0): org-workbench skeleton）。

### Added

- 壳-服务分离：Electron main 拉起 `apps/server`（Node，仅 127.0.0.1，每启动随机 boot-token）；控制面可脱离壳独立运行。
- 引擎消费：spawn 钉版 `digital-employee` CLI（ADR-0002）；`/health` 报告引擎可用性与下一步。
- `org apply`：staging 暂存 → 引擎校验 → rename 原子发布；失败留档 `rejected/`，裁撤归档 `archive/`，全程不硬删除（ADR-0003）。
- API 契约 v0 冻结：`docs/api-contract-v0.md`（8 端点全量；新增走增量，破坏性变更升 v1）。
