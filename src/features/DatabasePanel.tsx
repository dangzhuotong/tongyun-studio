import { useEffect, useState } from 'react';
import type { Project, ProjectInspection, SqlQueryResult, DbTableInfo, DbColumnInfo, PaginatedData } from '../contracts';
import {
  executeSqlQuery,
  getDbTables,
  getTableColumns,
  getTableData,
  readProjectFileContent,
  openProjectFile,
  isDesktop,
} from '../bridge';
import {
  ChevronDown,
  ChevronRight,
  Database,
  Download,
  ExternalLink,
  FileCode,
  Key,
  LoaderCircle,
  Play,
  RefreshCw,
  ShieldAlert,
  Table,
} from '../components/Icons';

export default function DatabasePanel({
  project,
  inspection,
  onNotify,
}: {
  project: Project | null;
  inspection?: ProjectInspection | null;
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

  // SQL Console
  const [sqlQuery, setSqlQuery] = useState("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name;");
  const [runningSql, setRunningSql] = useState(false);
  const [queryResult, setQueryResult] = useState<SqlQueryResult | null>(null);
  const [safetyWarning, setSafetyWarning] = useState<string | null>(null);

  // Schema file preview
  const [selectedSchemaFile, setSelectedSchemaFile] = useState<string | null>(null);
  const [schemaContent, setSchemaContent] = useState<string | null>(null);

  const loadTables = async (path?: string) => {
    if (!project) return;
    const target = path ?? dbPath;
    setLoadingTables(true);
    try {
      const list = await getDbTables(project.id, target);
      setTables(list);
      if (list.length > 0 && !selectedTable) {
        setSelectedTable(list[0].name);
        void loadTableData(list[0].name, 1, pageSize, target);
      }
    } catch {
      // might not be an existing sqlite yet
      setTables([]);
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
  ) => {
    if (!project) return;
    setSelectedTable(tableName);
    setActiveView('data');
    setLoadingData(true);
    try {
      const res = await getTableData(
        project.id,
        customPath ?? dbPath,
        tableName,
        newPage,
        newSize,
      );
      setPaginatedData(res);
      setPage(newPage);
      setPageSize(newSize);
    } catch (e) {
      onNotify?.(`读取表数据失败：${e}`);
    } finally {
      setLoadingData(false);
    }
  };

  const handleRunSql = async () => {
    if (!project || runningSql) return;
    const trimmed = sqlQuery.trim();
    if (!trimmed) return;

    // Safety checks for dangerous mutations without WHERE
    const upper = trimmed.toUpperCase();
    if ((upper.startsWith('DELETE') || upper.startsWith('UPDATE')) && !upper.includes('WHERE')) {
      setSafetyWarning('⚠️ 危险操作警示：该 SQL 为无 WHERE 条件的全表更新/删除，可能造成全量数据丢失。');
    } else {
      setSafetyWarning(null);
    }

    setRunningSql(true);
    setQueryResult(null);
    try {
      const res = await executeSqlQuery(project.id, dbPath, trimmed);
      setQueryResult(res);
      setActiveView('sql');
      if (res.error) {
        onNotify?.(`SQL 执行报错：${res.error}`);
      } else {
        onNotify?.(`查询成功：返回 ${res.rowCount} 行 (${res.durationMs}ms)`);
      }
    } catch (e) {
      setQueryResult({
        columns: [],
        rows: [],
        rowCount: 0,
        durationMs: 0,
        error: String(e),
      });
    } finally {
      setRunningSql(false);
    }
  };

  const exportData = (format: 'csv' | 'json') => {
    const cols = activeView === 'data' ? paginatedData?.columns : queryResult?.columns;
    const rows = activeView === 'data' ? paginatedData?.rows : queryResult?.rows;
    if (!cols || !rows || rows.length === 0) {
      onNotify?.('当前无数据可供导出');
      return;
    }

    let content = '';
    let filename = `${selectedTable || 'query_result'}.${format}`;

    if (format === 'csv') {
      content = `${cols.join(',')}\n` + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    } else {
      const objects = rows.map(r => {
        const obj: Record<string, any> = {};
        cols.forEach((col, idx) => {
          obj[col] = r[idx];
        });
        return obj;
      });
      content = JSON.stringify(objects, null, 2);
    }

    const blob = new Blob([content], { type: format === 'csv' ? 'text/csv' : 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    onNotify?.(`已导出为 ${filename}`);
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

  const totalPages = paginatedData ? Math.ceil(paginatedData.totalRows / pageSize) || 1 : 1;

  return (
    <div className="feature-panel-layout" aria-labelledby="db-title">
      <div className="workbench-header">
        <div className="workbench-title-group">
          <div className="large-tool-icon">
            <Database size={22} strokeWidth={1.5} />
          </div>
          <div>
            <h2 id="db-title">Tongyun Database · 企业级数据工作台</h2>
            <p>库表对象树、可视化分页数据网格、SQL 安全审阅、数据导出（CSV/JSON）与模式追溯。</p>
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
                  <div className="tree-empty-hint">未扫描到数据表（或数据库为空）</div>
                ) : (
                  tables.map(t => (
                    <div key={t.name} className="tree-table-item">
                      <div
                        className={`tree-table-row ${selectedTable === t.name && activeView === 'data' ? 'selected' : ''}`}
                        onClick={() => void loadTableData(t.name, 1, pageSize)}
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
                  SQL 控制台
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

            {/* View 1: Paginated Data Grid */}
            {activeView === 'data' && (
              <section className="table-data-workbench">
                <div className="table-data-toolbar">
                  <div className="toolbar-left">
                    <span className="active-table-title">{selectedTable || '未选择数据表'}</span>
                    {paginatedData && (
                      <span className="meta">
                        共 {paginatedData.totalRows} 条数据 · 第 {page} / {totalPages} 页
                      </span>
                    )}
                  </div>
                  <div className="toolbar-pagination">
                    <button
                      className="pagination-btn"
                      disabled={page <= 1 || loadingData}
                      onClick={() => selectedTable && void loadTableData(selectedTable, page - 1, pageSize)}
                    >
                      上一页
                    </button>
                    <span className="page-indicator">{page}</span>
                    <button
                      className="pagination-btn"
                      disabled={page >= totalPages || loadingData}
                      onClick={() => selectedTable && void loadTableData(selectedTable, page + 1, pageSize)}
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
                    <table className="enterprise-data-table">
                      <thead>
                        <tr>
                          {paginatedData.columns.map((col, idx) => (
                            <th key={idx}>{col}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {paginatedData.rows.map((row, rIdx) => (
                          <tr key={rIdx}>
                            {row.map((cell, cIdx) => (
                              <td key={cIdx} className="mono">
                                {cell === 'NULL' ? <span className="null-val">NULL</span> : cell}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </section>
            )}

            {/* View 2: SQL Console */}
            {activeView === 'sql' && (
              <section className="sql-workbench-card">
                {safetyWarning && (
                  <div className="safety-warning-banner">
                    <ShieldAlert size={16} />
                    <span>{safetyWarning}</span>
                  </div>
                )}

                <div className="sql-editor-container">
                  <textarea
                    className="sql-textarea"
                    rows={4}
                    value={sqlQuery}
                    onChange={e => setSqlQuery(e.target.value)}
                    placeholder="输入 SELECT / INSERT / UPDATE / PRAGMA 等标准 SQL 语句…"
                  />
                  <div className="sql-editor-footer">
                    <div className="sql-presets">
                      <button
                        className="preset-btn"
                        onClick={() => setSqlQuery("SELECT name, type FROM sqlite_master WHERE type IN ('table','view');")}
                      >
                        所有表
                      </button>
                      {selectedTable && (
                        <button
                          className="preset-btn"
                          onClick={() => setSqlQuery(`SELECT * FROM "${selectedTable}" LIMIT 20;`)}
                        >
                          查询 {selectedTable} 前20条
                        </button>
                      )}
                    </div>
                    <button
                      className="primary-button"
                      onClick={handleRunSql}
                      disabled={runningSql || !sqlQuery.trim()}
                    >
                      {runningSql ? <LoaderCircle size={14} className="spin" /> : <Play size={14} />}
                      执行查询
                    </button>
                  </div>
                </div>

                {queryResult && (
                  <div className="sql-results-area">
                    <div className="results-header">
                      <span>执行结果：{queryResult.error ? '异常' : `${queryResult.durationMs}ms · ${queryResult.rowCount} 行`}</span>
                    </div>
                    {queryResult.error ? (
                      <div className="sql-error-box">{queryResult.error}</div>
                    ) : (
                      <div className="data-grid-container max-height-300">
                        <table className="enterprise-data-table">
                          <thead>
                            <tr>
                              {queryResult.columns.map((col, idx) => (
                                <th key={idx}>{col}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {queryResult.rows.map((row, rIdx) => (
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
      )}
    </div>
  );
}
