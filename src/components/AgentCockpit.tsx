import { useState } from 'react';
import type { AgentSessionState, ActiveTab, Project } from '../contracts';
import { Bot, Copy, Send, Square, Workflow, X, Zap } from './Icons';

interface AgentCockpitProps {
  project: Project | null;
  session: AgentSessionState;
  onClose: () => void;
  onNavigate: (tab: ActiveTab) => void;
  onNotify?: (msg: string) => void;
  onInitializeSession?: () => void;
  onSendInstruction?: (text: string) => Promise<void> | void;
  onExportAudit?: () => Promise<void> | void;
  onTogglePause?: () => Promise<void> | void;
}

const unavailableReason = '只读文件快照 · 调度服务未接入';

export default function AgentCockpit({
  project,
  session,
  onClose,
  onInitializeSession,
  onSendInstruction,
  onExportAudit,
  onTogglePause,
}: AgentCockpitProps) {
  const [activeSubTab, setActiveSubTab] = useState<'stream' | 'plan'>('stream');
  const [instruction, setInstruction] = useState('');
  // Only display observations from a connected session belonging to this project.
  const observed = project && session.projectId === project.id && session.connectionStatus === 'connected'
    ? session
    : null;
  const plan = observed?.plan;

  return (
    <aside className="agent-cockpit-pane" aria-label="Agent 操作可视化监视舱">
      <div className="cockpit-header">
        <div className="cockpit-brand-row">
          <div className="cockpit-badge-group">
            <Bot size={14} />
            <span className="cockpit-title">Agent 操作监视舱</span>
          </div>
          <div className="cockpit-controls">
            {observed && onExportAudit && (
              <button className="icon-button-sm" onClick={() => void onExportAudit()} title="导出 Agent 快照" aria-label="导出 Agent 快照">
                <Copy size={13} />
              </button>
            )}
            <button className="icon-button-sm" onClick={onClose} title="收起监视舱 (⌘J)" aria-label="关闭 Agent 监视舱">
              <X size={14} />
            </button>
          </div>
        </div>
        {observed ? <>
        <div className="agent-hud-card">
          <div className="hud-identity">
            <div className="hud-avatar"><Bot size={16} strokeWidth={1.6} /></div>
            <div className="hud-info">
              <span className="hud-name">{observed?.agentName ?? '未接入 Agent'}</span>
              <span className="hud-model">模型：{observed?.model ?? '未知'}</span>
            </div>
            <span className="hud-mode-pill">{observed ? '文件快照' : '未接入'}</span>
          </div>
          <p className="mono-subtle">当前项目：{project?.name ?? '未选择项目'}</p>
          <div className="hud-stats-row">
            <div className="hud-stat-item"><span className="hud-stat-val">{observed ? observed.actions.length : '未知'}</span><span className="hud-stat-label">已接收操作</span></div>
            <div className="hud-stat-item"><span className="hud-stat-val">{observed?.filesTouched ?? '未知'}</span><span className="hud-stat-label">涉及文件</span></div>
            <div className="hud-stat-item"><span className="hud-stat-val">{observed?.tokensConsumed ?? '未知'}</span><span className="hud-stat-label">Token 用量</span></div>
            <div className="hud-stat-item"><span className="hud-stat-val">{plan?.progressPercent == null ? '未知' : `${plan.progressPercent}%`}</span><span className="hud-stat-label">目标进度</span></div>
          </div>
        </div>
        <div className="cockpit-subtabs">
          <button className={`cockpit-tab-btn ${activeSubTab === 'stream' ? 'active' : ''}`} onClick={() => setActiveSubTab('stream')}><Zap size={12} />执行记录</button>
          <button className={`cockpit-tab-btn ${activeSubTab === 'plan' ? 'active' : ''}`} onClick={() => setActiveSubTab('plan')}><Workflow size={12} />任务计划</button>
        </div>
        </> : <p className="mono-subtle">当前项目：{project?.name ?? '未选择项目'}</p>}
      </div>

      <div className="cockpit-body">
        {!observed ? (
          <div className="panel-empty-placeholder">
            <Bot size={24} strokeWidth={1.3} />
            <p>{project ? '暂无 Agent 快照' : '选择一个项目查看 Agent 快照'}</p>
            {project && <span>记录来自项目内的 .tongyun/agent-session.json。</span>}
            {project && onInitializeSession && (
              <button type="button" className="secondary-button-xs" onClick={onInitializeSession}>初始化跟踪模板</button>
            )}
          </div>
        ) : activeSubTab === 'stream' ? (
          <div className="action-stream-list">
            <div className="stream-section-lead"><span>已接收的执行记录</span><span className="mono-subtle">最近心跳：{observed?.lastHeartbeat ?? '未知'}</span></div>
            {observed?.actions.length ? observed.actions.slice().reverse().map(action => (
              <div key={action.id} className={`action-card ${action.status}`}>
                <div className="action-card-header"><span className="action-title">{action.title}</span></div>
                <p className="action-detail mono-subtle">{action.detail}</p>
                <div className="action-card-footer"><span className="action-timestamp">{action.timestamp}</span><span>{action.status}</span></div>
              </div>
            )) : (
              <div className="panel-empty-placeholder">
                <Bot size={28} strokeWidth={1.3} />
                <p>暂无真实执行记录</p>
              </div>
            )}
          </div>
        ) : (
          <div className="cockpit-plan-view">
            <div className="plan-goal-card"><span className="goal-label">当前目标</span><p className="goal-text">{plan?.goal ?? '暂无真实任务计划'}</p></div>
            {plan && <div className="plan-steps-list">{plan.steps.map(step => <div key={step.id} className={`step-item ${step.status}`}><span className="step-text">{step.text}</span><span className="step-status-tag">{step.status}</span></div>)}</div>}
          </div>
        )}
      </div>

      {observed && (
        <div className="cockpit-footer">
          {onSendInstruction && (
            <form className="cockpit-prompt-form" onSubmit={event => {
              event.preventDefault();
              if (instruction.trim()) {
                void onSendInstruction(instruction);
                setInstruction('');
              }
            }}>
              <div className="prompt-input-row">
                <input className="cockpit-input" aria-label="Agent 补充指令" placeholder="输入补充指令" value={instruction} onChange={event => setInstruction(event.target.value)} />
                <button type="submit" className="primary-button-sm" disabled={!instruction.trim()} aria-label="发送 Agent 指令"><Send size={13} /></button>
              </div>
            </form>
          )}
          {onTogglePause && (
            <button type="button" className="secondary-button-xs" onClick={() => void onTogglePause()}><Square size={11} />暂停调度</button>
          )}
          {!onSendInstruction && !onTogglePause && <p className="mono-subtle">{unavailableReason}</p>}
        </div>
      )}
    </aside>
  );
}
