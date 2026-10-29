# 架构与当前边界

React 19 / TypeScript 按项目切换 Files、Dev、API、Database、Git、Agent 面板。`src/bridge.ts` 调用 Tauri 命令，`src-tauri` 负责桌面适配，`crates/studio-core` 实现本地操作。浏览器仅预览空工作区，本机操作返回桌面版要求，不生成模拟成功数据。

## 当前实现

- `WorkspaceStore` 在应用配置目录保存项目登记，不复制项目代码；移除只删除登记。
- `ServiceManager` 按项目和服务 ID 托管 Unix 进程组，支持真实状态、停止、重启、有界输出和日志尾部。切换面板不会清空后台记录；正常退出同时覆盖 `ExitRequested` 和 macOS 原生 `Exit`；在可取消的退出请求中，清理失败会阻止退出并提示。它不负责跨应用重启恢复。主动脱离进程组的命令不受托管，应以前台模式启动。
- Dev 运行配置存在项目登记的可选 `dev` 字段里（启动命令、端口、健康检查、类型、分组）。目录扫描只读识别 Spring Boot（Maven/Gradle）、Tomcat WAR、Vite / Vue CLI / Next / Nuxt / CRA / Node、Django / FastAPI / Flask；已有运行配置的路径不覆盖，没有运行配置的已登记路径只补这个字段。移除仍然只删登记。
- 生命周期与 tongyun-dev 的就绪表对齐：`stopped` / `starting` / `port_open` / `ready` / `failed`。配了端口时，端口可连接且健康检查成功（或未配置检查）才是 `ready`；端口通但检查未成功是 `port_open`；进程还在、端口未通是 `starting`。进程组一旦退出就是 `failed`，不再保留 tongyun-dev 那种约 3 秒的「启动中」宽限，避免界面同时出现失败和启动中。进程已退出且端口仍开着不算本服务就绪。未配端口的一次性命令成功结束为 `exited`，运行中只记 `starting`，不会把进程存活标成就绪。`reachable` 只在 `ready` 或 `port_open` 时为真，对应 tongyun-dev 状态里的 `running`。同一分组支持基于 depends_on 依赖拓扑顺序批量启动，等待前一个到 ready（或超时/失败）后再启动下一个；检测到环路时拒绝启动并给出单句原因；依赖项失败时下游项目跳过启动并标明被谁挡住；同组批量停止按拓扑逆序停止。
- Git 使用本机 Git。普通提交和 amend 均保持已有 index，只提交用户已暂存内容；状态解析采用 NUL 分隔，保留状态列和原始文件名。
- SQLite 使用 `rusqlite`，只读打开现有项目内数据库；`query_only`、authorizer 和单语句解析共同限制读查询。限额为 1000 行、4 MiB 总结果、1 MiB 单值、64 KiB SQL、2 秒执行。SQL 写入和 DDL 尚未接入变更审批，不开放。
- HTTP 与文件浏览使用本地核心接口。用户显式输入的开发命令允许 shell 语法；其他外部程序采用参数数组。
- 项目文件写入通过目录描述符逐层访问，拒绝路径跳转、符号链接和硬链接目标；不在项目外提前创建目录。仅 Unix 实现。
- Agent 面板读取 `.tongyun/agent-session.json`，其次读取 `.agent/session.json`，校验字段和项目绑定。它是本地快照展示，没有接入 worker 注册表、数据库记忆、消息确认或调度控制。未知模型/心跳/用量显示未知；源文件缺失或无效时清空状态。投递、暂停保持不可用；可导出明确标注来源的本地快照。

## 与 tongyun-dev 的边界

Dev 面板继承的是运行契约，不是把 tongyun-dev 仓库嵌进来，也不连接它的进程。

已继承：

- 扫描目录、预览候选、登记到工作台（或给尚无运行配置的已有登记补上命令和端口）
- 启停、重启、同组批量启停（支持 depends_on 依赖拓扑排序、就绪等待、环路拦截与依赖失败跳过，批量停止按依赖逆序）
- 生命周期 `stopped` / `starting` / `port_open` / `ready` / `failed`，以及一次性成功的 `exited`
- 日志尾部（内存中的末尾行；每个输出流另有 64 KiB 上限）
- 启动前若登记端口已被监听，则拒绝启动，并标出占用进程的名字和 PID（mac/linux 用 lsof，Windows 用 netstat/Get-NetTCPConnection；无法获取时退化为单句提示已被监听）
- 环境预设与工具链注入：每个项目支持选择/配置 env 预设（如 dev/test，含 Spring Boot application-*.yml/properties 扫描识别）；支持指定 JAVA_HOME / Node 版本与路径，启动进程前预检工具链可用性，找不到时提前给出单句明确原因并拒绝启动，命中时注入 JAVA_HOME 与 PATH 环境变量。
- 对齐 tongyun-dev 的 Agent HTTP 契约与自动拉起：App 启动时在 127.0.0.1 自动拉起 Agent HTTP 服务（端口可配，默认 9100，环境变量 TONGYUN_STUDIO_AGENT_PORT，递增避让，不与 tongyun-dev 的 9099 冲突），提供项目清单与状态（GET /api/projects、GET /api/projects/:id）、启停与重启（POST /api/projects/:id/start、POST /api/projects/:id/stop、POST /api/projects/:id/restart）、日志尾部（GET /api/projects/:id/logs）以及同组启停（POST /api/groups/:key/start、POST /api/groups/:key/stop）。内置 DNS rebinding 与 CSRF 防护。

仍未接入：

- 独立 CLI、`~/.config/tongyun-dev/projects.toml` 和网页控制台 `:9099`（Studio 只在后台启动供外部 Agent 调用的 Agent HTTP 服务，不挂载独立 CLI、独立项目文件或 :9099 网页控制台）
- 跨产品的完整后端协议、共享数据库、Agent 调度
- 自动安装依赖（没有 `installing`）
- PTY、自动应答、向进程写入输入
- Tomcat `catalina` 部署；WAR 只登记并提示需要自己写启动命令
- 日志与 PID 落在 `~/.tongyun-dev/logs`，以及工作台重启后恢复进程

模块名称不表示已经接通独立应用。浏览器预览不能扫描、登记或启停本机进程。

## 集成限制

API、Database、Git、Agent 面板仍是 Studio 自己的本地能力，没有复用另外三个独立产品的完整后端协议，也没有统一数据库或跨机器记忆。界面入口不能当成已经接入的证据。
