/** API 工作台的纯解析与序列化逻辑：.http/.rest 双协议读写、cURL 导入、JSON 用例集。 */

export interface WorkspaceField {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

export type WorkspaceAuth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string };

export interface WorkspaceRequest {
  id: string;
  name: string;
  method: string;
  /** 不含 query 的地址；query 存在 params 里 */
  url: string;
  params: WorkspaceField[];
  headers: WorkspaceField[];
  auth: WorkspaceAuth;
  body: string;
  /** .http 文件内定位，用于写回 */
  line?: number;
  blockStart?: number;
  blockEnd?: number;
  /** 写回区间起点：有 `###` 时含分隔行 */
  regionStart?: number;
  hasSeparator?: boolean;
  /** 名字由方法+URL 合成，写回时不额外落名 */
  autoName?: boolean;
}

export interface ParseWarning {
  line: number;
  message: string;
}

export interface ParsedHttpFile {
  requests: WorkspaceRequest[];
  warnings: ParseWarning[];
}

const REQUEST_LINE = /^([A-Za-z][A-Za-z0-9-]*)\s+(\S+)(?:\s+HTTP\/\d+(?:\.\d+)?)?$/;
const URL_ONLY = /^(https?:\/\/\S+|\/\S*)$/i;
const HEADER_LINE = /^([^:\s]+)\s*:\s*(.*)$/;
const NAME_DIRECTIVE = /^(?:#|\/\/)\s*@name\s+(.+)$/;
const QUERY_CONTINUATION = /^\s+[?&]/;

let idSeed = 0;
export function nextWorkspaceId(prefix = 'ws'): string {
  idSeed += 1;
  return `${prefix}-${Date.now().toString(36)}-${idSeed}`;
}

interface SourceLine {
  line: number;
  text: string;
}

interface RawBlock {
  name: string;
  separatorIndex: number | null;
  start: number;
  end: number;
  lines: SourceLine[];
}

/** 检测行尾风格，写回时保持一致。 */
export function detectEol(source: string): string {
  const crlf = (source.match(/\r\n/g) || []).length;
  const lf = (source.match(/(^|[^\\r])\n/g) || []).length;
  return crlf > 0 && crlf >= lf ? '\r\n' : '\n';
}

/**
 * 解析 IntelliJ HTTP Client 的 .http / .rest 文本。
 * `###` 分隔请求；`# @name`／`// @name` 优先于 `###` 后面的标题；`{{var}}` 原样保留。
 * `< {% %}` 前置脚本与 `> {% %}` 响应脚本不进入请求体。
 */
export function parseHttpFile(source: string): ParsedHttpFile {
  const text = source.replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  const blocks = splitBlocks(lines);
  const requests: WorkspaceRequest[] = [];
  const warnings: ParseWarning[] = [];
  for (const block of blocks) {
    const parsed = parseBlock(block);
    warnings.push(...parsed.warnings);
    if (parsed.request) requests.push(parsed.request);
  }
  return { requests, warnings };
}

function splitBlocks(lines: string[]): RawBlock[] {
  const blocks: RawBlock[] = [];
  let separatorIndex: number | null = null;
  let name = '';
  let buffer: SourceLine[] = [];
  let start = 0;

  const flush = (end: number) => {
    const hasContent = buffer.some(l => l.text.trim() !== '' && !isComment(l.text)) || name.length > 0;
    if (hasContent) {
      blocks.push({ name, separatorIndex, start, end, lines: buffer });
    }
    buffer = [];
    name = '';
    separatorIndex = null;
  };

  lines.forEach((raw, index) => {
    const separator = raw.match(/^###\s*(.*)$/);
    if (separator) {
      flush(index);
      separatorIndex = index;
      name = separator[1].trim();
      start = index + 1;
      return;
    }
    buffer.push({ line: index + 1, text: raw });
  });
  flush(lines.length);
  return blocks;
}

function parseBlock(block: RawBlock): { request?: WorkspaceRequest; warnings: ParseWarning[] } {
  const warnings: ParseWarning[] = [];
  const cursor = { index: 0 };
  const directiveName = skipPreamble(block.lines, cursor);
  if (cursor.index >= block.lines.length) {
    warnings.push({
      line: block.lines[0]?.line ?? 1,
      message: block.name ? `请求「${block.name}」没有请求行` : '空请求块已跳过',
    });
    return { warnings };
  }

  const requestLine = block.lines[cursor.index];
  const parsedLine = parseRequestLine(requestLine.text.trim());
  if (!parsedLine) {
    warnings.push({ line: requestLine.line, message: `无法识别请求行：${requestLine.text.trim()}` });
    return { warnings };
  }
  cursor.index += 1;

  let urlText = parsedLine.url;
  while (cursor.index < block.lines.length && QUERY_CONTINUATION.test(block.lines[cursor.index].text)) {
    urlText += block.lines[cursor.index].text.trim();
    cursor.index += 1;
  }

  const headerRows: WorkspaceField[] = [];
  while (cursor.index < block.lines.length) {
    const current = block.lines[cursor.index];
    if (current.text.trim() === '') {
      cursor.index += 1;
      break;
    }
    if (isComment(current.text)) {
      cursor.index += 1;
      continue;
    }
    if (looksLikeBody(current.text)) {
      warnings.push({ line: current.line, message: '请求体前面缺少空行，这一行已按正文读取' });
      break;
    }
    const header = current.text.match(HEADER_LINE);
    if (!header) break;
    headerRows.push({
      id: nextWorkspaceId('h'),
      key: header[1].trim(),
      value: header[2].trim(),
      enabled: true,
    });
    cursor.index += 1;
  }

  const bodyLines: string[] = [];
  while (cursor.index < block.lines.length) {
    const current = block.lines[cursor.index];
    if (isResponseHandler(current.text)) {
      skipScriptFence(block.lines, cursor);
      continue;
    }
    bodyLines.push(current.text);
    cursor.index += 1;
  }
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === '') bodyLines.pop();

  const body = bodyLines.join('\n');
  if (/^<\s+\S+\s*$/.test(body)) {
    warnings.push({ line: requestLine.line, message: '不读取外部文件作为请求体' });
  }

  const { base, params } = splitUrlQuery(urlText);
  const { headers, auth } = extractAuth(headerRows);

  const explicitName = directiveName || block.name;
  return {
    request: {
      id: nextWorkspaceId('req'),
      name: explicitName || `${parsedLine.method} ${shorten(urlText)}`,
      method: parsedLine.method,
      url: base,
      params,
      headers,
      auth,
      body,
      line: requestLine.line,
      blockStart: block.start,
      blockEnd: block.end,
      regionStart: block.separatorIndex ?? block.start,
      hasSeparator: block.separatorIndex !== null,
      autoName: !explicitName,
    },
    warnings,
  };
}

function parseRequestLine(text: string): { method: string; url: string } | null {
  const named = text.match(REQUEST_LINE);
  if (named) return { method: named[1].toUpperCase(), url: named[2] };
  const urlOnly = text.match(URL_ONLY);
  if (urlOnly) return { method: 'GET', url: urlOnly[1] };
  return null;
}

function shorten(url: string): string {
  return url.length > 72 ? `${url.slice(0, 69)}…` : url;
}

function skipPreamble(lines: SourceLine[], cursor: { index: number }): string | null {
  let directiveName: string | null = null;
  while (cursor.index < lines.length) {
    const text = lines[cursor.index].text;
    const trimmed = text.trim();
    const named = trimmed.match(NAME_DIRECTIVE);
    if (named) {
      directiveName = named[1].trim();
      cursor.index += 1;
      continue;
    }
    if (trimmed === '' || isComment(text)) {
      cursor.index += 1;
      continue;
    }
    if (trimmed.startsWith('<')) {
      skipScriptFence(lines, cursor);
      continue;
    }
    break;
  }
  return directiveName;
}

function skipScriptFence(lines: SourceLine[], cursor: { index: number }) {
  const opening = lines[cursor.index]?.text ?? '';
  cursor.index += 1;
  if (opening.includes('{%') && !opening.includes('%}')) {
    while (cursor.index < lines.length && !lines[cursor.index].text.includes('%}')) cursor.index += 1;
    if (cursor.index < lines.length) cursor.index += 1;
  }
}

function isComment(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('//') || (trimmed.startsWith('#') && !trimmed.startsWith('###'));
}

function isResponseHandler(text: string): boolean {
  return text.trim().startsWith('>');
}

function looksLikeBody(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"');
}

/** 把 `a/b?x=1&y=2` 拆成 base 与 query 行；值不做 URL 解码，保留 `{{var}}`。 */
export function splitUrlQuery(rawUrl: string): { base: string; params: WorkspaceField[] } {
  const queryIndex = rawUrl.indexOf('?');
  if (queryIndex < 0) return { base: rawUrl, params: [] };
  const base = rawUrl.slice(0, queryIndex);
  const query = rawUrl.slice(queryIndex + 1);
  const params: WorkspaceField[] = [];
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    params.push({
      id: nextWorkspaceId('q'),
      key: eq < 0 ? pair : pair.slice(0, eq),
      value: eq < 0 ? '' : pair.slice(eq + 1),
      enabled: true,
    });
  }
  return { base, params };
}

