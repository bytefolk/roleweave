# examples/oss-maintainer

示例工作区：开源维护者组织（1 owner + 3 岗位），与 #163 展示同源形状。

生成方式（保证与引擎契约同源）：

1. 用支持目录组织契约的 digital-employee CLI 物化骨架：`digital-employee workspace init examples/oss-maintainer --template oss-maintainer-zh`；
2. `positions/repo-owner/` 下嵌套三个下属岗位，父子目录即汇报线；
3. 每个岗位目录携带 `budget.json`：repo-owner 为 perTask 40,000 tokens / 12 iterations、perDay 400,000 / 96；其余岗位为 perTask 20,000 / 8、perDay 200,000 / 64。

岗位名、描述、`SKILL.md` 正文与 knowledge/context 占位文本为中文，与产品自身的岗位骨架生成器保持一致（`writeProjectSkeleton` 的「项目负责人」、`buildPositionSkeletonFiles` 的中文 `SKILL.md`）。这些文案来自上游模板，不在本仓库手工翻译——`package.digest` 覆盖整个岗位包，手改 `SKILL.md` 会让摘要失效。本目录由 digital-employee `2ecb215`（bytefolk/digital-employee#266）的 `oss-maintainer-zh` 模板重新生成，仅对生成结果做两处规范化：`package.localReference` 改写为可移植的 `/workspace/positions/...`，并保留原 `workspace.json` 的 `createdAt`。英文默认模板保持 `oss-maintainer` 不变，避免把英文优先的 CLI 默认输出改为中文。

本目录已用同一 digital-employee 版本的 `org apply <workspace> --json` 做镜像核对：首次 apply 识别 4 个岗位、无虚假 move，并生成 0600 的应用态三文件。

用途：`POST /workspace/open` 指向本目录可复现 org-tree.v1；`POST /org/apply` 可验证目录提案闭环。
