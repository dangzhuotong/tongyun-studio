import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DevPanel from '../features/DevPanel';
import { importDevCandidates, listProjectServices, scanDevDirectory, startDevGroup, startProjectService } from '../bridge';

const service = {
  id: 's', projectId: 'p', command: 'pnpm dev', pid: 9, status: 'running' as const,
  startedAt: '2026-10-28T00:00:00Z', exitCode: null, stdout: 'listening', stderr: '',
  outputTruncated: false, lifecycle: 'ready' as const, failure: null, port: 5173, portOpen: true,
  elapsedSecs: 2, logTail: 'listening on 5173', readyTimeoutSecs: 180, reachable: true,
};
const candidate = {
  name: 'web', path: '/synthetic/shop/web', kind: 'vite', label: 'Vite', confidence: 'high',
  command: 'pnpm dev', port: 5173, portGuessed: false, healthUrl: null, why: ['package.json 识别为 Vite。'],
  alreadyRegistered: false, existingProjectId: null, existingHasDev: false, group: 'shop',
};

vi.mock('../bridge', () => ({
  isDesktop: true,
  listProjectServices: vi.fn(async () => [service]),
  detectListeningPorts: vi.fn(async () => []),
  startProjectService: vi.fn(async () => service),
  restartProjectService: vi.fn(),
  stopProjectService: vi.fn(),
  openUrl: vi.fn(),
  chooseProjectDirectory: vi.fn(async () => '/synthetic'),
  scanDevDirectory: vi.fn(async () => ({ root: '/synthetic', depth: 3, dirsVisited: 4, truncated: false, candidates: [candidate] })),
  importDevCandidates: vi.fn(async () => ({ workspace: { version: 1, projects: [], activeProjectId: null }, added: 1, attached: 0, unchanged: 0 })),
  startDevGroup: vi.fn(async () => [service]),
  stopDevGroup: vi.fn(async () => []),
}));

const project = {
  id: 'p', name: 'web', path: '/synthetic/shop/web', createdAt: '',
  dev: { command: 'pnpm dev', port: 5173, healthUrl: null, kind: 'vite', label: 'Vite', group: 'shop', confidence: 'high' },
};
const peer = { id: 'api', name: 'api', path: '/synthetic/shop/api', createdAt: '', dev: { command: 'mvn spring-boot:run', port: 8080, kind: 'spring-boot-maven', label: 'Spring Boot（Maven）', group: 'shop' } };

describe('dev runtime panel', () => {
  it('scans a directory and registers the selected candidate', async () => {
    const onWorkspace = vi.fn();
    render(<DevPanel project={null} onWorkspace={onWorkspace}/>);
    fireEvent.change(screen.getByLabelText('要扫描的目录'), { target: { value: '/synthetic' } });
    fireEvent.click(screen.getByRole('button', { name: '扫描' }));
    expect(await screen.findByText('web')).toBeInTheDocument();
    expect(scanDevDirectory).toHaveBeenCalledWith('/synthetic', 3);
    fireEvent.click(screen.getByRole('button', { name: '登记所选' }));
    await waitFor(() => expect(importDevCandidates).toHaveBeenCalled());
    expect(onWorkspace).toHaveBeenCalled();
  });

  it('shows readiness and the log tail for a registered server', async () => {
    vi.mocked(listProjectServices).mockResolvedValue([service]);
    render(<DevPanel project={project} projects={[project, peer]}/>);
    expect((await screen.findAllByText('就绪')).length).toBeGreaterThan(0);
    expect(screen.getByText('listening on 5173')).toBeInTheDocument();
    expect(screen.getByText('日志尾部')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '已启动' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '启动同组' }));
    expect(startDevGroup).toHaveBeenCalledWith('shop');
  });

  it('shows a single failed label when a port process has already crashed', async () => {
    vi.mocked(listProjectServices).mockResolvedValue([{
      ...service,
      status: 'failed',
      lifecycle: 'starting',
      reachable: false,
      portOpen: false,
      pid: null,
      exitCode: 7,
      failure: '进程已退出',
    }]);
    render(<DevPanel project={project} projects={[project]}/>);
    expect(await screen.findByText('执行失败')).toBeInTheDocument();
    expect(screen.queryByText('启动中')).not.toBeInTheDocument();
  });

  it('starts the registered command when that process is not running', async () => {
    vi.mocked(listProjectServices).mockResolvedValue([]);
    render(<DevPanel project={project} projects={[project]}/>);
    const start = await screen.findByRole('button', { name: '按登记启动' });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    expect(startProjectService).toHaveBeenCalledWith('p', 'pnpm dev');
  });
});
