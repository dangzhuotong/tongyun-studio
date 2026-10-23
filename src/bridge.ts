import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Workspace, ProjectInspection, ToolStatus, ToolId, LaunchResult } from './contracts';
export const isDesktop = isTauri();
function native<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktop) return Promise.reject(new Error('本机操作需要在橦云工作台桌面版中使用。'));
  return invoke<T>(command, args);
}
export function loadWorkspace(): Promise<Workspace> {
  return isDesktop ? native('load_workspace') : Promise.resolve({version: 1, projects: [], activeProjectId: null});
}
export const addProject = (path: string) => native<Workspace>('add_project', { path });
export const selectProject = (id: string) => native<Workspace>('select_project', { id });
export const removeProject = (id: string) => native<Workspace>('remove_project', { id });
export const inspectProject = (id: string) => native<ProjectInspection>('inspect_project', { id });
export function listTools(): Promise<ToolStatus[]> {
  return isDesktop ? native('list_tools') : Promise.resolve([
    {id: 'dev', name: '橦云 Dev', available: false, applicationPath: null, detail: '请在桌面版检测本机安装情况'},
    {id: 'api', name: '橦云接口', available: false, applicationPath: null, detail: '请在桌面版检测本机安装情况'},
    {id: 'database', name: '橦云数据库', available: false, applicationPath: null, detail: '请在桌面版检测本机安装情况'},
    {id: 'git', name: '橦云 Git', available: false, applicationPath: null, detail: '请在桌面版检测本机安装情况'},
  ]);
}
export const launchTool = (toolId: ToolId) => native<LaunchResult>('launch_tool', { toolId });
export const openProjectDirectory = (id: string) => native<void>('open_project_directory', { id });
export const chooseProjectDirectory = () => native<string | null>('choose_project_directory');
