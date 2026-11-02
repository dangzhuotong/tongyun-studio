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
  PUBLIC_ENV_FILE,
  PRIVATE_ENV_FILE,
  loadEnvFiles,
  substitute,
  findMissingVars,
  runAssertions,
  runExtractions,
  type ApiAssertion,
  type AssertionKind,
  type AssertionResult,
  type EnvPreset,
  type ExtractRule,
  type ExtractSource,
  type ExtractionResult,
} from './apiEnv';
import {
  CODE_TARGETS,
  generateRequestCode,
  type CodegenRequest,
  type CodeTarget,
} from './apiCodegen';
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
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Trash2,
  Workflow,
  X,
  Zap,
} from '../components/Icons';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD';

interface ParamRow {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  runtime?: boolean;
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
  /** 编辑器子页（Params/Headers/Auth/Body/断言/提取），逐 Tab 独立，避免串台 */
  section: 'params' | 'headers' | 'auth' | 'body' | 'assert' | 'extract';
  /** 该 Tab 选中的环境预设名 */
  envName: string;
  /** 该 Tab 的手动环境变量行；运行时提取值另存共享池 */
  envVars: ParamRow[];
  assertions: ApiAssertion[];
  assertionResults: AssertionResult[];
  extractRules: ExtractRule[];
  extractResults: ExtractionResult[];
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
type TabField =
  | EditableField
  | 'response'
  | 'sending'
  | 'name'
  | 'section'
  | 'envName'
  | 'envVars'
  | 'assertions'
  | 'assertionResults'
  | 'extractRules'
  | 'extractResults';

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
    section: 'params',
    envName: '',
    envVars: [{ id: 'e1', key: 'baseUrl', value: 'http://localhost:3000', enabled: true }],
    assertions: [{ id: 'a1', kind: 'status', enabled: true, name: '', expected: '200' }],
    assertionResults: [],
    extractRules: [],
    extractResults: [],
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
  const [sending] = bindField('sending');

  // Environments（运行时提取值共享池；手动行与环境预设逐 Tab）
  const [envVars, setEnvVars] = useState<ParamRow[]>([]);
  const [envPresets, setEnvPresets] = useState<EnvPreset[]>([]);
  const [loadingEnvFiles, setLoadingEnvFiles] = useState(false);
  const [envSourceNote, setEnvSourceNote] = useState('');
  const [showEnvModal, setShowEnvModal] = useState(false);

  // 逐 Tab 编辑器子页与环境/断言/提取绑定到 active
  const [section, setSection] = bindField('section');
  const [envName, setEnvName] = bindField('envName');
  const [, setTabEnvVars] = bindField('envVars');
  const [assertions, setAssertions] = bindField('assertions');
  const [extractRules, setExtractRules] = bindField('extractRules');

  // Code generation
  const [showCodeModal, setShowCodeModal] = useState(false);
  const [codeTarget, setCodeTarget] = useState<CodeTarget>('curl');

  // Execution
  const [responseTab, setResponseTab] = useState<'body' | 'headers'>('body');
  const [copiedBody, setCopiedBody] = useState(false);

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

  // Variable resolution: per-tab preset + tab manual rows, then session runtime rows
  const presetFor = (name: string): EnvPreset | null =>
    envPresets.find(p => p.name === name) ?? null;

  const varsForTab = (tab: RequestTab): Record<string, string> => {
    const manual: Record<string, string> = {};
    for (const ev of tab.envVars) {
      if (ev.enabled && ev.key.trim()) manual[ev.key.trim()] = ev.value;
    }
    const runtime: Record<string, string> = {};
    for (const ev of envVars) {
      if (ev.runtime && ev.enabled && ev.key.trim()) runtime[ev.key.trim()] = ev.value;
    }
    return { ...(presetFor(tab.envName)?.vars ?? {}), ...manual, ...runtime };
  };

  const missingVarsFor = (tab: RequestTab): string[] => {
    const vars = varsForTab(tab);
    return findMissingVars(
      [
        tab.url,
        ...tab.params.filter(p => p.enabled && p.key.trim()).map(p => p.value),
        ...tab.headers.filter(h => h.enabled && h.key.trim()).map(h => h.value),
        tab.authType === 'bearer' ? tab.bearerToken : '',
        tab.method !== 'GET' && tab.method !== 'HEAD' ? tab.body : '',
      ],
      vars,
    );
  };

