# Changelog

本仓库采用 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式。
早期开发记录以里程碑（D0/D1/D2…）标注，安装包发布使用语义化版本。

## [Unreleased]

### Fixed

- 对话默认使用 Enter 发送时，Ctrl/Command + Enter 可在光标处插入换行或替换选中文字，并保留正确光标位置；保留 Shift + Enter 换行、输入法确认保护和设置中的发送快捷键选择。

- #339 Android 原生客户端：release 强制 HTTPS；debug 才允许明文以便连本机 RoleWeave。WebSocket 断开按 1/2/4/8/16s 指数退避重连最多 5 次。发指令必须在组织页显式点选岗位，不再默认第一角色。`android-client.yml` 对 `mobile/android` 跑 `gradle test`（不安装已下线的 SDK `tools` 包）。

### Added

- #356: design-only multi-agent branch heads and handoff-carried checkpoint refs (`docs/design/memory-branch-handoff-v1.md`). No silent head clobber; handoff does not copy grants. No runtime.

- #355: design-only pin/disable/inspect/forget controls (`docs/design/memory-controls-v1.md`). Forget failure is visible; no local fake delete. No runtime.

- #354: design-only assembly receipt UI (`docs/design/assembly-receipt-ui-v1.md`). Admission authority is UTF-8 bytes; model tokens are a separate cost cap. UI counts must equal the receipt. No runtime.

- #352: design-only routing table among #143 short window, #327 durable memory, and #347 Knowledge Base (`docs/design/memory-routing-v1.md`). Does not close #143. No runtime.

- #348: design-only user remember/correct/forget acts (`docs/design/memory-user-acts-v1.md`). Write responses are created/stored; admitted/omitted only on the next receipt. Append-only supersession. Recalled text stays untrusted. No runtime.

- #349：private / position / team memory grants 设计稿（`docs/design/memory-grants-v1.md`）。pin mem#221 `e0e47c7`；employee-private 用不可复用 `employee.<hire_id>`（需 mem additive，不能用可换人的 position seat）；team/task 展开为每成员一条 mem grant 行，不引入 `task.*` principal；越权 receipt / handoff 不携带 memoryId。无运行时；#327 D0 / #345 未接受，不当作已定基线。


## [0.3.0] — 2026-09-18

### Added

- #334 #335 #336：手机壳按 iOS / Android / HarmonyOS 拆开，UA 分流；可用 `?platform=` 强制切换。

- #329：手机打开 RoleWeave 时进入原生手机壳（组织 / 指令 / 桌面 / 设置），而不是缩过的桌面工作台。组织页只读预览 `examples/oss-maintainer`；回合仍在已打开的电脑桌面执行。

- #328 R2：新增 `semantic-runtime.v1alpha1` 合同切片（BusinessObjectRef / EvidenceRef / DecisionRecord / ActionProposal / ExecutionReceipt）与 Ontology Runtime 术语表；github-ops 示例给出只读分析与可写 squash-merge 轨迹；纯函数测试覆盖「未批准不可执行、非法过期时间 fail-closed、幂等重试绑定目标版本、目标版本失效、运行前状态不可直接失败、indeterminate 不能变成 succeeded」。不是 live GitHub 执行，也不是 Sales Workbench 核心词汇。设计说明见 `docs/design/ontology-runtime-r2.md`。

- #309 后续：控制面拒绝超大请求体时，drain 或读取被中止（2 秒截止、10 MiB drain 上限、对端断开）会向 stderr 写一行原因与字节数，现场 EPIPE / 连接复位事故从此可归因；同步 docs/api-contract-v0.md：1 MiB 上限补记先读后拒行为、drain 上限与截止、server requestTimeout / headersTimeout，以及拒绝响应携带 Connection: close。附测试：stall 的超大上传在 drain 与 read 两条路径都断言中止行。

- #302：新增随仓库版本化的 GitHub 运营员工组织 `examples/github-ops/`：打开该目录即得到「问题调研 / PR 提交 / 合并把关」三个岗位。调研岗负责查重、复现并按模板建 issue；提交岗负责实现改动与提 PR；把关岗只在「存在非作者的批准、该 head 上必需检查全绿、无未解决对话、非 draft」时 squash 合并，合并前一刻重读 head SHA，禁用管理员绕过与 dismiss 他人的变更请求。三者均通过 `Bash` 调用 `gh`，不使用 MCP（内置宿主会以 `qoder.mcp_binding_unsupported` 拒绝员工 MCP 绑定）。注意：岗位包里的 `policy.network` / `policy.filesystem` / `policy.mode` 目前只被记录、不被执行，真正生效的是 `permissions.json` 的工具白名单，因此该员工在 GitHub 上的能力边界由所用凭据决定——建议用独立机器身份的细粒度 PAT，且不要授予 Administration。随附测试守护：声明与包一致（含 digest）、内置引擎能 `org apply`、控制面能打开并供出岗位卡。

- #305：对话选项条新增「新对话」入口：确认后把当前会话轮换进历史并自动挂接后继会话，聊天线程即刻清空，旧对话仍可在会话历史中只读回看；仅当前会话可用，运行中回合与忙碌状态下禁用。

- 顶栏工作区路径条改为可点击：点击后通过新增的 `owb:workspace:reveal` IPC 在系统文件管理器中打开当前工作区目录（macOS Finder / Windows 资源管理器）。main 进程自行向控制面回读已打开的工作区，renderer 全程不传路径；WSL 模式把 Linux 路径映射为与文件夹选择器一致的 `\\wsl.localhost\<distro>\...` 共享路径，映射前拒绝 `..` 穿越与未配置发行版；打开失败给出简短警告。附 workspace-ipc 单测覆盖原生/WSL 映射、工作区未打开、shell 失败与穿越拒绝。

- #294：在原有工作台中补齐消息复制、重新编辑、会话历史与手动专注对话；保留各工作区、员工和会话的草稿与阅读位置，显式重试保存到原失败回合的关联。设置模块使用统一 JSONC 草稿与加密凭据引用，支持变更预览、冲突处理、恢复和重启提示。

- #292：员工档案在创建之后可编辑：新增 `PATCH /positions/:id/profile`，可改员工姓名、执行模式与权限（工具、资源规则、Skill 与 MCP 绑定），岗位卡片头部新增「编辑」入口，`GET /positions/:id` 新增加法字段 `permissionPolicy` 供编辑器整份回填。改动写入岗位包（`.workbench/identity.v1.json`、`permissions.json`、`skills.json`、`mcp.json` 与 `employee.json` 的 `policy`）并由引擎重新裁决，因此卡片与组织树上的名字会跟着变；引擎拒绝时逐字节回滚，员工有回合在跑时返回 409 且不落盘。岗位 ID、汇报线与预算不在此范围，仍走各自既有的受治理通道。此前唯一的补救办法是裁撤后重招，而那会一并丢弃以该岗位 ID 归档的全部回合、会话与群聊引用。

- #289：员工 Agent 首次选定即持久化并锁定：导入的员工由操作者选定一次 Agent（Claude Code / Codex 等），对话面板展示当前 Agent 并在锁定后禁用切换，控制面接口对已锁定员工返回冲突；新建项目负责人与新聘员工创建即带锁定绑定，存量未绑定员工在首次派单时锁定其实际使用的 Agent。

### Fixed

- #322：修复未锁定或初次导入的数字人在对话头部无法选择 Agent 的问题：在会话头部恢复基于锁定状态的条件渲染，未锁定员工展示交互式 Agent 下拉选择框（允许完成首次选择并立即持久化锁定），已锁定员工保持固定标识展示。

- #314：招聘/编辑能力面板在绑定任一 MCP 连接器时给出明确警告——当前全部内置引擎都会在第一回合以 `qoder.mcp_binding_unsupported` 拒绝员工级 MCP，绑定仍可保存，但不再静默让操作员以为该能力已经可用。
- #243：Agent Host 登记顺序改为从详尽的 `HOST_DEFINITIONS` 派生，新增引擎时不能再静默漏掉。

- #325: The employee card now keeps its per-task and per-day budget declarations visible after turns instead of replacing the declaration with latest-turn usage. Usage remains available in the reports surfaces, where over-budget percentages stay truthful while the visual meter fill is bounded to its track.

- #297：创建数字员工默认先展示 Agent 与基础信息；Agent 草案、头像、权限、能力、记忆、运行模式和预算改为按需展开，保留安全默认值、原有字段校验与 hire 请求 payload。

- 组织树员工行的右键菜单与省略号菜单首位新增「编辑」入口：点击后打开 #292 的员工编辑抽屉，并按被右键/省略号唤起的那一行现取该员工档案回填表单，保存也对该行提交，不再绑定或抢占主面板当前选中的对话；岗位卡片头部的「编辑」按钮改用同一入口。企业根行菜单不变（仍为项目设置等）。附渲染层测试：行菜单两种触发均出编辑项、企业行菜单不出，以及 App 级端到端断言右键某行后抽屉预填该行档案、改名保存以正确 id 走档案更新桥且选中保持不变。

