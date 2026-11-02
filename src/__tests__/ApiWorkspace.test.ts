import { describe, it, expect } from 'vitest';
import {
  parseHttpFile,
  serializeRequest,
  renderHttpFile,
  replaceRequestInSource,
  parseCurl,
  splitUrlQuery,
  joinUrlQuery,
  tokenizeCommand,
  parseCollection,
  serializeCollection,
  upsertNode,
  removeNode,
  childrenOf,
  emptyCollection,
  type WorkspaceRequest,
} from '../features/apiWorkspace';

function makeRequest(patch: Partial<WorkspaceRequest> = {}): WorkspaceRequest {
  return {
    id: 'req-1',
    name: '示例',
    method: 'GET',
    url: 'https://api.example.com/users',
    params: [],
    headers: [],
    auth: { type: 'none' },
    body: '',
    hasSeparator: true,
    ...patch,
  };
}

describe('parseHttpFile 解析 .http／.rest', () => {
  it('按 ### 分隔多个请求并保留块区间', () => {
    const source = [
      '### 列表',
      'GET https://api.example.com/users?page=2',
      'Accept: application/json',
      '',
      '### 创建',
      'POST https://api.example.com/users HTTP/1.1',
      'Content-Type: application/json',
      '',
      '{"name":"阿橦"}',
      '',
      '### 删除',
      'DELETE https://api.example.com/users/9',
    ].join('\n');
    const { requests } = parseHttpFile(source);
    expect(requests.map(r => r.name)).toEqual(['列表', '创建', '删除']);
    expect(requests[1].method).toBe('POST');
    expect(requests[1].url).toBe('https://api.example.com/users');
    expect(requests[1].headers[0].key).toBe('Content-Type');
    expect(requests[1].body).toBe('{"name":"阿橦"}');
    expect(requests[0].params).toHaveLength(1);
    expect(requests[0].params[0]).toMatchObject({ key: 'page', value: '2' });
    expect(requests[2].blockEnd).toBeLessThanOrEqual(12);
  });

  it('# @name 与 // @name 优先于 ### 标题', () => {
    const { requests } = parseHttpFile('### 旧标题\n# @name 新名字\nGET https://a/x');
    expect(requests[0].name).toBe('新名字');
    const slash = parseHttpFile('// @name 斜杠\nGET https://a/x');
    expect(slash.requests[0].name).toBe('斜杠');
  });

  it('只有 URL 的行按 GET，URL 尾斜杠与路径变量保留', () => {
    const { requests } = parseHttpFile('GET https://api.example.com/{{tenant}}/list');
    expect(requests[0].url).toBe('https://api.example.com/{{tenant}}/list');
    const bare = parseHttpFile('https://api.example.com/ping');
    expect(bare.requests[0].method).toBe('GET');
  });

  it('缩进的 ?／& 续行拼进 URL 并拆成 Query', () => {
    const { requests } = parseHttpFile(
      ['GET https://api.example.com/search', '   ?q=tongyun', '   &page=1'].join('\n'),
    );
    expect(requests[0].params.map(p => p.key)).toEqual(['q', 'page']);
    expect(joinUrlQuery(requests[0].url, requests[0].params)).toBe(
      'https://api.example.com/search?q=tongyun&page=1',
    );
  });

  it('注释与响应脚本不进入请求体', () => {
    const { requests } = parseHttpFile(
      [
        '// 这是注释',
        'POST https://api.example.com/orders',
        'Content-Type: application/json',
        '',
        '{"id":1}',
        '> {%',
        '  client.global.set("id", response.body.id);',
        '%}',
      ].join('\n'),
    );
    expect(requests[0].body).toBe('{"id":1}');
    expect(requests[0].headers.map(h => h.key)).toEqual(['Content-Type']);
  });

  it('缺空行的请求体给出告警但仍按正文读取', () => {
    const { requests, warnings } = parseHttpFile(
      ['### 缺空行', 'POST https://a/b', 'Content-Type: application/json', '{"k":1}'].join('\n'),
    );
    expect(requests[0].body).toBe('{"k":1}');
    expect(warnings.some(w => w.message.includes('缺少空行'))).toBe(true);
  });

  it('空请求块跳过并告警', () => {
    const { requests, warnings } = parseHttpFile('### 空的\n\n### 正常\nGET https://a/b');
    expect(requests).toHaveLength(1);
    expect(warnings[0].message).toContain('没有请求行');
  });

  it('Authorization 头收敛为 auth（Bearer 与 Basic）', () => {
    const bearer = parseHttpFile('GET https://a/b\nAuthorization: Bearer tok3n');
    expect(bearer.requests[0].auth).toEqual({ type: 'bearer', token: 'tok3n' });
    expect(bearer.requests[0].headers).toHaveLength(0);
    const basic = parseHttpFile(`GET https://a/b\nAuthorization: Basic ${btoa('admin:pw')}`);
    expect(basic.requests[0].auth).toEqual({ type: 'basic', username: 'admin', password: 'pw' });
  });

  it('带 BOM 与 CRLF 的文件同样可解析', () => {
    const { requests } = parseHttpFile('\uFEFF### 健康\r\nGET https://a/health\r\nAccept: */*\r\n');
    expect(requests[0].name).toBe('健康');
    expect(requests[0].headers[0].value).toBe('*/*');
  });

  it('外部文件请求体给出告警', () => {
    const { warnings } = parseHttpFile('POST https://a/b\nContent-Type: text/plain\n\n< ./payload.txt');
    expect(warnings.some(w => w.message.includes('外部文件'))).toBe(true);
  });
});