  const missingVars = missingVarsFor(active);
  const activePreset = presetFor(active.envName);
  const activeVars = varsForTab(active);

  // 弹窗视图：当前 Tab 手动行 + 会话运行时池（同名时运行时行展示并可编辑）
  const envModalRows: ParamRow[] = [
    ...active.envVars.filter(m => !envVars.some(r => r.runtime && r.key.trim() === m.key.trim())),
    ...envVars,
  ];

  /** 弹窗行编辑：优先命中运行时池行，否则落到当前 Tab 的手动行 */
  const updateEnvModalRow = (id: string, field: 'key' | 'value' | 'enabled', val: string | boolean) => {
    const updater = (rows: ParamRow[]) =>
      rows.map(item => (item.id === id ? { ...item, [field]: val } : item));
    if (envVars.some(item => item.id === id)) setEnvVars(updater);
    else setTabEnvVars(updater);
  };

  const removeEnvModalRow = (id: string) => {
    const updater = (rows: ParamRow[]) => rows.filter(item => item.id !== id);
    if (envVars.some(item => item.id === id)) setEnvVars(updater);
    else setTabEnvVars(updater);
  };

  const buildTargetUrlFor = (tab: RequestTab): string => {
    const vars = varsForTab(tab);
    let raw = substitute(tab.url.trim(), vars).text;
    const activeParams = tab.params.filter(p => p.enabled && p.key.trim());
    if (activeParams.length > 0) {
      const searchParams = new URLSearchParams();
      for (const p of activeParams) {
        searchParams.append(p.key.trim(), substitute(p.value.trim(), vars).text);
      }
      const delimiter = raw.includes('?') ? '&' : '?';
      raw += `${delimiter}${searchParams.toString()}`;
    }
    return raw;
  };

  const buildResolvedRequest = (tab: RequestTab): CodegenRequest => {
    const vars = varsForTab(tab);
    const activeHeaders: [string, string][] = tab.headers
      .filter(h => h.enabled && h.key.trim())
      .map(h => [h.key.trim(), substitute(h.value.trim(), vars).text]);

    if (tab.authType === 'bearer' && tab.bearerToken.trim()) {
      activeHeaders.push(['Authorization', `Bearer ${substitute(tab.bearerToken.trim(), vars).text}`]);
    } else if (tab.authType === 'basic' && (tab.basicUser || tab.basicPass)) {
      const credentials = btoa(`${tab.basicUser}:${tab.basicPass}`);
      activeHeaders.push(['Authorization', `Basic ${credentials}`]);
    }

    const reqBody =
      tab.method !== 'GET' && tab.method !== 'HEAD' && tab.body.trim()
        ? substitute(tab.body, vars).text
        : undefined;

    return { method: tab.method, url: buildTargetUrlFor(tab), headers: activeHeaders, body: reqBody };
  };

  const assertionPassedCount = active.assertionResults.filter(item => item.passed).length;
  const assertionsAllPassed =
    active.assertionResults.length > 0 && assertionPassedCount === active.assertionResults.length;

  const loadProjectEnvFiles = async () => {
    if (!project) return;
    setLoadingEnvFiles(true);
    try {
      const [publicContent, privateContent] = await Promise.all([
        readProjectFileContent(project.id, PUBLIC_ENV_FILE).catch(() => null),
        readProjectFileContent(project.id, PRIVATE_ENV_FILE).catch(() => null),
      ]);
      if (publicContent === null && privateContent === null) {
        setEnvSourceNote('项目根目录没有环境文件');
        onNotify?.(`未找到 ${PUBLIC_ENV_FILE}，仍可只用手动变量`);
      } else {
        const presets = loadEnvFiles(publicContent, privateContent);
        setEnvPresets(presets);
        const sendingTabId = active.id;
        setTabs(prev =>
          prev.map(t =>
            t.id === sendingTabId
              ? {
                  ...t,
                  envName: presets.some(p => p.name === t.envName)
                    ? t.envName
                    : (presets[0]?.name ?? ''),
                }
              : t,
          ),
        );
        setEnvSourceNote(
          [
            publicContent !== null ? PUBLIC_ENV_FILE : null,
            privateContent !== null ? PRIVATE_ENV_FILE : null,
          ]
            .filter(Boolean)
            .join(' + '),
        );
        onNotify?.(
          presets.length > 0
            ? `已载入 ${presets.length} 个环境预设：${presets.map(p => p.name).join('、')}`
            : '环境文件解析后没有可用预设',
        );
      }
    } catch (err) {
      onNotify?.(`读取环境文件失败：${err}`);
    } finally {
      setLoadingEnvFiles(false);
    }
  };

