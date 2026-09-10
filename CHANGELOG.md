# Changelog

本仓库采用 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式。
版本号在首个正式发布前以里程碑标注；`gh-pages` 分支只承载官网静态站点，无独立版本号，跟随 `index.html` 的实质性改动记录。此分支与 `main`（应用源码）没有共同历史。

## [Unreleased]

### Changed

- **官网迁移进本仓库**：原先托管在独立仓库 `bytefolk/ordane`（`https://bytefolk.github.io/ordane/`）的官网内容，原样迁移到本仓库的 `gh-pages` 分支，改用 `https://bytefolk.github.io/roleweave/` 提供服务——`roleweave` 这个名字已经是本仓库自己占用，`ordane` 仓库无法直接改名。追踪见 [#228](https://github.com/bytefolk/roleweave/issues/228)；本条以上的历史条目全部来自 `bytefolk/ordane` 仓库，完整的 Ordane→RoleWeave 品牌与文案对齐过程见 [ordane#7](https://github.com/bytefolk/ordane/pull/7)。`bytefolk/ordane` 仓库本身如何处置（归档 / 加跳转说明 / 保留）是另一个待决定的事项，不在本次迁移范围内。
- CI 工作流文件改名 `verify.yml` → `site-verify.yml`（工作流名同步改为 `site-verify`），触发分支由 `main` 改为 `gh-pages`——`main` 上已经有一个同名的 `verify` 工作流（应用自己的 CI），避免混淆。

## [Migrated from bytefolk/ordane]

以下条目在迁移前记录于 `bytefolk/ordane` 仓库，随内容一并搬入；含 PR #3（feat: add Ordane marketing site）与 Ordane → RoleWeave 品牌 / 文案对齐。

### Changed

- **全站更名 Ordane → RoleWeave**，事实口径统一改取自 `bytefolk/roleweave` 仓库 README 与 v0.1.1 release：
  - 标识改用仓库内的 `branding/roleweave/roleweave-icon.svg`（紫 / 蓝 R+W 字母组合），内联进导航并编码为 favicon。
  - 主色跟随标识：token `--teal*` 更名 `--brand*`，取值来自 logo 的紫 `#722ed1`（OKLCH `49.4% 0.228 295.6`）；新增 `--azure`（logo 的蓝 `#1677ff`）用于 hero 标题强调。`scripts/contrast-check.js` 的 token 名与配对表同步更新，并为大字号强调新增一对 azure / paper（3:1 门槛），明暗两套共 46 项全部通过。
  - 版本标注由 `v0.6.0 · Alpha` 改为 `v0.1.1 · 早期预览`；导航、hero、CTA 增加指向 releases 的下载入口。
  - `#concept` 由 line 原语改为「文件树即组织架构」，附 `examples/oss-maintainer` 的实际目录结构与工作区 / 岗位 / 会话三个概念的定义。
  - `#principles` 由「三条不动摇的原则」改为 README 的三类日常使用（组织一支团队 / 与岗位工作 / 看清发生了什么）；能力清单重写为 v0.1.1 已发布的五项与仍在进行的三项。
  - `#runtime` 由「claude-local 与 qoder 均有本机验证证据」改为：默认适配器 Qoder CLI 1.1.x、macOS 已实机验证，Claude Code 未纳入验证基线，doc / mem / context 标为可选连接服务。
  - `#ladder` 由「个人 → 团队 → 组织」三级收编阶梯改为下载与上手：macOS（Apple Silicon）、Windows x64、Linux / Intel Mac 三张卡片加五步 get-started。后者在 v0.1.1 未提供安装包，如实标为暂未提供。
- 修正两处超出仓库事实的表述：页脚「本地优先 · 数据不出域」改为「工作区文件本地存储 · 提示词仍会发送给所配置的 AI 提供方」——README 明确 local storage 不等于 offline AI；下载卡片角标由「已实机验证」改为「自动更新可用」——README 明确安装、卸载与跨版本自动更新未声称端到端验证。
- hero 沿用同一张真实客户端截图（未经修饰），但其窗口标题仍是改名前的 `org-workbench` 开发版，已在图注中据实说明。
- 下载入口改为悬浮下拉：导航、hero、CTA 三处的「下载」按钮悬停即展开菜单，直接列出 v0.1.1 的两个安装包（`roleweave-0.1.1-arm64.dmg` 与 `roleweave-0.1.1-x64.exe`），点哪个就下哪个——GitHub release 资产带 `Content-Disposition: attachment`，无需中转到 releases 页面再找文件。
  - 用 `<details>` 而不是纯 JS 菜单：JavaScript 关掉时点击仍能展开，脚本只负责悬停展开、点选后收起、Escape 与点击外部关闭。菜单与按钮之间的 10px 间隙由 `.dl-menu` 的 `padding-top` 承担，指针移进菜单不会触发 `mouseleave`。
  - 「当前设备」角标只认浏览器自报的平台：Windows 标 EXE，macOS 标 DMG；`navigator.userAgentData.getHighEntropyValues` 可用且报告非 arm 架构时撤掉 macOS 角标——mac 包只有 arm64，不能让 Intel Mac 用户以为那是给他们的。Linux 与 iOS 不标任何一项。检测整体包在 try/catch 里，失败也不影响下拉本身。
  - `.hero-inner` 的 `z-index` 由 1 提到 2：hero 的下拉菜单从这层里溢出，而 `.float-card`（截图卡）同为 `z-index: 1` 且在 DOM 里靠后，此前会把展开的菜单盖住并抢走指针事件。
  - `scripts/contrast-check.js` 新增下拉悬停态的 ink / band 一对，明暗两套共 48 项通过。
- `package.json` / `package-lock.json` 包名 `@bytefolk/ordane-site` → `@bytefolk/roleweave-site`，README 重写为 RoleWeave 官网说明。仓库名与 Pages 地址仍是 `ordane`，重命名需单独处理。

### Added

- 首个可发布的官网页面：hero、line 原语说明、能力清单、三条原则（含可切换 tab）、Runtime 抽象层轨道图、三级收编阶梯、CTA、页脚。内容取自 `org-workbench` 现有仓库事实，附一张该客户端 `examples/oss-maintainer` 示例工作区的真实截图（未经修饰）。
- 导航与 favicon 图标：替换初始占位图形为正式设计稿（teal 环 + 播放三角标记）。
- `scripts/render-check.js`：站点的渲染校验脚本。无头渲染 `index.html`，对 hero / runtime / ladder 三段分别定位、滚动、截图并检查尺寸与文件大小，逐屏推进滚动以确保 9 个 `.reveal` 区块全部被 IntersectionObserver 触发，点击三条原则的 tab 验证面板切换。**失败即非零退出**（`try/finally` 保证浏览器关闭），判定口径为：
  - **致命**：`pageerror`；页面自身代码产生的 `console.error`；除字体主机以外任何失败的请求；以上各项断言不通过。
  - **非致命但记录**：`fonts.googleapis.com` / `fonts.gstatic.com` 的字体请求失败，按 URL 判定后计入 `WEBFONT_LOAD_FAILURES`——这取决于运行者的网络而非页面本身（未做此分类前，一次运行曾因 4 条 `ERR_NETWORK_CHANGED` 误报失败）。`Failed to load resource` 这类 console 回声不重复计数，统一由 `requestfailed` 分类。

  带 `--self-test-failclose` 会在同一页面注入一条 console 错误和一个抛出的异常，用于证明失败路径确实以非零退出，而不只是打印。

### Fixed

- 手机宽度横向溢出：Runtime 轨道图的三个 Host 节点用 `left: 90%` 等绝对定位 + `white-space: nowrap`，390px 下容器仅约 334px 宽，把文档撑到比视口宽 71px（`docScrollW=461` vs `winW=390`），导致整页可以左右拖动。720px 以下改为纵向堆叠（隐藏轨道圆环、节点转为静态流式布局并允许换行），修复后 390 / 768 / 1440 三个宽度均无横向溢出。
- 浅色模式主 CTA 按钮 hover 对比度：`.btn-primary:hover` 会把背景换成一个更亮的 teal，近白色标签文字掉到 3.90:1（低于小文本 4.5:1 门槛）。语义修正为「浅色底 hover 变深、深色底 hover 变亮」，token 由 `--teal-bright` 更名为 `--teal-hover`（浅色 58% → 40% L），修复后浅色 8.20:1、深色 9.78:1。全站 22 对文字/背景组合 × 明暗两套共 44 项已逐一计算，现全部通过。
- 三条原则的 tab 只实现了半套 ARIA：声明了 `role="tablist"` / `role="tab"` / `aria-selected`，但面板缺 `role="tabpanel"`、按钮缺 `aria-controls`、面板缺 `aria-labelledby`，且没有方向键导航与 `tabindex` 管理——读屏会播报「tab, 1 of 3」而方向键无反应。现补全为完整模式（含 roving tabindex 与 ←/→/↑/↓/Home/End）。
- 标题层级跳级：页脚三个栏目标题为 `<h4>`，其前最近的标题是 CTA 区的 `<h2>`，跳过了 h3。改为 `<h3>`。
- `mem 长期 Context` 能力状态由 `Shipped` 改为 `Building`，个人版文案由"本地记忆"改为"本地历史 readback"——`org-workbench` README 明确长期 Context 与委派链仍未完成，此前的措辞把未交付能力当成了已发布能力。
- `openai-compatible` Runtime 节点改为虚线、降低视觉权重，标注"Preview · 未 live-qualified"——该能力仅存在于 `digital-employee` 仓库且标注为 preview/fixture-conformant，`org-workbench` 自身未提供对应证据。
- 深色模式 `--ink-3`（56% → 60.7% L）与浅色模式 `--ink-3`（55% → 53.3% L）：对全部三个背景（paper/band/card）的小字号文本对比度均低于 WCAG 4.5:1 门槛（3.81–4.26:1 / 4.31:1），逐一计算 OKLCH → 线性 sRGB → 相对亮度后调整，修复后各组合 4.62–5.20:1。
- 浅色模式 `--amber`（64% → 54.5% L）：`.st-building` 状态标签在浅色模式下对 paper/band/card 均低于 4.5:1（3.13–3.51:1），同一方法计算后调整，修复后 4.60–5.17:1；深色模式 `--amber` 原值已通过，未改动。
