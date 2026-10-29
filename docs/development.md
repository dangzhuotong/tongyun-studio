# 开发与命令

状态：现行（Tauri 2 + React 19 + TypeScript + Vite + Rust core）

| 任务 | 命令 | 前提 | 成功条件 | 状态 |
| --- | --- | --- | --- | --- |
| 安装依赖 | `npm install` | Node.js 20.19+ 或 22.12+ | `node_modules/` 完整就位 | 已建立 |
| 前端类型检查 | `npm run typecheck` | 依赖已安装 | `tsc --noEmit` 零报错 | 已建立 |
| 前端测试 | `npm test` | 依赖已安装 | `vitest run` 全测用例通过 | 已建立 |
| 前端打包 | `npm run build` | 依赖已安装 | `dist/` 资源构建生成 | 已建立 |
| 前端全体验证 | `npm run check` | 依赖已安装 | 类型、单测、打包依次通过 | 已建立 |
| 核心库单元测试 | `cargo test -p studio-core` | Rust 工具链就位 | 单元与集成测试全部通过（数量以实际结果为准） | 已建立 |
| 桌面宿主语法检查 | `cargo check -p tongyun-studio` | Rust 工具链与 Tauri 就位 | 编译无报错 | 已建立 |
| 前端开发服务器 | 经 tongyun-dev 已登记入口启动 | 先按项目绝对路径核对登记、profile、端口和状态 | 受管启动返回就绪后再预览 | 使用统一管理入口 |
| 桌面开发模式 | 经核验的受管桌面开发入口 | 先核对登记配置；未登记则只读扫描预览 | 真实窗口启动与就绪核验 | 不直接执行框架启动命令 |

环境提示：在 macOS 上构建 Rust 模块时，若默认 SDK 链存在多个版本，可指定 `SDKROOT` 指向当前兼容 SDK（例如 `MacOSX15.4.sdk`）。

## 运行与浏览器入口

项目启停必须通过 tongyun-dev 或已确认具备运行管理接口的 Studio；先 list --json，按绝对路径确认登记，再 status <id> --json。已有合适服务就复用，确需启动用 start <id> --timeout 60 --json，核对 ok、退出码和就绪状态。未知占用者不自行终止或换端口。

package.json 的 dev 与 tauri dev 是管理工具登记时的底层配方，不是 Agent 可直接执行的启动入口。一次性类型检查、构建与不启动常驻项目服务的测试可以直接运行。浏览器操作统一用 ego-browser，先读取本机 Skill 与 ego-browser skill 完整指南；禁止自动打开默认浏览器绕过。

## Agent 交付与验证

接入、恢复、交付与当前接口边界见 [agent-start.md](agent-start.md)。纯文档改动核对链接和实际能力说明；代码改动按上表执行相关检查。设计原型的交互通过不等于真实数据库或调度链路验收。
