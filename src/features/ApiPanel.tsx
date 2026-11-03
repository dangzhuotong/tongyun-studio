import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { Project, ProjectInspection, HttpResponse, AgentSessionState } from '../contracts';
import {
  sendHttpRequest,
  readProjectFileContent,
  writeProjectFile,
  appendProjectFile,
} from '../bridge';
import {
  COLLECTION_PATH,
  childrenOf,
  emptyCollection,
  nextWorkspaceId,
  parseCollection,
  parseCurl,
  parseHttpFile,
  removeNode,
  replaceRequestInSource,
  serializeCollection,
  serializeRequest,
  upsertNode,
  type CollectionFile,
  type CollectionNode,
  type ParseWarning,
  type ParsedCurl,
  type WorkspaceAuth,
  type WorkspaceRequest,
} from './apiWorkspace';
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  FileCode,
  Folder,
  FolderOpen,
  History,
  Key,
  Layers,
  LoaderCircle,
  Plus,
  RefreshCw,
  Send,
  Terminal,
  Trash2,
  X,
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

interface RequestTab {
  id: string;
  name: string;
  method: HttpMethod;
  url: string;
  params: ParamRow[];
  headers: ParamRow[];
  authType: 'none' | 'bearer' | 'basic';
  bearerToken: string;
  basicUser: string;
  basicPass: string;
  body: string;
  response: HttpResponse | null;
  sending: boolean;
  /** 载入或上次保存时的请求快照，用于脏标记与写回 */
  baseline: string;
  httpId?: string;
  sourceFile?: string;
  sourceLine?: number;
  loadedName?: string;
  regionStart?: number;
  blockStart?: number;
  blockEnd?: number;
  autoName?: boolean;
  collectionNodeId?: string;
}

const EDITABLE_FIELDS = [
  'method',
  'url',
  'params',
  'headers',
  'authType',
  'bearerToken',
  'basicUser',
  'basicPass',
  'body',
] as const;

type EditableField = (typeof EDITABLE_FIELDS)[number];
type TabField = EditableField | 'response' | 'sending' | 'name';

function requestSignature(tab: RequestTab): string {
  return JSON.stringify(EDITABLE_FIELDS.map(key => tab[key]));
}

function freshRow(key = '', value = ''): ParamRow {
  return { id: nextWorkspaceId('row'), key, value, enabled: true };
}

function newRequestTab(patch: Partial<RequestTab> = {}): RequestTab {
  const base: RequestTab = {
    id: nextWorkspaceId('tab'),
    name: '未命名请求',
    method: 'GET',
    url: 'http://localhost:3000/api/health',
    params: [freshRow('version', '1')],
    headers: [freshRow('Content-Type', 'application/json'), freshRow('Accept', 'application/json')],
    authType: 'none',
    bearerToken: '',
    basicUser: '',
    basicPass: '',
    body: '{\n  "query": "hello"\n}',
    response: null,
    sending: false,
    baseline: '',
    autoName: true,
  };
  const merged = { ...base, ...patch };
  return { ...merged, baseline: requestSignature(merged) };
}

function authToTabFields(auth: WorkspaceAuth): Pick<RequestTab, 'authType' | 'bearerToken' | 'basicUser' | 'basicPass'> {
  if (auth.type === 'bearer') {
    return { authType: 'bearer', bearerToken: auth.token, basicUser: '', basicPass: '' };
  }
  if (auth.type === 'basic') {
    return { authType: 'basic', bearerToken: '', basicUser: auth.username, basicPass: auth.password };
  }
  return { authType: 'none', bearerToken: '', basicUser: '', basicPass: '' };
}

function tabToWorkspaceRequest(tab: RequestTab): WorkspaceRequest {
  const auth: WorkspaceAuth =
    tab.authType === 'bearer'
      ? { type: 'bearer', token: tab.bearerToken }
      : tab.authType === 'basic'
        ? { type: 'basic', username: tab.basicUser, password: tab.basicPass }
        : { type: 'none' };
  return {
    id: tab.httpId ?? nextWorkspaceId('req'),
    name: tab.name,
    method: tab.method,
    url: tab.url,
    params: tab.params,
    headers: tab.headers,
    auth,
    body: tab.body,
    line: tab.sourceLine,
    blockStart: tab.blockStart,
    blockEnd: tab.blockEnd,
    regionStart: tab.regionStart,
    hasSeparator: tab.regionStart !== undefined && tab.blockStart !== undefined && tab.regionStart !== tab.blockStart,
    autoName: tab.autoName,
  };
}

