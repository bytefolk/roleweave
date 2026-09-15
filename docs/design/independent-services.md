# doc / mem 独立服务接入与更新

RoleWeave 把 `doc` 和 `mem` 当作独立服务接入。三者不共享源码、数据库或发布版本：RoleWeave 管组织、岗位和工作区；doc 管文档编辑、协作和版本；mem 管文件、记忆及检索。doc 的完整编辑器和 mem 的网盘界面由各自服务提供，RoleWeave 通过 HTTP API 获取索引，通过受限浏览器窗口打开原生界面。因此上游界面的更新不需要重新打包 RoleWeave。

| 部署方式 | doc / mem 在哪里运行 | RoleWeave 如何连接 |
| --- | --- | --- |
| 本机 | 本机或 WSL 的独立进程 / Docker Compose | 本机 HTTP 地址 |
| 团队自托管 | 团队维护的服务器 | 服务的 HTTPS 地址和访问令牌 |
| 托管服务 | 运营方维护服务与数据生命周期 | 相同 HTTP 契约，无须改客户端架构 |

默认选择本机独立服务，需要团队共享时改成自托管地址。SaaS 不是解耦的前提。目前 mem 的生产资料明确限定私有部署，doc 的 Compose 明确属于本地开发环境；这次接入不意味着两个项目已经成为可公开运营的多租户 SaaS。

## 本机统一 Docker 管理

本地交付采用一个 RoleWeave 管理入口，内部保留 doc、mem 两组独立的 Docker Compose 项目。桌面应用照常安装，文档服务、记忆服务及其 PostgreSQL / Redis / 对象存储依赖分别运行在容器中。两个上游都定义了 `postgres`、`migrate`、`web`，直接拼接 Compose 会合并同名服务；保留独立项目可以沿用各自的服务发现、构建路径和数据卷，无须复制或重写上游部署模型。Docker Desktop 中会显示两个 `roleweave-doc-*` / `roleweave-mem-*` 分组，RoleWeave 命令一次管理全部。

完成下文的源码准备后，从 RoleWeave 仓库执行：

```bash
npm run local-services -- init       # 初始化两份固定配置；保留已有密钥
npm run local-services -- config     # 验证真实 Compose 配置，不启动容器
npm run local-services -- doctor     # 检查本机 Docker Engine 与 Compose
npm run local-services -- up         # 构建并启动两项服务，等待健康检查
npm run local-services -- status     # 查看两个项目的真实容器状态
npm run local-services -- logs       # 各容器最近 100 行日志
npm run local-services -- stop       # 停止两个项目；保留容器、配置和全部数据卷
```

这些命令也接受 `doc` 或 `mem`，例如 `npm run local-services -- up mem`、`npm run local-services -- logs doc`。支持与源码工具相同的 `--root`。源码工具与管理命令必须使用同一根目录及同一操作系统路径；Windows UNC 与 WSL 路径会生成不同的项目标识，不能交替用于真实部署。

推荐本机 Windows 使用 Docker Desktop 的 Linux 容器模式，并在 Settings → Resources → WSL Integration 中启用实际使用的发行版。启动 Docker Desktop 后，在同一 WSL 终端中管理服务。要求 Node.js 22+、Docker Compose 2.20+；环境初始化由 RoleWeave 完成，不依赖上游 CLI、`sh` 或 Node.js 24。命令只接受本机 Unix socket / Windows named pipe 的 Docker 上下文。

`init` 根据选中版本的上游 `.env.example` 生成固定的 `runtime/.env`：doc 三个独立随机密钥，mem 五个密钥，新 mem 配置绑定 `127.0.0.1`。新文件原子写入并保留私有权限；已有文件按原字节保留。doc 使用本机 Mailpit 登录，无须预先配置外部邮件服务。生成的密钥不会输出到命令结果。

`up` 先校验两份源码与全部目标配置，再依次构建启动。mem 默认镜像名带独立项目名前缀，镜像标签及构建版本使用选中提交 SHA；显式配置自定义镜像名时仍按用户配置执行。一项启动失败会如实报告，已成功的一项保持运行，不自动回退数据库。`up` 会执行上游定义的迁移，更新已有数据前仍须检查迁移和备份。

部署记录位于各自 `runtime/deployment.json`，分别记录成功部署的源码与最近一次尝试。它是部署输入记录，不替代运行中 API 的版本信息。`status` 读取 Docker 的真实状态；`stop` 和 `logs` 按固定 Compose 项目标签定位全部容器，即使更新失败、上游重命名了服务，也能找到原有容器。命令不提供删除数据卷选项。

独立升级示例：

```bash
npm run services -- update-source mem --channel main --transport archive
# 核对该版本的迁移说明和现有数据备份后：
npm run local-services -- up mem
```

