# 橦云工作台 (Tongyun Studio)

> 一个项目，一处工作空间。本地集成的开发者工作台。

橦云工作台（Tongyun Studio）是橦云开发者套件的中心工作台，遵循与 `tongyun-git` 一致的原生桌面应用设计理念：**直接内嵌运行、接口、数据、版本与文件工作流，无需依赖外部独立应用跳转**。

---

## 核心设计与内嵌工作台

遵循橦云设计令牌规范（`src/styles/tongyun-tokens.css`）：暖奶茶背景（`#f6f1e9`）、抹茶绿主色（`#4d7c5d`）、蜜桃红强调（`#c2593f`），并原生支持深色主题。

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
- 原生内嵌输出面板：支持标准输出/标准错误、退出码与日志复制；每流保留最后 64 KiB

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
- 仅提交已暂存内容，保留工作区未暂存改动和部分暂存选择

### 5. 文件 · Tongyun Files
- 层次化目录树导航与上级返回
- 快速预览配置文件与源代码
- 文件大小、路径与系统外部编辑器快捷打开

---

## 本地开发与构建

### 前置要求
- Node.js 20.19+ 或 22.12+
- Rust 2021 (Cargo)

### 常用命令
```bash
# 安装依赖
npm install

# 运行前端测试与类型检查
npm run check

# 启动网页端开发服务器 (仅界面预览，本机操作需桌面版)
npm run dev

# 运行 Rust 核心单元测试
cargo test -p studio-core

# 检查桌面端宿主
cargo check -p tongyun-studio

# 构建生产桌面版应用
npm run tauri build
```

## Agent 与集成边界

Agent 面板可读取项目里的 `.tongyun/agent-session.json`（备用 `.agent/session.json`），展示经格式校验的文件快照。不会生成示例执行、心跳或模型用量，也不宣称文件记录代表工人在线。没有消息消费与回执协议时，投递和暂停按钮保持不可用。

当前尚未接入共享数据库记忆、跨机器 worker 调度和四个独立工具的完整后端协议。开发命令、Git 和数据库测试使用隔离夹具；最新证据见 [验收记录](docs/testing/acceptance-tests.md)。
