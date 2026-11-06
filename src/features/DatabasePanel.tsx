import { useEffect, useRef, useState } from 'react';
import type {
  Project,
  ProjectInspection,
  DbTableInfo,
  DbColumnInfo,
  PaginatedData,
  RowChangePlan,
  AgentSessionState,
  SavedDbConnection,
  DbConnectionInput,
  DbEngineKind,
  DbProbeResult,
} from '../contracts';
import {
  executeSqlQuery,
  getDbTables,
  getTableColumns,
  getTableData,
  planRowChange,
  readProjectFileContent,
  openProjectFile,
  isDesktop,
  listDbConnections,
  saveDbConnection,
  deleteDbConnection,
  testDbConnection,
  connectionTables,
  connectionColumns,
  connectionRedisKeys,
  runConnectionQuery,
} from '../bridge';
import {
  applyTabResult,
  buildColumnChanges,
  closeQueryTab,
  createQueryTab,
  cursorForPage,
  formatPlanForClipboard,
  rememberCursor,
  renameQueryTab,
  templateSql,
  toCsv,
  toJson,
  type QueryTab,
  type TemplateKind,
} from './dbWorkspace';
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Database,
  Download,
  ExternalLink,
  FileCode,
  Key,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Table,
  Trash2,
  X,
} from '../components/Icons';

const PAGE_SIZES = [20, 50, 100, 200];

const ENGINE_LABEL: Record<DbEngineKind, string> = {
  sqlite: 'SQLite',
  mysql: 'MySQL',
  postgres: 'PostgreSQL',
  redis: 'Redis',
};

const PORT_BY_ENGINE: Record<DbEngineKind, number> = {
  sqlite: 0,
  mysql: 3306,
  postgres: 5432,
  redis: 6379,
};

const quoteIdent = (engine: DbEngineKind, name: string) =>
  engine === 'mysql' ? `\`${name.replace(/`/g, '')}\`` : `"${name.replace(/"/g, '')}"`;

