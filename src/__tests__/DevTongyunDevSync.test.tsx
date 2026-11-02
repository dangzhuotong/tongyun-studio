import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DevPanel, { formatRegistrySummary } from '../features/DevPanel';
import { importDevCandidates, readTongyunDevRegistry } from '../bridge';
import type { DevCandidate, Project, TongyunDevSyncReport, Workspace } from '../contracts';

const candidate: DevCandidate = {
  name: 'demo-api',
  path: '/synthetic/demo-api',
  kind: 'tongyun-dev',
  label: 'tongyun-dev 已登记',
  confidence: 'high',
  command: 'pnpm dev',
  port: 3000,
  group: 'demo',
  healthUrl: 'http://127.0.0.1:3000/health',
};

const report: TongyunDevSyncReport = {
  configPath: '/synthetic/.config/tongyun-dev/projects.toml',
  configSource: 'user_default',
  candidates: [candidate],
  skipped: [{ name: 'ghost-app', reason: '项目目录不存在：/synthetic/ghost-app' }],
  truncated: false,
};

const emptyWorkspace: Workspace = { version: 1, projects: [], activeProjectId: null };

vi.mock('../bridge', () => ({
  isDesktop: true,
  listProjectServices: vi.fn(async () => []),
  detectListeningPorts: vi.fn(async () => []),
  startProjectService: vi.fn(),
  restartProjectService: vi.fn(),
  stopProjectService: vi.fn(),
  openUrl: vi.fn(),
  chooseProjectDirectory: vi.fn(),
  scanDevDirectory: vi.fn(),
  importDevCandidates: vi.fn(async () => ({ workspace: emptyWorkspace, added: 1, attached: 0, unchanged: 0 })),
  readTongyunDevRegistry: vi.fn(),
  startDevGroup: vi.fn(),
  stopDevGroup: vi.fn(),
  devProjectLogTail: vi.fn(async () => null),
  updateProjectDev: vi.fn(),
  installProjectDependencies: vi.fn(),
  updateProjectAutoRestart: vi.fn(),
  loadWorkspace: vi.fn(async () => emptyWorkspace),
}));

describe('tongyun-dev registry import', () => {
  it('names the config source and counts in the summary', () => {
    expect(formatRegistrySummary(report)).toContain('从 tongyun-dev 读到 1 个可登记项目，跳过 1 个。来源：默认配置文件（/synthetic/.config/tongyun-dev/projects.toml）。');
    const none = formatRegistrySummary({ ...report, candidates: [], truncated: true });
    expect(none).toContain('tongyun-dev 里暂时没有可登记的项目');
    expect(none).toContain('超过 64 个已截断');
    expect(formatRegistrySummary({ ...report, configSource: 'env' })).toContain('环境变量 TONGYUN_DEV_CONFIG');
  });

  it('reads the registry, shows skipped rows, and registers only the selected project', async () => {
    vi.mocked(readTongyunDevRegistry).mockResolvedValue(report);
    const onNotify = vi.fn();
    render(<DevPanel project={null} onNotify={onNotify} />);

    fireEvent.click(screen.getByRole('button', { name: '从 tongyun-dev 读取' }));

    expect(await screen.findByText('demo-api')).toBeInTheDocument();
    expect(screen.getByText(/项目目录不存在：\/synthetic\/ghost-app/)).toBeInTheDocument();
    expect(screen.getByText(/来源：默认配置文件/)).toBeInTheDocument();

    const register = screen.getByRole('button', { name: '登记所选' });
    expect(register).toBeEnabled();
    fireEvent.click(register);

    await waitFor(() => {
      expect(importDevCandidates).toHaveBeenCalledWith([expect.objectContaining({
        name: 'demo-api',
        path: '/synthetic/demo-api',
        command: 'pnpm dev',
        port: 3000,
        group: 'demo',
      })]);
    });
    await waitFor(() => {
      expect(onNotify).toHaveBeenCalledWith('已登记 1 个项目，补上运行配置 0 个，未改动 0 个。');
    });
  });

  it('surfaces a registry read failure without crashing the panel', async () => {
    vi.mocked(readTongyunDevRegistry).mockRejectedValue(new Error('配置文件解析失败，已保留原文件。'));
    vi.mocked(importDevCandidates).mockClear();
    const project: Project = {
      id: 'proj-demo',
      name: 'demo-api',
      path: '/synthetic/demo-api',
      createdAt: '2026-11-03T00:00:00Z',
    };
    render(<DevPanel project={project} projects={[project]} />);

    fireEvent.click(screen.getByRole('button', { name: '从 tongyun-dev 读取' }));

    expect(await screen.findByText(/配置文件解析失败/)).toBeInTheDocument();
    expect(importDevCandidates).not.toHaveBeenCalled();
  });
});
