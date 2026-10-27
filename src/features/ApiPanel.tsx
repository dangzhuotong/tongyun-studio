import { useState, type FormEvent } from 'react';
import type { Project, ProjectInspection, HttpResponse, AgentSessionState } from '../contracts';
import {
  sendHttpRequest,
  readProjectFileContent,
  writeProjectFile,
  appendProjectFile,
} from '../bridge';
import {
  Bot,
  Check,
  Code2,
  Copy,
  FileCode,
  History,
  Key,
  LoaderCircle,
  Send,
  Terminal,
  Trash2,
} from '../components/Icons';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD';

interface ParamRow {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

interface RequestHistoryItem {
  id: string;
  method: HttpMethod;
  url: string;
  status: number;
  latencyMs: number;
  timestamp: string;
  curl?: string;
}

const COMMON_HEADERS = [
  'Accept',
  'Accept-Encoding',
  'Accept-Language',
  'Authorization',
  'Cache-Control',
  'Content-Type',
  'Cookie',
  'If-None-Match',
  'Origin',
  'Referer',
  'User-Agent',
  'X-API-Key',
  'X-Requested-With',
];

const COMMON_HEADER_VALUES: Record<string, string[]> = {
  'content-type': [
    'application/json',
    'application/x-www-form-urlencoded',
    'multipart/form-data',
    'text/plain',
    'text/html',
    'application/octet-stream',
  ],
  accept: [
    'application/json',
    'application/json, text/plain, */*',
    '*/*',
    'text/html',
  ],
  'cache-control': [
    'no-cache',
    'no-store',
    'max-age=0',
    'public, max-age=3600',
  ],
};

export default function ApiPanel({
  project,
  inspection,
  session,
  onNotify,
  onRefresh,
}: {
  project: Project | null;
  inspection?: ProjectInspection | null;
  session?: AgentSessionState | null;
  onRefresh?: () => void;
  onNotify?: (msg: string) => void;
}) {
  const [method, setMethod] = useState<HttpMethod>('GET');
  const [url, setUrl] = useState('http://localhost:3000/api/health');

  // Request configs
  const [params, setParams] = useState<ParamRow[]>([
    { id: 'p1', key: 'version', value: '1', enabled: true },
  ]);
  const [headers, setHeaders] = useState<ParamRow[]>([
    { id: 'h1', key: 'Content-Type', value: 'application/json', enabled: true },
    { id: 'h2', key: 'Accept', value: 'application/json', enabled: true },
  ]);
  const [authType, setAuthType] = useState<'none' | 'bearer' | 'basic'>('none');
  const [bearerToken, setBearerToken] = useState('');
  const [basicUser, setBasicUser] = useState('');
  const [basicPass, setBasicPass] = useState('');
  const [body, setBody] = useState('{\n  "query": "hello"\n}');

  // Active editor tab
  const [activeTab, setActiveTab] = useState<'params' | 'headers' | 'auth' | 'body'>('params');

  // Environments
  const [envVars, setEnvVars] = useState<ParamRow[]>([
    { id: 'e1', key: 'baseUrl', value: 'http://localhost:3000', enabled: true },
  ]);
  const [showEnvModal, setShowEnvModal] = useState(false);

  // Execution
  const [sending, setSending] = useState(false);
  const [response, setResponse] = useState<HttpResponse | null>(null);
  const [responseTab, setResponseTab] = useState<'body' | 'headers'>('body');
  const [copiedBody, setCopiedBody] = useState(false);
  const [copiedCurl, setCopiedCurl] = useState(false);

  // Save as .http modal state
  const [showSaveHttpModal, setShowSaveHttpModal] = useState(false);
  const [saveHttpTitle, setSaveHttpTitle] = useState('');
  const [saveHttpFilePath, setSaveHttpFilePath] = useState('requests.http');
  const [saveHttpMode, setSaveHttpMode] = useState<'append' | 'overwrite'>('append');
  const [savingHttp, setSavingHttp] = useState(false);

  // History & .http files
  const [history, setHistory] = useState<RequestHistoryItem[]>([]);
  const [selectedHttpFile, setSelectedHttpFile] = useState<string | null>(null);
  const [loadingHttpFile, setLoadingHttpFile] = useState(false);

  const [curlImportText, setCurlImportText] = useState('');
  const [showCurlModal, setShowCurlModal] = useState(false);

  const agentHttpActions = (session?.actions ?? []).filter(a => a.kind === 'http');

  const httpPaths = inspection?.httpFilePaths ?? [];

  // Interpolate {{variable}} from envVars
  const interpolate = (text: string): string => {
    let result = text;
    for (const ev of envVars) {
      if (ev.enabled && ev.key.trim()) {
        result = result.replaceAll(`{{${ev.key.trim()}}}`, ev.value);
      }
    }
    return result;
  };

  const addRow = (type: 'params' | 'headers' | 'env') => {
    const newRow = { id: Math.random().toString(36).slice(2, 9), key: '', value: '', enabled: true };
    if (type === 'params') setParams(p => [...p, newRow]);
    else if (type === 'headers') setHeaders(h => [...h, newRow]);
    else setEnvVars(e => [...e, newRow]);
  };

  const removeRow = (type: 'params' | 'headers' | 'env', id: string) => {
    if (type === 'params') setParams(p => p.filter(item => item.id !== id));
    else if (type === 'headers') setHeaders(h => h.filter(item => item.id !== id));
    else setEnvVars(e => e.filter(item => item.id !== id));
  };

  const updateRow = (
    type: 'params' | 'headers' | 'env',
    id: string,
    field: 'key' | 'value' | 'enabled',
    val: any,
  ) => {
    const updater = (list: ParamRow[]) =>
      list.map(item => (item.id === id ? { ...item, [field]: val } : item));
    if (type === 'params') setParams(updater);
    else if (type === 'headers') setHeaders(updater);
    else setEnvVars(updater);
  };

  const buildTargetUrl = () => {
    let raw = interpolate(url.trim());
    const activeParams = params.filter(p => p.enabled && p.key.trim());
    if (activeParams.length > 0) {
      const searchParams = new URLSearchParams();
      for (const p of activeParams) {
        searchParams.append(p.key.trim(), interpolate(p.value.trim()));
      }
      const delimiter = raw.includes('?') ? '&' : '?';
      raw += `${delimiter}${searchParams.toString()}`;
    }
    return raw;
  };

  const handleSend = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    if (!url.trim() || sending) return;

    setSending(true);
    setResponse(null);
    try {
      const targetUrl = buildTargetUrl();
      const activeHeaders: [string, string][] = headers
        .filter(h => h.enabled && h.key.trim())
        .map(h => [h.key.trim(), interpolate(h.value.trim())]);

      if (authType === 'bearer' && bearerToken.trim()) {
        activeHeaders.push(['Authorization', `Bearer ${interpolate(bearerToken.trim())}`]);
      } else if (authType === 'basic' && (basicUser || basicPass)) {
        const credentials = btoa(`${basicUser}:${basicPass}`);
        activeHeaders.push(['Authorization', `Basic ${credentials}`]);
      }

      const reqBody =
        method !== 'GET' && method !== 'HEAD' && body.trim() ? interpolate(body) : undefined;

      const res = await sendHttpRequest(method, targetUrl, activeHeaders, reqBody);
      setResponse(res);

      const recordedCurl = generateCurl(method, targetUrl, headers, authType, bearerToken, basicUser, basicPass, reqBody);
      setHistory(prev => [
        {
          id: Math.random().toString(36).slice(2, 9),
          method,
          url: targetUrl,
          status: res.status,
          latencyMs: res.latencyMs,
          timestamp: new Date().toLocaleTimeString(),
          curl: recordedCurl,
        },
        ...prev.slice(0, 19),
      ]);

      onNotify?.(`HTTP ${res.status} ${res.statusText} (${res.latencyMs}ms)`);
    } catch (err) {
      setResponse({
        status: 0,
        statusText: 'Request Failed',
        headers: [],
        body: String(err),
        latencyMs: 0,
      });
      onNotify?.(`请求失败：${err}`);
    } finally {
      setSending(false);
    }
  };