describe('用例文件写回', () => {
  it('序列化后重新解析得到等价请求', () => {
    const req = makeRequest({
      name: '创建用户',
      method: 'POST',
      params: [{ id: 'q1', key: 'verbose', value: 'true', enabled: true }],
      headers: [{ id: 'h1', key: 'Content-Type', value: 'application/json', enabled: true }],
      body: '{"name":"阿橦"}',
    });
    const parsed = parseHttpFile(serializeRequest(req));
    expect(parsed.requests[0]).toMatchObject({
      name: '创建用户',
      method: 'POST',
      url: 'https://api.example.com/users',
      body: '{"name":"阿橦"}',
    });
    expect(parsed.requests[0].params[0].key).toBe('verbose');
    expect(parsed.requests[0].headers[0].key).toBe('Content-Type');
  });

  it('整文件渲染与解析一致', () => {
    const file = renderHttpFile([makeRequest({ name: '一' }), makeRequest({ name: '二', method: 'PUT' })]);
    const parsed = parseHttpFile(file);
    expect(parsed.requests.map(r => [r.name, r.method])).toEqual([
      ['一', 'GET'],
      ['二', 'PUT'],
    ]);
  });

  it('写回只替换目标块，其余块逐字节不变', () => {
    const source = [
      '### 甲',
      'GET https://a/one',
      'X-Trace: keep-me',
      '',
      '### 乙',
      'POST https://a/two',
      'Content-Type: application/json',
      '',
      '{"v":1}',
      '',
      '### 丙',
      'DELETE https://a/three',
    ].join('\n');
    const { requests } = parseHttpFile(source);
    const target = requests[1];
    const updated: WorkspaceRequest = { ...target, name: '乙改', autoName: false, body: '{"v":2,"more":true}' };
    const next = replaceRequestInSource(source, target, updated);
    const reparsed = parseHttpFile(next);
    expect(reparsed.requests.map(r => r.name)).toEqual(['甲', '乙改', '丙']);
    expect(reparsed.requests[1].body).toBe('{"v":2,"more":true}');
    const srcLines = source.split('\n');
    const outLines = next.split('\n');
    expect(outLines.slice(0, 4)).toEqual(srcLines.slice(0, 4));
    expect(outLines.slice(-2)).toEqual(srcLines.slice(-2));
    expect(outLines.filter(l => l.startsWith('###'))).toEqual(['### 甲', '### 乙改', '### 丙']);
  });

  it('写回保持 CRLF 行尾', () => {
    const source = '### 甲\r\nGET https://a/one\r\n\r\n### 乙\r\nGET https://a/two\r\n';
    const { requests } = parseHttpFile(source);
    const next = replaceRequestInSource(source, requests[1], {
      ...requests[1],
      name: '乙新',
      autoName: false,
    });
    expect(next).toBe('### 甲\r\nGET https://a/one\r\n\r\n### 乙新\r\nGET https://a/two\r\n');
  });

  it('首个无分隔行的块用 @name 承载名字', () => {
    const source = 'GET https://a/one\nAccept: text/plain';
    const { requests } = parseHttpFile(source);
    const next = replaceRequestInSource(source, requests[0], {
      ...requests[0],
      name: '首页',
      autoName: false,
    });
    expect(next).toBe('# @name 首页\nGET https://a/one\nAccept: text/plain');
  });

  it('未命名的块写回不新增标题，只更新请求行', () => {
    const source = '### \nGET https://a/one\n';
    const { requests } = parseHttpFile(source);
    expect(requests[0].autoName).toBe(true);
    const next = replaceRequestInSource(source, requests[0], { ...requests[0], url: 'https://a/two' });
    expect(next).toBe('###\nGET https://a/two\n');
  });

  it('区间失效时明确报错，不静默写坏文件', () => {
    const source = '### 甲\nGET https://a/one';
    expect(() => replaceRequestInSource(source, { blockStart: 5, blockEnd: 9 }, makeRequest())).toThrow(
      /写回位置已失效/,
    );
  });
});

