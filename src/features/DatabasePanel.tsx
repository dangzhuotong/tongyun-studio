import { useEffect, useRef, useState } from 'react';
import type { Project, ProjectInspection, DbTableInfo, DbColumnInfo, PaginatedData, RowChangePlan, AgentSessionState } from '../contracts';
import {
  executeSqlQuery,
  getDbTables,
  getTableColumns,
  getTableData,
  planRowChange,
  readProjectFileContent,
  openProjectFile,
  isDesktop,
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
  Table,
  X,
} from '../components/Icons';

const PAGE_SIZES = [20, 50, 100, 200];

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

  const loadTables = async (path?: string) => {
    if (!project) return;
    const target = path ?? dbPath;
    setLoadingTables(true);
    setErrorText(null);
    try {
      const list = await getDbTables(project.id, target);
      setTables(list);
      if (list.length > 0 && !selectedTable) {
        setSelectedTable(list[0].name);
        void loadTableData(list[0].name, 1, pageSize, target);
      }
    } catch (error) {
      setErrorText(String(error));
      setTables([]);
      setPaginatedData(null);
    } finally {
      setLoadingTables(false);
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
    if (!columnsMap[tableName] && project) {
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
    if (!project || activeTab.running) return;
    const trimmed = activeTab.sql.trim();
    if (!trimmed) return;
    const tabId = activeTab.id;
    const sourcePath = dbPath;
    const projectId = project.id;

    setQueryTabs(tabs => applyTabResult(tabs, tabId, { running: true, result: null, dbPath: sourcePath }));
    try {
      const res = await executeSqlQuery(projectId, sourcePath, trimmed);
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

  return (
    <div className="feature-panel-layout" aria-labelledby="db-title">
      <div className="workbench-header">
        <div className="workbench-title-group">
          <div className="large-tool-icon">
            <Database size={22} strokeWidth={1.5} />
          </div>
          <div>
            <h2 id="db-title">Tongyun Database · 数据工作台</h2>
            <p>多查询标签页、主键游标分页数据网格、单行变更预览与回滚 SQL、数据导出（CSV/JSON）与模式追溯。</p>
          </div>
        </div>
        <div className="workbench-badges">
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

      {!project ? (
        <div className="panel-empty-placeholder">
          <Database size={32} strokeWidth={1.2} />
          <p>请先在左侧选择或添加一个项目，以浏览数据库结构与执行 SQL 查询。</p>
        </div>
      ) : (
        <>
          {agentSqlActions.length > 0 && (
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

            <div className="db-objects-tree">
              <div className="pane-header">
                <span>数据表与视图 ({tables.length})</span>
              </div>
              <div className="tree-list-content">
                {tables.length === 0 ? (
                  <div className="tree-empty-hint" role={errorText ? 'alert' : undefined}>{errorText || '数据库中没有数据表'}</div>
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
              {artifacts.length > 0 && (
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
                        共 {paginatedData.totalRows} 条 · 第 {page} / {totalPages} 页 · {pageLabel}翻页
                        {paginatedData.keyColumn ? ` · 主键 ${paginatedData.keyColumn}` : ' · 无单列主键'}
                      </span>
                    )}
                  </div>
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
                    只读查询：禁止写入、建表和附加数据库。单次最多 1000 行、4 MiB，执行限时 2 秒。当前源：{activeTab.dbPath}
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
                      <button className="preset-btn" onClick={() => applyTemplate('tables')}>
                        所有表
                      </button>
                      {selectedTable && (
                        <button className="preset-btn" onClick={() => applyTemplate('describe')}>
                          DESCRIBE {selectedTable}
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
    </div>
  );
}