/** 由 base + query 行还原 URL，保留原样字符串。 */
export function joinUrlQuery(base: string, params: WorkspaceField[]): string {
  const active = params.filter(p => p.enabled && p.key.trim() !== '');
  if (active.length === 0) return base;
  const query = active
    .map(p => (p.value === '' && !p.key.includes('=') ? p.key : `${p.key}=${p.value}`))
    .join('&');
  const delimiter = base.includes('?') ? '&' : '?';
  return `${base}${delimiter}${query}`;
}

/** Authorization 头收敛成 auth 结构，其余头原样保留。 */
export function extractAuth(headers: WorkspaceField[]): { headers: WorkspaceField[]; auth: WorkspaceAuth } {
  let auth: WorkspaceAuth = { type: 'none' };
  const rest: WorkspaceField[] = [];
  for (const header of headers) {
    const name = header.key.trim().toLowerCase();
    const value = header.value.trim();
    if (name === 'authorization' && /^bearer\s+\S/i.test(value)) {
      auth = { type: 'bearer', token: value.slice(value.indexOf(' ') + 1).trim() };
    } else if (name === 'authorization' && /^basic\s+\S/i.test(value)) {
      const decoded = decodeBasic(value.slice(value.indexOf(' ') + 1).trim());
      auth = decoded
        ? { type: 'basic', username: decoded.username, password: decoded.password }
        : { type: 'basic', username: '', password: value };
    } else {
      rest.push(header);
    }
  }
  return { headers: rest, auth };
}

