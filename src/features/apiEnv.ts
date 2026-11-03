import type { HttpResponse } from '../contracts';

export const PUBLIC_ENV_FILE = 'http-client.env.json';
export const PRIVATE_ENV_FILE = 'http-client.private.env.json';

export interface EnvPreset {
  name: string;
  vars: Record<string, string>;
}

export interface EnvFileContents {
  publicJson?: string | null;
  privateJson?: string | null;
}

const VARIABLE = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function flattenVars(value: unknown, prefix = ''): Record<string, string> {
  if (isPlainObject(value)) {
    const out: Record<string, string> = {};
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof child === 'string') out[path] = child;
      else if (typeof child === 'number' || typeof child === 'boolean') out[path] = String(child);
      else Object.assign(out, flattenVars(child, path));
    }
    return out;
  }
  return {};
}

export function parseEnvPresets(content: string | null | undefined): EnvPreset[] {
  if (!content || !content.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (!isPlainObject(parsed)) return [];
  return Object.entries(parsed)
    .filter(([, value]) => isPlainObject(value))
    .map(([name, value]) => ({ name, vars: flattenVars(value) }));
}

export function mergeEnvPresets(
  publicPresets: EnvPreset[],
  privatePresets: EnvPreset[],
): EnvPreset[] {
  const names: string[] = [];
  const byName = new Map<string, Record<string, string>>();
  const put = (preset: EnvPreset, override: boolean) => {
    if (!byName.has(preset.name)) {
      byName.set(preset.name, {});
      names.push(preset.name);
    }
    const target = byName.get(preset.name)!;
    for (const [key, value] of Object.entries(preset.vars)) {
      if (override || !(key in target)) target[key] = value;
    }
  };
  for (const preset of publicPresets) put(preset, false);
  for (const preset of privatePresets) put(preset, true);
  return names.map(name => ({ name, vars: byName.get(name)! }));
}

export function loadEnvFiles(
  publicContent: string | null | undefined,
  privateContent: string | null | undefined,
): EnvPreset[] {
  return mergeEnvPresets(parseEnvPresets(publicContent), parseEnvPresets(privateContent));
}

export interface SubstitutionResult {
  text: string;
  missing: string[];
}

export function substitute(input: string, vars: Record<string, string>): SubstitutionResult {
  const missing: string[] = [];
  const text = input.replace(VARIABLE, (raw, name: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
    if (!missing.includes(name)) missing.push(name);
    return raw;
  });
  return { text, missing };
}

export function findMissingVars(inputs: string[], vars: Record<string, string>): string[] {
  const missing: string[] = [];
  for (const input of inputs) {
    for (const name of substitute(input, vars).missing) {
      if (!missing.includes(name)) missing.push(name);
    }
  }
  return missing.sort();
}

export function getJsonPath(data: unknown, path: string): { found: boolean; value: unknown } {
  const segments = path
    .split('.')
    .flatMap(seg => seg.split(/\[(\d*)\]/).filter(part => part !== ''))
    .filter(Boolean);
  if (segments.length === 0) return { found: false, value: undefined };
  let current: unknown = data;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { found: false, value: undefined };
      }
      current = current[index];
      continue;
    }
    if (!isPlainObject(current)) return { found: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false, value: undefined };
    }
    current = current[segment];
  }
  return { found: true, value: current };
}

export function readResponseHeader(response: HttpResponse, name: string): string | null {
  const wanted = name.trim().toLowerCase();
  for (const [key, value] of response.headers) {
    if (key.toLowerCase() === wanted) return value;
  }
  return null;
}

export function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export type AssertionKind = 'status' | 'latency' | 'header' | 'json';

export interface ApiAssertion {
  id: string;
  kind: AssertionKind;
  enabled: boolean;
  name: string;
  expected: string;
}

export interface AssertionResult {
  id: string;
  kind: AssertionKind;
  label: string;
  passed: boolean;
  actual: string;
  reason: string;
}

const ASSERTION_LABEL: Record<AssertionKind, string> = {
  status: '状态码',
  latency: '响应时延',
  header: '响应头',
  json: 'JSON 字段',
};

export function assertionLabel(kind: AssertionKind, name: string, expected: string): string {
  switch (kind) {
    case 'status':
      return `状态码等于 ${expected.trim() || '?'}`;
    case 'latency':
      return `响应时延 ≤ ${expected.trim() || '?'} ms`;
    case 'header':
      return expected.trim()
        ? `响应头 ${name.trim() || '?'} = ${expected.trim()}`
        : `响应头 ${name.trim() || '?'} 存在`;
    case 'json':
      return expected.trim()
        ? `${name.trim() || '?'} = ${expected.trim()}`
        : `${name.trim() || '?'} 存在`;
  }
}

export function runAssertions(rules: ApiAssertion[], response: HttpResponse): AssertionResult[] {
  const results: AssertionResult[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const label = assertionLabel(rule.kind, rule.name, rule.expected);
    results.push({
      id: rule.id,
      kind: rule.kind,
      label,
      ...evaluateAssertion(rule, response),
    });
  }
  return results;
}

