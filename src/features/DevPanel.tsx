import { useState, useRef, useEffect, useCallback, type FormEvent } from 'react';
import type { Project, ProjectInspection, ManagedService, ListeningPort } from '../contracts';
import {
  isDesktop,
  startProjectService,
  listProjectServices,
  stopProjectService,
  restartProjectService,
  detectListeningPorts,
  openUrl,
} from '../bridge';
import { Activity, Check, Copy, Cpu, LoaderCircle, Play, RotateCw, Square, Terminal } from '../components/Icons';

const statusLabel: Record<ManagedService['status'], string> = { running: '进程运行中', stopped: '已停止', exited: '已完成', failed: '执行失败' };

export default function DevPanel({ project, inspection, onNotify }: {
  project: Project | null;
  inspection?: ProjectInspection | null;
  onRefresh?: () => void;
  onNotify?: (msg: string) => void;
}) {
  const [services, setServices] = useState<ManagedService[]>([]);
  const [listeningPorts, setListeningPorts] = useState<ListeningPort[]>([]);
  const [customCommand, setCustomCommand] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [hints, setHints] = useState(false);
  const projectId = project?.id;
  const currentProject = useRef(projectId);
  currentProject.current = projectId;
  const requestSequence = useRef(0);
  const mutations = useRef(new Set<string>());
  const mounted = useRef(true);
  const stack = inspection?.techStack ?? [];
  const scripts = inspection?.scripts ?? [];

  const readServices = useCallback(async (id: string) => {
    if (!isDesktop || mutations.current.has(id)) return;
    const request = ++requestSequence.current;
    try {
      const [result, ports] = await Promise.all([
        listProjectServices(id).catch(() => [] as ManagedService[]),
        detectListeningPorts().catch(() => [] as ListeningPort[]),
      ]);
      if (mounted.current && currentProject.current === id && request === requestSequence.current) {
        setServices(result);
        setListeningPorts(ports);
        setError(null);
      }
    } catch (cause) {
      if (mounted.current && currentProject.current === id && request === requestSequence.current) setError(String(cause));
    } finally {
      if (mounted.current && currentProject.current === id && request === requestSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    requestSequence.current++;
    setServices([]); setError(null); setBusy(null); setCustomCommand(''); setCopied(null); setHints(false);
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
    setBusy(label); setError(null);
    try {
      const result = await action(id);
      if (mounted.current && currentProject.current === id) {
        setServices(previous => [result, ...previous.filter(item => item.id !== result.id)]);
        onNotify?.(`${result.command}：${statusLabel[result.status]}`);
      }
    } catch (cause) {
      if (mounted.current && currentProject.current === id) setError(String(cause));
    } finally {
      mutations.current.delete(id);
      if (mounted.current && currentProject.current === id) { setBusy(null); setLoading(false); }
    }
  }
  function run(command: string) { if (command.trim()) void mutate(`start:${command}`, id => startProjectService(id, command.trim())); }
  function submit(event: FormEvent) { event.preventDefault(); run(customCommand); }
  async function copy(service: ManagedService) {
    const id = projectId;
    try {
      await navigator.clipboard.writeText(`$ ${service.command}\n${service.stdout}\n${service.stderr}`);
      if (mounted.current && currentProject.current === id) { setCopied(service.id); onNotify?.('已复制命令输出'); }
    } catch (cause) { if (mounted.current && currentProject.current === id) setError(`复制失败：${String(cause)}`); }
  }
  const running = services.filter(service => service.status === 'running').length;

  return <div className="feature-panel-layout" aria-labelledby="dev-title">
    <div className="workbench-header"><div className="workbench-title-group"><div className="large-tool-icon"><Terminal size={22} strokeWidth={1.5}/></div><div><h2 id="dev-title">Tongyun Dev · 企业级服务与终端</h2><p>运行项目命令，查看真实进程状态与输出。切换项目和页签不会停止服务。</p></div></div><div className="workbench-badges"><span className="badge">企业级进程控制</span>{project && <span className="mono-subtle">{project.name}</span>}</div></div>
    {!isDesktop && <p className="inline-error" role="status">浏览器预览无法启动或管理本机进程，请在桌面版使用。</p>}
    {!project ? <div className="panel-empty-placeholder"><Terminal size={32} strokeWidth={1.2}/><p>请先在左侧选择或添加一个项目，以运行项目脚本与服务。</p></div> : <>
      <p className="meta">正常退出工作台会停止这里启动的全部进程组。仅支持 macOS / Unix；请以前台模式运行命令，不要使用自行脱离进程组的守护模式。</p>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button className="text-button" disabled={!isDesktop || !!busy} onClick={() => void readServices(project.id)}>重新读取状态</button></div>}
      <div className="dev-metrics-bar">
        <div className="metrics-ports-group">
          <Activity size={15}/>
          <span className="toolbar-label">当前项目托管进程：</span>
          <span>{loading ? '读取中…' : `${running} 个运行中`}</span>
          <span className="meta">进程存活不代表服务已就绪</span>
        </div>
        {listeningPorts.length > 0 && (
          <div className="listening-ports-group">
            <span className="toolbar-label">活跃监听端口：</span>
            <div className="port-chips-list">
              {listeningPorts.map(p => (
                <button
                  key={p.port}
                  type="button"
                  className="port-chip-btn"
                  title={`在浏览器中打开 http://localhost:${p.port} (${p.process})`}
                  onClick={() => void openUrl(`http://localhost:${p.port}`)}
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
      <section className="panel-subcard"><div className="section-heading"><div className="subcard-title"><Play size={15}/><h3>项目命令</h3></div><span className="meta">{scripts.length ? `${scripts.length} 个脚本` : '无 package 脚本'}</span></div>
        {scripts.length ? <div className="script-grid">{scripts.map(script => {
          const active = services.find(service => service.command === script.command && service.status === 'running');
          return <div key={script.name} className="script-run-card"><div className="script-run-info"><div className="script-title-row"><span className="script-run-name">{script.name}</span>{active && <span className="mini-running-tag">进程运行中</span>}</div><code className="script-run-cmd" title={script.command}>{script.command}</code></div><button className="secondary-button-sm" disabled={!isDesktop || !!busy || loading || !!active} onClick={() => run(script.command)}>{busy === `start:${script.command}` ? <LoaderCircle size={13} className="spin"/> : <Play size={13}/>}<span>{active ? '已启动' : '运行'}</span></button></div>;
        })}</div> : <p className="subcard-empty">项目根目录没有可用的 package 脚本。可在下方输入项目命令。</p>}
        <form onSubmit={submit} className="command-input-row"><span className="prompt-symbol">$</span><input className="command-input" aria-label="项目命令" placeholder="输入项目命令，如 npm run dev 或 npm test" value={customCommand} onChange={event => setCustomCommand(event.target.value)} disabled={!isDesktop || !!busy}/><button type="submit" className="secondary-button" disabled={!isDesktop || !!busy || !customCommand.trim()}>{busy?.startsWith('start:') ? <LoaderCircle size={13} className="spin"/> : <Play size={13}/>}运行</button></form>
      </section>
      <section className="active-services-section"><div className="section-heading"><div className="subcard-title"><Activity size={15}/><h3>进程与执行记录</h3></div><button className="text-button" disabled={!isDesktop || !!busy} onClick={() => void readServices(project.id)}><RotateCw size={13}/>刷新</button></div>
        {loading ? <p role="status">正在读取托管进程…</p> : services.length === 0 ? <p className="subcard-empty">这个项目还没有执行记录。运行后可在这里查看状态、停止、重启和读取日志。</p> : <div className="services-grid">{services.map(service => <div key={service.id} className="service-card"><div className="service-header"><div className="service-title-info"><span className={`status-dot ${service.status === 'running' ? 'available' : ''}`}/><span className="service-name">{statusLabel[service.status]}</span><code className="service-cmd">{service.command}</code></div><div className="service-actions"><button className="service-btn" disabled={!isDesktop || !!busy} onClick={() => void mutate(`restart:${service.id}`, id => restartProjectService(id, service.id))}><RotateCw size={13}/>{busy === `restart:${service.id}` ? '重启中…' : '重启'}</button><button className="service-btn stop" disabled={!isDesktop || !!busy || service.status !== 'running'} onClick={() => void mutate(`stop:${service.id}`, id => stopProjectService(id, service.id))}><Square size={13}/>{busy === `stop:${service.id}` ? '停止中…' : '停止'}</button></div></div><div className="service-footer"><span className="meta">{service.pid ? `进程组 ${service.pid}` : `退出码 ${service.exitCode ?? '无（信号终止）'}`}</span><span className="meta">启动于 {new Date(service.startedAt).toLocaleString()}</span></div></div>)}</div>}
      </section>
      <section className="terminal-console-card"><div className="terminal-console-header"><div className="terminal-title"><Terminal size={14}/><span>命令输出</span></div><button className="terminal-btn" onClick={() => setHints(value => !value)}>{hints ? '收起排查提示' : '本地排查提示'}</button></div>
        {hints && <div className="ai-diagnostic-banner"><p>以下是固定排查提示，没有调用 AI，也未自动诊断你的项目。</p><ol><li>根据真实退出码和错误日志定位失败步骤。</li><li>核对命令、工作目录、依赖与环境变量。</li><li>仅在日志提示端口冲突时核对端口占用。</li></ol></div>}
        <div className="terminal-body">{services.length === 0 ? <div className="terminal-empty"><span className="terminal-prompt-hint">执行命令后，标准输出与错误输出会显示在这里。</span></div> : services.map(service => <div key={service.id} className="terminal-log-entry"><div className="terminal-log-header"><span className="terminal-cmd-title">$ {service.command}</span><div className="terminal-cmd-meta"><span className={`exit-badge ${service.status === 'failed' ? 'exit-failure' : ''}`}>{statusLabel[service.status]}{service.exitCode != null ? ` · ${service.exitCode}` : ''}</span><button className="terminal-mini-btn" aria-label={`复制 ${service.command} 输出`} onClick={() => void copy(service)}>{copied === service.id ? <Check size={12}/> : <Copy size={12}/>}</button></div></div>{service.outputTruncated && <p className="meta">输出较多，仅保留每个输出流最后 64 KiB。</p>}{service.stdout && <pre className="terminal-stdout">{service.stdout}</pre>}{service.stderr && <pre className="terminal-stderr">{service.stderr}</pre>}{!service.stdout && !service.stderr && <p className="meta">暂无输出</p>}</div>)}</div>
      </section>
    </>}
  </div>;
}
