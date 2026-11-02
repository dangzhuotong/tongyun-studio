import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Project, ProjectInspection, GitFileChange, GitLogCommit, GitCommitDetails, GitStashEntry, AgentSessionState } from '../contracts';
import {
  getGitBranches,
  getGitChangedFiles,
  getGitDiff,
  getGitHistory,
  getGitCommitDetails,
  getGitCommitFileDiff,
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
  gitStashList,
  gitStashPush,
  gitStashApply,
  gitStashPop,
  gitStashDrop,
} from '../bridge';
import { computeGitGraphRows, relativeCommitTime } from './gitGraph';
import Modal from '../components/Modal';
import { parseDiff, splitHunks, diffStats, formatStats, type ParsedDiffLine } from './diffParser';

const LANE_COLORS = ['#4d7c5d', '#3e6f9e', '#c2593f', '#8b6e3c'];
import {
  Archive,
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
  X,
} from '../components/Icons';

interface PendingConfirm {
  title: string;
  description: string;
  tip: string;
  detail: string;
  confirmLabel: string;
  run: () => Promise<void>;
}

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

  // Log Tree view
  const [view, setView] = useState<'changes' | 'log'>('changes');
  const [historyCommits, setHistoryCommits] = useState<GitLogCommit[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [allBranches, setAllBranches] = useState(false);
  const [selectedOid, setSelectedOid] = useState<string | null>(null);
  const [commitDetails, setCommitDetails] = useState<GitCommitDetails | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [selectedCommitFile, setSelectedCommitFile] = useState<string | null>(null);
  const [commitFileDiff, setCommitFileDiff] = useState('');
  const [loadingCommitDiff, setLoadingCommitDiff] = useState(false);

  const graphRows = useMemo(() => computeGitGraphRows(historyCommits), [historyCommits]);
  const maxLane = graphRows.reduce((max, row) => Math.max(max, row.laneCount), 1);

  const loadHistory = async (append: boolean) => {
    if (!project || !isRepo || loadingHistory) return;
    const owner = project.id;
    setLoadingHistory(true);
    setHistoryError(null);
    try {
      const skip = append ? historyCommits.length : 0;
      const result = await getGitHistory(owner, skip, 100, allBranches);
      if (project?.id !== owner) return;
      setHistoryCommits(prev => (append ? [...prev, ...result.commits] : result.commits));
      setHistoryTotal(result.total);
      setHistoryHasMore(result.hasMore);
    } catch (e) {
      if (project?.id === owner) setHistoryError(`读取提交历史失败：${e}`);
    } finally {
      setLoadingHistory(false);
    }
  };

  const openCommit = async (oid: string) => {
    if (!project) return;
    const owner = project.id;
    setSelectedOid(oid);
    setSelectedCommitFile(null);
    setCommitFileDiff('');
    setLoadingDetails(true);
    setCommitDetails(null);
    try {
      const details = await getGitCommitDetails(owner, oid);
      if (project?.id !== owner) return;
      setCommitDetails(details);
      const first = details.files[0]?.path ?? null;
      if (first) void loadCommitFileDiff(details.oid, first, details.files[0]?.oldPath ?? null);
    } catch (e) {
      if (project?.id === owner) onNotify?.(`读取提交详情失败：${e}`);
    } finally {
      setLoadingDetails(false);
    }
  };

  const loadCommitFileDiff = async (oid: string, filePath: string, oldPath?: string | null) => {
    if (!project) return;
    const owner = project.id;
    setSelectedCommitFile(filePath);
    setLoadingCommitDiff(true);
    try {
      const diff = await getGitCommitFileDiff(owner, oid, filePath, oldPath);
      if (project?.id !== owner) return;
      setCommitFileDiff(diff || '(该文件无文本差异)');
    } catch (e) {
      if (project?.id === owner) setCommitFileDiff(`读取差异失败：${e}`);
    } finally {
      setLoadingCommitDiff(false);
    }
  };

  useEffect(() => {
    setHistoryCommits([]);
    setHistoryHasMore(false);
    setHistoryTotal(0);
    setSelectedOid(null);
    setCommitDetails(null);
    setCommitFileDiff('');
    setSelectedCommitFile(null);
    if (project && isRepo && view === 'log') void loadHistory(false);
  }, [project?.id, view, allBranches, isRepo]);

  const [stashOpen, setStashOpen] = useState(false);
  const [stashEntries, setStashEntries] = useState<GitStashEntry[]>([]);
  const [stashMessage, setStashMessage] = useState('');
  const [stashUntracked, setStashUntracked] = useState(true);
  const [stashBusy, setStashBusy] = useState<'push' | 'list' | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

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
      setStashEntries([]);
      void loadGitState();
    }
  }, [project?.id, isRepo, git?.branch]);

  const loadStashList = async () => {
    if (!project || !isRepo) return;
    setStashBusy('list');
    try {
      setStashEntries(await gitStashList(project.id));
    } catch (e) {
      onNotify?.(`读取贮藏列表失败：${e}`);
    } finally {
      setStashBusy(null);
    }
  };

  const handleToggleStash = () => {
    const next = !stashOpen;
    setStashOpen(next);
    if (next) void loadStashList();
  };

  const runStashAction = async (action: () => Promise<string>, done: string) => {
    if (!project || stashBusy) return;
    try {
      onNotify?.(`${done}：${await action()}`);
      onRefresh?.();
      void loadGitState();
      void loadStashList();
    } catch (err) {
      onNotify?.(`${done}失败：${err}`);
    }
  };

  const handleStashPush = async (event: FormEvent) => {
    event.preventDefault();
    if (!project || !changedFiles.length) {
      onNotify?.('工作区没有改动，无需贮藏');
      return;
    }
    setStashBusy('push');
    try {
      const message = stashMessage.trim();
      onNotify?.(await gitStashPush(project.id, message || undefined, stashUntracked));
      setStashMessage('');
      onRefresh?.();
      void loadGitState();
      void loadStashList();
    } catch (err) {
      onNotify?.(`贮藏失败：${err}`);
    } finally {
      setStashBusy(null);
    }
  };

  const askConfirm = (confirm: PendingConfirm) => setPendingConfirm(confirm);

  const handleConfirmRun = async () => {
    if (!pendingConfirm) return;
    setConfirmBusy(true);
    try {
      await pendingConfirm.run();
      setPendingConfirm(null);
    } finally {
      setConfirmBusy(false);
    }
  };

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

  const handleDiscardFile = (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    if (!project) return;
    askConfirm({
      title: '丢弃文件修改',
      description: `确定要丢弃 ${path} 的全部修改吗？`,
      tip: '未跟踪文件会被删除，已跟踪文件会回到 HEAD 版本，此操作无法通过工作台撤销。',
      detail: path,
      confirmLabel: '确认丢弃',
      run: async () => {
        await gitDiscardFile(project.id, path);
        onNotify?.(`已丢弃修改：${path}`);
        void loadGitState();
      },
    });
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
      if (view === 'log') void loadHistory(false);
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

  const diffKindClass: Record<ParsedDiffLine['kind'], string> = {
    context: 'diff-line-context',
    add: 'diff-line-add',
    delete: 'diff-line-del',
    hunk: 'diff-line-hunk',
    file: 'diff-line-file',
    meta: 'diff-line-file',
  };

  const renderParsedLine = (line: ParsedDiffLine, key: string) => (
    <div key={key} className={`diff-line diff-gutter-row ${diffKindClass[line.kind]}`}>
      <span className="diff-ln">{line.oldLine ?? ''}</span>
      <span className="diff-ln">{line.newLine ?? ''}</span>
      <span className="diff-line-content">{line.text}</span>
    </div>
  );

  const parsedLines = parseDiff(diffText);
  const hunkBlocks = splitHunks(parsedLines);
  const totalStats = diffStats(parsedLines);

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

              <div className="stash-toggle-group">
                <button
                  className="git-sync-btn"
                  onClick={handleToggleStash}
                  title="查看与管理贮藏 (Stash)"
                  aria-expanded={stashOpen}
                >
                  <Archive size={12} />
                  Stash 贮藏
                  {stashEntries.length > 0 && <span className="stash-count">{stashEntries.length}</span>}
                </button>
              </div>

              <span className="badge-changes">
                {stagedFiles.length} 暂存 / {unstagedFiles.length} 未暂存
              </span>
            </div>
          </div>

          {/* View switch: Changes vs Log Tree */}
          <div className="git-view-switch" role="tablist" aria-label="Git 视图切换">
            <button
              type="button"
              role="tab"
              aria-selected={view === 'changes'}
              className={`git-view-tab ${view === 'changes' ? 'active' : ''}`}
              onClick={() => setView('changes')}
            >
              改动视图 (Changes)
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'log'}
              className={`git-view-tab ${view === 'log' ? 'active' : ''}`}
              onClick={() => setView('log')}
            >
              提交历史 (Log Tree)
            </button>
          </div>

          {/* Stash Manager */}
          {stashOpen && (
            <div className="panel-subcard stash-subcard">
              <div className="section-heading">
                <div className="subcard-title">
                  <Archive size={15} className="accent-color" />
                  <h3>贮藏管理 (Stash)</h3>
                  <span className="mini-badge-accent">{stashEntries.length} 条</span>
                </div>
                <div className="stash-heading-actions">
                  <button className="text-button-xs" onClick={() => void loadStashList()} disabled={stashBusy === 'list'}>
                    刷新
                  </button>
                  <button className="text-button-xs" onClick={() => setStashOpen(false)} aria-label="关闭贮藏面板">
                    <X size={12} />
                  </button>
                </div>
              </div>

              <form onSubmit={handleStashPush} className="stash-push-form">
                <input
                  className="modal-input"
                  placeholder="贮藏备注（可留空，默认「橦云工作台贮藏」）"
                  value={stashMessage}
                  onChange={e => setStashMessage(e.target.value)}
                  disabled={stashBusy === 'push'}
                />
                <label className="amend-checkbox-label">
                  <input
                    type="checkbox"
                    checked={stashUntracked}
                    onChange={e => setStashUntracked(e.target.checked)}
                  />
                  <span>包含未跟踪文件 (--include-untracked)</span>
                </label>
                <button
                  type="submit"
                  className="primary-button-sm"
                  disabled={stashBusy === 'push' || changedFiles.length === 0}
                >
                  {stashBusy === 'push' ? <LoaderCircle size={13} className="spin" /> : <Archive size={13} />}
                  <span>{stashBusy === 'push' ? '贮藏中…' : '贮藏当前改动'}</span>
                </button>
              </form>

              <div className="stash-list">
                {stashBusy === 'list' ? (
                  <div className="files-empty-hint">正在读取贮藏列表…</div>
                ) : stashEntries.length === 0 ? (
                  <div className="files-empty-hint">暂无贮藏记录</div>
                ) : (
                  stashEntries.map(entry => {
                    if (!project) return null;
                    return (
                      <div key={entry.reference} className="stash-row">
                        <code className="stash-ref">{entry.reference}</code>
                        <div className="stash-meta">
                          <span className="stash-msg" title={entry.message}>{entry.message}</span>
                          <span className="mono-subtle">{entry.date}</span>
                        </div>
                        <div className="stash-actions">
                          <button
                            className="file-action-icon-btn"
                            onClick={() => void runStashAction(() => gitStashApply(project.id, entry.index), '应用贮藏')}
                            disabled={!!stashBusy}
                            title="Apply（保留贮藏条目）"
                          >
                            Apply
                          </button>
                          <button
                            className="file-action-icon-btn"
                            onClick={() => void runStashAction(() => gitStashPop(project.id, entry.index), '弹出贮藏')}
                            disabled={!!stashBusy}
                            title="Pop（恢复并删除条目）"
                          >
                            Pop
                          </button>
                          <button
                            className="file-action-icon-btn danger"
                            onClick={() => askConfirm({
                              title: '删除贮藏条目',
                              description: `确定要删除 ${entry.reference} 吗？`,
                              tip: '删除后该贮藏内容无法从工作台找回，请确认已不需要这些改动。',
                              detail: entry.message,
                              confirmLabel: '确认删除',
                              run: async () => {
                                onNotify?.(await gitStashDrop(project.id, entry.index));
                                void loadStashList();
                              },
                            })}
                            disabled={!!stashBusy}
                            title="Drop（丢弃贮藏）"
                          >
                            Drop
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

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
          {view === 'changes' ? (
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
                  <span className="diff-header-right">
                    {hunkBlocks.length > 0 && (
                      <span className="diff-total-stats">{formatStats(totalStats)}</span>
                    )}
                    {loadingDiff && <LoaderCircle size={13} className="spin" />}
                  </span>
                </div>
                <div className="diff-code-area diff-gutter-grid">
                  {hunkBlocks.length > 0 ? (
                    hunkBlocks.map((block, blockIndex) => (
                      <div key={`hunk:${blockIndex}`} className="diff-hunk-block">
                        <div className="diff-hunk-header">
                          <span className="diff-hunk-range">{block[0]?.text ?? ''}</span>
                          <span className="diff-hunk-stats">{formatStats(diffStats(block))}</span>
                        </div>
                        {block.slice(1).map((line, lineIndex) =>
                          renderParsedLine(line, `h${blockIndex}:${lineIndex}`),
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="diff-plain-message">{diffText || '(该文件暂无文本差异)'}</div>
                  )}
                </div>
              </div>
            </div>
          </div>

          ) : (
            <div className="git-log-pane">
              <div className="git-log-toolbar">
                <label className="git-log-scope">
                  <input
                    type="checkbox"
                    checked={allBranches}
                    onChange={e => setAllBranches(e.target.checked)}
                  />
                  <span>全部分支</span>
                </label>
                <button
                  type="button"
                  className="git-sync-btn"
                  onClick={() => void loadHistory(false)}
                  disabled={loadingHistory}
                  title="刷新提交历史"
                >
                  <RefreshCw size={12} className={loadingHistory ? 'spin' : ''} />
                  刷新
                </button>
                <span className="meta">
                  {historyTotal > 0
                    ? `已加载 ${historyCommits.length} / ${historyTotal} 个提交`
                    : historyCommits.length > 0
                      ? `${historyCommits.length} 个提交`
                      : '暂无提交记录'}
                </span>
              </div>
              {historyError && <div className="git-log-error">{historyError}</div>}
              <div className="git-log-split">
                <div className="git-log-list" role="list">
                  {historyCommits.length === 0 && !loadingHistory && !historyError && (
                    <div className="files-empty-hint">该仓库尚无提交，或当前范围没有可显示的提交。</div>
                  )}
                  {historyCommits.map((c, idx) => {
                    const row = graphRows[idx];
                    const colX = (col: number) => col * 14 + 7;
                    return (
                      <div
                        key={c.oid}
                        role="listitem"
                        className={`git-log-row ${selectedOid === c.oid ? 'selected' : ''}`}
                        onClick={() => void openCommit(c.oid)}
                      >
                        <svg
                          className="git-log-graph"
                          width={Math.max(1, row?.laneCount ?? maxLane) * 14}
                          height={28}
                          aria-hidden="true"
                        >
                          {(row?.throughCols ?? []).map(thru => (
                            <line
                              key={`thru:${thru}`}
                              x1={colX(thru)}
                              y1={0}
                              x2={colX(thru)}
                              y2={28}
                              stroke={LANE_COLORS[thru % LANE_COLORS.length]}
                              strokeWidth={1.5}
                            />
                          ))}
                          {row?.incoming && (
                            <line
                              x1={colX(row.col)}
                              y1={0}
                              x2={colX(row.col)}
                              y2={14}
                              stroke={LANE_COLORS[row.col % LANE_COLORS.length]}
                              strokeWidth={1.5}
                            />
                          )}
                          {(row?.edges ?? []).map((edge, ei) => (
                            <line
                              key={`edge:${ei}`}
                              x1={colX(edge.fromCol)}
                              y1={14}
                              x2={colX(edge.toCol)}
                              y2={28}
                              stroke={LANE_COLORS[edge.fromCol % LANE_COLORS.length]}
                              strokeWidth={1.5}
                            />
                          ))}
                          <circle
                            cx={colX(row?.col ?? 0)}
                            cy={14}
                            r={4}
                            fill={selectedOid === c.oid ? 'var(--ty-matcha)' : 'var(--ty-surface)'}
                            stroke={LANE_COLORS[(row?.col ?? 0) % LANE_COLORS.length]}
                            strokeWidth={1.5}
                          />
                        </svg>
                        <code
                          className="mini-hash"
                          onClick={e => {
                            e.stopPropagation();
                            copyHash(c.oid);
                          }}
                          title="点击复制 Commit SHA"
                        >
                          {c.shortOid}
                          {copiedHash === c.oid && ' ✓'}
                        </code>
                        <span className="commit-msg git-log-summary">{c.summary}</span>
                        {c.refs.length > 0 && (
                          <span className="git-log-refs">
                            {c.refs.map(r => (
                              <span key={`${r.kind}:${r.name}`} className={`ref-badge ref-badge-${r.kind}`}>
                                {r.name}
                              </span>
                            ))}
                          </span>
                        )}
                        <span className="commit-meta">
                          <span className="commit-author">{c.authorName}</span>
                          <span className="commit-time">
                            <Clock size={11} />
                            {relativeCommitTime(c.timestamp)}
                          </span>
                        </span>
                      </div>
                    );
                  })}
                  {historyHasMore && (
                    <button
                      type="button"
                      className="text-button-sm git-log-more"
                      onClick={() => void loadHistory(true)}
                      disabled={loadingHistory}
                    >
                      {loadingHistory ? '加载中…' : '加载更多'}
                    </button>
                  )}
                </div>
                <div className="git-log-detail">
                  {!selectedOid ? (
                    <div className="files-empty-hint">点击左侧任意提交，查看作者信息、改动文件与 Diff。</div>
                  ) : loadingDetails ? (
                    <div className="diff-viewer-header">
                      <span>读取提交详情…</span>
                      <LoaderCircle size={13} className="spin" />
                    </div>
                  ) : commitDetails ? (
                    <>
                      <div className="git-log-detail-head">
                        <code
                          className="mini-hash"
                          onClick={() => copyHash(commitDetails.oid)}
                          title="点击复制完整 Commit SHA"
                        >
                          {commitDetails.oid}
                          {copiedHash === commitDetails.oid && ' ✓'}
                        </code>
                        <span className="meta">
                          {commitDetails.authorName} &lt;{commitDetails.authorEmail}&gt; ·{' '}
                          {relativeCommitTime(commitDetails.authorTimestamp)}
                        </span>
                        {commitDetails.parents.length > 0 && (
                          <span className="meta">父提交：{commitDetails.parents.map(p => p.slice(0, 7)).join(', ')}</span>
                        )}
                      </div>
                      <pre className="git-log-message">{commitDetails.message}</pre>
                      <div className="git-log-files-list">
                        {commitDetails.files.map(f => (
                          <div
                            key={f.path}
                            className={`changed-file-row ${selectedCommitFile === f.path ? 'selected' : ''}`}
                            onClick={() =>
                              void loadCommitFileDiff(
                                commitDetails.oid,
                                f.path,
                                f.oldPath,
                              )
                            }
                          >
                            <span
                              className={`status-tag ${
                                f.status === 'A'
                                  ? 'status-added'
                                  : f.status === 'D'
                                    ? 'status-deleted'
                                    : 'status-modified'
                              }`}
                            >
                              {f.status}
                            </span>
                            <span className="file-path" title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                              {f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                            </span>
                          </div>
                        ))}
                      </div>
                      <div className="diff-viewer-card git-log-diff-card">
                        <div className="diff-viewer-header">
                          <span>提交内差异：{selectedCommitFile ?? '选择左侧文件'}</span>
                          {loadingCommitDiff && <LoaderCircle size={13} className="spin" />}
                        </div>
                        <div className="diff-code-area">
                          {(commitFileDiff || '(未选择文件)').split('\n').map((line, idx) =>
                            renderDiffLine(line, idx),
                          )}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="files-empty-hint">未能读取该提交的详情。</div>
                  )}
                </div>
              </div>
            </div>
          )}

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

      {pendingConfirm && (
        <Modal
          title={pendingConfirm.title}
          onClose={() => setPendingConfirm(null)}
          busy={confirmBusy}
        >
          <div className="confirm-content">
            <p className="modal-description">{pendingConfirm.description}</p>
            <p className="confirm-tip">{pendingConfirm.tip}</p>
            <code className="confirm-path">{pendingConfirm.detail}</code>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setPendingConfirm(null)}
                disabled={confirmBusy}
              >
                取消
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => void handleConfirmRun()}
                disabled={confirmBusy}
              >
                {confirmBusy ? <LoaderCircle size={13} className="spin" /> : null}
                <span>{pendingConfirm.confirmLabel}</span>
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
