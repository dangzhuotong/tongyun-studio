import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ApiPanel from '../features/ApiPanel';
import * as bridge from '../bridge';
import type { HttpResponse, Project, ProjectInspection } from '../contracts';

const PUBLIC_ENV =
  '{"Development":{"host":"http://localhost:3000","name":"dev","baseUrl":"https://dev.example.com"},"Staging":{"host":"https://staging.example.com","name":"staging"}}';
const PRIVATE_ENV =
  '{"Staging":{"host":"https://staging-internal.example.com","token":"private-token"}}';

const defaultResponse: HttpResponse = {
  status: 200,
  statusText: 'OK',
  headers: [
    ['Content-Type', 'application/json'],
    ['X-Trace-Id', 'tr-7'],
  ],
  body: '{"code":0,"data":{"token":"tk-9"}}',
  latencyMs: 30,
};

vi.mock('../bridge', () => ({
  isDesktop: true,
  sendHttpRequest: vi.fn(async (_method: string, _url: string) => ({
    status: 200,
    statusText: 'OK',
    headers: [
      ['Content-Type', 'application/json'],
      ['X-Trace-Id', 'tr-7'],
    ],
    body: '{"code":0,"data":{"token":"tk-9"}}',
    latencyMs: 30,
  })),
  readProjectFileContent: vi.fn(async (_id: string, relativePath: string) => {
    if (relativePath === 'http-client.env.json') {
      return '{"Development":{"host":"http://localhost:3000","name":"dev","baseUrl":"https://dev.example.com"},"Staging":{"host":"https://staging.example.com","name":"staging"}}';
    }
    if (relativePath === 'http-client.private.env.json') {
      return '{"Staging":{"host":"https://staging-internal.example.com","token":"private-token"}}';
    }
    throw new Error('文件不存在: ' + relativePath);
  }),
  writeProjectFile: vi.fn(async () => {}),
  appendProjectFile: vi.fn(async () => {}),
}));

const mockProject: Project = {
  id: 'proj_env',
  name: 'env-demo',
  path: '/tmp/env-demo',
  createdAt: '2026-11-01T00:00:00Z',
};

const mockInspection: ProjectInspection = {
  exists: true,
  techStack: ['Node.js'],
  scripts: [],
  git: {
    isRepository: false,
    branch: null,
    head: null,
    changedFiles: 0,
    recentCommits: [],
    error: null,
  },
  dbArtifacts: [],
  httpFiles: 0,
  httpFilePaths: [],
};

const urlInput = () => screen.getByPlaceholderText(/\{\{baseUrl\}\}\/api/);
const envSelect = () => screen.getByLabelText('环境预设') as HTMLSelectElement;
const sendButton = () => screen.getByRole('button', { name: '发送' });
// 新建的 Tab 都叫「未命名请求」，按位置取标签
const tabAt = (index: number) => screen.getAllByRole('tab')[index];
const lastSentUrl = () => {
  const calls = vi.mocked(bridge.sendHttpRequest).mock.calls;
  return calls[calls.length - 1][1];
};

async function clickSend() {
  if (!(urlInput() as HTMLInputElement).value) {
    fireEvent.change(urlInput(), { target: { value: 'http://localhost:3000/api/health' } });
  }
  fireEvent.click(sendButton());
  await waitFor(() => {
    expect(bridge.sendHttpRequest).toHaveBeenCalled();
  });
}

async function loadProjectEnv() {
  fireEvent.click(screen.getByRole('button', { name: /读取 http-client/ }));
  await waitFor(() => {
    expect(envSelect().querySelector('option[value="Staging"]')).not.toBeNull();
  });
}

