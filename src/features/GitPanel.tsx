import { useState } from 'react';
import type { Project, ProjectInspection, ToolStatus } from '../contracts';
import ToolPanel from './ToolPanel';
import { Check, Clock, GitBranch, GitCommit } from '../components/Icons';

export default function GitPanel({
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
  const [copiedHash, setCopiedHash] = useState<string | null>(null);

  const copyHash = (hash: string) => {
    navigator.clipboard.writeText(hash);
    setCopiedHash(hash);
    onNotify?.(`已复制提交哈希：${hash}`);
    setTimeout(() => setCopiedHash(null), 2000);
  };

  const git = inspection?.git;
  const isRepo = git?.isRepository ?? false;
  const commits = git?.recentCommits ?? [];

  return (
    <div className="feature-panel-layout">
      {project && (
        <section className="panel-subcard">
          <div className="section-heading">
            <div className="subcard-title">
              <GitBranch size={16} className="title-icon" />
              <h3>版本仓库概况</h3>
            </div>
            <span className="meta">{isRepo ? 'Git 仓库' : '非 Git 仓库'}</span>
          </div>
          {isRepo ? (
            <div className="git-metric-grid">
              <div className="git-metric-card">
                <span className="metric-label">当前分支</span>
                <span className="metric-val mono">{git?.branch ?? '分离 HEAD'}</span>
              </div>
              <div className="git-metric-card">
                <span className="metric-label">HEAD 提交</span>
                <span className="metric-val mono">{git?.head ? git.head.slice(0, 8) : '—'}</span>
              </div>
              <div className="git-metric-card">
                <span className="metric-label">工作区未提交文件</span>
                <span className="metric-val">{git?.changedFiles ?? 0} 项</span>
              </div>
            </div>
          ) : (
            <div className="subcard-empty-box">
              <p>当前目录不是一个有效的 Git 仓库。</p>
              <span className="helper">可在项目目录下执行 <code>git init</code> 进行版本控制。</span>
            </div>
          )}
        </section>
      )}

      {project && isRepo && (
        <section className="panel-subcard">
          <div className="section-heading">
            <div className="subcard-title">
              <GitCommit size={16} className="title-icon" />
              <h3>最近提交历史</h3>
            </div>
            <span className="meta">{commits.length ? `最近 ${commits.length} 次` : '无提交'}</span>
          </div>
          {commits.length ? (
            <div className="commit-list">
              {commits.map(c => (
                <div key={c.hash} className="commit-item">
                  <div className="commit-main">
                    <button
                      className="commit-hash-pill"
                      onClick={() => copyHash(c.hash)}
                      title="点击复制完整哈希"
                      aria-label={`复制 ${c.hash}`}
                    >
                      {copiedHash === c.hash ? <Check size={11} className="accent-color" /> : null}
                      <code>{c.hash}</code>
                    </button>
                    <span className="commit-msg" title={c.message}>{c.message}</span>
                  </div>
                  <div className="commit-meta">
                    <span className="commit-author">{c.author}</span>
                    <span className="commit-time">
                      <Clock size={11} />
                      {c.relativeTime}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="subcard-empty">仓库中尚未产生任何提交历史。</p>
          )}
        </section>
      )}

      <ToolPanel
        toolId="git"
        project={project}
        status={status}
        loading={loading}
        error={error}
        onRefresh={onRefresh}
      />
    </div>
  );
}