- #301：创建数字员工抽屉移除左上角无响应的标题关闭按钮（×）：创建执行中取消本就被设计拒绝（#43），而该按钮在提交、审批与成功三个阶段静默吞掉点击，与同屏置灰的「执行中不可取消」提示相矛盾。按报告要求直接删除；可编辑面板保留底部「取消」，遮罩与 Esc 行为不变，员工编辑抽屉的关闭按钮不受影响。

- #297：优化创建数字员工抽屉的分区层级、提示词高度、表单与头像对齐，以及窄窗口滚动和底部操作区；沿用明暗主题，保留创建流程与配置行为。

- #297：侧栏仅在有可恢复记录时显示默认收起的「已移除员工」入口，展开查看原上级并恢复；空列表不占用底部空间，加载与失败重试分开展示，旧工作区和较早请求的结果不会覆盖当前恢复记录。

- #297：修复减少动态效果设置下聊天模型菜单被定位到窗口外的问题；当前模型显示勾选，菜单优先向上展开并限制滚动范围，保留模型搜索和会话行为。自定义模型编辑器保持在菜单上方，并在运行、保存或只读等不可切换状态关闭且阻止提交。

- #297：会话头部以固定标识展示员工 Agent，组织树同步显示品牌与尚未绑定员工的默认来源；整理输入框底部的模型、上下文与用量对齐。Qoder 模型菜单读取本机 CLI 的可用目录，区分档位、具体模型与已配置模型，提供刷新和目录暂不可用提示，不推测模型倍率或计费。

- #294：保持首页框架与默认分栏，完善聊天过程、最终结论、停止和模型配置反馈；聊天与文档共用安全 Markdown 阅读，支持中英文强调、表格、代码复制及文档目录。文档创建与目标操作显式刷新并选中新记录，修复切换时的过期结果、错误反馈、空状态和创建表单布局。

- #284：Agent 不可用提示改为简短状态与“重新检查”，仅刷新健康与当前员工连接状态；诊断只可主动复制，不再展开技术原文。检查与复制失败均提供简短反馈，保留员工、项目、草稿及发送门禁。

- #284：组织首页聚焦员工资料与对话，完整组织图移至“组织概览”；保留缩放、平移和选员工返回工作台，切换时保留会话草稿与分栏宽度。

- #284：会话、群聊与引擎状态改用简短的本地化提示；原始配置诊断默认收进“排查详情”，避免在主界面展示环境变量和命令行说明。保持发送、重试和模型选择的就绪限制。

- #284：统一对话区连接、上下文、用量和自定义模型浮层的阅读宽度与滚动边界；上下文说明按开关、附带记录和范围分区，保留统计含义。模型配置与头像错误提示改用主题错误语义色，改善深色模式可读性。

- #284：精简欢迎页和未选员工时的中英文引导文案，减少重复说明和窄窗口的零散换行，保留现有操作入口。

- #284：应用弹窗使用窗口居中定位；选择与创建工作区随内容高度居中，小窗口的项目表单在弹窗内部滚动，保持标题和关闭入口可见、底部操作可达。

- #284：按钮从禁用变为可用或切换主题时，文字与背景同步切换，保留边框和阴影过渡；避免欢迎页主操作在颜色渐变中短暂失去对比度。

- #284：按内容用途统一对齐：标题、导航、表单和文件名左对齐，比较数值与尾部操作右对齐，按钮、标签和空态整体居中。本地对话未选员工时仅保留一个清晰的引导空态，去除重复提示和不可用的输入框。修正 mint 与默认主题在明暗模式下的按钮、悬停态、禁用态和输入提示色，避免浅色背景上的浅色文字，并让设置表单与当前主题保持一致；打包时共享同一个 Ant Design 实例，确保本地链接的设计系统主题能传递到桌面控件。文档标题、描述、链接及收藏标签采用可读配色，正文和代码保留阅读排版。群聊头像限制在既有容器内，避免遮挡消息和展开控件；展开消息中的链接保持可读。

### Changed

- #316：打开一个尚未包含 RoleWeave 文件的已有目录时，不再落到没有组织树的空页面；工作区选择弹窗会解释缺少骨架的原因，并提供「在此目录初始化项目」。初始化保留目录里的业务文件，只添加工作区清单、项目上下文和只读项目负责人，再通过既有引擎 apply 闸门后打开；已有部分工作区标记或空组织声明会安全拒绝，失败会清理本次生成物。

- #316：导轨收拢按钮默认上移到内容区，普通 hover 使用按钮手型，按住拖动时显示抓取光标，并支持鼠标/触控上下拖动与方向键微调位置；收拢与展开 morph 调整为 160ms 的快速 ease-out，保持导轨宽度、菜单槽位、文字淡入淡出和箭头旋转同步完成。
- #316：打开已有项目时先保留工作区选择弹窗，明确展示原生目录选择后的加载状态；服务端确认并完成组织树刷新后才关闭弹窗，工作区校验或本地服务失败时保留弹窗并展示可读错误，避免点击后回到空页面却没有反馈。

- #275：新增 WorkBuddy（CodeBuddy Code CLI）服务凭据 Host，需要 `CODEBUDDY_API_KEY` 和显式 `CODEBUDDY_MODEL`；仅接受已审计的 2.106.4 / 2.137.1 工具清单。回合隔离本地配置并校验实际空工具/MCP 初始化，修复持久化 WorkBuddy 员工绑定在 renderer 被回退到其他 Host 的问题，补充 IPC、历史回读、打包清单与子进程验收。新增本地模拟 provider 验证脚本；真实 provider 与原生打包验收仍待完成，原生 Windows 当前保持 not-ready。

## [0.2.0] — 2026-09-15

### Changed

- #222：新增目标模块：声明目标，并把个人会话、群聊与回合关联到目标上，集中查看目标及其相关工作；契约层新增 goals 类型与 API，界面支持中英双语。
- #265：简化员工与项目配置，支持为员工/项目绑定一个 Agent 并选择模型；新增记忆与会话协作入口和对话路由；员工头像支持上传、预设与 AI 生成入口。
- 首次启动不再自动复制或打开演示工作区，用户从空工作区新建或打开项目；仍恢复有效的上次工作区并保留显式路径覆盖。上次工作区无法访问时留空并提示重新打开，已有演示和用户文件保持原样。
- Windows 可通过本机运行环境偏好默认连接指定 WSL 发行版；项目选择器从其 Linux home 开始，设置展示项目与 Agent 所用环境；沿用每个员工独立保存的 Agent 绑定。
- WSL 后台使用 Linux Node 与内置 adapter，保留 Linux CLI 的登录、代理与证书配置，并在桌面退出时清理其子进程；支持两种 WSL UNC 路径并拒绝跨发行版选择。
- 本地 doc / mem 新增统一 Docker 管理入口：共同或单独初始化、验证、启动、查看状态/日志和停止；复用独立 Compose 项目与持久卷，修正 doc 外部环境初始化，失败升级保留成功版本记录，停止按项目标签覆盖旧容器。
- doc / mem 以独立 HTTP 服务接入：桌面设置可保存加密令牌、验证实际 API 契约并打开上游原生界面；支持本机与远程 HTTPS，连接变更立即刷新索引。独立源码工具固定上游 commit、保留历史及持久化数据路径，并生成部署步骤；源码准备不会自动迁移数据库或切换运行中服务。
- #206：RoleWeave 内置引擎新增 Codex 服务凭据与本地登录两种 Agent Host；本地登录不依赖服务 API key。
- #236：Agent Host 下方显示本次回合将使用的模型（仅对存在模型旋钮的 Host 展示，由 `/health` 新增的可选 `modelPinnable` 下发，客户端不自带引擎清单）。`/health` 的 Host 状态新增可选 `model`（取自 `OPENAI_MODEL`）；未指定时如实显示"由 Host 自行决定"而不推断名字——Codex CLI 不向调用方报告它选中的模型。Codex 回合一律带 `--ignore-user-config`，`~/.codex/config.toml` 的 `model` 不生效。`OPENAI_MODEL` 非法时两个 Codex Host 在前置检查即 fail closed 并给出可执行提示，不再等到 spawn 前失败。
- 以 RoleWeave 标识的紫蓝色建立 light / dark 双主题，逐组件统一组织、会话、群聊、招聘、文档、网盘、报表、审批和设置；简化嵌套卡片与装饰标签，改善正文、长路径、超限数值及暗色表单的可读性，保留业务行为。
- 会话使用可折叠的执行状态行与连续正文：运行时展开公开里程碑并显示真实耗时，结束时默认收起，手动开合不受流式输出刷新影响；审批与错误保持可见，不推断工具次数，缺失的时间不补零。

### Fixed

