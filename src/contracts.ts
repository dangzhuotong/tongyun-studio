export type ToolId = 'dev' | 'api' | 'database' | 'git';

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
