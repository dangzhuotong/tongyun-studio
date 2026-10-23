export type ToolId = 'dev' | 'api' | 'database' | 'git' | 'files';

export type ActiveTab = 'overview' | 'agent' | ToolId;

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

export interface Workspace {
  version: number;
  projects: Project[];
  activeProjectId: string | null;
}

export interface GitCommit {
  hash: string;
  author: string;
  relativeTime: string;
  message: string;
}

export interface GitSummary {
  isRepository: boolean;
  branch: string | null;
  head: string | null;
  changedFiles: number;
  recentCommits: GitCommit[];
  error: string | null;
}

export interface PackageScript {
  name: string;
  command: string;
}

export interface DbArtifact {
  name: string;
  path: string;
  kind: string;
}

export interface ProjectInspection {
  exists: boolean;
  git: GitSummary;
  httpFiles: number;
  httpFilePaths: string[];
  techStack: string[];
  scripts: PackageScript[];
  dbArtifacts: DbArtifact[];
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  sizeBytes: number;
  modified: string;
}

export interface GitFileChange {
  path: string;
  status: string;
  staged: boolean;
}

export interface ExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  latencyMs: number;
}

export interface SqlQueryResult {
  columns: string[];
  rows: (string | number | boolean | null)[][];
  rowCount: number;
  durationMs: number;
  error: string | null;
}

export interface DbTableInfo {
  name: string;
  kind: string;
}

export interface DbColumnInfo {
  cid: number;
  name: string;
  dataType: string;
  notNull: boolean;
  dfltValue: string | null;
  pk: boolean;
}

export interface PaginatedData {
  columns: string[];
  rows: string[][];
  totalRows: number;
  page: number;
  pageSize: number;
}

export interface ListeningPort {
  port: number;
  process: string;
}

export interface AiProjectContext {
  projectName: string;
  projectPath: string;
  markdown: string;
}

export interface ToolStatus {
  id: ToolId;
  name: string;
  available: boolean;
  applicationPath: string | null;
  detail: string;
}

export interface LaunchResult {
  message: string;
}

export type AgentActionKind = 'terminal' | 'edit' | 'git' | 'sql' | 'http' | 'inspect' | 'plan';

export type AgentActionStatus = 'running' | 'done' | 'error' | 'pending';

export interface AgentActionStep {
  id: string;
  kind: AgentActionKind;
  title: string;
  detail: string;
  status: AgentActionStatus;
  target?: string;
  exitCode?: number;
  durationMs?: number;
  timestamp: string;
  toolPayload?: Record<string, unknown>;
  outputPreview?: string;
}

export interface AgentPlanStepItem {
  id: string;
  text: string;
  status: 'done' | 'active' | 'todo';
}

export interface AgentTaskPlan {
  id: string;
  goal: string;
  status: 'planning' | 'executing' | 'completed' | 'paused';
  progressPercent: number;
  steps: AgentPlanStepItem[];
}

export interface AgentSessionState {
  agentName: string;
  model: string;
  mode: 'autonomous' | 'collaborative' | 'observer';
  activeGoal: string;
  plan: AgentTaskPlan;
  actions: AgentActionStep[];
  tokensConsumed: number;
  filesTouched: number;
  lastHeartbeat: string;
}
