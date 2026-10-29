import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DevPanel, { isServiceFailed, formatErrorSummary, resolveTaskName } from '../features/DevPanel';
import { listProjectServices } from '../bridge';
import type { ManagedService, Project } from '../contracts';

const mockProject: Project = {
  id: 'proj-1',
  name: 'my-web-app',
  path: '/Users/d/code/my-web-app',
  createdAt: '2026-10-29T10:00:00Z',
  dev: {
    command: 'npm run dev',
    port: 3000,
    kind: 'vite',
    label: 'Vite Frontend',
  },
};

const failedService: ManagedService = {
  id: 'svc-failed',
  projectId: 'proj-1',
  command: 'npm run build',
  pid: null,
  status: 'failed',
  startedAt: '2026-10-29T10:00:00Z',
  exitCode: 1,
  stdout: 'vite v7.0.0 building...\n[error] failed to resolve import',
  stderr: 'Error: Cannot find module /Users/d/code/my-web-app/src/main.ts\n    at Module.load',
  outputTruncated: false,
  lifecycle: 'failed',
  failure: '构建失败：进程退出，退出码 1',
  port: null,
  portOpen: false,
  elapsedSecs: 5,
  logTail: 'vite v7.0.0 building...\nError: Cannot find module /Users/d/code/my-web-app/src/main.ts\nexit code 1',
  readyTimeoutSecs: 60,
  reachable: false,
  activeProfile: 'Build Script',
};

const runningService: ManagedService = {
  id: 'svc-running',
  projectId: 'proj-1',
  command: 'npm run dev',
  pid: 12345,
  status: 'running',
  startedAt: '2026-10-29T10:00:00Z',
  exitCode: null,
  stdout: 'Ready on http://localhost:3000',
  stderr: '',
  outputTruncated: false,
  lifecycle: 'ready',
  failure: null,
  port: 3000,
  portOpen: true,
  elapsedSecs: 120,
  logTail: 'Ready on http://localhost:3000',
  readyTimeoutSecs: 60,
  reachable: true,
};

const successExitedService: ManagedService = {
  id: 'svc-exited-ok',
  projectId: 'proj-1',
  command: 'npm test',
  pid: null,
  status: 'exited',
  startedAt: '2026-10-29T10:00:00Z',
  exitCode: 0,
  stdout: 'All tests passed (10/10)',
  stderr: '',
  outputTruncated: false,
  lifecycle: 'exited',
  failure: null,
  port: null,
  portOpen: false,
  elapsedSecs: 10,
  logTail: 'All tests passed (10/10)',
  readyTimeoutSecs: 60,
  reachable: false,
};

vi.mock('../bridge', () => ({
  isDesktop: true,
  listProjectServices: vi.fn(async () => []),
  detectListeningPorts: vi.fn(async () => []),
  startProjectService: vi.fn(),
  restartProjectService: vi.fn(),
  stopProjectService: vi.fn(),
  openUrl: vi.fn(),
  chooseProjectDirectory: vi.fn(async () => '/synthetic'),
  scanDevDirectory: vi.fn(async () => ({ root: '/synthetic', depth: 3, dirsVisited: 1, truncated: false, candidates: [] })),
  importDevCandidates: vi.fn(async () => ({ workspace: { version: 1, projects: [], activeProjectId: null }, added: 0, attached: 0, unchanged: 0 })),
  startDevGroup: vi.fn(async () => []),
  stopDevGroup: vi.fn(async () => []),
  devProjectLogTail: vi.fn(async () => null),
  inspectProjectDependencies: vi.fn(async () => null),
  updateProjectDev: vi.fn(async () => ({ version: 1, projects: [], activeProjectId: null })),
  installProjectDependencies: vi.fn(async () => null),
  updateProjectAutoRestart: vi.fn(async () => ({})),
  loadWorkspace: vi.fn(async () => ({ version: 1, projects: [], activeProjectId: null })),
}));

