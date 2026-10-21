# 验证记录

日期：2026-10-13。使用独立工作区，不修改用户已有的 RoleWeave 工作区或运行数据。

## 环境

- RoleWeave 基线：`245283ee`（从 origin/main 创建案例分支）。
- Node.js：`24.11.1`；Ubuntu 22.04 / WSL。
- design-system：CI 固定提交 `4a82fce41f89f1a55b6b02cdb54f7a4e9ce9d84d`。
- digital-employee 源码：`8a8a2a3`，manifest 声明 `0.6.1`。这是源码验证环境，不声明对应 npm 版本已发布。

## 已验证

| 验证项 | 结果 | 说明 |
| --- | --- | --- |
| 参考库 | 25 个稳定 ID，来源和协作引用完整 | CDO/CPO/CCO/CRO/CSO 等重名缩写不合并岗位 |
| 场景包 | 3 + 9 个岗位，共 12 包通过框架 validate | 使用 employee-package.v1alpha1；不增加 CLI 内置模板 |
| 包摘要 | 12 个框架目录摘要与声明一致 | 使用整包字节；不只散列 employee.json |
| 组织应用 | 两个副本分别得到 3 和 9 个岗位 | 汇报关系与场景定义一致，无虚假移动或裁撤 |
| 重复应用 | 两个副本均无变更 | 所有 changed 集合为空 |
| 控制面使用 | 两个场景均可打开，组织树岗位数正确 | 实际 HTTP 路由，工作区使用临时副本 |
| 群组协作 | 两个场景的并行和接力完成并有记录 | 接力收到前驱可信结果；并行不假定启动顺序、不转发同批次成员输出 |
| 重启回读 | 记录身份保持一致，没有重复调用驱动 | 群组操作不改变组织定义、预算或授权 |
| 资产回归 | 修改岗位包字节或源目录资料会被拒绝 | CI 的文件指纹与源渲染对比，不冒充框架校验 |
| 跨平台字节 | 案例范围固定 LF 换行 | 避免 Windows checkout 换行转换破坏摘要或生成文件指纹 |
| 完整仓库检查 | `npm run check` 通过，退出码 0 | 构建、脚本测试、UI 和 renderer 类型检查/测试、服务端测试、桌面测试、依赖安全检查 |

## 复现命令

```bash
node scripts/cxo-examples.mjs check
node scripts/cxo-examples.mjs validate --framework-root /path/to/built/digital-employee
npm run build
node --test scripts/test/cxo-examples.test.mjs apps/server/dist/test/cxo-examples.test.js
npm run check
```

控制面测试使用确定性 `TurnRunDriver` 和真实工作区/群组路由。框架组织应用在独立副本上运行，并清理应用态；已提交的场景不含 `.digital-employee/`、`.roleweave/`、Agent 绑定或凭据。

## 真实模型验收边界

上述验证没有调用真实模型。当前所用框架的隔离服务适配器 doctor 检查中，Qoder 缺服务 token，Claude 缺 API key；因此没有把本机 CLI 安装或确定性驱动结果当作真实模型成功。该检查不代表 RoleWeave 桌面的其他连接方式不可用。

真实模型验收应复制场景、连接参与岗位的 Agent，按 walkthrough 执行并由用户检查阶段产出与完整验收项。这一步尚未验证；实际模型质量、额度、上下文和真实业务效果不能由本记录证明。

通用能力缺口另见 [缺口清单](../../docs/design/cxo-example-capability-gaps.md)。

## 2026-10-14：执行团队补充

新增 `ai-product-delivery` 场景：五个经营职能、十四个专业岗位，共十九个岗位。产品、研发、市场、交付运营四条 runbook 都通过现有群组接口使用；方法来源、交接、验证、升级及复盘模板单独列在案例资料中。

这次验证使用 RoleWeave 基线 `28ba55aa`，Node 24.11.1 / Ubuntu 22.04 WSL、同一 CI 固定 design-system 和框架源码 `8a8a2a3`。原来的两个场景仍保留，所有三个场景共 31 个岗位包。

- 31 个岗位包均通过真实框架 validate，目录摘要与声明一致；三个场景的组织 apply 得到 3、9、19 个岗位，重复应用无变更。
- 四个团队的每个阶段都通过真实 HTTP 群组路由派发，只调用显式选择的专业岗位；sponsor 没有被自动加入或调用。
- 由测试客户端选择可信产出并作为下一阶段 input 传递，覆盖产品→研发/市场→交付的跨团队材料接缝；未增加隐式共享或自动 DAG 调度。
- QA 的 FAIL 仍属于 completed 的业务报告，不伪装成模型执行失败。测试覆盖 FAIL→用户发起修复→复验 PASS，以及三次验证 FAIL 后由客户端停止并升级的示例路径。
- QA FAIL 后没有自动派发；修复仅调用指定实现岗位，测试岗位不加入实现名单，其他团队没有被激活。NOT_VERIFIED fixture 保留证据不足的状态。
- 来源校验拒绝跨团队收件人、循环/前向依赖、不受限的修复次数和实现者自验收配置。快照比较按整组文件内容区分同一岗位在不同场景中的包，避免只按 role ID 误用摘要。
- 本轮完整 `npm run check` 通过，构建、脚本/组件/服务端/renderer/桌面测试及依赖安全检查均完成；依赖 audit 为零漏洞。新增来源约束和 QA 缺证据断言另通过针对性测试。

复现新测试：

```bash
npm run build
node --test scripts/test/cxo-examples.test.mjs apps/server/dist/test/cxo-examples.test.js apps/server/dist/test/cxo-team-runbooks.test.js
node scripts/cxo-examples.mjs validate --framework-root /path/to/built/digital-employee
npm run check
```

这些 HTTP 测试仍使用确定性驱动和合成产出，没有调用真实模型，也没有运行生成的软件、采集真实客户反馈或发布部署。人工 runbook 上限不是平台新加的全局循环限制。真实模型与文件执行的验收边界保持如上。
