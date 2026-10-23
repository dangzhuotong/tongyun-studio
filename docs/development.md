# 开发与命令

状态：现行（Tauri 2 + React 19 + TypeScript + Vite + Rust core）

| 任务 | 命令 | 前提 | 成功条件 | 状态 |
| --- | --- | --- | --- | --- |
| 安装依赖 | `npm install` | Node.js >= 18 | `node_modules/` 完整就位 | 已建立 |
| 前端类型检查 | `npm run typecheck` | 依赖已安装 | `tsc --noEmit` 零报错 | 已建立 |
| 前端测试 | `npm test` | 依赖已安装 | `vitest run` 全测用例通过 | 已建立 |
| 前端打包 | `npm run build` | 依赖已安装 | `dist/` 资源构建生成 | 已建立 |
| 前端全体验证 | `npm run check` | 依赖已安装 | 类型、单测、打包依次通过 | 已建立 |
| 核心库单元测试 | `cargo test -p studio-core` | Rust 工具链就位 | 5 个单测全部 PASS | 已建立 |
| 桌面宿主语法检查 | `cargo check -p tongyun-studio` | Rust 工具链与 Tauri 就位 | 编译无报错 | 已建立 |
| 前端开发服务器 | `npm run dev` | 端口 1438 未占用 | 启动 127.0.0.1:1438 预览 | 已建立 |
| 桌面开发模式 | `npm run tauri dev` | 前端依赖与 Rust 工具链就位 | 桌面窗口正常启动 | 已建立 |

环境提示：在 macOS 上构建 Rust 模块时，若默认 SDK 链存在多个版本，可指定 `SDKROOT` 指向当前兼容 SDK（例如 `MacOSX15.4.sdk`）。
