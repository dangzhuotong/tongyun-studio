import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DevPanel from '../features/DevPanel';
import { exportDiagnostics } from '../bridge';
import type { Project } from '../contracts';

const mockProject: Project = {
  id: 'proj-diagnostics',
  name: 'test-studio-app',
  path: '/Users/d/code/test-studio-app',
  createdAt: '2026-10-30T10:00:00Z',
  dev: {
    command: 'npm run dev',
    port: 3000,
    kind: 'vite',
    label: 'Vite Frontend',
  },
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
  scanDevDirectory: vi.fn(async () => ({
    root: '/synthetic',
    depth: 3,
    dirsVisited: 1,
    truncated: false,
    candidates: [],
  })),
  importDevCandidates: vi.fn(async () => ({
    workspace: { version: 1, projects: [], activeProjectId: null },
    added: 0,
    attached: 0,
    unchanged: 0,
  })),
  startDevGroup: vi.fn(async () => []),
  stopDevGroup: vi.fn(async () => []),
  devProjectLogTail: vi.fn(async () => 'mock log tail content'),
  updateProjectDev: vi.fn(async () => ({ version: 1, projects: [], activeProjectId: null })),
  installProjectDependencies: vi.fn(async () => null),
  updateProjectAutoRestart: vi.fn(async () => ({})),
  loadWorkspace: vi.fn(async () => ({ version: 1, projects: [], activeProjectId: null })),
  exportDiagnostics: vi.fn(),
}));

describe('DevPanel Export Diagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders "导出诊断包" button in terminal console header', async () => {
    render(<DevPanel project={mockProject} />);

    const exportBtn = screen.getByRole('button', { name: /导出诊断包/ });
    expect(exportBtn).toBeInTheDocument();
    expect(exportBtn).not.toBeDisabled();
  });

  it('successfully triggers export and calls onNotify with target path', async () => {
    const notifyMock = vi.fn();
    vi.mocked(exportDiagnostics).mockResolvedValueOnce({
      filePath: '/Users/d/Downloads/tongyun-studio-diagnostics-20261030-220000.zip',
      fileSize: 4096,
      projectCount: 1,
      logCount: 1,
      exportedAt: '2026-10-30T22:00:00Z',
    });

    render(<DevPanel project={mockProject} onNotify={notifyMock} />);

    const exportBtn = screen.getByRole('button', { name: /导出诊断包/ });
    fireEvent.click(exportBtn);

    await waitFor(() => {
      expect(exportDiagnostics).toHaveBeenCalledTimes(1);
      expect(notifyMock).toHaveBeenCalledWith(
        expect.stringContaining('/Users/d/Downloads/tongyun-studio-diagnostics-20261030-220000.zip')
      );
    });
  });

  it('displays permission denied reason when destination directory lacks write permissions', async () => {
    const notifyMock = vi.fn();
    const permErrorMsg = '导出诊断包失败：目标路径 \'/root/diagnostics.zip\' 写入权限不足（Permission denied）。请选择有写入权限的目录后重试。';
    vi.mocked(exportDiagnostics).mockRejectedValueOnce(new Error(permErrorMsg));

    render(<DevPanel project={mockProject} onNotify={notifyMock} />);

    const exportBtn = screen.getByRole('button', { name: /导出诊断包/ });
    fireEvent.click(exportBtn);

    await waitFor(() => {
      expect(exportDiagnostics).toHaveBeenCalledTimes(1);
      expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining('Permission denied'));
      expect(screen.getByRole('alert')).toHaveTextContent(/Permission denied/);
    });
  });

  it('handles user cancellation without showing error banner', async () => {
    const notifyMock = vi.fn();
    vi.mocked(exportDiagnostics).mockRejectedValueOnce(new Error('用户取消导出'));

    render(<DevPanel project={mockProject} onNotify={notifyMock} />);

    const exportBtn = screen.getByRole('button', { name: /导出诊断包/ });
    fireEvent.click(exportBtn);

    await waitFor(() => {
      expect(exportDiagnostics).toHaveBeenCalledTimes(1);
      expect(notifyMock).not.toHaveBeenCalled();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });
});