function decodeBasic(encoded: string): { username: string; password: string } | null {
  try {
    const decoded = atob(encoded);
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}

export function authToHeader(auth: WorkspaceAuth): { key: string; value: string } | null {
  if (auth.type === 'bearer' && auth.token.trim()) {
    return { key: 'Authorization', value: `Bearer ${auth.token.trim()}` };
  }
  if (auth.type === 'basic' && (auth.username || auth.password)) {
    const raw = `${auth.username}:${auth.password}`;
    let encoded = '';
    try {
      encoded = btoa(raw);
    } catch {
      encoded = '';
    }
    return { key: 'Authorization', value: `Basic ${encoded}` };
  }
  return null;
}

/** 单个请求序列化成 .http 块文本（自动名不额外落名，分隔行仍保留）。 */
export function serializeRequest(req: WorkspaceRequest): string {
  const lines: string[] = [];
  const name = req.name.trim();
  if (name && !req.autoName) {
    lines.push(req.hasSeparator ? `### ${name}` : `# @name ${name}`);
  } else if (req.hasSeparator) {
    lines.push('###');
  }
  const url = joinUrlQuery(req.url.trim(), req.params);
  lines.push(`${req.method.toUpperCase()} ${url}`);
  const authHeader = authToHeader(req.auth);
  for (const header of req.headers.filter(h => h.enabled && h.key.trim())) {
    lines.push(`${header.key.trim()}: ${header.value.trim()}`);
  }
  if (authHeader && !req.headers.some(h => h.key.trim().toLowerCase() === 'authorization')) {
    lines.push(`${authHeader.key}: ${authHeader.value}`);
  }
  if (req.body.trim()) {
    lines.push('');
    lines.push(...req.body.replace(/\s+$/, '').split('\n'));
  }
  return lines.join('\n');
}

/** 新建文件时的整文件文本。 */
export function renderHttpFile(requests: WorkspaceRequest[]): string {
  if (requests.length === 0) return '';
  return requests.map(r => serializeRequest({ ...r, hasSeparator: true })).join('\n\n') + '\n';
}

/**
 * 写回源文件：只替换该请求自身占用的行区间（含其 `###` 分隔行），其余行逐字节保留。
 * 区间来自 parseHttpFile。
 */
export function replaceRequestInSource(
  source: string,
  req: Pick<WorkspaceRequest, 'blockStart' | 'blockEnd' | 'regionStart'>,
  updated: WorkspaceRequest,
): string {
  const eol = detectEol(source);
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  const start = req.regionStart ?? req.blockStart ?? 0;
  const end = req.blockEnd ?? start;
  if (start < 0 || end < start || end > lines.length) {
    throw new Error('写回位置已失效，请重新载入该用例文件');
  }
  const replacement = serializeRequest({
    ...updated,
    hasSeparator: (req.regionStart ?? req.blockStart ?? 0) !== (req.blockStart ?? 0),
  }).split('\n');
  const removed = lines.slice(start, end);
  let trailingBlank = 0;
  while (trailingBlank < removed.length && removed[removed.length - 1 - trailingBlank].trim() === '') {
    trailingBlank += 1;
  }
  for (let i = 0; i < trailingBlank; i += 1) replacement.push('');
  const merged = [...lines.slice(0, start), ...replacement, ...lines.slice(end)];
  return merged.join(eol);
}

/* ------------------------------- cURL ------------------------------- */

export interface ParsedCurl {
  method: string;
  url: string;
  params: WorkspaceField[];
  headers: WorkspaceField[];
  auth: WorkspaceAuth;
  body: string;
  unrecognized: string[];
}

interface FlagSpec {
  kind: 'value' | 'bool';
  field?: string;
}

const CURL_FLAGS: Record<string, FlagSpec> = {
  '-X': { kind: 'value', field: 'method' },
  '--request': { kind: 'value', field: 'method' },
  '-H': { kind: 'value', field: 'header' },
  '--header': { kind: 'value', field: 'header' },
  '-b': { kind: 'value', field: 'cookie' },
  '--cookie': { kind: 'value', field: 'cookie' },
  '-A': { kind: 'value', field: 'user-agent' },
  '--user-agent': { kind: 'value', field: 'user-agent' },
  '-e': { kind: 'value', field: 'referer' },
  '--referer': { kind: 'value', field: 'referer' },
  '-u': { kind: 'value', field: 'user' },
  '--user': { kind: 'value', field: 'user' },
  '--url': { kind: 'value', field: 'url' },
  '-d': { kind: 'value', field: 'data' },
  '--data': { kind: 'value', field: 'data' },
  '--data-raw': { kind: 'value', field: 'data' },
  '--data-ascii': { kind: 'value', field: 'data' },
  '--data-binary': { kind: 'value', field: 'data-binary' },
  '--data-urlencode': { kind: 'value', field: 'data-urlencode' },
  '--form': { kind: 'value', field: 'form' },
  '-F': { kind: 'value', field: 'form' },
  '--form-string': { kind: 'value', field: 'form' },
  '-G': { kind: 'bool', field: 'get' },
  '--get': { kind: 'bool', field: 'get' },
  '-I': { kind: 'bool', field: 'head' },
  '--head': { kind: 'bool', field: 'head' },
  '-s': { kind: 'bool' },
  '--silent': { kind: 'bool' },
  '-S': { kind: 'bool' },
  '--show-error': { kind: 'bool' },
  '-k': { kind: 'bool' },
  '--insecure': { kind: 'bool' },
  '-L': { kind: 'bool' },
  '--location': { kind: 'bool' },
  '--location-trusted': { kind: 'bool' },
  '-v': { kind: 'bool' },
  '--verbose': { kind: 'bool' },
  '-i': { kind: 'bool' },
  '--include': { kind: 'bool' },
  '--compressed': { kind: 'bool' },
  '-N': { kind: 'bool' },
  '--no-buffer': { kind: 'bool' },
  '--fail': { kind: 'bool' },
  '--fail-with-body': { kind: 'bool' },
  '-g': { kind: 'bool' },
  '--globoff': { kind: 'bool' },
  '--http1.1': { kind: 'bool' },
  '--http2': { kind: 'bool' },
  '--http2-prior-knowledge': { kind: 'bool' },
  '--ssl-no-revoke': { kind: 'bool' },
  '-j': { kind: 'bool' },
  '--junk-session-cookies': { kind: 'bool' },
  '--anyauth': { kind: 'bool' },
  '-o': { kind: 'value', field: 'ignore' },
  '--output': { kind: 'value', field: 'ignore' },
  '-m': { kind: 'value', field: 'ignore' },
  '--max-time': { kind: 'value', field: 'ignore' },
  '--connect-timeout': { kind: 'value', field: 'ignore' },
  '-w': { kind: 'value', field: 'ignore' },
  '--write-out': { kind: 'value', field: 'ignore' },
  '--resolve': { kind: 'value', field: 'ignore' },
  '-x': { kind: 'value', field: 'ignore' },
  '--proxy': { kind: 'value', field: 'ignore' },
  '--noproxy': { kind: 'value', field: 'ignore' },
  '--cacert': { kind: 'value', field: 'ignore' },
  '--cert': { kind: 'value', field: 'ignore' },
  '--key': { kind: 'value', field: 'ignore' },
  '-#': { kind: 'bool' },
  '--progress-bar': { kind: 'bool' },
  '--retry': { kind: 'value', field: 'ignore' },
  '--tlsv1.2': { kind: 'bool' },
  '--ciphers': { kind: 'value', field: 'ignore' },
  '--digest': { kind: 'bool' },
};

/** Shell 风格分词：支持单双引号、反斜杠续行与转义、`--flag=value`。 */
export function tokenizeCommand(input: string): string[] {
  const text = input.replace(/\\\r?\n/g, ' ').replace(/\n/g, ' ');
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let index = 0;

  const push = () => {
    if (started) tokens.push(current);
    current = '';
    started = false;
  };

  while (index < text.length) {
    const ch = text[index];
    if (ch === ' ' || ch === '\t') {
      push();
      index += 1;
      continue;
    }
    if (ch === "'") {
      started = true;
      index += 1;
      while (index < text.length && text[index] !== "'") {
        current += text[index];
        index += 1;
      }
      index += 1;
      continue;
    }
    if (ch === '"') {
      started = true;
      index += 1;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === '\\' && index + 1 < text.length && '"\\$`'.includes(text[index + 1])) {
          current += text[index + 1];
          index += 2;
          continue;
        }
        current += text[index];
        index += 1;
      }
      index += 1;
      continue;
    }
    if (ch === '\\' && index + 1 < text.length) {
      started = true;
      current += text[index + 1];
      index += 2;
      continue;
    }
    started = true;
    current += ch;
    index += 1;
  }
  push();
  return tokens;
}

