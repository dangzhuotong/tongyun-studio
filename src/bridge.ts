import { invoke, isTauri } from '@tauri-apps/api/core';
import type {
  Workspace,
  ProjectInspection,
  ToolStatus,
  ToolId,
  LaunchResult,
  FileEntry,
  GitFileChange,
  ExecutionResult,
  HttpResponse,
  SqlQueryResult,
  DbTableInfo,
  DbColumnInfo,
  PaginatedData,
  ListeningPort,
  AiProjectContext,
} from './contracts';

export const isDesktop = isTauri();

function native<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktop) return Promise.reject(new Error('本机操作需要在橦云工作台桌面版中使用。'));
  return invoke<T>(command, args);
}

export function loadWorkspace(): Promise<Workspace> {
  return isDesktop
    ? native('load_workspace')
    : Promise.resolve({ version: 1, projects: [], activeProjectId: null });
}

export const addProject = (path: string) => native<Workspace>('add_project', { path });
export const selectProject = (id: string) => native<Workspace>('select_project', { id });
export const removeProject = (id: string) => native<Workspace>('remove_project', { id });
export const inspectProject = (id: string) =>
  isDesktop
    ? native<ProjectInspection>('inspect_project', { id })
    : Promise.resolve({
        exists: true,
        git: {
          isRepository: true,
          branch: 'main',
          head: '89bac36',
          changedFiles: 0,
          recentCommits: [
            {
              hash: '89bac36',
              author: 'Tongyun Worker',
              relativeTime: '刚刚',
              message: 'feat: 橦云工作台内嵌全套开发工作流',
            },
          ],
          error: null,
        },
        httpFiles: 1,
        httpFilePaths: ['test.http'],
        techStack: ['Tauri 2', 'React 19', 'Rust', 'TypeScript'],
        scripts: [
          { name: 'dev', command: 'npm run dev' },
          { name: 'test', command: 'npm test' },
          { name: 'build', command: 'npm run build' },
        ],
        dbArtifacts: [{ name: 'schema.sql', path: 'schema.sql', kind: 'schema' }],
      });

export const readProjectTree = (id: string, relativeDir?: string) =>
  isDesktop
    ? native<FileEntry[]>('read_project_tree', { id, relativeDir: relativeDir ?? null })
    : Promise.resolve([
        { name: 'src', path: 'src', isDir: true, sizeBytes: 0, modified: '刚刚' },
        { name: 'package.json', path: 'package.json', isDir: false, sizeBytes: 850, modified: '刚刚' },
        { name: 'README.md', path: 'README.md', isDir: false, sizeBytes: 1240, modified: '刚刚' },
      ]);

export const readProjectFileContent = (id: string, relativePath: string) =>
  isDesktop
    ? native<string>('read_project_file_content', { id, relativePath })
    : Promise.resolve('// 浏览器预览模式下仅展示占位内容\nconsole.log("Tongyun Studio");');

export const getGitChangedFiles = (id: string) =>
  isDesktop
    ? native<GitFileChange[]>('get_git_changed_files', { id })
    : Promise.resolve([
        { path: 'src/features/DevPanel.tsx', status: 'M', staged: false },
        { path: 'src/features/ApiPanel.tsx', status: 'M', staged: true },
      ]);

export const getGitDiff = (id: string, filePath?: string) =>
  isDesktop
    ? native<string>('get_git_diff', { id, filePath: filePath ?? null })
    : Promise.resolve(
        '--- a/src/features/DevPanel.tsx\n+++ b/src/features/DevPanel.tsx\n@@ -1,5 +1,5 @@\n-// old launcher\n+// in-app native workbench\n',
      );

export const createGitCommit = (id: string, message: string) =>
  isDesktop
    ? native<string>('create_git_commit', { id, message })
    : Promise.resolve('[main 1a2b3c4] ' + message);

export const gitCommitAmend = (id: string, message?: string) =>
  isDesktop
    ? native<string>('git_commit_amend', { id, message: message ?? null })
    : Promise.resolve('[main 1a2b3c4] amend');

export const gitStageFile = (id: string, path: string) =>
  isDesktop ? native<string>('git_stage_file', { id, path }) : Promise.resolve('已暂存');

export const gitUnstageFile = (id: string, path: string) =>
  isDesktop ? native<string>('git_unstage_file', { id, path }) : Promise.resolve('已取消暂存');

export const gitStageAll = (id: string) =>
  isDesktop ? native<string>('git_stage_all', { id }) : Promise.resolve('已全部暂存');

export const gitUnstageAll = (id: string) =>
  isDesktop ? native<string>('git_unstage_all', { id }) : Promise.resolve('已取消全部暂存');