describe('splitUrlQuery／joinUrlQuery', () => {
  it('保留 {{var}} 与空值参数，不做编解码', () => {
    const { base, params } = splitUrlQuery('https://a/b?token={{token}}&flag&x=1');
    expect(base).toBe('https://a/b');
    expect(params.map(p => [p.key, p.value])).toEqual([
      ['token', '{{token}}'],
      ['flag', ''],
      ['x', '1'],
    ]);
    expect(joinUrlQuery(base, params)).toBe('https://a/b?token={{token}}&flag&x=1');
  });

  it('禁用参数不参与拼接', () => {
    const url = joinUrlQuery('https://a/b', [
      { id: '1', key: 'on', value: '1', enabled: true },
      { id: '2', key: 'off', value: '2', enabled: false },
    ]);
    expect(url).toBe('https://a/b?on=1');
  });
});

describe('cURL 导入', () => {
  it('分词支持单双引号、转义与续行', () => {
    expect(tokenizeCommand("curl -H 'a: 1' \\\n  \"b c\"")).toEqual(['curl', '-H', 'a: 1', 'b c']);
    expect(tokenizeCommand('curl "https://a/b?q=\\"x\\""')).toEqual(['curl', 'https://a/b?q="x"']);
  });

  it('标准命令解析出方法、Query、请求头与 JSON 体', () => {
    const parsed = parseCurl(
      "curl -X POST 'https://api.example.com/users?verbose=true' -H 'Content-Type: application/json' -H 'Accept: application/json' --data-raw '{\"name\":\"阿橦\"}'",
    );
    expect(parsed.method).toBe('POST');
    expect(parsed.url).toBe('https://api.example.com/users');
    expect(parsed.params).toEqual([expect.objectContaining({ key: 'verbose', value: 'true' })]);
    expect(parsed.headers.map(h => h.key)).toEqual(['Content-Type', 'Accept']);
    expect(parsed.body).toBe('{"name":"阿橦"}');
    expect(parsed.unrecognized).toEqual([]);
  });

  it('多行带反斜杠续行的浏览器复制命令', () => {
    const parsed = parseCurl(
      [
        "curl 'https://httpbin.org/anything?t=1' \\",
        '  -H "content-type: application/json" \\',
        "  -b 'sid=9; theme=dark' \\",
        '  --data-raw \'{"a":1,"b":2}\'',
      ].join('\n'),
    );
    expect(parsed.method).toBe('POST');
    expect(parsed.headers[0]).toMatchObject({ key: 'content-type', value: 'application/json' });
    expect(parsed.headers[1]).toMatchObject({ key: 'Cookie', value: 'sid=9; theme=dark' });
    expect(parsed.body).toBe('{"a":1,"b":2}');
  });

  it('Windows 复制的双引号命令按转义还原请求体', () => {
    const parsed = parseCurl(
      'curl "https://a/b?t=1" -X POST -H "Content-Type: application/json" --data-raw "{\\"a\\":1,\\"b\\":2}"',
    );
    expect(parsed.url).toBe('https://a/b');
    expect(parsed.params[0]).toMatchObject({ key: 't', value: '1' });
    expect(parsed.body).toBe('{"a":1,"b":2}');
  });

  it('无 -X 时按体与 -I 推断方法', () => {
    expect(parseCurl("curl -d 'a=1' https://a/b").method).toBe('POST');
    expect(parseCurl('curl -I https://a/b').method).toBe('HEAD');
    expect(parseCurl('curl https://a/b').method).toBe('GET');
  });

  it('多个 -d 拼成表单体', () => {
    const parsed = parseCurl("curl -d 'a=1' -d 'b=2' https://a/b");
    expect(parsed.body).toBe('a=1&b=2');
  });

  it('-G 把数据并入 Query 且保持 GET', () => {
    const parsed = parseCurl("curl -G -d 'q=tongyun' -d 'page=1' https://a/search");
    expect(parsed.method).toBe('GET');
    expect(parsed.url).toBe('https://a/search');
    expect(parsed.params.map(p => [p.key, p.value])).toEqual([
      ['q', 'tongyun'],
      ['page', '1'],
    ]);
    expect(parsed.body).toBe('');
  });

  it('--data-urlencode 与 --data-binary 语义', () => {
    expect(parseCurl("curl --data-urlencode 'note=hello world' https://a/b").body).toBe('note=hello%20world');
    const bin = parseCurl('curl --data-binary @payload.json https://a/b');
    expect(bin.body).toBe('');
    expect(bin.unrecognized.join(' ')).toContain('外部文件请求体不读取');
  });

  it('鉴权：Bearer 头、Basic 头与 -u 都收敛为 auth', () => {
    expect(parseCurl("curl -H 'Authorization: Bearer {{token}}' https://a/b").auth).toEqual({
      type: 'bearer',
      token: '{{token}}',
    });
    expect(parseCurl('curl -u alice:secret https://a/b').auth).toEqual({
      type: 'basic',
      username: 'alice',
      password: 'secret',
    });
    expect(
      parseCurl(`curl -H 'Authorization: Basic ${btoa('bob:pw')}' https://a/b`).auth,
    ).toEqual({ type: 'basic', username: 'bob', password: 'pw' });
  });

  it('-A／-e／--url／组合布尔标记与等号写法', () => {
    const parsed = parseCurl(
      "curl.exe -sSkL --compressed -A 'Studio/1.0' -e 'https://ref.example' --header=X-Trace:ok --url 'https://a/b?k=1'",
    );
    expect(parsed.method).toBe('GET');
    expect(parsed.url).toBe('https://a/b');
    expect(parsed.params[0].key).toBe('k');
    expect(parsed.headers.map(h => h.key)).toEqual(['User-Agent', 'Referer', 'X-Trace']);
    expect(parsed.unrecognized).toEqual([]);
  });

  it('已知忽略标记吞掉自身参数，未知标记进未识别清单', () => {
    const known = parseCurl('curl --resolve api.example:443:127.0.0.1 https://api/example');
    expect(known.url).toBe('https://api/example');
    expect(known.unrecognized).toEqual([]);
    const unknown = parseCurl('curl --zlib-support yes https://api/example');
    expect(unknown.url).toBe('https://api/example');
    expect(unknown.unrecognized).toContain('--zlib-support');
  });

  it('拒绝非 curl 输入', () => {
    expect(() => parseCurl('wget https://a/b')).toThrow(/curl 开头/);
    expect(() => parseCurl('   ')).toThrow(/粘贴/);
  });

  it('表单 -F 生成 multipart 体与类型', () => {
    const parsed = parseCurl("curl -F 'file=@a.txt' -F 'note=hi' https://a/upload");
    expect(parsed.method).toBe('POST');
    expect(parsed.body).toBe('file=@a.txt&note=hi');
    expect(parsed.headers.some(h => h.value === 'multipart/form-data')).toBe(true);
  });
});

