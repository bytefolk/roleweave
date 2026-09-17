# 已批准资料：问题调研（issue-triage）

这个目录是本岗位**唯一**的已批准知识来源。往里放资料就代表它已被审阅、可以依据。

## 当前内容

本岗位包不自带组织规范副本。开工前从目标仓库自己读：

- 组织级工程基线：`bytefolk/.github` 的 `ENGINEERING.md`（语言与署名、分支与提交规则、测试与证据要求、issue 治理、PR 门禁、评审规则）。
- 仓库级规范：目标仓库的 `CONTRIBUTING.md`、`.github/CODEOWNERS`、`.github/PULL_REQUEST_TEMPLATE.md`、以及它自己的接口契约文档。

```sh
gh api "repos/<org>/.github/contents/ENGINEERING.md" -H "Accept: application/vnd.github.raw"
gh api "repos/<owner>/<repo>/contents/.github/CODEOWNERS" -H "Accept: application/vnd.github.raw"
```

## 为什么要现读而不是内置副本

规范会变。内置副本一定会漂移，而**漂移的规范比没有规范更危险**——它会让岗位按过时的门槛放行。所以这里只写"去哪里读、怎么读"，不写"规范说了什么"。

## 待补充

把本组织特有的约定放进来（例如：哪些标签可用、哪些 PR 必须走哪个评审人、灰度/回滚约定）。不要放凭据、个人信息或未经审阅的材料。
