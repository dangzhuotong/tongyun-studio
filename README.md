# 橦云工作台 (Tongyun Studio)

> 一个项目，一处工作空间。本地集成的开发者工作台。

橦云工作台（Tongyun Studio）是橦云开发者套件的中心工作台，遵循与 `tongyun-git` 一致的原生桌面应用设计理念：**直接内嵌运行、接口、数据、版本与文件工作流，无需依赖外部独立应用跳转**。

---

## 核心设计与内嵌工作台

设计约定见 [DESIGN.md](DESIGN.md)：当前以桌面深色、暖色文字和芽绿主操作为基调。实际令牌及界面以源码为准。

```
Tongyun Studio
  ├── 文件 (Files)    - 浏览项目目录树，原生代码/配置预览与快捷跳转
  ├── 运行 (Dev)      - 原生执行项目脚本与 shell 命令，内嵌实时终端控制台
  ├── 接口 (API)      - 原生 HTTP/REST 客户端，支持 .http 接口用例与 JSON 语法解析
  ├── 数据 (Database) - 原生 SQLite 引擎，SQL 编辑器，表格化呈现查询结果与模式
  └── 版本 (Git)      - 原生 Git 工作流，代码差异（Diff）高亮，内嵌提交与分支管理
```

---

## 模块能力

### 1. 运行 · Tongyun Dev
- 自动识别项目根目录技术栈与 package 脚本（`npm`, `cargo` 等）
- 一键执行快捷脚本与自定义 shell 命令，按项目托管 Unix 进程组
- 停止、重启核验实际进程；切换页签保留记录，正常退出清理进程组；不支持主动脱离进程组的命令
- 原生内嵌输出面板：支持标准输出/标准错误、退出码与日志复制；内存尾部每流保留最后 64 KiB
- 日志落盘与重启可查：托管进程输出按项目写入本机日志目录（默认 `~/.tongyun-studio/logs`，可用 `TONGYUN_STUDIO_LOG_DIR` 改路径），单文件 1 MiB 上限并滚动备份 `.log.1`；App 重启后 Dev 面板仍回看历史尾部
- 首次启动自动装依赖：Node 项目缺 `node_modules` 时按锁文件选择 `pnpm` / `yarn` / `npm`，Maven/Gradle 可选先拉依赖；安装中显示 `installing`，失败标 `failed` 并给退出码原因，可在设置中关闭改为拒绝启动
- 启动前预检：登记端口已被监听则拒绝启动并标出占用进程名与 PID；`JAVA_HOME`、Node 路径与 `CATALINA_HOME` 未命中时一句话报错，命中后注入 `JAVA_HOME` 与 `PATH`
- 环境预设与依赖顺序：按项目选择 env 预设（含 Spring Boot `application-*.yml/properties` 识别）；`depends_on` 支持拓扑启动、就绪等待、环路拦截与依赖失败跳过，批量停止按依赖逆序
- Tomcat WAR 部署：Maven packaging 为 war 的项目可配 `CATALINA_HOME`，按 `catalina run` 启停并把 WAR 部署到 `webapps`，端口探活判就绪
- 异常退出自动重启：项目级开关（默认关闭以免掩盖崩溃），可配重启次数上限与间隔上限；主动停止不触发重启，每次重启记录在日志，超限后标 `failed`
- 失败任务支持一键复制报错摘要到剪贴板

