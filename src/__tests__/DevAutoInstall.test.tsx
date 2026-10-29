import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DevPanel from '../features/DevPanel';
import { listProjectServices, updateProjectDev } from '../bridge';
import type { ManagedService, Project } from '../contracts';

const installingService: ManagedService = {
  id: 'srv-installing',
  projectId: 'proj-node',
  command: 'npm run dev',
  pid: 101,
  status: 'running',
  startedAt: '2026-10-29T00:00:00Z',
  exitCode: null,
  stdout: '[tongyun-studio] 检测到依赖缺失，正在安装依赖：pnpm install\nProgress: resolved 100 packages',
  stderr: '',
  outputTruncated: false,
  lifecycle: 'installing',
  failure: null,
  port: 5173,
  portOpen: false,
  elapsedSecs: 3,
  logTail: '[tongyun-studio] 检测到依赖缺失，正在安装依赖：pnpm install\nProgress: resolved 100 packages',
  readyTimeoutSecs: 180,
  reachable: false,
};

const failedInstallService: ManagedService = {
  id: 'srv-failed',
  projectId: 'proj-node',
  command: 'npm run dev',
  pid: null,
  status: 'failed',
  startedAt: '2026-10-29T00:00:00Z',
  exitCode: 1,
  stdout: '',
  stderr: 'ERR! 404 Not Found',
  outputTruncated: false,
  lifecycle: 'failed',
  failure: '依赖安装失败：pnpm install 退出码 1',
  port: 5173,
  portOpen: false,
  elapsedSecs: null,
  logTail: 'ERR! 404 Not Found',
  readyTimeoutSecs: 180,
  reachable: false,
};

vi.mock('../bridge', () => ({
  isDesktop: true,
  listProjectServices: vi.fn(async () => [installingService]),
  detectListeningPorts: vi.fn(async () => []),
  startProjectService: vi.fn(),
  restartProjectService: vi.fn(),
  stopProjectService: vi.fn(),
  openUrl: vi.fn(),
  chooseProjectDirectory: vi.fn(),
  scanDevDirectory: vi.fn(),
  importDevCandidates: vi.fn(),
  startDevGroup: vi.fn(),
  stopDevGroup: vi.fn(),
  devProjectLogTail: vi.fn(async () => null),
  updateProjectDev: vi.fn(async () => ({ version: 1, projects: [], activeProjectId: null })),
}));

describe('DevPanel auto-install and dependency settings', () => {
  it('displays installing status and log tail during dependency installation', async () => {
    vi.mocked(listProjectServices).mockResolvedValue([installingService]);
    const project: Project = {
      id: 'proj-node',
      name: 'node-app',
      path: '/synthetic/node-app',
      createdAt: '2026-10-29T00:00:00Z',
      dev: {
        command: 'npm run dev',
        kind: 'vite',
        label: 'Vite',
        port: 5173,
      },
    };

    render(<DevPanel project={project} projects={[project]} />);

    expect((await screen.findAllByText('安装中')).length).toBeGreaterThan(0);
    expect(screen.getByText(/正在安装依赖：pnpm install/)).toBeInTheDocument();
  });

  it('displays failed label and reason when dependency installation fails', async () => {
    vi.mocked(listProjectServices).mockResolvedValue([failedInstallService]);
    const project: Project = {
      id: 'proj-node',
      name: 'node-app',
      path: '/synthetic/node-app',
      createdAt: '2026-10-29T00:00:00Z',
      dev: {
        command: 'npm run dev',
        kind: 'vite',
        label: 'Vite',
        port: 5173,
      },
    };

    render(<DevPanel project={project} projects={[project]} />);

    expect(await screen.findByText('执行失败')).toBeInTheDocument();
    expect(screen.getByText('依赖安装失败：pnpm install 退出码 1')).toBeInTheDocument();
  });

  it('allows toggling auto install setting in the UI and calls updateProjectDev', async () => {
    vi.mocked(listProjectServices).mockResolvedValue([]);
    const project: Project = {
      id: 'proj-node',
      name: 'node-app',
      path: '/synthetic/node-app',
      createdAt: '2026-10-29T00:00:00Z',
      dev: {
        command: 'npm run dev',
        kind: 'vite',
        label: 'Vite',
        port: 5173,
        autoInstall: true,
      },
    };

    const onNotify = vi.fn();
    render(<DevPanel project={project} projects={[project]} onNotify={onNotify} />);

    const checkbox = await screen.findByLabelText('首次启动自动检测并安装依赖');
    expect(checkbox).toBeChecked();

    fireEvent.click(checkbox);
    await waitFor(() => {
      expect(updateProjectDev).toHaveBeenCalledWith('proj-node', expect.objectContaining({
        autoInstall: false,
      }));
    });
  });

  it('renders and toggles pullDepsFirst for Maven and Gradle projects', async () => {
    vi.mocked(listProjectServices).mockResolvedValue([]);
    const mavenProject: Project = {
      id: 'proj-mvn',
      name: 'spring-app',
      path: '/synthetic/spring-app',
      createdAt: '2026-10-29T00:00:00Z',
      dev: {
        command: 'mvn spring-boot:run',
        kind: 'spring-boot-maven',
        label: 'Spring Boot（Maven）',
        port: 8080,
        pullDepsFirst: false,
      },
    };

    render(<DevPanel project={mavenProject} projects={[mavenProject]} />);

    const pullCheckbox = await screen.findByLabelText('Maven/Gradle 首启先拉取依赖');
    expect(pullCheckbox).not.toBeChecked();

    fireEvent.click(pullCheckbox);
    await waitFor(() => {
      expect(updateProjectDev).toHaveBeenCalledWith('proj-mvn', expect.objectContaining({
        pullDepsFirst: true,
      }));
    });
  });
});
