import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DevPanel from '../features/DevPanel';
import { listProjectServices, stopProjectService } from '../bridge';
const fixture = vi.hoisted(() => ({id:'s',projectId:'p',command:'sleep 60',pid:123,status:'running',startedAt:'2026-10-23T00:00:00Z',exitCode:null,stdout:'ready',stderr:'',outputTruncated:false,lifecycle:'starting',failure:null,port:null,portOpen:false,elapsedSecs:1,logTail:'ready',readyTimeoutSecs:0,reachable:false}));
vi.mock('../bridge', () => ({
  isDesktop:true, listProjectServices:vi.fn(async () => [fixture]), detectListeningPorts:vi.fn(async () => []),
  startProjectService:vi.fn(), restartProjectService:vi.fn(), stopProjectService:vi.fn(), openUrl:vi.fn(),
  chooseProjectDirectory:vi.fn(), scanDevDirectory:vi.fn(), importDevCandidates:vi.fn(), startDevGroup:vi.fn(), stopDevGroup:vi.fn(),
  devProjectLogTail: vi.fn(async () => null),
}));
const project = {id:'p',name:'p',path:'/synthetic',createdAt:''};
describe('service state comes from the manager', () => {
  it('shows read failures instead of reporting an empty successful state', async () => {
    vi.mocked(listProjectServices).mockRejectedValueOnce(new Error('registry unavailable'));
    render(<DevPanel project={project}/>);
    expect(await screen.findByRole('alert')).toHaveTextContent('registry unavailable');
  });
  it('keeps a process visible and running when stopping fails', async () => {
    vi.mocked(stopProjectService).mockRejectedValueOnce(new Error('cannot stop process group'));
    render(<DevPanel project={project}/>);
    fireEvent.click(await screen.findByRole('button', {name:'停止'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('cannot stop process group');
    expect(screen.queryByText('已停止')).not.toBeInTheDocument();
    expect(screen.getAllByText('进程运行中').length).toBeGreaterThan(0);
  });
});
