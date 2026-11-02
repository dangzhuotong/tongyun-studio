import { describe, it, expect } from 'vitest';
import type { HttpResponse } from '../contracts';
import {
  PUBLIC_ENV_FILE,
  PRIVATE_ENV_FILE,
  flattenVars,
  parseEnvPresets,
  mergeEnvPresets,
  loadEnvFiles,
  substitute,
  findMissingVars,
  getJsonPath,
  runAssertions,
  runExtractions,
  assertionLabel,
  type ApiAssertion,
  type ExtractRule,
} from '../features/apiEnv';

const response = (overrides: Partial<HttpResponse> = {}): HttpResponse => ({
  status: 200,
  statusText: 'OK',
  headers: [
    ['Content-Type', 'application/json'],
    ['X-Trace-Id', 'trace-9'],
  ],
  body: '{"code":0,"data":{"token":"tk-1","items":[{"id":7}]}}',
  latencyMs: 42,
  ...overrides,
});

const rule = (patch: Partial<ApiAssertion>): ApiAssertion => ({
  id: 'a1',
  kind: 'status',
  enabled: true,
  name: '',
  expected: '200',
  ...patch,
});

const extract = (patch: Partial<ExtractRule>): ExtractRule => ({
  id: 'x1',
  enabled: true,
  variable: 'token',
  source: 'body',
  path: 'data.token',
  ...patch,
});

describe('环境文件解析与摊平', () => {
  it('把嵌套对象摊成点号键，数字与布尔转成字符串', () => {
    expect(
      flattenVars({
        host: 'https://api.example.com',
        port: 8443,
        debug: true,
        auth: { token: 'abc', nested: { deep: 'yes' } },
      }),
    ).toEqual({
      host: 'https://api.example.com',
      port: '8443',
      debug: 'true',
      'auth.token': 'abc',
      'auth.nested.deep': 'yes',
    });
  });

  it('顶层键是环境名，非法 JSON 与非对象值返回空预设', () => {
    const presets = parseEnvPresets(
      '{"Development":{"baseUrl":"http://localhost:3000"},"Staging":{"baseUrl":"https://staging.example.com"},"broken":"not-an-object"}',
    );
    expect(presets.map(p => p.name)).toEqual(['Development', 'Staging']);
    expect(presets[1].vars).toEqual({ baseUrl: 'https://staging.example.com' });
    expect(parseEnvPresets('{oops')).toEqual([]);
    expect(parseEnvPresets('[1,2]')).toEqual([]);
    expect(parseEnvPresets(null)).toEqual([]);
  });

  it('private 覆盖同名公共变量，并补充仅存在于 private 的环境', () => {
    const merged = loadEnvFiles(
      '{"dev":{"baseUrl":"http://localhost","timeout":"30"},"prod":{"baseUrl":"https://prod"}}',
      '{"dev":{"baseUrl":"http://127.0.0.1:9000","token":"secret"}}',
    );
    expect(merged.map(p => p.name)).toEqual(['dev', 'prod']);
    expect(merged[0].vars).toEqual({
      baseUrl: 'http://127.0.0.1:9000',
      timeout: '30',
      token: 'secret',
    });
  });

  it('合并时保留双方环境且不互相污染', () => {
    const merged = mergeEnvPresets(
      [{ name: 'a', vars: { x: '1' } }],
      [{ name: 'b', vars: { y: '2' } }],
    );
    expect(merged).toEqual([
      { name: 'a', vars: { x: '1' } },
      { name: 'b', vars: { y: '2' } },
    ]);
  });

  it('环境文件名与 JetBrains HTTP Client 约定一致', () => {
    expect(PUBLIC_ENV_FILE).toBe('http-client.env.json');
    expect(PRIVATE_ENV_FILE).toBe('http-client.private.env.json');
  });
});

