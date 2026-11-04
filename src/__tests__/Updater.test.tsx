import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { UpdateModal } from '../components/UpdateModal';
import { checkForAppUpdate, isDesktopEnvironment } from '../utils/updater';
import type { Update } from '@tauri-apps/plugin-updater';

describe('Updater Utilities', () => {
  it('detects desktop environment correctly based on isTauri', () => {
    // In vitest jsdom environment without Tauri internals, isDesktopEnvironment is false
    expect(isDesktopEnvironment()).toBe(false);
  });

  it('checkForAppUpdate returns null in non-desktop environments', async () => {
    const res = await checkForAppUpdate();
    expect(res).toBeNull();
  });
});

describe('UpdateModal Component', () => {
  it('does not render when isOpen is false', () => {
    const { container } = render(
      <UpdateModal isOpen={false} onClose={vi.fn()} currentVersion="0.1.0" />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders checking state then up-to-date when no update is found', async () => {
    const mockCheck = vi.fn().mockResolvedValue(null);

    render(
      <UpdateModal
        isOpen={true}
        onClose={vi.fn()}
        currentVersion="0.1.0"
        mockCheck={mockCheck}
      />
    );

    // Initial checking state
    expect(screen.getByText('检查应用更新')).toBeInTheDocument();
    expect(screen.getByText(/当前版本：/)).toBeInTheDocument();
    expect(screen.getByText('v0.1.0')).toBeInTheDocument();

    // After resolution
    await waitFor(() => {
      expect(screen.getByText('当前已是最新版本')).toBeInTheDocument();
    });
    expect(screen.getByText(/已处于最新发布版本/)).toBeInTheDocument();
    expect(screen.getByText('再次检查')).toBeInTheDocument();
  });

  it('renders available update with version, release notes and starts download', async () => {
    const mockUpdate: Partial<Update> = {
      available: true,
      version: '0.1.1',
      date: '2026-11-05',
      body: '1. 新增自动发版与更新\n2. 修复多处细节体验',
      downloadAndInstall: vi.fn(),
    };

    const mockCheck = vi.fn().mockResolvedValue(mockUpdate as Update);
    const mockInstall = vi.fn().mockImplementation(async (_u, onProgress) => {
      if (onProgress) {
        onProgress({ event: 'Started', contentLength: 1000, percent: 0 });
        onProgress({ event: 'Progress', chunkLength: 500, percent: 50 });
        onProgress({ event: 'Finished', percent: 100 });
      }
    });

    render(
      <UpdateModal
        isOpen={true}
        onClose={vi.fn()}
        currentVersion="0.1.0"
        mockCheck={mockCheck}
        mockInstall={mockInstall}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('发现新版本 v0.1.1')).toBeInTheDocument();
    });

    expect(screen.getByText(/发布时间：2026-11-05/)).toBeInTheDocument();
    expect(screen.getByText(/新增自动发版与更新/)).toBeInTheDocument();

    const updateBtn = screen.getByText('立即下载并更新');
    expect(updateBtn).toBeInTheDocument();

    fireEvent.click(updateBtn);

    await waitFor(() => {
      expect(mockInstall).toHaveBeenCalled();
      expect(screen.getByText('更新已就绪')).toBeInTheDocument();
    });
    expect(screen.getByText(/正在重启应用以生效新版本/)).toBeInTheDocument();
  });

  it('renders error state and retry button when check fails', async () => {
    const mockCheck = vi.fn().mockRejectedValue(new Error('网络超时无法连接 GitHub'));

    render(
      <UpdateModal
        isOpen={true}
        onClose={vi.fn()}
        currentVersion="0.1.0"
        mockCheck={mockCheck}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('检查或更新失败')).toBeInTheDocument();
    });
    expect(screen.getByText(/网络超时无法连接 GitHub/)).toBeInTheDocument();
    expect(screen.getByText('重试检查')).toBeInTheDocument();

    // Click retry
    mockCheck.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByText('重试检查'));

    await waitFor(() => {
      expect(screen.getByText('当前已是最新版本')).toBeInTheDocument();
    });
  });
});
