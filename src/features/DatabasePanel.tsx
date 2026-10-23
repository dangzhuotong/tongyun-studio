import { useState } from 'react';
import type { Project, ProjectInspection, SqlQueryResult } from '../contracts';
import { executeSqlQuery, readProjectFileContent, openProjectFile, isDesktop } from '../bridge';
import {
  Database,
  ExternalLink,
  FileCode,
  LoaderCircle,
  Play,
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

  const [dbPath, setDbPath] = useState(
    sqliteFiles[0]?.path ?? 'local.db',
  );
  const [sqlQuery, setSqlQuery] = useState(
    "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name;",
  );
  const [running, setRunning] = useState(false);
  const [queryResult, setQueryResult] = useState<SqlQueryResult | null>(null);

  const [selectedSchemaFile, setSelectedSchemaFile] = useState<string | null>(null);
  const [schemaContent, setSchemaContent] = useState<string | null>(null);
  const [loadingSchema, setLoadingSchema] = useState(false);

  const runQuery = async (customSql?: string) => {
    if (!project || running) return;
    const sql = customSql ?? sqlQuery;
    if (!sql.trim()) return;

    setRunning(true);
    setQueryResult(null);
    try {
      const res = await executeSqlQuery(project.id, dbPath.trim(), sql.trim());
      setQueryResult(res);
      if (res.error) {
        onNotify?.(`SQL 执行报错：${res.error}`);
      } else {
        onNotify?.(`查询完成：返回 ${res.rowCount} 行 (${res.durationMs}ms)`);
      }
    } catch (e) {
      setQueryResult({
        columns: [],
        rows: [],
        rowCount: 0,
        durationMs: 0,
        error: String(e),
      });
      onNotify?.(`执行失败：${e}`);
    } finally {
      setRunning(false);
    }
  };

  const loadSchema = async (relPath: string) => {
    if (!project) return;
    setSelectedSchemaFile(relPath);
    setLoadingSchema(true);
    try {
      const content = await readProjectFileContent(project.id, relPath);
      setSchemaContent(content);
      onNotify?.(`已读取模式文件：${relPath}`);
    } catch (e) {
      onNotify?.(`读取文件失败：${e}`);
    } finally {
      setLoadingSchema(false);
    }
  };

  return (
    <div className="feature-panel-layout" aria-labelledby="db-title">
      <div className="workbench-header">
        <div className="workbench-title-group">
          <div className="large-tool-icon">
            <Database size={22} strokeWidth={1.5} />
          </div>
          <div>
            <h2 id="db-title">Tongyun Database · 数据与 SQL</h2>
            <p>连接项目本地 SQLite 数据库，原生执行 SQL 查询并以表格方式检查结构与数据行。</p>
          </div>
        </div>
        <div className="workbench-badges">
          <span className="badge-matcha">原生 SQLite 引擎</span>
          {project && <span className="mono-subtle">{project.name}</span>}
        </div>
      </div>

      {!project ? (
        <div className="panel-empty-placeholder">
          <Database size={32} strokeWidth={1.2} />
          <p>请先在左侧选择或添加一个项目，以浏览数据库结构与执行 SQL 查询。</p>
        </div>
      ) : (
        <>
          {/* Discovered Database & Schema Artifacts */}
          <section className="panel-subcard">
            <div className="section-heading">
              <div className="subcard-title">
                <FileCode size={15} className="title-icon" />
                <h3>检测到的数据与模式产物</h3>
              </div>
              <span className="meta">{artifacts.length ? `${artifacts.length} 个数据文件` : '无标记文件'}</span>
            </div>

            {artifacts.length > 0 ? (
              <div className="db-artifact-grid">
                {artifacts.map(art => {
                  const isSqlite =
                    art.name.endsWith('.db') ||
                    art.name.endsWith('.sqlite') ||
                    art.name.endsWith('.sqlite3');
                  return (
                    <div
                      key={art.path}
                      className={`db-artifact-card ${selectedSchemaFile === art.path ? 'selected' : ''}`}
                      onClick={() => {
                        if (isSqlite) {
                          setDbPath(art.path);
                          onNotify?.(`已设置查询数据库：${art.path}`);
                        } else {
                          void loadSchema(art.path);
                        }
                      }}
                    >
                      <div className="db-artifact-info">
                        {loadingSchema && selectedSchemaFile === art.path ? (
                          <LoaderCircle size={15} className="spin" />
                        ) : isSqlite ? (
                          <Database size={15} />
                        ) : (
                          <FileCode size={15} />
                        )}
                        <div>
                          <span className="db-artifact-name">{art.name}</span>
                          <span className="db-artifact-kind">{art.kind}</span>
                        </div>
                      </div>
                      <div className="db-artifact-actions">
                        {isSqlite && (
                          <span className="mini-badge-active">选为查询源</span>
                        )}
                        <button
                          className="text-button-sm"
                          onClick={e => {
                            e.stopPropagation();
                            if (isDesktop && project) void openProjectFile(project.id, art.path);
                          }}
                          title="在系统编辑器中查看"
                        >
                          <ExternalLink size={12} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="subcard-empty">
                未在项目根目录发现常见的数据库产物文件（.sqlite / .db / .sql / schema.prisma / drizzle.config 等）。你可以直接在下方输入要查询的数据库文件路径。
              </p>
            )}

            {selectedSchemaFile && schemaContent && (
              <div className="http-preview-box">
                <div className="http-preview-header">
                  <span>模式 DDL 预览：{selectedSchemaFile}</span>
                  <button
                    className="text-button-sm"
                    onClick={() => {
                      setSelectedSchemaFile(null);
                      setSchemaContent(null);
                    }}
                  >
                    收起
                  </button>
                </div>
                <pre className="http-code-preview">{schemaContent}</pre>
              </div>
            )}
          </section>

          {/* Interactive SQL Workbench */}
          <section className="sql-workbench-card">
            <div className="sql-workbench-top">
              <div className="db-target-selector">
                <span className="db-label">目标 SQLite 文件:</span>
                <input
                  className="db-path-input"
                  value={dbPath}
                  onChange={e => setDbPath(e.target.value)}
                  placeholder="项目内 SQLite 相对路径，如 local.db 或 data/app.sqlite"
                />
              </div>

              <div className="sql-quick-presets">
                <button
                  type="button"
                  className="preset-btn"
                  onClick={() => {
                    const q = "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name;";
                    setSqlQuery(q);
                    void runQuery(q);
                  }}
                >
                  查看所有表
                </button>
                <button
                  type="button"
                  className="preset-btn"
                  onClick={() => {
                    const q = "SELECT tbl_name, sql FROM sqlite_master WHERE type='table';";
                    setSqlQuery(q);
                    void runQuery(q);
                  }}
                >
                  查看建表语句
                </button>
              </div>
            </div>

            <div className="sql-editor-container">
              <textarea
                className="sql-textarea"
                rows={4}
                value={sqlQuery}
                onChange={e => setSqlQuery(e.target.value)}
                placeholder="输入 SELECT / PRAGMA / EXPLAIN 等 SQL 语句…"
              />
              <div className="sql-editor-footer">
                <span className="mono-subtle">支持 SQLite 标准语法与 PRAGMA 检查</span>
                <button
                  className="primary-button"
                  onClick={() => void runQuery()}
                  disabled={running || !sqlQuery.trim()}
                >
                  {running ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <Play size={14} />
                  )}
                  <span>{running ? '执行中…' : '执行查询'}</span>
                </button>
              </div>
            </div>

            {/* SQL Results Table */}
            {queryResult && (
              <div className="sql-results-area">
                <div className="results-header">
                  <div className="results-meta">
                    <Table size={15} />
                    <span>查询结果</span>
                    <span className="meta">
                      {queryResult.error
                        ? '执行异常'
                        : `${queryResult.durationMs}ms · 返回 ${queryResult.rowCount} 行`}
                    </span>
                  </div>
                </div>

                {queryResult.error ? (
                  <div className="sql-error-box">
                    <span>{queryResult.error}</span>
                  </div>
                ) : queryResult.columns.length === 0 ? (
                  <div className="sql-empty-box">
                    <span>执行成功，无返回数据列。</span>
                  </div>
                ) : (
                  <div className="sql-table-wrapper">
                    <table className="sql-data-table">
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
                                {cell === null ? (
                                  <span className="null-val">NULL</span>
                                ) : (
                                  String(cell)
                                )}
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
        </>
      )}
    </div>
  );
}
