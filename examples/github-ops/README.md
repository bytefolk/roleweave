# github-ops — 一个处理 issue 与 PR 的员工组织

这是一份**提交在仓库里、可直接打开**的工作区：打开这个目录就得到三个岗位，定义随 `main` 版本化，换机器或重装都不会丢。

```sh
# 桌面端：打开项目 → 选这个目录
# 或直接走控制面
curl -X POST http://127.0.0.1:<port>/workspace/open \
  -H "Authorization: Bearer <boot-token>" -H 'content-type: application/json' \
  -d '{"path":"<repo>/examples/github-ops"}'
```

## 组织与权限分离

| 岗位 | 中文名 | 能做什么 | 明确不能做 | 工具白名单 |
|---|---|---|---|---|
| `pr-gatekeeper` | 合并把关（owner） | 核查闸门、合并他人的 PR | 不写代码、不提 PR、**不批准任何 PR** | `Read` `Grep` `Glob` `Bash` |
| `issue-triage` | 问题调研 | 查重、复现、分流、按模板建 issue | 不改代码、不合并 | `Read` `Grep` `Glob` `Bash` |
| `pr-author` | PR 提交 | 实现改动、提 PR、按评审意见修改 | **不合并任何 PR**（含自己提的） | `Read` `Write` `Edit` `Grep` `Glob` `Bash` |

三条不可让渡的规则（写在各自的 `SKILL.md` 里，逐条可核查）：

1. **提 PR 的人不合并，合并的人不提 PR。** 这样"独立批准"才有意义 —— 一旦同一个人既能提又能批，闸门就形同虚设。
2. **被必需检查挡住时，唯一合法的动作是修那条检查本身**（`pr-gatekeeper/SKILL.md` 明令禁止 `gh pr merge --admin`、禁止 dismiss 他人的 `CHANGES_REQUESTED`）。
3. **合并前一刻重读 head SHA。** 评审与检查都绑定到具体提交，head 变了它们就作废 —— 这是"批准的是这个提交"与"批准的是这个意图"的区别。

## 凭据：真正的边界在这里，不在 RoleWeave 的 policy 里

**这是使用前必须理解的一件事。**

今天，岗位包里的 `policy.network`、`policy.filesystem`、`policy.mode` 在打包引擎里**只被记录、不被执行** —— 全仓唯一真正生效的员工能力声明是 `permissions.json` 的 `tools`，它被翻译成宿主 CLI 的 `--tools` 白名单。员工能对 GitHub 做什么，取决于**它拿的是哪个凭据**。

所以：

- 用**独立的机器身份**（单独账号或 GitHub App）的细粒度 PAT，**不要**复用你本人的 `gh` 登录。理由很实际：你本人是 code owner，若复用你的登录，"PR 作者 ≠ 批准者"就只靠规则约束；换成机器身份后，`gh api user` 一眼就能证明批准者不是作者。
- 细粒度 PAT 的最小集合（三个岗位取并集）：

  | 权限 | 用途 |
  |---|---|
  | `Contents: Read and write` | 推分支（pr-author）；**squash 合并会写基分支**（pr-gatekeeper） |
  | `Pull requests: Read and write` | 建 PR / 合并（合并按钮就是一次 PR 写操作） |
  | `Issues: Read and write` | 建 issue、写评论、分流 |
  | `Actions: Read` | 读 CI 结论与失败日志 |
  | `Metadata: Read` | 必选的基础权限 |

  **不要授予 `Administration`** —— 那会让员工具备绕过分支保护的能力，而它恰恰被要求永不使用。

- ⚠️ **岗位级凭据隔离目前做不到。** RoleWeave 的凭据是按宿主（Host）配置的，不是按岗位；同一个工作区里的三个岗位共享宿主的登录态。因此"只有把关岗能合并"在**今天是一条规则约束，不是能力边界**。要把它变成能力边界，只有两条路：
  1. 给整个工作区的 PAT 去掉合并能力 —— 但那样把关岗也合不了，退回人工合并；
  2. 把关岗单独放在另一个工作区/宿主上，用一份具备合并权限的 PAT，另外两个岗位所在的工作区用不具备合并权限的 PAT。

  推荐 (2)：这是今天唯一能在机制上分离"建"与"合"的做法。

## 怎么改成你自己的仓库

这些文件里没有硬编码任何仓库名 —— 目标仓库是**运行时由员工的 `Bash` 去 `gh` 读的**。你要做的是：

1. 在 `positions/*/knowledge/README.md` 里补上本组织的特有约定（哪些标签可用、哪些 PR 必须谁批、灰度与回滚约定）。
2. 在仓库根放一份对员工可见的操作说明（或让它在开工前读目标仓库的 `CONTRIBUTING.md` 与 `.github/CODEOWNERS`）—— 三个 `SKILL.md` 都已经要求"先读规范再动手"。
3. 把目标仓库克隆到 `context/clone-rw/`（`pr-author` 的 `policy.filesystem.write` 已声明 `./context/**`）。

## 已知限制（都是当前实现的真实状态）

- **内置 Qoder 宿主不支持员工 MCP 绑定**：`permissions.json` 里 `mcpServers` 非空会让回合直接失败（`qoder.mcp_binding_unsupported`）。所以 GitHub 访问只能走 `Bash` + `gh` CLI，不能走 GitHub MCP。这也是这三个岗位包把 `mcpServers` 留空的原因。
- **`policy` 的 network / filesystem / mode 不被执行**（见上）。它们会被写入应用态模型并展示在界面上，但拦不住任何东西。
- **合并需要 `Contents: Read and write`**，这是 GitHub 的机制要求，不是本岗位的设计选择 —— squash 合并会往基分支写提交。
- **`pr-author` 的工具名用宿主 CLI 的真名**（`Bash` / `Read` / `Write` / `Edit` / `Glob` / `Grep`）。注意招聘抽屉里那排工具名中的 `Exec` **不是** Claude/Qoder 的内置工具名；手写岗位包时若照抄，白名单会落空。

## 文件结构

```
examples/github-ops/
├── workspace.json                 # workspace.v1alpha1
├── organization.v1alpha1.json     # workspace-org.v1；owner = pr-gatekeeper
├── context/README.md              # 运行时工作目录（克隆目标仓库）
└── positions/
    └── pr-gatekeeper/             # 目录嵌套 = 汇报线
        ├── employee.json          # 身份 + policy + assets
        ├── SKILL.md               # 岗位提示词（spawn 时作为 --agents 传给宿主 CLI）
        ├── permissions.json       # workbench-permissions.v1；tools 才是被执行的白名单
        ├── budget.json            # perTask / perDay
        ├── schemas/{input,output}.schema.json
        ├── knowledge/README.md    # 已批准资料（"去哪里读规范"，不内置规范副本）
        ├── evals/cases.json
        ├── issue-triage/          # 同上结构
        └── pr-author/             # 同上结构
```

`context/` 与 `.digital-employee/` 都是运行时产物，已在仓库 `.gitignore` 中忽略，不入库。