export const gitDiscardFile = (id: string, path: string) =>
  isDesktop ? native<string>('git_discard_file', { id, path }) : Promise.resolve('已丢弃修改');

export const gitCreateBranch = (id: string, branchName: string) =>
  isDesktop
    ? native<string>('git_create_branch', { id, branchName })
    : Promise.resolve(`已新建并切换到分支 '${branchName}'`);

export const gitRemoteSync = (id: string, action: 'fetch' | 'pull' | 'push') =>
  isDesktop
    ? native<string>('git_remote_sync', { id, action })
    : Promise.resolve(`${action} 同步成功`);

export const getGitBranches = (id: string) =>
  isDesktop
    ? native<string[]>('get_git_branches', { id })
    : Promise.resolve(['main', 'develop', 'feature/ai-workbench']);

export const switchGitBranch = (id: string, branch: string) =>
  isDesktop
    ? native<string>('switch_git_branch', { id, branch })
    : Promise.resolve(`Switched to branch '${branch}'`);

export const executeProjectScript = (id: string, command: string) =>
  isDesktop
    ? native<ExecutionResult>('execute_project_script', { id, command })
    : Promise.resolve({
        exitCode: 0,
        stdout: `> ${command}\n执行成功 (浏览器演示环境)\nAll checks passed.`,
        stderr: '',
        durationMs: 42,
      });

export const sendHttpRequest = (
  method: string,
  url: string,
  headers: [string, string][],
  body?: string,
): Promise<HttpResponse> =>
  isDesktop
    ? native<HttpResponse>('send_http_request', {
        method,
        url,
        headers,
        body: body ?? null,
      })
    : Promise.resolve<HttpResponse>({
        status: 200,
        statusText: 'OK',
        headers: [
          ['content-type', 'application/json; charset=utf-8'],
          ['server', 'mock/tongyun-studio'],
        ],
        body: JSON.stringify({ message: 'Tongyun Studio API 请求成功', url, method }, null, 2),
        latencyMs: 38,
      });

export const executeSqlQuery = (id: string, dbPath: string, sql: string) =>
  isDesktop
    ? native<SqlQueryResult>('execute_sql_query', { id, dbPath, sql })
    : Promise.resolve({
        columns: ['id', 'title', 'status', 'created_at'],
        rows: [
          [1, '初版工作台搭建', 'completed', '2026-10-22 10:00:00'],
          [2, '内嵌开发与终端执行', 'in_progress', '2026-10-23 12:00:00'],
          [3, 'SQLite 与接口工作台', 'pending', '2026-10-23 13:00:00'],
        ],
        rowCount: 3,
        durationMs: 14,
        error: null,
      });

export const getDbTables = (id: string, dbPath: string) =>
  isDesktop
    ? native<DbTableInfo[]>('get_db_tables', { id, dbPath })
    : Promise.resolve([
        { name: 'users', kind: 'table' },
        { name: 'projects', kind: 'table' },
        { name: 'tasks', kind: 'table' },
        { name: 'audit_logs', kind: 'view' },
      ]);

export const getTableColumns = (id: string, dbPath: string, tableName: string) =>
  isDesktop
    ? native<DbColumnInfo[]>('get_table_columns', { id, dbPath, tableName })
    : Promise.resolve([
        { cid: 0, name: 'id', dataType: 'INTEGER', notNull: true, dfltValue: null, pk: true },
        { cid: 1, name: 'name', dataType: 'TEXT', notNull: true, dfltValue: null, pk: false },
        { cid: 2, name: 'email', dataType: 'TEXT', notNull: false, dfltValue: null, pk: false },
        { cid: 3, name: 'created_at', dataType: 'DATETIME', notNull: true, dfltValue: 'CURRENT_TIMESTAMP', pk: false },
      ]);

export const getTableData = (
  id: string,
  dbPath: string,
  tableName: string,
  page: number,
  pageSize: number,
) =>
  isDesktop
    ? native<PaginatedData>('get_table_data', { id, dbPath, tableName, page, pageSize })
    : Promise.resolve({
        columns: ['id', 'name', 'email', 'created_at'],
        rows: [
          ['1', 'Alice', 'alice@tongyun.work', '2026-10-20 10:00:00'],
          ['2', 'Bob', 'bob@tongyun.work', '2026-10-21 11:30:00'],
          ['3', 'Charlie', 'charlie@tongyun.work', '2026-10-22 14:15:00'],
        ],
        totalRows: 3,
        page: 1,
        pageSize: 50,
      });

export const detectListeningPorts = () =>
  isDesktop
    ? native<ListeningPort[]>('detect_listening_ports')
    : Promise.resolve([
        { port: 5173, process: 'vite' },
        { port: 3000, process: 'node' },
      ]);

