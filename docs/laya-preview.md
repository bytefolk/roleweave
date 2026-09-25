# 智能协作建议（本地 Laya）

跟踪：[#447](https://github.com/bytefolk/roleweave/issues/447)。产品方案见 [#446](https://github.com/bytefolk/roleweave/pull/446)，研究背景见 [#422](https://github.com/bytefolk/roleweave/issues/422)。

## 隐私与费用边界

RoleWeave 的决策模型是开源 Laya，经本地 `POST /v1/systemone` 调用。只允许连接回环地址。默认地址是 `http://127.0.0.1:18081/v1/systemone`；非 `http`、非 loopback、带凭据、查询参数或其他路径的地址都会被拒绝并回退到默认地址。请求不带 API Key 或 Authorization header，不访问外部决策服务，也不产生外部模型费用。

模型权重首次下载需要由维护者单独完成。启动后推理在本机执行；RoleWeave 不会自动下载权重，也不会把业务数据发送给 Hugging Face。若本地服务未运行，建议功能有界失败，原始规则、执行记录和操作入口保持可用。

## 使用场景

负责人在上报中心看到失败执行，希望知道下一步该检查预算、Agent 连接还是执行记录。项目中的预览开关仍默认关闭。开启后，只有用户在上报中心主动点击“生成建议”才会调用本机 Laya；建议不会自动重试、派工、批准或改变权威状态。

每次最多检查最近 20 条失败或待确认记录。相同快照可复用本项目最近 5 分钟的结果；失败缓存 30 秒。切换项目或关闭开关会取消本地待处理请求并丢弃迟到结果。

## 本地数据范围

报告建议只向本机 Laya 进程传入执行状态、规范化错误码、是否与预算相关三个元数据字段，以及固定 Choice 问题。发送前预算建议只传入 `{ remainingPerTask, remainingPerDay, positionId }`；客户端不能上传额度、使用量、剩余额度或草稿。上游预算按 `(positionId, taskId, dayKey)` 记账，而当前 RoleWeave 记录没有权威的 `taskId` 和 `dayKey`，因此单任务与单日剩余均保持未知并在调用 Laya 前弃权；不复用上一任务用量，也不从累计使用量或本地日界线猜测。未知错误码归入 `other`。关联 ID、员工姓名、汇报链、项目路径、消息、任务、文档和附件正文不会进入推理请求。

Laya 输出只能选择本地定义的调查步骤。低置信度显示“信息不足”；当前 `0.6` 阈值是保守保护线，不是业务准确率承诺。规则事实仍然权威，Laya overlay 不能降低风险、清除失败或替代产品验收。

## 启动本地服务

推荐固定版本部署并预先下载模型。Laya 提供本地 System One HTTP 服务；示例：

```bash
python3 -m venv ~/.roleweave/laya-venv
~/.roleweave/laya-venv/bin/python -m pip install 'laya[serve]==0.3.11'
LAYA_HOST=127.0.0.1 LAYA_PORT=18081 LAYA_MODELS=typed-decisions LAYA_PRELOAD=1 \
  ~/.roleweave/laya-venv/bin/laya-serve
```

实际命令以所固定 Laya 版本的帮助信息为准。生产或长期使用应固定软件版本、模型 revision 和权重摘要，并在下载完成后验证离线启动。不要把服务绑定到 `0.0.0.0`。

可选环境变量：

| 环境变量 | 用途 |
| --- | --- |
| `ROLEWEAVE_LAYA_ENABLED` | 设为 `1`、`true` 或 `yes` 后启用本地 provider；仍需在项目设置里明确开启预览 |
| `ROLEWEAVE_LAYA_URL` | 可选回环 URL，默认 `http://127.0.0.1:18081/v1/systemone`；外部 URL 会被拒绝 |
| `ROLEWEAVE_LAYA_MODEL` | 可选，默认 `typed-decisions` |
| `ROLEWEAVE_LAYA_TIMEOUT_MS` | 可选，默认 2000 ms，运行时限制在 100–5000 ms |

变更环境后重启控制面。Windows WSL 模式只转发这些非秘密配置；不存在外部决策 API Key。

## 控制面 API

四个端点继续使用既有 boot-token 鉴权：

- `GET /experiments?workspacePath=…`：读取项目开关、本地服务状态和回环地址。
- `PATCH /experiments`：按 revision 保存项目开关。
- `POST /reports/advice`：服务端读取真实报告并调用本地 Laya；客户端不能上传任意判断正文。
- `POST /turns/budget-remaining-advice`：服务端按绑定的工作区、设置 revision 与岗位读取权威报告，只在单任务和单日剩余都已知时请求固定的 `shrink | switch_employee | send_anyway` Choice；点击建议不会创建 turn 或修改 hire 预算。

项目状态仍存于 `.roleweave/experiments.v1.json`。文件缺失默认项目开关关闭；损坏、回滚或不安全路径会 fail closed。

## 验证边界

自动化测试覆盖项目默认关闭、显式开启、loopback-only、无 Authorization header、受限字段、批量上限、缓存去重、超时、非法答案及关闭/切换竞态。契约测试不证明 Laya 在真实业务样本上的准确率；模型升级前仍需独立标注集、置信度校准和人工验收。
