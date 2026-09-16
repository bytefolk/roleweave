# ADR-0002: 引擎消费形态 —— spawn 钉版 CLI 子进程

状态：已决（CEO 拍板，D0 落地）｜ 日期：2026-08-23

## 决策

控制面消费 digital-employee 引擎的唯一形态是 spawn 子进程：组织生效运行钉版 `digital-employee org apply <workspace> --json`；D3 回合执行运行 `digital-employee turn run <workspace> --position <id> --stdin`，stdin 为密封 `turn-envelope.v1`，stdout 为严格 `engine.v1` NDJSON。凭据仅经最小环境白名单注入，输入与凭据均不进 argv。

## 备选与否决理由

- 同进程 import：引擎未稳定前耦合过深、版本漂移不可审计；留作引擎稳定后的优化项，不作为骨架形态。
- git submodule / monorepo 合并：违反独立仓库决策与"钉版即证据"纪律（见骨架定稿第一节三案对比，npm 钉版方案 A 胜出）。

## 同构性

spawn+stdout 结构化事件与 agent-host.v1 进程模型/NDJSON 事件流同构：每回合一个子运行，事件流即证据流；换装外部宿主零改动。

## 钉版纪律

引擎首版未发布前，开发期允许以 `ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI` 指向本地构建入口；CI 与正式包只认精确钉版。`/health` 必须报告 CLI 可用性与版本，不可用时给出下一步。

## 后果

- CLI 缺少 `org apply` 时驱动层如实返回 `engine_capability_missing`（503）；可用时严格按 JSON `status` 判断，不以退出码 0 冒充 applied。
- D3 只接受 `qoder` / `claude-code` / `claude-local` / `codex` / `codex-local` / `workbuddy`。退出码 1 是不确定结果，不自动重试；引擎事件、输入、输出与诊断全部有界，原始 stderr 不进入本地持久化。
- 会话/回合是 workbench 工作区本地状态，不复用 Host 原生 resume；当前只保留 digital-employee #158 的 recall 接缝，不声称 mem recall 已完成。
