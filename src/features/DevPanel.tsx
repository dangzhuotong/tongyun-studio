import { useState, useRef, useEffect, useCallback, type FormEvent } from 'react';
import type { Project, ProjectInspection, ManagedService, ListeningPort, AgentSessionState, DevCandidate, DevScanReport, Workspace } from '../contracts';
import {
  isDesktop,
  startProjectService,
  listProjectServices,
  stopProjectService,
  restartProjectService,
  detectListeningPorts,
  openUrl,
  chooseProjectDirectory,
  scanDevDirectory,
  importDevCandidates,
  startDevGroup,
  stopDevGroup,
} from '../bridge';
import { Activity, Bot, Check, Copy, Cpu, FolderOpen, LoaderCircle, Play, RotateCw, Search, Square, Terminal } from '../components/Icons';

const statusLabel: Record<ManagedService['status'], string> = { running: '进程运行中', stopped: '已停止', exited: '已完成', failed: '执行失败' };
const lifecycleLabel: Record<string, string> = {
  stopped: '已停止',
  starting: '启动中',
  port_open: '端口已通',
  ready: '就绪',
  failed: '失败',
  exited: '已完成',
};
const confidenceLabel: Record<string, string> = { high: '把握高', medium: '把握中', low: '把握低' };

function lifecycleText(value: string | undefined): string {
  if (!value) return '';
  return lifecycleLabel[value] ?? value;
}

/** One label for the card and the log badge. A failed process is never also "starting". */
function primaryStatus(service: Pick<ManagedService, 'status' | 'lifecycle'>): string {
  if (service.lifecycle === 'failed' || service.status === 'failed') return statusLabel.failed;
  if (service.lifecycle === 'ready') return lifecycleLabel.ready;
  if (service.lifecycle === 'port_open') return lifecycleLabel.port_open;
  if (service.lifecycle === 'exited' || service.status === 'exited') return statusLabel.exited;
  if (service.lifecycle === 'stopped' || service.status === 'stopped') return statusLabel.stopped;
  if (service.status === 'running') return statusLabel.running;
  return lifecycleText(service.lifecycle) || statusLabel[service.status];
}

/** Readiness detail that does not contradict the primary label. */
function secondaryStatus(service: Pick<ManagedService, 'status' | 'lifecycle'>): string {
  if (service.status !== 'running' || service.lifecycle === 'failed') return '';
  if (service.lifecycle === 'starting') return lifecycleLabel.starting;
  return '';
}

