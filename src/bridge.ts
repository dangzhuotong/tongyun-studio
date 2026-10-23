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
        { path: 'src/features/ApiPanel.tsx', status: 'M', staged: false },
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

export const getGitBranches = (id: string) =>
  isDesktop
    ? native<string[]>('get_git_branches', { id })
    : Promise.resolve(['main', 'develop']);

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

export function listTools(): Promise<ToolStatus[]> {
  return Promise.resolve([
    { id: 'dev', name: 'Tongyun Dev', available: true, applicationPath: null, detail: '内嵌原生运行控制台' },
    { id: 'api', name: 'Tongyun API', available: true, applicationPath: null, detail: '内嵌原生接口请求器' },
    { id: 'database', name: 'Tongyun Database', available: true, applicationPath: null, detail: '内嵌原生数据与 SQL' },
    { id: 'git', name: 'Tongyun Git', available: true, applicationPath: null, detail: '内嵌原生版本工作流' },
  ]);
}

export const launchTool = (toolId: ToolId) =>
  Promise.resolve<LaunchResult>({ message: `已激活 ${toolId} 工作区` });

export const openProjectDirectory = (id: string) => native<void>('open_project_directory', { id });
export const openInTerminal = (id: string) => native<void>('open_in_terminal', { id });
export const openProjectFile = (id: string, relativePath: string) =>
  native<void>('open_project_file', { id, relativePath });
export const chooseProjectDirectory = () => native<string | null>('choose_project_directory');
