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
      await screen.findByRole('heading', { name: 'Tongyun Dev · 服务与终端' }),
    ).toBeInTheDocument();
    expect(screen.getByText('原生内嵌控制台')).toBeInTheDocument();
  });

  it('allows switching to api panel tab', async () => {
    render(<App />);

    const nav = screen.getByRole('navigation', { name: '工作区模块' });
    const apiTab = within(nav).getByRole('button', { name: /接口/ });
    fireEvent.click(apiTab);

    expect(
      await screen.findByRole('heading', { name: 'Tongyun API · 原生接口工作台' }),
    ).toBeInTheDocument();
    expect(screen.getByText('原生 HTTP 客户端')).toBeInTheDocument();
  });

  it('allows switching to database panel tab', async () => {
    render(<App />);

    const nav = screen.getByRole('navigation', { name: '工作区模块' });
    const dbTab = within(nav).getByRole('button', { name: /数据/ });
    fireEvent.click(dbTab);

    expect(
      await screen.findByRole('heading', { name: 'Tongyun Database · 数据与 SQL' }),
    ).toBeInTheDocument();
    expect(screen.getByText('原生 SQLite 引擎')).toBeInTheDocument();
  });

  it('allows switching to git panel tab', async () => {
    render(<App />);

    const nav = screen.getByRole('navigation', { name: '工作区模块' });
    const gitTab = within(nav).getByRole('button', { name: /版本/ });
    fireEvent.click(gitTab);

    expect(
      await screen.findByRole('heading', { name: 'Tongyun Git · 版本工作台' }),
    ).toBeInTheDocument();
    expect(screen.getByText('原生 Git 工作流')).toBeInTheDocument();
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

  it('verifies tool definitions completeness', () => {
    expect(toolDefinitions).toHaveLength(4);
    expect(getTool('dev').name).toBe('Tongyun Dev');
    expect(getTool('api').name).toBe('Tongyun API');
    expect(getTool('database').name).toBe('Tongyun Database');
    expect(getTool('git').name).toBe('Tongyun Git');
  });
});
