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

  it('allows switching to a tool panel tab', async () => {
    render(<App />);

    const nav = screen.getByRole('navigation', { name: '工作区模块' });
    const devTab = within(nav).getByRole('button', { name: /运行/ });
    fireEvent.click(devTab);

    expect(await screen.findByRole('heading', { name: 'Tongyun Dev' })).toBeInTheDocument();
    expect(screen.getByText('尚未内嵌')).toBeInTheDocument();
    expect(screen.getByText('浏览器预览无法检测本机工具。')).toBeInTheDocument();
  });

  it('verifies tool definitions completeness', () => {
    expect(toolDefinitions).toHaveLength(4);
    expect(getTool('dev').name).toBe('Tongyun Dev');
    expect(getTool('api').name).toBe('Tongyun API');
    expect(getTool('database').name).toBe('Tongyun Database');
    expect(getTool('git').name).toBe('Tongyun Git');
  });
});
