# tongyun-studio · AI 开发规则

用途：以项目为中心的本地桌面工作台，连接 Dev / API / Database / Git。

## 当前范围
- Tauri 2 + React 19 + TypeScript + Vite；Rust 核心与桌面适配器分离。
- 当前：本地项目管理、内嵌 Files / Dev / API / SQLite / Git，以及只读 Agent 文件快照。Dev 面板已继承 tongyun-dev 的扫描登记、启停重启、生命周期、日志尾部、环境预设与 Java/Node 工具链注入（启动前预检未命中一句话报错）；App 启动时自动在 127.0.0.1 拉起 Agent HTTP 服务（默认端口 9100，对齐 tongyun-dev 契约），无需另跑 CLI；未接入独立 CLI、:9099 网页控制台和跨产品协议。当前边界以 docs/architecture.md 为准。
- 原有工具保持独立。Studio 没有伪造与 tongyun-dev 进程的联动，也未接入完整协议、共享数据库记忆或 worker 调度。
- Agent 开发与验收不连接生产数据库、不自动启动用户业务项目；临时夹具可测试命令、SQL 和 Git。仅在用户要求时提交或推送产品仓。
- 项目移除只移除登记，不删除磁盘文件。无隐式 git pull、commit 或 push。

## Agent 引导与交付

- 首次接入或恢复会话先读 [Agent 接入与交付引导](docs/agent-start.md)。共享任务仍使用现有 TiDB 与已核验 runner，不在工作台另写抢单逻辑。
- 默认按可用的 tongyun-document Skill 生成 HTML 交付报告，保留原始成果与真实验证证据。新交付表已存在，但 Studio 提交／预览／人工验收 API 尚未实现；未入库须明确报告，不调用原型里的设计接口。
- 自命名不等于注册成功；注册不等于排程安装；手动心跳不等于自动唤醒。初始化复用已有身份和单一排程入口，不停用其他客户端。

## 修改入口
- 界面先读 DESIGN.md；需求见 docs/prd.md；架构见 docs/architecture.md。
- 命令以 package.json、Cargo.toml 和 docs/development.md 为准。
- src/ 前端，crates/studio-core/ 本地项目与检查核心，src-tauri/ 桌面命令适配。
- 修改接口同步 src/contracts.ts 和对应 Rust 序列化结构。
- 完成验证 npm run check、cargo test -p studio-core、cargo check -p tongyun-studio；真实 UI 验证另记。

## 技能
项目由 tongyun-scaffold 初始化。默认 lite 技能源不可访问，项目级技能未安装。
按 [技能入口与安装现状](docs/skills.md) 查找并读取真实技能；工人流程用 tongyun-pipeline，可读交付用 tongyun-document，不把未安装写成可用。

## 边界
- 真实路径、私有项目清单与连接凭据不进示例和仓库；运行数据放应用配置目录。
- 凭据不存工作台项目记录。外部工具调用使用参数数组；运行面板用户明确输入的命令可使用 shell 语法并由进程管理器托管。
- 异步结果不得串到切换后的项目；失败显示真实错误，可重试。
- 仅在用户要求时提交、推送、部署、安装或替换已有应用。