- #245：模型名过长时在 Agent Host 模型行以单行省略号截断，不再换行。
- #234：切换员工时保留会话面板的滚动视口，不再重置。
- #240 review：报表中心的审计时间线改用与对话面板同一个引擎标签来源。它此前自带第三份标签映射（签名 `engine: string` + `return engine` 兜底），Codex 回合会显示成裸 id `codex-local`，`claude-local` 也与对话面板措辞不一致；这个缺陷在 #239 修复前不可达，因为 `/reports` 遇到 Codex 记录会直接硬报错。
- 新建项目接受界面传入的项目字段与可选 Agent 绑定，父目录只由原生选择器提供；打开与创建共用 WSL 路径转换，恢复 Linux 工作区时不再依赖 Windows 的存在性检查。
- 本地 Claude Host 复用用户 OAuth 登录时不再使用禁用该登录的 bare/空设置来源选项；保留工具限制并禁用 hooks。
- #239：Codex 回合不再在写盘后变成不可读记录。回合记录校验器仍保留 #206 之前的三引擎硬编码白名单，导致 `codex` / `codex-local` 的回合被路由接受并落盘、却在回读时判为非法，使该会话历史和整个报表中心永久报错（`local session turn history contains an invalid record` / `local reports data is invalid`）。校验器改为走 `turnEngines` 契约；已落盘的记录无需修复，本身合法。
- #221 review：Codex 就绪状态要求内置引擎边界；使用外部 digital-employee CLI 时，即使已安装 Codex 并配置凭据，两种 Codex Host 仍显示不可用并说明原因。
- #156：工作区覆盖路径仅在 Windows WSL 控制面模式下跳过本地存在性检查，由控制面在路径边界转换后校验；模式判断与路由、诊断统一，Linux/macOS 即使设置 `ORG_WORKBENCH_CONTROL_PLANE=wsl` 仍保留原生校验。
- #224：控制面模式开关同时接受 RoleWeave 命名 `ROLEWEAVE_CONTROL_PLANE_MODE`（RoleWeave 名优先，与 `ROLEWEAVE_DEFAULT_WORKSPACE` 一致），保留 `ORG_WORKBENCH_CONTROL_PLANE` 兼容旧部署；避免按新品牌名设置时被静默忽略而退回原生模式、使 #156 的 WSL 路径修复在真实 Windows 主机上失效。
- #135：新增免费 macOS GitHub 自动更新通道：发布 workflow 使用 `OWB_UPDATE_SIGNING_PRIVATE_KEY` 为 ZIP 元数据生成 Ed25519 签名，客户端校验后后台下载，并在正常退出时自动替换、重启；应用本身仍为 unsigned，Gatekeeper/Developer ID 方案保留为后续切换路径。

## [0.1.2] — 2026-09-10

### Changed

- #214：同一会话的后续回合可携带有界、脱敏的可信历史，并展示实际注入摘要、数量、字节数和 digest；上下文开关按会话持久化。
- #214：不同员工可同时处理任务；群聊支持显式并行和有序接力，前序失败时停止后续执行并保留可查询的状态。
- Rewrote the README in English with customer onboarding, desktop downloads, AI integration guidance, and source development instructions.

### Fixed

- GitHub Release 正文从冻结发布提交中的同版本说明文件自动载入；缺失、空白、版本不符或传输后改变的说明会在创建草稿前被拒绝，说明文件不会混入安装包资产。
- #170：工作区自动打开的失败诊断保持 best-effort；即使 stderr 不可写也不会把启动变成失败，并补充 main.js 调用边界回归覆盖。
- #215 review：群历史和接力结果先脱敏后截断；落盘失败释放运行标记，坏历史来源与失败事件订阅者不再连带中断其他成员。
- #215 review：取消绑定原工作区及已知回合；个人与群组执行共同阻止会话轮换和上下文策略变更，前端按工作区、岗位、引擎隔离事件。
- #215 review：补足最大群消息的持久化空间，接力只保留有界结果，恢复记录保留原接受时间并保证并发恢复幂等。
- #155：Windows 目录 fsync 的 EPERM 判断收回唯一的原子写入口（context export 不再自带第二份），裸 errno 通过 `cause` 穿过 groups/assets/sessions/turns 各自的存储错误包装；平台改为可注入后，这批回归在 POSIX runner 上真正执行而不是 skip。

## [0.1.1] — 2026-09-08

### Changed

- 产品与仓库统一为 RoleWeave / `bytefolk/roleweave`，使用带透明安全边距的 R/W 应用图标。
- 岗位文档采用左右分栏阅读，组织共享文档对接 `bytefolk/doc` v1 API；访问凭据仅留在服务端。
- 优化项目切换、员工创建、群聊成员搜索以及记忆来源展示。

### Fixed

- 修复 macOS 发布时误拒绝签名更新清单的问题，发布前校验清单签名、版本及 ZIP 大小和哈希。
- 安装包文件名、GitHub 发布坐标与 macOS 签名更新清单统一使用 `roleweave`，避免更新器寻找旧名称安装包。
- 保留旧环境变量、工作区数据迁移和应用 ID；旧开发包需手动安装新版一次，不放宽更新信任校验。

## [0.1.0] — 2026-09-03

初始公开版本，包含 D0–D4 全部开发切片的审查合并。

含 PR #3（feat(d1): 组织树只读）与 PR #7（fix(examples)）。

> 版本归属说明：本节由发布 v0.1.0 之前的 `[Unreleased]` 里程碑堆积转名而来，块内条目实际跨 v0.1.0 与 v0.1.2 分批发布，未在本变更中逐条重分派。
> 复核依据（`git merge-base --is-ancestor`）：`6fdb582`（#127 layout parity）、`d738343`（#146 i18n）、`4a1de4b`（#135 auto-update）是 `v0.1.1` 的祖先但不是 `v0.1.0` 的祖先；
> `c2bff33`（#206/#221）、`bbacc69`（#236/#238）、`b981b7d`（双主题）、`d209a97`（#239/#240）、`2faf6d4`（#156/#224）是 `v0.1.2` 的祖先。
> 逐条按版本重分派留待单独一次文档变更处理；本文件只保证不丢条目、不虚构归属。

### Added

- #329：手机打开 RoleWeave 时进入原生手机壳（组织 / 指令 / 桌面 / 设置），而不是缩过的桌面工作台。组织页只读预览 `examples/oss-maintainer`；回合仍在已打开的电脑桌面执行。

