export type ToolId = 'dev' | 'api' | 'database' | 'git';
export interface Project { id: string; name: string; path: string; createdAt: string }
export interface Workspace { version: number; projects: Project[]; activeProjectId: string | null }
export interface GitSummary { isRepository: boolean; branch: string | null; head: string | null; changedFiles: number; error: string | null }
export interface ProjectInspection { exists: boolean; git: GitSummary; httpFiles: number }
export interface ToolStatus { id: ToolId; name: string; available: boolean; applicationPath: string | null; detail: string }
export interface LaunchResult { message: string }
