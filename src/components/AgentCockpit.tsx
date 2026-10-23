import { useState } from 'react';
import type { AgentSessionState, ActiveTab, Project } from '../contracts';
import { Bot, Copy, Send, Square, Workflow, X, Zap } from './Icons';

interface AgentCockpitProps {
  project: Project | null;
  session: AgentSessionState;
  onClose: () => void;
  onNavigate: (tab: ActiveTab) => void;
  onNotify?: (msg: string) => void;
}

const unavailableReason = '尚未接入 Agent 调度与审计服务，无法投递指令、暂停执行或导出审计记录。';

export default function AgentCockpit({ project, session, onClose }: AgentCockpitProps) {
  const [activeSubTab, setActiveSubTab] = useState<'stream' | 'plan'>('stream');
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
            <button className="icon-button-sm" disabled title={unavailableReason} aria-label="导出 Agent 审计轨迹" aria-describedby="cockpit-unavailable">
              <Copy size={13} />
            </button>
            <button className="icon-button-sm" onClick={onClose} title="收起监视舱 (⌘J)" aria-label="关闭 Agent 监视舱">
              <X size={14} />
            </button>
          </div>
        </div>
        <div className="agent-hud-card">
          <div className="hud-identity">
            <div className="hud-avatar"><Bot size={16} strokeWidth={1.6} /></div>
            <div className="hud-info">
              <span className="hud-name">{observed?.agentName ?? '未接入 Agent'}</span>
              <span className="hud-model">模型：{observed?.model ?? '未知'}</span>
            </div>
            <span className="hud-mode-pill">{observed ? '已连接' : '未接入'}</span>
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
      </div>

      <div className="cockpit-body">
        {activeSubTab === 'stream' ? (
          <div className="action-stream-list">
            <div className="stream-section-lead"><span>已接收的执行记录</span><span className="mono-subtle">最近心跳：{observed?.lastHeartbeat ?? '未知'}</span></div>
            {observed?.actions.length ? observed.actions.slice().reverse().map(action => (
              <div key={action.id} className={`action-card ${action.status}`}>
                <div className="action-card-header"><span className="action-title">{action.title}</span></div>
                <p className="action-detail mono-subtle">{action.detail}</p>
                <div className="action-card-footer"><span className="action-timestamp">{action.timestamp}</span><span>{action.status}</span></div>
              </div>
            )) : <div className="panel-empty-placeholder"><Bot size={28} strokeWidth={1.3} /><p>暂无真实执行记录</p><span>接入真实事件来源后，才能显示工人、模型和执行过程。</span></div>}
          </div>
        ) : (
          <div className="cockpit-plan-view">
            <div className="plan-goal-card"><span className="goal-label">当前目标</span><p className="goal-text">{plan?.goal ?? '暂无真实任务计划'}</p></div>
            {plan && <div className="plan-steps-list">{plan.steps.map(step => <div key={step.id} className={`step-item ${step.status}`}><span className="step-text">{step.text}</span><span className="step-status-tag">{step.status}</span></div>)}</div>}
          </div>
        )}
      </div>

      <div className="cockpit-footer">
        <p id="cockpit-unavailable" className="mono-subtle">{unavailableReason}</p>
        <div className="cockpit-prompt-form">
          <div className="prompt-input-row">
            <input className="cockpit-input" aria-label="Agent 补充指令" placeholder="接入调度服务后可发送指令" disabled aria-describedby="cockpit-unavailable" />
            <button className="primary-button-sm" disabled title={unavailableReason} aria-label="发送 Agent 指令" aria-describedby="cockpit-unavailable"><Send size={13} /></button>
          </div>
        </div>
        <div className="cockpit-actions-bar">
          <button className="secondary-button-xs" disabled title={unavailableReason} aria-describedby="cockpit-unavailable"><Square size={11} /><span>暂停调度</span></button>
          <span className="footer-meta-tag">调度服务未接入</span>
        </div>
      </div>
    </aside>
  );
}
