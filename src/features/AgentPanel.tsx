import { useState } from 'react';
import type { AgentSessionState, Project, ActiveTab } from '../contracts';
import {
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Code2,
  Copy,
  Database,
  ExternalLink,
  GitBranch,
  LoaderCircle,
  Play,
  Send,
  Square,
  Terminal,
  Workflow,
  Zap,
} from '../components/Icons';

interface AgentPanelProps {
  project: Project | null;
  session: AgentSessionState;
  onNavigate: (tab: ActiveTab) => void;
  onDispatchPrompt: (prompt: string) => void;
  onTogglePause: () => void;
  onNotify?: (msg: string) => void;
}

export default function AgentPanel({
  project,
  session,
  onNavigate,
  onDispatchPrompt,
  onTogglePause,
  onNotify,
}: AgentPanelProps) {
  const [promptInput, setPromptInput] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedTrace, setCopiedTrace] = useState(false);
  const [filterKind, setFilterKind] = useState<string>('all');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!promptInput.trim()) return;
    onDispatchPrompt(promptInput.trim());
    setPromptInput('');
    onNotify?.('已向 Agent 投递新指示');
  };

  const copyTrace = () => {
    navigator.clipboard.writeText(JSON.stringify(session, null, 2));
    setCopiedTrace(true);
    onNotify?.('已复制完整 Agent 审计轨迹');
    setTimeout(() => setCopiedTrace(false), 2000);
  };

  const filteredActions = session.actions.filter(act => {
    if (filterKind === 'all') return true;
    return act.kind === filterKind;
  });

  const mapKindToTab = (kind: string): ActiveTab => {
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
    <div className="feature-panel-layout" aria-labelledby="agent-panel-title">
      {/* Workbench Header */}
      <div className="workbench-header">
        <div className="workbench-title-group">
          <div className="large-tool-icon">
            <Bot size={22} strokeWidth={1.5} />
          </div>
          <div>
            <h2 id="agent-panel-title">Tongyun Agent · 智能体全景视界与调度中枢</h2>
            <p>面向未来的 Agent 优先开发范式：原子工具调用轨迹、目标与计划多步编排、人机协同双向干预。</p>
          </div>
        </div>
        <div className="workbench-badges">
          <span className="badge-matcha">
            <span className="agent-pulse-dot" />
            <span>Agent 在线协同</span>
          </span>
          <button className="secondary-button-sm" onClick={copyTrace} title="复制 JSON 审计报告">
            {copiedTrace ? <Check size={12} className="accent-color" /> : <Copy size={12} />}
            <span>导出审计轨迹</span>
          </button>
        </div>
      </div>

      {!project ? (
        <div className="panel-empty-placeholder">
          <Bot size={32} strokeWidth={1.2} />
          <p>请先在左侧选择或添加一个项目，以开启 Agent 协同与行为流监视。</p>
        </div>
      ) : (
        <div className="agent-full-grid">
          {/* Top Macro HUD Bar */}
          <div className="agent-overview-bar">
            <div className="agent-id-card">
              <div className="agent-avatar-lg">
                <Bot size={24} className="accent-color" />
              </div>
              <div>
                <div className="agent-name-row">
                  <span className="agent-id-name">{session.agentName}</span>
                  <span className="mini-badge">{session.model}</span>
                </div>
                <div className="agent-meta-row">
                  <span className="meta">当前目标: {session.plan.goal}</span>
                </div>
              </div>
            </div>

            <div className="agent-metrics-trio">
              <div className="metric-box">
                <span className="metric-num accent-color">{session.plan.progressPercent}%</span>
                <span className="metric-label">计划进度</span>
              </div>
              <div className="metric-box">
                <span className="metric-num">{session.actions.length}</span>
                <span className="metric-label">工具调用总数</span>
              </div>
              <div className="metric-box">
                <span className="metric-num">{(session.tokensConsumed / 1000).toFixed(1)}k</span>
                <span className="metric-label">上下文 Tokens</span>
              </div>
              <div className="metric-box">
                <span className="metric-num">{session.filesTouched}</span>
                <span className="metric-label">涉及文件</span>
              </div>
            </div>
          </div>

          <div className="agent-dashboard-split">
            {/* Left Column: Plan Steps Checklist & Capability matrix */}
            <div className="agent-col-plan">
              <div className="subpanel-card">
                <div className="subpanel-header">
                  <Workflow size={14} className="accent-color" />
                  <span className="subpanel-title">步骤计划编排 ({session.plan.steps.length})</span>
                </div>
                <div className="plan-progress-track">
                  <div
                    className="plan-progress-fill"
                    style={{ width: `${session.plan.progressPercent}%` }}
                  />
                </div>
                <div className="agent-plan-step-items">
                  {session.plan.steps.map((step, idx) => (
                    <div key={step.id} className={`agent-step-row ${step.status}`}>
                      <div className="step-badge">
                        {step.status === 'done' ? (
                          <CheckCircle2 size={15} className="accent-color" />
                        ) : step.status === 'active' ? (
                          <LoaderCircle size={15} className="spin accent-color" />
                        ) : (
                          <span className="mono-subtle">{idx + 1}</span>
                        )}
                      </div>
                      <div className="step-body">
                        <span className="step-text">{step.text}</span>
                        <span className="step-tag">
                          {step.status === 'done'
                            ? '已完成'
                            : step.status === 'active'
                              ? '正在执行'
                              : '待触发'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Tool matrix badges */}
              <div className="subpanel-card">
                <div className="subpanel-header">
                  <Zap size={14} className="accent-color" />
                  <span className="subpanel-title">已绑定的原子工具能力</span>
                </div>
                <div className="tool-matrix-grid">
                  <div className="matrix-tile" onClick={() => onNavigate('dev')}>
                    <Terminal size={14} />
                    <span>Dev 进程终端</span>
                  </div>
                  <div className="matrix-tile" onClick={() => onNavigate('git')}>
                    <GitBranch size={14} />
                    <span>Git 版本控制</span>
                  </div>
                  <div className="matrix-tile" onClick={() => onNavigate('api')}>
                    <Code2 size={14} />
                    <span>API 接口调试</span>
                  </div>
                  <div className="matrix-tile" onClick={() => onNavigate('database')}>
                    <Database size={14} />
                    <span>Database SQLite</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Right Column: Visualized Action Stream with Filters */}
            <div className="agent-col-stream">
              <div className="subpanel-card stream-full-height">
                <div className="subpanel-header-with-filters">
                  <div className="subpanel-title-group">
                    <Zap size={14} className="accent-color" />
                    <span className="subpanel-title">原子操作执行全景流</span>
                  </div>

                  <div className="filter-chips">
                    {['all', 'terminal', 'git', 'edit', 'inspect'].map(f => (
                      <button
                        key={f}
                        className={`filter-chip ${filterKind === f ? 'active' : ''}`}
                        onClick={() => setFilterKind(f)}
                      >
                        {f === 'all'
                          ? '全部'
                          : f === 'terminal'
                            ? '终端'
                            : f === 'git'
                              ? 'Git'
                              : f === 'edit'
                                ? '修改'
                                : '巡检'}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="agent-actions-scroll">
                  {filteredActions.slice().reverse().map(act => {
                    const isExpanded = expandedId === act.id;
                    const navTab = mapKindToTab(act.kind);

                    return (
                      <div key={act.id} className={`action-card-full ${act.status}`}>
                        <div
                          className="action-card-head"
                          onClick={() => setExpandedId(isExpanded ? null : act.id)}
                        >
                          <div className="action-type-pill">
                            {act.kind.toUpperCase()}
                          </div>
                          <div className="action-main-info">
                            <div className="action-line-1">
                              <span className="action-title-text">{act.title}</span>
                              {act.durationMs && (
                                <span className="action-dur">
                                  <Clock size={11} /> {act.durationMs}ms
                                </span>
                              )}
                            </div>
                            <div className="action-detail-text mono-subtle">{act.detail}</div>
                          </div>
                          <div className="action-right-tools">
                            <button
                              className="jump-pill"
                              onClick={(e) => {
                                e.stopPropagation();
                                onNavigate(navTab);
                                onNotify?.(`已在工作台跳转至 [${navTab.toUpperCase()}]`);
                              }}
                              title={`在工作台聚焦查看 ${navTab}`}
                            >
                              <ExternalLink size={11} />
                              <span>聚焦</span>
                            </button>
                            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </div>
                        </div>

                        {act.target && (
                          <div className="action-target-row">
                            <span className="meta">涉及目标: </span>
                            <code>{act.target}</code>
                          </div>
                        )}

                        {isExpanded && act.outputPreview && (
                          <div className="action-output-expanded">
                            <div className="output-tag">操作回显快照:</div>
                            <pre className="output-body">{act.outputPreview}</pre>
                          </div>
                        )}

                        <div className="action-card-foot">
                          <span className="mono-subtle">{act.timestamp}</span>
                          <span className={`status-pill ${act.status}`}>
                            {act.status === 'done'
                              ? '✓ 已完成'
                              : act.status === 'running'
                                ? '⚡ 执行中'
                                : '待执行'}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Prompt Intervention Form */}
                <form className="agent-prompt-bar" onSubmit={handleSubmit}>
                  <input
                    type="text"
                    className="agent-prompt-input"
                    placeholder="给 Agent 投递补充说明、指令干预或调整任务方向..."
                    value={promptInput}
                    onChange={(e) => setPromptInput(e.target.value)}
                  />
                  <button
                    type="submit"
                    className="primary-button"
                    disabled={!promptInput.trim()}
                  >
                    <Send size={13} />
                    <span>投递指令</span>
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={onTogglePause}
                    title={session.plan.status === 'paused' ? '恢复 Agent 调度' : '暂停 Agent 调度'}
                  >
                    {session.plan.status === 'paused' ? <Play size={13} /> : <Square size={13} />}
                    <span>{session.plan.status === 'paused' ? '恢复' : '暂停'}</span>
                  </button>
                </form>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
