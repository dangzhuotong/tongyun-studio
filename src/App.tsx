import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { ActiveTab, AgentActionStep, AgentSessionState, AiProjectContext, Project, ProjectInspection, ToolId, Workspace } from './contracts';
import {
  addProject,
  chooseProjectDirectory,
  generateAiProjectContext,
  getInitialAgentSession,
  inspectProject,
  isDesktop,
  loadWorkspace,
  openInTerminal,
  openProjectDirectory,
  removeProject,
  selectProject,
} from './bridge';
import {
  ArrowUpRight,
  Bot,
  Box,
  Check,
  ChevronRight,
  Clock,
  Code2,
  Copy,
  Database,
  Folder,
  FolderOpen,
  GitBranch,
  GitCommit,
  LayoutGrid,
  LoaderCircle,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Sun,
  Terminal,
  Trash2,
} from './components/Icons';
import Modal from './components/Modal';
import AiContextModal from './components/AiContextModal';
import AgentCockpit from './components/AgentCockpit';
import { toolDefinitions } from './features/tools';
import './styles/app.css';

const panels: Record<
  'agent' | 'files' | ToolId,
  React.LazyExoticComponent<React.ComponentType<any>>
> = {
  agent: lazy(() => import('./features/AgentPanel')),
  files: lazy(() => import('./features/FilesPanel')),
  dev: lazy(() => import('./features/DevPanel')),
  api: lazy(() => import('./features/ApiPanel')),
  database: lazy(() => import('./features/DatabasePanel')),
  git: lazy(() => import('./features/GitPanel')),
};

