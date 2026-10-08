# @roleweave/ui

组织树组件族。D1 起消费 design-system（React 系，已与 org 各仓技术栈核对），把原型 P1 验证过的交互落为可复用组件：组织目录树（拖拽调岗/招聘预算对话框/裁撤确认）、岗位卡片、上报中心三流、顶栏预算仪表。

D0 阶段为占位包：桌面壳渲染层是零依赖原生实现（四区骨架的 D0 子集），React 化与 design-system 对接自 D1 开始，按规格重写，原型代码不搬（骨架定稿 open decision 7 既定口径）。

日期与时间选择统一使用 `DateField` / `DateTimeRangeField`，内部复用 Ant Design 并跟随 `OwbI18nProvider` 的中英文设置。各模块不要单独使用原生日期输入或重复封装 DatePicker。

- `DateField` 接收并返回 `YYYY-MM-DD`；清空返回空字符串；`min` / `max` 限制可选日期。
- `DateTimeRangeField` 接收 `[from, to]` ISO 时间戳，在本地时区显示，确认后返回 ISO 时间戳；支持单边范围，清空返回 `[undefined, undefined]`。
- 用 `aria-label` 或关联 `id` 的 label 命名字段，布局通过 `className` 设置，样式沿用应用的 Ant Design 主题。
