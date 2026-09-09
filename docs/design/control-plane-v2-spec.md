# org-workbench 设计规格 v2 —「Control Plane 控制平面」

> 交接文档：面向后续接手修改样式的 AI 或前端工程师。
> 配套预览：本目录 `org-workbench-design-control-plane.html`（交互稿，可对照看效果）。
> **权威关系（#77 review 修正——原表述与下方 #73 更新说明自相矛盾）**：
> §2 signature moves 的结构定义与 §4 落地文件清单，以本文为准；
> §1 铁律与 §3 的数值层（配色/字体/圆角/动效），在 #73 修订中已改为以
> `org-workbench-design-control-plane.html` 预览稿为权威源（productOwner
> 裁决，见下方 #73 更新说明）——不是"预览稿仅为视觉示意"。两者不是同一份
> 权威，改代码前先看清改的是哪一层。

---

## 0. 一句话

**组织图就是控制平面。** 文件树即组织架构，岗位是设备端点，预算是资源仪表，回合是证据链。

改造的唯一目标：让「文件树即组织架构」这个核心领域概念，第一次在视觉上真正成立。

---

## 1. 铁律（不可违背的底盘）

> **#73 更新（2026-08-27）**：本节数值已按 `org-workbench-design-control-plane.html`
> 落地实测更新（productOwner 拍板：html 为第一权威，与 design-system ADR-0002
> 的退役裁决不冲突——中性色/圆角本就是照 design-system 的契约值取的，状态色/
> 字体/动效为本轮新增）。原 #31 冻结值（`--ui-canvas:#f8f7f5`、圆角 4/6/8/12、
> 动效 120/150/200）已被本轮替换，不再是当前基线；历史脉络见 issue
> [#31](https://github.com/bytefolk/roleweave/issues/31)。

以下是现有品牌资产，**必须保留**，任何 AI 接手后不得推翻：

| 资产 | 现行位置 | 约束 |
|---|---|---|
| 单一强调色 lavender | `antd-skin.css` → `--ui-primary: #5E6AD2` | 全应用只此一处强调色；AI 紫 `#722ed1` 仅限 AI affordance |
| warm hairline 分层 | `--ui-border: #DCD7CA` / `--ui-border-strong: #CBC4B4` | 卡片分层靠 1px 描边 + 亮度阶，**不做重度阴影** |
| 动效三档 | `--owb-duration-fast/mid/slow` = 120/160/240ms，ease-out `cubic-bezier(0.22,0.61,0.36,1)` | 禁 >300ms；design-system 原生 `--ui-duration-fast/normal`/`--ui-ease` 已收敛到同一节奏，不再有两套并行动效体系；`prefers-reduced-motion` 下 `--owb-*` 自归零，不借上游通配兜底 |
| 语义 token 纪律 | `antd-skin.css`（ADR-0002 唯一 skin 面） | 一切颜色经 `--ui-*` 变量，**组件内不许出现裸 hex** |
| 布局/模式层自定义 | `app.css` 的 `.owb-*` 类 | DL5：布局不用 antd，保持自定义 |

验证方法：`rg "hex"`（八位 hex / rgb）扫 renderer，若命中即违规。

---

## 2. 设计方向详解

### 2.1 审计结论（为什么改）

现有 UI 的问题是「有价值的底盘 + 平庸的表皮」叠加：

- 组织树是普通缩进列表，看不出"树即组织架构"；高亮/选中反馈只有底色，无结构性表达
- 岗位卡、预算、对话、审计都是一式 hairline 白卡，层级平，第一眼无焦点
- 字体 Inter 一家独大，缺工程工具性格
- 数据密度够但信息架构没有层次（eyebrow / 状态灯 / 证据 chip 未形成系统）

### 2.2 四个核心改动（signature moves）

**改动 ①：连接线 = 汇报线（最重要的 signature）**

组织树从"缩进目录"升级为"guide-rail 连接图"：

- 用 CSS 连接线（`::before`/`::after` 竖线 + 横支线）表达汇报关系
- **选中任意岗位 → 其祖先链路上的连接线整段点亮 lavender**（递推向上，遇根停止）
- 末兄弟纵向线止于中点（`is-last`），避免穿到底
- 行高 30px，缩进步长 20px/级，连接线颜色 `--ui-border-strong`，点亮后 `--ui-primary`

DOM 约定（供 AI 对照）：
```html
<div class="tr-row" style="--d:1" data-pos="issue-researcher">
  <span class="conn" aria-hidden="true"></span>  <!-- 连接线占位 -->
  ...
</div>
```
```css
.tr-row { --d:0; padding-left: calc(10px + var(--d) * 20px); }
.tr-row .conn { position:absolute; left: calc(var(--d) * 20px - 6px); ... }
.tr-row.is-linked .conn::before { background: var(--ui-primary); }   /* 祖先链路点亮 */
```

`is-linked` 由交互逻辑递推标记（对照参考稿 JS 的树选中 handler，取该行更深级的前序兄弟标 `is-linked`，自身标 `is-selected`）。

**改动 ②：岗位即端点**

每行新增三样端点语言：

- 状态灯 `.led`：8px 圆点，可用=绿(ok)、运行=AI 紫+呼吸动画、离线=灰；所有状态/层级卡片共用同一套 `.led`
- 微型预算条 `.tr-budget`：42×6px 圆角条，`<80%` lavender / 80–100% 琥珀 / `>100%` 红
- hover 浮出 `.row-actions`：招聘下属（＋）、发起群聊（people）两个图标按钮，默认 `opacity:0`，行 hover 显示，120ms

**改动 ③：回合即证据**

对话面板以工程控制台语言呈现 D3 证据优先的定位：

- 状态行 `.statusline`：`engine badge · 耗时 · tokens · 终态词`，等宽字体，tabular-nums
- 可信终态 = 绿色实心点 + `可信终态`；不确定 = 琥珀 `▲ 不确定 · turn_cancelled`
- 证据 chip `.evidence`:信封 digest `sha256:…` + turn id，印章式小卡
- 审批卡 `.approval`：左 3px lavender 边、scope/expires 等宽行、批准/拒绝两按钮
- 运行中回合：AI 紫边框 + 呼吸点

**改动 ④：预算即仪表**

预算声明 + 消耗统一为双轨仪表：

- `.budget-lane`：`[58px 标签 | 1fr 轨道 | 值]`
- 轨道三态：绿(ok)/琥珀(warn ≥80%)/红(over >100%)
- 声明期（未消耗）：轨道显示占位，无百分比
- 数值区等宽、tabular-nums；`40,000` 风格，千分位

---

## 3. 视觉 token 系统

### 3.1 调色（#73 实测落地值，取代原 #31 冻结值）

沿用 `--ui-*` 语义角色（不新增裸色），值改为 html 设计稿的暖纸哑光调：

```
canvas  #F4F1E8        画布（暖纸壳层）
surface #FDFBF5        内容卡面
surface-raised #FFFDF8 提升卡面（titlebar / topbar / session chip）
inset   #F2EEE3        嵌入式背景（轨道 / 输入 / code 区块）
border  #DCD7CA        hairline 描边
primary #5E6AD2        lavender 强调（唯一，不变）
ai      #722ED1        AI affordance（仅回合运行 / SSE / 群聊活跃，不变）
ok      #3F7D4E        健康 / 可信终态（哑光森绿，非 antd 亮绿）
warn    #A86A0A        逼近上限 / 不确定（哑光琥珀）
danger  #C04A3E        超限 / 失败（哑光砖红）
```

具体到"控制平面感"，靠**等宽字 + 横竖 hairline + 状态灯**达成，不靠新颜色。
antd cssinjs 侧（`App.tsx` `ConfigProvider`）与此处同值同步维护。

### 3.2 字体（#73 实测落地值）

| 角色 | 字体 | 用法 |
|---|---|---|
| 正文 / 控件 | `Inter`（沿用，`@fontsource/inter`） | 按钮、输入、选择器、正文；等同 html 稿的系统字体栈，视觉等价、零新增加载风险 |
| 面板 / 分区标题 | `Space Grotesk`（新增，`@fontsource/space-grotesk` 500/600/700，`--owb-font-display`） | 仅 `.owb-*__header h2`、`.owb-reports__hero h1`、`.owb-modal__header h2` 等标题；`letter-spacing:-0.01em`（沿用处方5） |
| 数据 / 证据 / id | `JetBrains Mono`（新增，`@fontsource/jetbrains-mono` 500/600，`--ui-font-mono`） | 岗位 id、预算值、token 数、digest、时间戳，一律 `font-variant-numeric: tabular-nums` |
| 微标签 | 12px / 600 + `0.08em` 大写 | eyebrow、分区 h3（沿用现状的 uppercase 标签体系） |

### 3.3 间距 & 圆角（#73 实测落地值）

沿用现有 scale（`--ui-space` 4/8/12/16/…）与 `--ui-radius-sm/md/lg/xl`，圆角改为 **6/10/14/18**（对齐 html 设计稿 `--r-sm/md/lg` 6/10/14，并延伸一档 18 供 modal/drawer 用，antd cssinjs `borderRadius` 同步为 10）。行高、卡 padding 一律从 token 取，禁止魔法数。

### 3.4 动效（#77 review 修正：与 §1 铁律表数值不一致）

- 三档 **120/160/240ms**，ease-out `cubic-bezier(0.22,0.61,0.36,1)`（对齐 §1
  铁律表与 html 设计稿 `--t-fast/mid/slow`；此前本节残留 #31 冻结值
  120/150/200，与 §1 已更新的数值互相矛盾，以 §1 为准）
- 新增且必须：`prefers-reduced-motion: reduce` 时关闭全部动画与过渡（statusline 呼吸点停止、树连线点亮变瞬时）

---

## 4. 落地指引（改哪些文件、怎么改）

| 文件 | 改动 |
|---|---|
| `apps/desktop/renderer/src/antd-skin.css` | 可增补 `.led` 状态token辅助色，但**不改**primary/AI紫/border 主值 |
| `apps/desktop/renderer/src/app.css` | 新增连接线/仪表/证据/hover actions 的应用层规则（本规格 §2 为准）；沿用 `.owb-` 前缀 |
| `packages/ui/src/org-tree.tsx` | 树行追加 `.conn` / `is-linked` 标记逻辑、`.tr-budget`、`.row-actions`（招聘/群聊入口}) |
| `packages/ui/src/position-card.tsx` | 预算区改 `.budget-lane` 双轨仪表（对齐 BudgetBar 语义，不重造数据） |
| `packages/ui/src/budget-bar.tsx` | 依赖现有 tierClass(<0.8 ok / ≥0.8 warn / >1 over)；确认样式类名与笔记稿一致 |
| `apps/desktop/renderer/src/turns/TurnThread.tsx` | 状态行/证据 chip/审批卡的 class 与 markup 对齐 §2·③ |
| `apps/desktop/renderer/src/App.tsx` | 树选中 → 祖先链路 `is-linked` 的 handler；只为 UI 状态，业务逻辑不动 |