  /** 提取值进会话共享运行时池：链式引用跨 Tab 可用，但不回写各 Tab 的手动行 */
  const applyExtractedVars = (results: ExtractionResult[]) => {
    const updates = results.filter(r => r.value !== null);
    if (updates.length === 0) return;
    setEnvVars(prev => {
      const next = [...prev];
      for (const update of updates) {
        const index = next.findIndex(item => item.key.trim() === update.variable);
        if (index >= 0) {
          next[index] = {
            ...next[index],
            value: update.value as string,
            enabled: true,
            runtime: true,
          };
        } else {
          next.push({
            id: `rt_${Math.random().toString(36).slice(2, 9)}`,
            key: update.variable,
            value: update.value as string,
            enabled: true,
            runtime: true,
          });
        }
      }
      return next;
    });
  };

  const addRow = (type: 'params' | 'headers' | 'env') => {
    const newRow = { id: nextWorkspaceId('row'), key: '', value: '', enabled: true };
    if (type === 'params') setParams(p => [...p, newRow]);
    else if (type === 'headers') setHeaders(h => [...h, newRow]);
    else setTabEnvVars(e => [...e, newRow]);
  };

  const removeRow = (type: 'params' | 'headers' | 'env', id: string) => {
    if (type === 'params') setParams(p => p.filter(item => item.id !== id));
    else if (type === 'headers') setHeaders(h => h.filter(item => item.id !== id));
    else setTabEnvVars(e => e.filter(item => item.id !== id));
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
    else setTabEnvVars(updater);
  };

  const handleSend = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    const tab = active;
    if (!tab.url.trim() || tab.sending) return;
    const tabMissing = missingVarsFor(tab);
    if (tabMissing.length > 0) {
      onNotify?.(`变量未解析：${tabMissing.map(v => `{{${v}}}`).join('、')}`);
      return;
    }

