import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { Project, ProjectInspection, ToolId, ToolStatus, Workspace } from './contracts';
import { addProject, chooseProjectDirectory, inspectProject, isDesktop, listTools, loadWorkspace, openProjectDirectory, removeProject, selectProject } from './bridge';
import { ArrowUpRight, Box, ChevronRight, Folder, FolderOpen, GitBranch, LayoutGrid, LoaderCircle, Plus, RefreshCw, Search, Trash2 } from './components/Icons';
import Modal from './components/Modal';
import { toolDefinitions } from './features/tools';
import './styles/app.css';

const panels = { dev: lazy(() => import('./features/DevPanel')), api: lazy(() => import('./features/ApiPanel')), database: lazy(() => import('./features/DatabasePanel')), git: lazy(() => import('./features/GitPanel')) };
const emptyWorkspace: Workspace = { version: 1, projects: [], activeProjectId: null };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
type InspectionState = { id: string; result?: ProjectInspection; error?: string } | null;

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace);
  const [loading, setLoading] = useState(isDesktop);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [tab, setTab] = useState<'overview' | ToolId>('overview');
  const [inspection, setInspection] = useState<InspectionState>(null);
  const [refresh, setRefresh] = useState(0);
  const [tools, setTools] = useState<ToolStatus[]>([]);
  const [toolsLoading, setToolsLoading] = useState(isDesktop);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Project | null>(null);
  const [path, setPath] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const project = workspace.projects.find(item => item.id === workspace.activeProjectId) ?? null;
  const current = inspection?.id === project?.id ? inspection : null;
  const toolsRequest = useRef(0);
  const loadRequest = useRef(0);
  const operationLock = useRef(false);

  const readWorkspace = useCallback(async () => {
    if (!isDesktop) return;
    const request = ++loadRequest.current;
    setLoading(true); setLoadError(null);
    try { const result = await loadWorkspace(); if (request === loadRequest.current) setWorkspace(result); }
    catch (cause) { if (request === loadRequest.current) setLoadError(message(cause)); }
    finally { if (request === loadRequest.current) setLoading(false); }
  }, []);
  const readTools = useCallback(async () => {
    if (!isDesktop) return;
    const request = ++toolsRequest.current;
    setToolsLoading(true); setToolsError(null);
    try { const result = await listTools(); if (request === toolsRequest.current) setTools(result); }
    catch (cause) { if (request === toolsRequest.current) setToolsError(message(cause)); }
    finally { if (request === toolsRequest.current) setToolsLoading(false); }
  }, []);
  useEffect(() => { void readWorkspace(); void readTools(); return () => { loadRequest.current++; toolsRequest.current++; }; }, [readWorkspace, readTools]);
  useEffect(() => {
    if (!project || !isDesktop) return;
    let stale = false;
    setInspection({ id: project.id });
    inspectProject(project.id).then(result => { if (!stale) setInspection({ id: project.id, result }); }).catch(cause => { if (!stale) setInspection({ id: project.id, error: message(cause) }); });
    return () => { stale = true; };
  }, [project?.id, refresh]);

  async function mutate(action: () => Promise<Workspace>, onSuccess?: () => void, isForm = false) {
    if (operationLock.current || !isDesktop) return;
    operationLock.current = true; setBusy(true); setActionError(null); setFormError(null);
    try { setWorkspace(await action()); onSuccess?.(); }
    catch (cause) { (isForm ? setFormError : setActionError)(message(cause)); }
    finally { operationLock.current = false; setBusy(false); }
  }
  function beginAdd() { setPath(''); setFormError(null); setAdding(true); }
  async function pick() {
    setPicking(true); setFormError(null);
    try { const directory = await chooseProjectDirectory(); if (directory) setPath(directory); }
    catch (cause) { setFormError(message(cause)); }
    finally { setPicking(false); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!path.trim()) { setFormError('请输入项目目录的完整路径。'); return; }
    void mutate(() => addProject(path.trim()), () => { setAdding(false); setTab('overview'); setFilter(''); setRefresh(value => value + 1); }, true);
  }
  async function openDirectory() {
    if (!project) return;
    setActionError(null);
    try { await openProjectDirectory(project.id); } catch (cause) { setActionError(message(cause)); }
  }
  const filtered = workspace.projects.filter(item => `${item.name} ${item.path}`.toLowerCase().includes(filter.toLowerCase()));
  const Panel = tab === 'overview' ? null : panels[tab];

  return <div className="app-shell">
    <aside className="sidebar" aria-label="项目导航">
      <div className="brand"><div className="brand-symbol"><Box size={21} strokeWidth={1.5}/></div><div><span className="brand-name">橦云工作台</span><span className="brand-subtitle">TONGYUN STUDIO</span></div></div>
      <div className="sidebar-section-title"><span>项目</span><span className="project-count">{workspace.projects.length}</span><button className="icon-button" onClick={beginAdd} disabled={!isDesktop || loading || !!loadError || busy} aria-label="添加项目" title={isDesktop ? '添加项目' : '请在桌面版添加项目'}><Plus size={16}/></button></div>
      <label className="search-field"><Search size={14}/><input aria-label="搜索项目" placeholder="搜索项目…" value={filter} onChange={event => setFilter(event.target.value)}/></label>
      <div className="project-list">
        {loading ? <p className="sidebar-message">正在读取项目…</p> : loadError ? <p className="sidebar-message">项目读取失败</p> : filtered.length ? filtered.map(item => <button key={item.id} className={`project-row ${project?.id === item.id ? 'selected' : ''}`} disabled={busy} onClick={() => { if (project?.id !== item.id) { setActionError(null); void mutate(() => selectProject(item.id)); } }} aria-current={project?.id === item.id ? 'true' : undefined} title={item.path}><Folder size={16}/><span><span className="project-name">{item.name}</span><span className="project-path">{item.path}</span></span>{project?.id === item.id && <ChevronRight size={13}/>}</button>) : <div className="sidebar-empty"><Folder size={22} strokeWidth={1.3}/><p>{filter ? '没有匹配的项目' : '你的项目会显示在这里'}</p><span>{filter ? '试试其他名称或路径' : '从一个本地目录开始'}</span></div>}
      </div>
      <div className="sidebar-footer"><span className="status-dot"/><span>本地工作区</span><span className="meta">v0.1</span></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><span>工作区</span><ChevronRight size={13}/><span>{project?.name ?? '开始'}</span></div><span className="topbar-label">一个项目，一处工作空间</span></header>
      {!isDesktop && <div className="preview-banner"><span className="status-dot"/><span>浏览器预览 · 本机功能请在桌面版使用</span></div>}
      <div className="project-header"><div className="project-title-row"><div className="project-emblem"><FolderOpen size={22} strokeWidth={1.5}/></div><div className="project-title"><h1>{project?.name ?? '我的工作区'}</h1><p title={project?.path}>{project?.path ?? '集中管理项目，按需打开开发工具。'}</p></div></div>{project && <div className="header-actions"><button className="secondary-button" onClick={openDirectory} disabled={!isDesktop || current?.result?.exists === false}><FolderOpen size={14}/>打开目录</button><button className="icon-button" aria-label="移除项目登记" disabled={busy} onClick={() => { setFormError(null); setRemoving(project); }} title="移除项目登记"><Trash2 size={15}/></button></div>}</div>
      <nav className="tabs" aria-label="工作区模块"><button aria-current={tab === 'overview' ? 'page' : undefined} className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}><LayoutGrid size={15}/>概览</button>{toolDefinitions.map(tool => <button key={tool.id} aria-current={tab === tool.id ? 'page' : undefined} className={tab === tool.id ? 'active' : ''} onClick={() => setTab(tool.id)}><tool.Icon size={15}/>{tool.label}</button>)}</nav>
      <main className="main-content">
        {actionError && <div className="error-banner" role="alert"><span>{actionError}</span><button className="text-button" onClick={() => setActionError(null)}>关闭</button></div>}
        {loading ? <div className="loading-state" role="status"><LoaderCircle className="spin" size={20}/><p>正在读取本地工作区…</p></div> : loadError ? <div className="error-state" role="alert"><h2>暂时无法读取项目</h2><p>{loadError}</p><button className="secondary-button" onClick={() => void readWorkspace()}><RefreshCw size={14}/>重新读取</button></div> : Panel ? <Suspense fallback={<div className="loading-state" role="status">正在打开面板…</div>}><Panel key={`${tab}:${project?.id ?? 'empty'}`} project={project} status={tools.find(tool => tool.id === tab)} loading={toolsLoading} error={toolsError} onRefresh={() => void readTools()}/></Suspense> : <>
          {!project ? <section className="welcome-card"><div className="welcome-icon"><FolderOpen size={28} strokeWidth={1.3}/></div><div className="section-eyebrow">从项目开始</div><h2>把开发现场，放在一起。</h2><p>添加本地项目，在同一个工作区找到运行、接口、数据与版本工具。</p><button className="primary-button" disabled={!isDesktop} onClick={beginAdd}><Plus size={16}/>添加本地项目</button><span className="welcome-footnote">只登记目录位置，保留你原有的文件与工作方式。</span></section> : <section className="overview-section"><div className="section-heading"><h2>项目概况</h2><button className="text-button" disabled={!!current && !current.result && !current.error} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={13}/>刷新</button></div>
            {current?.error ? <div className="error-banner" role="alert"><span>读取项目状态失败：{current.error}</span><button className="text-button" onClick={() => setRefresh(value => value + 1)}>重试</button></div> : !current?.result ? <div className="inspection-loading" role="status"><LoaderCircle size={15} className="spin"/>正在检查目录与版本状态…</div> : <><div className="stat-grid"><div className="stat-card"><span className="stat-label">项目目录</span><span className="stat-value directory-status"><span className={`status-dot ${current.result.exists ? 'available' : ''}`}/>{current.result.exists ? '可访问' : '目录不存在'}</span><span className="meta">本机文件状态</span></div><div className="stat-card"><span className="stat-label">当前分支</span><span className="stat-value mono" title={current.result.git.branch ?? ''}>{current.result.git.error ? '读取失败' : current.result.git.isRepository ? current.result.git.branch ?? '分离 HEAD' : '非 Git 仓库'}</span><span className="meta">{current.result.git.head ? current.result.git.head.slice(0, 8) : '本地版本信息'}</span></div><div className="stat-card"><span className="stat-label">工作区改动</span><span className="stat-value">{current.result.git.isRepository && !current.result.git.error ? <>{current.result.git.changedFiles}<span className="stat-unit">项</span></> : '—'}</span><span className="meta">未提交的文件变更</span></div><div className="stat-card"><span className="stat-label">接口请求文件</span><span className="stat-value">{current.result.exists ? <>{current.result.httpFiles}<span className="stat-unit">个</span></> : '—'}</span><span className="meta">.http / .rest</span></div></div>{!current.result.exists && <p className="inline-error" role="alert">目录可能已移动或删除。可移除这条登记，再添加新的目录。</p>}{current.result.git.error && <p className="inline-error" role="alert">Git 状态读取失败：{current.result.git.error}</p>}</>}
          </section>}
          <section className="tools-section"><div className="section-heading"><h2>开发工具</h2><span className="meta">按需打开 · 独立运行</span></div><div className="tools-grid">{toolDefinitions.map(tool => { const installed = tools.find(item => item.id === tool.id); return <button className="tool-card" key={tool.id} onClick={() => setTab(tool.id)}><div className="tool-card-top"><div className="tool-icon"><tool.Icon size={20} strokeWidth={1.5}/></div><ArrowUpRight size={15}/></div><h3>{tool.label}<span>{tool.name.replace('Tongyun ', '')}</span></h3><p>{tool.description}</p><div className="tool-card-bottom"><span>{!isDesktop ? '桌面版可用' : toolsLoading ? '检测中…' : toolsError ? '检测失败' : installed?.available ? '已安装' : '未检测到安装'}</span><span>查看入口 <ChevronRight size={12}/></span></div></button>; })}</div></section>
          <div className="workspace-note"><GitBranch size={15}/><p>项目保留在原目录，工具保留各自的工作方式。<span>选择模块不会自动启动服务或连接数据库。</span></p></div>
        </>}
      </main>
      <footer className="statusbar"><span className="inline"><span className={`status-dot ${isDesktop ? 'available' : ''}`}/>{isDesktop ? '本机桌面' : '浏览器预览'}</span><span>{busy ? '正在保存…' : project ? '本地项目已登记' : '等待添加项目'}</span><span className="statusbar-end">TONGYUN STUDIO</span></footer>
    </div>
    {adding && <Modal title="添加本地项目" onClose={() => setAdding(false)} busy={busy || picking}><form onSubmit={submit}><p className="modal-description">选择项目所在目录。工作台只保存目录位置，不移动或修改项目文件。</p><label className="form-label" htmlFor="project-path">项目目录</label><div className="path-input-row"><input id="project-path" value={path} onChange={event => setPath(event.target.value)} placeholder="/完整路径/项目目录" disabled={busy || picking} autoComplete="off"/><button type="button" className="secondary-button" disabled={busy || picking} onClick={pick}><FolderOpen size={15}/>{picking ? '选择中…' : '选择目录'}</button></div>{formError && <p role="alert" className="inline-error">{formError}</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setAdding(false)} disabled={busy || picking}>取消</button><button className="primary-button" type="submit" disabled={busy || picking || !path.trim()}>{busy && <LoaderCircle size={14} className="spin"/>}{busy ? '正在添加…' : '添加项目'}</button></div></form></Modal>}
    {removing && <Modal title="移除项目登记？" onClose={() => setRemoving(null)} busy={busy}><p className="modal-description">从工作台移除「{removing.name}」的登记。<br/>磁盘中的项目文件和 Git 历史都会保留。</p><code className="remove-path">{removing.path}</code>{formError && <p className="inline-error" role="alert">{formError}</p>}<div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={() => setRemoving(null)}>取消</button><button className="primary-button" disabled={busy} onClick={() => void mutate(() => removeProject(removing.id), () => { setRemoving(null); setTab('overview'); }, true)}>{busy ? '正在移除…' : '仅移除登记'}</button></div></Modal>}
  </div>;
}
