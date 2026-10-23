import { useState } from 'react';
import type { AgentSessionState, AgentActionStep, ActiveTab } from '../contracts';
import {
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Database,
  ExternalLink,
  Eye,
  FileCode,
  GitBranch,
  Globe,
  LoaderCircle,
  Play,
  Send,
  Square,
  Terminal,
  Workflow,
  X,
  Zap,
} from './Icons';

interface AgentCockpitProps {
  session: AgentSessionState;
  onClose: () => void;
  onNavigate: (tab: ActiveTab) => void;
  onDispatchPrompt: (prompt: string) => void;
  onTogglePause: () => void;
  onNotify?: (msg: string) => void;
}

export default function AgentCockpit({
  session,
  onClose,
  onNavigate,
  onDispatchPrompt,
  onTogglePause,
  onNotify,
}: AgentCockpitProps) {
  const [promptInput, setPromptInput] = useState('');
  const [expandedActionId, setExpandedActionId] = useState<string | null>(null);
  const [activeSubTab, setActiveSubTab] = useState<'stream' | 'plan' | 'telemetry'>('stream');
  const [copiedTrace, setCopiedTrace] = useState(false);

  const handleSubmitPrompt = (e: React.FormEvent) => {
    e.preventDefault();
    if (!promptInput.trim()) return;
    onDispatchPrompt(promptInput.trim());
    setPromptInput('');
    onNotify?.('已向 Agent 投递补充指示');
  };

  const copyTrace = () => {
    const traceJson = JSON.stringify(session, null, 2);
    navigator.clipboard.writeText(traceJson);
    setCopiedTrace(true);
    onNotify?.('已复制 Agent 操作审计轨迹');
    setTimeout(() => setCopiedTrace(false), 2000);
  };

  const getActionIcon = (kind: AgentActionStep['kind']) => {
    switch (kind) {
      case 'terminal':
        return <Terminal size={14} className="accent-color" />;
      case 'edit':
        return <FileCode size={14} style={{ color: 'var(--ty-sky)' }} />;
      case 'git':
        return <GitBranch size={14} style={{ color: 'var(--ty-honey)' }} />;
      case 'sql':
        return <Database size={14} style={{ color: 'var(--ty-peach)' }} />;
      case 'http':
        return <Globe size={14} style={{ color: 'var(--ty-matcha)' }} />;
      case 'plan':
        return <Workflow size={14} className="accent-color" />;
      default:
        return <Eye size={14} />;
    }
  };

  const mapActionToTab = (kind: AgentActionStep['kind']): ActiveTab => {
    switch (kind) {
      case 'terminal':
        return 'dev';
      case 'git':
        return 'git';
      case 'http':
        return 'api';
      case 'sql':
        return 'database';
      case 'edit':
        return 'files';
      default:
        return 'overview';
    }
  };

  return (
    <aside className="agent-cockpit-pane" aria-label="Agent 操作可视化监视舱">
      {/* Cockpit Header */}
      <div className="cockpit-header">
        <div className="cockpit-brand-row">
          <div className="cockpit-badge-group">
            <span className="agent-pulse-dot" />
            <span className="cockpit-title">Agent 操作监视舱</span>
          </div>
          <div className="cockpit-controls">
            <button
              className="icon-button-sm"
              onClick={copyTrace}
              title="导出当前 Agent 操作轨迹 (JSON)"
            >
              {copiedTrace ? <Check size={13} className="accent-color" /> : <Copy size={13} />}
            </button>
            <button
              className="icon-button-sm"
              onClick={onClose}
              title="收起监视舱 (⌘J)"
              aria-label="关闭 Agent 监视舱"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Telemetry HUD Mini Card */}
        <div className="agent-hud-card">
          <div className="hud-identity">
            <div className="hud-avatar">
              <Bot size={16} strokeWidth={1.6} />
            </div>
            <div className="hud-info">
              <span className="hud-name">{session.agentName}</span>
              <span className="hud-model">{session.model}</span>
            </div>
            <span className={`hud-mode-pill ${session.mode}`}>
              {session.mode === 'collaborative'
                ? '协同伴写'
                : session.mode === 'autonomous'
                  ? '全自动驱动'
                  : '观察者'}
            </span>
          </div>

          <div className="hud-stats-row">
            <div className="hud-stat-item">
              <span className="hud-stat-val">{session.actions.length}</span>
              <span className="hud-stat-label">原子操作</span>
            </div>
            <div className="hud-stat-item">
              <span className="hud-stat-val">{session.filesTouched}</span>
              <span className="hud-stat-label">涉及文件</span>
            </div>
            <div className="hud-stat-item">
              <span className="hud-stat-val">{(session.tokensConsumed / 1000).toFixed(1)}k</span>
              <span className="hud-stat-label">Token 上下文</span>
            </div>
            <div className="hud-stat-item">
              <span className="hud-stat-val accent-color">{session.plan.progressPercent}%</span>
              <span className="hud-stat-label">目标进度</span>
            </div>
          </div>
        </div>

        {/* View Switcher Tabs */}
        <div className="cockpit-subtabs">
          <button
            className={`cockpit-tab-btn ${activeSubTab === 'stream' ? 'active' : ''}`}
            onClick={() => setActiveSubTab('stream')}
          >
            <Zap size={12} />
            实时行为流 ({session.actions.length})
          </button>
          <button
            className={`cockpit-tab-btn ${activeSubTab === 'plan' ? 'active' : ''}`}
            onClick={() => setActiveSubTab('plan')}
          >
            <Workflow size={12} />
            多步计划 ({session.plan.steps.length})
          </button>
        </div>
      </div>

      {/* Main Cockpit Content Area */}
      <div className="cockpit-body">
        {activeSubTab === 'stream' && (
          <div className="action-stream-list">
            <div className="stream-section-lead">
              <span>实时执行轨迹 (倒序流式)</span>
              <span className="mono-subtle">最近活动: {session.lastHeartbeat}</span>
            </div>

            {session.actions.slice().reverse().map(act => {
              const isExpanded = expandedActionId === act.id;
              const targetTab = mapActionToTab(act.kind);

              return (
                <div key={act.id} className={`action-card ${act.status}`}>
                  <div
                    className="action-card-header"
                    onClick={() => setExpandedActionId(isExpanded ? null : act.id)}
                  >
                    <div className="action-type-icon">{getActionIcon(act.kind)}</div>
                    <div className="action-card-meta">
                      <div className="action-card-title-row">
                        <span className="action-title">{act.title}</span>
                        {act.durationMs && (
                          <span className="action-duration">
                            <Clock size={11} />
                            {act.durationMs}ms
                          </span>
                        )}
                      </div>
                      <div className="action-detail mono-subtle">{act.detail}</div>
                    </div>
                    <div className="action-card-expand">
                      {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    </div>
                  </div>

                  {act.target && (
                    <div className="action-target-badge">
                      <span>目标: </span>
                      <code>{act.target}</code>
                    </div>
                  )}

                  {isExpanded && act.outputPreview && (
                    <div className="action-preview-box">
                      <div className="preview-label">执行快照输出:</div>
                      <pre className="preview-code">{act.outputPreview}</pre>
                    </div>
                  )}

                  <div className="action-card-footer">
                    <span className="action-timestamp">{act.timestamp}</span>
                    <button
                      className="cockpit-jump-button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onNavigate(targetTab);
                        onNotify?.(`已在主工作台定位到 [${targetTab.toUpperCase()}] 面板`);
                      }}
                      title={`在工作台聚焦该操作对应的 ${targetTab} 视图`}
                    >
                      <ExternalLink size={11} />
                      在工作台聚焦
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {activeSubTab === 'plan' && (
          <div className="cockpit-plan-view">
            <div className="plan-goal-card">
              <span className="goal-label">当前宏观目标</span>
              <p className="goal-text">{session.plan.goal}</p>
              <div className="plan-progress-track">
                <div
                  className="plan-progress-fill"
                  style={{ width: `${session.plan.progressPercent}%` }}
                />
              </div>
            </div>

            <div className="plan-steps-list">
              <span className="steps-header">计划步骤拆解与执行状态</span>
              {session.plan.steps.map((st, idx) => (
                <div key={st.id} className={`step-item ${st.status}`}>
                  <div className="step-indicator">
                    {st.status === 'done' ? (
                      <CheckCircle2 size={15} className="accent-color" />
                    ) : st.status === 'active' ? (
                      <LoaderCircle size={15} className="spin accent-color" />
                    ) : (
                      <span className="step-index-dot">{idx + 1}</span>
                    )}
                  </div>
                  <div className="step-content">
                    <span className="step-text">{st.text}</span>
                    <span className="step-status-tag">
                      {st.status === 'done'
                        ? '已完成'
                        : st.status === 'active'
                          ? '正在执行'
                          : '待触发'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Cockpit Human Intervention Footer */}
      <div className="cockpit-footer">
        <form className="cockpit-prompt-form" onSubmit={handleSubmitPrompt}>
          <div className="prompt-input-row">
            <input
              type="text"
              placeholder="向 Agent 发出指引或干预操作..."
              value={promptInput}
              onChange={(e) => setPromptInput(e.target.value)}
              className="cockpit-input"
            />
            <button
              type="submit"
              className="primary-button-sm"
              disabled={!promptInput.trim()}
              title="发送指示"
            >
              <Send size={13} />
            </button>
          </div>
        </form>
        <div className="cockpit-actions-bar">
          <button
            className="secondary-button-xs"
            onClick={onTogglePause}
            title={session.plan.status === 'paused' ? '恢复 Agent 运行' : '暂停 Agent 运行'}
          >
            {session.plan.status === 'paused' ? <Play size={11} /> : <Square size={11} />}
            <span>{session.plan.status === 'paused' ? '恢复执行' : '暂停调度'}</span>
          </button>
          <span className="footer-meta-tag">⚡ 实时人机双向通讯中</span>
        </div>
      </div>
    </aside>
  );
}
