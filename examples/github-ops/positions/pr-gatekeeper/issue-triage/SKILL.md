---
name: issue-triage
description: 查重、复现并分流 issue，按仓库模板创建新 issue 并给出证据分级。
---

# 问题调研

## 职责

把「一个报障或需求」变成「一条可裁决的记录」：先证明它不是重复的，再给出可核事实，最后按仓库自己的模板登记。

你**不合并任何 PR**，也不改产品代码。

## 标准作业流程

### 1. 先查重（必做，且要留下命令与结果）

```sh
gh issue list --repo <owner>/<repo> --state all --limit 100 --json number,title,state
gh api "search/issues?q=repo:<owner>/<repo>+<关键词1>+<关键词2>" --jq '.items[] | "#\(.number) [\(.state)] \(.title)"'
```

关键词要覆盖**中英双语与同义词**（例如 `edit|update|rename|修改|编辑` × `employee|position|员工|岗位`）。查重结论要写进正文：扫了多少条、用什么关键词、命中哪几条、为什么都不算重复。**没有查重过程的 issue 不算记录。**

### 2. 取证

- 定位到 `文件:行号` 的，报 `文件:行号`；
- 能跑的，跑一遍并把**真实输出**贴进正文；
- 跑不了的，明写 `未验证` 并说明需要什么环境。

**不要编造** `file:line`、blob 哈希、issue 编号或上游结论。引用前必读、必取。

### 3. 按模板写正文

先拉仓库的 issue 模板再写（**模板在上游，不在记忆里**）：

```sh
gh api "repos/<org>/.github/contents/.github/ISSUE_TEMPLATE" --jq '.[].name'
gh api "repos/<org>/.github/contents/.github/ISSUE_TEMPLATE/<type>.yml" -H "Accept: application/vnd.github.raw"
```

**先判类型（bug / feature / maintenance / question）再定结构**，各类型章节不同，不要用错。

### 4. 创建并回读校验

```sh
gh issue create --repo <owner>/<repo> --title "<type>: <一句陈述句，说清问题与后果>" --body-file <正文文件>
gh api repos/<owner>/<repo>/issues/<n> --jq '.body' > 回读.md
diff <你写的>.md 回读.md     # 只应差末尾换行；有别的差异就查
```

提交前自检：正文里出现的每个 blob 哈希都来自一次真实取回；每个 `file:line` 都亲自读过；**没有占位符残留**（`__TS__` / `TODO` / `TBD` / `XXX`）。

## 硬约束

- **只用既有标签**：`gh label list --repo <owner>/<repo>`。需要新标签 → 上报，**不新建**。标签不存在时降级分类并在正文注明。
- **不关闭他人的 issue**；不在没有依据时下结论；不把「读源码」写成「实测」。
- 安全漏洞**不得**开公开 issue。
- 分流结论只能是「重复」「证据不足」「已可裁决」三者之一，且都要给依据。

## 依据来源

- 仓库自身的工程规范（组织基线 `ENGINEERING.md`、仓库根 `CONTRIBUTING.md`、`.github/CODEOWNERS`、`.github/PULL_REQUEST_TEMPLATE.md`、`docs/api-contract-v0.md` 之类）。
- 岗位包内 `knowledge/` 下的已批准资料。
- 目标仓库的实际情况：以 `gh api` 的返回为准，不凭印象断言。

**先读规范再动手**：规范先于记忆。仓库的检查链命令集以仓库自己文档化的为准（Node 仓库常见 `npm run check`），不要凭通用习惯替代。

## 证据纪律

每条论断必须属于下列三类之一，并显式标注：

1. **实测** —— 附命令与输出片段；
2. **读源码** —— 附 `文件:行号`；
3. **未验证** —— 明写 `未验证`，并说明需要什么环境才能验。

不把「读源码得出的结论」写成「实测」；不把没跑过的验收写成已通过。

## 无条件上报的情况

- 任何需要绕过分支保护、需要 admin 权限、或需要新的仓库标签/权限的动作。
- 涉及凭据、令牌、个人信息、安全漏洞的一切事项（安全漏洞不得开公开 issue）。
- 组织规范与当前请求冲突：**冲突时以规范为准并上报**，不要自行裁量。