describe('JSON 用例集', () => {
  it('空文本视为空集合，非法 JSON 与缺 nodes 明确报错', () => {
    expect(parseCollection('')).toEqual(emptyCollection());
    expect(() => parseCollection('{oops')).toThrow(/合法 JSON/);
    expect(() => parseCollection('{"version":1}')).toThrow(/nodes/);
  });

  it('忽略结构不完整的节点，保留可用节点', () => {
    const file = parseCollection(
      JSON.stringify({
        version: 1,
        nodes: [
          { id: 'f1', kind: 'folder', name: '用户', parentId: null },
          { id: 'c1', kind: 'case', name: '列表', parentId: 'f1', request: makeRequest() },
          { id: 'bad', kind: 'whatever', name: 'x', parentId: null },
        ],
      }),
    );
    expect(file.nodes.map(n => n.id)).toEqual(['f1', 'c1']);
    expect(serializeCollection(file).endsWith('\n')).toBe(true);
  });

  it('新增、覆盖与级联删除', () => {
    let file = emptyCollection();
    file = upsertNode(file, { id: 'f1', kind: 'folder', name: '用户', parentId: null });
    file = upsertNode(file, { id: 'c1', kind: 'case', name: '列表', parentId: 'f1', request: makeRequest() });
    file = upsertNode(file, { id: 'c1', kind: 'case', name: '列表改名', parentId: 'f1', request: makeRequest() });
    expect(file.nodes).toHaveLength(2);
    expect(childrenOf(file, 'f1')[0].name).toBe('列表改名');
    const pruned = removeNode(file, 'f1');
    expect(pruned.nodes).toEqual([]);
  });

  it('同级排序文件夹优先', () => {
    const file = parseCollection(
      JSON.stringify({
        version: 1,
        nodes: [
          { id: 'c', kind: 'case', name: 'aaa', parentId: null },
          { id: 'f', kind: 'folder', name: 'zzz', parentId: null },
        ],
      }),
    );
    expect(childrenOf(file, null).map(n => n.id)).toEqual(['f', 'c']);
  });
});