function evaluateAssertion(
  rule: ApiAssertion,
  response: HttpResponse,
): Omit<AssertionResult, 'id' | 'kind' | 'label'> {
  const expected = rule.expected.trim();
  switch (rule.kind) {
    case 'status': {
      const allowed = expected
        .split(/[,，\s]+/)
        .filter(Boolean)
        .map(Number);
      if (allowed.length === 0 || allowed.some(code => !Number.isInteger(code))) {
        return {
          passed: false,
          actual: String(response.status),
          reason: `状态码断言表达式无效：${expected || '(空)'}`,
        };
      }
      const passed = allowed.includes(response.status);
      return {
        passed,
        actual: String(response.status),
        reason: passed
          ? `${response.status} 命中期望集合 ${allowed.join('/')}`
          : `${ASSERTION_LABEL[rule.kind]} 期望 ${allowed.join('/')}，实际 ${response.status}`,
      };
    }
    case 'latency': {
      const limit = Number(expected);
      if (!expected || !Number.isFinite(limit) || limit < 0) {
        return {
          passed: false,
          actual: `${response.latencyMs} ms`,
          reason: `时延断言表达式无效：${expected || '(空)'}`,
        };
      }
      const passed = response.latencyMs <= limit;
      return {
        passed,
        actual: `${response.latencyMs} ms`,
        reason: passed
          ? `${response.latencyMs} ms 在 ${limit} ms 上限内`
          : `响应时延 ${response.latencyMs} ms 超出上限 ${limit} ms`,
      };
    }
    case 'header': {
      const name = rule.name.trim();
      if (!name) {
        return {
          passed: false,
          actual: '(未填写)',
          reason: '响应头断言缺少 Header 名称',
        };
      }
      const value = readResponseHeader(response, name);
      if (value === null) {
        return {
          passed: false,
          actual: '(缺失)',
          reason: `响应缺少请求头 ${name}`,
        };
      }
      if (!expected) {
        return { passed: true, actual: value, reason: `响应头 ${name} 存在` };
      }
      const passed = value.trim() === expected;
      return {
        passed,
        actual: value,
        reason: passed
          ? `响应头 ${name} = ${value}`
          : `响应头 ${name} 期望 ${expected}，实际 ${value}`,
      };
    }
    case 'json': {
      const path = rule.name.trim();
      if (!path) {
        return {
          passed: false,
          actual: '(未填写)',
          reason: 'JSON 断言缺少字段路径，例如 data.code',
        };
      }
      let data: unknown;
      try {
        data = JSON.parse(response.body);
      } catch {
        return {
          passed: false,
          actual: '(非 JSON)',
          reason: '响应体不是合法 JSON，无法按字段路径断言',
        };
      }
      const { found, value } = getJsonPath(data, path);
      if (!found) {
        return {
          passed: false,
          actual: '(路径不存在)',
          reason: `响应 JSON 中不存在字段路径 ${path}`,
        };
      }
      const actual = describeValue(value);
      if (!expected) {
        return { passed: true, actual, reason: `字段 ${path} 存在` };
      }
      const numeric = typeof value === 'number' && Number.isFinite(Number(expected));
      const passed = numeric ? Number(value) === Number(expected) : actual === expected;
      return {
        passed,
        actual,
        reason: passed
          ? `字段 ${path} = ${actual}`
          : `字段 ${path} 期望 ${expected}，实际 ${actual}`,
      };
    }
  }
}

export type ExtractSource = 'body' | 'header';

export interface ExtractRule {
  id: string;
  enabled: boolean;
  variable: string;
  source: ExtractSource;
  path: string;
}

export interface ExtractionResult {
  id: string;
  variable: string;
  source: ExtractSource;
  path: string;
  value: string | null;
  reason: string;
}

export function runExtractions(rules: ExtractRule[], response: HttpResponse): ExtractionResult[] {
  const results: ExtractionResult[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const variable = rule.variable.trim();
    const path = rule.path.trim();
    const base = { id: rule.id, variable, source: rule.source, path };
    if (!variable) {
      results.push({ ...base, value: null, reason: '提取规则缺少目标变量名' });
      continue;
    }
    if (!path) {
      results.push({ ...base, value: null, reason: '提取规则缺少字段路径或响应头名' });
      continue;
    }
    if (rule.source === 'header') {
      const value = readResponseHeader(response, path);
      results.push(
        value === null
          ? { ...base, value: null, reason: `响应头 ${path} 不存在，变量 ${variable} 未更新` }
          : { ...base, value, reason: `已提取响应头 ${path} → {{${variable}}}` },
      );
      continue;
    }
    let data: unknown;
    try {
      data = JSON.parse(response.body);
    } catch {
      results.push({ ...base, value: null, reason: '响应体不是合法 JSON，无法按字段路径提取' });
      continue;
    }
    const { found, value } = getJsonPath(data, path);
    if (!found) {
      results.push({ ...base, value: null, reason: `字段路径 ${path} 不存在，变量 ${variable} 未更新` });
      continue;
    }
    if (value === null || value === undefined) {
      results.push({ ...base, value: null, reason: `字段路径 ${path} 为空，变量 ${variable} 未更新` });
      continue;
    }
    const extracted = typeof value === 'object' ? JSON.stringify(value) : String(value);
    results.push({ ...base, value: extracted, reason: `已提取 ${path} → {{${variable}}}` });
  }
  return results;
}
