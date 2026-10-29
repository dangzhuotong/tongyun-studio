import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DevPanel from '../features/DevPanel';
import { devProjectLogTail, listProjectServices } from '../bridge';

const mockService = {
  id: 'srv-1',
  projectId: 'demo-app',
  command: 'npm start',
  pid: 1234,
  status: 'running' as const,
  startedAt: '2026-10-29T08:00:00Z',
  exitCode: null,
  stdout: 'live stdout output',
  stderr: '',
  outputTruncated: false,
  lifecycle: 'ready' as const,
  failure: null,
  port: 8080,
  portOpen: true,
  elapsedSecs: 10,
  logTail: 'live stdout output',
  readyTimeoutSecs: 180,
  reachable: true,
};

vi.mock('../bridge', () => ({
  isDesktop: true,
  listProjectServices: vi.fn(),
  detectListeningPorts: vi.fn(async () => []),
  startProjectService: vi.fn(),
  restartProjectService: vi.fn(),
  stopProjectService: vi.fn(),
  openUrl: vi.fn(),
  chooseProjectDirectory: vi.fn(async () => '/synthetic'),
  scanDevDirectory: vi.fn(),
  importDevCandidates: vi.fn(),
  startDevGroup: vi.fn(async () => []),
  stopDevGroup: vi.fn(async () => []),
  devProjectLogTail: vi.fn(),
}));

const project = {
  id: 'demo-app',
  name: 'demo',
  path: '/tmp/demo',
  createdAt: '2026-10-29T00:00:00Z',
  dev: {
    command: 'npm start',
    port: 8080,
    healthUrl: null,
    kind: 'node',
    label: 'Node',
  },
};

describe('DevPanel Log Persistence on App Restart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('displays disk log tail when app restarts with zero running services', async () => {
    // Simulating app restart: listProjectServices returns [] (clean process table)
    vi.mocked(listProjectServices).mockResolvedValue([]);
    // But disk has persisted logs from the previous session
    vi.mocked(devProjectLogTail).mockResolvedValue(
      '2026-10-29 16:00:00 App booted\n2026-10-29 16:00:01 Listening on 8080'
    );

    render(<DevPanel project={project} projects={[project]} />);

    // Should find the persisted disk log entry
    expect(await screen.findByText('上次运行日志（已落盘）')).toBeInTheDocument();
    expect(screen.getByText('历史记录')).toBeInTheDocument();
    expect(
      screen.getByText(/2026-10-29 16:00:01 Listening on 8080/)
    ).toBeInTheDocument();
  });

  it('supports copying the persisted disk log', async () => {
    vi.mocked(listProjectServices).mockResolvedValue([]);
    const diskOutput = 'Line 1: init\nLine 2: server ready';
    vi.mocked(devProjectLogTail).mockResolvedValue(diskOutput);

    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText: writeTextMock },
    });

    render(<DevPanel project={project} projects={[project]} />);

    const copyBtn = await screen.findByRole('button', {
      name: '复制上次运行输出',
    });
    fireEvent.click(copyBtn);

    expect(writeTextMock).toHaveBeenCalledWith(diskOutput);
  });

  it('shows empty hint when app restarts and no disk logs exist', async () => {
    vi.mocked(listProjectServices).mockResolvedValue([]);
    vi.mocked(devProjectLogTail).mockResolvedValue(null);

    render(<DevPanel project={project} projects={[project]} />);

    expect(
      await screen.findByText('执行命令后，日志尾部会显示在这里。')
    ).toBeInTheDocument();
    expect(screen.queryByText('上次运行日志（已落盘）')).not.toBeInTheDocument();
  });

  it('prioritizes live service output when a service is actively running', async () => {
    vi.mocked(listProjectServices).mockResolvedValue([mockService]);
    vi.mocked(devProjectLogTail).mockResolvedValue('old historical log');

    render(<DevPanel project={project} projects={[project]} />);

    expect(await screen.findByText('$ npm start')).toBeInTheDocument();
    expect(screen.getByText('live stdout output')).toBeInTheDocument();
    expect(screen.queryByText('上次运行日志（已落盘）')).not.toBeInTheDocument();
  });
});
