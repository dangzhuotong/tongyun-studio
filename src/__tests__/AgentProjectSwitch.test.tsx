import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import type { Project, Workspace } from '../contracts';
import App from '../App';
import { getInitialAgentSession } from '../bridge';

const { projects } = vi.hoisted(() => ({ projects: [
  { id: 'alpha', name: 'Alpha', path: '/test/alpha', createdAt: '2026-10-23' },
  { id: 'beta', name: 'Beta', path: '/test/beta', createdAt: '2026-10-23' },
] as Project[] }));

vi.mock('../bridge', async importOriginal => {
  const actual = await importOriginal<typeof import('../bridge')>();
  return {
    ...actual,
    isDesktop: true,
    getInitialAgentSession: vi.fn(actual.getInitialAgentSession),
    loadWorkspace: vi.fn(async (): Promise<Workspace> => ({ version: 1, projects, activeProjectId: 'alpha' })),
    selectProject: vi.fn(async (id: string): Promise<Workspace> => ({ version: 1, projects, activeProjectId: id })),
    inspectProject: vi.fn(async () => ({
      exists: true, git: { isRepository: false, branch: null, head: null, changedFiles: 0, recentCommits: [], error: null },
      httpFiles: 0, httpFilePaths: [], techStack: [], scripts: [], dbArtifacts: [],
    })),
  };
});

describe('Agent session project binding', () => {
  it('binds the disconnected session to each selected project without creating activity', async () => {
    render(<App />);
    const alpha = await screen.findByRole('button', { name: /Alpha/ });
    expect(alpha).toHaveAttribute('aria-current', 'true');
    fireEvent.click(screen.getByTitle(/切换 Agent 监视舱/));
    const cockpit = screen.getByRole('complementary', { name: 'Agent 操作可视化监视舱' });
    expect(within(cockpit).getByText('当前项目：Alpha')).toBeInTheDocument();
    expect(getInitialAgentSession).toHaveBeenCalledWith('alpha');

    fireEvent.click(screen.getByRole('button', { name: /Beta/ }));
    expect(await within(cockpit).findByText('当前项目：Beta')).toBeInTheDocument();
    await waitFor(() => expect(getInitialAgentSession).toHaveBeenCalledWith('beta'));
    expect(within(cockpit).queryByText('当前项目：Alpha')).not.toBeInTheDocument();
    expect(within(cockpit).getByText('暂无 Agent 快照')).toBeInTheDocument();
    expect(within(cockpit).queryByRole('button', { name: '暂停调度' })).not.toBeInTheDocument();
  });
});
