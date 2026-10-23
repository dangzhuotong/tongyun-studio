# 架构设计

状态：现行（Tauri 2 + studio-core + React 19）

## 原则

1. **分层清晰与宿主解耦**：Rust 核心领域逻辑（`studio-core`）独立于 Tauri 桌面桥接层（`src-tauri`），纯 Rust 单元测试脱离 UI 独立快速执行。
2. **读写安全与边界受控**：工作台仅做只读探测（Git 状态、文件统计）与应用登记持久化，绝不隐式修改用户项目代码，绝不跨越项目边界执行 shell 字符串拼接（一律参数数组）。
3. **前端强类型契约**：前端 `src/contracts.ts` 与 Rust 数据结构（`Workspace`, `Project`, `GitSummary`, `ToolStatus` 等）通过 camelCase JSON 契约精确对齐。

## 系统架构

```
┌────────────────────────────────────────────────────────┐
│                   React 19 + TypeScript (src/)         │
│  - App.tsx (主界面布局、项目导航、概览状态网格)           │
│  - bridge.ts (Tauri 2 invoke 适配器与降级)             │
│  - features/ (Dev / Api / Database / Git 工具面板)      │
│  - styles/app.css (DESIGN.md 严格对齐令牌体系)          │
└───────────────────────────┬────────────────────────────┘
                            │ IPC (Tauri Commands)
┌───────────────────────────▼────────────────────────────┐
│                  src-tauri (桌面命令适配层)              │
│  - tauri.conf.json (窗口尺寸、权限控制与能力配置)         │
│  - lib.rs (Tauri invoke handler 与异步原生文件选择)      │
└───────────────────────────┬────────────────────────────┘
                            │ 直接引用
┌───────────────────────────▼────────────────────────────┐
│                crates/studio-core (核心领域库)          │
│  - WorkspaceStore (原子写入、版本隔离与持久化)          │
│  - inspect_project (只读 git 探测、.http 文件扫描)      │
│  - list_tools / launch_tool (本地工具探测与系统拉起)    │
└────────────────────────────────────────────────────────┘
```

## 当前上下文一览

| 上下文 | 目录 | 职责 | 对外接口 |
| --- | --- | --- | --- |
| 工作区持久化 | `crates/studio-core` | 本地项目记录管理、原子存取、版本隔离 | `WorkspaceStore::{load, add, select, remove, project}` |
| 项目只读探测 | `crates/studio-core` | Git 分支/HEAD/改动文件、.http 文件统计 | `inspect_project(&Project)` |
| 工具集成探测 | `crates/studio-core` | Dev / API / Database / Git 检测与调用 open 拉起 | `list_tools()`, `launch_tool(ToolId)`, `open_project_directory(&Project)` |
| 桌面通信桥接 | `src-tauri` | 暴露 Tauri 2 命令、目录异步对话框 | `tauri::command` handlers |
| 交互视图层 | `src/` | 桌面与浏览器预览、工作区视图渲染、键盘无障碍支持 | React 组件与 `bridge.ts` |