- #127 AC-004 跨平台布局一致性证据：新增 layout smoke 模式（macOS arm64 / Windows x64 双平台，全应用渲染两栏组织工作区并由 main 进程度量列矩形写报告），verify.yml 新增 layout-parity job 下载双平台报告比对（per-platform bottomDelta ≤2px、per-platform 两列高差 ≤2px、跨平台宽差 ≤4px、跨平台 chrome overhead 差 ≤8px，阈值声明在 scripts/check-layout-parity.mjs）。跨平台一项自 #190 起比的是 chrome overhead（`viewport.innerHeight - 列高`）而非绝对列高：runner 给两侧的窗口高度本就不同，比绝对高度量到的是 runner 而不是布局，#190 之前的「高差 ≤8px」写法已随之作废。顺带修 #150 打包缺口：doc-plane.js 未登记 SERVER_RUNTIME_FILES 导致打包 server 启动即崩、main CI 红。
- #146 国际化骨架与全量迁移：`@org-workbench/ui` 新增 `OwbI18nProvider` / `useT` / `zhText` 与 zh-CN/en 双目录（440 key，parity 门强制 key 集合一致）；标题栏新增语言切换钮（恰好两态，持久化，默认 zh-CN，antd ConfigProvider locale 同步切换）；renderer 与 ui 包全部用户可见文案迁入目录，`i18n-cjk-gate` 测试扫描源码字符串字面量内的 CJK 防绕过；数据层（turn 原文、信封、组织文件、裁决输入）不翻译。
- #167 组织图画布化收尾：视口 overflow:hidden 零滚动条，平移纯拖拽（transform translate + pointer capture，4px 点击阈值保留），缩放（按钮/捏合）以光标为锚；选中岗位 translate 居中替代 scrollIntoView；布局不再随滚动条跳动。描述语精简到标题：图表头部只留标题、空态只留标题行、composer 空闲提示行移除（运行态/禁用原因保留）。
- 上下文来源与统一网盘入口：岗位卡片展示岗位知识库、mem 统一网盘和岗位级 context 来源；新增 Workbench 内网盘模块，支持清单、搜索与详情查看，不引入 Obsidian 客户端。
- #132：新增 macOS arm64 DMG/ZIP 与 Windows x64 NSIS 安装包构建；保持无签名、Windows per-user 和 `--publish never`。安装/启动/卸载行为验证仍待后续切片。
- **D2 目录提案编排**：招聘直接生成嵌套岗位包与 0600 原子写 `budget.json`，调岗整目录 rename，裁撤移至树外 `.digital-employee/backup/<id>-<stamp>/`；支持移至根和 `maxDepth=8` 防御上限。
- **引擎 org-audit 报告流**：`GET /reports` 改读 `.digital-employee/org-audit.jsonl`（org-audit.v1）。
- **真实引擎契约测试**：覆盖 workspace 参数、严格 status/payload 解析、拒绝时应用态字节零变更与提案保留。
- **`packages/ui` 组件包**：OrgTree / OrgTreeNode / PositionCard / BudgetBar 四组件，消费 design-system 语义 token；OrgTree 支持键盘树导航（↑↓ 移动、←→ 折叠展开）。
- **React/Vite 渲染层**：桌面壳 renderer 重写为 AppShell 四区布局（Sidebar 288px / 主区 / 岗位卡片 / 预算条），SSE `org.updated` 驱动自动刷新。
- **冻结契约类型**：`packages/shared/src/org-tree.ts` 提供 org-tree.v1 类型与运行时守卫。
- **workspace-state**：服务端工作区状态管理，`/org/tree` 返回冻结形状快照。
- 测试：ui 14 用例（vitest）+ server 侧 workspace/apply 断言扩展。
- D3 `POST /turns` / `GET /turns?positionId=...` 控制面，只允许 Qoder 与 Claude Code；密封 `turn-envelope.v1`、严格 `engine.v1` NDJSON、turn SSE 与退出码 1 不自动重试。
- 工作区本地 `turn-record.v1` / `turn-history.v1`：0600 原子文件、0700 目录、崩溃遗留 running 回合恢复为 indeterminate，拒绝符号链接与无界历史。
- D3 `@岗位` 对话面板：组织树与岗位选择器联动，本地历史加载、回合发送与服务端 readback、Host idle 禁用、API 失败保留输入、信封 digest 展示；委派链与长期 Context 继续诚实标记为 Planned。
- `/health` 增加 Qoder/Claude Code 各自的 `configured` / `ready` / `nextStep` 本地预检，仅返回布尔值和非敏感操作提示；bundled `qoder-engine` 以本地 Qoder 1.1.x 的有界版本探针作为前置，普通 `digital-employee` 仍保持 service-token 门禁。renderer 不读取凭据，也不从引擎可达性推断远端 Host entitlement。
- D2 工作台交互：组织树拖拽只生成 move 清单；招聘弹窗强制声明 token 预算；裁撤二次确认；`.digital-employee/backup` 恢复区支持显式幂等恢复和冲突保护。
- D4 上报中心：从真实 org-audit 和本地 turn record 派生脱敏证据、失败/不确定升级链及已记录预算用量；空状态与损坏数据均 fail closed，不显示原始输入/输出。
- 枚举式 `orgBackups` / `orgRestore` / `reports` IPC 与恢复 ID 边界验证；renderer 仍无通用请求或文件写能力。
- org-workbench #12 R2 显式 session：`workbench-session.v1`、create/list/get/rotate/session-turn API，server-owned principal/workspace mapping、每岗位单 active、多 session 只读历史和 zero-history-copy successor。
- Desktop 枚举式 session IPC 与岗位会话选择器：显式新建/轮换、旧 session 只读切换、session-scoped turn/readback；不暴露 boot token、绝对路径或 mem/context 能力。
- Session 持久化安全门禁：0700/0600、单文件原子 rotate、并发双 rotate 幂等、running-turn conflict、重启恢复、symlink/路径/损坏/错 workspace/无界状态 fail closed。
- org-workbench #15 R1 Context exporter：可信 session `completed` 回合落盘后异步生成两条 scoped `context-occurrence.v1`，持久 `pending|done|failed` 与跨重启幂等恢复；固定消费 `context@f63f57f` 公共 CLI/stdio adapter，失败不重跑 Host。
- Context exporter E3：真实临时 SQLite vault 通过 provider grant → ingest/distill → recall/readback 验证两条 raw occurrence，另覆盖 partial replay、wrong scope、revoked token、adapter outage、symlink/corrupt state 与 failed/indeterminate 不导出。
- #32 组织树真实拖拽：body 投放生成 move 提案，上/下四分位插入线生成同级排序（`change-manifest.v1` 新增 `reorder` op，跨级插入以 move+reorder 单清单原子提交）；投放到自身/下属 dropEffect=none 拒绝并轻提示；⌘↑/⌘↓ 同级排序、⌘←/⌘→ 调级，企业负责人拦截提示。
- #32 排序持久化：`org-layout.v1` 覆盖层（`.digital-employee/org-layout.v1.json`，0600 原子写，零迁移、引擎不触），reorder-only 清单不调引擎；快照同级顺序覆盖层优先、字母序兜底，open/reload 时自动修剪与补齐。
- #32 单步撤销：`POST /org/undo` 回放 inverseMoves 并还原覆盖层（404 `not_found` 表示无可撤销）；renderer「撤销」按钮与树聚焦时 ⌘/Ctrl+Z。
- #32 创建入口：组织树行 hover「+」与空态按钮打开招聘弹窗并预置汇报对象。
- #73 Control Plane v2：组织树连接线（guide-rail，选中即递推点亮祖先链路）、岗位状态灯（仅映射真实在途回合）、42×6px 微型预算条；对话面板改证据时间线（`.owb-tc` 控制台卡：状态圆点/状态行/证据印章 chip/内嵌审批卡），群聊仍保留气泡布局。
- #73 无边框窗口自定义标题栏：`owb:window:minimize` / `owb:window:toggle-maximize` / `owb:window:close` 三个枚举式 IPC；每个 handler 均校验 `event.senderFrame` 是 mainWindow 自身主 frame 且仍在展示打包渲染层（`window-ipc.cjs` 纯函数 + 6 条负向单测），并对 mainWindow 加 `will-navigate`/`setWindowOpenHandler` 拦截，拒绝导航到打包文件之外的任何地址与新窗口。
- `apps/desktop/test/contrast.test.cjs`：对 `--ui-foreground-subtle` 在亮/暗两套主题的全部 5 个背景阶做真实 WCAG 对比度计算断言（≥4.5:1），而非仅检查 token 字符串存在。
- #94 主题切换入口：自定义标题栏新增亮/暗切换按钮（`aria-pressed` + 目标态 `title`/`aria-label`），`theme-mode.ts` 提供唯一的 `data-theme` 写入路径与 `localStorage` 持久化，`main.tsx` 在 `createRoot()` 前种子化。未显式选择过时跟随系统 `prefers-color-scheme`（含运行时变化），首次点击即固化为显式选择并停止跟随。`antd-skin.css` 的暗色调色板与 antd `darkAlgorithm`/`ANTD_SEED.dark` 自 #73 起已完备，此前只是无人可达。
- #110 Lane A：新增 macOS arm64 / Windows x64 原生无产品签名的 unpacked staging、逐文件字节精确的运行时 inventory/拒绝清单、架构与签名状态核验，以及从源码树外 clean staging 启动后证明静态 renderer、控制面 ready 和严格 process-ownership 边界归零的 smoke；command/staging path 不授予 signal 权限。只扩展只读验证工作流，不含安装器、分发签名、发布或自动更新。#111 的 Finder PATH → Qoder/MCP fixture → turn/history 行为资格验证保留为独立 macOS-only command/schema，不与 static smoke 混称。Windows 原生结果已由 `windows-latest` 在 head `59b7eaf` 实际运行验证（run 33601662786：package / verify / smoke 全绿，verifier 报告 33 required entries、189 packaged files、`authenticode-not-signed`）；该结果不外推到安装包、签名与自动更新路径，Windows 上的 Qoder 残留断言按构造未被执行，见 #131。并入 #122 中未被本分支取代的部分：Windows 下 `.bat`/`.cmd` 启动脚本的 shell 路由（Node 因 CVE-2024-27980 加固拒绝无 shell 执行，缺此项打包后的 Windows 应用无法启动 Qoder）、Qoder 子进程环境补入 `PATHEXT`/`ComSpec`/`SystemRoot`/`WINDIR`，以及测试可移植性辅助（NTFS 合成权限位改用 `assertPosixMode` 跳过、exec `#!/bin/sh` fixture 的用例在 win32 跳过）。曾一并并入的 `windows-latest` check 矩阵腿**已撤回** —— 该套件按 POSIX 进程与文件系统语义编写，在 Windows 上跑 `npm run check` 挂起逾一小时且无有界失败可定位；Windows 改由专门的 staging package/verify/smoke 腿覆盖（与 cc-haha 同形：其全部质量 job 均在 ubuntu 上，Windows 只跑针对性检查）。撤回时保留了这次尝试的两项产物：所有 `node --test` 的 `--test-timeout` 上限与 check job 的 `timeout-minutes`；#122 的打包面（两条目 `WIN_APP_REQUIRED_ENTRIES`、`signAndEditExecutable`、重复的 package-windows job）已被本分支取代而未并入。
### Changed