const emptyWorkspace: Workspace = { version: 1, projects: [], activeProjectId: null };
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
type InspectionState = { id: string; result?: ProjectInspection; error?: string } | null;

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace);
  const [loading, setLoading] = useState(isDesktop);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [tab, setTab] = useState<ActiveTab>('overview');
  const [inspection, setInspection] = useState<InspectionState>(null);
  const [refresh, setRefresh] = useState(0);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Project | null>(null);
  const [path, setPath] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState(false);
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  });
  const [aiContext, setAiContext] = useState<AiProjectContext | null>(null);
  const [showAiModal, setShowAiModal] = useState(false);
  const [loadingAi, setLoadingAi] = useState(false);

  // Three-column layout & Agent Cockpit states
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showAgentCockpit, setShowAgentCockpit] = useState(false);

  const project = workspace.projects.find(item => item.id === workspace.activeProjectId) ?? null;

  const [agentSession, setAgentSession] = useState<AgentSessionState>(() =>
    getInitialAgentSession(project?.name ?? 'tongyun-studio'),
  );

  const searchInputRef = useRef<HTMLInputElement>(null);
  const toastTimerRef = useRef<number | null>(null);

  const notify = useCallback((text: string) => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast(text);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2400);
  }, []);

  const openAiContext = async () => {
    if (!project || loadingAi) return;
    setLoadingAi(true);
    try {
      const ctx = await generateAiProjectContext(project.id);
      setAiContext(ctx);
      setShowAiModal(true);
    } catch (err) {
      notify(`生成 AI 上下文失败: ${err}`);
    } finally {
      setLoadingAi(false);
    }
  };

  const handleAgentPrompt = (userPrompt: string) => {
    const newAction: AgentActionStep = {
      id: `act-${Date.now()}`,
      kind: 'plan',
      title: '响应人机协同干预',
      detail: userPrompt,
      status: 'running',
      timestamp: new Date().toLocaleTimeString(),
      durationMs: 160,
      target: 'Agent 目标调度队列',
    };
    setAgentSession(prev => ({
      ...prev,
      actions: [...prev.actions, newAction],
      plan: {
        ...prev.plan,
        steps: [
          ...prev.plan.steps,
          { id: `step-${Date.now()}`, text: `人工补充: ${userPrompt}`, status: 'active' },
        ],
      },
    }));
    notify('已向 Agent 投递补充指示');
  };

  const handleToggleAgentPause = () => {
    setAgentSession(prev => {
      const nextStatus = prev.plan.status === 'paused' ? 'executing' : 'paused';
      notify(nextStatus === 'paused' ? '已暂停 Agent 调度' : '已恢复 Agent 调度');
      return {
        ...prev,
        plan: {
          ...prev.plan,
          status: nextStatus,
        },
      };
    });
  };

  const current = inspection?.id === project?.id ? inspection : null;
  const loadRequest = useRef(0);
  const operationLock = useRef(false);

  // Sync theme attribute to root
  useEffect(() => {
    if (darkMode) {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }, [darkMode]);

  const readWorkspace = useCallback(async () => {
    if (!isDesktop) return;
    const request = ++loadRequest.current;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await loadWorkspace();
      if (request === loadRequest.current) setWorkspace(result);
    } catch (cause) {
      if (request === loadRequest.current) setLoadError(message(cause));
    } finally {
      if (request === loadRequest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void readWorkspace();
    return () => {
      loadRequest.current++;
    };
  }, [readWorkspace]);

  useEffect(() => {
    if (!project) return;
    let stale = false;
    setInspection({ id: project.id });
    inspectProject(project.id)
      .then(result => {
        if (!stale) setInspection({ id: project.id, result });
      })
      .catch(cause => {
        if (!stale) setInspection({ id: project.id, error: message(cause) });
      });
    return () => {
      stale = true;
    };
  }, [project?.id, refresh]);

  // Global keyboard shortcuts (Cmd+K: search, Cmd+N: add, Cmd+B: toggle sidebar, Cmd+J: toggle Agent Cockpit)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        if (isDesktop && !loading && !busy) beginAdd();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        setSidebarCollapsed(prev => !prev);
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        e.preventDefault();
        setShowAgentCockpit(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [loading, busy]);

  async function mutate(action: () => Promise<Workspace>, onSuccess?: () => void, isForm = false) {
    if (operationLock.current || !isDesktop) return;
    operationLock.current = true;
    setBusy(true);
    setActionError(null);
    setFormError(null);
    try {
      setWorkspace(await action());
      onSuccess?.();
    } catch (cause) {
      (isForm ? setFormError : setActionError)(message(cause));
    } finally {
      operationLock.current = false;
      setBusy(false);
    }
  }

  function beginAdd() {
    setPath('');
    setFormError(null);
    setAdding(true);
  }

  async function pick() {
    setPicking(true);
    setFormError(null);
    try {
      const directory = await chooseProjectDirectory();
      if (directory) setPath(directory);
    } catch (cause) {
      setFormError(message(cause));
    } finally {
      setPicking(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!path.trim()) {
      setFormError('请输入项目目录的完整路径。');
      return;
    }
    void mutate(
      () => addProject(path.trim()),
      () => {
        setAdding(false);
        setTab('overview');
        setFilter('');
        setRefresh(value => value + 1);
        notify('已成功添加项目');
      },
      true,
    );
  }

  async function openDirectory() {
    if (!project) return;
    setActionError(null);
    try {
      await openProjectDirectory(project.id);
      notify('已在访达中打开项目');
    } catch (cause) {
      setActionError(message(cause));
    }
  }

  async function openTerminal() {
    if (!project) return;
    setActionError(null);
    try {
      await openInTerminal(project.id);
      notify('已在系统终端中打开项目目录');
    } catch (cause) {
      setActionError(message(cause));
    }
  }

  function copyProjectPath() {
    if (!project) return;
    navigator.clipboard.writeText(project.path);
    setCopiedPath(true);
    notify('已复制项目绝对路径');
    setTimeout(() => setCopiedPath(false), 2000);
  }

  const filtered = workspace.projects.filter(item =>
    `${item.name} ${item.path}`.toLowerCase().includes(filter.toLowerCase()),
  );
  const Panel = tab === 'overview' ? null : panels[tab];
  const techStack = current?.result?.techStack ?? [];
  const recentCommits = current?.result?.git?.recentCommits ?? [];

  const getExplorerTitle = (activeTab: ActiveTab) => {
    switch (activeTab) {
      case 'agent':
        return 'Agent 编排与目标';
      case 'dev':
        return '服务进程与端口';
      case 'api':
        return 'API 用例与测试';
      case 'database':
        return '数据库与表结构';
      case 'git':
        return '版本分支与暂存';
      case 'files':
        return '项目源码与资源';
      default:
        return '项目工作区';
    }
  };

  return (
    <div className="app-shell">
      {/* =====================================================================
          Column 1: Narrow Activity Rail (52px Icon Bar)
          ===================================================================== */}
      <aside className="activity-rail" aria-label="全局活动导航">
        <div className="rail-top">
          <button
            className="brand-symbol-btn"
            onClick={() => {
              setTab('overview');
              setSidebarCollapsed(false);
            }}
            title="橦云工作台 · TONGYUN STUDIO"
          >
            <Box size={20} strokeWidth={1.5} />
          </button>
          <div className="rail-divider" />

          {/* Activity Navigation Buttons */}
          <nav className="activity-nav" aria-label="工作区模块">
            <button
              className={`rail-btn ${tab === 'overview' ? 'active' : ''}`}
              onClick={() => {
                if (tab === 'overview') setSidebarCollapsed(prev => !prev);
                else {
                  setTab('overview');
                  setSidebarCollapsed(false);
                }
              }}
              title="概览"
              aria-label="概览"
              aria-current={tab === 'overview' ? 'page' : undefined}
            >
              <LayoutGrid size={18} />
              <span className="rail-btn-text">概览</span>
            </button>

            <button
              className={`rail-btn ${tab === 'agent' ? 'active' : ''}`}
              onClick={() => {
                if (tab === 'agent') setSidebarCollapsed(prev => !prev);
                else {
                  setTab('agent');
                  setSidebarCollapsed(false);
                }
              }}
              title="智能体视界 · Agent 操作监视"
              aria-label="智能体视界"
              aria-current={tab === 'agent' ? 'page' : undefined}
            >
              <Bot size={18} />
              <span className="rail-btn-text">智能体</span>
            </button>

            <button
              className={`rail-btn ${tab === 'dev' ? 'active' : ''}`}
              onClick={() => {
                if (tab === 'dev') setSidebarCollapsed(prev => !prev);
                else {
                  setTab('dev');
                  setSidebarCollapsed(false);
                }
              }}
              title="Tongyun Dev · 运行服务与终端"
              aria-label="运行服务与终端"
              aria-current={tab === 'dev' ? 'page' : undefined}
            >
              <Terminal size={18} />
              <span className="rail-btn-text">运行</span>
            </button>

            <button
              className={`rail-btn ${tab === 'api' ? 'active' : ''}`}
              onClick={() => {
                if (tab === 'api') setSidebarCollapsed(prev => !prev);
                else {
                  setTab('api');
                  setSidebarCollapsed(false);
                }
              }}
              title="Tongyun API · 原生接口工作台"
              aria-label="接口工作台"
              aria-current={tab === 'api' ? 'page' : undefined}
            >
              <Code2 size={18} />
              <span className="rail-btn-text">接口</span>
            </button>

            <button
              className={`rail-btn ${tab === 'database' ? 'active' : ''}`}
              onClick={() => {
                if (tab === 'database') setSidebarCollapsed(prev => !prev);
                else {
                  setTab('database');
                  setSidebarCollapsed(false);
                }
              }}
              title="Tongyun Database · 数据与 SQL"
              aria-label="数据工作台"
              aria-current={tab === 'database' ? 'page' : undefined}
            >
              <Database size={18} />
              <span className="rail-btn-text">数据</span>
            </button>

            <button
              className={`rail-btn ${tab === 'git' ? 'active' : ''}`}
              onClick={() => {
                if (tab === 'git') setSidebarCollapsed(prev => !prev);
                else {
                  setTab('git');
                  setSidebarCollapsed(false);
                }
              }}
              title="Tongyun Git · 版本工作台"
              aria-label="版本工作台"
              aria-current={tab === 'git' ? 'page' : undefined}
            >
              <GitBranch size={18} />
              <span className="rail-btn-text">版本</span>
            </button>

            <button
              className={`rail-btn ${tab === 'files' ? 'active' : ''}`}
              onClick={() => {
                if (tab === 'files') setSidebarCollapsed(prev => !prev);
                else {
                  setTab('files');
                  setSidebarCollapsed(false);
                }
              }}
              title="Tongyun Files · 项目文件与源码"
              aria-label="项目文件与源码"
              aria-current={tab === 'files' ? 'page' : undefined}
            >
              <FolderOpen size={18} />
              <span className="rail-btn-text">文件</span>
            </button>
          </nav>
        </div>

        <div className="rail-bottom">
          <div
            className="agent-rail-indicator"
            onClick={() => setShowAgentCockpit(prev => !prev)}
            title="Agent 实时监视舱 (⌘J)"
          >
            <span className="agent-pulse-dot" />
          </div>

          <button
            className="rail-icon-btn"
            onClick={() => setDarkMode(prev => !prev)}
            title={darkMode ? '切换为浅色主题（暖奶茶）' : '切换为深色模式'}
          >
            {darkMode ? <Sun size={16} /> : <Moon size={16} />}
          </button>

          <button
            className="rail-icon-btn"
            onClick={() => setSidebarCollapsed(prev => !prev)}
            title={sidebarCollapsed ? '展开侧边栏 (⌘B)' : '收起侧边栏 (⌘B)'}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </div>
      </aside>

      {/* =====================================================================
          Column 2: Secondary Contextual Explorer (Collapsible, ~250px)
          ===================================================================== */}
      <aside
        className={`secondary-explorer ${sidebarCollapsed ? 'collapsed' : ''}`}
        aria-label="项目导航"
      >
        <div className="explorer-inner">
          <div className="brand">
            <div className="brand-symbol">
              <Box size={20} strokeWidth={1.5} />
            </div>
            <div>
              <span className="brand-name">橦云工作台</span>
              <span className="brand-subtitle">TONGYUN STUDIO</span>
            </div>
          </div>

          <div className="sidebar-section-title">
            <span>{getExplorerTitle(tab)}</span>
            <span className="project-count">{workspace.projects.length}</span>
            <button
              className="icon-button"
              onClick={beginAdd}
              disabled={!isDesktop || loading || !!loadError || busy}
              aria-label="添加项目"
              title={isDesktop ? '添加项目 (⌘N)' : '请在桌面版添加项目'}
            >
              <Plus size={16} />
            </button>
          </div>

          <label className="search-field">
            <Search size={14} />
            <input
              ref={searchInputRef}
              aria-label="搜索项目"
              placeholder="搜索项目 (⌘K)…"
              value={filter}
              onChange={event => setFilter(event.target.value)}
            />
          </label>

          <div className="project-list">
            {loading ? (
              <p className="sidebar-message">正在读取项目…</p>
            ) : loadError ? (
              <p className="sidebar-message">项目读取失败</p>
            ) : filtered.length ? (
              filtered.map(item => (
                <button
                  key={item.id}
                  className={`project-row ${project?.id === item.id ? 'selected' : ''}`}
                  disabled={busy}
                  onClick={() => {
                    if (project?.id !== item.id) {
                      setActionError(null);
                      void mutate(() => selectProject(item.id));
                    }
                  }}
                  aria-current={project?.id === item.id ? 'true' : undefined}
                  title={item.path}
                >
                  <Folder size={16} />
                  <span>
                    <span className="project-name">{item.name}</span>
                    <span className="project-path">{item.path}</span>
                  </span>
                  {project?.id === item.id && <ChevronRight size={13} />}
                </button>
              ))
            ) : (
              <div className="sidebar-empty">
                <Folder size={22} strokeWidth={1.3} />
                <p>{filter ? '没有匹配的项目' : '你的项目会显示在这里'}</p>
                <span>{filter ? '试试其他名称或路径' : '从一个本地目录开始'}</span>
              </div>
            )}
          </div>

          {/* Contextual quick summary inside Column 2 */}
          {project && tab !== 'overview' && (
            <div className="explorer-context-card">
              <span className="explorer-context-label">当前模块焦点</span>
              <div className="mono-subtle">{tab.toUpperCase()} · {project.name}</div>
              <div className="explorer-quick-list">
                <div className="explorer-quick-item">
                  <span>Agent 状态</span>
                  <span className="accent-color">● 在线就绪</span>
                </div>
                {tab === 'git' && current?.result?.git?.branch && (
                  <div className="explorer-quick-item">
                    <span>当前分支</span>
                    <span className="mono">{current.result.git.branch}</span>
                  </div>
                )}
                {tab === 'dev' && current?.result?.scripts && (
                  <div className="explorer-quick-item">
                    <span>脚本数量</span>
                    <span>{current.result.scripts.length} 个</span>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="sidebar-footer">
            <div className="sidebar-footer-info">
              <span className="status-dot available" />
              <span>本地工作区</span>
            </div>
            <button
              className="theme-toggle-btn"
              onClick={() => setDarkMode(prev => !prev)}
              title={darkMode ? '切换为浅色（暖奶茶）' : '切换为深色模式'}
            >
              {darkMode ? <Sun size={13} /> : <Moon size={13} />}
            </button>
          </div>
        </div>
      </aside>

      {/* =====================================================================
          Column 3: Main Workbench Stage (Flex 1)
          ===================================================================== */}
      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-left">
            {sidebarCollapsed && (
              <button
                className="topbar-expand-btn"
                onClick={() => setSidebarCollapsed(false)}
                title="展开侧栏 (⌘B)"
                aria-label="展开侧栏"
              >
                <PanelLeftOpen size={14} />
              </button>
            )}
            <div className="breadcrumb">
              <span>工作区</span>
              <ChevronRight size={13} />
              <span>{project?.name ?? '开始'}</span>
              {tab !== 'overview' && (
                <>
                  <ChevronRight size={13} />
                  <span className="breadcrumb-tab">{tab.toUpperCase()}</span>
                </>
              )}
            </div>
          </div>

          <div className="topbar-actions">
            {project && (
              <button
                className="ai-topbar-pill"
                onClick={() => void openAiContext()}
                disabled={loadingAi}
                title="生成并复制当前项目的企业级 AI 上下文与 Prompt"
              >
                {loadingAi ? (
                  <LoaderCircle size={13} className="spin" />
                ) : (
                  <Sparkles size={13} className="sparkle-icon" />
                )}
                <span>AI 上下文协同</span>
              </button>
            )}

            <button
              className={`agent-topbar-pill ${showAgentCockpit ? 'active' : ''}`}
              onClick={() => setShowAgentCockpit(prev => !prev)}
              title="切换 Agent 实时操作可视化监视舱 (⌘J)"
            >
              <Bot size={13} />
              <span>Agent 监视舱</span>
              <span className="agent-pill-dot" />
            </button>

            <span className="topbar-label">本地集成开发者工作台</span>
          </div>
        </header>

        {!isDesktop && (
          <div className="preview-banner">
            <span className="status-dot available" />
            <span>浏览器演示模式 · 本机文件与命令执行已启用模拟器预览</span>
          </div>
        )}

        <div className="project-header">
          <div className="project-title-row">
            <div className="project-emblem">
              <FolderOpen size={22} strokeWidth={1.5} />
            </div>
            <div className="project-title">
              <div className="title-with-stack">
                <h1>{project?.name ?? '我的工作区'}</h1>
                {techStack.map(t => (
                  <span key={t} className="mini-badge">
                    {t}
                  </span>
                ))}
              </div>
              <p title={project?.path}>
                {project?.path ?? '集中管理本地项目，运行、接口、数据与版本一站式开发。'}
              </p>
            </div>
          </div>

          {project && (
            <div className="header-actions">
              <button
                className="secondary-button"
                onClick={openDirectory}
                disabled={!isDesktop || current?.result?.exists === false}
                title="在访达中打开项目所在目录"
              >
                <FolderOpen size={14} />
                访达
              </button>
              <button
                className="secondary-button"
                onClick={openTerminal}
                disabled={!isDesktop || current?.result?.exists === false}
                title="在系统终端中打开当前目录"
              >
                <Terminal size={14} />
                终端
              </button>
              <button
                className="secondary-button"
                onClick={copyProjectPath}
                title="复制项目完整物理路径"
              >
                {copiedPath ? <Check size={14} className="accent-color" /> : <Copy size={14} />}
                复制路径
              </button>
              <button
                className="icon-button"
                aria-label="移除项目登记"
                disabled={busy}
                onClick={() => {
                  setFormError(null);
                  setRemoving(project);
                }}
                title="仅从工作台移除登记"
              >
                <Trash2 size={15} />
              </button>
            </div>
          )}
        </div>

        {/* Secondary Horizontal Quick Navigation Tabs */}
        <nav className="tabs" aria-label="工作区快速导航">
          <button
            aria-current={tab === 'overview' ? 'page' : undefined}
            className={tab === 'overview' ? 'active' : ''}
            onClick={() => setTab('overview')}
          >
            <LayoutGrid size={15} />
            概览
          </button>
          <button
            aria-current={tab === 'agent' ? 'page' : undefined}
            className={tab === 'agent' ? 'active' : ''}
            onClick={() => setTab('agent')}
          >
            <Bot size={15} />
            智能体视界
          </button>
          <button
            aria-current={tab === 'files' ? 'page' : undefined}
            className={tab === 'files' ? 'active' : ''}
            onClick={() => setTab('files')}
          >
            <FolderOpen size={15} />
            文件
          </button>
          {toolDefinitions.map(tool => (
            <button
              key={tool.id}
              aria-current={tab === tool.id ? 'page' : undefined}
              className={tab === tool.id ? 'active' : ''}
              onClick={() => setTab(tool.id)}
            >
              <tool.Icon size={15} />
              {tool.label}
            </button>
          ))}
        </nav>

        <main className="main-content">
          {actionError && (
            <div className="error-banner" role="alert">
              <span>{actionError}</span>
              <button className="text-button" onClick={() => setActionError(null)}>
                关闭
              </button>
            </div>
          )}

          {loading ? (
            <div className="loading-state" role="status">
              <LoaderCircle className="spin" size={20} />
              <p>正在读取本地工作区…</p>
            </div>
          ) : loadError ? (
            <div className="error-state" role="alert">
              <h2>暂时无法读取项目</h2>
              <p>{loadError}</p>
              <button className="secondary-button" onClick={() => void readWorkspace()}>
                <RefreshCw size={14} />
                重新读取
              </button>
            </div>
          ) : Panel ? (
            <Suspense fallback={<div className="loading-state" role="status">正在打开工作台…</div>}>
              <Panel
                key={`${tab}:${project?.id ?? 'empty'}`}
                project={project}
                inspection={current?.result}
                session={agentSession}
                onNavigate={(t: ActiveTab) => setTab(t)}
                onDispatchPrompt={handleAgentPrompt}
                onTogglePause={handleToggleAgentPause}
                onRefresh={() => setRefresh(v => v + 1)}
                onNotify={notify}
              />
            </Suspense>
          ) : (
            <>
              {!project ? (
                <section className="welcome-card">
                  <div className="welcome-icon">
                    <FolderOpen size={28} strokeWidth={1.3} />
                  </div>
                  <div className="section-eyebrow">从项目开始</div>
                  <h2>把开发现场，放在一起。</h2>
                  <p>添加本地项目，在同一个工作区找到运行、接口、数据与版本工具。</p>
                  <button className="primary-button" disabled={!isDesktop} onClick={beginAdd}>
                    <Plus size={16} />
                    添加本地项目
                  </button>
                  <span className="welcome-footnote">
                    只登记目录位置，保留你原有的文件与工作方式。
                  </span>
                </section>
              ) : (
                <section className="overview-section">
                  <div className="section-heading">
                    <h2>项目概况</h2>
                    <button
                      className="text-button"
                      disabled={!!current && !current.result && !current.error}
                      onClick={() => setRefresh(value => value + 1)}
                    >
                      <RefreshCw size={13} />
                      刷新
                    </button>
                  </div>

                  {current?.error ? (
                    <div className="error-banner" role="alert">
                      <span>读取项目状态失败：{current.error}</span>
                      <button className="text-button" onClick={() => setRefresh(value => value + 1)}>
                        重试
                      </button>
                    </div>
                  ) : !current?.result ? (
                    <div className="inspection-loading" role="status">
                      <LoaderCircle size={15} className="spin" />
                      正在检查目录与版本状态…
                    </div>
                  ) : (
                    <>
                      <div className="stat-grid">
                        <div className="stat-card">
                          <span className="stat-label">项目目录</span>
                          <span className="stat-value directory-status">
                            <span
                              className={`status-dot ${current.result.exists ? 'available' : ''}`}
                            />
                            {current.result.exists ? '可访问' : '目录不存在'}
                          </span>
                          <span className="meta">本机文件系统状态</span>
                        </div>
                        <div className="stat-card">
                          <span className="stat-label">当前分支</span>
                          <span className="stat-value mono" title={current.result.git.branch ?? ''}>
                            {current.result.git.error
                              ? '读取失败'
                              : current.result.git.isRepository
                              ? current.result.git.branch ?? '分离 HEAD'
                              : '非 Git 仓库'}
                          </span>
                          <span className="meta">
                            {current.result.git.head
                              ? current.result.git.head.slice(0, 8)
                              : '本地版本信息'}
                          </span>
                        </div>
                        <div className="stat-card">
                          <span className="stat-label">工作区改动</span>
                          <span className="stat-value">
                            {current.result.git.isRepository && !current.result.git.error ? (
                              <>
                                {current.result.git.changedFiles}
                                <span className="stat-unit">项</span>
                              </>
                            ) : (
                              '—'
                            )}
                          </span>
                          <span className="meta">未提交的文件变更</span>
                        </div>
                        <div className="stat-card">
                          <span className="stat-label">接口测试用例</span>
                          <span className="stat-value">
                            {current.result.exists ? (
                              <>
                                {current.result.httpFiles}
                                <span className="stat-unit">个</span>
                              </>
                            ) : (
                              '—'
                            )}
                          </span>
                          <span className="meta">.http / .rest 请求文件</span>
                        </div>
                      </div>

                      {!current.result.exists && (
                        <p className="inline-error" role="alert">
                          目录可能已移动或删除。可移除这条登记，再添加新的目录。
                        </p>
                      )}
                      {current.result.git.error && (
                        <p className="inline-error" role="alert">
                          Git 状态读取失败：{current.result.git.error}
                        </p>
                      )}

                      {/* Recent commits activity mini-card */}
                      {current.result.git.isRepository && recentCommits.length > 0 && (
                        <div className="recent-activity-card">
                          <div className="section-heading">
                            <div className="subcard-title">
                              <GitCommit size={15} className="title-icon" />
                              <h3>近期提交活动</h3>
                            </div>
                            <button className="text-button" onClick={() => setTab('git')}>
                              查看完整版本 <ChevronRight size={12} />
                            </button>
                          </div>
                          <div className="commit-list">
                            {recentCommits.slice(0, 3).map(c => (
                              <div key={c.hash} className="commit-item">
                                <div className="commit-main">
                                  <code className="mini-hash">{c.hash}</code>
                                  <span className="commit-msg">{c.message}</span>
                                </div>
                                <div className="commit-meta">
                                  <span className="commit-time">
                                    <Clock size={11} />
                                    {c.relativeTime}
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </section>
              )}

              <section className="tools-section">
                <div className="section-heading">
                  <h2>工作台模块</h2>
                  <span className="meta">原生内嵌 · 实时工作</span>
                </div>
                <div className="tools-grid">
                  {toolDefinitions.map(tool => (
                    <button
                      className="tool-card"
                      key={tool.id}
                      onClick={() => setTab(tool.id)}
                    >
                      <div className="tool-card-top">
                        <div className="tool-icon">
                          <tool.Icon size={20} strokeWidth={1.5} />
                        </div>
                        <ArrowUpRight size={15} />
                      </div>
                      <h3>
                        {tool.label}
                        <span>{tool.name.replace('Tongyun ', '')}</span>
                      </h3>
                      <p>{tool.description}</p>
                      <div className="tool-card-bottom">
                        <span className="badge-matcha-soft">原生内嵌</span>
                        <span>
                          进入工作台 <ChevronRight size={12} />
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              </section>

              <div className="workspace-note">
                <GitBranch size={15} />
                <p>
                  所有操作直接在项目工作区执行，数据留在本机，随时切换。
                </p>
              </div>
            </>
          )}
        </main>

        <footer className="statusbar">
          <span className="inline">
            <span className={`status-dot ${isDesktop ? 'available' : ''}`} />
            {isDesktop ? '本机桌面宿主' : '浏览器演示环境'}
          </span>
          <span>{busy ? '正在保存…' : project ? `已激活：${project.name}` : '等待添加项目'}</span>
          <span className="statusbar-end">TONGYUN STUDIO</span>
        </footer>
      </div>

      {/* =====================================================================
          Column 4: Right-Side Collapsible Agent Cockpit
          ===================================================================== */}
      {showAgentCockpit && (
        <AgentCockpit
          session={agentSession}
          onClose={() => setShowAgentCockpit(false)}
          onNavigate={(targetTab: ActiveTab) => setTab(targetTab)}
          onDispatchPrompt={handleAgentPrompt}
          onTogglePause={handleToggleAgentPause}
          onNotify={notify}
        />
      )}

      {/* =====================================================================
          Modals & Notifications
          ===================================================================== */}
      {adding && (
        <Modal title="添加本地项目" onClose={() => setAdding(false)} busy={busy || picking}>
          <form onSubmit={submit}>
            <p className="modal-description">
              选择项目所在目录。工作台只保存目录位置，不移动或修改项目文件。
            </p>
            <label className="form-label" htmlFor="project-path">
              项目目录
            </label>
            <div className="path-input-row">
              <input
                id="project-path"
                value={path}
                onChange={event => setPath(event.target.value)}
                placeholder="/完整路径/项目目录"
                disabled={busy || picking}
                autoFocus
              />
              <button
                type="button"
                className="secondary-button"
                onClick={() => void pick()}
                disabled={busy || picking}
              >
                {picking ? <LoaderCircle size={14} className="spin" /> : <FolderOpen size={14} />}
                浏览…
              </button>
            </div>
            {formError && <p className="form-error" role="alert">{formError}</p>}
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setAdding(false)}
                disabled={busy || picking}
              >
                取消
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={busy || picking || !path.trim()}
              >
                {busy && <LoaderCircle size={14} className="spin" />}
                添加
              </button>
            </div>
          </form>
        </Modal>
      )}

      {removing && (
        <Modal
          title={`移除项目登记：${removing.name}`}
          onClose={() => setRemoving(null)}
          busy={busy}
        >
          <div className="confirm-content">
            <p className="modal-description">
              确定要将 <strong>{removing.name}</strong> 从橦云工作台中移除吗？
            </p>
            <p className="confirm-tip">
              这只会从工作台项目列表中移除登记，<strong>绝不会</strong>删除或修改磁盘上的任何物理文件。
            </p>
            <code className="confirm-path">{removing.path}</code>
            {formError && <p className="form-error" role="alert">{formError}</p>}
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setRemoving(null)}
                disabled={busy}
              >
                保留
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => {
                  void mutate(
                    () => removeProject(removing.id),
                    () => {
                      setRemoving(null);
                      notify('已移除项目登记');
                    },
                    true,
                  );
                }}
                disabled={busy}
              >
                {busy && <LoaderCircle size={14} className="spin" />}
                确认移除
              </button>
            </div>
          </div>
        </Modal>
      )}

      {showAiModal && aiContext && (
        <AiContextModal
          context={aiContext}
          onClose={() => setShowAiModal(false)}
          onNotify={notify}
        />
      )}

      {toast && (
        <div className="toast-notification" role="status">
          <Check size={14} className="accent-color" />
          <span>{toast}</span>
        </div>
      )}
    </div>
  );
}
