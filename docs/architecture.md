# 架构与当前边界

React 19 / TypeScript 按项目切换 Files、Dev、API、Database、Git、Agent 面板。`src/bridge.ts` 调用 Tauri 命令，`src-tauri` 负责桌面适配，`crates/studio-core` 实现本地操作。浏览器仅预览空工作区，本机操作返回桌面版要求，不生成模拟成功数据。

## 当前实现

- `WorkspaceStore` 在应用配置目录保存项目登记，不复制项目代码；移除只删除登记。
- `ServiceManager` 按项目和服务 ID 托管 Unix 进程组，支持真实状态、停止、重启、有界输出和日志尾部。切换面板不会清空后台记录；正常退出同时覆盖 `ExitRequested` 和 macOS 原生 `Exit`；在可取消的退出请求中，清理失败会阻止退出并提示。它不负责跨应用重启恢复。主动脱离进程组的命令不受托管，应以前台模式启动。
- Dev 运行配置存在项目登记的可选 `dev` 字段里（启动命令、端口、健康检查、类型、分组）。目录扫描只读识别 Spring Boot（Maven/Gradle）、Tomcat WAR、Vite / Vue CLI / Next / Nuxt / CRA / Node、Django / FastAPI / Flask；已有运行配置的路径不覆盖，没有运行配置的已登记路径只补这个字段。移除仍然只删登记。
- 生命周期与 tongyun-dev 的就绪表对齐：`stopped` / `starting` / `port_open` / `ready` / `failed`。配了端口时，端口可连接且健康检查成功（或未配置检查）才是 `ready`；端口通但检查未成功是 `port_open`；进程还在、端口未通是 `starting`。进程组一旦退出就是 `failed`，不再保留 tongyun-dev 那种约 3 秒的「启动中」宽限，避免界面同时出现失败和启动中。进程已退出且端口仍开着不算本服务就绪。未配端口的一次性命令成功结束为 `exited`，运行中只记 `starting`，不会把进程存活标成就绪。`reachable` 只在 `ready` 或 `port_open` 时为真，对应 tongyun-dev 状态里的 `running`。同一分组支持基于 depends_on 依赖拓扑顺序批量启动，等待前一个到 ready（或超时/失败）后再启动下一个；检测到环路时拒绝启动并给出单句原因；依赖项失败时下游项目跳过启动并标明被谁挡住；同组批量停止按拓扑逆序停止。
- Git 使用本机 Git。普通提交和 amend 均保持已有 index，只提交用户已暂存内容；状态解析采用 NUL 分隔，保留状态列和原始文件名。提交历史（Log Tree）走 `git log --topo-order` 读取拓扑并在 `studio-core` 计算泳道，分支/标签徽章来自 `for-each-ref`（含带注释标签的 peel），空仓库降级为空历史；提交详情用 `git diff -M` 取改动文件，支持重命名两侧 pathspec 过滤。贮藏支持 push/list/apply/pop/drop：条目下标按当轮列表校验后再拼 `stash@{N}`，Pop 在工作区仍有未提交改动时先拦截、不改历史，Drop 与丢弃文件修改都在界面二次确认；差异视图由 `src/features/diffParser.ts` 按 `@@` 头独立推进新旧行号，逐块给出 +X/−Y 统计，二进制与无 hunk 的文本不成块。
- SQLite 使用 `rusqlite`，只读打开现有项目内数据库；`query_only`、authorizer 和单语句解析共同限制读查询。限额为 1000 行、4 MiB 总结果、1 MiB 单值、64 KiB SQL、2 秒执行。SQL 写入和 DDL 尚未接入变更审批，不开放。表数据网格在单列主键表上用游标（keyset）翻页，复合主键、视图和按非唯一列排序时退回 OFFSET；排序列与游标都先经表结构白名单校验，整数主键游标必须能解析成整数。SQL 控制台支持多个查询标签页，文本、结果、耗时与来源库按标签各自保存。单行编辑只生成参数化的正向与回滚 SQL（数据网格里 `NULL` 哨兵会还原成真正的 NULL），执行仍交给外部客户端，工作台不代为写入。
- HTTP 与文件浏览使用本地核心接口。用户显式输入的开发命令允许 shell 语法；其他外部程序采用参数数组。
- 项目文件写入通过目录描述符逐层访问，拒绝路径跳转、符号链接和硬链接目标；不在项目外提前创建目录。仅 Unix 实现。
- Agent 面板读取 `.tongyun/agent-session.json`，其次读取 `.agent/session.json`，校验字段和项目绑定。它是本地快照展示，没有接入 worker 注册表、数据库记忆、消息确认或调度控制。未知模型/心跳/用量显示未知；源文件缺失或无效时清空状态。投递、暂停保持不可用；可导出明确标注来源的本地快照。

## 与 tongyun-dev 的边界

Dev 面板继承的是运行契约，不是把 tongyun-dev 仓库嵌进来，也不连接它的进程。

已继承：