**边界（严禁触碰）**：

- `apps/server/*`、`packages/shared/*` 契约层、IPC/preload 白名单、SSE 事件、认证/凭据流
- 组织树拖拽 *语义*（`onMove`/`onDropPosition`/reorder）不变，只改其视觉
- 数据字段不动：预算、权限、回合记录、报告契约全部只读展示

---

## 5. 交互行为清单（验收用）

- [ ] 点击岗位：祖先链路连接线点亮 lavender，自身行 `is-selected`
- [ ] hover 树行：浮出「招聘下属 / 发起群聊」，120ms 淡入
- [ ] 树折叠/展开：`is-closed` 旋转；折叠后下一代行体被正确隐藏
- [ ] 预算仪表三态在 `>100%` 时呈红且超长（116% 出界不截断圆角）
- [ ] 回合运行中：AI 紫呼吸点 + 状态行实时 token 数；完成后转绿"可信终态"
- [ ] 审批卡批准/拒绝可用，决策态字样切换
- [ ] 亮/暗双主题切换后所有 token 正确、对比达 AA
- [ ] `prefers-reduced-motion` 下无动画残留
- [ ] 键盘可达：Tab 遍历所有按钮/树行，focus-visible 可见

---

## 6. 常见坑（写给接手的 AI）

1. **别重造语义**：预算三态、模式只读/需批准、终态词全都来自 `packages/shared` 契约字段，UI 只做映射展示。
2. **颜色走 token**：任何新颜色进 `antd-skin.css` 的 `--ui-*`，组件内不许裸 hex/rgb。
3. **is-linked 要递推**：不能只在选中行本级点亮；向上遍历前序兄弟、遇到更浅 `--d` 即标记，直到根。
4. **动效不让步**：`>300ms` 一律回退；没 `prefers-reduced-motion` 覆盖=未完成。
5. **布局不用 antd**：栅格/间距保持 `app.css` 自定义，antd 只出控件（按钮/选择/标签）。

---

## 7. 怎么验收

1. 打开 `start-owb-server.sh` / `run-owb-desktop.sh` 跑起桌面壳
2. 对照本规格 §5 清单逐项点验
3. 用 `npm run check` 全量门禁（tsc + typecheck + vitest + node --test + renderer 构建）
