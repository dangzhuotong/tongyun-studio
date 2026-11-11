import { useState } from 'react';
import type { AgentSessionState, Project, ActiveTab } from '../contracts';
import { Bot, Code2, Copy, Database, GitBranch, Send, Square, Terminal, Workflow, Zap } from '../components/Icons';

interface AgentPanelProps {
  project: Project | null;
  session: AgentSessionState;
  onNavigate: (tab: ActiveTab) => void;
  onNotify?: (msg: string) => void;
  onInitializeSession?: () => void;
  onSendInstruction?: (text: string) => Promise<void> | void;
  onExportAudit?: () => Promise<void> | void;
  onTogglePause?: () => Promise<void> | void;
}

const unavailableReason = '当前为只读文件快照。发送指令和暂停需要接入调度服务。';

export default function AgentPanel({
  project,
  session,
  onNavigate,
  onInitializeSession,
  onSendInstruction,
  onExportAudit,
  onTogglePause,
}: AgentPanelProps) {
  const [instruction, setInstruction] = useState('');
  const observed = project && session.projectId === project.id && session.connectionStatus === 'connected'
    ? session
    : null;
  const plan = observed?.plan;
  const canControl = Boolean(observed && (onSendInstruction || onTogglePause));

  return (
    <div className="feature-panel-layout" aria-labelledby="agent-panel-title">
      <div className="workbench-header">
        <div className="workbench-title-group">
          <div className="large-tool-icon"><Bot size={22} strokeWidth={1.5} /></div>
          <h2 id="agent-panel-title">智能体</h2>
        </div>
        <div className="workbench-badges">
          <span className="mini-badge">{observed ? '已读取本地快照' : 'Agent 未接入'}</span>
          {observed && onExportAudit && (
            <button className="secondary-button" onClick={() => void onExportAudit()}>
              <Copy size={13} />导出快照
            </button>
          )}
        </div>
      </div>

      {!observed ? (
        <div className="panel-empty-placeholder">
          <Bot size={28} strokeWidth={1.2} />
          <p>{project ? '暂无 Agent 快照' : '选择一个项目查看 Agent 快照'}</p>
          {project && <span>工作台从项目内的 .tongyun/agent-session.json 读取计划和执行记录。</span>}
          {project && onInitializeSession && (
            <button type="button" className="secondary-button" onClick={onInitializeSession}>初始化跟踪模板</button>
          )}
        </div>
      ) : (
        <div className="agent-full-grid">
          <div className="agent-overview-bar">
            <div className="agent-id-card">
              <div className="agent-avatar-lg"><Bot size={24} /></div>
              <div>
                <div className="agent-name-row"><span className="agent-id-name">{observed?.agentName ?? '未接入 Agent'}</span><span className="mini-badge">模型：{observed?.model ?? '未知'}</span></div>
                <div className="agent-meta-row"><span className="meta">当前项目：{project?.name}</span></div>
                <div className="agent-meta-row"><span className="meta">最近心跳：{observed?.lastHeartbeat ?? '未知'}</span></div>
              </div>
            </div>
            <div className="agent-metrics-trio">
              <div className="metric-box"><span className="metric-num">{plan?.progressPercent == null ? '未知' : `${plan.progressPercent}%`}</span><span className="metric-label">计划进度</span></div>
              <div className="metric-box"><span className="metric-num">{observed ? observed.actions.length : '未知'}</span><span className="metric-label">快照记录</span></div>
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
                <div className="subpanel-header"><Zap size={14} /><span className="subpanel-title">相关工作台</span></div>
                <div className="tool-matrix-grid">
                  <button className="matrix-tile" onClick={() => onNavigate('dev')}>
                    <Terminal size={14} />
                    <span>Dev 进程终端</span>
                    {observed && <span className="mini-badge-accent">{observed.actions.filter(a => a.kind === 'terminal').length} 项调用</span>}
                  </button>
                  <button className="matrix-tile" onClick={() => onNavigate('git')}>
                    <GitBranch size={14} />
                    <span>Git 版本控制</span>
                    {observed && <span className="mini-badge-accent">{observed.actions.filter(a => a.kind === 'git' || a.kind === 'edit').length} 项交付</span>}
                  </button>
                  <button className="matrix-tile" onClick={() => onNavigate('api')}>
                    <Code2 size={14} />
                    <span>API 接口调试</span>
                    {observed && <span className="mini-badge-accent">{observed.actions.filter(a => a.kind === 'http').length} 项探针</span>}
                  </button>
                  <button className="matrix-tile" onClick={() => onNavigate('database')}>
                    <Database size={14} />
                    <span>Database 数据</span>
                    {observed && <span className="mini-badge-accent">{observed.actions.filter(a => a.kind === 'sql').length} 项查询</span>}
                  </button>
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
                  )) : (
                    <div className="panel-empty-placeholder">
                      <Bot size={28} strokeWidth={1.3} />
                      <p>暂无真实执行记录</p>
                    </div>
                  )}
                </div>
                {canControl ? (
                  <form
                    className="agent-prompt-bar"
                    onSubmit={e => {
                      e.preventDefault();
                      if (instruction.trim()) {
                        void onSendInstruction?.(instruction);
                        setInstruction('');
                      }
                    }}
                  >
                    {onSendInstruction && <>
                    <input
                      className="agent-prompt-input"
                      aria-label="Agent 补充指令"
                      placeholder="向当前 Agent 投递补充指令..."
                      value={instruction}
                      onChange={e => setInstruction(e.target.value)}
                    />
                    <button
                      type="submit"
                      className="primary-button"
                      disabled={!onSendInstruction || !instruction.trim()}
                      title="投递指令"
                    >
                      <Send size={13} />
                      <span>投递指令</span>
                    </button>
                    </>}
                    {onTogglePause && <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void onTogglePause?.()}
                      title="暂停"
                    >
                      <Square size={13} />
                      <span>暂停</span>
                    </button>}
                  </form>
                ) : <p className="meta agent-readonly-note">{unavailableReason}</p>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