function normalizeFlag(token: string): { flag: string; inlineValue: string | null; combo?: boolean } | null {
  if (!token.startsWith('-') || token === '-') return null;
  if (token.startsWith('--')) {
    const eq = token.indexOf('=');
    if (eq > 0) return { flag: token.slice(0, eq), inlineValue: token.slice(eq + 1) };
    return { flag: token, inlineValue: null };
  }
  // 短标记组合（如 -sS、-kL）：全部是已知布尔标记时整体忽略
  const body = token.slice(1);
  if (body.length > 1) {
    const allBool = [...body].every(c => CURL_FLAGS[`-${c}`]?.kind === 'bool');
    if (allBool) return { flag: token, inlineValue: null, combo: true };
    return { flag: `-${body[0]}`, inlineValue: body.slice(1) };
  }
  return { flag: token, inlineValue: null };
}

/** 解析 curl 命令：方法、URL、Query、请求头、鉴权与请求体。 */
export function parseCurl(input: string): ParsedCurl {
  const text = input.trim();
  if (!text) throw new Error('请粘贴 curl 命令');
  const allTokens = tokenizeCommand(text);
  const head = allTokens.findIndex(t => /^curl(?:\.exe)?$/i.test(t) || /\/curl$/i.test(t));
  if (head < 0) throw new Error('请输入以 curl 开头的命令');
  const tokens = allTokens.slice(head + 1);
  const headers: WorkspaceField[] = [];
  const dataParts: string[] = [];
  const formParts: string[] = [];
  const unrecognized: string[] = [];
  let methodFlag: string | null = null;
  let urlArg = '';
  let basicAuth: WorkspaceAuth | null = null;
  let useGet = false;
  let useHead = false;

  const takeValue = (i: number, inline: string | null): [string, number] => {
    if (inline !== null) return [inline, i];
    const next = tokens[i + 1];
    if (next === undefined) return ['', i];
    return [next, i + 1];
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const normalized = normalizeFlag(token);
    if (!normalized) {
      // 位置参数：第一个是 URL，多余的记为未识别
      if (!urlArg) urlArg = token;
      else unrecognized.push(token);
      continue;
    }
    if (normalized.combo) continue;
    const spec = CURL_FLAGS[normalized.flag];
    if (!spec) {
      unrecognized.push(normalized.flag);
      // 未知标记可能带值：吞掉下一个 token，避免被当成 URL
      if (normalized.inlineValue === null && tokens[i + 1] !== undefined && !tokens[i + 1].startsWith('-')) {
        i += 1;
      }
      continue;
    }
    if (spec.kind === 'bool') {
      if (spec.field === 'get') useGet = true;
      if (spec.field === 'head') useHead = true;
      continue;
    }
    const [value, consumed] = takeValue(i, normalized.inlineValue);
    i = consumed;
    switch (spec.field) {
      case 'method':
        methodFlag = value.trim().toUpperCase();
        break;
      case 'url':
        urlArg = value;
        break;
      case 'header': {
        const colon = value.indexOf(':');
        if (colon < 0) {
          unrecognized.push(`-H ${value}`);
          break;
        }
        const name = value.slice(0, colon).trim();
        const raw = value.slice(colon + 1).trim();
        if (/^authorization$/i.test(name) && /^bearer\s+\S/i.test(raw)) {
          headers.push({ id: nextWorkspaceId('h'), key: 'Authorization', value: raw, enabled: true });
        } else {
          headers.push({ id: nextWorkspaceId('h'), key: name, value: raw, enabled: true });
        }
        break;
      }
      case 'cookie':
        headers.push({ id: nextWorkspaceId('h'), key: 'Cookie', value, enabled: true });
        break;
      case 'user-agent':
        headers.push({ id: nextWorkspaceId('h'), key: 'User-Agent', value, enabled: true });
        break;
      case 'referer':
        headers.push({ id: nextWorkspaceId('h'), key: 'Referer', value, enabled: true });
        break;
      case 'user': {
        const colon = value.indexOf(':');
        basicAuth =
          colon < 0
            ? { type: 'basic', username: value, password: '' }
            : { type: 'basic', username: value.slice(0, colon), password: value.slice(colon + 1) };
        break;
      }
      case 'data':
      case 'data-binary':
        if (value.startsWith('@') || value.startsWith('<')) {
          unrecognized.push(`${normalized.flag} ${value}（外部文件请求体不读取）`);
        } else {
          dataParts.push(value);
        }
        break;
      case 'data-urlencode': {
        const eq = value.indexOf('=');
        if (eq > 0) dataParts.push(`${value.slice(0, eq)}=${encodeURIComponent(value.slice(eq + 1))}`);
        else dataParts.push(encodeURIComponent(value));
        break;
      }
      case 'form':
        formParts.push(value);
        break;
      default:
        break;
    }
  }

  const bodyFromData = dataParts.join('&');
  let body = bodyFromData;
  if (!body && formParts.length > 0) {
    body = formParts
      .map(part => {
        const eq = part.indexOf('=');
        return eq < 0 ? part : `${part.slice(0, eq)}=${part.slice(eq + 1)}`;
      })
      .join('&');
    if (!headers.some(h => /^content-type$/i.test(h.key.trim()))) {
      headers.push({
        id: nextWorkspaceId('h'),
        key: 'Content-Type',
        value: 'multipart/form-data',
        enabled: true,
      });
    }
  }

  let method = methodFlag ?? '';
  if (!method) {
    if (useHead) method = 'HEAD';
    else if (useGet) method = 'GET';
    else if (body) method = 'POST';
    else method = 'GET';
  }

  let rawUrl = urlArg;
  let params: WorkspaceField[];
  if (useGet && body) {
    const merged = rawUrl.includes('?') ? `${rawUrl}&${body}` : `${rawUrl}?${body}`;
    const split = splitUrlQuery(merged);
    rawUrl = split.base;
    params = split.params;
    body = '';
  } else {
    const split = splitUrlQuery(rawUrl);
    rawUrl = split.base;
    params = split.params;
  }

  const { headers: cleanHeaders, auth } = extractAuth(headers);

  return {
    method,
    url: rawUrl,
    params,
    headers: cleanHeaders,
    auth: basicAuth ?? auth,
    body,
    unrecognized,
  };
}

