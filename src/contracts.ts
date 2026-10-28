export type ToolId = 'dev' | 'api' | 'database' | 'git' | 'files';

export type ActiveTab = 'overview' | 'agent' | ToolId;

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  dev?: DevProfile | null;
}

export interface DevProfile {
  command: string;
  port?: number | null;
  healthUrl?: string | null;
  kind: string;
  label: string;
  group?: string | null;
  confidence?: string | null;
  dependsOn?: string[];
  readyTimeoutSecs?: number | null;
}

export interface DevCandidate {
  name: string;
  path: string;
  kind: string;
  label: string;
  confidence: string;
  command: string;
  port?: number | null;
  portGuessed?: boolean;
  healthUrl?: string | null;
  why?: string[];
  alreadyRegistered?: boolean;
  existingProjectId?: string | null;
  existingHasDev?: boolean;
  group?: string | null;
  dependsOn?: string[];
}

export interface DevScanReport {
  root: string;
  depth: number;
  dirsVisited: number;
  truncated: boolean;
  candidates: DevCandidate[];
}

export interface DevImportResult {
  workspace: Workspace;
  added: number;
  attached: number;
  unchanged: number;
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

export interface ManagedService {
  id: string;
  projectId: string;
  command: string;
  pid: number | null;
  status: 'running' | 'stopped' | 'exited' | 'failed';
  startedAt: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  lifecycle: 'stopped' | 'starting' | 'port_open' | 'ready' | 'failed' | 'exited';
  failure: string | null;
  port: number | null;
  portOpen: boolean;
  elapsedSecs: number | null;
  logTail: string;
  readyTimeoutSecs: number;
  reachable: boolean;
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
  progressPercent: number | null;
  steps: AgentPlanStepItem[];
}

export interface AgentSessionState {
  projectId: string | null;
  connectionStatus: 'not_connected' | 'connected';
  agentName: string | null;
  model: string | null;
  mode: 'autonomous' | 'collaborative' | 'observer' | null;
  activeGoal: string | null;
  plan: AgentTaskPlan | null;
  actions: AgentActionStep[];
  tokensConsumed: number | null;
  filesTouched: number | null;
  lastHeartbeat: string | null;
}