function requestToTabPatch(req: WorkspaceRequest, sourceFile?: string): Partial<RequestTab> {
  return {
    name: req.name,
    method: req.method as HttpMethod,
    url: req.url,
    params: req.params,
    headers: req.headers,
    ...authToTabFields(req.auth),
    body: req.body,
    response: null,
    sending: false,
    httpId: req.id,
    sourceFile,
    sourceLine: req.line,
    loadedName: req.name,
    regionStart: req.regionStart,
    blockStart: req.blockStart,
    blockEnd: req.blockEnd,
    autoName: req.autoName,
  };
}

function curlToTabPatch(parsed: ParsedCurl, httpMethod: string): Partial<RequestTab> {
  return {
    method: httpMethod as HttpMethod,
    url: parsed.url,
    params: parsed.params,
    headers: parsed.headers,
    ...authToTabFields(parsed.auth),
    body: parsed.body,
    autoName: false,
  };
}

interface HttpFileTree {
  requests: WorkspaceRequest[];
  warnings: ParseWarning[];
  text: string;
}

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
  const [tabs, setTabs] = useState<RequestTab[]>(() => [newRequestTab()]);
  const [activeTabId, setActiveTabId] = useState('');
  const active = tabs.find(t => t.id === activeTabId) ?? tabs[0];

  const patchTab = (
    id: string,
    patch: Partial<RequestTab> | ((prev: RequestTab) => Partial<RequestTab>),
  ) => {
    setTabs(prev =>
      prev.map(t => (t.id === id ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t)),
    );
  };

  const bindField = <K extends TabField>(key: K) =>
    [
      active[key],
      (next: RequestTab[K] | ((prev: RequestTab[K]) => RequestTab[K])) =>
        patchTab(active.id, prev => ({
          [key]: typeof next === 'function'
            ? (next as (prev: RequestTab[K]) => RequestTab[K])(prev[key])
            : next,
        } as Partial<RequestTab>)),
    ] as const;

  const [method, setMethod] = bindField('method');
  const [url, setUrl] = bindField('url');
  const [params, setParams] = bindField('params');
  const [headers, setHeaders] = bindField('headers');
  const [authType, setAuthType] = bindField('authType');
  const [bearerToken, setBearerToken] = bindField('bearerToken');
  const [basicUser, setBasicUser] = bindField('basicUser');
  const [basicPass, setBasicPass] = bindField('basicPass');
  const [body, setBody] = bindField('body');
  const [response, setResponse] = bindField('response');
  const [sending, setSending] = bindField('sending');

  // Active editor tab
  const [activeTab, setActiveTab] = useState<'params' | 'headers' | 'auth' | 'body'>('params');

  // Environments
  const [envVars, setEnvVars] = useState<ParamRow[]>([
    { id: 'e1', key: 'baseUrl', value: 'http://localhost:3000', enabled: true },
  ]);
  const [showEnvModal, setShowEnvModal] = useState(false);

  // Execution
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
  const [httpTrees, setHttpTrees] = useState<Record<string, HttpFileTree>>({});
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});
  const [writingBack, setWritingBack] = useState(false);

  // JSON 用例集
  const [collection, setCollection] = useState<CollectionFile>(() => emptyCollection());
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const [newFolderName, setNewFolderName] = useState('');
  const [caseName, setCaseName] = useState('');
  const [targetFolderId, setTargetFolderId] = useState<string | null>(null);
  const [showCollections, setShowCollections] = useState(true);

  const [curlImportText, setCurlImportText] = useState('');
  const [showCurlModal, setShowCurlModal] = useState(false);

  const dirty = requestSignature(active) !== active.baseline;

  const createTab = (patch: Partial<RequestTab> = {}) => {
    const tab = newRequestTab(patch);
    setTabs(prev => [...prev, tab]);
    setActiveTabId(tab.id);
    return tab;
  };

  const closeTab = (id: string) => {
    const target = tabs.find(t => t.id === id);
    if (!target) return;
    if (requestSignature(target) !== target.baseline) {
      if (!window.confirm(`「${target.name}」有未保存的修改，确定关闭该 Tab 吗？`)) return;
    }
    const index = tabs.findIndex(t => t.id === id);
    const next = tabs.filter(t => t.id !== id);
    if (next.length === 0) {
      const fresh = newRequestTab();
      setTabs([fresh]);
      setActiveTabId(fresh.id);
      return;
    }
    setTabs(next);
    if (id === activeTabId) {
      setActiveTabId(next[Math.min(index, next.length - 1)].id);
    }
  };

  useEffect(() => {
    if (!tabs.some(t => t.id === activeTabId)) setActiveTabId(tabs[0]?.id ?? '');
  }, [tabs, activeTabId]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'w') {
        event.preventDefault();
        closeTab(active.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, activeTabId, project]);

  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    void (async () => {
      try {
        const text = await readProjectFileContent(project.id, COLLECTION_PATH);
        if (!cancelled) setCollection(parseCollection(text));
      } catch {
        if (!cancelled) setCollection(emptyCollection());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project?.id]);

  useEffect(() => {
    setHttpTrees({});
    setExpandedFiles({});
  }, [project?.id]);

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

  const readTree = async (relPath: string, silent = false) => {
    if (!project) return null;
    setLoadingHttpFile(true);
    try {
      const content = await readProjectFileContent(project.id, relPath);
      const parsed = parseHttpFile(content);
      setHttpTrees(prev => ({
        ...prev,
        [relPath]: { requests: parsed.requests, warnings: parsed.warnings, text: content },
      }));
      if (!silent) {
        const first = parsed.warnings[0];
        onNotify?.(
          first
            ? `已解析 ${relPath}（${parsed.requests.length} 个请求，${parsed.warnings.length} 处提示：${first.message}）`
            : `已解析用例文件：${relPath}（${parsed.requests.length} 个请求）`,
        );
      }
      return parsed;
    } catch (e) {
      onNotify?.(`读取文件失败：${e}`);
      return null;
    } finally {
      setLoadingHttpFile(false);
    }
  };

  const toggleHttpFile = async (relPath: string) => {
    if (!project) return;
    setSelectedHttpFile(relPath);
    setExpandedFiles(prev => ({ ...prev, [relPath]: !prev[relPath] }));
    if (!httpTrees[relPath]) await readTree(relPath);
  };

  const openRequestTab = (relPath: string, req: WorkspaceRequest) => {
    const existing = tabs.find(t => t.sourceFile === relPath && t.sourceLine === req.line);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    createTab(requestToTabPatch(req, relPath));
  };

  const reloadSourceIntoTab = async () => {
    if (!project || !active.sourceFile) return;
    const parsed = await readTree(active.sourceFile, true);
    const req = parsed?.requests.find(r => r.line === active.sourceLine);
    if (!req) {
      onNotify?.('源文件里已找不到该请求，请重新选择用例');
      return;
    }
    patchTab(active.id, prev => {
      const merged = { ...prev, ...requestToTabPatch(req, active.sourceFile!) };
      return { ...merged, baseline: requestSignature(merged) };
    });
    onNotify?.(`已重新载入：${req.name}`);
  };

  const writeBackActive = async () => {
    const sourceFile = active.sourceFile;
    if (!project || !sourceFile) return;
    setWritingBack(true);
    try {
      const content = await readProjectFileContent(project.id, sourceFile);
      const parsed = parseHttpFile(content);
      const located =
        parsed.requests.find(r => r.line === active.sourceLine) ??
        parsed.requests.find(r => r.name === active.loadedName);
      if (!located) {
        onNotify?.('写回失败：源文件里已找不到这段请求，请重新载入后再试');
        return;
      }
      const updated = tabToWorkspaceRequest(active);
      const next = replaceRequestInSource(content, located, updated);
      await writeProjectFile(project.id, sourceFile, next);
      const reparsed = parseHttpFile(next);
      const moved =
        reparsed.requests.find(r => r.name === updated.name) ??
        reparsed.requests.find(r => r.name === located.name);
      patchTab(active.id, prev => {
        const merged = { ...prev, ...(moved ? requestToTabPatch(moved, sourceFile) : {}) };
        return { ...merged, baseline: requestSignature(merged) };
      });
      setHttpTrees(prev => ({ ...prev, [sourceFile]: { requests: reparsed.requests, warnings: reparsed.warnings, text: next } }));
      onNotify?.(`✨ 已写回 ${sourceFile}，其余用例逐字节保留`);
      onRefresh?.();
    } catch (err) {
      onNotify?.(`写回失败：${err}`);
    } finally {
      setWritingBack(false);
    }
  };

  const applyCurlToActiveTab = () => {
    const text = curlImportText.trim();
    if (!text) {
      onNotify?.('请先粘贴 curl 命令');
      return;
    }
    try {
      const parsed = parseCurl(text);
      patchTab(active.id, prev => {
        const merged = { ...prev, ...curlToTabPatch(parsed, parsed.method) };
        return { ...merged, baseline: requestSignature(merged) };
      });
      setShowCurlModal(false);
      setCurlImportText('');
      const extra =
        parsed.unrecognized.length > 0 ? ` · 未识别参数：${parsed.unrecognized.join(' ')}` : '';
      onNotify?.(`✨ 已从 cURL 解析导入（${parsed.method} ${parsed.url}）${extra}`);
    } catch (err) {
      onNotify?.(`cURL 解析失败：${err}`);
    }
  };

  const persistCollection = async (nextFile: CollectionFile, msg: string) => {
    if (!project) return;
    try {
      await writeProjectFile(project.id, COLLECTION_PATH, serializeCollection(nextFile));
      setCollection(nextFile);
      onNotify?.(msg);
    } catch (err) {
      onNotify?.(`保存用例集失败：${err}`);
    }
  };

  const createFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    const node: CollectionNode = {
      id: nextWorkspaceId('col'),
      kind: 'folder',
      name,
      parentId: targetFolderId,
    };
    setExpandedFolders(prev => ({ ...prev, [node.id]: true }));
    setNewFolderName('');
    void persistCollection(upsertNode(collection, node), `已新建目录「${name}」`);
  };

  const saveActiveToCollection = () => {
    const name = (caseName.trim() || active.name).trim();
    if (!name) return;
    const id = active.collectionNodeId ?? nextWorkspaceId('col');
    const node: CollectionNode = {
      id,
      kind: 'case',
      name,
      parentId: targetFolderId,
      request: { ...tabToWorkspaceRequest(active), id, name },
    };
    patchTab(active.id, prev => {
      const merged = { ...prev, name, collectionNodeId: id };
      return { ...merged, baseline: requestSignature(merged) };
    });
    setCaseName('');
    void persistCollection(upsertNode(collection, node), `已存入用例集：${name}`);
  };

  const openCollectionCase = (node: CollectionNode) => {
    if (!node.request) return;
    const req: WorkspaceRequest = { ...node.request, id: node.request.id, name: node.name };
    const existing = tabs.find(t => t.collectionNodeId === node.id);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    createTab({ ...requestToTabPatch(req), collectionNodeId: node.id });
  };

  const removeCollectionNode = (node: CollectionNode) => {
    if (!window.confirm(`删除${node.kind === 'folder' ? '目录及其内容' : '用例'}「${node.name}」？`)) return;
    void persistCollection(removeNode(collection, node.id), `已删除「${node.name}」`);
  };

  const renderCollectionNodes = (parentId: string | null, depth: number): ReactNode[] =>
    childrenOf(collection, parentId).map(node => {
      const isFolder = node.kind === 'folder';
      const open = !!expandedFolders[node.id];
      const inTab = !isFolder && active.collectionNodeId === node.id;
      return (
        <div key={node.id} className="case-tree-file">
          <div
            className={`tree-row ${isFolder ? 'folder' : 'request'} ${inTab ? 'active' : ''}`}
            style={{ paddingLeft: 6 + depth * 12 }}
            onClick={() => {
              if (!isFolder) openCollectionCase(node);
            }}
            onDoubleClick={() => (isFolder ? setExpandedFolders(p => ({ ...p, [node.id]: !open })) : openCollectionCase(node))}
            title={isFolder ? '双击展开/收起目录' : '双击在新 Tab 打开该用例'}
          >
            {isFolder ? (
              <>
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                {open ? <FolderOpen size={12} /> : <Folder size={12} />}
              </>
            ) : (
              <span
                className={`method-badge-mini method-${(node.request?.method ?? 'GET').toLowerCase()}`}
              >
                {node.request?.method ?? 'REQ'}
              </span>
            )}
            <span className="tree-label">{node.name}</span>
            <button
              type="button"
              className="icon-button-sm"
              onClick={e => {
                e.stopPropagation();
                removeCollectionNode(node);
              }}
              title="删除"
            >
              <Trash2 size={11} />
            </button>
          </div>
          {isFolder && open && (
            <div className="tree-children">{renderCollectionNodes(node.id, depth + 1)}</div>
          )}
        </div>
      );
    });

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

  const generateHttpSnippet = (title?: string) =>
    serializeRequest({
      ...tabToWorkspaceRequest(active),
      name: title?.trim() || active.name,
      hasSeparator: true,
    });

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
      await readTree(targetPath, true).catch(() => null);
      setExpandedFiles(prev => ({ ...prev, [targetPath]: true }));
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
            <p>多 Tab 独立调试、.http／.rest 双协议读写、JSON 用例集、cURL 导入导出与历史快照。</p>
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
          {/* Left: .http 用例树 + JSON 用例集 */}
          <aside className="api-case-drawer">
            <div className="pane-header">
              <span className="subcard-title-sm">
                <FileCode size={13} /> 项目用例文件 ({httpPaths.length})
              </span>
              <button
                type="button"
                className="text-button-xs"
                onClick={() => httpPaths.forEach(p => void readTree(p, true))}
                title="重新解析全部用例文件"
              >
                <RefreshCw size={12} className={loadingHttpFile ? 'spin' : ''} />
              </button>
            </div>
            {httpPaths.length === 0 ? (
              <div className="history-empty">项目内暂无 .http / .rest 用例文件</div>
            ) : (
              <div className="case-tree">
                {httpPaths.map(path => {
                  const tree = httpTrees[path];
                  const expanded = !!expandedFiles[path];
                  return (
                    <div key={path} className="case-tree-file">
                      <button
                        type="button"
                        className={`tree-row file ${selectedHttpFile === path && expanded ? 'active' : ''}`}
                        onClick={() => void toggleHttpFile(path)}
                      >
                        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        {expanded ? <FolderOpen size={12} /> : <Folder size={12} />}
                        <span className="tree-label">{path}</span>
                        {tree && <span className="tree-count">{tree.requests.length}</span>}
                      </button>
                      {expanded && (
                        <div className="tree-children">
                          {!tree && (
                            <div className="tree-empty mono-subtle">
                              {loadingHttpFile ? '解析中…' : '点击文件名解析'}
                            </div>
                          )}
                          {tree?.requests.map(req => (
                            <div
                              key={req.id}
                              className={`tree-row request ${
                                active.sourceFile === path && active.sourceLine === req.line
                                  ? 'active'
                                  : ''
                              }`}
                              onDoubleClick={() => openRequestTab(path, req)}
                              title="双击在新 Tab 打开该请求"
                            >
                              <span className={`method-badge-mini method-${req.method.toLowerCase()}`}>
                                {req.method}
                              </span>
                              <span className="tree-label">{req.name}</span>
                            </div>
                          ))}
                          {tree && tree.requests.length === 0 && (
                            <div className="tree-empty mono-subtle">未识别到请求行</div>
                          )}
                          {tree?.warnings.map((w, idx) => (
                            <div key={`w-${w.line}-${idx}`} className="tree-warn mono-subtle">
                              L{w.line} {w.message}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="pane-header">
              <span className="subcard-title-sm">
                <Layers size={13} /> JSON 用例集 ({collection.nodes.length})
              </span>
              <button
                type="button"
                className="text-button-xs"
                onClick={() => setShowCollections(v => !v)}
              >
                {showCollections ? '收起' : '展开'}
              </button>
            </div>
            {showCollections && (
              <>
                <div className="case-tree">
                  {collection.nodes.length === 0 ? (
                    <div className="history-empty">暂无用例，先把当前请求「存入用例集」</div>
                  ) : (
                    renderCollectionNodes(null, 0)
                  )}
                </div>
                <div className="collection-tools">
                  <div className="collection-row">
                    <input
                      className="collection-input"
                      placeholder="新目录名"
                      value={newFolderName}
                      onChange={e => setNewFolderName(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') createFolder();
                      }}
                    />
                    <button type="button" className="text-button-sm" onClick={createFolder}>
                      <Folder size={12} />
                      新建目录
                    </button>
                  </div>
                  <div className="collection-row">
                    <input
                      className="collection-input"
                      placeholder="用例名（留空用当前 Tab 名）"
                      value={caseName}
                      onChange={e => setCaseName(e.target.value)}
                    />
                    <button
                      type="button"
                      className="text-button-sm"
                      onClick={saveActiveToCollection}
                    >
                      <Plus size={12} />
                      存入当前请求
                    </button>
                  </div>
                  <div className="collection-row">
                    <span className="preset-label">放入目录:</span>
                    <select
                      className="collection-select"
                      value={targetFolderId ?? ''}
                      onChange={e => setTargetFolderId(e.target.value || null)}
                    >
                      <option value="">根目录</option>
                      {collection.nodes
                        .filter(n => n.kind === 'folder')
                        .map(f => (
                          <option key={f.id} value={f.id}>
                            {f.name}
                          </option>
                        ))}
                    </select>
                  </div>
                </div>
              </>
            )}
          </aside>

          {/* Main Request & Response Section */}
          <div className="api-main-pane">

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

            {/* 请求 Tab 条：多标签独立状态 */}
            <div className="api-tab-strip" role="tablist" aria-label="接口请求 Tab">
              {tabs.map(tab => {
                const tabDirty = requestSignature(tab) !== tab.baseline;
                const isActive = tab.id === active.id;
                return (
                  <div
                    key={tab.id}
                    role="tab"
                    aria-selected={isActive}
                    tabIndex={0}
                    className={`api-tab ${isActive ? 'active' : ''}`}
                    onClick={() => setActiveTabId(tab.id)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') setActiveTabId(tab.id);
                    }}
                    title={`${tab.name}${tab.sourceFile ? ` · ${tab.sourceFile}` : ''}${tabDirty ? '（未保存）' : ''}`}
                  >
                    <span className={`method-badge-mini method-${tab.method.toLowerCase()}`}>
                      {tab.method}
                    </span>
                    <span className="api-tab-name">{tab.name}</span>
                    {tabDirty && <span className="tab-dirty-dot" title="有未保存的修改" />}
                    <button
                      type="button"
                      className="tab-close"
                      aria-label={`关闭 ${tab.name}`}
                      title="关闭（Ctrl+W）"
                      onClick={e => {
                        e.stopPropagation();
                        closeTab(tab.id);
                      }}
                    >
                      <X size={11} />
                    </button>
                  </div>
                );
              })}
              <button
                type="button"
                className="tab-add"
                onClick={() => createTab()}
                title="新建请求 Tab（Ctrl+W 关闭当前）"
              >
                <Plus size={12} />
                新建
              </button>
            </div>

            {/* HTTP Request Builder Workbench */}
            <section className="api-requester-card">
              <div className="api-case-meta">
                <input
                  className="case-name-input"
                  aria-label="用例名称"
                  placeholder="用例名称（写入 .http 的 ### 标题）"
                  value={active.name}
                  onChange={e => patchTab(active.id, { name: e.target.value })}
                />
                {active.sourceFile ? (
                  <>
                    <button
                      type="button"
                      className="secondary-button-sm"
                      disabled={writingBack}
                      onClick={() => void writeBackActive()}
                      title={`只改写 ${active.sourceFile} 中该请求所占的行区间`}
                    >
                      {writingBack ? (
                        <LoaderCircle size={12} className="spin" />
                      ) : (
                        <Check size={12} />
                      )}
                      写回源文件
                    </button>
                    <button
                      type="button"
                      className="secondary-button-sm"
                      onClick={() => void reloadSourceIntoTab()}
                      title="丢弃本地改动，按原位置重新载入"
                    >
                      <RefreshCw size={12} />
                      重新载入
                    </button>
                    <span className="mono-subtle">源：{active.sourceFile}</span>
                  </>
                ) : (
                  <button
                    type="button"
                    className="secondary-button-sm"
                    onClick={saveActiveToCollection}
                    title="存入项目 JSON 用例集"
                  >
                    <Layers size={12} />
                    存入用例集
                  </button>
                )}
                {dirty && <span className="tab-dirty-hint">未保存的修改</span>}
              </div>

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
              <button className="primary-button" onClick={applyCurlToActiveTab}>
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
