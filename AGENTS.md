# tongyun-studio · AI 开发规则

用途：给开发者和 Agent 共同使用的项目开发工作台，连接 Files / Dev / API / Database / Git。主线是打开项目 → 理解任务 → 开发调试 → 查看改动 → 验证 → 查看交付，不建设工人调度总控台。

## 当前范围
- Tauri 2 + React 19 + TypeScript + Vite；Rust 核心与桌面适配器分离。
- 当前：本地项目管理、内嵌 Files / Dev / API / SQLite / Git，以及只读 Agent 文件快照。Dev 面板已继承 tongyun-dev 的扫描登记、从 tongyun-dev 全局登记文件（projects.toml，按 $TONGYUN_DEV_CONFIG → 记忆路径 → 默认用户配置 → 仓库内 config/projects.toml 顺序查找）读取候选并勾选登记（坏行与指向不存在目录的条目只跳过并注明原因，单批上限 64 个，不自动批量导入）、启停重启、生命周期（含 installing）、日志尾部与本地落盘（单文件 1 MiB 滚动，App 重启后保留 Dev 面板与 HTTP 日志回看，内存 64 KiB 上限不变）、环境预设、Java/Node 工具链注入与 Tomcat WAR catalina 部署启停（启动前预检未命中一句话报错），支持首启自动检测并安装依赖（Node 项目按锁文件安装、Maven/Gradle 可选先拉依赖，输出进日志尾部，失败标 failed，可在设置关闭）；App 启动时自动在 127.0.0.1 拉起 Agent HTTP 服务（默认端口 9100，对齐 tongyun-dev 契约），无需另跑 CLI；支持项目级异常退出可选自动重启策略（默认关闭，主动停止不重启，标明次数上限与日志）；未接入独立 CLI、:9099 网页控制台和跨产品协议。当前边界以 docs/architecture.md 为准。
- 原有工具保持独立。Studio 没有伪造与 tongyun-dev 进程的联动，也未接入完整协议、共享数据库记忆或 worker 调度。
- Agent 开发与验收不连接生产数据库、不自动启动用户业务项目；临时夹具可测试命令、SQL 和 Git。仅在用户要求时提交或推送产品仓。
- 项目移除只移除登记，不删除磁盘文件。无隐式 git pull、commit 或 push。

## Agent 引导与交付

- 首次接入或恢复会话先读 [Agent 接入与交付引导](docs/agent-start.md)。共享任务继续使用 TiDB 与现有接单协议。Agent 通过自己的客户端原生定时任务／自动化方式唤醒自己；已有脚本 runner 仅为兼容方式，不作为所有客户端的强制入口。工作台不统一安装排程或另写抢单逻辑。
- Agent 定时周期先安全同步引导仓与归属产品仓、按规则内容变化补读，再接单开发；目标仓同步失败先报告阻塞，保留未提交改动。应用不隐式更新代码；已有客户端定时任务需单独迁移核验，详见 docs/agent-start.md。
- 空闲只读取任务／通知摘要，有单再加载本单规格与相关文件；续租用轻量命令，不另开模型对话。中途保存最小恢复索引，完成时生成一次简洁 HTML；不为每次唤醒重复写报告。具体遵守 tongyun-work 的 docs/token-budget.md。
- 默认按可用的 tongyun-document Skill 生成 HTML 交付报告，保留原始成果与真实验证证据。新交付表已存在，但 Studio 提交／预览／人工验收 API 尚未实现；未入库须明确报告，不调用原型里的设计接口。
- 自命名不等于注册成功；注册不等于排程安装；手动心跳不等于自动唤醒。初始化复用本客户端已有身份和有效唤醒配置，不停用其他客户端；不支持定时能力时说明限制。

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