export const generateAiProjectContext = (id: string) =>
  isDesktop
    ? native<AiProjectContext>('generate_ai_project_context', { id })
    : Promise.resolve({
        projectName: '演示项目',
        projectPath: '/Users/d/code/demo',
        markdown: '# AI 上下文报告\n- 技术栈: Tauri 2, React 19, Rust\n- 分支: main\n',
      });

export function listTools(): Promise<ToolStatus[]> {
  return Promise.resolve([
    { id: 'dev', name: 'Tongyun Dev', available: true, applicationPath: null, detail: '企业级服务与终端' },
    { id: 'api', name: 'Tongyun API', available: true, applicationPath: null, detail: '企业级接口测试器' },
    { id: 'database', name: 'Tongyun Database', available: true, applicationPath: null, detail: '企业级数据与模式' },
    { id: 'git', name: 'Tongyun Git', available: true, applicationPath: null, detail: '企业级版本工作台' },
  ]);
}

export const launchTool = (toolId: ToolId) =>
  Promise.resolve<LaunchResult>({ message: `已激活 ${toolId} 工作区` });

export const openProjectDirectory = (id: string) => native<void>('open_project_directory', { id });
export const openInTerminal = (id: string) => native<void>('open_in_terminal', { id });
export const openProjectFile = (id: string, relativePath: string) =>
  native<void>('open_project_file', { id, relativePath });
export const chooseProjectDirectory = () => native<string | null>('choose_project_directory');

export function getInitialAgentSession(projectName: string = 'tongyun-studio'): import('./contracts').AgentSessionState {
  return {
    agentName: 'AGY-Copilot',
    model: 'Claude 3.7 Sonnet / Antigravity Agent',
    mode: 'collaborative',
    activeGoal: `为 ${projectName} 构建企业级三栏可视化工作台并提供 Agent 全生命周期行为监视`,
    tokensConsumed: 48920,
    filesTouched: 14,
    lastHeartbeat: new Date().toLocaleTimeString(),
    plan: {
      id: 'plan-001',
      goal: '三栏架构重构 & Agent 行为可视化落地',
      status: 'executing',
      progressPercent: 75,
      steps: [
        { id: 'step-1', text: '分析项目工作区与上下文依赖结构', status: 'done' },
        { id: 'step-2', text: '重构工作台为三栏弹性伸缩布局 (Rail + Explorer + Main + Cockpit)', status: 'done' },
        { id: 'step-3', text: '实现二级上下文侧栏 (Explorer) 一键合并/收起 (⌘B)', status: 'done' },
        { id: 'step-4', text: '构建 Agent 操作实时监视舱 (Live Cockpit)，可视化命令与工具流', status: 'active' },
        { id: 'step-5', text: '实现操作事件一键在工作台聚焦定位 (Focus in Workbench)', status: 'todo' },
      ],
    },
    actions: [
      {
        id: 'act-1',
        kind: 'terminal',
        title: '执行构建验证',
        detail: 'cargo test -p studio-core --offline',
        status: 'done',
        exitCode: 0,
        durationMs: 820,
        timestamp: '14:55:02',
        outputPreview: 'test result: ok. 5 passed; 0 failed; finished in 1.12s',
      },
      {
        id: 'act-2',
        kind: 'git',
        title: 'Git 状态检索与自动暂存',
        detail: 'git status & stage modified enterprise components',
        status: 'done',
        durationMs: 140,
        timestamp: '14:55:40',
        target: 'src/features/GitPanel.tsx',
        outputPreview: '13 files changed, 3586 insertions(+), 665 deletions(-)',
      },
      {
        id: 'act-3',
        kind: 'edit',
        title: '重构工作区三栏架构',
        detail: '引入 Activity Rail 与可收起二级导航 Pane',
        status: 'done',
        durationMs: 310,
        timestamp: '14:56:15',
        target: 'src/App.tsx',
      },
      {
        id: 'act-4',
        kind: 'inspect',
        title: '端口感知与守护进程健康检查',
        detail: 'detect_listening_ports(:5173, :3000)',
        status: 'done',
        durationMs: 85,
        timestamp: '14:57:08',
        outputPreview: 'Listening: :5173 (vite), :3000 (daemon)',
      },
      {
        id: 'act-5',
        kind: 'plan',
        title: '实时渲染 Agent 操作流与人机干预界面',
        detail: '渲染步骤时间轴与操作回溯组件',
        status: 'running',
        durationMs: 450,
        timestamp: '14:58:30',
        target: 'src/components/AgentCockpit.tsx',
      },
    ],
  };
}