- #35 文档模块视觉整理：增加岗位文档上下文、文件类型与大小信息，优化文件选择/复制引用/解析引用的层级，并补齐加载、空状态、错误状态及窄窗口适配；文档引用契约与读写行为不变。
- **D4 上报中心视觉层级**：首屏优先展示有事实的数据流，预算快照集中呈现单任务/单日指标并提供成本看板入口；同时补齐只读边界提示、空态容器、选项卡语义和窄窗响应式布局。
- GitHub repository and raw-content coordinates now target the `bytefolk` organization while the published `@fullstack-ai-infra/*` npm scope and desktop application ID remain unchanged.
- `DigitalEmployeeCliDriver` 调用翻转为 `digital-employee org apply <workspace> --json`；成功后控制面从 `.digital-employee/org.json` 重载应用态，`org.updated.updatedAt` 与引擎时间戳对齐。
- oss-maintainer 示例改为目录表达汇报线的嵌套布局，并为每个岗位增加 `budget.json`。
- 桌面壳 IPC 白名单新增渲染层所需通道（preload）。
- 桌面壳新增枚举式 `createTurn` / `turnHistory` IPC；没有通用 HTTP/IPC 请求入口，boot token 继续只留在 main process。
- README：状态更新为 "D0 骨架 + D1 组织树只读"，补充 design-system 开发期 `file:` 链接说明（同级克隆 + `npm run build:package`）。
- #73 token 层：暖纸画布/圆角 6·10·14·18/动效三档 120·160·240ms 统一（含 design-system 原生 duration/ease 一并收敛）；新增 Space Grotesk 展示字体 + JetBrains Mono；PositionCard 从 antd Card 改造为自定义 `owb-panel`。
- BrowserWindow `minWidth` 980→640：原值使 `@media (max-width:680px)` 断点（侧栏隐藏、单栏堆叠）在真实窗口不可达，只能靠 DevTools 视口模拟验证，现在拖窗边缘就能触发。

### Removed

- 旧 staging/rejected/applied 发布机制、客户端 `apply-log.ndjson` 写入和 `archive/` 裁撤路径。
- 旧原生 renderer（app.js / index.html / style.css）。

### Fixed

- #194（Refs #127 AC-004、#190、#180）layout-parity job 在同一份代码上非确定性变红：run 33781690234（`d89ceb5`）macOS 列高 565px、chrome overhead 116px 通过；run 33782374969 第二次尝试（`fbff520`）同一平台量到 515px、overhead 166px，跨平台 overhead 差 50px 而失败；对同一 commit 做完整重跑（第三次尝试）又回到 565px / 116px 通过。`d89ceb5` 与 `fbff520` 共享同一 tree `23443b161487417bd0228852f1f70d66c28597ba`，即渲染层与样式完全相同——变的是量测时机，不是布局。Windows 侧 604px、两侧列宽 314px、`bottomDelta` 0、viewport（mac 1024×681 / win 1024×720）在全部三次采样中恒定，失败那次报告自身仍是 `ok: true`。根因：`LAYOUT_MEASURE_SCRIPT` 只轮询两栏**是否出现**，出现的那一瞬间就量一次；presence 不等于 settled geometry，webfont swap 会在两栏首次出现之后再次回流列高，而脚本既没有 `await document.fonts.ready`，也没有 rAF 或任何收敛条件，于是量到的是 runner 那一刻恰好看到的中间态。修复分两半：① 量测端在挂载轮询之后先 best-effort 等 `document.fonts.ready`（reject 不得让一次本来正常的量测失败），再按最多 60 个采样点取样，直到连续 3 次采样间五个字段的最大漂移 ≤0.5px 才判定 settled，并把 `settled` 写进报告；每次迭代用 `requestAnimationFrame` 与 50ms 定时器**互相 race**，因此 CI runner 上一个被遮挡、始终没有合成的窗口不会把脚本挂到预算之外。② 校验端 `readLayout` 拒绝 `settled !== true` 的报告——与 #190 拒绝无 viewport 同理，refused 而非 compared：一份没收敛的量测是"那个 runner 何时看了一眼"的样本，两份这样的样本比的是两个任意时刻。该检查排在 viewport 检查之后，因此两者都缺的报告仍然报更旧、更具体的那条缺失。**四条阈值（bottomDelta ≤2px、两列高差 ≤2px、跨平台宽差 ≤4px、跨平台 chrome overhead 差 ≤8px）未被触碰**：settle 预算只决定何时停止等待，从不决定什么算一致；0.5px epsilon 落在全部四条阈值之内，遮蔽不了真实失配，并有专门用例锁定"已 settled 但确实失配的报告照旧失败"。`schemaVersion` 保持 `org-workbench-layout-smoke.v1` 不变（#190 新增的 viewport 也是在 `.v1` 下成为必需字段的，且无代码校验该串）。排障坑：对 layout-parity 用 `gh run rerun --failed` 是 no-op——它只会重新下载同一批缓存 artifact，只有完整重跑 workflow 才会重新量测，本次诊断因此白跑了两次。测试：校验端新增 5 例（拒绝未收敛、拒绝 #194 之前的旧报告而非默认其已收敛、错误信息点名未收敛的那一侧、两者皆缺时的检查次序、settle 门不遮蔽真实失配），量测端新增 4 例——在 vm 里以 stub DOM **实际执行**注入脚本，因为 #183 那道守卫只解析脚本不运行它，此前没有任何测试能证明渲染端真的产出 `settled`；一个仍返回 #194 之前形状的渲染端不会让任何单元测试失败，只会让 parity job 在 CI 上永久变红。两半都做了 mutation 验证（把渲染端改成恒报 settled、把校验端的拒绝短路，各自只有预期的用例失败）。同时修正本文件 #127 AC-004 条目中自 #190 起就已作废的「跨平台高差 ≤8px」表述。
- #156：WSL 拓扑下桌面壳向控制面服务端发送工作区路径时，Windows 盘符路径（`C:\...`）现在经 `serverPathForWorkspace` 转换为 `/mnt/c/...` 再 POST 到 `/workspace/open`；native 模式与非 win32 主机原样不动。`main.js` 全部四处 POST（`ORG_WORKBENCH_DEFAULT_WORKSPACE`、#145 的持久化上次工作区、demo 兜底、目录选择器 IPC）都已接线；转换只发生在跨边界的这一处，服务端因此不必解析盘符，仍只接受自身原生绝对路径——`wsl` 模式下跑在 ext4 上、根本没有 Windows 表示的工作区照旧可用（AC-003）。持久化刻意不转换：`last-workspace.json` 存原始 Windows 路径，因为开机重开时的 `fs.existsSync` 在 Windows 侧执行，`/mnt/c/...` 在那里永远解析不到（AC-005 的可执行形式）。`openDefaultWorkspace` 的 `existsSync` 早退与 HTTP 非 200 响应均写 stderr（含当前 mode 与原始 dir），不再静默丢弃（AC-006）。新增源码接线断言：`main.js` 中每处 `/workspace/open` POST 必须经过 `serverPathForWorkspace`，后续再加站点会被同一条测试拦住（AC-004）。
- 审批中心现在明确说明用途与数据接入状态；未接入回合历史/事件流时不再把空列表误报为“所有回合都在界内运行”，并提供返回组织模块的入口。审批岗位、动作描述与目标中的多层 Unicode 转义也会在展示层恢复为可读中文。
- #137 组织页主区重构为两列工作区：左列上下堆叠组织图与岗位档案（同宽对齐），右列由本地对话面板独占整列高度，回合流拿回被全宽组织图压掉的纵向空间。`.owb-workspace-grid` 包装层移除，布局单源挂在 `.owb-org-module`（grid 两列 + `__left` flex 列）；组织图在半宽左列内横向溢出改为列内滚动（`overflow-x: auto`），纵向仍自然撑开；980px 单栏堆叠与 720px 竖向压缩断点按新选择器等价重述。`org-panel-sizing` / `panel-parity` 两套 CSS 契约测试同步换选择器，并新增 #137 左列配对断言（chart flex none + 档案卡 flex 1 + 模块级 stretch）。契约面未触碰。

