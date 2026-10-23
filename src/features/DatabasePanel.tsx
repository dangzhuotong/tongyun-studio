import { useState } from 'react';
import type { Project, ProjectInspection, ToolStatus } from '../contracts';
import ToolPanel from './ToolPanel';
import { Check, Copy, Database, ExternalLink, FileCode, ShieldCheck } from '../components/Icons';
import { isDesktop, openProjectFile } from '../bridge';

export default function DatabasePanel({
  project,
  inspection,
  status,
  loading,
  error,
  onRefresh,
  onNotify,
}: {
  project: Project | null;
  inspection?: ProjectInspection | null;
  status?: ToolStatus;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onNotify?: (msg: string) => void;
}) {
  const [copiedFile, setCopiedFile] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  const copyPath = (path: string) => {
    navigator.clipboard.writeText(path);
    setCopiedFile(path);
    onNotify?.(`已复制路径：${path}`);
    setTimeout(() => setCopiedFile(null), 2000);
  };

  const openFile = async (relPath: string) => {
    if (!project || !isDesktop) return;
    setOpening(relPath);
    try {
      await openProjectFile(project.id, relPath);
      onNotify?.(`已打开文件：${relPath}`);
    } catch (e) {
      onNotify?.(`无法打开文件：${e}`);
    } finally {
      setOpening(null);
    }
  };

  const artifacts = inspection?.dbArtifacts ?? [];

  return (
    <div className="feature-panel-layout">
      {project && (
        <section className="security-notice-card">
          <ShieldCheck size={20} className="notice-icon" />
          <div className="notice-content">
            <h4>本地工作台安全隔离准则</h4>
            <p>
              工作台绝不保存数据库密码凭据，绝不直连任何生产环境数据库。
              所有复杂连接、查询与数据变更计划均在独立的 <strong>橦云数据库</strong> 客户端内安全隔离执行。
            </p>
          </div>
        </section>
      )}

      {project && (
        <section className="panel-subcard">
          <div className="section-heading">
            <div className="subcard-title">
              <Database size={16} className="title-icon" />
              <h3>数据库资产与配置探测</h3>
            </div>
            <span className="meta">{artifacts.length ? `发现 ${artifacts.length} 项` : '未发现'}</span>
          </div>
          {artifacts.length ? (
            <div className="file-list">
              {artifacts.map(item => (
                <div key={item.path} className="file-item">
                  <div className="file-info">
                    <FileCode size={15} className="file-icon" />
                    <span className="file-path" title={item.path}>{item.path}</span>
                    <span className="badge">{item.kind.toUpperCase()}</span>
                  </div>
                  <div className="file-actions">
                    <button
                      className="text-button"
                      onClick={() => void openFile(item.path)}
                      disabled={!isDesktop || opening === item.path}
                      title="打开查看"
                    >
                      <ExternalLink size={13} />
                      {opening === item.path ? '打开中…' : '查看'}
                    </button>
                    <button
                      className="icon-button"
                      title="复制相对路径"
                      onClick={() => copyPath(item.path)}
                      aria-label="复制路径"
                    >
                      {copiedFile === item.path ? <Check size={14} className="accent-color" /> : <Copy size={14} />}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="subcard-empty-box">
              <p>当前项目根目录下未发现 SQL 脚本、Prisma 模式或 migrations 目录。</p>
              <span className="helper">可在项目内建立 <code>schema.sql</code> 或 <code>migrations/</code> 存放数据表定义。</span>
            </div>
          )}
        </section>
      )}

      <ToolPanel
        toolId="database"
        project={project}
        status={status}
        loading={loading}
        error={error}
        onRefresh={onRefresh}
      />
    </div>
  );
}
