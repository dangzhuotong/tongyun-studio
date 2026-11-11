import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DevPanel from '../features/DevPanel';
import { listProjectServices, updateProjectAutoRestart } from '../bridge';

const serviceWithRestart = {
  id: 'svc-restarted',
  projectId: 'p1',
  command: 'pnpm dev',
  pid: 1234,
  status: 'running' as const,
  startedAt: '2026-10-29T10:00:00Z',
  exitCode: null,
  stdout: 'restarted output',
  stderr: '[自动重启] 进程异常退出，正在进行第 2/3 次自动重启...',
  outputTruncated: false,
  lifecycle: 'ready' as const,
  failure: null,
  port: 3000,
  portOpen: true,
  elapsedSecs: 15,
  logTail: 'running after 2 restarts',
  readyTimeoutSecs: 180,
  reachable: true,
  restartCount: 2,
  autoRestart: true,
  maxRestarts: 3,
};

const serviceFailedAtLimit = {
  id: 'svc-failed-limit',
  projectId: 'p1',
  command: 'pnpm dev',
  pid: null,
  status: 'failed' as const,
  startedAt: '2026-10-29T10:00:00Z',
  exitCode: 1,
  stdout: '',
  stderr: '[自动重启] 已达自动重启上限（3次），停止重启：进程退出，退出码 1',
  outputTruncated: false,
  lifecycle: 'failed' as const,
  failure: '已达自动重启上限（3次），停止重启：进程退出，退出码 1',
  port: 3000,
  portOpen: false,
  elapsedSecs: 30,
  logTail: 'failed after reaching 3 restarts',
  readyTimeoutSecs: 180,
  reachable: false,
  restartCount: 3,
  autoRestart: true,
  maxRestarts: 3,
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
  updateProjectAutoRestart: vi.fn(async () => ({
    id: 'p1',
    name: 'web',
    path: '/synthetic/web',
    createdAt: '',
    dev: {
      command: 'pnpm dev',
      kind: 'vite',
      label: 'Vite',
      autoRestart: true,
      maxRestarts: 3,
      restartIntervalSecs: 60,
    },
  })),
  loadWorkspace: vi.fn(async () => ({ version: 1, projects: [], activeProjectId: null })),
}));

describe('DevPanel auto-restart UI', () => {
  it('renders default closed state and allows toggling auto-restart', async () => {
    const projectDefault = {
      id: 'p1',
      name: 'web',
      path: '/synthetic/web',
      createdAt: '',
      dev: {
        command: 'pnpm dev',
        port: 3000,
        kind: 'vite',
        label: 'Vite',
        autoRestart: false,
      },
    };

    const onNotify = vi.fn();
    render(<DevPanel project={projectDefault} onNotify={onNotify} />);

    fireEvent.click(screen.getByText('运行设置'));
    expect(screen.getByText('异常退出自动重启（默认关闭）')).toBeVisible();

    const checkbox = screen.getByLabelText('异常退出自动重启');
    expect(checkbox).not.toBeChecked();

    fireEvent.click(checkbox);
    await waitFor(() => {
      expect(updateProjectAutoRestart).toHaveBeenCalledWith('p1', true, 3, 60);
    });
    expect(onNotify).toHaveBeenCalledWith('已开启该项目异常退出自动重启');
  });

  it('displays restart count and failure reason on service cards', async () => {
    vi.mocked(listProjectServices).mockResolvedValue([serviceWithRestart, serviceFailedAtLimit]);

    const projectWithRestart = {
      id: 'p1',
      name: 'web',
      path: '/synthetic/web',
      createdAt: '',
      dev: {
        command: 'pnpm dev',
        port: 3000,
        kind: 'vite',
        label: 'Vite',
        autoRestart: true,
        maxRestarts: 3,
        restartIntervalSecs: 60,
      },
    };

    render(<DevPanel project={projectWithRestart} />);

    fireEvent.click(screen.getByText('运行设置'));
    expect(screen.getByText('上限 3 次 · 窗口 60s')).toBeVisible();

    // Shows restart counts on both process rows
    expect(await screen.findByText('已重启 2 次')).toBeInTheDocument();
    expect(screen.getByText('已重启 3 次')).toBeInTheDocument();

    // Shows failure reason at limit
    expect(
      screen.getByText('已达自动重启上限（3次），停止重启：进程退出，退出码 1')
    ).toBeInTheDocument();
  });
});
