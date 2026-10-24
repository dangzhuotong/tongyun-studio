import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { Project, Workspace } from '../contracts';
import App from '../App';

const project: Project = { id: 'live-proj', name: 'Live Proj', path: '/code/live-proj', createdAt: '2026-10-23' };

vi.mock('../bridge', async importOriginal => {
  const actual = await importOriginal<typeof import('../bridge')>();
  return {
    ...actual,
    isDesktop: true,
    loadWorkspace: vi.fn(async (): Promise<Workspace> => ({ version: 1, projects: [project], activeProjectId: 'live-proj' })),
    inspectProject: vi.fn(async () => ({
      exists: true,
      git: { isRepository: false, branch: null, head: null, changedFiles: 0, recentCommits: [], error: null },
      httpFiles: 0,
      httpFilePaths: [],
      techStack: [],
      scripts: [],
      dbArtifacts: [],
    })),
    detectListeningPorts: vi.fn(async () => [
      { port: 5173, process: 'vite' },
      { port: 3000, process: 'node' },
    ]),
    listProjectServices: vi.fn(async () => []),
    openUrl: vi.fn(async () => {}),
    readProjectFileContent: vi.fn(async (_id: string, path: string) => {
      if (path === '.tongyun/agent-session.json') {
        return JSON.stringify({
          agentName: 'Agy Worker',
          model: 'Claude 3.7 Sonnet',
          mode: 'autonomous',
          lastHeartbeat: '18:30:00',
          tokensConsumed: 4500,
          filesTouched: 3,
          plan: {
            id: 'plan-real',
            goal: '端到端全链路工程交付',
            status: 'executing',
            progressPercent: 75,
            steps: [{ id: 's1', text: '单元测试跑通', status: 'done' }],
          },
          actions: [
            { id: 'a1', kind: 'terminal', title: 'cargo test --offline', detail: 'All 17 tests passed', status: 'done', timestamp: '18:29:50' },
          ],
        });
      }
      throw new Error('File not found');
    }),
  };
});

describe('Real Agent Session Ingestion & Monitoring', () => {
  it('reads .tongyun/agent-session.json and reflects truthful connected state', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getAllByText('Live Proj').length).toBeGreaterThan(0);
    });

    // Switch to agent tab via rail button
    const agentTabBtn = screen.getAllByRole('button', { name: '智能体视界' })[0];
    fireEvent.click(agentTabBtn);

    await waitFor(() => {
      expect(screen.getByText('Agy Worker')).toBeInTheDocument();
      expect(screen.getByText('模型：Claude 3.7 Sonnet')).toBeInTheDocument();
      expect(screen.getByText('端到端全链路工程交付')).toBeInTheDocument();
      expect(screen.getByText('All 17 tests passed')).toBeInTheDocument();
      expect(screen.getByText('75%')).toBeInTheDocument();
      expect(screen.getByText('已读取本地快照')).toBeInTheDocument();
      expect(screen.getByRole('button', {name: '暂停'})).toBeDisabled();
      expect(screen.getByRole('button', {name: '投递指令'})).toBeDisabled();
      expect(screen.getByRole('textbox', {name: 'Agent 补充指令'})).toBeDisabled();
      expect(screen.queryByRole('button', {name: /初始化跟踪模板/})).not.toBeInTheDocument();
    });
  });

  it('renders listening ports and invokes openUrl when clicked', async () => {
    const { openUrl } = await import('../bridge');
    render(<App />);
    await waitFor(() => {
      expect(screen.getAllByText('Live Proj').length).toBeGreaterThan(0);
    });

    const devTabBtn = screen.getAllByRole('button', { name: /运行服务与终端/ })[0];
    fireEvent.click(devTabBtn);

    await waitFor(() => {
      expect(screen.getByText(':5173')).toBeInTheDocument();
      expect(screen.getByText('(vite)')).toBeInTheDocument();
      expect(screen.getByText(':3000')).toBeInTheDocument();
      expect(screen.getByText('(node)')).toBeInTheDocument();
    });

    const vitePortBtn = screen.getByTitle(/在浏览器中打开 http:\/\/localhost:5173/);
    fireEvent.click(vitePortBtn);
    expect(openUrl).toHaveBeenCalledWith('http://localhost:5173');
  });
});