  const loadHttpFile = async (relPath: string) => {
    if (!project) return;
    setSelectedHttpFile(relPath);
    setLoadingHttpFile(true);
    try {
      const content = await readProjectFileContent(project.id, relPath);
      const lines = content.split('\n');
      let foundRequest = false;
      let inBody = false;
      const parsedHeaders: ParamRow[] = [];
      const bodyLines: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        const trimmed = rawLine.trim();

        if (!foundRequest) {
          if (trimmed.startsWith('#') || !trimmed) continue;
          const match = trimmed.match(/^(GET|POST|PUT|DELETE|PATCH|HEAD)\s+(\S+)/i);
          if (match) {
            setMethod(match[1].toUpperCase() as HttpMethod);
            setUrl(match[2]);
            foundRequest = true;
          }
          continue;
        }

        // Once request line is found
        if (trimmed.startsWith('###')) {
          // Reached next request block
          break;
        }

        if (!inBody) {
          if (!trimmed) {
            inBody = true;
            continue;
          }
          const colonIdx = trimmed.indexOf(':');
          if (colonIdx > 0) {
            const k = trimmed.slice(0, colonIdx).trim();
            const v = trimmed.slice(colonIdx + 1).trim();
            if (k.toLowerCase() === 'authorization' && v.toLowerCase().startsWith('bearer ')) {
              setAuthType('bearer');
              setBearerToken(v.slice(7).trim());
            } else {
              parsedHeaders.push({
                id: `load_h_${parsedHeaders.length}`,
                key: k,
                value: v,
                enabled: true,
              });
            }
          }
        } else {
          bodyLines.push(rawLine);
        }
      }

      if (parsedHeaders.length > 0) {
        setHeaders(parsedHeaders);
      }
      if (bodyLines.length > 0) {
        setBody(bodyLines.join('\n').trim());
      }
      onNotify?.(`已载入用例：${relPath}`);
    } catch (e) {
      onNotify?.(`读取文件失败：${e}`);
    } finally {
      setLoadingHttpFile(false);
    }
  };

  const parseCurlCommand = () => {
    const text = curlImportText.trim();
    if (!text.startsWith('curl')) {
      onNotify?.('非标准 curl 命令');
      return;
    }

    const methodMatch = text.match(/-X\s+([A-Z]+)/);
    if (methodMatch) setMethod(methodMatch[1] as HttpMethod);

    const urlMatch = text.match(/https?:\/\/[^\s'"]+/);
    if (urlMatch) setUrl(urlMatch[0]);

    const headerMatches = [...text.matchAll(/-H\s+['"]([^'"]+)['"]/g)];
    if (headerMatches.length > 0) {
      const parsed: ParamRow[] = headerMatches.map((m, idx) => {
        const [k, v] = m[1].split(':');
        return {
          id: `curl_h_${idx}`,
          key: k?.trim() || '',
          value: v?.trim() || '',
          enabled: true,
        };
      });
      setHeaders(parsed);
    }

    const dataMatch = text.match(/--data(-raw|-binary)?\s+['"]([^'"]+)['"]/);
    if (dataMatch) {
      setBody(dataMatch[2]);
      if (!methodMatch) setMethod('POST');
    }

    setShowCurlModal(false);
    setCurlImportText('');
    onNotify?.('✨ 已成功从 cURL 解析导入请求');
  };

  const generateCurl = (
    customMethod?: HttpMethod,
    customUrl?: string,
    customHeaders?: ParamRow[],
    customAuthType?: 'none' | 'bearer' | 'basic',
    customBearer?: string,
    customUser?: string,
    customPass?: string,
    customBody?: string,
  ) => {
    const m = customMethod ?? method;
    const targetUrl = customUrl ?? buildTargetUrl();
    let curl = `curl -X ${m} "${targetUrl}"`;

    const activeHeaders = (customHeaders ?? headers)
      .filter(h => h.enabled && h.key.trim())
      .map(h => [h.key.trim(), interpolate(h.value.trim())]);

    for (const [k, v] of activeHeaders) {
      curl += ` \\\n  -H "${k}: ${v}"`;
    }

    const auth = customAuthType ?? authType;
    const bToken = customBearer ?? bearerToken;
    const uName = customUser ?? basicUser;
    const uPass = customPass ?? basicPass;

    if (auth === 'bearer' && bToken.trim()) {
      curl += ` \\\n  -H "Authorization: Bearer ${interpolate(bToken.trim())}"`;
    } else if (auth === 'basic' && (uName || uPass)) {
      const creds = btoa(`${uName}:${uPass}`);
      curl += ` \\\n  -H "Authorization: Basic ${creds}"`;
    }

    const reqBody = customBody !== undefined ? customBody : body;
    if (m !== 'GET' && m !== 'HEAD' && reqBody.trim()) {
      curl += ` \\\n  --data '${interpolate(reqBody)}'`;
    }
    return curl;
  };

  const exportAsCurl = () => {
    const curl = generateCurl();
    navigator.clipboard.writeText(curl);
    onNotify?.('已复制 cURL 完整命令');
  };

  const copyResponseBody = () => {
    if (!response) return;
    navigator.clipboard.writeText(response.body);
    setCopiedBody(true);
    onNotify?.('已复制响应数据');
    setTimeout(() => setCopiedBody(false), 2000);
  };

  const quickAddHeader = (key: string, value: string) => {
    setHeaders(prev => {
      const existingIndex = prev.findIndex(h => h.key.trim().toLowerCase() === key.toLowerCase());
      if (existingIndex >= 0) {
        const copy = [...prev];
        copy[existingIndex] = { ...copy[existingIndex], value, enabled: true };
        return copy;
      }
      return [
        ...prev,
        { id: Math.random().toString(36).slice(2, 9), key, value, enabled: true },
      ];
    });
    onNotify?.(`已应用 Header: ${key}`);
  };

  const generateHttpSnippet = (title?: string) => {
    const targetUrl = buildTargetUrl();
    const lines: string[] = [];
    const summary = title?.trim() || `${method} ${targetUrl}`;
    lines.push(`### ${summary}`);
    lines.push(`${method} ${targetUrl}`);

    for (const h of headers.filter(h => h.enabled && h.key.trim())) {
      lines.push(`${h.key.trim()}: ${interpolate(h.value.trim())}`);
    }
    if (authType === 'bearer' && bearerToken.trim()) {
      lines.push(`Authorization: Bearer ${interpolate(bearerToken.trim())}`);
    } else if (authType === 'basic' && (basicUser || basicPass)) {
      const creds = btoa(`${basicUser}:${basicPass}`);
      lines.push(`Authorization: Basic ${creds}`);
    }

    if (method !== 'GET' && method !== 'HEAD' && body.trim()) {
      lines.push('');
      lines.push(interpolate(body));
    }
    return lines.join('\n');
  };

  const handleSaveHttp = async () => {
    if (!project) return;
    const targetPath = saveHttpFilePath.trim() || 'requests.http';
    const snippet = generateHttpSnippet(saveHttpTitle);
    setSavingHttp(true);
    try {
      if (saveHttpMode === 'append') {
        await appendProjectFile(project.id, targetPath, '\n\n' + snippet);
      } else {
        await writeProjectFile(project.id, targetPath, snippet);
      }
      setShowSaveHttpModal(false);
      onNotify?.(`✨ 已保存到项目用例文件：${targetPath}`);
      onRefresh?.();
    } catch (err) {
      onNotify?.(`保存文件失败：${err}`);
    } finally {
      setSavingHttp(false);
    }
  };

  const copyHttpSnippet = () => {
    const snippet = generateHttpSnippet(saveHttpTitle);
    navigator.clipboard.writeText(snippet);
    onNotify?.('已复制 .http 格式代码片段');
  };

  return (
    <div className="feature-panel-layout" aria-labelledby="api-title">
      <div className="workbench-header">
        <div className="workbench-title-group">
          <div className="large-tool-icon">
            <Code2 size={22} strokeWidth={1.5} />
          </div>
          <div>
            <h2 id="api-title">Tongyun API · 接口工作台</h2>
            <p>Query Params 解析、环境变量（{`{{baseUrl}}`}）、Auth 认证、cURL 导入导出与历史快照。</p>
          </div>
        </div>
        <div className="workbench-badges">
          <button className="secondary-button-sm" onClick={() => setShowEnvModal(true)}>
            <Key size={12} />
            环境变量 ({envVars.length})
          </button>
          <button className="secondary-button-sm" onClick={() => setShowCurlModal(true)}>
            导入 cURL
          </button>
          <button className="secondary-button-sm" onClick={exportAsCurl}>
            <Copy size={12} />
            复制 cURL
          </button>
          <button className="secondary-button-sm" onClick={() => setShowSaveHttpModal(true)}>
            <FileCode size={12} />
            保存为 .http
          </button>
        </div>
      </div>

      {!project ? (
        <div className="panel-empty-placeholder">
          <Code2 size={32} strokeWidth={1.2} />
          <p>请先在左侧选择或添加一个项目，以调试与管理项目接口用例。</p>
        </div>
      ) : (
        <div className="api-workbench-split">
          {/* Main Request & Response Section */}
          <div className="api-main-pane">
            {/* Discovered .http files */}
            {httpPaths.length > 0 && (
              <section className="panel-subcard-compact">
                <div className="section-heading">
                  <span className="subcard-title-sm">
                    <FileCode size={13} /> 项目用例 ({httpPaths.length})
                  </span>
                </div>
                <div className="http-file-pills">
                  {httpPaths.map(p => (
                    <button
                      key={p}
                      className={`http-pill ${selectedHttpFile === p ? 'selected' : ''}`}
                      onClick={() => void loadHttpFile(p)}
                    >
                      {loadingHttpFile && selectedHttpFile === p ? (
                        <LoaderCircle size={11} className="spin" />
                      ) : (
                        <FileCode size={11} />
                      )}
                      <span>{p}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {/* Agent Automated API Verifications */}
            {agentHttpActions.length > 0 && (
              <section className="panel-subcard agent-subcard">
                <div className="section-heading">
                  <div className="subcard-title">
                    <Bot size={15} className="accent-color" />
                    <h3>Agent 接口测试验证流</h3>
                    <span className="mini-badge-accent">{session?.agentName ?? 'Agent'}</span>
                  </div>
                  <span className="meta">{agentHttpActions.length} 项接口探针</span>
                </div>
                <div className="agent-action-mini-list">
                  {agentHttpActions.slice(-4).reverse().map(act => (
                    <div
                      key={act.id}
                      className="agent-action-mini-item clickable"
                      onClick={() => {
                        if (act.detail && act.detail.startsWith('http')) {
                          setUrl(act.detail);
                        }
                      }}
                      title="点击将此接口载入上方调试栏"
                    >
                      <div className="action-mini-header">
                        <span className={`status-dot ${act.status === 'done' ? 'available' : 'error'}`} />
                        <span className="mini-badge">HTTP</span>
                        <code className="action-mini-cmd">{act.title}</code>
                        <span className="mono-subtle">{act.timestamp}</span>
                      </div>
                      <div className="action-mini-detail mono-subtle">{act.detail}</div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* HTTP Request Builder Workbench */}
            <section className="api-requester-card">
              <form onSubmit={handleSend} className="api-url-bar">
                <select
                  className={`method-select method-${method.toLowerCase()}`}
                  value={method}
                  onChange={e => setMethod(e.target.value as HttpMethod)}
                >
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                  <option value="DELETE">DELETE</option>
                  <option value="PATCH">PATCH</option>
                  <option value="HEAD">HEAD</option>
                </select>

                <input
                  className="url-input"
                  placeholder="https://api.example.com/v1/... 或 {{baseUrl}}/api/..."
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  disabled={sending}
                />

                <button
                  type="submit"
                  className="primary-button"
                  disabled={sending || !url.trim()}
                >
                  {sending ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <Send size={14} />
                  )}
                  <span>{sending ? '发送中…' : '发送'}</span>
                </button>
              </form>

              {/* Sub-tabs: Params, Headers, Auth, Body */}
              <div className="api-config-area">
                <div className="sub-tabs">
                  <button
                    type="button"
                    className={activeTab === 'params' ? 'active' : ''}
                    onClick={() => setActiveTab('params')}
                  >
                    Params ({params.filter(p => p.enabled && p.key).length})
                  </button>
                  <button
                    type="button"
                    className={activeTab === 'headers' ? 'active' : ''}
                    onClick={() => setActiveTab('headers')}
                  >
                    Headers ({headers.filter(h => h.enabled && h.key).length})
                  </button>
                  <button
                    type="button"
                    className={activeTab === 'auth' ? 'active' : ''}
                    onClick={() => setActiveTab('auth')}
                  >
                    Auth {authType !== 'none' ? `(${authType})` : ''}
                  </button>
                  <button
                    type="button"
                    className={activeTab === 'body' ? 'active' : ''}
                    onClick={() => setActiveTab('body')}
                  >
                    Body
                  </button>
                </div>

                {activeTab === 'params' && (
                  <div className="key-val-editor">
                    <div className="key-val-table">
                      <div className="table-row-head">
                        <span />
                        <span>参数名 (Key)</span>
                        <span>参数值 (Value)</span>
                        <span />
                      </div>
                      {params.map(p => (
                        <div key={p.id} className="table-row-item">
                          <input
                            type="checkbox"
                            checked={p.enabled}
                            onChange={e => updateRow('params', p.id, 'enabled', e.target.checked)}
                          />
                          <input
                            placeholder="param_name"
                            value={p.key}
                            onChange={e => updateRow('params', p.id, 'key', e.target.value)}
                          />
                          <input
                            placeholder="param_value"
                            value={p.value}
                            onChange={e => updateRow('params', p.id, 'value', e.target.value)}
                          />
                          <button
                            type="button"
                            className="icon-button-sm"
                            onClick={() => removeRow('params', p.id)}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="text-button-sm"
                      onClick={() => addRow('params')}
                    >
                      + 添加 Query 参数
                    </button>
                  </div>
                )}

                {activeTab === 'headers' && (
                  <div className="key-val-editor">
                    <div className="header-presets-bar">
                      <span className="preset-label">快捷预设:</span>
                      <button
                        type="button"
                        className="preset-chip"
                        onClick={() => {
                          quickAddHeader('Content-Type', 'application/json');
                          quickAddHeader('Accept', 'application/json');
                        }}
                      >
                        + JSON
                      </button>
                      <button
                        type="button"
                        className="preset-chip"
                        onClick={() => quickAddHeader('Content-Type', 'application/x-www-form-urlencoded')}
                      >
                        + Form
                      </button>
                      <button
                        type="button"
                        className="preset-chip"
                        onClick={() => quickAddHeader('Cache-Control', 'no-cache')}
                      >
                        + No-Cache
                      </button>
                      <button
                        type="button"
                        className="preset-chip"
                        onClick={() => quickAddHeader('Accept', '*/*')}
                      >
                        + Accept: */*
                      </button>
                      <button
                        type="button"
                        className="preset-chip"
                        onClick={() => quickAddHeader('User-Agent', 'Tongyun-Studio/1.0')}
                      >
                        + User-Agent
                      </button>
                    </div>

                    <div className="key-val-table">
                      <div className="table-row-head">
                        <span />
                        <span>Header 名</span>
                        <span>Header 值</span>
                        <span />
                      </div>
                      {headers.map(h => (
                        <div key={h.id} className="table-row-item">
                          <input
                            type="checkbox"
                            checked={h.enabled}
                            onChange={e => updateRow('headers', h.id, 'enabled', e.target.checked)}
                          />
                          <input
                            list="common-header-keys"
                            placeholder="Header-Key"
                            value={h.key}
                            onChange={e => updateRow('headers', h.id, 'key', e.target.value)}
                          />
                          <input
                            list={`values-for-${h.key.trim().toLowerCase()}`}
                            placeholder="Header-Value"
                            value={h.value}
                            onChange={e => updateRow('headers', h.id, 'value', e.target.value)}
                          />
                          <button
                            type="button"
                            className="icon-button-sm"
                            onClick={() => removeRow('headers', h.id)}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="text-button-sm"
                      onClick={() => addRow('headers')}
                    >
                      + 添加请求头
                    </button>

                    <datalist id="common-header-keys">
                      {COMMON_HEADERS.map(name => (
                        <option key={name} value={name} />
                      ))}
                    </datalist>
                    {Object.entries(COMMON_HEADER_VALUES).map(([keyName, vals]) => (
                      <datalist key={keyName} id={`values-for-${keyName}`}>
                        {vals.map(v => (
                          <option key={v} value={v} />
                        ))}
                      </datalist>
                    ))}
                  </div>
                )}

                {activeTab === 'auth' && (
                  <div className="auth-editor">
                    <div className="auth-type-selector">
                      <label>认证类型:</label>
                      <select
                        value={authType}
                        onChange={e => setAuthType(e.target.value as any)}
                        className="auth-select"
                      >
                        <option value="none">无认证 (No Auth)</option>
                        <option value="bearer">Bearer Token</option>
                        <option value="basic">Basic Auth</option>
                      </select>
                    </div>

                    {authType === 'bearer' && (
                      <div className="auth-fields">
                        <label>Bearer Token:</label>
                        <input
                          type="password"
                          className="auth-input"
                          placeholder="eyJhbGciOi..."
                          value={bearerToken}
                          onChange={e => setBearerToken(e.target.value)}
                        />
                      </div>
                    )}

                    {authType === 'basic' && (
                      <div className="auth-fields-row">
                        <div>
                          <label>用户名:</label>
                          <input
                            className="auth-input"
                            placeholder="admin"
                            value={basicUser}
                            onChange={e => setBasicUser(e.target.value)}
                          />
                        </div>
                        <div>
                          <label>密码:</label>
                          <input
                            type="password"
                            className="auth-input"
                            placeholder="password"
                            value={basicPass}
                            onChange={e => setBasicPass(e.target.value)}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {activeTab === 'body' && (
                  <div className="body-editor">
                    <textarea
                      className="body-textarea"
                      placeholder="请求体 JSON、XML 或文本内容，支持 {{variable}} 变量…"
                      rows={6}
                      value={body}
                      onChange={e => setBody(e.target.value)}
                    />
                    <div className="body-tools">
                      <button
                        type="button"
                        className="text-button-sm"
                        onClick={() => {
                          try {
                            const parsed = JSON.parse(body);
                            setBody(JSON.stringify(parsed, null, 2));
                          } catch {
                            onNotify?.('非标准 JSON 格式，无法美化');
                          }
                        }}
                      >
                        美化 JSON
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* HTTP Response Panel */}
            {response && (
              <section className="api-response-card">
                <div className="response-header">
                  <div className="response-meta">
                    <span
                      className={`status-pill ${
                        response.status >= 200 && response.status < 300
                          ? 'status-success'
                          : response.status >= 400
                          ? 'status-client-error'
                          : 'status-server-error'
                      }`}
                    >
                      {response.status} {response.statusText}
                    </span>
                    <span className="latency-badge">{response.latencyMs} ms</span>
                  </div>
                  <div className="response-tabs">
                    <button
                      className={responseTab === 'body' ? 'active' : ''}
                      onClick={() => setResponseTab('body')}
                    >
                      响应体
                    </button>
                    <button
                      className={responseTab === 'headers' ? 'active' : ''}
                      onClick={() => setResponseTab('headers')}
                    >
                      响应头 ({response.headers.length})
                    </button>
                    <button
                      className="terminal-btn"
                      onClick={() => {
                        const curl = generateCurl();
                        navigator.clipboard.writeText(curl);
                        setCopiedCurl(true);
                        onNotify?.('已复制 cURL 完整命令');
                        setTimeout(() => setCopiedCurl(false), 2000);
                      }}
                      title="复制此请求的 cURL 命令"
                    >
                      {copiedCurl ? <Check size={12} /> : <Terminal size={12} />}
                      复制 cURL
                    </button>
                    <button
                      className="terminal-btn"
                      onClick={copyResponseBody}
                      title="复制响应内容"
                    >
                      {copiedBody ? <Check size={12} /> : <Copy size={12} />}
                      复制内容
                    </button>
                  </div>
                </div>

                {responseTab === 'body' ? (
                  <div className="response-body-view">
                    <pre className="response-pre">
                      {(() => {
                        try {
                          const parsed = JSON.parse(response.body);
                          return JSON.stringify(parsed, null, 2);
                        } catch {
                          return response.body || '(空响应体)';
                        }
                      })()}
                    </pre>
                  </div>
                ) : (
                  <div className="response-headers-view">
                    <table className="headers-result-table">
                      <thead>
                        <tr>
                          <th>Header 名称</th>
                          <th>Header 取值</th>
                        </tr>
                      </thead>
                      <tbody>
                        {response.headers.map(([k, v], idx) => (
                          <tr key={idx}>
                            <td className="mono">{k}</td>
                            <td className="mono">{v}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )}
          </div>

          {/* Right Column: History Drawer */}
          <aside className="api-history-drawer">
            <div className="pane-header">
              <span className="subcard-title-sm">
                <History size={13} /> 请求历史 ({history.length})
              </span>
              {history.length > 0 && (
                <button className="text-button-xs" onClick={() => setHistory([])}>
                  清空
                </button>
              )}
            </div>
            <div className="history-list">
              {history.length === 0 ? (
                <div className="history-empty">暂无请求历史</div>
              ) : (
                history.map(item => (
                  <div
                    key={item.id}
                    className="history-item"
                    onClick={() => {
                      setMethod(item.method);
                      setUrl(item.url);
                    }}
                    title="点击恢复此请求参数"
                  >
                    <div className="history-top">
                      <span className={`method-badge-mini method-${item.method.toLowerCase()}`}>
                        {item.method}
                      </span>
                      <span className="history-status">{item.status}</span>
                      <span className="history-time">{item.latencyMs}ms</span>
                      <button
                        type="button"
                        className="history-copy-btn"
                        onClick={e => {
                          e.stopPropagation();
                          const curl = item.curl ?? generateCurl(item.method, item.url);
                          navigator.clipboard.writeText(curl);
                          onNotify?.('已复制历史请求 cURL');
                        }}
                        title="复制此历史请求的 cURL"
                      >
                        <Copy size={11} />
                      </button>
                    </div>
                    <span className="history-url">{item.url}</span>
                  </div>
                ))
              )}
            </div>
          </aside>
        </div>
      )}

      {/* Save as .http Modal */}
      {showSaveHttpModal && (
        <div className="modal-overlay" onClick={() => setShowSaveHttpModal(false)}>
          <div className="modal-dialog" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>保存请求为 .http 用例文件</h2>
            </div>
            <div className="modal-body">
              <div className="modal-form-group">
                <label>用例名称 / 描述:</label>
                <input
                  className="modal-input"
                  placeholder="例如：查询健康检查接口 或 用户登录"
                  value={saveHttpTitle}
                  onChange={e => setSaveHttpTitle(e.target.value)}
                />
              </div>

              <div className="modal-form-group">
                <label>保存目标文件 (项目内相对路径):</label>
                <input
                  list="project-http-files"
                  className="modal-input"
                  placeholder="requests.http"
                  value={saveHttpFilePath}
                  onChange={e => setSaveHttpFilePath(e.target.value)}
                />
                <datalist id="project-http-files">
                  {httpPaths.map(p => (
                    <option key={p} value={p} />
                  ))}
                  <option value="requests.http" />
                  <option value="api.http" />
                </datalist>
                {httpPaths.length > 0 && (
                  <div className="file-pill-hint">
                    <span className="preset-label">项目已有用例文件:</span>
                    {httpPaths.map(p => (
                      <button
                        key={p}
                        type="button"
                        className="preset-chip"
                        onClick={() => setSaveHttpFilePath(p)}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="modal-form-group">
                <label>写入模式:</label>
                <div className="modal-radio-group">
                  <label>
                    <input
                      type="radio"
                      name="saveHttpMode"
                      value="append"
                      checked={saveHttpMode === 'append'}
                      onChange={() => setSaveHttpMode('append')}
                    />
                    追加到文件尾部 (推荐)
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="saveHttpMode"
                      value="overwrite"
                      checked={saveHttpMode === 'overwrite'}
                      onChange={() => setSaveHttpMode('overwrite')}
                    />
                    覆盖已有文件
                  </label>
                </div>
              </div>

              <div className="modal-form-group">
                <label>生成的 .http 格式代码预览:</label>
                <pre className="http-preview-box">{generateHttpSnippet(saveHttpTitle)}</pre>
              </div>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setShowSaveHttpModal(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={copyHttpSnippet}
              >
                <Copy size={13} />
                复制片段
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={savingHttp || !saveHttpFilePath.trim()}
                onClick={() => void handleSaveHttp()}
              >
                {savingHttp ? <LoaderCircle size={14} className="spin" /> : <FileCode size={14} />}
                <span>{savingHttp ? '保存中…' : '保存到项目'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* cURL Import Modal */}
      {showCurlModal && (
        <div className="modal-overlay" onClick={() => setShowCurlModal(false)}>
          <div className="modal-dialog" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>导入 cURL 命令</h2>
            </div>
            <div className="modal-body">
              <textarea
                className="body-textarea"
                rows={5}
                placeholder="粘贴包含 -X, -H, --data 等参数的标准 curl 命令…"
                value={curlImportText}
                onChange={e => setCurlImportText(e.target.value)}
              />
            </div>
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setShowCurlModal(false)}>
                取消
              </button>
              <button className="primary-button" onClick={parseCurlCommand}>
                解析并导入
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Environments Modal */}
      {showEnvModal && (
        <div className="modal-overlay" onClick={() => setShowEnvModal(false)}>
          <div className="modal-dialog" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>环境变量配置 (支持 {'{{key}}'} 动态替换)</h2>
            </div>
            <div className="modal-body">
              <div className="key-val-editor">
                <div className="key-val-table">
                  <div className="table-row-head">
                    <span />
                    <span>变量名 (Key)</span>
                    <span>变量值 (Value)</span>
                    <span />
                  </div>
                  {envVars.map(ev => (
                    <div key={ev.id} className="table-row-item">
                      <input
                        type="checkbox"
                        checked={ev.enabled}
                        onChange={e => updateRow('env', ev.id, 'enabled', e.target.checked)}
                      />
                      <input
                        placeholder="baseUrl"
                        value={ev.key}
                        onChange={e => updateRow('env', ev.id, 'key', e.target.value)}
                      />
                      <input
                        placeholder="http://127.0.0.1:3000"
                        value={ev.value}
                        onChange={e => updateRow('env', ev.id, 'value', e.target.value)}
                      />
                      <button
                        type="button"
                        className="icon-button-sm"
                        onClick={() => removeRow('env', ev.id)}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  className="text-button-sm"
                  onClick={() => addRow('env')}
                >
                  + 添加新变量
                </button>
              </div>
            </div>
            <div className="modal-actions">
              <button className="primary-button" onClick={() => setShowEnvModal(false)}>
                完成
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
