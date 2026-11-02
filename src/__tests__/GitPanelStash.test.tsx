import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import GitPanel from '../features/GitPanel';
import type { Project, ProjectInspection } from '../contracts';

// vi.mock is hoisted above module bindings, so the stash spies must come from vi.hoisted.
const stash = vi.hoisted(() => ({
  list: vi.fn(async () => [
    { index: 0, reference: 'stash@{0}', message: 'WIP on main: 前端改造', date: '2026-11-03 01:00:00 +0800' },
    { index: 1, reference: 'stash@{1}', message: 'On main: 贮藏当前改动', date: '2026-11-02 20:00:00 +0800' },
  ]),
  push: vi.fn(async () => '已贮藏：改造未完成'),
  apply: vi.fn(async () => '已应用 stash@{1}（贮藏仍保留）'),
  pop: vi.fn(async () => '已弹出 stash@{1} 并恢复改动'),
  drop: vi.fn(async () => '已删除 stash@{1}'),
  discard: vi.fn(async () => '已丢弃修改'),
}));

const diffSample = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,4 +20,5 @@ function keep()',
  ' context one',
  '-removed line',
  '+added line',
  '+added line two',
  ' context two',
  '@@ -40 +50 @@',
  ' lone context',
].join('\n');

vi.mock('../bridge', () => ({
  isDesktop: true,
  getGitBranches: vi.fn(async () => ['main']),
  getGitChangedFiles: vi.fn(async () => [
    { path: 'src/a.ts', status: 'M', staged: false },
    { path: 'src/b.ts', status: 'M', staged: true },
  ]),
  getGitDiff: vi.fn(async () => diffSample),
  createGitCommit: vi.fn(async () => 'abc1234'),
  gitCommitAmend: vi.fn(async () => 'abc1234'),
  switchGitBranch: vi.fn(async () => '已切换至分支 main'),
  gitStageFile: vi.fn(async () => '已暂存'),
  gitUnstageFile: vi.fn(async () => '已取消暂存'),
  gitStageAll: vi.fn(async () => '已全部暂存'),
  gitUnstageAll: vi.fn(async () => '已取消全部暂存'),
  gitDiscardFile: stash.discard,
  gitCreateBranch: vi.fn(async () => '已新建分支'),
  gitRemoteSync: vi.fn(async () => 'Fetch 成功'),
  gitStashList: stash.list,
  gitStashPush: stash.push,
  gitStashApply: stash.apply,
  gitStashPop: stash.pop,
  gitStashDrop: stash.drop,
}));

const project: Project = {
  id: 'p1',
  name: 'demo',
  path: '/synthetic/demo',
  createdAt: '',
};

const inspection: ProjectInspection = {
  exists: true,
  git: {
    isRepository: true,
    branch: 'main',
    head: 'abc1234',
    changedFiles: 2,
    recentCommits: [],
    error: null,
  },
  httpFiles: 0,
  httpFilePaths: [],
  techStack: ['TypeScript'],
  scripts: [],
  dbArtifacts: [],
};

const renderPanel = (onNotify = vi.fn()) => {
  render(<GitPanel project={project} inspection={inspection} onNotify={onNotify} />);
  return onNotify;
};

beforeEach(() => {
  stash.list.mockClear();
  stash.push.mockClear();
  stash.apply.mockClear();
  stash.pop.mockClear();
  stash.drop.mockClear();
  stash.discard.mockClear();
});