async function addExtractRule(variable: string, path: string, source?: 'header') {
  fireEvent.click(screen.getByRole('button', { name: /提取/ }));
  fireEvent.click(screen.getByRole('button', { name: /添加提取规则/ }));
  fireEvent.change(screen.getByPlaceholderText('token'), { target: { value: variable } });
  if (source === 'header') {
    fireEvent.change(screen.getByLabelText('提取来源'), { target: { value: 'header' } });
  }
  fireEvent.change(screen.getByPlaceholderText(source === 'header' ? 'X-Token' : 'data.token'), {
    target: { value: path },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // 逐用例重建默认实现，避免上一用例的 mockRejectedValueOnce 队列串到下一个渲染
  vi.mocked(bridge.readProjectFileContent).mockReset().mockImplementation(
    async (_id: string, relativePath: string) => {
      if (relativePath === 'http-client.env.json') return PUBLIC_ENV;
      if (relativePath === 'http-client.private.env.json') return PRIVATE_ENV;
      throw new Error('文件不存在: ' + relativePath);
    },
  );
  vi.mocked(bridge.sendHttpRequest).mockReset().mockImplementation(async () => defaultResponse);
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
});

describe('ApiPanel 环境预设级联与缺失告警', () => {
  it('读取项目环境文件后按预设替换实际发出的地址，私有文件覆盖同名变量', async () => {
    render(<ApiPanel project={mockProject} inspection={mockInspection} />);
    await loadProjectEnv();

    fireEvent.change(urlInput(), { target: { value: '{{host}}/api/health?env={{name}}' } });
    expect(envSelect().value).toBe('Development');
    await clickSend();
    expect(lastSentUrl()).toContain('http://localhost:3000/api/health?env=dev');

    fireEvent.change(envSelect(), { target: { value: 'Staging' } });
    await clickSend();
    expect(lastSentUrl()).toContain(
      'https://staging-internal.example.com/api/health?env=staging',
    );
  });

  it('手动变量覆盖同名预设变量', async () => {
    render(<ApiPanel project={mockProject} inspection={mockInspection} />);
    await loadProjectEnv();
    fireEvent.change(envSelect(), { target: { value: 'Development' } });

    fireEvent.click(screen.getByRole('button', { name: /^环境变量/ }));
    fireEvent.click(screen.getByRole('button', { name: /添加新变量/ }));
    fireEvent.change(screen.getByPlaceholderText('baseUrl'), { target: { value: 'baseUrl' } });
    fireEvent.change(screen.getByPlaceholderText('http://127.0.0.1:3000'), { target: { value: 'http://localhost:3000' } });
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    fireEvent.change(urlInput(), { target: { value: '{{baseUrl}}/api/ping' } });
    await clickSend();
    expect(lastSentUrl()).toContain('http://localhost:3000/api/ping');
  });

  it('环境缺少变量时给出明确告警并禁止发送', () => {
    render(<ApiPanel project={mockProject} inspection={mockInspection} />);

    fireEvent.change(urlInput(), { target: { value: '{{missingHost}}/api/x' } });
    expect(screen.getByRole('alert')).toHaveTextContent('{{missingHost}}');
    expect(sendButton()).toBeDisabled();
    expect(bridge.sendHttpRequest).not.toHaveBeenCalled();

    fireEvent.change(envSelect(), { target: { value: 'Development' } });
    expect(sendButton()).toBeDisabled();
  });

  it('项目没有环境文件时说明限制，不谎报已载入预设', async () => {
    // 挂载期用例集读取也会走同一 mock，Once 队列会被消耗；这里让任意文件一律不存在
    vi.mocked(bridge.readProjectFileContent).mockImplementation(async (_id, relPath) => {
      throw new Error('文件不存在: ' + relPath);
    });
    const notify = vi.fn();
    render(<ApiPanel project={mockProject} inspection={mockInspection} onNotify={notify} />);

    fireEvent.click(screen.getByRole('button', { name: /读取 http-client/ }));
    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith(expect.stringContaining('未找到 http-client.env.json'));
    });
    expect(screen.getByText('项目根目录没有环境文件')).toBeInTheDocument();
  });
});

