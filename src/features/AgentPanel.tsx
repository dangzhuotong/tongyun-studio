import type { AgentSessionState, Project, ActiveTab } from '../contracts';
import { Bot, Code2, Copy, Database, GitBranch, Send, Square, Terminal, Workflow, Zap } from '../components/Icons';

interface AgentPanelProps {
  project: Project | null;
  session: AgentSessionState;
  onNavigate: (tab: ActiveTab) => void;
  onNotify?: (msg: string) => void;
}

const unavailableReason = '尚未接入 Agent 调度与审计服务，无法投递指令、暂停执行或导出审计记录。';

export default function AgentPanel({ project, session, onNavigate }: AgentPanelProps) {
  const observed = project && session.projectId === project.id && session.connectionStatus === 'connected'
    ? session
    : null;
  const plan = observed?.plan;

  return (
    <div className="feature-panel-layout" aria-labelledby="agent-panel-title">
      <div className="workbench-header">
        <div className="workbench-title-group">
          <div className="large-tool-icon"><Bot size={22} strokeWidth={1.5} /></div>
          <div>
            <h2 id="agent-panel-title">Tongyun Agent · 执行记录与计划</h2>
            <p>Agent 服务尚未接入。当前没有可核验的工人、模型、用量或执行进度。</p>
          </div>
        </div>
        <div className="workbench-badges">
          <span className="mini-badge">{observed ? '已连接执行记录来源' : 'Agent 未接入'}</span>
          <button className="secondary-button-sm" disabled title={unavailableReason} aria-describedby="agent-unavailable"><Copy size={12} /><span>导出审计轨迹</span></button>
        </div>
      </div>

      <p id="agent-unavailable" className="meta">{unavailableReason}</p>
      {!project ? (
        <div className="panel-empty-placeholder"><Bot size={32} strokeWidth={1.2} /><p>尚未选择项目。选择项目后也需接入真实 Agent 服务，才会产生执行记录。</p></div>
      ) : (
        <div className="agent-full-grid">
          <div className="agent-overview-bar">
            <div className="agent-id-card">
              <div className="agent-avatar-lg"><Bot size={24} /></div>
              <div>
                <div className="agent-name-row"><span className="agent-id-name">{observed?.agentName ?? '未接入 Agent'}</span><span className="mini-badge">模型：{observed?.model ?? '未知'}</span></div>
                <div className="agent-meta-row"><span className="meta">当前项目：{project.name}</span></div>
                <div className="agent-meta-row"><span className="meta">最近心跳：{observed?.lastHeartbeat ?? '未知'}</span></div>
              </div>
            </div>
            <div className="agent-metrics-trio">
              <div className="metric-box"><span className="metric-num">{plan?.progressPercent == null ? '未知' : `${plan.progressPercent}%`}</span><span className="metric-label">计划进度</span></div>
              <div className="metric-box"><span className="metric-num">{observed ? observed.actions.length : '未知'}</span><span className="metric-label">已接收工具调用</span></div>
              <div className="metric-box"><span className="metric-num">{observed?.tokensConsumed ?? '未知'}</span><span className="metric-label">Token 用量</span></div>
              <div className="metric-box"><span className="metric-num">{observed?.filesTouched ?? '未知'}</span><span className="metric-label">涉及文件</span></div>
            </div>
          </div>

          <div className="agent-dashboard-split">
            <div className="agent-col-plan">
              <div className="subpanel-card">
                <div className="subpanel-header"><Workflow size={14} /><span className="subpanel-title">任务计划</span></div>
                <p className="meta">{plan?.goal ?? '暂无真实任务计划'}</p>
                {plan && <div className="agent-plan-step-items">{plan.steps.map(step => <div key={step.id} className={`agent-step-row ${step.status}`}><div className="step-body"><span className="step-text">{step.text}</span><span className="step-tag">{step.status}</span></div></div>)}</div>}
              </div>
              <div className="subpanel-card">
                <div className="subpanel-header"><Zap size={14} /><span className="subpanel-title">工作台入口</span></div>
                <p className="meta">以下入口供手动使用，尚未绑定 Agent。</p>
                <div className="tool-matrix-grid">
                  <button className="matrix-tile" onClick={() => onNavigate('dev')}><Terminal size={14} /><span>Dev 进程终端</span></button>
                  <button className="matrix-tile" onClick={() => onNavigate('git')}><GitBranch size={14} /><span>Git 版本控制</span></button>
                  <button className="matrix-tile" onClick={() => onNavigate('api')}><Code2 size={14} /><span>API 接口调试</span></button>
                  <button className="matrix-tile" onClick={() => onNavigate('database')}><Database size={14} /><span>Database SQLite</span></button>
                </div>
              </div>
            </div>
            <div className="agent-col-stream">
              <div className="subpanel-card stream-full-height">
                <div className="subpanel-header-with-filters"><div className="subpanel-title-group"><Zap size={14} /><span className="subpanel-title">执行记录</span></div></div>
                <div className="agent-actions-scroll">
                  {observed?.actions.length ? observed.actions.slice().reverse().map(action => (
                    <div key={action.id} className={`action-card-full ${action.status}`}>
                      <div className="action-card-head"><span className="action-type-pill">{action.kind}</span><div className="action-main-info"><span className="action-title-text">{action.title}</span><p className="action-detail-text mono-subtle">{action.detail}</p></div></div>
                      <div className="action-card-foot"><span className="mono-subtle">{action.timestamp}</span><span>{action.status}</span></div>
                    </div>
                  )) : <div className="panel-empty-placeholder"><Bot size={28} strokeWidth={1.3} /><p>暂无真实执行记录</p><span>接入真实事件来源后，才会展示操作和结果。</span></div>}
                </div>
                <div className="agent-prompt-bar">
                  <input className="agent-prompt-input" aria-label="Agent 补充指令" placeholder="接入调度服务后可发送指令" disabled aria-describedby="agent-unavailable" />
                  <button className="primary-button" disabled title={unavailableReason} aria-describedby="agent-unavailable"><Send size={13} /><span>投递指令</span></button>
                  <button className="secondary-button" disabled title={unavailableReason} aria-describedby="agent-unavailable"><Square size={13} /><span>暂停</span></button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
