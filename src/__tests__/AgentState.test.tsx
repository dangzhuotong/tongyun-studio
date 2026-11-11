import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import AgentPanel from '../features/AgentPanel';
import AgentCockpit from '../components/AgentCockpit';
import { getInitialAgentSession } from '../bridge';
import type { AgentSessionState, Project } from '../contracts';

const project: Project = { id: 'project-a', name: 'Project A', path: '/test/project-a', createdAt: '2026-10-23' };
const otherProject: Project = { ...project, id: 'project-b', name: 'Project B' };

// A synthetic event fixture verifies project isolation; it is never production data.
const priorProjectSession = (): AgentSessionState => ({
  ...getInitialAgentSession(project.id),
  connectionStatus: 'connected',
  agentName: 'prior-project-worker',
  model: 'prior-project-model',
  tokensConsumed: 123,
  filesTouched: 2,
  lastHeartbeat: 'prior-project-heartbeat',
  plan: { id: 'plan-a', goal: 'Prior project goal', status: 'executing', progressPercent: 50, steps: [] },
  actions: [{ id: 'event-a', kind: 'inspect', title: 'Prior project event', detail: 'Synthetic isolation fixture', status: 'done', timestamp: 'fixture-time' }],
});

describe('Agent observations', () => {
  it('starts with unknown telemetry and no claimed worker, plan or execution record', () => {
    const session = getInitialAgentSession(project.id);
    expect(session).toEqual({
      projectId: project.id, connectionStatus: 'not_connected',
      agentName: null, model: null, mode: null, activeGoal: null,
      plan: null, actions: [], tokensConsumed: null, filesTouched: null, lastHeartbeat: null,
    });
    expect(getInitialAgentSession().projectId).toBeNull();
  });

  it('shows a single empty state without unsupported Agent controls', () => {
    render(<AgentPanel project={project} session={getInitialAgentSession(project.id)} onNavigate={vi.fn()} />);
    expect(screen.getByText('暂无 Agent 快照')).toBeInTheDocument();
    expect(screen.getByText(/agent-session\.json/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Agent 补充指令' })).not.toBeInTheDocument();
    for (const name of ['投递指令', '暂停', '导出快照']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('hides the prior project session immediately when the full panel changes project', () => {
    const session = priorProjectSession();
    const { rerender } = render(<AgentPanel project={project} session={session} onNavigate={vi.fn()} />);
    expect(screen.getByText('Prior project event')).toBeInTheDocument();
    rerender(<AgentPanel project={otherProject} session={session} onNavigate={vi.fn()} />);
    expect(screen.getByText('暂无 Agent 快照')).toBeInTheDocument();
    expect(screen.queryByText('Prior project event')).not.toBeInTheDocument();
    expect(screen.queryByText('prior-project-worker')).not.toBeInTheDocument();
    expect(screen.queryByText('Prior project goal')).not.toBeInTheDocument();
  });

  it('protects cockpit telemetry and traces when the project changes or is removed', () => {
    const session = priorProjectSession();
    const props = { session, onNavigate: vi.fn(), onClose: vi.fn() };
    const { rerender } = render(<AgentCockpit project={project} {...props} />);
    expect(screen.getByText('Prior project event')).toBeInTheDocument();
    rerender(<AgentCockpit project={otherProject} {...props} />);
    expect(screen.getByText('暂无 Agent 快照')).toBeInTheDocument();
    expect(screen.queryByText('Prior project event')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '任务计划' })).not.toBeInTheDocument();
    for (const name of ['发送 Agent 指令', '暂停调度', '导出 Agent 快照']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    rerender(<AgentCockpit project={null} {...props} />);
    expect(screen.getByText('当前项目：未选择项目')).toBeInTheDocument();
    expect(screen.queryByText('prior-project-model')).not.toBeInTheDocument();
  });
});