/* ---------------------------- 用例集合 ---------------------------- */

export interface CollectionNode {
  id: string;
  kind: 'folder' | 'case';
  name: string;
  parentId: string | null;
  request?: WorkspaceRequest;
}

export interface CollectionFile {
  version: 1;
  nodes: CollectionNode[];
}

export const COLLECTION_PATH = '.tongyun/api-collections.json';

export function emptyCollection(): CollectionFile {
  return { version: 1, nodes: [] };
}

export function serializeCollection(file: CollectionFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

export function parseCollection(text: string): CollectionFile {
  if (!text.trim()) return emptyCollection();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('用例集文件不是合法 JSON，已保留原文件不覆盖');
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as CollectionFile).nodes)) {
    throw new Error('用例集文件缺少 nodes 数组，已保留原文件不覆盖');
  }
  const nodes = (raw as CollectionFile).nodes.filter(
    n => n && typeof n.id === 'string' && (n.kind === 'folder' || n.kind === 'case') && typeof n.name === 'string',
  );
  return { version: 1, nodes };
}

export function upsertNode(file: CollectionFile, node: CollectionNode): CollectionFile {
  const exists = file.nodes.some(n => n.id === node.id);
  const nodes = exists
    ? file.nodes.map(n => (n.id === node.id ? node : n))
    : [...file.nodes, node];
  return { version: 1, nodes };
}

export function removeNode(file: CollectionFile, id: string): CollectionFile {
  const doomed = new Set<string>([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of file.nodes) {
      if (node.parentId && doomed.has(node.parentId) && !doomed.has(node.id)) {
        doomed.add(node.id);
        changed = true;
      }
    }
  }
  return { version: 1, nodes: file.nodes.filter(n => !doomed.has(n.id)) };
}

export function childrenOf(file: CollectionFile, parentId: string | null): CollectionNode[] {
  return file.nodes
    .filter(n => (n.parentId ?? null) === parentId)
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1));
}
