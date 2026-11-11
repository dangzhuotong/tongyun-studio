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

    expect(screen.getByRole('heading', { name: '接口' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /复制 cURL/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /保存为 \.http/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /导入 cURL/i })).toBeInTheDocument();
    expect(screen.getByLabelText('请求地址')).toHaveValue('');
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
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

    fireEvent.change(screen.getByLabelText('请求地址'), { target: { value: 'http://localhost:3000/api/health' } });
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

  it('解析 .http 文件成用例树，双击请求项在新 Tab 打开', async () => {
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

    // 侧栏以树形式展示解析结果
    const requestNode = await screen.findByTitle('在请求标签页打开');
    expect(requestNode).toHaveTextContent('Get User');

    fireEvent.click(requestNode);

    // 新 Tab 内载入完整请求：方法、URL、Header、Auth、Body
    expect(screen.getByDisplayValue('https://api.example.com/users/1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Headers \(/ }));
    expect(screen.getByDisplayValue('application/json')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Auth/ }));
    expect(screen.getByDisplayValue('token123')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Body/ }));
    expect(screen.getByDisplayValue('{"filter":"active"}')).toBeInTheDocument();
    expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining('已解析用例文件：requests.http'));
  });

  it('多 Tab 状态互不干扰，脏标记与关闭确认生效', async () => {
    render(<ApiPanel project={mockProject} inspection={mockInspection} />);

    const firstUrl = screen.getByLabelText('请求地址');
    fireEvent.change(firstUrl, { target: { value: 'https://a.test/one' } });
    fireEvent.change(screen.getByLabelText('用例名称'), { target: { value: '甲请求' } });
    expect(document.querySelector('.tab-dirty-dot')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^新建$/ }));

    // 第二个 Tab 是全新的默认请求，不受第一个 Tab 影响
    expect(screen.getByLabelText('请求地址')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('请求地址'), {
      target: { value: 'https://a.test/two' },
    });
    fireEvent.change(screen.getByLabelText('用例名称'), { target: { value: '乙请求' } });

    // 切回第一个 Tab，URL 与用例名仍是它自己的
    fireEvent.click(screen.getByRole('tab', { name: /甲请求/ }));
    expect(screen.getByDisplayValue('https://a.test/one')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('https://a.test/two')).not.toBeInTheDocument();

    // 有未保存修改时关闭需确认；拒绝则 Tab 保留
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: '关闭 甲请求' }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: /甲请求/ })).toBeInTheDocument();

    // 确认后关闭，活动 Tab 落到相邻 Tab
    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: '关闭 甲请求' }));
    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: /甲请求/ })).not.toBeInTheDocument();
    });
    expect(screen.getByDisplayValue('https://a.test/two')).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('写回 .http 源文件时只改该请求，其余内容逐字节保留', async () => {
    render(<ApiPanel project={mockProject} inspection={mockInspection} />);

    fireEvent.click(screen.getByRole('button', { name: 'requests.http' }));
    const requestNode = await screen.findByTitle('在请求标签页打开');
    fireEvent.click(requestNode);

    fireEvent.change(screen.getByDisplayValue('https://api.example.com/users/1'), {
      target: { value: 'https://api.example.com/users/42?tag=beta' },
    });

    fireEvent.click(screen.getByRole('button', { name: /写回源文件/ }));

    await waitFor(() => {
      expect(bridge.writeProjectFile).toHaveBeenCalled();
    });
    const [, path, text] = vi.mocked(bridge.writeProjectFile).mock.calls[0];
    expect(path).toBe('requests.http');
    expect(text).toContain('### Get User');
    expect(text).toContain('GET https://api.example.com/users/42');
    expect(text).toContain('tag=beta');
    expect(text).toContain('Accept: application/json');
    expect(text).toContain('Authorization: Bearer token123');
    expect(text).toContain('{"filter":"active"}');
  });

  it('把当前请求存入项目 JSON 用例集并可再打开', async () => {
    render(<ApiPanel project={mockProject} inspection={mockInspection} />);

    fireEvent.change(screen.getByLabelText('请求地址'), {
      target: { value: 'https://a.test/case' },
    });
    fireEvent.click(screen.getByRole('button', { name: '存入当前请求' }));

    await waitFor(() => {
      expect(bridge.writeProjectFile).toHaveBeenCalledWith(
        mockProject.id,
        '.tongyun/api-collections.json',
        expect.stringContaining('"kind": "case"'),
      );
    });

    // 用例树出现保存的用例，点击后在 Tab 中打开
    const caseNode = await screen.findByTitle('双击在新 Tab 打开该用例');
    expect(caseNode).toHaveTextContent('未命名请求');
    fireEvent.click(caseNode);
    expect(screen.getByDisplayValue('https://a.test/case')).toBeInTheDocument();
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

    fireEvent.change(screen.getByLabelText('请求地址'), { target: { value: 'http://localhost:3000/api/health' } });
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

  it('导入 cURL：-X / -H / --data-raw / Bearer 解析后填入当前 Tab', () => {
    const notifyMock = vi.fn();
    render(<ApiPanel project={mockProject} inspection={mockInspection} onNotify={notifyMock} />);

    fireEvent.click(screen.getByRole('button', { name: /导入 cURL/i }));
    const textarea = screen.getByPlaceholderText(/粘贴包含/);
    fireEvent.change(textarea, {
      target: {
        value:
          "curl -X POST 'https://api.demo/orders' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Authorization: Bearer tk-1' \\\n  --data-raw '{\"qty\":2}'",
      },
    });
    fireEvent.click(screen.getByRole('button', { name: '解析并导入' }));

    expect(screen.getByDisplayValue('https://api.demo/orders')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Headers \(/ }));
    expect(screen.getByDisplayValue('application/json')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Auth/ }));
    expect(screen.getByDisplayValue('tk-1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Body/ }));
    expect(screen.getByDisplayValue('{"qty":2}')).toBeInTheDocument();
    expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining('POST https://api.demo/orders'));
    // 弹窗已关闭
    expect(screen.queryByPlaceholderText(/粘贴包含/)).not.toBeInTheDocument();
  });
});
