# tongyun-studio · AI 开发规则

用途：以项目为中心的本地桌面工作台，连接 Dev / API / Database / Git。

## 当前范围
- Tauri 2 + React 19 + TypeScript + Vite；Rust 核心与桌面适配器分离。
- 首版：本地项目登记与持久化、切换项目、真实只读 Git 摘要、四工具入口。
- 原有工具保持独立。尚无项目上下文交接协议时，明确提示用户在原工具选择项目，不伪造联动。
- 不连接生产数据库、不自动启动用户项目、不提交或推送产品仓代码。
- 项目移除只移除登记，不删除磁盘文件。无隐式 git pull、commit 或 push。

## 修改入口
- 界面先读 DESIGN.md；需求见 docs/prd.md；架构见 docs/architecture.md。
- 命令以 package.json、Cargo.toml 和 docs/development.md 为准。
- src/ 前端，crates/studio-core/ 本地项目与检查核心，src-tauri/ 桌面命令适配。
- 修改接口同步 src/contracts.ts 和对应 Rust 序列化结构。
- 完成验证 npm run check、cargo test -p studio-core、cargo check -p tongyun-studio；真实 UI 验证另记。

## 技能
项目由 tongyun-scaffold 初始化。默认 lite 技能源不可访问，项目级技能未安装。
宿主可用时使用 tongyun-product（含 project 工种）、tongyun-ui-design、tongyun-test、tongyun-code-review；读取实际技能再执行，不把未安装写成可用。

## 边界
- 真实路径、私有项目清单与连接凭据不进示例和仓库；运行数据放应用配置目录。
- 凭据不存工作台项目记录。所有外部命令使用参数数组，不拼 shell。
- 异步结果不得串到切换后的项目；失败显示真实错误，可重试。
- 仅在用户要求时提交、推送、部署、安装或替换已有应用。