describe('ApiPanel 断言卡片', () => {
  it('默认状态码断言通过，改期望值后判失败并写明实际值', async () => {
    render(<ApiPanel project={mockProject} inspection={mockInspection} />);
    fireEvent.click(screen.getByRole('button', { name: /断言/ }));
    await clickSend();

    expect(screen.getByText('断言测试 1/1 通过')).toBeInTheDocument();
    expect(screen.getByText('Passed')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('200,201'), { target: { value: '404' } });
    await clickSend();
    expect(screen.getByText('断言测试 0/1 通过')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('状态码等于 404')).toBeInTheDocument();
    expect(screen.getByText('状态码 期望 404，实际 200')).toBeInTheDocument();
  });

  it('JSON 字段与时延断言一起判定，禁用规则不参与', async () => {
    render(<ApiPanel project={mockProject} inspection={mockInspection} />);
    fireEvent.click(screen.getByRole('button', { name: /断言/ }));

    fireEvent.click(screen.getByRole('button', { name: /JSON 字段/ }));
    fireEvent.change(screen.getByPlaceholderText('data.code'), { target: { value: 'data.token' } });
    fireEvent.change(screen.getByPlaceholderText(/只判断存在/), { target: { value: 'tk-9' } });

    fireEvent.click(screen.getByRole('button', { name: /时延上限/ }));
    fireEvent.change(screen.getByPlaceholderText('500'), { target: { value: '100' } });

    await clickSend();
    expect(screen.getByText('断言测试 3/3 通过')).toBeInTheDocument();
    expect(screen.getByText('data.token = tk-9')).toBeInTheDocument();
    expect(screen.getByText('响应时延 ≤ 100 ms')).toBeInTheDocument();

    const firstCheckbox = screen.getAllByRole('checkbox')[0];
    fireEvent.click(firstCheckbox);
    await clickSend();
    expect(screen.getByText('断言测试 2/2 通过')).toBeInTheDocument();
  });

  it('响应不是 JSON 时字段断言判失败而不是崩溃', async () => {
    vi.mocked(bridge.sendHttpRequest).mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: [],
      body: 'plain text',
      latencyMs: 12,
    });
    render(<ApiPanel project={mockProject} inspection={mockInspection} />);
    fireEvent.click(screen.getByRole('button', { name: /断言/ }));
    fireEvent.click(screen.getByRole('button', { name: /JSON 字段/ }));
    fireEvent.change(screen.getByPlaceholderText('data.code'), { target: { value: 'data.token' } });
    fireEvent.change(screen.getByPlaceholderText(/只判断存在/), { target: { value: 'tk-9' } });

    await clickSend();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('响应体不是合法 JSON，无法按字段路径断言')).toBeInTheDocument();
  });
});