本机验收环境已完成两项服务的环境初始化、真实 Compose 配置校验和健康检查：doc 监听 `127.0.0.1:3100`，mem 监听 `127.0.0.1:18080`（本机 `8080` 已被其他 mem 实例占用）。首次启动成功后，在各自原生界面登录并创建 PAT，再填入 RoleWeave 的「文档与记忆服务」；`scripts/verify-live-local-services.mjs` 可创建临时验证数据并检查 RoleWeave 的两条读取桥接。

依据：[Compose 配置解析](https://docs.docker.com/reference/cli/docker/compose/config/)、[Compose 网络与项目隔离](https://docs.docker.com/reference/compose-file/networks/)。

## 三种状态必须分开

1. **上游源代码**：官方仓库某个分支或标签当前指向的完整 commit SHA。
2. **已准备源码**：下载到本机、经过 SHA 核对、可用于下一次部署的代码。
3. **正在运行的服务**：某个地址实际提供的服务，通过健康及 API 请求验证。

下载新版本不会切换正在运行的容器。服务能连通不代表最新源码已部署。doc 暂时没有 HTTP 版本接口；不能用本地源码的版本冒充远程服务版本。

## 准备独立版本

从 RoleWeave 仓库运行，需要 Node.js 22+ 和访问 GitHub 的网络。默认 Git 传输还需要 Git；归档传输使用 RoleWeave 显式固定的 `tar@7.5.22` 依赖。准备源码不需要 doc / mem 的开发依赖，也不会运行上游脚本、Docker 或数据库迁移。

```bash
# 查看 main 分支的候选 SHA；只读操作，明确标识为 main-preview。
npm run services -- plan doc
npm run services -- plan mem

# 优先使用 plan 返回的完整 SHA，获得可重现的部署输入。
npm run services -- prepare doc --ref <完整的40位SHA>
npm run services -- prepare mem --ref <完整的40位SHA>

# Git 传输在当前网络不可用时，明确选择官方 codeload 归档。
npm run services -- prepare doc --ref <完整的40位SHA> --transport archive
npm run services -- prepare mem --ref <完整的40位SHA> --transport archive

# 也可以明确选择主分支预览版；实际下载仍然固定到解析出的 SHA。
npm run services -- update-source doc --channel main
npm run services -- update-source mem --channel main

# 归档方式同样先解析 main，再下载固定 SHA 的源码。
npm run services -- update-source doc --channel main --transport archive
npm run services -- update-source mem --channel main --transport archive

# 查看已准备源码、历史记录和具体部署命令，不查询或修改运行中服务。
npm run services -- status doc
npm run services -- status mem
```

没有 `--ref` 或 `--channel main` 的准备 / 更新命令会被拒绝。`latest` 不会被解释为稳定服务版本。`doc` 目前没有 GitHub release；`mem` 当前公开发布的 MCP 制品也不能代表 Web、服务端和 Worker 整套服务的兼容承诺。未来有服务级版本后，可以直接用其明确标签作为 `--ref`。

所有命令支持 `--root <目录>`。默认目录是当前系统用户的 `~/.roleweave/services`，独立于 RoleWeave 工作区，也独立于已有 doc / mem 开发仓库。例如 Windows 可使用 `--root C:\Users\me\.roleweave\services`，WSL 可使用 `--root /home/me/.roleweave/services`。推荐在真正运行 Docker 的 Linux / WSL 环境中准备和部署，避免混用 Windows 与 Linux 路径。

```text
services/
  doc/
    manifest.json               # 无令牌：仓库、SHA、来源 ref、下载及选择时间
    sources/<完整SHA>/          # 固定提交的 Git checkout 或归档源码，保留旧版本
    runtime/.env                # 由部署操作者初始化；升级时保持不变
  mem/
    manifest.json
    sources/<完整SHA>/
    runtime/.env
```

工具不执行 `git pull`，不改已有开发 checkout。下载在临时目录完成，Git 方式核对真实 HEAD 和工作树，归档方式先完整校验归档再解包；确认 Compose 文件存在后才切换源码清单。失败时保留之前的选择，每个服务有独立锁，避免两次更新同时覆盖清单。

归档只从 `https://codeload.github.com/bytefolk/<服务>/tar.gz/<完整SHA>` 下载，不跟随重定向。压缩体最多 64 MiB、解压后最多 256 MiB、单文件最多 32 MiB、条目最多 20,000。解包前拒绝符号链接、硬链接、设备、绝对路径、路径穿越、Windows 特殊名称、重复或大小写冲突路径，以及特权权限位；保留正常文件的可执行权限。

清单记录传输方式、归档 SHA-256，以及每个源文件的路径、大小、权限和 SHA-256。重复准备和源码回退都会重新检查，拒绝缺失、修改或新增的源文件。doc 官方 `init` 生成的 `.doc/instance-id` 和 `services/collaboration/.env` 是明确允许的运行配置。清单中的归档哈希用于本地完整性核对，来源仍以官方 HTTPS 下载和固定提交 URL 为依据，不冒充上游已签名的 release。

## 部署与数据升级

`services prepare` / `services status` 的 JSON 中，`nextSteps.commands` 给出初始化与底层 Compose 命令，并提供 Windows PowerShell 或 POSIX shell 可复制的 `display`。源码工具只打印这些步骤。日常统一管理使用上面的 `local-services` 命令，它会实际执行用户选择的操作。

部署前先阅读该 SHA 中的上游说明，检查数据库迁移，并验证数据库、对象存储的备份可恢复。首次部署没有已有业务数据时，先完成环境初始化；以后使用同一份环境文件，不重新生成数据库密码和服务密钥。

- **doc**：使用 RoleWeave 的 `local-services init doc` 生成独立环境，使用上游 `docker-compose.yml`。doc 上游 CLI 要求环境文件位于源码目录内，因此不能用它初始化这里的外部 `runtime/.env`。默认 Web `http://localhost:3100`，邮件登录使用本机 Mailpit `http://localhost:8025`。实际 Compose 仍运行开发用途的 `db:push`，不具有生产级自动迁移 / 回滚保证。
- **mem**：`local-services init mem` 按上游模板生成随机密钥；使用 `deploy/compose/compose.yaml`，默认 Web 与 API 同源入口 `http://localhost:8080`。这个入口不同于开发模式中直接运行 memd 常见的 `8787` 端口。首次通过原生 Web 注册一个 owner，再创建适当范围的 API 令牌。

生成的 Compose 命令使用**与源码 SHA 无关、由服务种类和固定根目录决定的 project name**，并引用 `runtime/.env`。这使下一次源码更新继续使用原有服务项目和数据卷。保持 `--root` 不变；换目录或换项目名可能得到另一组空数据卷。已有其他方式部署的服务继续由原部署流程维护，不能直接用这里生成的新 project name 接管旧容器。

完成部署后，通过生成命令中的 `docker compose ... ps` 查看容器状态，再在 RoleWeave 中检查服务连接、索引读取和原生编辑器。源码工具的 `deployment.state` 始终为 `not-managed`，不会把部署指令的打印当作部署成功。

## 源码回退

```bash
npm run services -- rollback-source doc --sha <此前准备过的完整SHA>
npm run services -- rollback-source mem --sha <此前准备过的完整SHA>
```

这只重新选择已经下载且未被修改的源码，不启动容器、不切换镜像，也不回退数据库。数据库经过新版本迁移后，旧服务未必还能读取它；实际回退必须先确认版本与数据兼容，必要时按上游恢复流程还原备份。工具不删除旧源码，也不提供删除数据卷的命令。

## 连接契约与独立升级边界

RoleWeave 的服务适配器只依赖已实现的 HTTP 能力，不读取 doc / mem 的数据库或内部代码。令牌留在本地控制面，不放进文档链接、浏览器 URL 或源码清单。浏览器登录与 API 令牌认证是两条独立会话；首次打开原生服务界面仍可能需要登录。

doc 未单独配置 Web 地址，或 Web 地址与 API 地址相同时，原生入口默认为 API 基址加 `/work`，保留反向代理子路径，由 doc 处理语言跳转。明确配置了不同的 Web 地址则按该地址打开，不重复追加 `/work`。mem 保留其独立的 Web 入口。

| 服务 | 健康检查 | 认证 / 数据契约 | 原生界面 |
| --- | --- | --- | --- |
| doc | `GET /api/health`，校验 `service: doc-web` 与 `status: ok` | Bearer `GET /api/v1/me`，确认读权限并验证 `/api/v1/documents` 的响应结构；单文档用 `/api/v1/documents/{id}` | `/work`、`/work/{id}`，由服务进行语言跳转 |
| mem | 校验 `GET /v1/version` 与 `/v1/capabilities` | Bearer 令牌和 `X-Workspace-ID` 作用域下，验证 `/v1/files?limit=1`；数据访问仍受路径及角色权限约束 | 服务自身 Web 入口 |

mem 的 Web `/healthz` 只表示 Nginx 代理存活，不能证明后端可用；某些未知路径还可能回退成 SPA 的 HTML。连接验证必须检查 API 身份、响应类型与实际授权读取，不能只看 HTTP 200。健康与索引检查也不是上游未来版本永不破坏兼容性的承诺。上游新增界面能力会随原生 Web 自动获得；新增 API 能力需要适配器明确采用；破坏旧 API 的变化需要适配器升级。

可靠的全自动稳定更新还需要上游提供：服务级不可变镜像 release、机器可读版本 / 能力清单、API 主版本兼容规则，以及可重复的跨版本迁移验证。当前实现先把服务地址、凭证、源码准备、运行状态和数据升级分开管理，避免以追随 `main` 代替兼容验证。

上游依据：[doc API](https://github.com/bytefolk/doc/blob/main/docs/API.md)、[doc 本地运行](https://github.com/bytefolk/doc/blob/main/docs/RUN_LOCAL.md)、[doc releases](https://github.com/bytefolk/doc/releases)、[mem 私有部署](https://github.com/bytefolk/mem/blob/main/docs/DEPLOYMENT.md)。