    const tabId = tab.id;
    const startPatch = (prev: RequestTab): Partial<RequestTab> => ({
      ...prev,
      sending: true,
      response: null,
      assertionResults: [],
      extractResults: [],
    });
    patchTab(tabId, startPatch);
    try {
      const request = buildResolvedRequest(tab);
      const res = await sendHttpRequest(
        request.method,
        request.url,
        request.headers,
        request.body,
      );

      const assertionRun = runAssertions(tab.assertions, res);
      const extractionRun = runExtractions(tab.extractRules, res);
      applyExtractedVars(extractionRun);

      const recordedCurl = generateRequestCode('curl', request);

      // 结果只落回发起请求的 Tab；期间切了 Tab 也不串台
      patchTab(tabId, prev => ({
        ...prev,
        sending: false,
        response: res,
        assertionResults: assertionRun,
        extractResults: extractionRun,
      }));

      setHistory(prev => [
        {
          id: Math.random().toString(36).slice(2, 9),
          method: tab.method,
          url: request.url,
          status: res.status,
          latencyMs: res.latencyMs,
          timestamp: new Date().toLocaleTimeString(),
          curl: recordedCurl,
        },
        ...prev.slice(0, 19),
      ]);

      const assertionsFailed = assertionRun.some(item => !item.passed);
      const extractedCount = extractionRun.filter(item => item.value !== null).length;
      const suffix = extractedCount > 0 ? `，已提取 ${extractedCount} 个变量` : '';
      const verdict =
        assertionRun.length === 0
          ? ''
          : assertionsFailed
            ? '，断言未通过'
            : '，断言全部通过';
      onNotify?.(`HTTP ${res.status} ${res.statusText} (${res.latencyMs}ms)${verdict}${suffix}`);
    } catch (err) {
      patchTab(tabId, prev => ({
        ...prev,
        sending: false,
        response: {
          status: 0,
          statusText: 'Request Failed',
          headers: [],
          body: String(err),
          latencyMs: 0,
        },
        assertionResults: [],
        extractResults: [],
      }));
      onNotify?.(`请求失败：${err}`);
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

  const exportAsCurl = () => {
    navigator.clipboard.writeText(generateRequestCode('curl', buildResolvedRequest(active)));
    onNotify?.('已复制 cURL 完整命令');
  };

  const generatedCode = () => generateRequestCode(codeTarget, buildResolvedRequest(active));

  const copyGeneratedCode = () => {
    navigator.clipboard.writeText(generatedCode());
    onNotify?.(`已复制 ${CODE_TARGETS.find(t => t.id === codeTarget)?.label ?? ''} 代码`);
  };

  const addAssertion = (kind: AssertionKind) => {
    setAssertions(prev => [
      ...prev,
      {
        id: `a_${Math.random().toString(36).slice(2, 9)}`,
        kind,
        enabled: true,
        name: '',
        expected: kind === 'status' ? '200' : kind === 'latency' ? '500' : '',
      },
    ]);
  };

  const patchAssertion = (id: string, patch: Partial<ApiAssertion>) => {
    setAssertions(prev => prev.map(item => (item.id === id ? { ...item, ...patch } : item)));
  };

  const removeAssertion = (id: string) => {
    setAssertions(prev => prev.filter(item => item.id !== id));
  };

  const addExtractRule = () => {
    setExtractRules(prev => [
      ...prev,
      {
        id: `x_${Math.random().toString(36).slice(2, 9)}`,
        enabled: true,
        variable: '',
        source: 'body' as ExtractSource,
        path: '',
      },
    ]);
  };

  const patchExtractRule = (id: string, patch: Partial<ExtractRule>) => {
    setExtractRules(prev => prev.map(item => (item.id === id ? { ...item, ...patch } : item)));
  };

  const removeExtractRule = (id: string) => {
    setExtractRules(prev => prev.filter(item => item.id !== id));
  };

  const copyResponseBody = () => {
    const res = active.response;
    if (!res) return;
    navigator.clipboard.writeText(res.body);
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
            <p>
              多 Tab 独立调试、.http／.rest 双协议读写、JSON 用例集、环境预设级联（{`{{baseUrl}}`}）、断言与变量提取、7 种语言代码生成与 cURL 导入导出。
            </p>
          </div>
        </div>
        <div className="workbench-badges">
          <button className="secondary-button-sm" onClick={() => setShowEnvModal(true)}>
            <Key size={12} />
            环境变量 ({active.envVars.length + envVars.length})
          </button>
          <button className="secondary-button-sm" onClick={() => setShowCodeModal(true)}>
            <Zap size={12} />
            代码生成
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

            {/* Environment presets & resolution（逐 Tab 生效） */}
            <section className="api-env-bar">
              <div className="env-bar-group">
                <span className="env-bar-label">环境</span>
                <select
                  className="env-select"
                  aria-label="环境预设"
                  value={envName}
                  onChange={e => setEnvName(e.target.value)}
                >
                  <option value="">未选择预设</option>
                  {envPresets.map(p => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="text-button-sm"
                  onClick={() => void loadProjectEnvFiles()}
                  disabled={loadingEnvFiles}
                >
                  {loadingEnvFiles ? (
                    <LoaderCircle size={12} className="spin" />
                  ) : (
                    <RefreshCw size={12} />
                  )}
                  读取 http-client.env.json
                </button>
              </div>
              <div className="env-bar-group">
                <span className="env-bar-meta">
                  {activePreset
                    ? `预设 ${Object.keys(activePreset.vars).length} 个变量`
                    : '仅手动／运行时变量'}{' '}
                  · 生效 {Object.keys(activeVars).length} 个
                </span>
                {envSourceNote && <span className="env-source-note">{envSourceNote}</span>}
                <button className="text-button-sm" onClick={() => setShowEnvModal(true)}>
                  <Key size={12} />
                  编辑变量
                </button>
              </div>
            </section>

            {missingVars.length > 0 && (
              <div className="env-missing-banner" role="alert">
                <ShieldAlert size={13} />
                <span>
                  当前环境缺少变量 {missingVars.map(v => `{{${v}}}`).join('、')}
                  ，切换环境或补全变量后才能发送。
                </span>
              </div>
            )}

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
                  disabled={sending || !url.trim() || missingVars.length > 0}
                  title={
                    missingVars.length > 0
                      ? `变量未解析：${missingVars.map(v => `{{${v}}}`).join('、')}`
                      : undefined
                  }
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
                    className={section === 'params' ? 'active' : ''}
                    onClick={() => setSection('params')}
                  >
                    Params ({params.filter(p => p.enabled && p.key).length})
                  </button>
                  <button
                    type="button"
                    className={section === 'headers' ? 'active' : ''}
                    onClick={() => setSection('headers')}
                  >
                    Headers ({headers.filter(h => h.enabled && h.key).length})
                  </button>
                  <button
                    type="button"
                    className={section === 'auth' ? 'active' : ''}
                    onClick={() => setSection('auth')}
                  >
                    Auth {authType !== 'none' ? `(${authType})` : ''}
                  </button>
                  <button
                    type="button"
                    className={section === 'body' ? 'active' : ''}
                    onClick={() => setSection('body')}
                  >
                    Body
                  </button>
                  <button
                    type="button"
                    className={section === 'assert' ? 'active' : ''}
                    onClick={() => setSection('assert')}
                  >
                    <Zap size={11} /> 断言 (
                    {assertions.filter(a => a.enabled).length})
                  </button>
                  <button
                    type="button"
                    className={section === 'extract' ? 'active' : ''}
                    onClick={() => setSection('extract')}
                  >
                    <Workflow size={11} /> 提取 (
                    {extractRules.filter(r => r.enabled).length})
                  </button>
                </div>

                {section === 'params' && (
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

                {section === 'headers' && (
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

                {section === 'auth' && (
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

                {section === 'body' && (
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

                {section === 'assert' && (
                  <div className="rule-editor">
                    <div className="key-val-table rule-table">
                      <div className="table-row-head">
                        <span />
                        <span>断言类型</span>
                        <span>目标 (Header 名 / JSON 路径)</span>
                        <span>期望值</span>
                        <span />
                      </div>
                      {assertions.map(rule => (
                        <div key={rule.id} className="table-row-item">
                          <input
                            type="checkbox"
                            checked={rule.enabled}
                            onChange={e => patchAssertion(rule.id, { enabled: e.target.checked })}
                          />
                          <select
                            aria-label="断言类型"
                            value={rule.kind}
                            onChange={e =>
                              patchAssertion(rule.id, { kind: e.target.value as AssertionKind })
                            }
                          >
                            <option value="status">状态码</option>
                            <option value="latency">时延上限 (ms)</option>
                            <option value="header">响应头</option>
                            <option value="json">JSON 字段</option>
                          </select>
                          <input
                            placeholder={
                              rule.kind === 'header'
                                ? 'X-Request-Id'
                                : rule.kind === 'json'
                                  ? 'data.code'
                                  : '无需填写'
                            }
                            value={rule.name}
                            disabled={rule.kind === 'status' || rule.kind === 'latency'}
                            onChange={e => patchAssertion(rule.id, { name: e.target.value })}
                          />
                          <input
                            placeholder={
                              rule.kind === 'status'
                                ? '200,201'
                                : rule.kind === 'latency'
                                  ? '500'
                                  : rule.kind === 'header'
                                    ? 'application/json（留空=只判断存在）'
                                    : '0（留空=只判断存在）'
                            }
                            value={rule.expected}
                            onChange={e => patchAssertion(rule.id, { expected: e.target.value })}
                          />
                          <button
                            type="button"
                            className="icon-button-sm"
                            onClick={() => removeAssertion(rule.id)}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="rule-add-row">
                      <button type="button" className="text-button-sm" onClick={() => addAssertion('status')}>
                        <Plus size={12} /> 状态码
                      </button>
                      <button type="button" className="text-button-sm" onClick={() => addAssertion('latency')}>
                        <Plus size={12} /> 时延上限
                      </button>
                      <button type="button" className="text-button-sm" onClick={() => addAssertion('header')}>
                        <Plus size={12} /> 响应头
                      </button>
                      <button type="button" className="text-button-sm" onClick={() => addAssertion('json')}>
                        <Plus size={12} /> JSON 字段
                      </button>
                    </div>
                    <p className="rule-hint">
                      发送后按启用的规则自动判定，结果显示在响应区；期望值留空表示只判断存在。
                    </p>
                  </div>
                )}

                {section === 'extract' && (
                  <div className="rule-editor">
                    <div className="key-val-table rule-table">
                      <div className="table-row-head">
                        <span />
                        <span>目标变量</span>
                        <span>来源</span>
                        <span>字段路径 / Header 名</span>
                        <span />
                      </div>
                      {extractRules.map(rule => (
                        <div key={rule.id} className="table-row-item">
                          <input
                            type="checkbox"
                            checked={rule.enabled}
                            onChange={e => patchExtractRule(rule.id, { enabled: e.target.checked })}
                          />
                          <input
                            placeholder="token"
                            value={rule.variable}
                            onChange={e => patchExtractRule(rule.id, { variable: e.target.value })}
                          />
                          <select
                            aria-label="提取来源"
                            value={rule.source}
                            onChange={e =>
                              patchExtractRule(rule.id, { source: e.target.value as ExtractSource })
                            }
                          >
                            <option value="body">响应体 JSON</option>
                            <option value="header">响应头</option>
                          </select>
                          <input
                            placeholder={rule.source === 'header' ? 'X-Token' : 'data.token'}
                            value={rule.path}
                            onChange={e => patchExtractRule(rule.id, { path: e.target.value })}
                          />
                          <button
                            type="button"
                            className="icon-button-sm"
                            onClick={() => removeExtractRule(rule.id)}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="rule-add-row">
                      <button type="button" className="text-button-sm" onClick={addExtractRule}>
                        <Plus size={12} /> 添加提取规则
                      </button>
                    </div>
                    <p className="rule-hint">
                      提取值写入当前会话的环境变量，下一个请求可直接用 {'{{变量名}}'} 引用。
                    </p>
                    {active.extractResults.length > 0 && (
                      <div className="extract-result-list">
                        {active.extractResults.map(item => (
                          <div
                            key={item.id}
                            className={`extract-result ${item.value === null ? 'failed' : 'passed'}`}
                          >
                            <span className="extract-source">
                              {item.source === 'header' ? 'Header' : 'JSON'} ·{' '}
                              <code>{item.path || '(未填写)'}</code>
                            </span>
                            <span className="extract-value">
                              {item.value === null ? '—' : <code>{`{{${item.variable}}} = ${item.value}`}</code>}
                            </span>
                            <span className="extract-reason">{item.reason}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </section>

            {/* HTTP Response Panel */}
            {active.response && (
              <section className="api-response-card">
                <div className="response-header">
                  <div className="response-meta">
                    <span
                      className={`status-pill ${
                        active.response.status >= 200 && active.response.status < 300
                          ? 'status-success'
                          : active.response.status >= 400
                          ? 'status-client-error'
                          : 'status-server-error'
                      }`}
                    >
                      {active.response.status} {active.response.statusText}
                    </span>
                    <span className="latency-badge">{active.response.latencyMs} ms</span>
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
                      响应头 ({active.response.headers.length})
                    </button>
                    <button
                      className="terminal-btn"
                      onClick={exportAsCurl}
                      title="复制此请求的 cURL 命令"
                    >
                      <Terminal size={12} />
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

                {active.assertionResults.length > 0 && (
                  <div className={`assertion-card ${assertionsAllPassed ? 'all-pass' : 'has-fail'}`}>
                    <div className="assertion-card-head">
                      <span className="assertion-title">
                        {assertionsAllPassed ? <ShieldCheck size={13} /> : <ShieldAlert size={13} />}
                        断言测试 {assertionPassedCount}/{active.assertionResults.length} 通过
                      </span>
                      <span
                        className={`assertion-verdict ${assertionsAllPassed ? 'passed' : 'failed'}`}
                      >
                        {assertionsAllPassed ? 'Passed' : 'Failed'}
                      </span>
                    </div>
                    <ul className="assertion-list">
                      {active.assertionResults.map(item => (
                        <li key={item.id} className={item.passed ? 'pass' : 'fail'}>
                          <span className={`assertion-flag ${item.passed ? 'pass' : 'fail'}`}>
                            {item.passed ? <Check size={11} /> : <X size={11} />}
                            {item.kind}
                          </span>
                          <span className="assertion-label">{item.label}</span>
                          <span className="assertion-actual">实际 {item.actual}</span>
                          <span className="assertion-reason">{item.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {responseTab === 'body' ? (
                  <div className="response-body-view">
                    <pre className="response-pre">
                      {(() => {
                        try {
                          const parsed = JSON.parse(active.response.body);
                          return JSON.stringify(parsed, null, 2);
                        } catch {
                          return active.response.body || '(空响应体)';
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
                        {active.response.headers.map(([k, v], idx) => (
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
                          const curl =
                            item.curl ??
                            generateRequestCode('curl', {
                              method: item.method,
                              url: item.url,
                              headers: [],
                            });
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
              {activePreset && (
                <div className="env-preset-block">
                  <div className="env-preset-head">
                    <span className="preset-label">环境预设：{activePreset.name}</span>
                    <span className="env-bar-meta">
                      {envSourceNote ? `来源 ${envSourceNote}` : '来自项目环境文件'}
                    </span>
                  </div>
                  <div className="env-preset-grid">
                    {Object.entries(activePreset.vars).map(([name, value]) => (
                      <div key={name} className="env-preset-row">
                        <code className="env-preset-key">{name}</code>
                        <code className="env-preset-value">{value}</code>
                      </div>
                    ))}
                  </div>
                  <p className="rule-hint">预设值只读，手动／运行时变量同名时覆盖预设。</p>
                </div>
              )}
              <div className="key-val-editor">
                <div className="key-val-table env-var-table">
                  <div className="table-row-head">
                    <span />
                    <span>变量名 (Key)</span>
                    <span>变量值 (Value)</span>
                    <span>来源</span>
                    <span />
                  </div>
                  {envModalRows.map(ev => (
                    <div key={ev.id} className="table-row-item">
                      <input
                        type="checkbox"
                        checked={ev.enabled}
                        onChange={e => updateEnvModalRow(ev.id, 'enabled', e.target.checked)}
                      />
                      <input
                        placeholder="baseUrl"
                        value={ev.key}
                        onChange={e => updateEnvModalRow(ev.id, 'key', e.target.value)}
                      />
                      <input
                        placeholder="http://127.0.0.1:3000"
                        value={ev.value}
                        onChange={e => updateEnvModalRow(ev.id, 'value', e.target.value)}
                      />
                      <span className={`var-origin ${ev.runtime ? 'runtime' : ''}`}>
                        {ev.runtime ? '运行时提取' : '手动'}
                      </span>
                      <button
                        type="button"
                        className="icon-button-sm"
                        onClick={() => removeEnvModalRow(ev.id)}
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
              <button className="secondary-button" onClick={() => void loadProjectEnvFiles()}>
                <RefreshCw size={13} />
                重新读取项目环境
              </button>
              <button className="primary-button" onClick={() => setShowEnvModal(false)}>
                完成
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Code Generation Modal */}
      {showCodeModal && (
        <div className="modal-overlay" onClick={() => setShowCodeModal(false)}>
          <div className="modal-dialog codegen-dialog" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>多语言客户端代码生成</h2>
            </div>
            <div className="modal-body">
              <div className="codegen-tabs">
                {CODE_TARGETS.map(target => (
                  <button
                    key={target.id}
                    type="button"
                    className={`codegen-tab ${codeTarget === target.id ? 'active' : ''}`}
                    onClick={() => setCodeTarget(target.id)}
                    title={target.hint}
                  >
                    {target.label}
                  </button>
                ))}
              </div>
              <pre className="codegen-preview">{generatedCode()}</pre>
              <p className="rule-hint">
                代码按当前环境的实际替换结果生成；切换语言或修改请求后内容同步更新。
              </p>
            </div>
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setShowCodeModal(false)}>
                关闭
              </button>
              <button className="primary-button" onClick={copyGeneratedCode}>
                <Copy size={13} />
                复制代码
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
