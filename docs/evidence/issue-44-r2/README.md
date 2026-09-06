# R2 素材证据包（运营索取单回执 · 客户端负责人）

基线：org-workbench main @ 3fd1de3（#35 S4 合入后；运营单原定基线 828834d 为 #33 入仓点，
#33 创建员工面自 828834d 至 3fd1de3 零改动，补拍以当前 main 为准并在此注明）。
仪式：/tmp stub CLI（`ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI`）+ 全新 fixture
（`/tmp/owb-44-ws`，自 examples/oss-maintainer 复制）+ CDP（9337）驱动真实 UI。
stub 与驱动脚本仅存 /tmp，不入仓库。本包仅落盘不外发。

## ① S1 Drawer 打开态 —— drawer-s1-open.png（补拍）

- 点「创建员工」打开 Drawer：标题「创建员工」，表单草稿态全空
  （姓名/岗位 ID/职责描述/上级=Repo Owner/运行模式=需审批/双预算四格）；
- 「开始创建」disabled（必填未齐），「取消」可关；背景组织树遮罩不可操作；
- 与 issue-33 既有 S2（hire-executing）/ S4（hire-succeeded）互补，四态机现齐
  S1 草稿 / S2 执行 / S3 拒绝（见下）/ S4 成功。

## ② S3 失败/拒绝态 —— drawer-s3-rejected.png（补拍）

- stub 以 `OWB44_VALIDATE=reject` 使闸门一 `hire validate` exit 1 +
  `{status:"failed", code:"hire_request_rejected", message:"evidence-44 simulated gate-1 rejection: …"}`；
- 填表（R2 拒绝演示员 / r2-reject-demo / 职责 / 20000 / 200000）点「开始创建」后：
  Drawer 渲染错误图标 + `hire_request_rejected` + 诚实文案
  「创建被拒绝；hire 契约面未产生任何效果，已填内容保留。」+「修改后重试」/「重试」；
- 无副作用断言：`/tmp/owb-44-ws/.digital-employee/packages/` 不存在（无 staged 骨架），
  `org.json` 未写入（仅既有 org-layout.v1.json / workbench），闸门一 fail-closed 成立。

## ③ issue-32 拖拽证据核实 —— 无需补拍

- `docs/evidence/issue-32/`（reorder-applied.png / undone.png / hire-entry.png + README）
  已随 828834d 入仓；三件均为真 PNG（2480×1544），README 含 CDP 断言时间线
  （⌘↑ 排序生效 + overlay 600 落盘 + 撤销消费 + 二次撤销 404）；核实通过。

## ④ #25 Slice B 审批卡证据源 —— 无需补拍

- `docs/evidence/issue-25/README.md` 下半部即 Slice B 取证：独立控制面 + curl 全链路
  （turn1 审批门 engine.approval_required / turn2 granted 续跑信封摘要互验 /
  decidedBy≠operator fail-closed 400 / 历史回读 / SSE wire capture），
  随 76fbbd2 入仓；renderer 侧审批卡片另由 approval.test.tsx（4 例）+
  approval-ipc.test.cjs（3 例）覆盖。证据源确认。

## 回执路径

- docs/evidence/issue-44-r2/drawer-s1-open.png
- docs/evidence/issue-44-r2/drawer-s3-rejected.png
- docs/evidence/issue-44-r2/timeline-phase1.txt
- docs/evidence/issue-44-r2/timeline-phase2.txt
- docs/evidence/issue-44-r2/README.md（本件）
