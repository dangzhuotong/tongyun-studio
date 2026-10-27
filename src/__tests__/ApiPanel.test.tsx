import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ApiPanel from '../features/ApiPanel';
import * as bridge from '../bridge';

import type { Project, ProjectInspection } from '../contracts';

vi.mock('../bridge', () => ({
  isDesktop: true,
  sendHttpRequest: vi.fn(async () => ({
    status: 200,
    statusText: 'OK',
    headers: [['Content-Type', 'application/json']],
    body: '{"ok":true}',
    latencyMs: 42,
  })),
  readProjectFileContent: vi.fn(async () => `### Get User\nGET https://api.example.com/users/1\nAccept: application/json\nAuthorization: Bearer token123\n\n{"filter":"active"}`),
  writeProjectFile: vi.fn(async () => {}),
  appendProjectFile: vi.fn(async () => {}),
}));

const mockProject: Project = {
  id: 'proj_api',
  name: 'api-demo',
  path: '/path/to/api-demo',
  createdAt: '2026-10-25T00:00:00Z',
};

const mockInspection: ProjectInspection = {
  exists: true,
  techStack: ['Node.js'],
  scripts: [],
  git: {
    isRepository: true,
    branch: 'main',
    head: 'abc1234',
    changedFiles: 0,
    recentCommits: [],
    error: null,
  },
  dbArtifacts: [],
  httpFiles: 2,
  httpFilePaths: ['requests.http', 'api/users.http'],
};

describe('ApiPanel Polish & Enhancements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(async () => {}),
      },
    });
  });

  it('renders workbench action bar with "复制 cURL" and "保存为 .http" buttons', () => {
    render(<ApiPanel project={mockProject} inspection={mockInspection} />);

    expect(screen.getByRole('heading', { name: 'Tongyun API · 接口工作台' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /复制 cURL/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /保存为 \.http/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /导入 cURL/i })).toBeInTheDocument();
  });

  it('provides header quick presets and autocompletion datalists in Headers tab', () => {
    render(<ApiPanel project={mockProject} inspection={mockInspection} />);

    const headersTab = screen.getByRole('button', { name: /Headers/i });
    fireEvent.click(headersTab);

    // Verify Quick Presets are present
    expect(screen.getByText('快捷预设:')).toBeInTheDocument();
    const jsonPreset = screen.getByRole('button', { name: '+ JSON' });
    expect(jsonPreset).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Form' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ No-Cache' })).toBeInTheDocument();

    // Click + Form preset
    fireEvent.click(screen.getByRole('button', { name: '+ Form' }));
    expect(screen.getByDisplayValue('application/x-www-form-urlencoded')).toBeInTheDocument();

    // Verify autocomplete datalist elements exist
    const keyDatalist = document.getElementById('common-header-keys');
    expect(keyDatalist).toBeInTheDocument();
  });

  it('opens "保存为 .http" modal, generates snippet and calls appendProjectFile upon saving', async () => {
    const notifyMock = vi.fn();
    const refreshMock = vi.fn();

    render(
      <ApiPanel
        project={mockProject}
        inspection={mockInspection}
        onNotify={notifyMock}
        onRefresh={refreshMock}
      />
    );

    const saveHttpBtn = screen.getByRole('button', { name: /保存为 \.http/i });
    fireEvent.click(saveHttpBtn);

    // Modal should be open
    expect(screen.getByRole('heading', { name: '保存请求为 .http 用例文件' })).toBeInTheDocument();
    expect(screen.getByText('生成的 .http 格式代码预览:')).toBeInTheDocument();

    // Click "复制片段"
    const copySnippetBtn = screen.getByRole('button', { name: /复制片段/i });
    fireEvent.click(copySnippetBtn);
    expect(navigator.clipboard.writeText).toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledWith('已复制 .http 格式代码片段');

    // Click "保存到项目"
    const saveToProjectBtn = screen.getByRole('button', { name: /保存到项目/i });
    fireEvent.click(saveToProjectBtn);

    await waitFor(() => {
      expect(bridge.appendProjectFile).toHaveBeenCalledWith(
        mockProject.id,
        'requests.http',
        expect.stringContaining('GET http://localhost:3000/api/health')
      );
    });

    expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining('已保存到项目用例文件'));
    expect(refreshMock).toHaveBeenCalled();
  });

  it('parses method, url, headers, and body when loading an .http file', async () => {
    const notifyMock = vi.fn();

    render(
      <ApiPanel
        project={mockProject}
        inspection={mockInspection}
        onNotify={notifyMock}
      />
    );

    const httpFileBtn = screen.getByRole('button', { name: 'requests.http' });
    fireEvent.click(httpFileBtn);

    await waitFor(() => {
      expect(bridge.readProjectFileContent).toHaveBeenCalledWith(mockProject.id, 'requests.http');
    });

    // Check URL was updated from .http file content
    expect(screen.getByDisplayValue('https://api.example.com/users/1')).toBeInTheDocument();
    expect(notifyMock).toHaveBeenCalledWith('已载入用例：requests.http');
  });

  it('copies cURL command with correct headers and handles response cURL export', async () => {
    const notifyMock = vi.fn();

    render(
      <ApiPanel
        project={mockProject}
        inspection={mockInspection}
        onNotify={notifyMock}
      />
    );

    // Copy cURL from header badge
    const copyCurlBadge = screen.getByRole('button', { name: /复制 cURL/i });
    fireEvent.click(copyCurlBadge);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('curl -X GET')
    );
    expect(notifyMock).toHaveBeenCalledWith('已复制 cURL 完整命令');

    // Trigger Send
    const sendBtn = screen.getByRole('button', { name: '发送' });
    fireEvent.click(sendBtn);

    await waitFor(() => {
      expect(screen.getByText('200 OK')).toBeInTheDocument();
    });

    // Response area has "复制 cURL" button
    const copyCurlInResponse = screen.getAllByRole('button', { name: /复制 cURL/i })[1];
    expect(copyCurlInResponse).toBeInTheDocument();
    fireEvent.click(copyCurlInResponse);
    expect(notifyMock).toHaveBeenCalledWith('已复制 cURL 完整命令');

    // History drawer item has copy button
    const historyCopyBtn = screen.getByTitle('复制此历史请求的 cURL');
    expect(historyCopyBtn).toBeInTheDocument();
    fireEvent.click(historyCopyBtn);
    expect(notifyMock).toHaveBeenCalledWith('已复制历史请求 cURL');
  });
});