describe('formatErrorSummary & isServiceFailed unit tests', () => {
  it('correctly identifies failed vs success/running states', () => {
    expect(isServiceFailed(failedService)).toBe(true);
    expect(isServiceFailed(runningService)).toBe(false);
    expect(isServiceFailed(successExitedService)).toBe(false);

    // Non-zero exit code marks failure even if status was exited
    const abnormalExit = { ...successExitedService, exitCode: 137 };
    expect(isServiceFailed(abnormalExit)).toBe(true);

    // Stopped by user is not a crash failure
    const stoppedService = { ...runningService, status: 'stopped' as const, lifecycle: 'stopped' as const };
    expect(isServiceFailed(stoppedService)).toBe(false);
  });

  it('formats error summary with task name, command, exit code, and bounded tail lines', () => {
    const summary = formatErrorSummary(failedService, 'Build Script');

    expect(summary).toContain('任务名: Build Script');
    expect(summary).toContain('命令: npm run build');
    expect(summary).toContain('Exit Code: 1');
    expect(summary).toContain('退出码: 1');
    expect(summary).toContain('失败原因: 构建失败：进程退出，退出码 1');
    expect(summary).toContain('末尾日志:');
    expect(summary).toContain('/Users/d/code/my-web-app/src/main.ts');
  });

  it('limits log tail in summary to at most 80 lines', () => {
    // Generate a 120-line log
    const lines = Array.from({ length: 120 }, (_, i) => `log line ${i + 1}: detailed output`);
    const serviceWithLongLog: ManagedService = {
      ...failedService,
      logTail: lines.join('\n'),
    };

    const summary = formatErrorSummary(serviceWithLongLog, 'Long Task');
    expect(summary).toContain('任务名: Long Task');

    // Tail section should contain at most 80 lines
    const tailSection = summary.split('末尾日志:\n')[1];
    const tailLines = tailSection.split('\n');
    expect(tailLines.length).toBeLessThanOrEqual(80);
    // Line 1 should have been truncated, while line 120 is present
    expect(summary).not.toContain('log line 1:');
    expect(summary).toContain('log line 120: detailed output');
    expect(summary).toContain('log line 41: detailed output');
  });

  it('resolves task name gracefully across activeProfile, script name, and command', () => {
    expect(resolveTaskName(failedService, [{ name: 'build', command: 'npm run build' }])).toBe('Build Script');

    const noProfileService = { ...failedService, activeProfile: undefined };
    expect(resolveTaskName(noProfileService, [{ name: 'build', command: 'npm run build' }])).toBe('build');

    const customService = { ...failedService, activeProfile: undefined, command: 'cat /etc/hosts' };
    expect(resolveTaskName(customService, [], 'my-app')).toBe('my-app (cat /etc/hosts)');
  });
});

describe('DevPanel Copy Error UI integration', () => {
  let writeTextMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText: writeTextMock },
    });
  });

  it('renders 「复制报错」 button on failed service card and copies error summary', async () => {
    vi.mocked(listProjectServices).mockResolvedValue([failedService]);

    const onNotify = vi.fn();
    render(<DevPanel project={mockProject} onNotify={onNotify} />);

    // Should display the failed service card
    expect(await screen.findByText('执行失败')).toBeInTheDocument();

    // The "复制报错" button must be present in failure state
    const copyErrorBtn = screen.getByRole('button', { name: '复制报错' });
    expect(copyErrorBtn).toBeInTheDocument();

    // Click to copy error summary
    fireEvent.click(copyErrorBtn);

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledTimes(1);
    });

    const copiedText = writeTextMock.mock.calls[0][0];
    expect(copiedText).toContain('任务名: Build Script');
    expect(copiedText).toContain('命令: npm run build');
    expect(copiedText).toContain('Exit Code: 1');
    expect(copiedText).toContain('退出码: 1');
    expect(copiedText).toContain('末尾日志:');
    expect(copiedText).toContain('/Users/d/code/my-web-app/src/main.ts');

    // Notification feedback
    expect(onNotify).toHaveBeenCalledWith('已复制报错摘要到剪贴板');

    // Button updates to feedback state
    expect(await screen.findByText('已复制')).toBeInTheDocument();
  });

  it('does NOT render 「复制报错」 button on running or successful service cards', async () => {
    vi.mocked(listProjectServices).mockResolvedValue([runningService, successExitedService]);

    render(<DevPanel project={mockProject} />);

    // Wait for services to load
    const readyBadges = await screen.findAllByText('就绪');
    expect(readyBadges.length).toBeGreaterThan(0);
    expect(screen.getByText('已完成')).toBeInTheDocument();

    // Neither service is failed, so no "复制报错" button should exist
    expect(screen.queryByRole('button', { name: '复制报错' })).not.toBeInTheDocument();
    expect(screen.queryByText('复制报错')).not.toBeInTheDocument();
  });
});
