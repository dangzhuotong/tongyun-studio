import { useState } from 'react';
import type { Project, ToolId, ToolStatus } from '../contracts';
import { isDesktop, launchTool } from '../bridge';
import { ArrowUpRight, Folder, LoaderCircle, RefreshCw } from '../components/Icons';
import { getTool } from './tools';

export default function ToolPanel({ toolId, project, status, loading, error, onRefresh }: { toolId: ToolId; project: Project | null; status?: ToolStatus; loading: boolean; error: string | null; onRefresh: () => void }) {
  const tool = getTool(toolId);
  const [launch, setLaunch] = useState<{ busy: boolean; message: string; error: boolean }>({ busy: false, message: '', error: false });
  const Icon = tool.Icon;
  async function open() {
    setLaunch({ busy: true, message: '', error: false });
    try { const result = await launchTool(toolId); setLaunch({ busy: false, message: result.message, error: false }); }
    catch (cause) { setLaunch({ busy: false, message: String(cause), error: true }); }
  }
  return <section className="tool-panel" aria-labelledby="tool-title">
    <div className="section-eyebrow">工具 / {tool.label}</div>
    <div className="tool-panel-heading"><div className="large-tool-icon"><Icon size={24} strokeWidth={1.5}/></div><div><h2 id="tool-title">{tool.name}</h2><p>{tool.description}</p></div></div>
    <div className="integration-card">
      <div className="section-heading"><h3>独立应用入口</h3><span className="badge">尚未内嵌</span></div>
      <p>从这里打开已安装的工具。打开后，请在工具中选择当前项目或连接。</p>
      <div className="context-line"><Folder size={16}/><span>{project ? project.name : '尚未选择项目'}</span>{project && <code title={project.path}>{project.path}</code>}</div>
      <div className="tool-availability">
        {!isDesktop ? <span>浏览器预览无法检测本机工具。</span> : loading ? <span className="inline"><LoaderCircle size={14} className="spin"/>正在检测本机安装…</span> : error ? <span role="alert">工具检测失败：{error}</span> : <><span className={`status-dot ${status?.available ? 'available' : ''}`}/><span>{status?.available ? '已安装 · 可打开' : '未检测到安装'}</span></>}
        <button className="text-button" disabled={!isDesktop || loading} onClick={onRefresh}><RefreshCw size={13}/>重新检测</button>
      </div>
      {isDesktop && !loading && !error && !status?.available && <p className="helper">请先安装 {tool.name} 桌面应用，再点击「重新检测」。{status?.detail ? ` ${status.detail}` : ''}</p>}
      <button className="primary-button" onClick={open} disabled={!isDesktop || !status?.available || loading || !!error || launch.busy}>{launch.busy ? <LoaderCircle size={15} className="spin"/> : <ArrowUpRight size={15}/>} {launch.busy ? '正在打开…' : `打开 ${tool.name}`}</button>
      {launch.message && <p className={launch.error ? 'inline-error' : 'helper'} role={launch.error ? 'alert' : 'status'}>{launch.message}</p>}
    </div>
    <div className="section-heading capability-heading"><h3>在这个工具里</h3><span className="meta">按需使用</span></div>
    <div className="capability-list">{tool.details.map((detail, index) => <div key={detail}><span className="step-number">0{index + 1}</span><span>{detail}</span></div>)}</div>
    <p className="panel-note">{tool.hint} 切换本页不会启动工具或服务。</p>
  </section>;
}
