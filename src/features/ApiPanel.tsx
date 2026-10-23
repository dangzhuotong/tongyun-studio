import { useState } from 'react';
import type { Project, ProjectInspection, ToolStatus } from '../contracts';
import ToolPanel from './ToolPanel';
import { Check, Code2, Copy, ExternalLink, FileCode } from '../components/Icons';
import { isDesktop, openProjectFile } from '../bridge';

export default function ApiPanel({
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

  const httpPaths = inspection?.httpFilePaths ?? [];

  return (
    <div className="feature-panel-layout">
      {project && (
        <section className="panel-subcard">
          <div className="section-heading">
            <div className="subcard-title">
              <FileCode size={16} className="title-icon" />
              <h3>接口请求文件 (.http / .rest)</h3>
            </div>
            <span className="meta">{httpPaths.length ? `共 ${httpPaths.length} 个文件` : '暂未发现'}</span>
          </div>
          {httpPaths.length ? (
            <div className="file-list">
              {httpPaths.map(path => (
                <div key={path} className="file-item">
                  <div className="file-info">
                    <Code2 size={15} className="file-icon" />
                    <span className="file-path" title={path}>{path}</span>
                  </div>
                  <div className="file-actions">
                    <button
                      className="text-button"
                      onClick={() => void openFile(path)}
                      disabled={!isDesktop || opening === path}
                      title="使用系统默认编辑器打开"
                    >
                      <ExternalLink size={13} />
                      {opening === path ? '打开中…' : '打开'}
                    </button>
                    <button
                      className="icon-button"
                      title="复制文件相对路径"
                      onClick={() => copyPath(path)}
                      aria-label="复制相对路径"
                    >
                      {copiedFile === path ? <Check size={14} className="accent-color" /> : <Copy size={14} />}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="subcard-empty-box">
              <p>当前项目尚未发现 <code>.http</code> 或 <code>.rest</code> 接口请求文件。</p>
              <span className="helper">在项目任意目录下创建例如 <code>api/health.http</code> 即可在此检索并在 <strong>Tongyun API</strong> 中集中调试。</span>
            </div>
          )}
        </section>
      )}

      <ToolPanel
        toolId="api"
        project={project}
        status={status}
        loading={loading}
        error={error}
        onRefresh={onRefresh}
      />
    </div>
  );
}
