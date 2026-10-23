import { useEffect, useState, type FormEvent } from 'react';
import type { Project, ProjectInspection, GitFileChange } from '../contracts';
import {
  getGitBranches,
  getGitChangedFiles,
  getGitDiff,
  createGitCommit,
  switchGitBranch,
} from '../bridge';
import {
  Check,
  Clock,
  GitBranch,
  GitCommit,
  LoaderCircle,
  RefreshCw,
} from '../components/Icons';

export default function GitPanel({
  project,
  inspection,
  onRefresh,
  onNotify,
}: {
  project: Project | null;
  inspection?: ProjectInspection | null;
  onRefresh?: () => void;
  onNotify?: (msg: string) => void;
}) {
  const git = inspection?.git;
  const isRepo = git?.isRepository ?? false;
  const commits = git?.recentCommits ?? [];

  const [branches, setBranches] = useState<string[]>([]);
  const [currentBranch, setCurrentBranch] = useState<string>(git?.branch ?? 'main');
  const [switchingBranch, setSwitchingBranch] = useState(false);

  const [changedFiles, setChangedFiles] = useState<GitFileChange[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diffText, setDiffText] = useState<string>('');
  const [loadingDiff, setLoadingDiff] = useState(false);

  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);

  const loadGitState = async () => {
    if (!project || !isRepo) return;
    try {
      const [bList, fList] = await Promise.all([
        getGitBranches(project.id),
        getGitChangedFiles(project.id),
      ]);
      setBranches(bList);
      setChangedFiles(fList);

      const firstFile = fList[0]?.path ?? null;
      setSelectedFile(firstFile);
      if (firstFile) {
        void loadDiff(firstFile);
      } else {
        void loadDiff(undefined);
      }
    } catch (e) {
      onNotify?.(`读取 Git 状态失败：${e}`);
    }
  };

  useEffect(() => {
    if (project && isRepo) {
      setCurrentBranch(git?.branch ?? 'main');
      void loadGitState();
    }
  }, [project?.id, isRepo, git?.branch]);

  const loadDiff = async (filePath?: string) => {
    if (!project) return;
    setLoadingDiff(true);
    try {
      const diff = await getGitDiff(project.id, filePath);
      setDiffText(diff || '(该文件或工作区暂无文本差异)');
    } catch (e) {
      setDiffText(`读取差异失败：${e}`);
    } finally {
      setLoadingDiff(false);
    }
  };

  const handleSelectFile = (path: string) => {
    setSelectedFile(path);
    void loadDiff(path);
  };

  const handleBranchChange = async (newBranch: string) => {
    if (!project || switchingBranch || newBranch === currentBranch) return;
    setSwitchingBranch(true);
    try {
      const msg = await switchGitBranch(project.id, newBranch);
      setCurrentBranch(newBranch);
      onNotify?.(msg);
      onRefresh?.();
      void loadGitState();
    } catch (e) {
      onNotify?.(`切换分支失败：${e}`);
    } finally {
      setSwitchingBranch(false);
    }
  };

  const handleCommit = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    if (!project || committing || !commitMessage.trim()) return;

    setCommitting(true);
    try {
      const result = await createGitCommit(project.id, commitMessage.trim());
      setCommitMessage('');
      onNotify?.(`提交成功：${result}`);
      onRefresh?.();
      void loadGitState();
    } catch (err) {
      onNotify?.(`提交失败：${err}`);
    } finally {
      setCommitting(false);
    }
  };

  const copyHash = (hash: string) => {
    navigator.clipboard.writeText(hash);
    setCopiedHash(hash);
    onNotify?.(`已复制提交哈希：${hash}`);
    setTimeout(() => setCopiedHash(null), 2000);
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'M':
        return 'status-modified';
      case 'A':
      case '??':
        return 'status-added';
      case 'D':
        return 'status-deleted';
      default:
        return 'status-other';
    }
  };

  const renderDiffLine = (line: string, index: number) => {
    let className = 'diff-line';
    if (line.startsWith('+') && !line.startsWith('+++')) {
      className += ' diff-line-add';
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      className += ' diff-line-del';
    } else if (line.startsWith('@@')) {
      className += ' diff-line-hunk';
    }
    return (
      <div key={index} className={className}>
        <span className="diff-line-content">{line}</span>
      </div>
    );
  };

  return (
    <div className="feature-panel-layout" aria-labelledby="git-title">
      <div className="workbench-header">
        <div className="workbench-title-group">
          <div className="large-tool-icon">
            <GitBranch size={22} strokeWidth={1.5} />
          </div>
          <div>
            <h2 id="git-title">Tongyun Git · 版本工作台</h2>
            <p>检查工作区代码差异，直接在应用内完成代码提交、分支切换与提交记录追溯。</p>
          </div>
        </div>
        <div className="workbench-badges">
          <span className="badge-matcha">原生 Git 工作流</span>
          {project && <span className="mono-subtle">{project.name}</span>}
        </div>
      </div>

      {!project ? (
        <div className="panel-empty-placeholder">
          <GitBranch size={32} strokeWidth={1.2} />
          <p>请先在左侧选择或添加一个项目，以管理代码版本与查看提交记录。</p>
        </div>
      ) : !isRepo ? (
        <div className="panel-empty-placeholder">
          <GitBranch size={32} strokeWidth={1.2} />
          <p>当前项目目录不是一个 Git 仓库。请在终端执行 git init 初始化仓库。</p>
        </div>
      ) : (
        <>
          {/* Branch & Status Toolbar */}
          <div className="git-toolbar-bar">
            <div className="branch-selector-group">
              <GitBranch size={15} />
              <span className="toolbar-label">当前分支:</span>
              <select
                className="branch-select"
                value={currentBranch}
                onChange={e => void handleBranchChange(e.target.value)}
                disabled={switchingBranch}
              >
                {branches.length > 0 ? (
                  branches.map(b => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))
                ) : (
                  <option value={currentBranch}>{currentBranch}</option>
                )}
              </select>
              {switchingBranch && <LoaderCircle size={13} className="spin" />}
            </div>

            <div className="git-toolbar-meta">
              <span className="badge-changes">
                {changedFiles.length} 项未提交变更
              </span>
              <button
                className="text-button-sm"
                onClick={() => {
                  onRefresh?.();
                  void loadGitState();
                }}
                title="重新扫描工作区状态"
              >
                <RefreshCw size={13} />
                刷新
              </button>
            </div>
          </div>

          {/* Side-by-Side Workbench: Left Changes List, Right Diff & Commit */}
          <div className="git-workbench-split">
            {/* Left Column: Changed Files */}
            <div className="git-changed-files-pane">
              <div className="pane-header">
                <span>变更文件 ({changedFiles.length})</span>
                {changedFiles.length > 0 && (
                  <button
                    className="text-button-xs"
                    onClick={() => {
                      setSelectedFile(null);
                      void loadDiff(undefined);
                    }}
                  >
                    全部差异
                  </button>
                )}
              </div>

              <div className="changed-files-list">
                {changedFiles.length === 0 ? (
                  <div className="files-empty-state">
                    <Check size={18} className="accent-color" />
                    <span>工作区整洁，无未提交变更</span>
                  </div>
                ) : (
                  changedFiles.map(f => (
                    <div
                      key={f.path}
                      className={`changed-file-row ${selectedFile === f.path ? 'selected' : ''}`}
                      onClick={() => handleSelectFile(f.path)}
                    >
                      <span className={`status-tag ${getStatusColor(f.status)}`}>
                        {f.status}
                      </span>
                      <span className="file-path" title={f.path}>
                        {f.path}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Right Column: Diff Viewer & In-App Commit Box */}
            <div className="git-diff-commit-pane">
              {/* In-app Commit Box */}
              <form onSubmit={handleCommit} className="commit-box-card">
                <textarea
                  className="commit-textarea"
                  placeholder="填写提交说明 (例如 feat: 添加用户设置页面，支持 Cmd+Enter 快速提交)…"
                  rows={2}
                  value={commitMessage}
                  onChange={e => setCommitMessage(e.target.value)}
                  onKeyDown={e => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                      e.preventDefault();
                      void handleCommit();
                    }
                  }}
                  disabled={committing || changedFiles.length === 0}
                />
                <div className="commit-actions-bar">
                  <span className="meta">快捷键: ⌘ + Enter 快速提交</span>
                  <button
                    type="submit"
                    className="primary-button-sm"
                    disabled={committing || !commitMessage.trim() || changedFiles.length === 0}
                  >
                    {committing ? (
                      <LoaderCircle size={13} className="spin" />
                    ) : (
                      <GitCommit size={13} />
                    )}
                    <span>{committing ? '提交中…' : '提交更改'}</span>
                  </button>
                </div>
              </form>

              {/* Diff Viewer Area */}
              <div className="diff-viewer-card">
                <div className="diff-viewer-header">
                  <span>差异对比：{selectedFile ? selectedFile : '工作区所有文件'}</span>
                  {loadingDiff && <LoaderCircle size={13} className="spin" />}
                </div>
                <div className="diff-code-area">
                  {diffText.split('\n').map((line, idx) =>
                    renderDiffLine(line, idx),
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Recent Commits Activity */}
          {commits.length > 0 && (
            <section className="panel-subcard">
              <div className="section-heading">
                <div className="subcard-title">
                  <Clock size={15} className="title-icon" />
                  <h3>近期提交记录</h3>
                </div>
                <span className="meta">{commits.length} 次记录</span>
              </div>
              <div className="commit-list">
                {commits.map(c => (
                  <div key={c.hash} className="commit-item">
                    <div className="commit-main">
                      <code
                        className="mini-hash"
                        onClick={() => copyHash(c.hash)}
                        title="点击复制哈希"
                      >
                        {c.hash}
                        {copiedHash === c.hash && ' ✓'}
                      </code>
                      <span className="commit-msg">{c.message}</span>
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
            </section>
          )}
        </>
      )}
    </div>
  );
}
