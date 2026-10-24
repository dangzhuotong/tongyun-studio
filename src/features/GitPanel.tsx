import { useEffect, useState, type FormEvent } from 'react';
import type { Project, ProjectInspection, GitFileChange, AgentSessionState } from '../contracts';
import {
  getGitBranches,
  getGitChangedFiles,
  getGitDiff,
  createGitCommit,
  gitCommitAmend,
  switchGitBranch,
  gitStageFile,
  gitUnstageFile,
  gitStageAll,
  gitUnstageAll,
  gitDiscardFile,
  gitCreateBranch,
  gitRemoteSync,
} from '../bridge';
import {
  Bot,
  Clock,
  DownloadCloud,
  GitBranch,
  GitCommit,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  Sparkles,
  Undo2,
  UploadCloud,
} from '../components/Icons';

export default function GitPanel({
  project,
  inspection,
  session,
  onRefresh,
  onNotify,
}: {
  project: Project | null;
  inspection?: ProjectInspection | null;
  session?: AgentSessionState | null;
  onRefresh?: () => void;
  onNotify?: (msg: string) => void;
}) {
  const git = inspection?.git;
  const isRepo = git?.isRepository ?? false;
  const commits = git?.recentCommits ?? [];

  const [branches, setBranches] = useState<string[]>([]);
  const [currentBranch, setCurrentBranch] = useState<string>(git?.branch ?? 'main');
  const [switchingBranch, setSwitchingBranch] = useState(false);
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');

  const [changedFiles, setChangedFiles] = useState<GitFileChange[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diffText, setDiffText] = useState<string>('');
  const [loadingDiff, setLoadingDiff] = useState(false);

  const [commitMessage, setCommitMessage] = useState('');
  const [isAmend, setIsAmend] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<'fetch' | 'pull' | 'push' | null>(null);

  const agentGitActions = (session?.actions ?? []).filter(a => a.kind === 'git' || a.kind === 'edit');

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
      if (!selectedFile && firstFile) {
        setSelectedFile(firstFile);
        void loadDiff(firstFile);
      } else if (selectedFile) {
        void loadDiff(selectedFile);
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
      setDiffText(diff || '(该文件暂无文本差异)');
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

  const handleStageFile = async (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    if (!project) return;
    try {
      await gitStageFile(project.id, path);
      onNotify?.(`已暂存：${path}`);
      void loadGitState();
    } catch (err) {
      onNotify?.(`暂存失败：${err}`);
    }
  };

  const handleUnstageFile = async (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    if (!project) return;
    try {
      await gitUnstageFile(project.id, path);
      onNotify?.(`已取消暂存：${path}`);
      void loadGitState();
    } catch (err) {
      onNotify?.(`取消暂存失败：${err}`);
    }
  };

  const handleDiscardFile = async (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    if (!project) return;
    if (!window.confirm(`确定要丢弃文件 ${path} 的所有修改吗？此操作无法撤销。`)) return;
    try {
      await gitDiscardFile(project.id, path);
      onNotify?.(`已丢弃修改：${path}`);
      void loadGitState();
    } catch (err) {
      onNotify?.(`丢弃修改失败：${err}`);
    }
  };

  const handleStageAll = async () => {
    if (!project) return;
    try {
      await gitStageAll(project.id);
      onNotify?.('已全部暂存');
      void loadGitState();
    } catch (err) {
      onNotify?.(`全部暂存失败：${err}`);
    }
  };

  const handleUnstageAll = async () => {
    if (!project) return;
    try {
      await gitUnstageAll(project.id);
      onNotify?.('已取消全部暂存');
      void loadGitState();
    } catch (err) {
      onNotify?.(`取消全部暂存失败：${err}`);
    }
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

  const handleCreateBranch = async (e: FormEvent) => {
    e.preventDefault();
    if (!project || !newBranchName.trim()) return;
    try {
      const msg = await gitCreateBranch(project.id, newBranchName.trim());
      setCreatingBranch(false);
      setNewBranchName('');
      onNotify?.(msg);
      onRefresh?.();
      void loadGitState();
    } catch (err) {
      onNotify?.(`创建分支失败：${err}`);
    }
  };

  const handleSync = async (action: 'fetch' | 'pull' | 'push') => {
    if (!project || syncing) return;
    setSyncing(action);
    try {
      const msg = await gitRemoteSync(project.id, action);
      onNotify?.(msg);
      onRefresh?.();
      void loadGitState();
    } catch (err) {
      onNotify?.(`${action} 失败：${err}`);
    } finally {
      setSyncing(null);
    }
  };

  const handleCommit = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    if (!project || committing || !commitMessage.trim() || (!isAmend && !changedFiles.some(file => file.staged))) return;

    setCommitting(true);
    try {
      if (isAmend) {
        const result = await gitCommitAmend(project.id, commitMessage.trim());
        onNotify?.(`Amend 提交成功：${result}`);
      } else {
        const result = await createGitCommit(project.id, commitMessage.trim());
        onNotify?.(`提交成功：${result}`);
      }
      setCommitMessage('');
      setIsAmend(false);
      onRefresh?.();
      void loadGitState();
    } catch (err) {
      onNotify?.(`提交失败：${err}`);
    } finally {
      setCommitting(false);
    }
  };

  const generateCommitDraft = () => {
    const staged = changedFiles.filter(f => f.staged);
    const targets = staged;
    if (targets.length === 0) {
      onNotify?.('请先暂存需要提交的文件');
      return;
    }

    const first = targets[0].path;
    let type = 'feat';
    if (first.includes('test')) type = 'test';
    else if (first.includes('fix') || first.includes('bug')) type = 'fix';
    else if (first.includes('doc') || first.endsWith('.md')) type = 'docs';
    else if (first.includes('style') || first.endsWith('.css')) type = 'style';

    const cleanName = first.split('/').pop()?.replace(/\.[^/.]+$/, '') || 'core';
    const generated = `${type}: 更新 ${cleanName} 并优化相关实现`;
    setCommitMessage(generated);
    onNotify?.('已按暂存文件名生成本地规则草稿，请核对内容');
  };

  const copyHash = (hash: string) => {
    navigator.clipboard.writeText(hash);
    setCopiedHash(hash);
    onNotify?.(`已复制提交哈希：${hash}`);
    setTimeout(() => setCopiedHash(null), 2000);
  };

  const stagedFiles = changedFiles.filter(f => f.staged);
  const unstagedFiles = changedFiles.filter(f => !f.staged);

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
            <p>暂存区精细化管理、分支创建切换、远程同步、代码差异对比与 本地规则提交草稿。</p>
          </div>
        </div>
        <div className="workbench-badges">
          <span className="badge-matcha">双栏暂存工作流</span>
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
          {/* Branch & Remote Sync Toolbar */}
          <div className="git-toolbar-bar">
            <div className="branch-selector-group">
              <GitBranch size={15} />
              <span className="toolbar-label">分支:</span>
              <select
                className="branch-select"
                value={currentBranch}
                onChange={e => void handleBranchChange(e.target.value)}
                disabled={switchingBranch}
              >
                {branches.map(b => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
              {switchingBranch && <LoaderCircle size={13} className="spin" />}

              {!creatingBranch ? (
                <button
                  className="text-button-sm"
                  onClick={() => setCreatingBranch(true)}
                  title="新建并切换到新分支"
                >
                  + 新建分支
                </button>
              ) : (
                <form onSubmit={handleCreateBranch} className="inline-branch-form">
                  <input
                    className="inline-branch-input"
                    placeholder="分支名 feature/..."
                    value={newBranchName}
                    onChange={e => setNewBranchName(e.target.value)}
                    autoFocus
                  />
                  <button type="submit" className="primary-button-sm">
                    创建
                  </button>
                  <button
                    type="button"
                    className="text-button-xs"
                    onClick={() => setCreatingBranch(false)}
                  >
                    取消
                  </button>
                </form>
              )}
            </div>

            <div className="git-toolbar-meta">
              <div className="remote-actions-group">
                <button
                  className="git-sync-btn"
                  onClick={() => void handleSync('fetch')}
                  disabled={!!syncing}
                  title="获取远程更新"
                >
                  <RefreshCw size={12} className={syncing === 'fetch' ? 'spin' : ''} />
                  Fetch
                </button>
                <button
                  className="git-sync-btn"
                  onClick={() => void handleSync('pull')}
                  disabled={!!syncing}
                  title="拉取并合并远程变更"
                >
                  <DownloadCloud size={12} className={syncing === 'pull' ? 'spin' : ''} />
                  Pull
                </button>
                <button
                  className="git-sync-btn"
                  onClick={() => void handleSync('push')}
                  disabled={!!syncing}
                  title="推送本地提交至远程"
                >
                  <UploadCloud size={12} className={syncing === 'push' ? 'spin' : ''} />
                  Push
                </button>
              </div>

              <span className="badge-changes">
                {stagedFiles.length} 暂存 / {unstagedFiles.length} 未暂存
              </span>
            </div>
          </div>

          {agentGitActions.length > 0 && (
            <div className="panel-subcard agent-subcard" style={{ marginBottom: 12 }}>
              <div className="section-heading">
                <div className="subcard-title">
                  <Bot size={15} className="accent-color" />
                  <h3>Agent 代码变动与交付流</h3>
                  <span className="mini-badge-accent">{session?.agentName ?? 'Agent'}</span>
                </div>
                <span className="meta">{agentGitActions.length} 项变动交付</span>
              </div>
              <div className="agent-action-mini-list">
                {agentGitActions.slice(-3).reverse().map(act => (
                  <div key={act.id} className="agent-action-mini-item">
                    <div className="action-mini-header">
                      <span className={`status-dot ${act.status === 'done' ? 'available' : 'active-pulse'}`} />
                      <span className="mini-badge">{act.kind}</span>
                      <code className="action-mini-cmd">{act.title}</code>
                      <span className="mono-subtle">{act.timestamp}</span>
                    </div>
                    <div className="action-mini-detail mono-subtle">{act.detail}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Side-by-Side Workbench: Left Changes Dual-List, Right Diff & Commit */}
          <div className="git-workbench-split">
            {/* Left Column: Dual Staged / Unstaged Lists */}
            <div className="git-changed-files-pane">
              {/* Staged Section */}
              <div className="staging-section">
                <div className="pane-header">
                  <span>已暂存改动 (Staged: {stagedFiles.length})</span>
                  {stagedFiles.length > 0 && (
                    <button className="text-button-xs" onClick={handleUnstageAll}>
                      取消全选
                    </button>
                  )}
                </div>
                <div className="changed-files-list">
                  {stagedFiles.length === 0 ? (
                    <div className="files-empty-hint">暂无已暂存文件</div>
                  ) : (
                    stagedFiles.map(f => (
                      <div
                        key={`staged:${f.path}`}
                        className={`changed-file-row ${selectedFile === f.path ? 'selected' : ''}`}
                        onClick={() => handleSelectFile(f.path)}
                      >
                        <span className="status-tag status-added">{f.status}</span>
                        <span className="file-path" title={f.path}>
                          {f.path}
                        </span>
                        <button
                          className="file-action-icon-btn"
                          onClick={e => void handleUnstageFile(e, f.path)}
                          title="取消暂存"
                        >
                          <Minus size={12} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Unstaged Section */}
              <div className="staging-section unstaged">
                <div className="pane-header">
                  <span>工作区改动 (Unstaged: {unstagedFiles.length})</span>
                  {unstagedFiles.length > 0 && (
                    <button className="text-button-xs" onClick={handleStageAll}>
                      全部暂存
                    </button>
                  )}
                </div>
                <div className="changed-files-list">
                  {unstagedFiles.length === 0 ? (
                    <div className="files-empty-hint">工作区干净，无未暂存改动</div>
                  ) : (
                    unstagedFiles.map(f => (
                      <div
                        key={`unstaged:${f.path}`}
                        className={`changed-file-row ${selectedFile === f.path ? 'selected' : ''}`}
                        onClick={() => handleSelectFile(f.path)}
                      >
                        <span
                          className={`status-tag ${
                            f.status === 'M'
                              ? 'status-modified'
                              : f.status === 'D'
                              ? 'status-deleted'
                              : 'status-other'
                          }`}
                        >
                          {f.status}
                        </span>
                        <span className="file-path" title={f.path}>
                          {f.path}
                        </span>
                        <div className="file-actions-pair">
                          <button
                            className="file-action-icon-btn"
                            onClick={e => void handleDiscardFile(e, f.path)}
                            title="丢弃此文件的修改"
                          >
                            <Undo2 size={12} />
                          </button>
                          <button
                            className="file-action-icon-btn stage"
                            onClick={e => void handleStageFile(e, f.path)}
                            title="暂存此文件"
                          >
                            <Plus size={12} />
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            {/* Right Column: Diff Viewer & In-App Commit Box */}
            <div className="git-diff-commit-pane">
              {/* In-app Commit Box */}
              <form onSubmit={handleCommit} className="commit-box-card">
                <div className="commit-tools-row">
                  <div className="conventional-prefixes">
                    {['feat:', 'fix:', 'refactor:', 'docs:', 'test:', 'chore:'].map(prefix => (
                      <button
                        key={prefix}
                        type="button"
                        className="prefix-chip"
                        onClick={() => setCommitMessage(prev => (prev.startsWith(prefix) ? prev : `${prefix} ${prev.replace(/^[a-z]+:\s*/, '')}`))}
                      >
                        {prefix}
                      </button>
                    ))}
                  </div>

                  <button
                    type="button"
                    className="ai-assist-btn"
                    onClick={generateCommitDraft}
                    title="按已暂存文件名生成草稿，不调用 AI"
                  >
                    <Sparkles size={12} />
                    生成提交草稿
                  </button>

                  {session?.activeGoal && (
                    <button
                      type="button"
                      className="ai-assist-btn"
                      onClick={() => setCommitMessage(`feat: ${session.activeGoal}`)}
                      title={`直接使用 Agent 目标: ${session.activeGoal}`}
                    >
                      <Bot size={12} />
                      填入 Agent 目标
                    </button>
                  )}
                </div>

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
                  disabled={committing}
                />

                <div className="commit-actions-bar">
                  <label className="amend-checkbox-label">
                    <input
                      type="checkbox"
                      checked={isAmend}
                      onChange={e => setIsAmend(e.target.checked)}
                    />
                    <span>Amend (修改上一次提交)</span>
                  </label>

                  <div className="commit-buttons-group">
                    <span className="meta">仅提交暂存区 · ⌘ + Enter</span>
                    <button
                      type="submit"
                      className="primary-button-sm"
                      disabled={committing || !commitMessage.trim() || (!isAmend && stagedFiles.length === 0)}
                    >
                      {committing ? (
                        <LoaderCircle size={13} className="spin" />
                      ) : (
                        <GitCommit size={13} />
                      )}
                      <span>{committing ? '提交中…' : isAmend ? '确认 Amend' : '提交已暂存'}</span>
                    </button>
                  </div>
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