- 扫描目录、预览候选、登记到工作台（或给尚无运行配置的已有登记补上命令和端口）
- 启停、重启、同组批量启停（支持 depends_on 依赖拓扑排序、就绪等待、环路拦截与依赖失败跳过，批量停止按依赖逆序）
- 生命周期 `stopped` / `starting` / `installing` / `port_open` / `ready` / `failed`，以及一次性成功的 `exited`
- 日志尾部（内存中的末尾行；每个输出流另有 64 KiB 上限）
- 日志落盘与重启可查：托管进程 stdout/stderr 按项目写到本机日志文件（默认 ~/.tongyun-studio/logs，可通过 TONGYUN_STUDIO_LOG_DIR 配置），单文件 1 MiB 上限并自动滚动备份（.log.1）；App 重启后 Dev 面板显示历史落盘日志尾部，Agent HTTP GET /api/projects/:id/logs 支持读取落盘日志与返回真实文件路径；内存输出尾部上限维持 64 KiB 不变。
- 启动前若登记端口已被监听，则拒绝启动，并标出占用进程的名字和 PID（mac/linux 用 lsof，Windows 用 netstat/Get-NetTCPConnection；无法获取时退化为单句提示已被监听）
- 环境预设与工具链注入：每个项目支持选择/配置 env 预设（如 dev/test，含 Spring Boot application-*.yml/properties 扫描识别）；支持指定 JAVA_HOME / Node 版本与路径，启动进程前预检工具链可用性，找不到时提前给出单句明确原因并拒绝启动，命中时注入 JAVA_HOME 与 PATH 环境变量。
- Tomcat WAR 与 catalina 部署：识别到 Tomcat WAR（Maven packaging 为 war）的项目可配 CATALINA_HOME，按 catalina run 启停并部署 WAR 到 webapps；就绪判定沿用端口探活（默认 8080）；无 Tomcat 时启动前一句话提示。
- 首次启动自动检测并安装依赖：Node 项目缺 `node_modules` 时按锁文件（`pnpm-lock.yaml` → `pnpm`、`yarn.lock` → `yarn`、`package-lock.json` 或无锁文件 → `npm`）自动安装依赖；Maven/Gradle 项目首启可选先拉依赖（`./mvnw dependency:resolve` / `./gradlew dependencies`）；安装过程中状态为 `installing`（安装中），输出追加进日志尾部；安装失败状态标 `failed` 并给出退出码原因；支持可在设置中关掉自动安装（`auto_install = false`），关掉后缺失依赖直接拒绝启动并报「依赖未安装（缺 node_modules）」；支持手动点击「安装依赖」或通过 Agent HTTP `POST /api/projects/:id/install` 独立安装依赖。
- 对齐 tongyun-dev 的 Agent HTTP 契约与自动拉起：App 启动时在 127.0.0.1 自动拉起 Agent HTTP 服务（端口可配，默认 9100，环境变量 TONGYUN_STUDIO_AGENT_PORT，递增避让，不与 tongyun-dev 的 9099 冲突），提供项目清单与状态（GET /api/projects、GET /api/projects/:id）、启停与重启（POST /api/projects/:id/start、POST /api/projects/:id/stop、POST /api/projects/:id/restart）、依赖安装（POST /api/projects/:id/install）、日志尾部（GET /api/projects/:id/logs）以及同组启停（POST /api/groups/:key/start、POST /api/groups/:key/stop）。内置 DNS rebinding 与 CSRF 防护。
- 异常退出自动重启策略（可关）：托管进程非主动停止而退出时，按项目配置可选自动重启（默认关闭以免掩盖崩溃；可配置次数上限 max_restarts 与稳定窗口/间隔上限 restart_interval_secs）；用户主动停止不触发重启；每次重启在 stderr / 日志尾部清晰记录重启次数；达到重启上限后停止重启并标为 failed，记录失败原因。提供项目级开关更新指令（桌面 update_project_auto_restart、Agent HTTP POST /api/projects/:id/auto_restart）。

仍未接入：

- 独立 CLI、`~/.config/tongyun-dev/projects.toml` 和网页控制台 `:9099`（Studio 只在后台启动供外部 Agent 调用的 Agent HTTP 服务，不挂载独立 CLI、独立项目文件或 :9099 网页控制台）
- 跨产品的完整后端协议、共享数据库、Agent 调度
- PTY、自动应答、向进程写入输入
- 工作台重启后恢复跨进程托管（Studio 仅持久化日志供重启后回看，不恢复历史进程生命周期）

模块名称不表示已经接通独立应用。浏览器预览不能扫描、登记或启停本机进程。

## 集成限制

API、Database、Git、Agent 面板仍是 Studio 自己的本地能力，没有复用另外三个独立产品的完整后端协议，也没有统一数据库或跨机器记忆。界面入口不能当成已经接入的证据。

## Agent 整合增量与新会话入口

共享 TiDB / 工人 runner 的自注册与公共池抢单已存在，不能从 Studio 本地快照能力推断整个团队没有调度。task_deliveries 已核实建好，Studio 尚未接通对应提交、预览和审核服务。不得用原型或新表存在代替能力证据。

新会话读[接入与交付引导](agent-start.md)；实现计划见[工作流设计](design/agent-workflow/design.md)。HTML 默认按 tongyun-document 出稿，未入库阶段按引导保留原稿、记录真实可访问性和现有 runner 回写结果。

## 产品职责更正：开发现场与客户端唤醒

Studio 是开发者和 Agent 操作项目的工作台，主区域保持文件、代码、Git、运行、接口、数据和交付；当前任务与 Agent 执行只是项目上下文。全局注册、任务池治理和各客户端排程不作为本产品主线。各 Agent 使用自身宿主的定时任务机制，醒来后遵守共享协议；脚本 runner 是可选兼容入口。Studio 的项目服务运行管理与 Agent 客户端定时唤醒是两回事。