const unsafeIdent = (name: string) => /["`;]/.test(name) || /\s/.test(name);

// 已保存记录回填表单；password 为 null 表示沿用后端已加密保存的口令。
const draftFrom = (conn: SavedDbConnection): DbConnectionInput => ({
  id: conn.id,
  name: conn.name,
  engine: conn.engine,
  host: conn.host,
  port: conn.engine === 'sqlite' ? null : conn.port,
  user: conn.user,
  password: null,
  database: conn.database,
  tls: conn.tls,
  readOnly: conn.readOnly,
  revision: conn.revision,
});

export default function DatabasePanel({
  project,
  inspection,
  session,
  onNotify,
}: {
  project: Project | null;
  inspection?: ProjectInspection | null;
  session?: AgentSessionState | null;
  onRefresh?: () => void;
  onNotify?: (msg: string) => void;
}) {
  const artifacts = inspection?.dbArtifacts ?? [];
  const sqliteFiles = artifacts.filter(
    a => a.name.endsWith('.db') || a.name.endsWith('.sqlite') || a.name.endsWith('.sqlite3'),
  );

  const [dbPath, setDbPath] = useState(sqliteFiles[0]?.path ?? 'local.db');

  // Object tree state
  const [tables, setTables] = useState<DbTableInfo[]>([]);
  const [loadingTables, setLoadingTables] = useState(false);
  const [expandedTable, setExpandedTable] = useState<string | null>(null);
  const [columnsMap, setColumnsMap] = useState<Record<string, DbColumnInfo[]>>({});

  // Active view: 'data' (table grid) | 'sql' (custom query) | 'schema' (file preview)
  const [activeView, setActiveView] = useState<'data' | 'sql' | 'schema'>('data');
  const [selectedTable, setSelectedTable] = useState<string | null>(null);

  // Paginated Table Data
  const [paginatedData, setPaginatedData] = useState<PaginatedData | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [loadingData, setLoadingData] = useState(false);
  const [sortBy, setSortBy] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [cursorStack, setCursorStack] = useState<Record<number, string>>({});
  const loadToken = useRef(0);

  // SQL console: one tab per query, each keeping its own text, source and result.
  const [queryTabs, setQueryTabs] = useState<QueryTab[]>(() => [
    {
      id: 'tab-initial',
      name: '查询 1',
      sql: "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name;",
      dbPath: sqliteFiles[0]?.path ?? 'local.db',
      result: null,
      running: false,
    },
  ]);
  const [activeTabId, setActiveTabId] = useState('tab-initial');
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const activeTab = queryTabs.find(tab => tab.id === activeTabId) ?? queryTabs[0];

  // Row edit with change control preview
  const [editingRowIndex, setEditingRowIndex] = useState<number | null>(null);
  const [rowEdits, setRowEdits] = useState<Record<number, string>>({});
  const [changePlan, setChangePlan] = useState<RowChangePlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planConfirmed, setPlanConfirmed] = useState(false);

  const [errorText, setErrorText] = useState<string | null>(null);

  // Schema file preview
  const [selectedSchemaFile, setSelectedSchemaFile] = useState<string | null>(null);
  const [schemaContent, setSchemaContent] = useState<string | null>(null);

  const agentSqlActions = (session?.actions ?? []).filter(a => a.kind === 'sql');

  // 通用连接管理器：外部 SQLite / MySQL / PostgreSQL / Redis
  const [connections, setConnections] = useState<SavedDbConnection[]>([]);
  const [activeConn, setActiveConn] = useState<SavedDbConnection | null>(null);
  const [draft, setDraft] = useState<DbConnectionInput | null>(null);
  const [passwordDraft, setPasswordDraft] = useState('');
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [probe, setProbe] = useState<DbProbeResult | null>(null);
  const [connError, setConnError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [savingConn, setSavingConn] = useState(false);
  // 切换数据源后丢弃在途结果，避免异步串台。
  const seq = useRef(0);

  const reloadConnections = async () => {
    if (!isDesktop) return;
    try {
      setConnections(await listDbConnections());
    } catch (error) {
      onNotify?.(`读取连接列表失败：${error}`);
    }
  };

  useEffect(() => {
    void reloadConnections();
  }, []);

  const blankDraft = (engine: DbEngineKind = 'mysql'): DbConnectionInput => ({
    id: '',
    name: '',
    engine,
    host: '',
    port: engine === 'sqlite' ? null : PORT_BY_ENGINE[engine],
    user: '',
    password: null,
    database: '',
    tls: false,
    readOnly: true,
    revision: null,
  });

  const openNewDialog = () => {
    setDraft(blankDraft());
    setPasswordDraft('');
    setPasswordTouched(false);
    setProbe(null);
    setConnError(null);
  };

  const openEditDialog = (conn: SavedDbConnection) => {
    setDraft(draftFrom(conn));
    setPasswordDraft('');
    setPasswordTouched(false);
    setProbe(null);
    setConnError(null);
  };

  const openConnection = async (conn: SavedDbConnection) => {
    const stamp = (seq.current += 1);
    setActiveConn(conn);
    setSelectedTable(null);
    setExpandedTable(null);
    setColumnsMap({});
    setPaginatedData(null);
    setActiveView('data');
    setErrorText(null);
    setLoadingTables(true);
    try {
      const list =
        conn.engine === 'redis'
          ? await connectionRedisKeys(conn.id, '*')
          : await connectionTables(conn.id);
      if (stamp !== seq.current) return;
      setTables(list);
      if (list.length > 0) {
        await loadConnectionData(conn, list[0].name, stamp);
      }
    } catch (error) {
      if (stamp !== seq.current) return;
      setErrorText(String(error));
      setTables([]);
    } finally {
      if (stamp === seq.current) setLoadingTables(false);
    }
  };

  const backToProject = () => {
    seq.current += 1;
    setActiveConn(null);
    setTables([]);
    setPaginatedData(null);
    setSelectedTable(null);
    setExpandedTable(null);
    setColumnsMap({});
    if (project) void loadTables();
  };

  const loadConnectionData = async (conn: SavedDbConnection, target: string, stamp: number) => {
    setSelectedTable(target);
    setActiveView('data');
    setLoadingData(true);
    try {
      if (conn.engine === 'redis') {
        const res = await runConnectionQuery(conn.id, `GET ${target}`);
        if (stamp !== seq.current) return;
        setPaginatedData({
          columns: ['键', '值'],
          rows: res.error ? [] : [[target, String(res.rows[0]?.[1] ?? 'NULL')]],
          totalRows: res.error ? 0 : 1,
          page: 1,
          pageSize,
          sortBy: null,
          sortDir: 'asc',
          keyColumn: null,
          nextCursor: null,
          hasMore: false,
        });
        if (res.error) onNotify?.(`读取键失败：${res.error}`);
        return;
      }
      if (unsafeIdent(target)) {
        setPaginatedData({
          columns: [],
          rows: [],
          totalRows: 0,
          page: 1,
          pageSize,
          sortBy: null,
          sortDir: 'asc',
          keyColumn: null,
          nextCursor: null,
          hasMore: false,
        });
        onNotify?.('该对象名含引号或空格，请在 SQL 控制台手写查询');
        return;
      }
      const res = await runConnectionQuery(
        conn.id,
        `SELECT * FROM ${quoteIdent(conn.engine, target)} LIMIT ${pageSize}`,
      );
      if (stamp !== seq.current) return;
      if (res.error) {
        setPaginatedData(null);
        onNotify?.(`读取表数据失败：${res.error}`);
        return;
      }
      setPaginatedData({
        columns: res.columns,
        rows: res.rows.map(row => row.map(cell => String(cell))),
        totalRows: res.rowCount,
        page: 1,
        pageSize,
        sortBy: null,
        sortDir: 'asc',
        keyColumn: null,
        nextCursor: null,
        hasMore: res.rowCount > res.rows.length,
      });
    } finally {
      if (stamp === seq.current) setLoadingData(false);
    }
  };

  const submitDraft = async (shouldTest: boolean) => {
    if (!draft) return;
    const payload: DbConnectionInput = {
      ...draft,
      password: passwordTouched ? passwordDraft : null,
    };
    setSavingConn(true);
    setConnError(null);
    setProbe(null);
    try {
      const saved = await saveDbConnection(payload);
      setConnections(await listDbConnections());
      if (shouldTest) {
        // 探针以已保存的 id 发起，测试时保持弹窗打开，否则结果没有落点。
        setDraft(draftFrom(saved));
        setPasswordDraft('');
        setPasswordTouched(false);
        setProbing(true);
        try {
          setProbe(await testDbConnection(saved.id));
        } finally {
          setProbing(false);
        }
        return;
      }
      setDraft(null);
      onNotify?.(`已保存连接：${saved.name}`);
      await openConnection(saved);
    } catch (error) {
      setConnError(String(error));
    } finally {
      setSavingConn(false);
      setProbing(false);
    }
  };

  const removeConnection = async (conn: SavedDbConnection) => {
    try {
      setConnections(await deleteDbConnection(conn.id));
      setDraft(null);
      if (activeConn?.id === conn.id) backToProject();
      onNotify?.(`已删除连接：${conn.name}`);
    } catch (error) {
      onNotify?.(`删除连接失败：${error}`);
    }
  };


  const loadTables = async (path?: string) => {
    if (!project || activeConn) return;
    const stamp = (seq.current += 1);
    const target = path ?? dbPath;
    setLoadingTables(true);
    setErrorText(null);
    try {
      const list = await getDbTables(project.id, target);
      if (stamp !== seq.current) return;
      setTables(list);
      if (list.length > 0 && !selectedTable) {
        setSelectedTable(list[0].name);
        void loadTableData(list[0].name, 1, pageSize, target);
      }
    } catch (error) {
      if (stamp !== seq.current) return;
      setErrorText(String(error));
      setTables([]);
      setPaginatedData(null);
    } finally {
      if (stamp === seq.current) setLoadingTables(false);
    }
  };

  useEffect(() => {
    if (project) {
      void loadTables();
    }
  }, [project?.id, dbPath]);

  const toggleTableExpand = async (tableName: string) => {
    if (expandedTable === tableName) {
      setExpandedTable(null);
      return;
    }
    setExpandedTable(tableName);
    if (columnsMap[tableName]) return;
    if (activeConn) {
      if (activeConn.engine === 'redis') return;
      const stamp = seq.current;
      try {
        const cols = await connectionColumns(activeConn.id, tableName);
        if (stamp !== seq.current) return;
        setColumnsMap(prev => ({ ...prev, [tableName]: cols }));
      } catch (err) {
        onNotify?.(`无法获取表字段：${err}`);
      }
      return;
    }
    if (project) {
      try {
        const cols = await getTableColumns(project.id, dbPath, tableName);
        setColumnsMap(prev => ({ ...prev, [tableName]: cols }));
      } catch (err) {
        onNotify?.(`无法获取表字段：${err}`);
      }
    }
  };

  const loadTableData = async (
    tableName: string,
    newPage: number,
    newSize: number,
    customPath?: string,
    sort?: string | null,
    dir?: 'asc' | 'desc',
    cursor?: string | null,
  ) => {
    if (activeConn) {
      void loadConnectionData(activeConn, tableName, seq.current);
      return;
    }
    if (!project) return;
    const projectId = project.id;
    const token = loadToken.current + 1;
    loadToken.current = token;
    setSelectedTable(tableName);
    setActiveView('data');
    setEditingRowIndex(null);
    setLoadingData(true);
    try {
      const res = await getTableData(projectId, customPath ?? dbPath, tableName, newPage, newSize, {
        sortBy: sort ?? null,
        sortDir: dir ?? 'asc',
        cursor: cursor ?? null,
      });
      // A slower response must not overwrite a newer page, a sort change or another project.
      if (loadToken.current !== token || project?.id !== projectId) return;
      setPaginatedData(res);
      setPage(newPage);
      setPageSize(newSize);
      setCursorStack(stack => rememberCursor(stack, newPage, res.nextCursor));
    } catch (e) {
      if (loadToken.current !== token) return;
      onNotify?.(`读取表数据失败：${e}`);
    } finally {
      if (loadToken.current === token) setLoadingData(false);
    }
  };

  const resetPaging = () => {
    loadToken.current += 1;
    setCursorStack({});
    setPage(1);
    setPaginatedData(null);
  };

  const openTable = (tableName: string) => {
    resetPaging();
    setSortBy(null);
    setSortDir('asc');
    void loadTableData(tableName, 1, pageSize, undefined, null, 'asc', null);
  };

  const sortByColumn = (column: string) => {
    if (!selectedTable) return;
    const nextDir = sortBy === column && sortDir === 'asc' ? 'desc' : 'asc';
    resetPaging();
    setSortBy(column);
    setSortDir(nextDir);
    void loadTableData(selectedTable, 1, pageSize, undefined, column, nextDir, null);
  };

  const goToPage = (target: number) => {
    if (!selectedTable || target < 1) return;
    void loadTableData(
      selectedTable,
      target,
      pageSize,
      undefined,
      sortBy,
      sortDir,
      cursorForPage(cursorStack, target),
    );
  };

  const changePageSize = (size: number) => {
    if (!selectedTable) return;
    resetPaging();
    void loadTableData(selectedTable, 1, size, undefined, sortBy, sortDir, null);
  };

  const updateActiveTab = (patch: Partial<QueryTab>) => {
    setQueryTabs(tabs => tabs.map(tab => (tab.id === activeTab.id ? { ...tab, ...patch } : tab)));
  };

  const addQueryTab = () => {
    const tab = createQueryTab(dbPath, queryTabs, selectedTable);
    setQueryTabs(tabs => [...tabs, tab]);
    setActiveTabId(tab.id);
  };

  const removeQueryTab = (id: string) => {
    const closed = closeQueryTab(queryTabs, id);
    setQueryTabs(closed.tabs);
    setActiveTabId(closed.activeId);
  };

  const applyTemplate = (kind: TemplateKind) => {
    updateActiveTab({ sql: templateSql(kind, selectedTable) });
  };

  const handleRunSql = async () => {
    if ((!project && !activeConn) || activeTab.running) return;
    const trimmed = activeTab.sql.trim();
    if (!trimmed) return;
    const tabId = activeTab.id;
    const conn = activeConn;
    const sourcePath = dbPath;
    const projectId = project?.id ?? '';

    setQueryTabs(tabs => applyTabResult(tabs, tabId, { running: true, result: null, dbPath: sourcePath }));
    try {
      const res = conn
        ? await runConnectionQuery(conn.id, trimmed)
        : await executeSqlQuery(projectId, sourcePath, trimmed);
      setQueryTabs(tabs => applyTabResult(tabs, tabId, { running: false, result: res }));
      setActiveView('sql');
      if (res.error) {
        onNotify?.(`SQL 执行报错：${res.error}`);
      } else {
        onNotify?.(`查询成功：返回 ${res.rowCount} 行 (${res.durationMs}ms)`);
      }
    } catch (e) {
      setQueryTabs(tabs =>
        applyTabResult(tabs, tabId, {
          running: false,
          result: { columns: [], rows: [], rowCount: 0, durationMs: 0, error: String(e) },
        }),
      );
    }
  };

  const download = (content: string, filename: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const exportData = (format: 'csv' | 'json') => {
    const cols = activeView === 'data' ? paginatedData?.columns : activeTab.result?.columns;
    const rows = activeView === 'data' ? paginatedData?.rows : activeTab.result?.rows;
    if (!cols || !rows || rows.length === 0) {
      onNotify?.('当前无数据可供导出');
      return;
    }
    const base = (selectedTable || activeTab.name).replace(/[^\w.-]+/g, '_');
    const content = format === 'csv' ? toCsv(cols, rows) : toJson(cols, rows);
    const mime = format === 'csv' ? 'text/csv' : 'application/json';
    download(content, `${base}-p${page}.${format}`, mime);
    onNotify?.(`已导出 ${rows.length} 行为 ${format.toUpperCase()}`);
  };

  const loadSchema = async (relPath: string) => {
    if (!project) return;
    setSelectedSchemaFile(relPath);
    setActiveView('schema');
    try {
      const content = await readProjectFileContent(project.id, relPath);
      setSchemaContent(content);
      onNotify?.(`已读取模式文件：${relPath}`);
    } catch (e) {
      onNotify?.(`读取文件失败：${e}`);
    }
  };

  const keyColumnIndex = paginatedData?.keyColumn
    ? paginatedData.columns.indexOf(paginatedData.keyColumn)
    : -1;
  const editingRow = editingRowIndex !== null ? paginatedData?.rows[editingRowIndex] : undefined;
  const pendingChanges =
    paginatedData && editingRow ? buildColumnChanges(paginatedData.columns, editingRow, rowEdits) : [];

  const startRowEdit = (rowIndex: number) => {
    setEditingRowIndex(rowIndex);
    setRowEdits({});
    setChangePlan(null);
    setPlanError(null);
    setPlanConfirmed(false);
  };

  const buildPlan = async () => {
    if (!project || !selectedTable || !paginatedData || !editingRow) return;
    if (keyColumnIndex < 0) {
      setPlanError('该表没有单列主键，无法生成可回滚的单行变更');
      return;
    }
    setPlanError(null);
    try {
      const plan = await planRowChange(
        project.id,
        dbPath,
        selectedTable,
        [editingRow[keyColumnIndex]],
        pendingChanges,
      );
      setChangePlan(plan);
      setPlanConfirmed(false);
    } catch (e) {
      setChangePlan(null);
      setPlanError(String(e));
    }
  };

  const copyPlan = async (kind: 'forward' | 'rollback') => {
    if (!changePlan) return;
    const text = formatPlanForClipboard(changePlan, kind);
    try {
      await navigator.clipboard.writeText(text);
      onNotify?.(`已复制${kind === 'forward' ? '正向' : '回滚'} SQL`);
    } catch {
      download(`${text}\n`, `${changePlan.table}-${kind}.sql`, 'text/plain');
      onNotify?.('剪贴板不可用，已改为下载 SQL 文件');
    }
  };

  const totalPages = paginatedData ? Math.ceil(paginatedData.totalRows / pageSize) || 1 : 1;
  const pageLabel = paginatedData?.keyColumn && cursorStack[page - 1] ? '游标' : '偏移';

  const connTarget = (c: SavedDbConnection) =>
    c.engine === 'sqlite'
      ? c.database
      : `${c.host}:${c.port}${c.database ? `/${c.database}` : ''}`;

  const schemaPreset = (engine: DbEngineKind) => {
    if (engine === 'mysql') return 'SHOW TABLES;';
    if (engine === 'postgres') {
      return 'SELECT c.relname, CASE c.relkind WHEN \'v\' THEN \'view\' ELSE \'table\' END FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relkind IN (\'r\',\'m\',\'v\',\'f\') ORDER BY 1;';
    }
    if (engine === 'redis') return 'DBSIZE';
    return "SELECT name, type FROM sqlite_master WHERE type IN ('table','view');";
  };

  return (
    <div className="feature-panel-layout" aria-labelledby="db-title">
      <div className="workbench-header">
        <div className="workbench-title-group">
          <div className="large-tool-icon">
            <Database size={22} strokeWidth={1.5} />
          </div>
          <div>
            <h2 id="db-title">Tongyun Database · 数据工作台</h2>
            <p>多引擎连接管理（SQLite / MySQL / PostgreSQL / Redis）、多查询标签页、主键游标分页数据网格、单行变更预览与回滚 SQL、数据导出（CSV/JSON）与模式追溯。</p>
          </div>
        </div>
        <div className="workbench-badges">
          {isDesktop && (
            <button className="secondary-button-sm" onClick={openNewDialog}>
              <Plus size={12} />
              新建连接
            </button>
          )}
          <button className="secondary-button-sm" onClick={() => exportData('csv')}>
            <Download size={12} />
            导出 CSV
          </button>
          <button className="secondary-button-sm" onClick={() => exportData('json')}>
            <Download size={12} />
            导出 JSON
          </button>
        </div>
      </div>

      {!project && connections.length === 0 ? (
        <div className="panel-empty-placeholder">
          <Database size={32} strokeWidth={1.2} />
          <p>请先在左侧选择或添加一个项目，或用「新建连接」登记外部 SQLite / MySQL / PostgreSQL / Redis 数据源。</p>
        </div>
      ) : (
        <>
          {project && agentSqlActions.length > 0 && (
            <div className="panel-subcard agent-subcard" style={{ marginBottom: 12 }}>
              <div className="section-heading">
                <div className="subcard-title">
                  <Bot size={15} className="accent-color" />
                  <h3>Agent SQL 探查与校验审计</h3>
                  <span className="mini-badge-accent">{session?.agentName ?? 'Agent'}</span>
                </div>
                <span className="meta">{agentSqlActions.length} 项数据操作</span>
              </div>
              <div className="agent-action-mini-list">
                {agentSqlActions.slice(-4).reverse().map(act => (
                  <div
                    key={act.id}
                    className="agent-action-mini-item clickable"
                    onClick={() => {
                      if (act.detail) {
                        updateActiveTab({ sql: act.detail });
                        setActiveView('sql');
                      }
                    }}
                    title="点击将此 SQL 载入当前查询标签"
                  >
                    <div className="action-mini-header">
                      <span className={`status-dot ${act.status === 'done' ? 'available' : 'error'}`} />
                      <span className="mini-badge">SQL</span>
                      <code className="action-mini-cmd">{act.title}</code>
                      <span className="mono-subtle">{act.timestamp}</span>
                    </div>
                    <div className="action-mini-detail mono-subtle">{act.detail}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="db-workbench-split">
          {/* Left Column: Schema & Table Tree Explorer */}
          <aside className="db-sidebar-pane">
            {isDesktop && (
              <div className="db-conn-pane">
                <div className="pane-header">
                  <span>连接列表 ({connections.length})</span>
                  <button className="icon-button-sm" onClick={openNewDialog} title="新建连接">
                    <Plus size={12} />
                  </button>
                </div>
                <div className="conn-list">
                  {project && (
                    <div
                      className={`conn-row ${activeConn ? '' : 'selected'}`}
                      onClick={backToProject}
                      title="使用项目扫描到的 SQLite"
                    >
                      <Database size={13} className="accent-color" />
                      <span className="conn-name">项目 SQLite</span>
                      <span className="conn-target">{dbPath}</span>
                    </div>
                  )}
                  {connections.map(c => (
                    <div
                      key={c.id}
                      className={`conn-row ${activeConn?.id === c.id ? 'selected' : ''}`}
                      onClick={() => void openConnection(c)}
                      title={`${ENGINE_LABEL[c.engine]} · 更新于 ${c.updatedAt}`}
                    >
                      <span className="conn-engine">{ENGINE_LABEL[c.engine]}</span>
                      <span className="conn-name">{c.name}</span>
                      <span className="conn-target">{connTarget(c)}</span>
                      <span className="conn-flags">
                        {c.readOnly && (
                          <span className="conn-flag" title="只读保护已开启">
                            <ShieldCheck size={11} />
                          </span>
                        )}
                        {c.hasPassword && (
                          <span className="conn-flag" title="口令已加密保存">
                            <Key size={11} />
                          </span>
                        )}
                        <button
                          className="icon-button-sm"
                          title="编辑连接"
                          onClick={e => {
                            e.stopPropagation();
                            openEditDialog(c);
                          }}
                        >
                          <FileCode size={11} />
                        </button>
                        <button
                          className="icon-button-sm"
                          title="删除连接"
                          onClick={e => {
                            e.stopPropagation();
                            void removeConnection(c);
                          }}
                        >
                          <Trash2 size={11} />
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeConn ? (
              <div className="db-target-header">
                <span className="toolbar-label">当前连接:</span>
                <input className="db-path-mini-input" value={activeConn.name} readOnly />
                <button
                  className="icon-button-sm"
                  onClick={() => void openConnection(activeConn)}
                  title="重新读取库表"
                >
                  <RefreshCw size={12} className={loadingTables ? 'spin' : ''} />
                </button>
              </div>
            ) : (
              <div className="db-target-header">
                <span className="toolbar-label">当前 SQLite 源:</span>
                <input
                  className="db-path-mini-input"
                  value={dbPath}
                  onChange={e => setDbPath(e.target.value)}
                  placeholder="local.db"
                />
                <button
                  className="icon-button-sm"
                  onClick={() => void loadTables(dbPath)}
                  title="重新扫描库表"
                >
                  <RefreshCw size={12} className={loadingTables ? 'spin' : ''} />
                </button>
              </div>
            )}

            <div className="db-objects-tree">
              <div className="pane-header">
                <span>
                  {activeConn
                    ? activeConn.engine === 'redis'
                      ? `键与类型 (${tables.length})`
                      : `表与视图 (${tables.length})`
                    : `数据表与视图 (${tables.length})`}
                </span>
              </div>
              <div className="tree-list-content">
                {tables.length === 0 ? (
                  <div className="tree-empty-hint" role={errorText ? 'alert' : undefined}>
                    {errorText || (activeConn ? '该连接暂无可读对象' : '数据库中没有数据表')}
                  </div>
                ) : (
                  tables.map(t => (
                    <div key={t.name} className="tree-table-item">
                      <div
                        className={`tree-table-row ${selectedTable === t.name && activeView === 'data' ? 'selected' : ''}`}
                        onClick={() => openTable(t.name)}
                      >
                        <button
                          className="tree-expand-btn"
                          onClick={e => {
                            e.stopPropagation();
                            void toggleTableExpand(t.name);
                          }}
                        >
                          {expandedTable === t.name ? (
                            <ChevronDown size={13} />
                          ) : (
                            <ChevronRight size={13} />
                          )}
                        </button>
                        <Table size={13} className="accent-color" />
                        <span className="tree-item-name">{t.name}</span>
                        <span className="tree-item-kind">{t.kind}</span>
                      </div>

                      {expandedTable === t.name && (
                        <div className="table-columns-sublist">
                          {columnsMap[t.name]?.map(col => (
                            <div key={col.cid} className="column-meta-row">
                              {col.pk ? (
                                <Key size={11} className="pk-icon" />
                              ) : (
                                <span className="col-bullet">•</span>
                              )}
                              <span className="col-name">{col.name}</span>
                              <span className="col-type">{col.dataType}</span>
                              {col.notNull && <span className="col-tag">NOT NULL</span>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>

              {/* Artifacts list (schemas / migrations) */}
              {!activeConn && artifacts.length > 0 && (
                <div className="db-artifacts-subpane">
                  <div className="pane-header">
                    <span>模式产物 ({artifacts.length})</span>
                  </div>
                  <div className="artifacts-list">
                    {artifacts.map(a => (
                      <div
                        key={a.path}
                        className={`artifact-item-row ${selectedSchemaFile === a.path && activeView === 'schema' ? 'selected' : ''}`}
                        onClick={() => {
                          if (a.name.endsWith('.db') || a.name.endsWith('.sqlite')) {
                            setDbPath(a.path);
                          } else {
                            void loadSchema(a.path);
                          }
                        }}
                      >
                        <FileCode size={13} />
                        <span className="artifact-name">{a.name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </aside>

          {/* Right Column: View Switcher (Table Data Grid / SQL Console / Schema DDL) */}
          <div className="db-main-pane">
            <div className="db-view-switch-bar">
              <div className="sub-tabs">
                <button
                  className={activeView === 'data' ? 'active' : ''}
                  onClick={() => setActiveView('data')}
                >
                  <Table size={13} />
                  表数据浏览 {selectedTable ? `(${selectedTable})` : ''}
                </button>
                <button
                  className={activeView === 'sql' ? 'active' : ''}
                  onClick={() => setActiveView('sql')}
                >
                  <Play size={13} />
                  SQL 控制台 ({queryTabs.length})
                </button>
                {selectedSchemaFile && (
                  <button
                    className={activeView === 'schema' ? 'active' : ''}
                    onClick={() => setActiveView('schema')}
                  >
                    <FileCode size={13} />
                    模式定义 ({selectedSchemaFile})
                  </button>
                )}
              </div>
            </div>

            {/* View 1: Cursor-paginated Data Grid */}
            {activeView === 'data' && (
              <section className="table-data-workbench">
                <div className="table-data-toolbar">
                  <div className="toolbar-left">
                    <span className="active-table-title">{selectedTable || '未选择数据表'}</span>
                    {paginatedData && (
                      <span className="meta">
                        {activeConn
                          ? `首屏 ${paginatedData.totalRows} 行 · 更多请用 SQL 控制台（LIMIT / OFFSET）`
                          : `共 ${paginatedData.totalRows} 条 · 第 ${page} / ${totalPages} 页 · ${pageLabel}翻页${paginatedData.keyColumn ? ` · 主键 ${paginatedData.keyColumn}` : ' · 无单列主键'}`}
                      </span>
                    )}
                  </div>
                  {!activeConn && (
                  <div className="toolbar-pagination">
                    <label className="page-size-picker">
                      <span className="toolbar-label">每页</span>
                      <select
                        className="page-size-select"
                        value={pageSize}
                        onChange={e => changePageSize(Number(e.target.value))}
                      >
                        {PAGE_SIZES.map(size => (
                          <option key={size} value={size}>
                            {size}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="pagination-btn"
                      disabled={page <= 1 || loadingData}
                      onClick={() => goToPage(page - 1)}
                    >
                      上一页
                    </button>
                    <span className="page-indicator">{page}</span>
                    <button
                      className="pagination-btn"
                      disabled={!paginatedData?.hasMore || loadingData}
                      onClick={() => goToPage(page + 1)}
                    >
                      下一页
                    </button>
                  </div>
                  )}
                </div>

                <div className="data-grid-container">
                  {loadingData ? (
                    <div className="grid-loading">
                      <LoaderCircle size={18} className="spin" />
                      <span>正在加载表数据…</span>
                    </div>
                  ) : !paginatedData || paginatedData.rows.length === 0 ? (
                    <div className="grid-empty">该表暂无数据记录</div>
                  ) : (
                    <table className="enterprise-data-table auto-column-width">
                      <thead>
                        <tr>
                          {paginatedData.columns.map((col, idx) => (
                            <th key={idx}>
                              <button
                                className={`sort-header ${sortBy === col ? 'sorting' : ''}`}
                                onClick={() => sortByColumn(col)}
                                aria-label={`按 ${col} 排序`}
                              >
                                {col}
                                <span className="sort-arrow">
                                  {sortBy === col ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                                </span>
                              </button>
                            </th>
                          ))}
                          <th className="row-action-col">行操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {paginatedData.rows.map((row, rIdx) => (
                          <tr key={rIdx} className={editingRowIndex === rIdx ? 'editing-row' : ''}>
                            {row.map((cell, cIdx) => (
                              <td key={cIdx} className="mono">
                                {editingRowIndex === rIdx && cIdx !== keyColumnIndex ? (
                                  <input
                                    className="cell-edit-input"
                                    aria-label={`第 ${rIdx + 1} 行 ${paginatedData.columns[cIdx]} 新值`}
                                    defaultValue={cell}
                                    onChange={e =>
                                      setRowEdits(prev => ({ ...prev, [cIdx]: e.target.value }))
                                    }
                                  />
                                ) : cell === 'NULL' ? (
                                  <span className="null-val">NULL</span>
                                ) : (
                                  cell
                                )}
                              </td>
                            ))}
                            <td className="row-action-cell">
                              {editingRowIndex === rIdx ? (
                                <div className="row-editor-actions">
                                  <button
                                    className="secondary-button-sm"
                                    disabled={pendingChanges.length === 0}
                                    onClick={() => void buildPlan()}
                                  >
                                    生成变更预览
                                  </button>
                                  <button
                                    className="icon-button-sm"
                                    aria-label="取消编辑"
                                    onClick={() => {
                                      setEditingRowIndex(null);
                                      setRowEdits({});
                                      setChangePlan(null);
                                      setPlanError(null);
                                    }}
                                  >
                                    <X size={12} />
                                  </button>
                                </div>
                              ) : (
                                <button
                                  className="secondary-button-sm"
                                  disabled={keyColumnIndex < 0}
                                  title={
                                    keyColumnIndex < 0
                                      ? '无单列主键的表或视图不生成可回滚变更'
                                      : '编辑该行并生成回滚 SQL'
                                  }
                                  onClick={() => startRowEdit(rIdx)}
                                >
                                  编辑
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                {editingRowIndex !== null && (
                  <section className="panel-subcard change-control-card">
                    <div className="section-heading">
                      <div className="subcard-title">
                        <ShieldAlert size={15} className="accent-color" />
                        <h3>变更控制预览</h3>
                        <span className="mini-badge-accent">
                          {pendingChanges.length} 个字段
                        </span>
                      </div>
                      <span className="meta">参数化 SQL · 只读连接不代为执行</span>
                    </div>
                    {planError && <div className="sql-error-box" role="alert">{planError}</div>}
                    {!changePlan && pendingChanges.length === 0 && (
                      <p className="change-control-hint">
                        改动任意非主键单元格后点击「生成变更预览」，正向与回滚 SQL 都会带上绑定参数。
                      </p>
                    )}
                    {changePlan && (
                      <div className="change-plan-body">
                        <div className="change-plan-block">
                          <span className="toolbar-label">正向变更</span>
                          <code className="change-plan-sql">{changePlan.forwardSql}</code>
                          <span className="mono-subtle">
                            参数: [{changePlan.forwardParameters.map(value => value ?? 'NULL').join(', ')}]
                          </span>
                        </div>
                        <div className="change-plan-block">
                          <span className="toolbar-label">反向回滚（按主键还原旧值）</span>
                          <code className="change-plan-sql">{changePlan.rollbackSql}</code>
                          <span className="mono-subtle">
                            参数: [{changePlan.rollbackParameters.map(value => value ?? 'NULL').join(', ')}]
                          </span>
                        </div>
                        <label className="change-plan-confirm">
                          <input
                            type="checkbox"
                            checked={planConfirmed}
                            onChange={e => setPlanConfirmed(e.target.checked)}
                          />
                          <span>我已确认改动 {changePlan.changedColumns.join('、')} 只影响主键 {changePlan.keyPredicate} 的一行</span>
                        </label>
                        <div className="change-plan-actions">
                          <button
                            className="secondary-button-sm"
                            disabled={!planConfirmed}
                            onClick={() => void copyPlan('forward')}
                          >
                            复制正向 SQL
                          </button>
                          <button
                            className="secondary-button-sm"
                            disabled={!planConfirmed}
                            onClick={() => void copyPlan('rollback')}
                          >
                            复制回滚 SQL
                          </button>
                        </div>
                        <p className="change-control-hint">
                          工作台以只读方式打开 SQLite，正向与回滚 SQL 需要你在外部客户端执行；回滚 SQL 请随变更一起留存。
                        </p>
                      </div>
                    )}
                  </section>
                )}
              </section>
            )}

            {/* View 2: SQL Console with independent query tabs */}
            {activeView === 'sql' && (
              <section className="sql-workbench-card">
                <div className="query-tab-bar" role="tablist" aria-label="查询标签页">
                  {queryTabs.map(tab => (
                    <div
                      key={tab.id}
                      className={`query-tab ${tab.id === activeTab.id ? 'active' : ''}`}
                      role="tab"
                      tabIndex={0}
                      aria-selected={tab.id === activeTab.id}
                      onClick={() => setActiveTabId(tab.id)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ' ') setActiveTabId(tab.id);
                      }}
                    >
                      {renamingTabId === tab.id ? (
                        <input
                          className="query-tab-rename"
                          autoFocus
                          defaultValue={tab.name}
                          aria-label="标签名称"
                          onBlur={e => {
                            setQueryTabs(tabs => renameQueryTab(tabs, tab.id, e.target.value));
                            setRenamingTabId(null);
                          }}
                          onKeyDown={e => {
                            if (e.key === 'Enter') {
                              setQueryTabs(tabs =>
                                renameQueryTab(tabs, tab.id, (e.target as HTMLInputElement).value),
                              );
                              setRenamingTabId(null);
                            }
                          }}
                        />
                      ) : (
                        <button
                          className="query-tab-name"
                          onDoubleClick={() => setRenamingTabId(tab.id)}
                          title="双击重命名"
                        >
                          {tab.name}
                        </button>
                      )}
                      {tab.result && (
                        <span className="query-tab-meta">
                          {tab.result.error ? '异常' : `${tab.result.rowCount} 行 · ${tab.result.durationMs}ms`}
                        </span>
                      )}
                      <button
                        className="query-tab-close"
                        aria-label={`关闭 ${tab.name}`}
                        onClick={e => {
                          e.stopPropagation();
                          removeQueryTab(tab.id);
                        }}
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                  <button className="query-tab-add" onClick={addQueryTab}>
                    <Plus size={12} />
                    新建查询
                  </button>
                </div>

                <div className="safety-warning-banner">
                  <ShieldAlert size={16} />
                  <span>
                    {activeConn
                      ? `${ENGINE_LABEL[activeConn.engine]} 连接「${activeConn.name}」：只读保护${activeConn.readOnly ? '已开启，非只读语句会被拦截' : '未开启，请自行控制语句范围'}。单次最多 1000 行、4 MiB，连接与查询限时 5 秒。`
                      : `只读查询：禁止写入、建表和附加数据库。单次最多 1000 行、4 MiB，执行限时 2 秒。当前源：${activeTab.dbPath}`}
                  </span>
                </div>

                <div className="sql-editor-container">
                  <textarea
                    className="sql-textarea"
                    aria-label="SQL 查询语句"
                    rows={4}
                    value={activeTab.sql}
                    onChange={e => updateActiveTab({ sql: e.target.value })}
                    placeholder="输入单条 SELECT 或只读表结构查询…"
                  />
                  <div className="sql-editor-footer">
                    <div className="sql-presets">
                      <button className="preset-btn" onClick={() => applyTemplate('sample')}>
                        SELECT 前 50 条
                      </button>
                      <button
                        className="preset-btn"
                        onClick={() => updateActiveTab({ sql: schemaPreset(activeConn?.engine ?? 'sqlite') })}
                      >
                        {activeConn?.engine === 'redis' ? '键数量 DBSIZE' : '所有表'}
                      </button>
                      {selectedTable && !activeConn && (
                        <button className="preset-btn" onClick={() => applyTemplate('describe')}>
                          DESCRIBE {selectedTable}
                        </button>
                      )}
                      {selectedTable && !unsafeIdent(selectedTable) && (
                        <button
                          className="preset-btn"
                          onClick={() =>
                            updateActiveTab({
                              sql:
                                activeConn?.engine === 'redis'
                                  ? `TYPE ${selectedTable}`
                                  : `SELECT * FROM ${
                                      activeConn ? quoteIdent(activeConn.engine, selectedTable) : `"${selectedTable}"`
                                    } LIMIT 20;`,
                            })
                          }
                        >
                          查询 {selectedTable} 前20条
                        </button>
                      )}
                    </div>
                    <button
                      className="primary-button"
                      onClick={() => void handleRunSql()}
                      disabled={activeTab.running || !activeTab.sql.trim()}
                    >
                      {activeTab.running ? <LoaderCircle size={14} className="spin" /> : <Play size={14} />}
                      只读查询
                    </button>
                  </div>
                </div>

                {activeTab.result && (
                  <div className="sql-results-area">
                    <div className="results-header">
                      <span>
                        {activeTab.name} · {activeTab.result.error ? '异常' : `${activeTab.result.durationMs}ms · ${activeTab.result.rowCount} 行`}
                      </span>
                    </div>
                    {activeTab.result.error ? (
                      <div className="sql-error-box">{activeTab.result.error}</div>
                    ) : (
                      <div className="data-grid-container max-height-300">
                        <table className="enterprise-data-table auto-column-width">
                          <thead>
                            <tr>
                              {activeTab.result.columns.map((col, idx) => (
                                <th key={idx}>{col}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {activeTab.result.rows.map((row, rIdx) => (
                              <tr key={rIdx}>
                                {row.map((cell, cIdx) => (
                                  <td key={cIdx} className="mono">
                                    {cell === 'NULL' ? <span className="null-val">NULL</span> : String(cell)}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </section>
            )}

            {/* View 3: Schema DDL Preview */}
            {activeView === 'schema' && schemaContent && (
              <section className="schema-preview-pane">
                <div className="schema-header">
                  <span>DDL 语法预览：{selectedSchemaFile}</span>
                  {isDesktop && (
                    <button
                      className="terminal-btn"
                      onClick={() => project && selectedSchemaFile && void openProjectFile(project.id, selectedSchemaFile)}
                    >
                      <ExternalLink size={12} />
                      在系统编辑器中打开
                    </button>
                  )}
                </div>
                <pre className="schema-code-view">
                  <code>{schemaContent}</code>
                </pre>
              </section>
            )}
          </div>
        </div>
        </>
      )}

      {draft && (
        <div
          className="modal-overlay"
          onMouseDown={e => {
            if (e.target === e.currentTarget && !savingConn) setDraft(null);
          }}
        >
          <div className="modal-dialog" role="dialog" aria-modal="true" aria-label="连接配置">
            <div className="modal-header">
              <h2>{draft.id ? `编辑连接：${draft.name}` : '新建数据库连接'}</h2>
            </div>
            <div className="modal-body">
              <p className="modal-description">
                口令用本机密钥以 AES-256-GCM 加密后写入 connections.json，界面与日志都不回显明文；
                「测试连接」会先保存当前配置再发起探针。
              </p>

              <div className="modal-form-group">
                <label>连接名称 (1-64 字):</label>
                <input
                  className="modal-input"
                  value={draft.name}
                  onChange={e => setDraft({ ...draft, name: e.target.value })}
                  placeholder="例如：订单主库（只读）"
                />
              </div>

              <div className="modal-form-group">
                <label>引擎类型:</label>
                <div className="modal-radio-group">
                  {(['mysql', 'postgres', 'redis', 'sqlite'] as DbEngineKind[]).map(kind => (
                    <label key={kind}>
                      <input
                        type="radio"
                        name="dbEngine"
                        checked={draft.engine === kind}
                        onChange={() =>
                          setDraft({
                            ...draft,
                            engine: kind,
                            port: kind === 'sqlite' ? null : PORT_BY_ENGINE[kind],
                            tls: kind === 'mysql' ? draft.tls : false,
                            host: kind === 'sqlite' ? '' : draft.host,
                          })
                        }
                      />
                      {kind === 'mysql' ? 'MySQL / TiDB / MariaDB' : ENGINE_LABEL[kind]}
                    </label>
                  ))}
                </div>
              </div>

              {draft.engine === 'sqlite' ? (
                <div className="modal-form-group">
                  <label>数据库文件绝对路径:</label>
                  <input
                    className="modal-input"
                    value={draft.database}
                    onChange={e => setDraft({ ...draft, database: e.target.value })}
                    placeholder="D:/data/local.db"
                  />
                </div>
              ) : (
                <>
                  <div className="modal-form-group">
                    <label>主机 Host:</label>
                    <input
                      className="modal-input"
                      value={draft.host}
                      onChange={e => setDraft({ ...draft, host: e.target.value })}
                      placeholder="127.0.0.1"
                    />
                  </div>
                  <div className="modal-form-group">
                    <label>端口 Port:</label>
                    <input
                      className="modal-input"
                      type="number"
                      min={1}
                      max={65535}
                      value={draft.port ?? ''}
                      onChange={e =>
                        setDraft({ ...draft, port: e.target.value === '' ? null : Number(e.target.value) })
                      }
                    />
                  </div>
                  {draft.engine !== 'redis' && (
                    <div className="modal-form-group">
                      <label>用户名:</label>
                      <input
                        className="modal-input"
                        value={draft.user}
                        autoComplete="off"
                        onChange={e => setDraft({ ...draft, user: e.target.value })}
                        placeholder="readonly"
                      />
                    </div>
                  )}
                  <div className="modal-form-group">
                    <label>{draft.engine === 'redis' ? '数据库索引 (如 0):' : '数据库名:'}</label>
                    <input
                      className="modal-input"
                      value={draft.database}
                      onChange={e => setDraft({ ...draft, database: e.target.value })}
                      placeholder={draft.engine === 'redis' ? '0' : 'analytics'}
                    />
                  </div>
                </>
              )}

              {draft.engine !== 'sqlite' && (
                <div className="modal-form-group">
                  <label>密码{draft.id ? '（不改动则保留原密码，清空则删除）:' : ':'}</label>
                  <input
                    className="modal-input"
                    type="password"
                    autoComplete="new-password"
                    value={passwordDraft}
                    onChange={e => {
                      setPasswordDraft(e.target.value);
                      setPasswordTouched(true);
                    }}
                  />
                  {draft.id && (
                    <div className="confirm-tip">
                      当前{connections.find(c => c.id === draft.id)?.hasPassword ? '已保存加密口令' : '没有保存口令'}
                    </div>
                  )}
                </div>
              )}

              <div className="modal-form-group">
                <div className="modal-radio-group">
                  <label>
                    <input
                      type="checkbox"
                      checked={draft.tls}
                      disabled={draft.engine !== 'mysql'}
                      onChange={e => setDraft({ ...draft, tls: e.target.checked })}
                    />
                    使用 SSL 连接{draft.engine !== 'mysql' ? '（当前仅 MySQL 支持）' : ''}
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={draft.readOnly}
                      onChange={e => setDraft({ ...draft, readOnly: e.target.checked })}
                    />
                    只读保护（拦截写入、加锁与多语句）
                  </label>
                </div>
              </div>

              {connError && <div className="form-error" role="alert">{connError}</div>}
              {probe && (
                <div className={`probe-result ${probe.ok ? 'ok' : 'fail'}`} role="status">
                  {probe.ok
                    ? `连接成功（${probe.latencyMs}ms）：${probe.detail}`
                    : `连接失败 [${probe.errorCode}]：${probe.detail}`}
                </div>
              )}

              <div className="modal-actions">
                {draft.id && (
                  <button
                    className="danger-button"
                    disabled={savingConn}
                    onClick={() => {
                      const target = connections.find(c => c.id === draft.id);
                      if (target) void removeConnection(target);
                    }}
                  >
                    <Trash2 size={13} />
                    删除连接
                  </button>
                )}
                <button className="secondary-button-sm" disabled={savingConn} onClick={() => setDraft(null)}>
                  <X size={13} />
                  取消
                </button>
                <button
                  className="secondary-button-sm"
                  disabled={savingConn || !draft.name.trim()}
                  onClick={() => void submitDraft(true)}
                >
                  {probing || savingConn ? <LoaderCircle size={13} className="spin" /> : <Play size={13} />}
                  测试连接
                </button>
                <button
                  className="primary-button"
                  disabled={savingConn || !draft.name.trim()}
                  onClick={() => void submitDraft(false)}
                >
                  <Plus size={13} />
                  保存连接
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
