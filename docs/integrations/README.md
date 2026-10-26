# 外部工具集成指南

本目录收录"外部工具如何安全消费 RoleWeave 控制面"的集成指南。所有指南遵守
[`docs/api-contract-v0.md`](../api-contract-v0.md) 的冻结形状与 §4 安全基线；
若指南与契约冲突，以契约为准并提 issue。

| 指南 | 外部工具 | 说明 |
|---|---|---|
| [orca-supervisor.md](./orca-supervisor.md) | [Orca](https://github.com/stablyai/orca)（AI 代理舰队编排器） | 配对流程、快照轮询、SSE 事件消费、移动端通知候选事件；参考客户端 [`examples/orca-supervisor-client.mjs`](../../examples/orca-supervisor-client.mjs) |

通用纪律（适用于任何外部监督面板/插件）：

1. **凭据最小化**——boot-token 只落本机内存，不写文件、不进日志、不出本机；
2. **只读优先**——监督场景不应持有任何写端点权限；
3. **不回显正文**——事件与回合的任务文本、prompt、stderr 不进入外部面板的日志或通知。