describe('变量插值与缺失告警', () => {
  const vars = { baseUrl: 'http://localhost:3000', token: 'tk-1' };

  it('替换 URL、请求头与请求体中的变量，容忍花括号内空格', () => {
    expect(substitute('{{ baseUrl }}/api/ping', vars).text).toBe('http://localhost:3000/api/ping');
    expect(substitute('Bearer {{token}}', vars).text).toBe('Bearer tk-1');
    expect(substitute('{"t":"{{token}}","u":"{{baseUrl}}"}', vars).text).toBe(
      '{"t":"tk-1","u":"http://localhost:3000"}',
    );
  });

  it('未定义变量原样保留并列出缺失名', () => {
    const result = substitute('{{baseUrl}}/{{missingHost}}/{{token}}', vars);
    expect(result.text).toBe('http://localhost:3000/{{missingHost}}/tk-1');
    expect(result.missing).toEqual(['missingHost']);
  });

  it('跨多个输入去重并排序缺失变量', () => {
    expect(
      findMissingVars(
        ['{{host}}/a?b={{secret}}', '{{host}}/b', 'no-vars', '{{token}}'],
        vars,
      ),
    ).toEqual(['host', 'secret']);
  });

  it('不替换非标识符形式的内容', () => {
    expect(substitute('{{ 1bad }}{{}}', vars)).toEqual({ text: '{{ 1bad }}{{}}', missing: [] });
  });
});

describe('JSON 路径读取', () => {
  it('支持点号与下标混写', () => {
    const data = JSON.parse(
      '{"code":0,"data":{"token":"tk-1","items":[{"id":7},{"id":9}],"none":null}}',
    );
    expect(getJsonPath(data, 'data.token')).toEqual({ found: true, value: 'tk-1' });
    expect(getJsonPath(data, 'data.items[1].id')).toEqual({ found: true, value: 9 });
    expect(getJsonPath(data, 'code')).toEqual({ found: true, value: 0 });
    expect(getJsonPath(data, 'data.none')).toEqual({ found: true, value: null });
    expect(getJsonPath(data, 'data.items[5]')).toEqual({ found: false, value: undefined });
    expect(getJsonPath(data, 'data.missing.deep')).toEqual({ found: false, value: undefined });
    expect(getJsonPath(data, '')).toEqual({ found: false, value: undefined });
  });
});

