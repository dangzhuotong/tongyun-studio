import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import GitPanel from '../features/GitPanel';
import * as bridge from '../bridge';
import type { GitHistoryResult, GitCommitDetails, Project, ProjectInspection } from '../contracts';

vi.mock('../bridge', () => ({
  isDesktop: true,
  getGitBranches: vi.fn(async () => ['main']),
  getGitChangedFiles: vi.fn(async () => []),
  getGitDiff: vi.fn(async () => 'no change'),
  getGitHistory: vi.fn(),
  getGitCommitDetails: vi.fn(),
  getGitCommitFileDiff: vi.fn(async () => 'diff --git a/src/a.ts b/src/a.ts\n+hello world'),
  createGitCommit: vi.fn(async () => 'abc1234'),
  gitCommitAmend: vi.fn(async () => 'abc1234'),
  switchGitBranch: vi.fn(async () => 'switched'),
  gitStageFile: vi.fn(async () => 'ok'),
  gitUnstageFile: vi.fn(async () => 'ok'),
  gitStageAll: vi.fn(async () => 'ok'),
  gitUnstageAll: vi.fn(async () => 'ok'),
  gitDiscardFile: vi.fn(async () => 'ok'),
  gitCreateBranch: vi.fn(async () => 'ok'),
  gitRemoteSync: vi.fn(async () => 'ok'),
}));

const project: Project = {
  id: 'proj_git',
  name: 'git-demo',
  path: '/tmp/git-demo',
  createdAt: '2026-11-01T00:00:00Z',
};

const inspection: ProjectInspection = {
  exists: true,
  git: {
    isRepository: true,
    branch: 'main',
    head: 'c200000',
    changedFiles: 0,
    recentCommits: [],
    error: null,
  },
  httpFiles: 0,
  httpFilePaths: [],
  techStack: [],
  scripts: [],
  dbArtifacts: [],
};

const OID_MERGE = `c${'2'.repeat(39)}`;
const OID_ROOT = `r${'1'.repeat(39)}`;

const historyFixture: GitHistoryResult = {
  commits: [
    {
      oid: OID_MERGE,
      shortOid: OID_MERGE.slice(0, 7),
      parents: [OID_ROOT],
      authorName: 'Alice',
      authorEmail: 'alice@example.invalid',
      timestamp: Math.floor(Date.now() / 1000) - 120,
      summary: 'feat: 提交历史视图',
      refs: [{ name: 'main', kind: 'head' }],
      col: 0,
      edges: [{ fromCol: 0, toCol: 0 }],
    },
    {
      oid: OID_ROOT,
      shortOid: OID_ROOT.slice(0, 7),
      parents: [],
      authorName: 'Bob',
      authorEmail: 'bob@example.invalid',
      timestamp: Math.floor(Date.now() / 1000) - 3600,
      summary: 'chore: initial commit',
      refs: [{ name: 'v1', kind: 'tag' }],
      col: 0,
      edges: [],
    },
  ],
  total: 2,
  hasMore: false,
};

const detailsFixture: GitCommitDetails = {
  oid: OID_MERGE,
  shortOid: OID_MERGE.slice(0, 7),
  parents: [OID_ROOT],
  authorName: 'Alice',
  authorEmail: 'alice@example.invalid',
  authorTimestamp: Math.floor(Date.now() / 1000) - 120,
  committerName: 'Alice',
  committerEmail: 'alice@example.invalid',
  commitTimestamp: Math.floor(Date.now() / 1000) - 120,
  message: 'feat: 提交历史视图\n\n正文说明',
  files: [{ path: 'src/a.ts', oldPath: null, status: 'M' }],
};

describe('GitPanel log tree view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(bridge.getGitHistory).mockResolvedValue(historyFixture);
    vi.mocked(bridge.getGitCommitDetails).mockResolvedValue(detailsFixture);
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(() => Promise.resolve()) },
    });
  });

  const openLogView = async () => {
    render(<GitPanel project={project} inspection={inspection} />);
    fireEvent.click(screen.getByRole('tab', { name: /提交历史/ }));
    await waitFor(() => expect(bridge.getGitHistory).toHaveBeenCalled());
  };

  it('loads and renders commit rows with badges and topology', async () => {
    await openLogView();
    expect(bridge.getGitHistory).toHaveBeenCalledWith('proj_git', 0, 100, false);
    expect(await screen.findByText('feat: 提交历史视图')).toBeTruthy();
    expect(screen.getByText('chore: initial commit')).toBeTruthy();
    expect(screen.getByText('v1')).toBeTruthy();
    expect(screen.getByText('已加载 2 / 2 个提交')).toBeTruthy();
    expect(document.querySelectorAll('.git-log-row')).toHaveLength(2);
    expect(document.querySelectorAll('.git-log-graph svg, svg.git-log-graph')).toHaveLength(2);
  });

  it('opens commit details and per-file diff when a row is clicked', async () => {
    await openLogView();
    fireEvent.click(screen.getByText('feat: 提交历史视图'));
    await waitFor(() => expect(bridge.getGitCommitDetails).toHaveBeenCalledWith('proj_git', OID_MERGE));
    expect(await screen.findByText(/正文说明/)).toBeTruthy();
    expect(screen.getByText('src/a.ts')).toBeTruthy();
    await waitFor(() =>
      expect(bridge.getGitCommitFileDiff).toHaveBeenCalledWith('proj_git', OID_MERGE, 'src/a.ts', null),
    );
    expect(await screen.findByText('+hello world')).toBeTruthy();
  });

  it('copies the full commit SHA from the row hash', async () => {
    await openLogView();
    fireEvent.click(screen.getAllByTitle('点击复制 Commit SHA')[0]);
    await waitFor(() =>
      expect(window.navigator.clipboard.writeText).toHaveBeenCalledWith(OID_MERGE),
    );
    expect(bridge.getGitCommitDetails).not.toHaveBeenCalled();
  });

  it('appends the next page through 加载更多', async () => {
    vi.mocked(bridge.getGitHistory).mockResolvedValueOnce({
      ...historyFixture,
      hasMore: true,
      total: 120,
    });
    render(<GitPanel project={project} inspection={inspection} />);
    fireEvent.click(screen.getByRole('tab', { name: /提交历史/ }));
    await waitFor(() => expect(bridge.getGitHistory).toHaveBeenCalled());
    fireEvent.click(await screen.findByText('加载更多'));
    await waitFor(() => expect(bridge.getGitHistory).toHaveBeenLastCalledWith('proj_git', 2, 100, false));
  });

  it('refuses local history loads for non-repository projects', () => {
    render(
      <GitPanel
        project={project}
        inspection={{ ...inspection, git: { ...inspection.git, isRepository: false } }}
      />,
    );
    expect(bridge.getGitHistory).not.toHaveBeenCalled();
  });
});
