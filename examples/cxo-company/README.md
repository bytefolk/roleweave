# CXO 公司参考案例

用现有 RoleWeave 岗位、组织树和群组协作能力组合一家 AI 公司。CXO 是案例中的职责配置，不是产品新增的公司类型、特权岗位或执行分支。

## 内容

- [岗位参考库](role-catalog/README.md)：25 种职能，含职责、输入、交付物、协作关系、执行岗位建议与权限边界。缩写不作唯一标识。
- [入门公司](scenarios/starter/README.md)：CEO、CTO、COO，三个独立岗位。
- [AI 产品公司](scenarios/ai-product-company/README.md)：九个职能。设计官向产品官汇报，其余职能向 CEO 汇报；这只是案例选用的结构。
- [需求到产品验证方案](walkthroughs/README.md)：合成业务需求、并行评估、接力交付和人工验收。
- [通用能力缺口](../../docs/design/cxo-example-capability-gaps.md)：与案例资产分开记录，待独立功能设计。

岗位库是可选的职责资料，不是必须同时运行的 25 个员工。只有场景选中的岗位会形成员工包。执行团队建议中的工程师、研究员等不会被自动招聘。

## 在 RoleWeave 中使用

1. 将 `scenarios/starter/` 或 `scenarios/ai-product-company/` **整个目录复制到仓库外的新目录**。每个副本是一家独立公司。不要直接打开已提交的案例目录，避免把运行状态写回源码。
2. 在 RoleWeave 中使用现有“打开项目”入口选择副本。组织树从副本的岗位目录和组织清单读取；本案例没有新增创建向导。
3. 在每个参与岗位的设置中选择并连接本机 Agent。快照没有预置 Agent 绑定、凭据或在线状态。连接检查成功也不保证模型调用成功。
4. 将示范需求发给 CEO，审阅目标、未知项及组队建议。建议只是会话产出；用户使用现有招聘、岗位配置和群组入口落实决定。
5. 按 [示范任务](walkthroughs/README.md) 显式选择群组成员，并选择并行或接力模式。相同岗位可出现在不同群组；每个岗位在同一工作区仍受一个活动执行的限制。
6. 用户检查群组时间线和每个岗位的产出，依据示范任务中的标准验收。交付在会话中完成；当前只读案例不会生成软件、写文件或联系真实客户。

组织树是长期汇报关系；群组是本次协作成员集合。组群不改变汇报关系，也不合并权限和预算。CEO、CFO 等头衔不会绕过控制面的组织变更或资源授权。

## 格式与权限

场景使用现有 `workspace.v1alpha1`、`workspace-org.v1` 和 `employee-package.v1alpha1`。`workspace.json` 的 `template` 仅记录案例来源；框架没有因此新增 `workspace init --template cxo-*`。

每个岗位包含 `employee.json`、`SKILL.md`、输入输出 schema、批准的合成知识、离线 eval fixture 和 `budget.json`。默认 `read_only`，工具为 Read/Grep/Glob，网络拒绝，文件写权限为空，MCP 为空。`work/` 目录是后续交付位置，不授予写权限；`context/` 中的文件也不会因存在而自动进入 Agent 上下文。示范需求应放入本次输入，岗位自己的知识目录中另有相同资料。

预算沿用现有开源维护示例的初始上限：CEO 每任务 40,000 tokens / 12 iterations、每日 400,000 / 96；其余岗位每任务 20,000 / 8、每日 200,000 / 64。这是演示资源上限，不是推荐用量、共享团队预算、货币预算或实际消耗。

`role-catalog/*.json`、`scenarios.json` 和 `walkthroughs/*.json` 的 `cxo-example-*` 标签是案例资产格式，**不是新的平台 API 契约**。

## 生成与校验

职责来源是手工维护的参考资料，见 [sources.json](role-catalog/sources.json)。职称来源与 AI 化交付方法分开标注；历史披露不代表当前任职。

修改源资料后，在一个干净、尚未打开的案例快照中重新生成。传入一个已构建、导出 `computeEmployeePackageDigest` 的 digital-employee 源码目录；不把框架复制到 RoleWeave，也不改它的模板注册表：

```bash
node scripts/cxo-examples.mjs generate --framework-root /path/to/digital-employee
node scripts/cxo-examples.mjs check
node scripts/cxo-examples.mjs validate --framework-root /path/to/digital-employee
```

岗位包摘要由框架公开的摘要函数计算，覆盖 manifest、提示词、schemas 和声明的 assets；不能只对 `employee.json` 求散列。生成后不要手改场景文件。`generated-files.json` 记录源文件和生成文件的普通 SHA-256，供 CI 检查资产是否过期；这个文件完整性检查不能代替框架的岗位包校验和摘要计算。

针对副本执行框架组织校验：

```bash
node /path/to/digital-employee/dist/apps/cli/bin.js org apply /path/to/company-copy --json
node /path/to/digital-employee/dist/apps/cli/bin.js org tree /path/to/company-copy --json
```

验证范围见 [验证记录](verification.md)。离线 eval 和确定性测试驱动不会调用模型，也不能证明实际模型质量；真实 Agent 验收需在连接 Agent 后完成。
