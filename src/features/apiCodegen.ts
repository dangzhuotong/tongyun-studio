export interface CodegenRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body?: string;
}

export type CodeTarget =
  | 'curl'
  | 'jsFetch'
  | 'jsAxios'
  | 'pyRequests'
  | 'pyHttpx'
  | 'go'
  | 'rust';

export const CODE_TARGETS: { id: CodeTarget; label: string; hint: string }[] = [
  { id: 'curl', label: 'cURL', hint: 'shell' },
  { id: 'jsFetch', label: 'JavaScript Fetch', hint: 'browser' },
  { id: 'jsAxios', label: 'Axios', hint: 'node' },
  { id: 'pyRequests', label: 'Python requests', hint: 'python' },
  { id: 'pyHttpx', label: 'Python httpx', hint: 'python' },
  { id: 'go', label: 'Go net/http', hint: 'go' },
  { id: 'rust', label: 'Rust reqwest', hint: 'rust' },
];

function shSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function jsStr(value: string): string {
  return JSON.stringify(value);
}

function pyStr(value: string): string {
  return JSON.stringify(value);
}

function goStr(value: string): string {
  if (!value.includes('`')) return '`' + value + '`';
  return `"${value
    .replace(/[\\"]/g, '\\$&')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`;
}

function rustStr(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20) out += `\\u{${code.toString(16)}}`;
    else out += ch;
  }
  return out + '"';
}

function bodyOf(request: CodegenRequest): string | undefined {
  return typeof request.body === 'string' && request.body.length > 0 ? request.body : undefined;
}

function generateCurl(request: CodegenRequest): string {
  const lines = [`curl -X ${request.method} ${shSingle(request.url)}`];
  for (const [key, value] of request.headers) {
    lines.push(`  -H ${shSingle(`${key}: ${value}`)}`);
  }
  const body = bodyOf(request);
  if (body !== undefined) {
    lines.push(`  --data ${shSingle(body)}`);
  }
  return lines.join(' \\\n');
}

function dictJs(pairs: [string, string][], pad: string): string {
  if (pairs.length === 0) return '{}';
  const close = pad.slice(0, Math.max(0, pad.length - 2));
  const rows = pairs.map(([k, v]) => `\n${pad}${jsStr(k)}: ${jsStr(v)},`).join('');
  return `{${rows}\n${close}}`;
}

function dictPy(pairs: [string, string][], pad: string): string {
  if (pairs.length === 0) return '{}';
  const close = pad.slice(0, Math.max(0, pad.length - 4));
  const rows = pairs.map(([k, v]) => `\n${pad}${pyStr(k)}: ${pyStr(v)},`).join('');
  return `{${rows}\n${close}}`;
}

function generateFetch(request: CodegenRequest): string {
  const lines = [
    'const response = await fetch({',
    `    method: ${jsStr(request.method)},`,
    `    url: ${jsStr(request.url)},`,
  ];
  if (request.headers.length > 0) {
    lines.push(`    headers: ${dictJs(request.headers, '        ')},`);
  }
  const body = bodyOf(request);
  if (body !== undefined) {
    lines.push(`    body: ${jsStr(body)},`);
  }
  lines.push('});', '', 'const text = await response.text();', 'console.log(response.status, text);');
  return lines.join('\n');
}

function generateAxios(request: CodegenRequest): string {
  const lines = [
    "import axios from 'axios';",
    '',
    'const response = await axios({',
    `    method: ${jsStr(request.method.toLowerCase())},`,
    `    url: ${jsStr(request.url)},`,
  ];
  if (request.headers.length > 0) {
    lines.push(`    headers: ${dictJs(request.headers, '        ')},`);
  }
  const body = bodyOf(request);
  if (body !== undefined) {
    lines.push(`    data: ${jsStr(body)},`);
  }
  lines.push('});', '', 'console.log(response.status, response.data);');
  return lines.join('\n');
}

function generatePyRequests(request: CodegenRequest): string {
  const lines = [
    'import requests',
    '',
    'response = requests.request(',
    `    ${pyStr(request.method)},`,
    `    ${pyStr(request.url)},`,
  ];
  if (request.headers.length > 0) {
    lines.push(`    headers=${dictPy(request.headers, '        ')},`);
  }
  const body = bodyOf(request);
  if (body !== undefined) {
    lines.push(`    data=${pyStr(body)},`);
  }
  lines.push(')', '', 'print(response.status_code, response.text)');
  return lines.join('\n');
}

function generatePyHttpx(request: CodegenRequest): string {
  const lines = [
    'import httpx',
    '',
    'with httpx.Client() as client:',
    '    response = client.request(',
    `        ${pyStr(request.method)},`,
    `        ${pyStr(request.url)},`,
  ];
  if (request.headers.length > 0) {
    lines.push(`        headers=${dictPy(request.headers, '            ')},`);
  }
  const body = bodyOf(request);
  if (body !== undefined) {
    lines.push(`        content=${pyStr(body)},`);
  }
  lines.push('    )', '', 'print(response.status_code, response.text)');
  return lines.join('\n');
}

function generateGo(request: CodegenRequest): string {
  const body = bodyOf(request);
  const imports = ['"fmt"', '"io"', '"net/http"'];
  if (body !== undefined) imports.push('"strings"');
  const lines = [
    'package main',
    '',
    'import (',
    ...imports.map(name => `\t${name}`),
    ')',
    '',
    'func main() {',
    `\treq, err := http.NewRequest(${goStr(request.method)}, ${goStr(request.url)}, ${
      body !== undefined ? `strings.NewReader(${goStr(body)})` : 'nil'
    })`,
    '\tif err != nil {',
    '\t\tpanic(err)',
    '\t}',
  ];
  for (const [key, value] of request.headers) {
    lines.push(`\treq.Header.Set(${goStr(key)}, ${goStr(value)})`);
  }
  lines.push(
    '\tresp, err := http.DefaultClient.Do(req)',
    '\tif err != nil {',
    '\t\tpanic(err)',
    '\t}',
    '\tdefer resp.Body.Close()',
    '\tdata, err := io.ReadAll(resp.Body)',
    '\tif err != nil {',
    '\t\tpanic(err)',
    '\t}',
    '\tfmt.Println(resp.Status, string(data))',
    '}',
  );
  return lines.join('\n');
}

function generateRust(request: CodegenRequest): string {
  const lines = [
    'use reqwest::blocking::Client;',
    '',
    'fn main() -> Result<(), Box<dyn std::error::Error>> {',
    '    let client = Client::new();',
    '    let response = client',
    `        .request(reqwest::Method::from_bytes(b${jsStr(request.method)})?, ${rustStr(request.url)})`,
  ];
  for (const [key, value] of request.headers) {
    lines.push(`        .header(${rustStr(key)}, ${rustStr(value)})`);
  }
  const body = bodyOf(request);
  if (body !== undefined) {
    lines.push(`        .body(${rustStr(body)})`);
  }
  lines.push(
    '        .send()?',
    '    let status = response.status();',
    '    let text = response.text()?;',
    '    println!("{} {}", status, text);',
    '    Ok(())',
    '}',
  );
  return lines.join('\n');
}

export function generateRequestCode(target: CodeTarget, request: CodegenRequest): string {
  switch (target) {
    case 'curl':
      return generateCurl(request);
    case 'jsFetch':
      return generateFetch(request);
    case 'jsAxios':
      return generateAxios(request);
    case 'pyRequests':
      return generatePyRequests(request);
    case 'pyHttpx':
      return generatePyHttpx(request);
    case 'go':
      return generateGo(request);
    case 'rust':
      return generateRust(request);
  }
}
