import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Project, Workspace, ProjectInspection, FileEntry, GitFileChange, GitHistoryResult, GitCommitDetails, ExecutionResult, HttpResponse, SqlQueryResult, DbTableInfo, DbColumnInfo, PaginatedData, ListeningPort, AiProjectContext, ManagedService, AgentSessionState, DevScanReport, DevCandidate, DevImportResult, AgentHttpInfo } from './contracts';

export const isDesktop = isTauri();
function native<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktop) return Promise.reject(new Error('本机操作需要在橦云工作台桌面版中使用。'));
  return invoke<T>(command, args);
}
export function loadWorkspace(): Promise<Workspace> {
  return isDesktop ? native('load_workspace') : Promise.resolve({ version: 1, projects: [], activeProjectId: null });
}
export const addProject = (path: string) => native<Workspace>('add_project', { path });
export const selectProject = (id: string) => native<Workspace>('select_project', { id });
export const removeProject = (id: string) => native<Workspace>('remove_project', { id });
export const inspectProject = (id: string) => native<ProjectInspection>('inspect_project', { id });
export const readProjectTree = (id: string, relativeDir?: string) => native<FileEntry[]>('read_project_tree', { id, relativeDir: relativeDir ?? null });
export const readProjectFileContent = (id: string, relativePath: string) => native<string>('read_project_file_content', { id, relativePath });
export const getGitChangedFiles = (id: string) => native<GitFileChange[]>('get_git_changed_files', { id });
export const getGitDiff = (id: string, filePath?: string) => native<string>('get_git_diff', { id, filePath: filePath ?? null });
export const getGitHistory = (id: string, skip?: number, limit?: number, allBranches?: boolean) =>
  native<GitHistoryResult>('get_git_history', { id, skip: skip ?? null, limit: limit ?? null, allBranches: allBranches ?? null });
export const getGitCommitDetails = (id: string, oid: string) => native<GitCommitDetails>('get_git_commit_details', { id, oid });
export const getGitCommitFileDiff = (id: string, oid: string, filePath: string, oldPath?: string | null) =>
  native<string>('get_git_commit_file_diff', { id, oid, filePath, oldPath: oldPath ?? null });
export const createGitCommit = (id: string, message: string) => native<string>('create_git_commit', { id, message });
export const gitCommitAmend = (id: string, message?: string) => native<string>('git_commit_amend', { id, message: message ?? null });
export const gitStageFile = (id: string, path: string) => native<string>('git_stage_file', { id, path });
export const gitUnstageFile = (id: string, path: string) => native<string>('git_unstage_file', { id, path });
export const gitStageAll = (id: string) => native<string>('git_stage_all', { id });
export const gitUnstageAll = (id: string) => native<string>('git_unstage_all', { id });
export const gitDiscardFile = (id: string, path: string) => native<string>('git_discard_file', { id, path });
export const gitCreateBranch = (id: string, branchName: string) => native<string>('git_create_branch', { id, branchName });
export const gitRemoteSync = (id: string, action: 'fetch' | 'pull' | 'push') => native<string>('git_remote_sync', { id, action });
export const getGitBranches = (id: string) => native<string[]>('get_git_branches', { id });
export const switchGitBranch = (id: string, branch: string) => native<string>('switch_git_branch', { id, branch });
export const executeProjectScript = (id: string, command: string) => native<ExecutionResult>('execute_project_script', { id, command });
export const sendHttpRequest = (method: string, url: string, headers: [string, string][], body?: string) => native<HttpResponse>('send_http_request', { method, url, headers, body: body ?? null });
export const executeSqlQuery = (id: string, dbPath: string, sql: string) => native<SqlQueryResult>('execute_sql_query', { id, dbPath, sql });
export const getDbTables = (id: string, dbPath: string) => native<DbTableInfo[]>('get_db_tables', { id, dbPath });
export const getTableColumns = (id: string, dbPath: string, tableName: string) => native<DbColumnInfo[]>('get_table_columns', { id, dbPath, tableName });
export const getTableData = (id: string, dbPath: string, tableName: string, page: number, pageSize: number) => native<PaginatedData>('get_table_data', { id, dbPath, tableName, page, pageSize });
export const detectListeningPorts = () => native<ListeningPort[]>('detect_listening_ports');
export const generateAiProjectContext = (id: string) => native<AiProjectContext>('generate_ai_project_context', { id });
export const openProjectDirectory = (id: string) => native<void>('open_project_directory', { id });
export const openInTerminal = (id: string) => native<void>('open_in_terminal', { id });
export const openProjectFile = (id: string, relativePath: string) => native<void>('open_project_file', { id, relativePath });
export const chooseProjectDirectory = () => native<string | null>('choose_project_directory');
export const openUrl = (url: string) => native<void>('open_url', { url });
export const writeProjectFile = (id: string, relativePath: string, content: string) => native<void>('write_project_file', { id, relativePath, content });
export const appendProjectFile = (id: string, relativePath: string, content: string) => native<void>('append_project_file', { id, relativePath, content });
export const startProjectService = (id: string, command: string, profile?: string | null) => native<ManagedService>('start_project_service', profile ? { id, command, profile } : { id, command });
export const listProjectServices = (id: string) => native<ManagedService[]>('list_project_services', { id });
export const stopProjectService = (id: string, serviceId: string) => native<ManagedService>('stop_project_service', { id, serviceId });
export const restartProjectService = (id: string, serviceId: string) => native<ManagedService>('restart_project_service', { id, serviceId });
export const updateProjectAutoRestart = (id: string, autoRestart: boolean, maxRestarts?: number | null, restartIntervalSecs?: number | null) => native<Project>('update_project_auto_restart', { id, autoRestart, maxRestarts: maxRestarts ?? null, restartIntervalSecs: restartIntervalSecs ?? null });
export const scanDevDirectory = (path: string, depth?: number) => native<DevScanReport>('scan_dev_directory', { path, depth: depth ?? null });
export const getAgentHttpInfo = () => native<AgentHttpInfo>('agent_http_info');
export const importDevCandidates = (candidates: DevCandidate[]) => native<DevImportResult>('import_dev_candidates', { candidates });
export const startDevGroup = (group: string) => native<ManagedService[]>('start_dev_group', { group });
export const stopDevGroup = (group: string) => native<ManagedService[]>('stop_dev_group', { group });
export const devServiceLogTail = (id: string, serviceId: string, lines?: number) => native<string>('dev_service_log_tail', { id, serviceId, lines: lines ?? null });
export const devProjectLogTail = (id: string, lines?: number) => native<string | null>('dev_project_log_tail', { id, lines: lines ?? null });
export const updateProjectDev = (id: string, dev: import('./contracts').DevProfile | null) => native<Workspace>('update_project_dev', { id, dev });
export const updateProjectAutoInstall = (id: string, autoInstall: boolean) => native<Workspace>('update_project_auto_install', { id, autoInstall });
export const installProjectDependencies = (id: string) => native<ManagedService>('install_project_dependencies', { id });
export function getInitialAgentSession(projectId: string | null = null): AgentSessionState {
  return { projectId, connectionStatus: 'not_connected', agentName: null, model: null, mode: null, activeGoal: null, plan: null, actions: [], tokensConsumed: null, filesTouched: null, lastHeartbeat: null };
}
