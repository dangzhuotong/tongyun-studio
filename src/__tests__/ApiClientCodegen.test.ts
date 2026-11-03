import { describe, it, expect } from 'vitest';
import { CODE_TARGETS, generateRequestCode, type CodegenRequest } from '../features/apiCodegen';

const basic: CodegenRequest = {
  method: 'POST',
  url: 'https://api.example.com/v1/login?a=1',
  headers: [
    ['Content-Type', 'application/json'],
    ['Accept', 'application/json'],
  ],
  body: '{"user":"abc","pass":"p@ss"}',
};

const targets = CODE_TARGETS.map(t => t.id);

describe('多语言代码生成入口', () => {
  it('提供 6 种以上语言与可读标签', () => {
    expect(targets.length).toBeGreaterThanOrEqual(6);
    expect(targets).toEqual(['curl', 'jsFetch', 'jsAxios', 'pyRequests', 'pyHttpx', 'go', 'rust']);
    expect(CODE_TARGETS.map(t => t.label)).toEqual([
      'cURL',
      'JavaScript Fetch',
      'Axios',
      'Python requests',
      'Python httpx',
      'Go net/http',
      'Rust reqwest',
    ]);
  });

  it('每种语言都带上方法、地址、请求头与请求体', () => {
    for (const target of targets) {
      const code = generateRequestCode(target, basic);
      expect(code, target).toContain('api.example.com/v1/login?a=1');
      expect(code, target).toContain('Content-Type');
      expect(code, target).toContain('application/json');
      expect(code.toLowerCase(), target).toContain('post');
    }
  });
});

