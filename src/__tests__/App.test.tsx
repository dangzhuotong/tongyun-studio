import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import App from '../App';
import { toolDefinitions, getTool } from '../features/tools';

describe('App', () => {
  it('renders welcome view in non-desktop mode', () => {
    render(<App />);

    expect(screen.getByText('橦云工作台')).toBeInTheDocument();
    expect(screen.getAllByText('TONGYUN STUDIO').length).toBeGreaterThan(0);
    expect(screen.getByText('把开发现场，放在一起。')).toBeInTheDocument();
    expect(screen.getByText('从一个本地目录开始')).toBeInTheDocument();
  });

  it('renders all four developer tools in overview', () => {
    render(<App />);

    expect(screen.getByText('Dev')).toBeInTheDocument();
    expect(screen.getByText('API')).toBeInTheDocument();
    expect(screen.getByText('Database')).toBeInTheDocument();
    expect(screen.getByText('Git')).toBeInTheDocument();
  });

  it('allows switching to dev panel tab', async () => {
    render(<App />);

    const nav = screen.getByRole('navigation', { name: '工作区模块' });
    const devTab = within(nav).getByRole('button', { name: /运行/ });
    fireEvent.click(devTab);

    expect(
      await screen.findByRole('heading', { name: 'Tongyun Dev · 企业级服务与终端' }),
    ).toBeInTheDocument();
    expect(screen.getByText('企业级进程控制')).toBeInTheDocument();
  });

  it('allows switching to api panel tab', async () => {
    render(<App />);

    const nav = screen.getByRole('navigation', { name: '工作区模块' });
    const apiTab = within(nav).getByRole('button', { name: /接口/ });
    fireEvent.click(apiTab);

    expect(
      await screen.findByRole('heading', { name: 'Tongyun API · 企业级接口工作台' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /导入 cURL/ })).toBeInTheDocument();
  });

  it('allows switching to database panel tab', async () => {
    render(<App />);

    const nav = screen.getByRole('navigation', { name: '工作区模块' });
    const dbTab = within(nav).getByRole('button', { name: /数据/ });
    fireEvent.click(dbTab);

    expect(
      await screen.findByRole('heading', { name: 'Tongyun Database · 企业级数据工作台' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /导出 CSV/ })).toBeInTheDocument();
  });

  it('allows switching to git panel tab', async () => {
    render(<App />);

    const nav = screen.getByRole('navigation', { name: '工作区模块' });
    const gitTab = within(nav).getByRole('button', { name: /版本/ });
    fireEvent.click(gitTab);

    expect(
      await screen.findByRole('heading', { name: 'Tongyun Git · 企业级版本工作台' }),
    ).toBeInTheDocument();
    expect(screen.getByText('双栏暂存工作流')).toBeInTheDocument();
  });

  it('allows switching to files panel tab', async () => {
    render(<App />);

    const nav = screen.getByRole('navigation', { name: '工作区模块' });
    const filesTab = within(nav).getByRole('button', { name: /文件/ });
    fireEvent.click(filesTab);

    expect(
      await screen.findByRole('heading', { name: 'Tongyun Files · 项目文件与源码' }),
    ).toBeInTheDocument();
    expect(screen.getByText('原生文件浏览')).toBeInTheDocument();
  });

  it('shows the disconnected Agent state instead of a fabricated mission', async () => {
    render(<App />);

    const nav = screen.getByRole('navigation', { name: '工作区模块' });
    const agentTab = within(nav).getByRole('button', { name: /智能体/ });
    fireEvent.click(agentTab);

    expect(
      await screen.findByRole('heading', { name: 'Tongyun Agent · 执行记录与计划' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Agent 未接入')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导出审计轨迹' })).toBeDisabled();
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
    expect(screen.getByText('暂无真实执行记录')).toBeInTheDocument();
    expect(screen.getByText('模型：未知')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送 Agent 指令' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '暂停调度' })).toBeDisabled();
  });

  it('verifies tool definitions completeness', () => {
    expect(toolDefinitions).toHaveLength(4);
    expect(getTool('dev').name).toBe('Tongyun Dev');
    expect(getTool('api').name).toBe('Tongyun API');
    expect(getTool('database').name).toBe('Tongyun Database');
    expect(getTool('git').name).toBe('Tongyun Git');
  });
});
