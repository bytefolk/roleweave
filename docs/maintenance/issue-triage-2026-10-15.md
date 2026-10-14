# RoleWeave issue 核对 — 2026-10-15

核对基线：`2ad8536001c2f282ee28dfba1cf3e035438f0a5c`，48 个 open issue，14 个 open PR。状态是核对结论；实际关闭以 GitHub issue 记录为准。

本轮处理 UTF-8 解码、Vault 检索、计划负责人图谱、Gemini 取消回收，以及 #555 的主题磁盘恢复测试。新旧模型工具审批桥接仍需独立实现；本轮工作区受控审批试用不证明该桥接已完成。

## 可关闭或本轮修复

| Issue | 结论 | 依据 |
| --- | --- | --- |
| [#582](https://github.com/bytefolk/roleweave/issues/582) | 关闭依据已核验 | v0.4.0 已公开；tag 指向 #583 的 db027d41；发布工作流成功；9 个下载资产的大小与 SHA-256、更新签名、Windows SHA-512 和包版本均已核对。 |
| [#555](https://github.com/bytefolk/roleweave/issues/555) | 本 PR 修复后关闭 | 新增真实 JSONC 存储驱动的设置界面测试，覆盖 light/dark/system、保存前不生效、缓存丢失后的启动恢复。 |
| [#552](https://github.com/bytefolk/roleweave/issues/552) | 关闭依据已核验 | #553 已合入；mem/bdpan 来源、显式错误、超时、输出上限和参数传递测试通过。errno=-7 已按后续证据改为上游失败。 |
| [#547](https://github.com/bytefolk/roleweave/issues/547) | 关闭依据已核验 | 锁文件所有 brace-expansion 为 1.1.21、2.1.7 或 5.0.12；当前 npm audit 为 0 漏洞。 |
| [#512](https://github.com/bytefolk/roleweave/issues/512) | 关闭依据已核验 | #513 已合入，组件保留未保存的 PAT；背景刷新回归通过，多次后续 Ubuntu main 检查成功。最新失败属于 Gemini 进程回收，另在本 PR 修复。 |
| [#361](https://github.com/bytefolk/roleweave/issues/361) | 关闭依据已核验 | #554/#549 与 #499/#500 已交付当前审批/上报工作台；断线快照、真实统计、精确来源跳转和中英文/主题已有验收及回归。当前用户授权检查整个仓库，先前仅因清理范围而重开的原因已解除。 |

## 继续处理的事项

优先补齐真实模型审批和 host 进度/断线恢复，再完成正在评审的协作区、岗位文档生命周期与 marketplace 接口；签名和跨仓记忆契约按各自上游依赖推进。

| Issue | 尚需完成 |
| --- | --- |
| [#558](https://github.com/bytefolk/roleweave/issues/558) | acceptance.v1 契约已合入 #559；作者随后将文档协作 UI 纳入跟踪，#560 仍为 draft。契约测试通过不能代替 UI 交付。 |
| [#544](https://github.com/bytefolk/roleweave/issues/544) | 依赖 digital-employee-platform#21 的买方 HTTP 面；当前招聘接口不接收 marketplace listing。 |
| [#539](https://github.com/bytefolk/roleweave/issues/539) | #540 尚未合入；商业交付验收与执行权限审批的边界需要评审。 |
| [#535](https://github.com/bytefolk/roleweave/issues/535) | #536 尚未合入，真实 marketplace 数据源与招聘交接仍需上游。 |
| [#519](https://github.com/bytefolk/roleweave/issues/519) | #524 尚未合入；其 stub 登录也不能完成 #395 的真实部署身份认证。 |
| [#516](https://github.com/bytefolk/roleweave/issues/516) | 仍需验证断线补齐和真实 host-reported 步骤；本地五阶段进度不是 host 工具执行进度。 |
| [#511](https://github.com/bytefolk/roleweave/issues/511) | 本地笔记库 #574 已交付，完整 live-preview、自动保存、光标/草稿保留与外部修改冲突流仍不能由该基础能力推定完成；#505 前置仍未合。 |
| [#485](https://github.com/bytefolk/roleweave/issues/485) | OpenAI-compatible 技术实现已合入；仍缺本 issue 要求的真实 provider 回合产品验收。 |
| [#468](https://github.com/bytefolk/roleweave/issues/468) | 独立 PR #502 尚未合入；建议仅作 advisory，仍需评审其边界及当前 main 集成。 |
| [#467](https://github.com/bytefolk/roleweave/issues/467) | 独立 PR #508 尚未合入；建议仅作 advisory，仍需评审其边界及当前 main 集成。 |
| [#466](https://github.com/bytefolk/roleweave/issues/466) | 独立 PR #506 尚未合入；建议仅作 advisory，仍需评审其边界及当前 main 集成。 |
| [#465](https://github.com/bytefolk/roleweave/issues/465) | 独立 PR #504 尚未合入；建议仅作 advisory，仍需评审其边界及当前 main 集成。 |
| [#464](https://github.com/bytefolk/roleweave/issues/464) | 独立 PR #492 尚未合入；建议仅作 advisory，仍需评审其边界及当前 main 集成。 |
| [#463](https://github.com/bytefolk/roleweave/issues/463) | 独立 PR #491 尚未合入；建议仅作 advisory，仍需评审其边界及当前 main 集成。 |
| [#461](https://github.com/bytefolk/roleweave/issues/461) | 独立 PR #507 尚未合入；建议仅作 advisory，仍需评审其边界及当前 main 集成。 |
| [#452](https://github.com/bytefolk/roleweave/issues/452) | #493 尚未合入且仅设计；同一共享频道的多轮唤醒、人工插话与有界上下文仍需 runtime。 |
| [#428](https://github.com/bytefolk/roleweave/issues/428) | Goals/Reports overlay 切片存在；尚无本 issue 的完整产品走查与接受记录。 |
| [#422](https://github.com/bytefolk/roleweave/issues/422) | RFC 及多条后续故事，默认关闭的基础适配器和部分已合切片不等于整项完成。 |
| [#395](https://github.com/bytefolk/roleweave/issues/395) | 缺少按部署登录、会话恢复、失效与独立退出的完整已交付路径。 |
| [#363](https://github.com/bytefolk/roleweave/issues/363) | 看板/排期已交付；仍需按完整 AC 核验依赖编辑、键盘时间轴操作、可操作日期及完整目标归属。 |
| [#356](https://github.com/bytefolk/roleweave/issues/356) | 多 Agent checkpoint 分支与合并记录依赖 Gate D0 和 digital-employee#328。 |
| [#355](https://github.com/bytefolk/roleweave/issues/355) | 权限化 pin/disable/inspect/forget 依赖 #354 和 mem#220。 |
| [#354](https://github.com/bytefolk/roleweave/issues/354) | 依赖 #327 与 digital-employee#327 的 accepted assembly receipt。 |
| [#353](https://github.com/bytefolk/roleweave/issues/353) | 耐久写入前的秘密与 PII 清理依赖记忆平面契约；本地公开文本过滤不能代替全部 AC。 |
| [#352](https://github.com/bytefolk/roleweave/issues/352) | 路由设计 #378 已合；仍待 Gate D0 对路由表和 AC 的产品接受。 |
| [#351](https://github.com/bytefolk/roleweave/issues/351) | 需要在跨仓记忆装配接口证明恶意 recall 只被省略或引用，不进入高权限消息。 |
| [#350](https://github.com/bytefolk/roleweave/issues/350) | 设计文档曾误触关闭后重开；memory pack 导入/导出未交付。 |
| [#349](https://github.com/bytefolk/roleweave/issues/349) | private/position/team grants 尚为设计；handoff 引用不授予额外权限。 |
| [#348](https://github.com/bytefolk/roleweave/issues/348) | remember/correct 的耐久写入与使用回执依赖 #327 Gate D0。 |
| [#347](https://github.com/bytefolk/roleweave/issues/347) | #505 仍为 draft；岗位知识文档的编辑、改名、归档、恢复、删除与本地化需完成交付。 |
| [#333](https://github.com/bytefolk/roleweave/issues/333) | 目标执行和图投影有实现；本 PR 只补计划负责人关系，不代表完整目标、分支、依赖、交接与证据地图全部验收。 |
| [#328](https://github.com/bytefolk/roleweave/issues/328) | 对象→决策→审批→幂等执行→真实 readback 仍缺完整运行证据与跨仓 owner 决策。 |
| [#327](https://github.com/bytefolk/roleweave/issues/327) | 记忆平面 Gate D0 与跨仓契约尚待冻结/接受；本地 Vault 不代替耐久记忆平台。 |
| [#246](https://github.com/bytefolk/roleweave/issues/246) | 预设与手动配色已有实现；未核验真实 Agent 生成、细化、预览、确认保存及重置的完整产品路径。 |
| [#136](https://github.com/bytefolk/roleweave/issues/136) | 已决策采购 OV/EV，尚缺签名身份、凭据和真实签名安装/更新验证。 |
| [#121](https://github.com/bytefolk/roleweave/issues/121) | 当前仍使用 @fullstack-ai-infra/ui；上游包身份与双消费模式迁移未完成。 |
| [#110](https://github.com/bytefolk/roleweave/issues/110) | 已发布安装包和更新链路，但原始完整结果还要求签名安装与开箱使用证据；不能用 unsigned release 关闭。 |
| [#89](https://github.com/bytefolk/roleweave/issues/89) | 岗位 MCP 声明存在不代表 bundled engine 的运行权限链已实现。 |
| [#87](https://github.com/bytefolk/roleweave/issues/87) | 上游 host_policy 的网络执行链未完成，不能仅开放 UI 开关。 |
| [#68](https://github.com/bytefolk/roleweave/issues/68) | 缺 engine 回显灰度全量确认收据；仍保留 groupRef 读兜底/双写，不能当作已清偿。 |
| [#37](https://github.com/bytefolk/roleweave/issues/37) | 簇锚点仍受 #36 的设计和验收约束。 |
| [#36](https://github.com/bytefolk/roleweave/issues/36) | 项目资产沉淀、索引、会话引用跳转与来源追溯的完整设计/产品验收尚未完成。 |

## 证据入口

- #512 原草稿问题由 [PR #513](https://github.com/bytefolk/roleweave/pull/513) 修复；[连续成功的 main verify](https://github.com/bytefolk/roleweave/actions/runs/38285336896)、[后续 run](https://github.com/bytefolk/roleweave/actions/runs/38328720804)、[后续 run](https://github.com/bytefolk/roleweave/actions/runs/38490813460)。最新 [run](https://github.com/bytefolk/roleweave/actions/runs/38609092416) 的失败是 Gemini 子进程回收断言。
- #361 的完整交付见 [PR #554](https://github.com/bytefolk/roleweave/pull/554)、[issue #549](https://github.com/bytefolk/roleweave/issues/549) 和 `docs/design/inbox-workbench-v1.md`。本地重新运行了完整检查，并保留既有界面验收证据。
- #582 的 [公开 v0.4.0 release](https://github.com/bytefolk/roleweave/releases/tag/v0.4.0)、[发布工作流](https://github.com/bytefolk/roleweave/actions/runs/37962360747) 指向 `db027d41ed837f5aadbc500c07c8e9538244ec8f`；下载了全部 9 个资产并逐一核对 API 的 SHA-256，使用仓库验证器核验 macOS 签名清单和 Windows installer SHA-512。macOS ZIP 内 package.json 为 0.4.0；公开正文与冻结 release notes 相同。
- #555 测试使用临时目录内的真实 `createConfigurationStore`，通过界面保存后重建 store 与 bridge，再清空 renderer 缓存验证磁盘恢复；测试不依赖用户配置或真实凭据。
