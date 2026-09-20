# 审批中心 P0 实现

日期：2026-09-18

## 行为

审批中心和会话卡通过同一个本地审批服务读取状态和提交裁决。服务端绑定原岗位、原会话、原回合与引擎；默认批准范围为 `once`，保留原到期时间。裁决保存与后续执行结果分别展示。

个人 session 和旧版岗位会话可以裁决。群聊来源只读展示，批准和拒绝按钮固定禁用，不能由审批中心裁决；已归档会话必须重新发起任务。旧接口直接提交 `pendingApproval` 返回 `409 approval_endpoint_required`，不会启动引擎。

批准或拒绝会启动一条携带 `pendingApproval` 的新恢复回合；原始 `engine.approval_required` 回合及其事件记录保持不变，不会在原回合上续写或改写终态。

### #401：一次性与本回合范围

引擎可以在 `approval.requested.action.scope` 中声明 `approval-scope-offer.v1`。`allowed` 必须以 `once` 开始；只有同时声明 `run` 和 `runBinding` 时，才可能选择本回合范围。`runBinding` 是 `sha256:` 加十六进制 SHA-256，输入为 shared 的 `approvalRunScopeBindingInput(approvalId, sourceRunId, {kind, description, target}, expiresAt)` 的规范 JSON。

服务端重新计算摘要并在写入裁决前比对：绑定到不同审批编号、请求 run、动作（含目标）或有效期的 offer 一律不能升级为 `run`。`run` 只允许批准，不允许拒绝；来源已过期、失配、重放或版本冲突仍按原路径拒绝。审计记录持久化实际 `decision.scope`，同一个 `requestId` 重试时必须携带完全相同的范围。

对 UI，服务端只投影校验通过的 `context.scope.allowed`；默认与旧记录均仅显示“仅此动作”。选择“仅本回合”仅会把该恢复回合的 `pendingApproval.scope` 设为 `run`，不会放宽该岗位、后续回合或其他动作。审批历史显示实际生效范围。

## 接口

- `GET /approvals?status=all|pending|decided&limit=50&cursor=...&workspacePath=...`：返回分页 items、pendingCount、revision、workspaceToken、nextCursor 和 syncState。limit 最大 200。快照改变后旧游标返回 `409 approval_snapshot_changed`。
- `GET /approvals/:id`：详情含 `canDecide` 和 `unavailableReason`。
- `POST /approvals/:id/decision`：请求包含 `workspaceToken`、`requestId`、`expectedVersion`、`decision`、可选 `scope`（省略即 `once`）和可选 `reason`。理由上限为 1024 UTF-8 字节。`scope: run` 仅接受引擎声明且服务端验证了绑定的批准请求。
- 首次持久化成功返回 202；相同请求幂等返回 200；相反裁决、旧版本或工作区实例失配返回 409；过期返回 410；格式错误返回 400。
- `approvals.changed` 在记录落盘后发布，携带工作区路径、审批记录 ID 和版本。客户端将 SSE 作为刷新提示，重连、聚焦、返回审批中心及每 10 秒补查快照。

审批记录 ID 是来源元组的 SHA-256，包括来源种类、会话、岗位、回合、引擎 runId 及审批编号。与初稿随机 UUID 的区别：历史扫描重入时无需另建去重索引即可得到同一 ID。工作区仍独立存储。

## 存储和恢复

记录位于 `.digital-employee/workbench/approvals/<id>.json`。写入复用回合存储的原子写与同步机制；读取限制大小并拒绝符号链接。`writer.json` 为本机单写控制平面锁，持有至服务关闭；活进程占有时第二个服务返回 409。死进程的锁在独占 reclaim 锁内接管；异机、损坏或接管中断的锁不会被盲目删除。

首次查询在服务端扫描现有持久化回合并补建审批；沿用报告存储的扫描上限，超限或损坏返回错误，不能当成空列表。P0 使用完整有界扫描，再对结果分页；大规模异步历史索引尚未实现。

裁决与固定恢复回合 ID 同时落盘为 `starting`，随后创建新回合。与方案初稿的 `queued` 自动恢复不同，P0 选择保守策略：启动意图已保存但未发现可信完成记录时，重启后标记 `indeterminate`，不自动重放。这样不会在“动作已执行、完成记录未保存”的情况下再次产生副作用。

若回合已完成但审批未更新，按恢复回合 ID 对账。批准完成还要求出现对应 `approval.granted` 证据；拒绝通过 `engine.approval_denied` 归为正常拒绝结果。尚未发送到引擎即过期的裁决保持已批准历史，但执行结果显示失败。

旧版裁决事件仅在同一来源会话内能唯一匹配时导入；无法确定的记录保留为待核实。单靠旧记录缺失裁决证据，无法证明过去没有发生过未持久化的外部动作。

## 测试

在 org-workbench 根目录执行：

```sh
npm run build
node --test apps/server/dist/test/approvals-center.test.js apps/server/dist/test/approval.test.js apps/server/dist/test/reports.test.js
npm run test:renderer -- approvals-state.test.tsx approval.test.tsx approval-queue.test.tsx turn-progress-interaction.test.tsx
node --test apps/desktop/test/approvals-center-ipc.test.cjs
npm run typecheck:renderer
npm run typecheck:ui
npm run build:renderer
```

可选真实引擎门控测试：设置 `APPROVAL_ENGINE_MODULE` 为本地已构建的 digital-employee engine index.js 的 file URL，再运行 `approvals-center.test.js`。未设置时该用例明确跳过。测试使用真实引擎执行器和确定性模型端口，覆盖批准后调用模型、拒绝/过期不调用模型；不连接付费模型或实际外部写工具。

完整回归使用 `npm run check`。新增用例覆盖来源隔离、重试幂等、相反裁决、失效、重启对账、第二写进程拒绝、存储损坏、分页变化、客户端旧响应隔离与断线重连。

## 兼容性和限制

- 需要同时更新桌面客户端和本地服务：旧客户端的直接裁决路径已关闭。
- Windows 目录 fsync 的耐久性限制沿用现有原子写实现。
- 已接受的恢复若因工作区切换或崩溃未能完成，不自动执行第二次；页面保留结果待核实。
- 历史扫描不是常驻全量索引；分页读取会核对完整有界快照。
- 群聊恢复、多审批人权限、批量批准和外部通知不属于本期。