### 2. 接口 · Tongyun API
- 自动发现项目内的 `.http` / `.rest` 接口测试用例文件，支持载入与预览
- 原生 HTTP 客户端：支持 `GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `HEAD`
- 请求头、请求体可视化编辑（支持 JSON 美化）
- 实时响应分析：状态码徽标、网络时延、格式化 JSON 预览与响应头详情

### 3. 数据 · Tongyun Database
- 自动发现项目内的 SQLite 数据库文件（`.db`, `.sqlite`）及模式产物（`.sql`, Prisma/Drizzle 等）
- 只读 SQLite 查询；写入、DDL、ATTACH 和多语句均拒绝
- 数据表网格呈现：表头、字段值、空值处理、耗时与行数统计
- 预设快捷查询：列出所有表、查看表结构

### 4. 版本 · Tongyun Git
- 实时检测工作区文件变更（`M` 修改、`A` 新增、`D` 删除、`??` 未追踪）
- 原生 Unified Diff 查看器：行级别语法高亮（绿色添加、红色删除）
- 内嵌提交输入框：支持 `⌘ + Enter` 快捷提交
- 分支实时下拉切换与近期提交记录时间线
- 提交历史（Log Tree）视图：拓扑图与提交列表、分支/标签徽章、分页加载 100+ 提交，点击提交查看作者信息、改动文件与该提交的 Diff，可一键复制 Commit SHA
- 仅提交已暂存内容，保留工作区未暂存改动和部分暂存选择

### 5. 文件 · Tongyun Files
- 层次化目录树导航与上级返回
- 快速预览配置文件与源代码
- 文件大小、路径与系统外部编辑器快捷打开

---

## 本地开发与构建

### 前置要求
- Node.js 20.19+ 或 22.12+（本次体检在 Node 24.9 / npm 11.6 下跑通）
- Rust 2021 (Cargo)，桌面端另需系统 WebView 运行时（Windows WebView2 / macOS WKWebView）与 C++ 链接工具链
- 仓库未配置 lint 脚本，也没有 `.github/workflows`：验收以本地检查为准（见下表）

### 干净环境从零跑通
```bash
# 1. 安装依赖（首次或换机；README 命令与 package-lock 一致）
npm install          # 或 npm ci

# 2. 前端全体验证：类型检查 + 单测 + 打包
npm run check

# 3. Rust 核心与桌面宿主
cargo test -p studio-core
cargo check -p tongyun-studio

# 4. 起应用
npm run dev              # 仅前端预览：http://127.0.0.1:1438
npm run tauri dev        # 真实桌面窗口，先编译 src-tauri 宿主
npm run tauri build      # 生产安装包
```

`npm run tauri dev` 启动后，App 会在 `127.0.0.1` 自动拉起 Agent HTTP 服务（默认 9100），无需另跑 CLI；托管项目的运行日志落在 `~/.tongyun-studio/logs`。

## Agent 与集成边界

Agent 面板可读取项目里的 `.tongyun/agent-session.json`（备用 `.agent/session.json`），展示经格式校验的文件快照。不会生成示例执行、心跳或模型用量，也不宣称文件记录代表工人在线。没有消息消费与回执协议时，投递和暂停按钮保持不可用。

### Agent HTTP 服务（App 启动即拉起，无需另跑 CLI）
- 监听 `127.0.0.1`，默认端口 9100（`TONGYUN_STUDIO_AGENT_PORT` 可配，被占用时递增避让，不与 tongyun-dev 的 9099 冲突），契约对齐 tongyun-dev
- 项目与状态：`GET /api/projects`、`GET /api/projects/:id`
- 生命周期：`POST /api/projects/:id/start`、`/stop`、`/restart`；同组启停 `POST /api/groups/:key/start`、`/stop`
- 依赖与日志：`POST /api/projects/:id/install`；`GET /api/projects/:id/logs` 返回落盘日志尾部与真实文件路径
- 重启策略：`POST /api/projects/:id/auto_restart`
- 内置 DNS rebinding 与 CSRF 防护；只服务本机，不承诺跨机器 worker 调度

当前尚未接入共享数据库记忆、跨机器 worker 调度和四个独立工具的完整后端协议。开发命令、Git 和数据库测试使用隔离夹具；最新证据见 [验收记录](docs/testing/acceptance-tests.md)。

## Agent 从这里开始

先读 [AGENTS.md](AGENTS.md) 与 [接入和交付引导](docs/agent-start.md)，再按 [技能入口](docs/skills.md) 读取实际 Skill。默认 HTML 报告使用 tongyun-document。

TiDB 注册、抢单和现有 runner 已有基础；新 HTML 交付表已核实存在。Studio 的数据库交付与人工验收界面仍是[整合设计](docs/design/agent-workflow/report.html)，尚未接通真实接口。项目服务启动统一走受管入口，见 [开发说明](docs/development.md)。

## 开发工作台与 Agent 客户端的分工

工作台围绕当前项目提供文件、代码、Git、运行、接口、数据与交付阅读，供人和 Agent 共同开发。注册与接单遵循已有共享协议；各 Agent 按自身客户端支持的方式创建定时任务，工作台不统一守护、唤醒或调度这些客户端。原生定时唤醒可能在查队列前已调用模型，不承诺所有方式都能做到无单零模型消耗。