export default function DevPanel({
  project,
  projects = [],
  inspection,
  session,
  onNotify,
  onWorkspace,
}: {
  project: Project | null;
  projects?: Project[];
  inspection?: ProjectInspection | null;
  session?: AgentSessionState | null;
  onRefresh?: () => void;
  onNotify?: (msg: string) => void;
  onWorkspace?: (workspace: Workspace) => void;
}) {
  const [services, setServices] = useState<ManagedService[]>([]);
  const [listeningPorts, setListeningPorts] = useState<ListeningPort[]>([]);
  const [customCommand, setCustomCommand] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [hints, setHints] = useState(false);
  const [scanPath, setScanPath] = useState('');
  const [selectedProfile, setSelectedProfile] = useState<string | null>(null);
  const [scanDepth, setScanDepth] = useState('3');
  const [scanBusy, setScanBusy] = useState(false);
  const [report, setReport] = useState<DevScanReport | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, { command: string; port: string }>>({});
  const projectId = project?.id;
  const currentProject = useRef(projectId);
  currentProject.current = projectId;
  const requestSequence = useRef(0);
  const mutations = useRef(new Set<string>());
  const mounted = useRef(true);
  const errorSource = useRef<'read' | 'action' | null>(null);
  const stack = inspection?.techStack ?? [];
  const scripts = inspection?.scripts ?? [];
  const profile = project?.dev ?? null;
  const group = profile?.group ?? null;
  const members = projects.filter(item => group && item.dev?.group === group && item.dev.command.trim());

  const readServices = useCallback(async (id: string) => {
    if (!isDesktop || mutations.current.has(id)) return;
    const request = ++requestSequence.current;
    try {
      const [result, ports] = await Promise.all([
        listProjectServices(id),
        detectListeningPorts(),
      ]);
      if (mounted.current && currentProject.current === id && request === requestSequence.current) {
        setServices(result);
        setListeningPorts(ports);
        if (errorSource.current !== 'action') {
          errorSource.current = null;
          setError(null);
        }
      }
    } catch (cause) {
      if (mounted.current && currentProject.current === id && request === requestSequence.current) {
        errorSource.current = 'read';
        setError(String(cause));
      }
    } finally {
      if (mounted.current && currentProject.current === id && request === requestSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    requestSequence.current++;
    setServices([]); setListeningPorts([]); setSelectedProfile(null); errorSource.current = null; setError(null); setBusy(null); setCustomCommand(''); setCopied(null); setHints(false);
    if (!projectId || !isDesktop) { setLoading(false); return; }
    setLoading(true);
    void readServices(projectId);
    const timer = setInterval(() => void readServices(projectId), 1500);
    return () => { clearInterval(timer); requestSequence.current++; };
  }, [projectId, readServices]);
  useEffect(() => () => { mounted.current = false; requestSequence.current++; }, []);

  async function mutate(label: string, action: (id: string) => Promise<ManagedService>) {
    if (!projectId || !isDesktop || mutations.current.has(projectId)) return;
    const id = projectId;
    mutations.current.add(id); requestSequence.current++;
    setBusy(label); errorSource.current = null; setError(null);
    try {
      const result = await action(id);
      if (mounted.current && currentProject.current === id) {
        setServices(previous => [result, ...previous.filter(item => item.id !== result.id)]);
        onNotify?.(`${result.command}：${primaryStatus(result)}`);
      }
    } catch (cause) {
      if (mounted.current && currentProject.current === id) { errorSource.current = 'action'; setError(String(cause)); }
    } finally {
      mutations.current.delete(id);
      if (mounted.current && currentProject.current === id) { setBusy(null); setLoading(false); }
    }
  }
  function run(command: string, profileKey?: string | null) { if (command.trim()) void mutate(`start:${command}`, id => profileKey ? startProjectService(id, command.trim(), profileKey) : startProjectService(id, command.trim())); }
  function submit(event: FormEvent) { event.preventDefault(); run(customCommand); }

  async function scanDirectory() {
    if (!isDesktop || scanBusy || !scanPath.trim()) return;
    setScanBusy(true);
    errorSource.current = null;
    setError(null);
    try {
      const depth = Number(scanDepth);
      const next = await scanDevDirectory(scanPath.trim(), Number.isInteger(depth) ? depth : 3);
      if (!mounted.current) return;
      setReport(next);
      const draftsNext: Record<string, { command: string; port: string }> = {};
      for (const item of next.candidates) draftsNext[item.path] = { command: item.command, port: item.port ? String(item.port) : '' };
      setDrafts(draftsNext);
      setSelected(new Set(next.candidates.filter(item => item.command.trim() && !item.existingHasDev && item.confidence !== 'low').map(item => item.path)));
    } catch (cause) {
      if (mounted.current) { errorSource.current = 'action'; setError(String(cause)); }
    } finally {
      if (mounted.current) setScanBusy(false);
    }
  }

  async function pickScanDirectory() {
    if (!isDesktop || scanBusy) return;
    errorSource.current = null;
    setError(null);
    try {
      const picked = await chooseProjectDirectory();
      if (mounted.current && picked) setScanPath(picked);
    } catch (cause) {
      if (mounted.current) { errorSource.current = 'action'; setError(String(cause)); }
    }
  }

  async function registerSelected() {
    if (!isDesktop || !report || busy || scanBusy) return;
    const chosen = report.candidates.filter(item => selected.has(item.path) && !item.existingHasDev);
    if (!chosen.length) return;
    setBusy('import');
    errorSource.current = null;
    setError(null);
    try {
      const items = chosen.map(item => withDraft(item, drafts[item.path]));
      const result = await importDevCandidates(items);
      if (!mounted.current) return;
      onWorkspace?.(result.workspace);
      onNotify?.(`已登记 ${result.added} 个项目，补上运行配置 ${result.attached} 个，未改动 ${result.unchanged} 个。`);
      setReport(null);
      setSelected(new Set());
    } catch (cause) {
      if (mounted.current) { errorSource.current = 'action'; setError(String(cause)); }
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function runGroup(action: 'start' | 'stop') {
    if (!projectId || !group || !isDesktop || mutations.current.has(projectId)) return;
    const id = projectId;
    mutations.current.add(id);
    requestSequence.current++;
    setBusy(action === 'start' ? 'group-start' : 'group-stop');
    errorSource.current = null;
    setError(null);
    try {
      const result = action === 'start' ? await startDevGroup(group) : await stopDevGroup(group);
      if (mounted.current && currentProject.current === id) {
        onNotify?.(action === 'start'
          ? `已按依赖顺序批量启动同组 ${result.length} 个登记项目。`
          : result.length ? `已按依赖逆序停止同组 ${result.length} 个登记项目。` : '同组没有正在运行的登记命令。');
      }
    } catch (cause) {
      if (mounted.current && currentProject.current === id) { errorSource.current = 'action'; setError(String(cause)); }
    } finally {
      mutations.current.delete(id);
      if (mounted.current && currentProject.current === id) {
        setBusy(null);
        setLoading(false);
        void readServices(id);
      }
    }
  }

  async function copy(service: ManagedService) {
    const id = projectId;
    const body = service.logTail || `${service.stdout}\n${service.stderr}`;
    try {
      await navigator.clipboard.writeText(`$ ${service.command}\n${body}`);
      if (mounted.current && currentProject.current === id) { setCopied(service.id); onNotify?.('已复制日志尾部'); }
    } catch (cause) { if (mounted.current && currentProject.current === id) { errorSource.current = 'action'; setError(`复制失败：${String(cause)}`); } }
  }
  const running = services.filter(service => service.status === 'running').length;
  const readyCount = services.filter(service => service.lifecycle === 'ready').length;

  const devPorts = listeningPorts.filter(p => {
    if (p.port < 80 || p.port >= 32768) return false;
    const name = p.process.toLowerCase();
    const isExcluded = ['rapport', 'controlce', 'launchd', 'wechat', 'doubao', 'feishu', 'slack', 'clash', 'antigrav', 'agy', 'electron'].some(k => name.includes(k));
    return !isExcluded;
  });

  const agentTerminalActions = (session?.actions ?? []).filter(a => a.kind === 'terminal');
  const activeProfileKey = selectedProfile ?? profile?.defaultProfile ?? (profile?.profiles ? Object.keys(profile.profiles)[0] : null);
  const activePreset = (activeProfileKey && profile?.profiles) ? profile.profiles[activeProfileKey] : null;
  const effectiveCommand = (activePreset?.command?.trim()) || (profile?.command.trim() ?? '');
  const effectivePort = activePreset?.port ?? profile?.port;
  const registeredCommand = effectiveCommand;
  const registeredRunning = registeredCommand ? services.some(service => service.command === registeredCommand && service.status === 'running') : false;

  return <div className="feature-panel-layout" aria-labelledby="dev-title">
    <div className="workbench-header"><div className="workbench-title-group"><div className="large-tool-icon"><Terminal size={22} strokeWidth={1.5}/></div><div><h2 id="dev-title">Tongyun Dev · 服务与终端</h2><p>扫描目录并登记可运行项目，按端口和探针区分启动中、端口已通、就绪或失败。切换项目和页签不会停止服务。</p></div></div><div className="workbench-badges"><span className="badge">本地进程控制</span>{project && <span className="mono-subtle">{project.name}</span>}</div></div>
    {!isDesktop && <p className="inline-error" role="status">浏览器预览无法启动或管理本机进程，请在桌面版使用。</p>}
    <section className="panel-subcard" aria-labelledby="dev-scan-title">
      <div className="section-heading"><div className="subcard-title"><Search size={15}/><h3 id="dev-scan-title">扫描目录</h3></div><span className="meta">只读识别，登记不改项目文件</span></div>
      <p className="meta">向下查看有限层数，跳过 node_modules、target 等目录。已有运行配置的目录不会被覆盖。</p>
      <form className="command-input-row" onSubmit={event => { event.preventDefault(); void scanDirectory(); }}>
        <span className="prompt-symbol">/</span>
        <input className="command-input" aria-label="要扫描的目录" placeholder="要扫描的目录" value={scanPath} onChange={event => setScanPath(event.target.value)} disabled={!isDesktop || scanBusy}/>
        <input className="command-input" aria-label="扫描层数" inputMode="numeric" value={scanDepth} onChange={event => setScanDepth(event.target.value)} disabled={!isDesktop || scanBusy}/>
        <button type="button" className="secondary-button" disabled={!isDesktop || scanBusy} onClick={() => void pickScanDirectory()}><FolderOpen size={13}/>选择</button>
        <button type="submit" className="secondary-button" disabled={!isDesktop || scanBusy || !scanPath.trim()}>{scanBusy ? <LoaderCircle size={13} className="spin"/> : <Search size={13}/>}扫描</button>
      </form>
      {report && <p className="meta">已查看 {report.dirsVisited} 个目录，找到 {report.candidates.length} 个候选。{report.truncated ? '结果已截断，请缩小目录或层数。' : ''}</p>}
      {report && report.candidates.length === 0 && <p className="subcard-empty">这个目录下没有识别到可运行项目。</p>}
      {report && report.candidates.length > 0 && <div className="dev-candidate-list">{report.candidates.map(item => {
        const draft = drafts[item.path] ?? { command: item.command, port: item.port ? String(item.port) : '' };
        const locked = !!item.existingHasDev;
        return <label key={item.path} className="dev-candidate">
          <input type="checkbox" checked={selected.has(item.path)} disabled={!isDesktop || !!busy || locked} onChange={event => setSelected(previous => {
            const next = new Set(previous);
            if (event.target.checked) next.add(item.path); else next.delete(item.path);
            return next;
          })} aria-label={`选择 ${item.name}`}/>
          <span className="dev-candidate-fields">
            <span className="script-title-row"><span className="script-run-name">{item.name}</span><span className="mini-running-tag">{item.label}</span><span className="meta">{confidenceLabel[item.confidence] ?? item.confidence}</span>{item.portGuessed && <span className="meta">端口为默认猜测</span>}{locked && <span className="meta">已有运行配置，不覆盖</span>}{item.alreadyRegistered && !locked && <span className="meta">已登记，只补运行配置</span>}</span>
            <code className="script-run-cmd" title={item.path}>{item.path}</code>
            <span className="dev-inline-fields">
              <input className="command-input" aria-label={`${item.name} 启动命令`} value={draft.command} disabled={!isDesktop || !!busy || locked} onChange={event => setDrafts(previous => ({ ...previous, [item.path]: { ...draft, command: event.target.value } }))}/>
              <input className="command-input" aria-label={`${item.name} 端口`} inputMode="numeric" placeholder="端口" value={draft.port} disabled={!isDesktop || !!busy || locked} onChange={event => setDrafts(previous => ({ ...previous, [item.path]: { ...draft, port: event.target.value } }))}/>
            </span>
            {!!item.why?.length && <span className="meta">{item.why.join(' ')}</span>}
          </span>
        </label>;
      })}</div>}
      {report && <button type="button" className="secondary-button" disabled={!isDesktop || !!busy || scanBusy || ![...selected].some(path => report.candidates.some(item => item.path === path && !item.existingHasDev))} onClick={() => void registerSelected()}>{busy === 'import' ? <LoaderCircle size={13} className="spin"/> : <Check size={13}/>}登记所选</button>}
    </section>
    {!project ? <div className="panel-empty-placeholder"><Terminal size={32} strokeWidth={1.2}/><p>请先在左侧选择一个项目，或用上面的扫描登记新项目，再启动命令和查看日志。</p></div> : <>
      <p className="meta">正常退出工作台会停止这里启动的全部进程组。仅支持 macOS / Unix；请以前台模式运行命令，不要使用自行脱离进程组的守护模式。进程存活不等于服务就绪。</p>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button className="text-button" disabled={!isDesktop || !!busy} onClick={() => void readServices(project.id)}>重新读取状态</button></div>}
      <div className="dev-metrics-bar">
        <div className="metrics-ports-group">
          <Activity size={15}/>
          <span className="toolbar-label">当前项目托管进程：</span>
          <span>{loading ? '读取中…' : `${running} 个运行中 · ${readyCount} 个就绪`}</span>
          <span className="meta">进程存活不代表服务已就绪</span>
        </div>
        {devPorts.length > 0 && (
          <div className="listening-ports-group">
            <span className="toolbar-label">本机开发端口（不限当前项目）：</span>
            <div className="port-chips-list">
              {devPorts.slice(0, 8).map(p => (
                <button
                  key={p.port}
                  type="button"
                  className="port-chip-btn"
                  title={`在浏览器中打开 http://localhost:${p.port} (${p.process})`}
                  onClick={() => void openUrl(`http://localhost:${p.port}`).catch(cause => { errorSource.current = 'action'; setError(String(cause)); })}
                >
                  <span className="port-dot active" />
                  <span className="mono-subtle">:{p.port}</span>
                  <span className="port-proc-name">({p.process})</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {stack.length > 0 && (
          <div className="tech-badge-list">
            <span className="tech-badge-label"><Cpu size={13}/>运行时：</span>
            {stack.map(tech => <span key={tech} className="tech-badge">{tech}</span>)}
          </div>
        )}
      </div>
      {profile && <section className="panel-subcard"><div className="section-heading"><div className="subcard-title"><Play size={15}/><h3>登记的运行配置</h3></div><span className="meta">{profile.label}{group ? ` · 分组 ${group}` : ''}</span></div>
        {profile.profiles && Object.keys(profile.profiles).length > 0 && (
          <div className="profile-presets-row" style={{ display: 'flex', gap: '8px', alignItems: 'center', margin: '8px 0' }}>
            <span className="toolbar-label">环境预设：</span>
            {Object.entries(profile.profiles).map(([key, p]) => (
              <button
                key={key}
                type="button"
                className={`secondary-button-sm ${activeProfileKey === key ? 'active-profile' : ''}`}
                style={activeProfileKey === key ? { borderColor: 'var(--accent, #3b82f6)', fontWeight: 'bold' } : {}}
                onClick={() => setSelectedProfile(key)}
              >
                {p.label || key}
              </button>
            ))}
          </div>
        )}
        {(profile.java || profile.node || profile.javaHome || profile.nodeHome || profile.catalinaHome) && (
          <div className="toolchain-info-row" style={{ margin: '6px 0', fontSize: '12px', color: 'var(--text-muted, #888)' }}>
            {profile.java && <span style={{ marginRight: '12px' }}>Java: {profile.java}</span>}
            {profile.javaHome && <span style={{ marginRight: '12px' }}>JAVA_HOME: {profile.javaHome}</span>}
            {profile.catalinaHome && <span style={{ marginRight: '12px' }}>CATALINA_HOME: {profile.catalinaHome}</span>}
            {profile.node && <span style={{ marginRight: '12px' }}>Node: {profile.node}</span>}
            {profile.nodeHome && <span>Node Home: {profile.nodeHome}</span>}
          </div>
        )}
        {registeredCommand ? <div className="script-run-card"><div className="script-run-info"><div className="script-title-row"><span className="script-run-name">{profile.label}</span>{registeredRunning && <span className="mini-running-tag">进程运行中</span>}</div><code className="script-run-cmd" title={registeredCommand}>{registeredCommand}</code><span className="meta">{effectivePort ? `就绪端口 ${effectivePort}${profile.healthUrl ? ` · 探针 ${profile.healthUrl}` : ' · 端口可连接即就绪'}` : '未配置端口，进程存活不会标成就绪'}</span></div><button className="secondary-button-sm" disabled={!isDesktop || !!busy || loading || registeredRunning} onClick={() => run(registeredCommand, activeProfileKey)}>{busy === `start:${registeredCommand}` ? <LoaderCircle size={13} className="spin"/> : <Play size={13}/>}<span>{registeredRunning ? '已启动' : '按登记启动'}</span></button></div> : <p className="subcard-empty">这条登记没有启动命令，不能从这里启动。</p>}
        {members.length > 1 && <div className="script-actions-pair"><span className="meta">同组 {members.length} 个：{members.map(item => item.name).join('、')}</span><button className="secondary-button-sm" disabled={!isDesktop || !!busy} onClick={() => void runGroup('start')}>{busy === 'group-start' ? <LoaderCircle size={13} className="spin"/> : <Play size={13}/>}启动同组</button><button className="secondary-button-sm" disabled={!isDesktop || !!busy} onClick={() => void runGroup('stop')}><Square size={13}/>{busy === 'group-stop' ? '停止中…' : '停止同组'}</button></div>}
      </section>}
      {agentTerminalActions.length > 0 && (
        <section className="panel-subcard agent-subcard">
          <div className="section-heading">
            <div className="subcard-title">
              <Bot size={15} className="accent-color" />
              <h3>Agent 终端执行现场</h3>
              <span className="mini-badge-accent">{session?.agentName ?? 'Agent'}</span>
            </div>
            <span className="meta">{agentTerminalActions.length} 项自动化执行记录</span>
          </div>
          <div className="agent-action-mini-list">
            {agentTerminalActions.slice(-4).reverse().map(act => (
              <div key={act.id} className="agent-action-mini-item">
                <div className="action-mini-header">
                  <span className={`status-dot ${act.status === 'done' ? 'available' : act.status === 'running' ? 'active-pulse' : 'error'}`} />
                  <code className="action-mini-cmd">{act.title}</code>
                  <span className="mono-subtle">{act.timestamp}</span>
                </div>
                <div className="action-mini-detail mono-subtle">{act.detail}</div>
              </div>
            ))}
          </div>
        </section>
      )}
      <section className="panel-subcard"><div className="section-heading"><div className="subcard-title"><Play size={15}/><h3>项目命令</h3></div><span className="meta">{scripts.length ? `${scripts.length} 个脚本` : '无 package 脚本'}</span></div>
        {scripts.length ? <div className="script-grid">{scripts.map(script => {
          const active = services.find(service => service.command === script.command && service.status === 'running');
          return <div key={script.name} className="script-run-card"><div className="script-run-info"><div className="script-title-row"><span className="script-run-name">{script.name}</span>{active && <span className="mini-running-tag">进程运行中</span>}</div><code className="script-run-cmd" title={script.command}>{script.command}</code></div><button className="secondary-button-sm" disabled={!isDesktop || !!busy || loading || !!active} onClick={() => run(script.command)}>{busy === `start:${script.command}` ? <LoaderCircle size={13} className="spin"/> : <Play size={13}/>}<span>{active ? '已启动' : '运行'}</span></button></div>;
        })}</div> : <p className="subcard-empty">项目根目录没有可用的 package 脚本。可在下方输入项目命令。</p>}
        <form onSubmit={submit} className="command-input-row"><span className="prompt-symbol">$</span><input className="command-input" aria-label="项目命令" placeholder="输入项目命令，如 npm run dev 或 npm test" value={customCommand} onChange={event => setCustomCommand(event.target.value)} disabled={!isDesktop || !!busy}/><button type="submit" className="secondary-button" disabled={!isDesktop || !!busy || !customCommand.trim()}>{busy?.startsWith('start:') ? <LoaderCircle size={13} className="spin"/> : <Play size={13}/>}运行</button></form>
      </section>
      <section className="active-services-section"><div className="section-heading"><div className="subcard-title"><Activity size={15}/><h3>进程与执行记录</h3></div><button className="text-button" disabled={!isDesktop || !!busy} onClick={() => void readServices(project.id)}><RotateCw size={13}/>刷新</button></div>
        {loading ? <p role="status">正在读取托管进程…</p> : services.length === 0 ? <p className="subcard-empty">这个项目还没有执行记录。运行后可在这里查看状态、停止、重启和读取日志。</p> : <div className="services-grid">{services.map(service => {
          const label = primaryStatus(service);
          const detail = secondaryStatus(service);
          const dot = service.lifecycle === 'failed' || service.status === 'failed' ? 'error' : service.lifecycle === 'ready' ? 'available' : service.status === 'running' ? 'active-pulse' : '';
          return <div key={service.id} className="service-card"><div className="service-header"><div className="service-title-info"><span className={`status-dot ${dot}`}/><span className="service-name">{label}</span>{service.activeProfile && <span className="mini-running-tag">预设: {service.activeProfile}</span>}{detail && <span className="meta">{detail}</span>}<code className="service-cmd">{service.command}</code></div><div className="service-actions"><button className="service-btn" disabled={!isDesktop || !!busy} onClick={() => void mutate(`restart:${service.id}`, id => restartProjectService(id, service.id))}><RotateCw size={13}/>{busy === `restart:${service.id}` ? '重启中…' : '重启'}</button><button className="service-btn stop" disabled={!isDesktop || !!busy || service.status !== 'running'} onClick={() => void mutate(`stop:${service.id}`, id => stopProjectService(id, service.id))}><Square size={13}/>{busy === `stop:${service.id}` ? '停止中…' : '停止'}</button></div></div><div className="service-footer"><span className="meta">{service.pid ? `进程组 ${service.pid}` : `退出码 ${service.exitCode ?? '无（信号终止）'}`}</span><span className="meta">{service.port ? `端口 ${service.port}${service.portOpen ? ' 已通' : ' 未通'}` : '无就绪端口'}</span><span className="meta">启动于 {new Date(service.startedAt).toLocaleString()}</span></div>{service.failure && <p className="meta">{service.failure}</p>}</div>;
        })}</div>}
      </section>
      <section className="terminal-console-card"><div className="terminal-console-header"><div className="terminal-title"><Terminal size={14}/><span>日志尾部</span></div><button className="terminal-btn" onClick={() => setHints(value => !value)}>{hints ? '收起排查提示' : '本地排查提示'}</button></div>
        {hints && <div className="ai-diagnostic-banner"><p>以下是固定排查提示，没有调用 AI，也未自动诊断你的项目。</p><ol><li>根据真实退出码和错误日志定位失败步骤。</li><li>核对命令、工作目录、依赖与环境变量。</li><li>仅在日志提示端口冲突时核对端口占用。</li></ol></div>}
        <div className="terminal-body">{services.length === 0 ? <div className="terminal-empty"><span className="terminal-prompt-hint">执行命令后，日志尾部会显示在这里。</span></div> : services.map(service => {
          const tail = service.logTail || [service.stdout, service.stderr].filter(Boolean).join('\n');
          return <div key={service.id} className="terminal-log-entry"><div className="terminal-log-header"><span className="terminal-cmd-title">$ {service.command}</span><div className="terminal-cmd-meta"><span className={`exit-badge ${service.lifecycle === 'failed' || service.status === 'failed' ? 'exit-failure' : ''}`}>{primaryStatus(service)}{service.exitCode != null ? ` · ${service.exitCode}` : ''}</span><button className="terminal-mini-btn" aria-label={`复制 ${service.command} 输出`} onClick={() => void copy(service)}>{copied === service.id ? <Check size={12}/> : <Copy size={12}/>}</button></div></div>{service.outputTruncated && <p className="meta">输出较多，每个输出流只保留最后 64 KiB，这里显示其中的末尾 200 行。</p>}<pre className="terminal-stdout">{tail || '暂无输出'}</pre></div>;
        })}</div>
      </section>
    </>}
  </div>;
}

function withDraft(item: DevCandidate, draft: { command: string; port: string } | undefined): DevCandidate {
  const portText = draft?.port.trim() ?? (item.port ? String(item.port) : '');
  if (portText === '') return { ...item, command: draft?.command ?? item.command, port: null };
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${item.name} 的端口无效。请填写 1 到 65535 的整数，或留空。`);
  }
  return { ...item, command: draft?.command ?? item.command, port };
}