describe('断言引擎', () => {
  it('状态码断言支持逗号列表并给出原因', () => {
    const results = runAssertions(
      [rule({ expected: '200,201' }), rule({ id: 'a2', expected: '404,410' })],
      response(),
    );
    expect(results[0].passed).toBe(true);
    expect(results[0].actual).toBe('200');
    expect(results[1].passed).toBe(false);
    expect(results[1].reason).toContain('期望 404/410，实际 200');
  });

  it('时延断言按上限判定，非法表达式直接判失败', () => {
    expect(runAssertions([rule({ kind: 'latency', expected: '500' })], response())[0].passed).toBe(
      true,
    );
    const slow = runAssertions([rule({ kind: 'latency', expected: '10' })], response({ latencyMs: 900 }));
    expect(slow[0].passed).toBe(false);
    expect(slow[0].reason).toContain('超出上限');
    const broken = runAssertions([rule({ kind: 'latency', expected: 'abc' })], response());
    expect(broken[0].passed).toBe(false);
    expect(broken[0].reason).toContain('无效');
  });

  it('响应头断言忽略大小写，留空期望值时只判断存在', () => {
    const exists = runAssertions([rule({ kind: 'header', name: 'x-trace-id', expected: '' })], response());
    expect(exists[0].passed).toBe(true);
    expect(exists[0].actual).toBe('trace-9');
    const value = runAssertions(
      [rule({ kind: 'header', name: 'Content-Type', expected: 'application/json' })],
      response(),
    );
    expect(value[0].passed).toBe(true);
    const missing = runAssertions([rule({ kind: 'header', name: 'X-Nope', expected: '' })], response());
    expect(missing[0].passed).toBe(false);
    expect(missing[0].reason).toContain('响应缺少请求头 X-Nope');
    const noName = runAssertions([rule({ kind: 'header', name: '  ' })], response());
    expect(noName[0].passed).toBe(false);
    expect(noName[0].reason).toContain('缺少 Header 名称');
  });

  it('JSON 字段断言做数字与字符串比较，并报告路径缺失与非 JSON', () => {
    const numeric = runAssertions([rule({ kind: 'json', name: 'code', expected: '0' })], response());
    expect(numeric[0].passed).toBe(true);
    const token = runAssertions([rule({ kind: 'json', name: 'data.token', expected: 'tk-1' })], response());
    expect(token[0].passed).toBe(true);
    const wrong = runAssertions([rule({ kind: 'json', name: 'data.token', expected: 'tk-2' })], response());
    expect(wrong[0].passed).toBe(false);
    expect(wrong[0].actual).toBe('tk-1');
    const objectValue = runAssertions(
      [rule({ kind: 'json', name: 'data.items[0]', expected: '{"id":7}' })],
      response(),
    );
    expect(objectValue[0].passed).toBe(true);
    const absent = runAssertions([rule({ kind: 'json', name: 'data.nope', expected: '' })], response());
    expect(absent[0].passed).toBe(false);
    expect(absent[0].reason).toContain('不存在字段路径 data.nope');
    const notJson = runAssertions(
      [rule({ kind: 'json', name: 'data', expected: '' })],
      response({ body: 'plain text' }),
    );
    expect(notJson[0].passed).toBe(false);
    expect(notJson[0].reason).toContain('不是合法 JSON');
  });

  it('只评估启用的规则，标签描述可读', () => {
    const results = runAssertions(
      [rule({ enabled: false }), rule({ id: 'a2', kind: 'latency', expected: '500' })],
      response(),
    );
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('a2');
    expect(assertionLabel('status', '', '200,201')).toBe('状态码等于 200,201');
    expect(assertionLabel('latency', '', '500')).toBe('响应时延 ≤ 500 ms');
    expect(assertionLabel('header', 'X-A', '')).toBe('响应头 X-A 存在');
    expect(assertionLabel('json', 'data.code', '0')).toBe('data.code = 0');
  });
});

describe('变量提取', () => {
  it('从响应体 JSON 路径提取并给出写入的变量名', () => {
    const results = runExtractions([extract({})], response());
    expect(results[0]).toMatchObject({
      variable: 'token',
      value: 'tk-1',
      source: 'body',
      reason: '已提取 data.token → {{token}}',
    });
  });

  it('从响应头提取，并把对象值序列化为 JSON', () => {
    const fromHeader = runExtractions(
      [extract({ variable: 'trace', source: 'header', path: 'x-trace-id' })],
      response(),
    );
    expect(fromHeader[0].value).toBe('trace-9');
    const objectValue = runExtractions([extract({ variable: 'first', path: 'data.items[0]' })], response());
    expect(objectValue[0].value).toBe('{"id":7}');
  });

  it('路径缺失、非 JSON、空值与缺字段都记为未更新', () => {
    const absent = runExtractions([extract({ path: 'data.nope' })], response());
    expect(absent[0].value).toBeNull();
    expect(absent[0].reason).toContain('变量 token 未更新');
    const nullish = runExtractions([extract({ path: 'data.none' })], response({ body: '{"data":{"none":null}}' }));
    expect(nullish[0].value).toBeNull();
    const notJson = runExtractions([extract({})], response({ body: 'oops' }));
    expect(notJson[0].reason).toContain('不是合法 JSON');
    const noVar = runExtractions([extract({ variable: '  ' })], response());
    expect(noVar[0].reason).toContain('缺少目标变量名');
    const noPath = runExtractions([extract({ path: '' })], response());
    expect(noPath[0].reason).toContain('缺少字段路径');
    expect(runExtractions([extract({ enabled: false })], response())).toHaveLength(0);
  });
});