- #128 桌面本地对话模块 UX 收敛：① 导轨「记忆」项曾无 `onSelect` 也无渲染分支，用户点击后毫无反馈；在 mem plane 未接入桌面前，直接从导轨移除该假入口而非保留占位（AC-004）。② 对话文本框 `onKeyDown` 现在识别 `nativeEvent.isComposing` 与 legacy `keyCode === 229`，中文候选窗提交 Enter 时即便手指还在 ⌘/Ctrl 上，也不会误发送回合；提示条 `⌘↵ 发送` 与非组合期行为保持不变（AC-003）。③ `TurnThread` 空态首行不再固定读作「从一个明确任务开始」，改由 caller 传入 `emptyPrompt`，`TurnPanel` 将其绑定到 `disabledReason`，因此空态与下方 composer 提示不再互相打脸（AC-002）。④ 新增 vitest 用例锁定：树点岗位→对话面板 combobox 同步、IME 组合期 ⌘↵ 不发送、空态口径与 disabledReason 一致（AC-001/002/003）。契约不变（`turn-envelope.v1` / `workbench-session.v1` 未触碰），后端 D3 主链路仍是 `smoke:package:macos` 的既有绿证。
- #127 桌面主区双面板视觉一致性：① 单源化 `.owb-workspace-grid` 与 `.owb-workspace-grid > .owb-turn-panel`——之前它们分别在两个块里被声明为 `align-items: start` + `height: calc(100vh - 116px)` 与 `align-items: stretch` + `height: auto`，级联胜出的是后者，但早期声明作为死代码留在 stylesheet 里，混淆了 cascade 追踪；现在删除早期块，layout 意图只在"主区：14px padding + 两栏"处单点定义（AC-001）。② `.owb-position-column` 由 `align-self: start` 改为 `align-self: stretch`，让岗位档案卡与本地对话面板真正等高，而不是空态时明显矮一截（AC-001）。③ 新增 `apps/desktop/test/panel-parity.test.cjs`——用 postcss AST 断言两条顶层规则各自唯一、位置列 stretch、`@media (max-width: 980px)` 单栏堆叠保住 380px 最小高度、`@media (max-height: 720px)` 竖向压缩降为 0 转由内滚（AC-001/002）。契约面未触碰。AC-003（对话文本框中文 IME `⌘↵` 抑制）已在 #128 落地；AC-004（Windows 视觉一致性证据）继续挂在 #122 后。
- #120: the Org page's lower-left position region read materially smaller than the adjacent local-conversation panel. Two declarations caused it independently: `.owb-workspace-grid` still sized its tracks `minmax(300px, .92fr) minmax(360px, 1.14fr)`, so the left column was permanently a step narrower — and because the two px floors were unequal, they, not the `fr` ratio, decided the width wherever the grid ran out of room (300px vs 360px at 981px) — while #98's `align-self: start` + `grid-template-rows: auto auto` made it shorter as well. Above the 980px breakpoint the two regions are now one equal pair: both tracks are `minmax(0, 1fr)` with `min-width: 0` on the items, and the column stretches to the row again, with the card taking the column's remaining height, `.owb-pos-body` growing and scrolling, and the 裁撤 action staying at the column bottom. This supersedes only #98's panel-sizing choice; the org-chart expansion, collapse and scroll-to-selection work from #99 is unchanged. Measured in headless Chromium against the built renderer bundle at 1280×900 / 981×900 / 1280×700 / 1600×1000, the width, top and bottom deltas between the two regions are all 0.00px, against 94.44 / 60.00 / 94.44 / 128.59px wide and 232.80 / 137.94 / 32.80 / 352.80px tall before. Under vertical pressure the body scrolls instead of overflowing (at 1280×560: 288px of content in a 181px box, dismiss still inside the column; before, the column overran its own row by 107.20px). At 980px and below the stack and its horizontal reachability are unchanged. Stretching the column exposed one consequence, which product called in during review: with no position selected the guidance row sat in a 79px box with 486.55px of empty card under it at 1280×900 (146.55px at 1280×560), so it now grows into the card and centres — 0.51px off the vertical centre of the free space, with the equal-pair deltas still 0.00px — covering the 已裁撤 notice state the same way. Two more review points, plus a regression the rebase onto main exposed. (a) #130 (which implements #127) declares `align-self: stretch` explicitly inside the single-sourced `.owb-position-column` block, and AC-002 rejected it because it only accepted the inherited `null`/`auto` — so the two gates contradicted each other on one rendering-equivalent value. The contract is the stretched state, not which rule declares it, so AC-002 now accepts `stretch` and still fails on an opt-out value such as `start`, matching `panel-parity.test.cjs`. (b) The duplicate adjacent `#120` entry is folded into this one. (c) #130 also deleted the block that carried `display: grid`, and no other `.owb-workspace-grid` rule in the file declares a display type, so the element fell back to `display: block`: both regions spanned the full 898px grid width stacked vertically, `grid-template-columns` was inert, and AC-001 still reported 0.00px because two equal full widths are trivially equal. The declaration is restored and AC-001 now pins `display: grid` before it asserts anything about the tracks. Re-measured in headless Chromium on the rebased tree: before, 898.00×338.58 against 898.00×274.89, stacked, with 338.58px / 274.89px top and bottom deltas and the regions overlapping; after, 442.00×631.38 against 442.00×631.38 side by side, all three deltas 0.00px, no overlap — holding at 981×900 (292.50px), 1280×700 and 1600×1000 (602.00px).
- #116: 用过个人会话的成员现在能正常建群。`POST /groups` 的锚 session 改为**复用优先**——首个成员岗位已有 active session 时直接以该会话为锚（只读绑定：不写岗位状态文件、不轮换、不追加会话），只有无 active session 时才新建，于是建群不再回 409 `session_conflict`；同岗位的多个群与并发创建共用同一锚，不会为每个群额外造会话。renderer 侧创建失败原先落在 `panelError` 却只在已选中群时才渲染，点「创建群聊」看着毫无反应；告警现在置于会话区顶部，一个群都还没有时同样可见（`role="alert"`，展示服务端原文）。显式 `POST /sessions` 的 409 与轮换语义不变。
- #112: `GET /reports` now aggregates bounded, validated `turn-record.v1` facts from both legacy position conversations and durable session conversations, so completed session turns remain visible as public-safe evidence, derived timeline entries, and observed budget usage after rotation or restart. Session facts must bind to the existing authoritative workspace/position/session state; file-handle-stable reads, shared byte/entry/temp limits, ordinal ordering, and cross-root identity checks make orphaned, duplicated, raced, unsafe, unbounded, or inconsistent local facts fail closed.
- #113: the bundled `qoder-engine` now implements the existing `hire validate <file> --json` gate used by `POST /hire`. It accepts only a bounded regular non-symlink `hire-request.v1alpha1` file, mirrors the frozen field/budget/deadline constraints, and preserves upstream's opaque minLength-16 `envelopeDigest` semantics without spawning Qoder or touching the workspace. Cross-platform path/handle identity and size checks plus a fixed MAX+1 positional read reject replacement and growth races. A valid static result still only opens gate one: the control plane stages the exact skeleton and requires the existing `org apply` gate before publishing the employee, with rollback on rejection.
- #114: 群聊实时态按 exact message/turn/position/engine 归属结算；202/SSE 竞态、乱序终态或事件流断开时，通过有界持久化时间线对账恢复完成输出与在线状态，并按稳定 `turnId` 去重，无需重新选择群聊。
- #125 review follow-up：Windows `.cmd`/`.bat` Qoder launcher now goes through an explicitly escaped `cmd.exe` invocation with `shell: false`; prompt metacharacters remain argv data instead of becoming shell commands.
- #110 independent review：进程清理只信任当前验证的 root/descendant、已绑定 identity，以及 POSIX 上来源代际未歧义的预期 detached group；Windows null-root fail closed，路径/command 只作诊断。static/behavior controls 按 Windows 大小写语义在任何 report reservation 前互斥检测，并从实际 child env 剥离；两种 smoke 共享 load/renderer/window lifecycle gate，失败报告 nonce/stage 绑定且 descriptor take-and-null，覆盖 post-report crash、重复事件与四个 production renderer timeout mutants。Windows native 仍为 **NOT VERIFIED**。
- #110 current-main integration：显式 server runtime inventory 新增 #119 生产依赖 `dist/src/stable-read.js`，缺文件时 layout 与 production verifier 均 fail closed；独立 macOS behavior qualification 改走 durable session create → session turn → session-history readback，实际加载该打包模块。#119 的 session/turn/report production code 与 tests 保持逐字节不变，Lane A static smoke 的结论不扩张。
- #104: 桌面默认的 bundled `qoder-engine` 已能真实执行本机 Qoder 回合，但 `/health` 仍只检查 `QODER_PERSONAL_ACCESS_TOKEN`，导致 renderer 把可用 Host 错误禁用。现在仅在引擎精确宣布 `qoder-engine <semver>` 时，以 health/turn 共用的无 shell resolver 解析绝对 Qoder executable：显式覆盖无效即 fail closed，否则查 PATH 与 macOS 已支持的用户安装位置；有界版本探针支持 1.1.x，缺失、非普通文件、不可执行、超时和版本越界均有非敏感下一步。turn 子进程保留继承 PATH；Finder 登录 PATH 恢复与打包验收由 #110 的 macOS arm64 foundation partial 承接，不是 #104 的完成依赖。普通 `digital-employee` 的 Qoder service-token 规则、Claude 判定和远端 entitlement 边界不变。
- Renderer verification now isolates Vitest workers from Node 26's experimental global Web Storage, so Node 24 and Node 26 both exercise jsdom-owned `localStorage` without changing Electron theme persistence.
- #110 macOS arm64 foundation（partial）：Finder/LaunchServices 的最小 PATH 无法发现用户 Qoder/MCP 命令。桌面 main 现在用固定 argv、单行 marker、绝对路径校验、输出上限和 `SIGKILL` 硬超时只恢复登录 PATH；失败保留原 PATH，不导入其他 shell 环境。`ELECTRON_RUN_AS_NODE=1` 只到桌面默认 bundled engine；health/hire/org 的普通 operator CLI 使用无凭据运行时 allowlist，turn 只携所选 Host 的明确授权，真实 Qoder/Claude probe 同样不读凭据。bundled Qoder adapter 只接收受支持的 binary/permission 配置，真实 Qoder/MCP 后代只接收 Qoder 运行时/凭据 allowlist，server boot token、internal marker、Context authority 与任意 secret 均不会跨越各自边界。
- #100: restore the two missing renderer stylesheet block closures so approval and audit-timeline styles parse in their intended scopes; add a focused PostCSS regression guard.
- D4 rejects symlinked/oversized org-audit sources before bounded reads, projects audit entries through an exact allowlist, and no longer reuses the latest per-task ratio as a per-day percentage when no day bucket exists.
- D3 turn control plane now preserves split UTF-8 output, accepts the upstream 1,048,576-character model boundary, reaps timed-out engine processes without late SSE, and safely preserves allowlisted spawn error codes.
- Active turns are no longer recovered as interrupted; trusted terminal SSE is emitted only after the final turn record is durably persisted, and position IDs mirror the engine organization contract.
- Persisted turn recovery now rejects unsafe or filename-mismatched turn IDs before path construction, and D2/shared/server/Desktop consume one position-ID validator (`7x` valid; repeated or trailing hyphens invalid).
- 桌面壳从 Vite 的实际输出目录加载 renderer，干净构建不再依赖被忽略的旧产物。
- renderer 按 IPC 的真实响应结构读取引擎健康状态，不再把可用引擎恒显为离线。
- renderer 可读取当前 SSE 连接状态，避免窗口加载晚于连接事件时一直显示“事件流重连中”。
- Electron 从 33 升级到 43.4.1，清除当前依赖审计中的高危漏洞；新增 Linux/macOS 双平台源码门禁。
- oss-maintainer 示例工作区：去除机器专属的 `localReference`，改用可移植占位路径；真实绝对绑定由引擎 apply 时重算。
- #73（`a47a803`，先于 PR #77 review，非本轮修复）：`antd-skin.css` 头注释里 `--ui-duration-*/--ui-ease` 中的 `*/` 提前闭合整块 light token（CSSOM 解析丢弃，仅 CDP 计算值能看出，静态检查看不出），改写措辞避开 `*/` 组合。
- PR #77 review：`--ui-foreground-subtle` 对卡面对比度只有 3.49:1/3.81:1（9-11px 文本不适用 large-text 的 3:1 门槛），调整为 `#66685f`/`#92958b`，全部背景阶 ≥4.62:1。
- PR #77 review：预算仪表 `>100%` 时宽度被夹到 100%、且 `aria-valuenow` 可超出固定的 `aria-valuemax=100`（非法 meter）——改为不夹宽度（轨道 `overflow:hidden` 移除，允许圆角端帽出界）、`aria-valuemax` 随读数动态取 `max(100, 当前值)`，保证 `valuenow <= valuemax` 恒成立。
- #86: `buildPositionSkeletonFiles` now JSON-quotes the generated SKILL.md frontmatter's `name` field (matching `description`'s existing escaping), so a purely numeric or YAML-reserved-word position ID (e.g. `1234`) no longer parses as a non-string YAML scalar and fails `org apply` with `employee_skill_name_mismatch`.
- #92: the `POST /hire` description bound now mirrors the real upstream constraint — at most 1024 **characters** (UTF-16 code units) on the trimmed value, matching digital-employee's `validateSkillFrontmatter` SKILL.md frontmatter check, which is stricter than `employee.json`'s own 2000-character bound. It previously allowed 2048 **bytes**, so a 1025-2048 character ASCII description passed every org-workbench gate, was staged to disk, and only failed at `org apply` with an opaque `employee_skill_description_required` (same defect class as #86, which fixed the sibling `name` field). The desktop IPC gate, which had no length check at all, now mirrors the same bound, and `docs/api-contract-v0.md` §2.14 documents it for the first time.
- #94: the composer's send button (and the cancel button in the same slot) went nearly invisible when disabled — reported directly ("看不清标志了") with the composer in its default empty state, which is disabled by default. Root cause: `.owb-turn-composer__surface button:disabled` dimmed the *whole button* via `opacity: 0.45`, and because both the white icon and its saturated `--ui-ai` (#722ed1) background were dimmed toward the same backdrop together, they collapsed toward each other rather than fading evenly — measured ~2.2:1, under the 3:1 WCAG floor for a UI icon. Fixed by swapping to `--ui-surface-raised` / `--ui-foreground-subtle` instead of opacity: the same pair `contrast.test.cjs` already holds to ≥4.5:1 on every surface tier in both themes.
- #94: the three real window-control buttons in the custom title bar (`.owb-wctl`, added in #73) rendered their close/minimize/maximize glyphs at `opacity: 0` by default, only reaching `opacity: 1` on `:hover`/`:focus-visible` of the *entire* title bar. Unlike a decorative macOS traffic light, these are the only way to close/minimize/maximize a frameless window, so shipping them with zero default affordance was a discoverability defect for first-time and keyboard-adjacent users, not a stylistic choice (reported directly by a reviewer while testing this same PR). The glyph now renders at full opacity always, in a theme-aware `var(--ui-foreground-muted)` stroke instead of the old hardcoded `rgba(0, 0, 0, 0.62)` (which only worked because it used to appear exclusively over the light hover backgrounds); hover/focus still swap in the semantic danger/warning/success background and switch the stroke back to the dark tone for contrast against it.
- #94: the Agent Host `Select` was narrower than its own longest option (`Claude Code · 本地登录 · Configured`), so the trigger ellipsised the selected host mid-CJK — and because `popupMatchSelectWidth` was unset, `@rc-component/select` pinned the popup to the trigger's `width` rather than its `min-width`, leaving no interaction that revealed the full text. `GroupsPanel` was the worse of the two: a *fixed* `150px` track that never widened at any window size. Both call sites now share one `EngineSelect`: the popup sizes to its content and keeps the readiness suffix, the trigger renders a compact `icon + host name` label (readiness is already stated in prose below the control and in the group engine chip), and both grid tracks get a `220px` floor. Host selection decides which engine runs the turn and which credential path `claude-local` vs `claude-code` uses, so choosing it from truncated labels was an operator-error path, not a cosmetic one.
- #98: the Org page's chart panel capped `.owb-org-chart__body` at a fixed `max-height: 240px` with no way to reach the hidden content except manual scroll, and no scroll-to-selection existed anywhere in `OrgChart.tsx`. A 4-level, 5-position organization needs roughly 430px to render, so the root node scrolled out of view by default and switching positions gave no hint where the newly selected card was. The cap is gone — the panel now sizes to its actual depth — and a header toggle (default expanded) lets the user collapse it back down for room instead of the layout silently deciding for them. A `scrollIntoView` effect keyed on `selectedId` now brings the selected card into view on every switch, honoring `prefers-reduced-motion`.
- #98: the position card (`.owb-position-column`) was force-stretched to the conversation panel's height via `align-items: stretch` + `grid-template-rows: minmax(0, 1fr) auto`, but the card's own content (`.owb-pos-body { align-content: start }`) has no section designed to absorb extra height — everything past "Context Scope" was blank white space with no semantic meaning, unlike the conversation panel's own flexible row, which fills leftover height with a designed empty state. The column no longer stretches (`align-self: start`, `grid-template-rows: auto auto`); the card sizes to its own content and the conversation panel keeps the full row height.

