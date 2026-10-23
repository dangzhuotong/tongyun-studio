import { useState, type FormEvent } from 'react';
import type { Project, ProjectInspection, HttpResponse } from '../contracts';
import { sendHttpRequest, readProjectFileContent, openProjectFile, isDesktop } from '../bridge';
import {
  Check,
  Code2,
  Copy,
  ExternalLink,
  FileCode,
  LoaderCircle,
  Send,
  Trash2,
} from '../components/Icons';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD';

interface HeaderRow {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

export default function ApiPanel({
  project,
  inspection,
  onNotify,
}: {
  project: Project | null;
  inspection?: ProjectInspection | null;
  onRefresh?: () => void;
  onNotify?: (msg: string) => void;
}) {
  const [method, setMethod] = useState<HttpMethod>('GET');
  const [url, setUrl] = useState('http://localhost:3000/api/health');
  const [headers, setHeaders] = useState<HeaderRow[]>([
    { id: '1', key: 'Content-Type', value: 'application/json', enabled: true },
    { id: '2', key: 'Accept', value: 'application/json', enabled: true },
  ]);
  const [body, setBody] = useState('{\n  "query": "hello"\n}');
  const [activeTab, setActiveTab] = useState<'headers' | 'body'>('headers');
  const [sending, setSending] = useState(false);
  const [response, setResponse] = useState<HttpResponse | null>(null);
  const [responseTab, setResponseTab] = useState<'body' | 'headers'>('body');
  const [copiedBody, setCopiedBody] = useState(false);

  const [selectedHttpFile, setSelectedHttpFile] = useState<string | null>(null);
  const [httpFileContent, setHttpFileContent] = useState<string | null>(null);
  const [loadingHttpFile, setLoadingHttpFile] = useState(false);

  const httpPaths = inspection?.httpFilePaths ?? [];

  const addHeaderRow = () => {
    setHeaders(prev => [
      ...prev,
      { id: Math.random().toString(36).slice(2, 9), key: '', value: '', enabled: true },
    ]);
  };

  const removeHeaderRow = (id: string) => {
    setHeaders(prev => prev.filter(h => h.id !== id));
  };

  const updateHeaderRow = (id: string, field: 'key' | 'value' | 'enabled', val: any) => {
    setHeaders(prev =>
      prev.map(h => (h.id === id ? { ...h, [field]: val } : h)),
    );
  };

  const handleSend = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    if (!url.trim() || sending) return;

    setSending(true);
    setResponse(null);
    try {
      const activeHeaders: [string, string][] = headers
        .filter(h => h.enabled && h.key.trim())
        .map(h => [h.key.trim(), h.value.trim()]);

      const reqBody = method !== 'GET' && method !== 'HEAD' && body.trim() ? body : undefined;
      const res = await sendHttpRequest(method, url.trim(), activeHeaders, reqBody);
      setResponse(res);
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
      setHttpFileContent(content);

      // Simple heuristic to prefill URL/method from .http file
      const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        const match = line.match(/^(GET|POST|PUT|DELETE|PATCH|HEAD)\s+(https?:\/\/\S+)/i);
        if (match) {
          setMethod(match[1].toUpperCase() as HttpMethod);
          setUrl(match[2]);
          break;
        }
      }
      onNotify?.(`已载入接口用例文件：${relPath}`);
    } catch (e) {
      onNotify?.(`读取文件失败：${e}`);
    } finally {
      setLoadingHttpFile(false);
    }
  };

  const copyResponseBody = () => {
    if (!response) return;
    navigator.clipboard.writeText(response.body);
    setCopiedBody(true);
    onNotify?.('已复制响应数据');
    setTimeout(() => setCopiedBody(false), 2000);
  };

  const getMethodBadgeClass = (m: string) => {
    switch (m) {
      case 'GET':
        return 'method-get';
      case 'POST':
        return 'method-post';
      case 'PUT':
        return 'method-put';
      case 'DELETE':
        return 'method-delete';
      default:
        return 'method-other';
    }
  };

  const getStatusBadgeClass = (status: number) => {
    if (status >= 200 && status < 300) return 'status-success';
    if (status >= 300 && status < 400) return 'status-redirect';
    if (status >= 400 && status < 500) return 'status-client-error';
    return 'status-server-error';
  };

  return (
    <div className="feature-panel-layout" aria-labelledby="api-title">
      <div className="workbench-header">
        <div className="workbench-title-group">
          <div className="large-tool-icon">
            <Code2 size={22} strokeWidth={1.5} />
          </div>
          <div>
            <h2 id="api-title">Tongyun API · 原生接口工作台</h2>
            <p>构建并原生发送 HTTP 请求，测试 REST API，实时解析响应头与 JSON 数据体。</p>
          </div>
        </div>
        <div className="workbench-badges">
          <span className="badge-matcha">原生 HTTP 客户端</span>
          {project && <span className="mono-subtle">{project.name}</span>}
        </div>
      </div>

      {!project ? (
        <div className="panel-empty-placeholder">
          <Code2 size={32} strokeWidth={1.2} />
          <p>请先在左侧选择或添加一个项目，以调试与管理项目接口用例。</p>
        </div>
      ) : (
        <>
          {/* Discovered .http / .rest files in project */}
          {httpPaths.length > 0 && (
            <section className="panel-subcard">
              <div className="section-heading">
                <div className="subcard-title">
                  <FileCode size={15} className="title-icon" />
                  <h3>项目接口用例文件 (.http / .rest)</h3>
                </div>
                <span className="meta">{httpPaths.length} 个文件</span>
              </div>
              <div className="http-file-grid">
                {httpPaths.map(p => (
                  <div
                    key={p}
                    className={`http-file-card ${selectedHttpFile === p ? 'selected' : ''}`}
                    onClick={() => void loadHttpFile(p)}
                  >
                    <div className="http-file-info">
                      {loadingHttpFile && selectedHttpFile === p ? (
                        <LoaderCircle size={14} className="spin" />
                      ) : (
                        <FileCode size={14} />
                      )}
                      <span className="http-file-name">{p}</span>
                    </div>
                    <button
                      className="text-button-sm"
                      onClick={e => {
                        e.stopPropagation();
                        if (isDesktop && project) void openProjectFile(project.id, p);
                      }}
                      title="在系统编辑器中打开此文件"
                    >
                      <ExternalLink size={12} />
                    </button>
                  </div>
                ))}
              </div>

              {selectedHttpFile && httpFileContent && (
                <div className="http-preview-box">
                  <div className="http-preview-header">
                    <span>文件预览：{selectedHttpFile}</span>
                    <button
                      className="text-button-sm"
                      onClick={() => {
                        setSelectedHttpFile(null);
                        setHttpFileContent(null);
                      }}
                    >
                      收起
                    </button>
                  </div>
                  <pre className="http-code-preview">{httpFileContent}</pre>
                </div>
              )}
            </section>
          )}

          {/* HTTP Request Builder Workbench */}
          <section className="api-requester-card">
            <form onSubmit={handleSend} className="api-url-bar">
              <select
                className={`method-select ${getMethodBadgeClass(method)}`}
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
                placeholder="https://api.example.com/v1/endpoint 或 http://localhost:3000/..."
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

            {/* Request tabs: Headers / Body */}
            <div className="api-config-area">
              <div className="sub-tabs">
                <button
                  type="button"
                  className={activeTab === 'headers' ? 'active' : ''}
                  onClick={() => setActiveTab('headers')}
                >
                  请求头 ({headers.filter(h => h.enabled && h.key).length})
                </button>
                <button
                  type="button"
                  className={activeTab === 'body' ? 'active' : ''}
                  onClick={() => setActiveTab('body')}
                >
                  请求体 {method !== 'GET' && method !== 'HEAD' ? '(Body)' : ''}
                </button>
              </div>

              {activeTab === 'headers' ? (
                <div className="headers-editor">
                  <div className="headers-table">
                    <div className="headers-table-header">
                      <span>启用</span>
                      <span>Key (名称)</span>
                      <span>Value (取值)</span>
                      <span>操作</span>
                    </div>
                    {headers.map(h => (
                      <div key={h.id} className="header-row">
                        <input
                          type="checkbox"
                          checked={h.enabled}
                          onChange={e =>
                            updateHeaderRow(h.id, 'enabled', e.target.checked)
                          }
                        />
                        <input
                          className="header-key-input"
                          placeholder="Header-Name"
                          value={h.key}
                          onChange={e =>
                            updateHeaderRow(h.id, 'key', e.target.value)
                          }
                        />
                        <input
                          className="header-val-input"
                          placeholder="Header-Value"
                          value={h.value}
                          onChange={e =>
                            updateHeaderRow(h.id, 'value', e.target.value)
                          }
                        />
                        <button
                          type="button"
                          className="icon-button-sm"
                          onClick={() => removeHeaderRow(h.id)}
                          title="删除此 Header"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="text-button-sm"
                    onClick={addHeaderRow}
                  >
                    + 添加请求头
                  </button>
                </div>
              ) : (
                <div className="body-editor">
                  <textarea
                    className="body-textarea"
                    placeholder="请输入请求体内容（例如 JSON、XML 或纯文本）…"
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
                          onNotify?.('非有效 JSON 格式，无法格式化');
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
                    className={`status-pill ${getStatusBadgeClass(response.status)}`}
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
        </>
      )}
    </div>
  );
}
