import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import App from '../App';
import { toolDefinitions, getTool } from '../features/tools';

describe('App', () => {
  it('renders welcome view in non-desktop mode', () => {
    render(<App />);

    expect(screen.getByText('橦云工作台')).toBeInTheDocument();
    expect(screen.getAllByText('TONGYUN STUDIO').length).toBeGreaterThan(0);
    expect(screen.getByText('打开本地项目')).toBeInTheDocument();
    expect(screen.getByText('从一个本地目录开始')).toBeInTheDocument();
  });

  it('renders all four developer tools in overview', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: '运行' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '接口' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '数据' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '版本' })).toBeInTheDocument();
  });

  it('allows switching to dev panel tab', async () => {
    render(<App />);

    const nav = screen.getByRole('navigation', { name: '工作区模块' });
    const devTab = within(nav).getByRole('button', { name: /运行/ });
    fireEvent.click(devTab);

    expect(
      await screen.findByRole('heading', { name: '运行' }),
    ).toBeInTheDocument();
    expect(screen.getByText('扫描并登记项目')).toBeInTheDocument();
  });

  it('allows switching to api panel tab', async () => {
    render(<App />);

    const nav = screen.getByRole('navigation', { name: '工作区模块' });
    const apiTab = within(nav).getByRole('button', { name: /接口/ });
    fireEvent.click(apiTab);

    expect(
      await screen.findByRole('heading', { name: '接口' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/请选择|请先在左侧选择/)).toBeInTheDocument();
  });

  it('allows switching to database panel tab', async () => {
    render(<App />);

    const nav = screen.getByRole('navigation', { name: '工作区模块' });
    const dbTab = within(nav).getByRole('button', { name: /数据/ });
    fireEvent.click(dbTab);

    expect(
      await screen.findByRole('heading', { name: '数据' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /导出 CSV/ })).toBeInTheDocument();
  });

  it('allows switching to git panel tab', async () => {
    render(<App />);

    const nav = screen.getByRole('navigation', { name: '工作区模块' });
    const gitTab = within(nav).getByRole('button', { name: /版本/ });
    fireEvent.click(gitTab);

    expect(
      await screen.findByRole('heading', { name: '版本' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/以管理代码版本/)).toBeInTheDocument();
  });

  it('allows switching to files panel tab', async () => {
    render(<App />);

    const nav = screen.getByRole('navigation', { name: '工作区模块' });
    const filesTab = within(nav).getByRole('button', { name: /文件/ });
    fireEvent.click(filesTab);

    expect(
      await screen.findByRole('heading', { name: '文件' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/以浏览其内部文件/)).toBeInTheDocument();
  });

  it('shows the disconnected Agent state instead of a fabricated mission', async () => {
    render(<App />);

    const nav = screen.getByRole('navigation', { name: '工作区模块' });
    const agentTab = within(nav).getByRole('button', { name: /智能体/ });
    fireEvent.click(agentTab);

    expect(
      await screen.findByRole('heading', { name: '智能体' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Agent 未接入')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '导出快照' })).not.toBeInTheDocument();
    expect(screen.queryByText('Agent 在线协同')).not.toBeInTheDocument();
  });

  it('allows toggling secondary sidebar and agent cockpit', async () => {
    render(<App />);

    const sidebarToggle = screen.getByTitle(/收起侧边栏/);
    fireEvent.click(sidebarToggle);
    expect(screen.getByTitle(/展开侧边栏/)).toBeInTheDocument();

    const agentCockpitBtn = screen.getByTitle(/切换 Agent 监视舱/);
    fireEvent.click(agentCockpitBtn);
    expect(screen.getByText('Agent 操作监视舱')).toBeInTheDocument();
    expect(screen.getByText('选择一个项目查看 Agent 快照')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '发送 Agent 指令' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '暂停调度' })).not.toBeInTheDocument();
  });

  it('verifies tool definitions completeness', () => {
    expect(toolDefinitions).toHaveLength(4);
    expect(getTool('dev').name).toBe('Tongyun Dev');
    expect(getTool('api').name).toBe('Tongyun API');
    expect(getTool('database').name).toBe('Tongyun Database');
    expect(getTool('git').name).toBe('Tongyun Git');
  });
});