### Verification

- #110 Lane A 原始候选 `2645033`（old base `764bfe0`）：macOS 15.5 arm64 本机以单一前台串行链从 cold `npm ci` 开始，通过 focused scripts 15/15、desktop behavior 17/17、packaged renderer 2/2、完整 `npm run check`、无产品签名的 unpacked staging、manifest/arm64 核验及 static clean-staging smoke；该证据只属于原始固定 SHA，不自动覆盖后续 current-main 集成。主 executable 的签名口径是 `unsealed-linker-adhoc`，不是产品/分发签名。Windows x64 原生结果仍为 **NOT VERIFIED**；current-main 集成链见 `docs/evidence/issue-110/lane-a/README.md`。
- #110 旧 current-main evidence SHA `e8afd2c` 经 independent review 为 **REQUEST CHANGES**：process ownership、Windows env casing、behavior lifecycle 与 D6 command ledger 均需修复；它此前的绿色记录仅保留为历史，不是新 SHA gate。
- #110 historical hardened code head `3897329`（base `24ce31a`）：bundled Node 24 cold `npm ci` 保持当时 current-main lock 字节不变；exact focused integrated 68/68、packaged renderer 2/2 与完整 `npm run check` 全绿（scripts 20、UI 31、server 156+1 expected skip、renderer 157、desktop 89、audit 0）。macOS arm64 unpacked staging 通过当时的 33-entry/188-file verifier、Lane A static smoke 与独立 behavior smoke；main 后续前移后该记录只作历史 provenance，不能 gate 新 SHA。
- #110 current-main code head `4f9a983`（base `ff878d8` / PR #119）：bundled Node 24 cold `npm ci` 保持 current-main lock 字节不变；exact focused integrated 71/71、packaged renderer 2/2 与完整 `npm run check` 全绿（scripts 21、UI 31、server 181+1 expected skip、renderer 157、desktop 91、audit 0）。macOS arm64 unpacked staging 通过含 `stable-read.js` 的 34-entry/189-file exact-byte verifier、Lane A static clean-staging smoke，以及独立的 Finder PATH → Qoder/MCP fixture → durable session turn/history behavior smoke；`sessionHistoryReadback=true`，两种 smoke 的 known/bound residual 均为 0、临时 staging 均删除。25 个 #111/#119 protected paths 相对 base 逐字节不变。Windows x64 原生 staging/verify/smoke、安装器、签名、发布与更新仍为 **NOT VERIFIED / 未实现**。
- 本地 `npm run check` 全绿（ui 15/15、server 46/46、renderer 13/13、desktop-main 4/4，依赖审计 0 漏洞）；Ubuntu/macOS required checks 以 PR CI 为准。
- 真实本地引擎 E2E：digital-employee `7a92690` 成功招聘后 `/org/tree` 重载 5 岗位；非法预算拒绝码透传，`org.json`/`org-audit.jsonl`/`permissions.json` 前后 SHA-256 一致，提案和 0600 `budget.json` 保留。
- macOS 桌面壳实测：组织树渲染、岗位卡片、SSE 刷新、关窗进程退出全部通过（issue #4 验收，证据见 issue #1/#2 评论）。
- D3 后端以 fixture CLI 和 HTTP 集成测试验证；renderer 以 IPC fixture 验证“打开工作区 → 选岗位 → 加载本地历史 → 发送 → readback”、idle 禁用和 API failure。bundled Qoder 已在 macOS 本机完成真实 `POST /turns` → `completed` turn-record → `GET /turns` readback；响应正文不进入仓库。Claude Code live Host、委派与 mem recall 不在本切片范围。
- Fix for #104: Node 24.13.0 的完整 `npm run check` 通过（scripts 4/4、UI 31/31、server 148 pass + 1 expected skip、renderer 155/155、desktop-main 39/39、依赖审计 0 漏洞）；真实 bundled Qoder health、direct engine turn 与 Workbench HTTP E4 的公开安全事实见 `docs/evidence/issue-104/README.md`。
- Session E3 以真实临时 workspace 覆盖 create → turn → rotate → restart → old/read-only + successor/zero-turn，另覆盖双 rotate、running conflict、错误请求不触发 Host 和持久化攻击面。Memory recall/write 与 live Host E4 明确未实现/未验证。
- PR #77：`tsc -b`、`typecheck:ui`、`typecheck:renderer` 全绿；`test:ui` 31/31、`test:renderer` 97/97、`test:desktop-main` 27/27（含新增 `window-ipc.test.cjs` 6 例负向安全测试、`contrast.test.cjs` 1 例真实 WCAG 计算）；`npm audit --audit-level=high` 0 漏洞。`apps/server/*` 未改动，其测试套件本地重跑两次分别为 17 / 20 个失败（非确定性、失败数不稳定，`git diff apps/server/` 为空），系既有 test 隔离问题，非本 PR 引入，CI（干净环境）按 reviewer 记录为全绿；未在本 PR 内处理（越出 AC-005 边界）。窗口边缘拖拽缩放：CDP 视口模拟 940/680/1680 三档均验证通过，真实 WM 交互（WSLg）未验证，已在 macOS 实机验证通过（见 PR review）。
- Fix for #92: `tsc -b` and `typecheck:renderer` clean. The new regression test derives the boundary instead of restating a constant — it binary-searches the description length the live request gate actually accepts, then asserts the resulting SKILL.md frontmatter and `employee.json` both satisfy the upstream bounds; reverting the fix makes it fail with `accepted description of 2048 chars yields 2048 in SKILL.md frontmatter, over the upstream 1024 bound`, confirming it catches the original defect. `hire.test.ts` + `apply.test.ts` 17/18 pass (the 1 failure is the pre-existing `hire/move/dismiss` isolation flake). `test:desktop-main` 34/34. Full `apps/server` suite: 124/142 pass, 17 fail, 1 skipped — a `git stash` A/B against unmodified `main` produced 37 failures on the baseline run, so the flake's failure *count* is itself non-deterministic (as this file already records); the meaningful check is that the failing-test-name set under this change is a strict **subset** of the baseline set, with zero failures unique to the change. `test:renderer` 125/136 with the same 11 pre-existing duplicate-React failures; no renderer source is touched by this diff. `test:ui` / `security:check` not rerun locally — untouched trees, CI is the gate of record.
- Fix for #94: `npm run build` / `test:scripts` 4/4 / `typecheck:ui` / `test:ui` 31/31 / `typecheck:renderer` / `test:renderer` 155/155 / `test:desktop-main` 35/35 / `npm audit --audit-level=high` 0 漏洞，全部本地绿。新增 19 条 renderer 用例（`theme-mode` 9、`theme-toggle` 5、`agent-host-select` 4、`groups-panel` +1）与 1 条 `agent-host-width.test.cjs`。宽度门禁做过反向验证：把两条 grid track 改回 `150px` 并重新构建，断言以 `Agent Host track floor is 150px, below the 200px the compact label needs` 失败，确认它真的能捕获原缺陷。`apps/server` 未改动，其套件本地 124/142 pass、17 fail、1 skipped——与 `git stash` 后干净 `main` 的失败用例名集合**完全相同**（0 条为本次变更独有），系本文件上文已记录的既有 test 隔离 flake。桌面壳双主题的真实观感（WSLg 实机）本轮**未**由我执行，仅有 jsdom 层的属性/可访问性断言与既有 `contrast.test.cjs` 覆盖；实机确认留给 review。
- Fix for #86: `tsc -b` clean; new `buildPositionSkeletonFiles` regression test (numeric position ID stays quoted in SKILL.md) passes. `node --test apps/server/dist/test/*.test.js` locally: 112/130 pass, 17 fail, 1 skipped — the 17 failures reproduce identically against unmodified `main` (verified via a `git stash`/rebuild A/B check isolating this change), matching the pre-existing, already-documented test-isolation flake noted in the PR #77 verification entry above (not introduced by this change; CI clean-environment runs are the gate of record). Renderer/desktop suites are untouched by this diff and were not rerun locally.
- Fix for #98: `npm run build` / `typecheck:ui` / `typecheck:renderer` clean, `test:scripts` 4/4, `test:ui` 31/31, `test:renderer` 155/155, `test:desktop-main` 37/37, `npm audit --audit-level=high` 0 vulnerabilities, all local green. No new test file was added — both fixes are covered by the existing `org-chart.test.tsx` / `position-card.test.tsx` / `App.test.tsx` suites, none of which assert the removed pixel cap or the stretch behavior directly (they assert selection state, node structure, and card content, all unaffected by the layout change); a pixel-level regression guard was judged not worth adding for two CSS layout properties — flagged for reviewer judgment. `apps/server` untouched by this diff (`git diff --stat` confirms zero overlap): 124/142 pass, 17 fail, 1 skipped, the exact same shape already recorded against unmodified `main` in the #94 entry above, so it was not independently re-verified via a fresh `git stash` A/B this time. Real-window confirmation on WSLg: performed by the requester after each of the two fixes (screenshots reviewed in the linked issue), not captured as an automated check.

## [D0] — 骨架

提交 0db36fe（feat(d0): org-workbench skeleton）。

### Added

- #329：手机打开 RoleWeave 时进入原生手机壳（组织 / 指令 / 桌面 / 设置），而不是缩过的桌面工作台。组织页只读预览 `examples/oss-maintainer`；回合仍在已打开的电脑桌面执行。

- 壳-服务分离：Electron main 拉起 `apps/server`（Node，仅 127.0.0.1，每启动随机 boot-token）；控制面可脱离壳独立运行。
- 引擎消费：spawn 钉版 `digital-employee` CLI（ADR-0002）；`/health` 报告引擎可用性与下一步。
- `org apply`：staging 暂存 → 引擎校验 → rename 原子发布；失败留档 `rejected/`，裁撤归档 `archive/`，全程不硬删除（ADR-0003）。
- API 契约 v0 冻结：`docs/api-contract-v0.md`（8 端点全量；新增走增量，破坏性变更升 v1）。