describe('逐语言输出', () => {
  it('cURL 用单引号包裹并对内部单引号做 shell 转义', () => {
    const code = generateRequestCode('curl', {
      method: 'GET',
      url: "https://api.example.com/q?x=it's",
      headers: [['Authorization', "Bearer 'quoted'"]],
    });
    expect(code).toContain("curl -X GET 'https://api.example.com/q?x=it'\\''s'");
    expect(code).toContain("-H 'Authorization: Bearer '\\''quoted'\\'''");
    expect(code).not.toContain('--data');
  });

  it('cURL 多行续行，最后一个参数不带续行符', () => {
    const lines = generateRequestCode('curl', basic).split('\n');
    expect(lines[0]).toBe("curl -X POST 'https://api.example.com/v1/login?a=1' \\");
    expect(lines[1]).toBe("  -H 'Content-Type: application/json' \\");
    expect(lines[2]).toBe("  -H 'Accept: application/json' \\");
    expect(lines[3]).toBe(`  --data '{"user":"abc","pass":"p@ss"}'`);
  });

  it('JavaScript Fetch 生成配对括号与字符串字面量', () => {
    const code = generateRequestCode('jsFetch', basic);
    expect(code).toContain('const response = await fetch({');
    expect(code).toContain('    method: "POST",');
    expect(code).toContain('    url: "https://api.example.com/v1/login?a=1",');
    expect(code).toContain('        "Content-Type": "application/json",');
    expect(code).toContain('    body: "{\\"user\\":\\"abc\\",\\"pass\\":\\"p@ss\\"}",');
    expect(code).toContain('const text = await response.text();');
    expect(code.match(/\{/g)?.length).toBe(code.match(/\}/g)?.length);
  });

  it('Axios 用小写方法名并把请求体放进 data', () => {
    const code = generateRequestCode('jsAxios', basic);
    expect(code).toContain("import axios from 'axios';");
    expect(code).toContain('    method: "post",');
    expect(code).toContain('    data: "{\\"user\\":\\"abc\\",\\"pass\\":\\"p@ss\\"}",');
    expect(code).toContain('console.log(response.status, response.data);');
    expect(code.match(/\{/g)?.length).toBe(code.match(/\}/g)?.length);
  });

  it('无请求头与请求体时不生成多余字段', () => {
    const bare: CodegenRequest = { method: 'DELETE', url: 'https://api.example.com/x/1', headers: [] };
    const fetch = generateRequestCode('jsFetch', bare);
    expect(fetch).not.toContain('headers:');
    expect(fetch).not.toContain('body:');
    expect(generateRequestCode('jsAxios', bare)).not.toContain('data:');
    expect(generateRequestCode('pyRequests', bare)).not.toContain('headers=');
  });

  it('Python requests 用 data，httpx 用 content 并缩进在 with 块内', () => {
    const requests = generateRequestCode('pyRequests', basic);
    expect(requests).toContain('import requests');
    expect(requests).toContain('response = requests.request(');
    expect(requests).toContain('    "POST",');
    expect(requests).toContain('        "Content-Type": "application/json",');
    expect(requests).toContain('    data="{\\"user\\":\\"abc\\",\\"pass\\":\\"p@ss\\"}",');
    expect(requests).toContain('print(response.status_code, response.text)');
    const httpx = generateRequestCode('pyHttpx', basic);
    expect(httpx).toContain('with httpx.Client() as client:');
    expect(httpx).toContain('    response = client.request(');
    expect(httpx).toContain('        content="{\\"user\\":\\"abc\\",\\"pass\\":\\"p@ss\\"}",');
    expect(httpx).toContain('    )');
  });

  it('Python 保留中文字面量并转义换行', () => {
    const code = generateRequestCode('pyRequests', {
      method: 'PUT',
      url: 'https://api.example.com/notes',
      headers: [],
      body: '两行\n文本',
    });
    expect(code).toContain('    data="两行\\n文本",');
    const httpx = generateRequestCode('pyHttpx', {
      method: 'PUT',
      url: 'https://api.example.com/notes',
      headers: [],
      body: '中文',
    });
    expect(httpx).toContain('        content="中文",');
  });

  it('Go 用原始字符串与 strings.NewReader，无请求体时传 nil', () => {
    const code = generateRequestCode('go', basic);
    expect(code).toContain('package main');
    expect(code).toContain('http.NewRequest(`POST`, `https://api.example.com/v1/login?a=1`, strings.NewReader(`{"user":"abc","pass":"p@ss"}`))');
    expect(code).toContain('\treq.Header.Set(`Content-Type`, `application/json`)');
    expect(code.indexOf('"fmt"')).toBeLessThan(code.indexOf('"strings"'));
    const get = generateRequestCode('go', { method: 'GET', url: 'https://x/', headers: [] });
    expect(get).not.toContain('"strings"');
    expect(get).toContain('http.NewRequest(`GET`, `https://x/`, nil)');
    expect(get.match(/\{/g)?.length).toBe(get.match(/\}/g)?.length);
  });

  it('Go 原始字符串承载多行请求体，含反引号时退回双引号转义', () => {
    const raw = generateRequestCode('go', {
      method: 'POST',
      url: 'https://x/',
      headers: [['X-Note', 'plain']],
      body: 'line1\nline2',
    });
    expect(raw).toContain('strings.NewReader(`line1\nline2`)');
    const quoted = generateRequestCode('go', {
      method: 'POST',
      url: 'https://x/',
      headers: [['X-Note', 'a`b']],
      body: 'a`b"c',
    });
    expect(quoted).toContain('req.Header.Set(`X-Note`, "a`b")');
    expect(quoted).toContain('strings.NewReader("a`b\\"c")');
  });

  it('Rust 用 reqwest blocking 链式构造请求', () => {
    const code = generateRequestCode('rust', basic);
    expect(code).toContain('use reqwest::blocking::Client;');
    expect(code).toContain(
      '        .request(reqwest::Method::from_bytes(b"POST")?, "https://api.example.com/v1/login?a=1")',
    );
    expect(code).toContain('        .header("Content-Type", "application/json")');
    expect(code).toContain('        .body("{\\"user\\":\\"abc\\",\\"pass\\":\\"p@ss\\"}")');
    expect(code).toContain('        .send()?');
    expect(code).toContain('    let text = response.text()?;');
    expect(code.match(/\{/g)?.length).toBe(code.match(/\}/g)?.length);
  });

  it('Rust 转义引号、反斜杠、换行与控制字符', () => {
    const code = generateRequestCode('rust', {
      method: 'GET',
      url: 'https://x/',
      headers: [
        ['X-Q', 'a"b\\c'],
        ['X-C', String.fromCharCode(1) + 'plain'],
      ],
      body: '两行\n文本',
    });
    expect(code).toContain('.header("X-Q", "a\\"b\\\\c")');
    expect(code).toContain('.header("X-C", "' + String.fromCharCode(92) + 'u{1}plain")');
    expect(code).toContain('.body("两行\\n文本")');
  });
});