describe('GitPanel diff gutter', () => {
  it('renders per-hunk separators with old/new line numbers', async () => {
    renderPanel();

    const blocks = await screen.findAllByText(/^@@ /);
    expect(blocks).toHaveLength(2);

    const hunks = document.querySelectorAll('.diff-hunk-block');
    expect(hunks).toHaveLength(2);
    expect(hunks[0].querySelector('.diff-hunk-stats')?.textContent).toBe('+2 −1');

    const gutters = Array.from(hunks[0].querySelectorAll('.diff-line')) as HTMLElement[];
    const readGutter = (needle: string) => {
      const row = gutters.find(el => el.querySelector('.diff-line-content')?.textContent === needle)!;
      return Array.from(row.querySelectorAll('.diff-ln')).map(el => el.textContent);
    };
    expect(readGutter(' context one')).toEqual(['10', '20']);
    expect(readGutter('-removed line')).toEqual(['11', '']);
    expect(readGutter('+added line')).toEqual(['', '21']);
    expect(readGutter('+added line two')).toEqual(['', '22']);
    expect(readGutter(' context two')).toEqual(['12', '23']);
    expect(Array.from(hunks[1].querySelectorAll('.diff-ln')).map(el => el.textContent)).toEqual(['40', '50']);
  });

  it('shows the selected file stats in the diff header', async () => {
    renderPanel();
    const header = await screen.findByText(/^差异对比：/);
    // The viewer auto-selects the first changed file, so the header reflects that single diff.
    expect(header.parentElement?.textContent).toContain('+2 −1');
  });
});

describe('GitPanel stash manager', () => {
  it('loads and lists stash entries when the panel opens', async () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: /Stash 贮藏/ }));

    await screen.findByText('stash@{1}');
    expect(stash.list).toHaveBeenCalledWith('p1');
    expect(screen.getAllByText(/WIP on main/).length).toBeGreaterThan(0);
  });

  it('pushes a stash with the typed note and untracked switch', async () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: /Stash 贮藏/ }));
    const note = await screen.findByPlaceholderText(/贮藏备注/);
    const includeUntracked = within(note.parentElement as HTMLElement).getByRole('checkbox');
    fireEvent.change(note, { target: { value: '改造未完成' } });
    fireEvent.click(includeUntracked);
    fireEvent.click(screen.getByRole('button', { name: /贮藏当前改动/ }));

    await waitFor(() => expect(stash.push).toHaveBeenCalledWith('p1', '改造未完成', false));
  });

  it('applies and pops entries through the bridge', async () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: /Stash 贮藏/ }));
    await screen.findByText('stash@{1}');
    fireEvent.click(screen.getAllByTitle('Apply（保留贮藏条目）')[1]);
    await waitFor(() => expect(stash.apply).toHaveBeenCalledWith('p1', 1));
    fireEvent.click(screen.getAllByTitle('Pop（恢复并删除条目）')[1]);
    await waitFor(() => expect(stash.pop).toHaveBeenCalledWith('p1', 1));
  });

  it('requires confirmation before dropping a stash and refreshes the list', async () => {
    const onNotify = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: /Stash 贮藏/ }));
    await screen.findByText('stash@{1}');
    fireEvent.click(screen.getAllByTitle('Drop（丢弃贮藏）')[1]);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/确定要删除 stash@\{1\} 吗？/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(stash.drop).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByTitle('Drop（丢弃贮藏）')[1]);
    const nextDialog = await screen.findByRole('dialog');
    fireEvent.click(within(nextDialog).getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(stash.drop).toHaveBeenCalledWith('p1', 1));
    // One call opened the panel, the next one refreshes the list after the drop.
    await waitFor(() => expect(stash.list.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(onNotify.mock.calls.flat().join(' ')).toContain('已删除');
  });
});

describe('GitPanel discard safety', () => {
  it('intercepts discard behind a confirm dialog and does nothing on cancel', async () => {
    renderPanel();

    fireEvent.click(await screen.findByTitle('丢弃此文件的修改'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/确定要丢弃 src\/a\.ts 的全部修改吗？/)).toBeInTheDocument();
    expect(stash.discard).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(stash.discard).not.toHaveBeenCalled();
  });

  it('discards the file once the user confirms', async () => {
    const onNotify = renderPanel();

    fireEvent.click(await screen.findByTitle('丢弃此文件的修改'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '确认丢弃' }));

    await waitFor(() => expect(stash.discard).toHaveBeenCalledWith('p1', 'src/a.ts'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onNotify.mock.calls.flat().join(' ')).toContain('已丢弃修改：src/a.ts');
  });
});