describe('ApiPanel 变量提取与链式调用', () => {
  it('从响应体提取 token 后，下一个请求直接引用新值', async () => {
    render(<ApiPanel project={mockProject} inspection={mockInspection} />);
    await addExtractRule('authToken', 'data.token');

    await clickSend();
    expect(screen.getByText('{{authToken}} = tk-9')).toBeInTheDocument();

    fireEvent.change(urlInput(), { target: { value: '{{authToken}}/me' } });
    await clickSend();
    expect(lastSentUrl()).toContain('tk-9/me');

    fireEvent.click(screen.getByRole('button', { name: /环境变量/ }));
    expect(screen.getByText('运行时提取')).toBeInTheDocument();
  });

  it('从响应头提取值写入变量，路径不存在时明确报告未更新', async () => {
    render(<ApiPanel project={mockProject} inspection={mockInspection} />);
    await addExtractRule('trace', 'X-Trace-Id', 'header');

    await clickSend();
    expect(screen.getByText('{{trace}} = tr-7')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('X-Token'), { target: { value: 'X-Nope' } });
    await clickSend();
    expect(screen.getByText('响应头 X-Nope 不存在，变量 trace 未更新')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});

describe('ApiPanel 多 Tab 隔离', () => {
  it('环境预设、断言与响应逐 Tab 独立，切 Tab 不串台', async () => {
    render(<ApiPanel project={mockProject} inspection={mockInspection} />);
    await loadProjectEnv();

    // Tab1：选 Staging 预设，URL 使用 {{host}} 并发一个请求
    fireEvent.change(urlInput(), { target: { value: '{{host}}/api/a' } });
    fireEvent.change(envSelect(), { target: { value: 'Staging' } });
    await clickSend();
    await waitFor(() => expect(screen.getByText('200 OK')).toBeInTheDocument());
    expect(lastSentUrl()).toContain('https://staging-internal.example.com/api/a');

    // Tab2：新 Tab 不继承 Tab1 的预设、断言改动与响应
    fireEvent.click(screen.getByRole('button', { name: '新建' }));
    expect(tabAt(1)).toHaveAttribute('aria-selected', 'true');
    expect(envSelect().value).toBe('');
    expect(screen.getByText('断言 (1)')).toBeInTheDocument();
    expect(screen.queryByText('200 OK')).not.toBeInTheDocument();

    // 切回 Tab1：预设、断言条数与响应都还在
    fireEvent.click(tabAt(0));
    expect(envSelect().value).toBe('Staging');
    expect(screen.getByText('200 OK')).toBeInTheDocument();

    // Tab1 加一条 JSON 断言后，Tab2 仍只见默认的状态码断言
    fireEvent.click(screen.getByRole('button', { name: /断言/ }));
    fireEvent.click(screen.getByRole('button', { name: /JSON 字段/ }));
    expect(screen.getByText('断言 (2)')).toBeInTheDocument();
    fireEvent.click(tabAt(1));
    expect(screen.getByText('断言 (1)')).toBeInTheDocument();
  });

  it('后到的响应只落回发起请求的 Tab，不覆盖当前查看的 Tab', async () => {
    let resolveFirst: (v: import('../contracts').HttpResponse) => void = () => {};
    vi.mocked(bridge.sendHttpRequest).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveFirst = resolve;
        }),
    );
    vi.mocked(bridge.sendHttpRequest).mockResolvedValueOnce({
      status: 201,
      statusText: 'Created',
      headers: [],
      body: '{}',
      latencyMs: 5,
    });
    render(<ApiPanel project={mockProject} inspection={mockInspection} />);

    await clickSend(); // Tab1 挂起
    fireEvent.click(screen.getByRole('button', { name: '新建' })); // 切到 Tab2
    await clickSend(); // Tab2 返回 201
    await waitFor(() => expect(screen.getByText('201 Created')).toBeInTheDocument());

    resolveFirst({
      status: 200,
      statusText: 'OK',
      headers: [],
      body: '{"code":0,"data":{"token":"tk-9"}}',
      latencyMs: 10,
    });
    await waitFor(() => expect(vi.mocked(bridge.sendHttpRequest)).toHaveBeenCalledTimes(2));
    // 当前仍在 Tab2：迟到的 Tab1 响应不得覆盖 Tab2 视图
    expect(screen.getByText('201 Created')).toBeInTheDocument();
    // 切回 Tab1：能看到自己的 200 响应
    fireEvent.click(screen.getAllByRole('tab')[0]);
    await waitFor(() => expect(screen.getByText('200 OK')).toBeInTheDocument());
  });
});

describe('ApiPanel 多语言代码生成', () => {
  it('弹窗列出 7 种语言，切换后复制对应代码', () => {
    const notify = vi.fn();
    render(<ApiPanel project={mockProject} inspection={mockInspection} onNotify={notify} />);
    fireEvent.change(urlInput(), { target: { value: 'http://localhost:3000/api/health' } });
    fireEvent.click(screen.getByRole('button', { name: /代码生成/ }));
    for (const label of [
      'cURL',
      'JavaScript Fetch',
      'Axios',
      'Python requests',
      'Python httpx',
      'Go net/http',
      'Rust reqwest',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByText(/curl -X GET 'http:\/\/localhost:3000\/api\/health/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Rust reqwest' }));
    expect(screen.getByText(/reqwest::blocking/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Go net/http' }));
    expect(screen.getByText(/http\.NewRequest/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /复制代码/ }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('net/http'),
    );
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Go net/http'));
  });

  it('代码生成使用当前环境替换后的实际值', async () => {
    render(<ApiPanel project={mockProject} inspection={mockInspection} />);
    await loadProjectEnv();
    fireEvent.change(envSelect(), { target: { value: 'Staging' } });
    fireEvent.change(urlInput(), { target: { value: '{{host}}/api/orders' } });

    fireEvent.click(screen.getByRole('button', { name: /代码生成/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Python httpx' }));
    expect(
      screen.getByText(/https:\/\/staging-internal\.example\.com\/api\/orders/),
    ).toBeInTheDocument();
  });
});
