import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import DatabasePanel from '../features/DatabasePanel';
import * as bridge from '../bridge';

import type { Project, ProjectInspection } from '../contracts';

const COLUMNS = [
  { cid: 0, name: 'id', dataType: 'INTEGER', notNull: false, dfltValue: null, pk: true, pkPosition: 1 },
  { cid: 1, name: 'label', dataType: 'TEXT', notNull: true, dfltValue: null, pk: false, pkPosition: 0 },
  { cid: 2, name: 'note', dataType: 'TEXT', notNull: false, dfltValue: null, pk: false, pkPosition: 0 },
];

const pageFor = (page: number) => ({
  columns: ['id', 'label', 'note'],
  rows: [
    [`${(page - 1) * 2 + 1}`, `row${page}a`, 'NULL'],
    [`${(page - 1) * 2 + 2}`, `row${page}b`, 'kept'],
  ],
  totalRows: 120,
  page,
  pageSize: 2,
  sortBy: null,
  sortDir: 'asc' as const,
  keyColumn: 'id',
  nextCursor: `${(page - 1) * 2 + 2}`,
  hasMore: page < 60,
});

vi.mock('../bridge', () => ({
  isDesktop: true,
  getDbTables: vi.fn(async () => [{ name: 'notes', kind: 'table' }]),
  getTableColumns: vi.fn(async () => COLUMNS),
  getTableData: vi.fn(async (_id: string, _db: string, _table: string, page: number) => pageFor(page)),
  executeSqlQuery: vi.fn(async (_id: string, _db: string, sql: string) => ({
    columns: ['echo'],
    rows: [[sql]],
    rowCount: 1,
    durationMs: 3,
    error: null,
  })),
  planRowChange: vi.fn(async () => ({
    table: 'notes',
    forwardSql: 'UPDATE "notes" SET "label" = ? WHERE "id" = 2;',
    forwardParameters: ['renamed'],
    rollbackSql: 'UPDATE "notes" SET "label" = ? WHERE "id" = 2;',
    rollbackParameters: ['row1b'],
    keyPredicate: '"id" = 2',
    changedColumns: ['label'],
  })),
  readProjectFileContent: vi.fn(async () => 'CREATE TABLE notes(id INTEGER PRIMARY KEY);'),
  openProjectFile: vi.fn(async () => {}),
}));

const mockProject: Project = {
  id: 'proj_db',
  name: 'db-demo',
  path: '/path/to/db-demo',
  createdAt: '2026-10-25T00:00:00Z',
};

const mockInspection: ProjectInspection = {
  exists: true,
  techStack: [],
  scripts: [],
  git: { isRepository: false, branch: null, head: null, changedFiles: 0, recentCommits: [], error: null },
  httpFiles: 0,
  httpFilePaths: [],
  dbArtifacts: [{ name: 'local.db', path: 'local.db', kind: 'sqlite' }],
};

const renderPanel = (onNotify = vi.fn()) => {
  render(<DatabasePanel project={mockProject} inspection={mockInspection} session={null} onNotify={onNotify} />);
  return onNotify;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:mock'),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

describe('DatabasePanel table grid', () => {
  it('pages forward with the primary-key cursor and back to the stored page', async () => {
    renderPanel();
    await screen.findByText('row1a');
    expect(bridge.getTableData).toHaveBeenCalledWith('proj_db', 'local.db', 'notes', 1, 50, {
      sortBy: null,
      sortDir: 'asc',
      cursor: null,
    });

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() =>
      expect(bridge.getTableData).toHaveBeenCalledWith('proj_db', 'local.db', 'notes', 2, 50, {
        sortBy: null,
        sortDir: 'asc',
        cursor: '2',
      }),
    );
    await screen.findByText('row2a');

    fireEvent.click(screen.getByRole('button', { name: '上一页' }));
    await waitFor(() =>
      expect(bridge.getTableData).toHaveBeenLastCalledWith('proj_db', 'local.db', 'notes', 1, 50, {
        sortBy: null,
        sortDir: 'asc',
        cursor: null,
      }),
    );
    expect(screen.getByText(/主键 id/)).toBeInTheDocument();
  });

  it('re-queries from page one when a header sort changes', async () => {
    renderPanel();
    await screen.findByText('row1a');
    fireEvent.click(screen.getByRole('button', { name: '按 label 排序' }));
    await waitFor(() =>
      expect(bridge.getTableData).toHaveBeenCalledWith('proj_db', 'local.db', 'notes', 1, 50, {
        sortBy: 'label',
        sortDir: 'asc',
        cursor: null,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '按 label 排序' }));
    await waitFor(() =>
      expect(bridge.getTableData).toHaveBeenLastCalledWith('proj_db', 'local.db', 'notes', 1, 50, {
        sortBy: 'label',
        sortDir: 'desc',
        cursor: null,
      }),
    );
  });

  it('exports the current page as CSV and JSON', async () => {
    const onNotify = renderPanel();
    await screen.findByText('row1a');
    fireEvent.click(screen.getByRole('button', { name: /导出 CSV/ }));
    fireEvent.click(screen.getByRole('button', { name: /导出 JSON/ }));
    expect(onNotify).toHaveBeenCalledWith('已导出 2 行为 CSV');
    expect(onNotify).toHaveBeenCalledWith('已导出 2 行为 JSON');
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(2);
  });

  it('refuses the row editor when the table has no single-column primary key', async () => {
    vi.mocked(bridge.getTableData).mockResolvedValueOnce({
      ...pageFor(1),
      keyColumn: null,
      nextCursor: null,
    });
    renderPanel();
    await screen.findByText('row1a');
    expect(screen.getAllByRole('button', { name: '编辑' })[0]).toBeDisabled();
  });
});

describe('DatabasePanel change control', () => {
  it('previews parameterised forward and rollback SQL behind an explicit confirmation', async () => {
    renderPanel();
    await screen.findByText('row1b');
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[1]);

    const input = await screen.findByRole('textbox', { name: '第 2 行 label 新值' });
    fireEvent.change(input, { target: { value: 'renamed' } });
    fireEvent.click(screen.getByRole('button', { name: '生成变更预览' }));

    await waitFor(() =>
      expect(bridge.planRowChange).toHaveBeenCalledWith('proj_db', 'local.db', 'notes', ['2'], [
        { column: 'label', oldValue: 'row1b', newValue: 'renamed' },
      ]),
    );
    expect(screen.getAllByText('UPDATE "notes" SET "label" = ? WHERE "id" = 2;')).toHaveLength(2);
    expect(screen.getByText('参数: [renamed]')).toBeInTheDocument();
    expect(screen.getByText('参数: [row1b]')).toBeInTheDocument();

    const copyForward = screen.getByRole('button', { name: '复制正向 SQL' });
    const copyRollback = screen.getByRole('button', { name: '复制回滚 SQL' });
    expect(copyForward).toBeDisabled();
    expect(copyRollback).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(copyRollback).toBeEnabled();
  });

  it('surfaces the reason when the plan is refused instead of showing an empty preview', async () => {
    vi.mocked(bridge.planRowChange).mockRejectedValueOnce(new Error('该表没有主键，无法生成可回滚的单行变更'));
    renderPanel();
    await screen.findByText('row1a');
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]);
    fireEvent.change(await screen.findByRole('textbox', { name: '第 1 行 label 新值' }), {
      target: { value: 'changed' },
    });
    fireEvent.click(screen.getByRole('button', { name: '生成变更预览' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('无法生成可回滚的单行变更');
  });
});

describe('DatabasePanel query tabs', () => {
  const openConsole = async () => {
    renderPanel();
    await screen.findByText('row1a');
    fireEvent.click(screen.getByRole('button', { name: /SQL 控制台/ }));
  };

  it('keeps one SQL text and result per tab while switching', async () => {
    await openConsole();
    const editor = screen.getByRole('textbox', { name: 'SQL 查询语句' }) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'SELECT count(*) FROM notes;' } });
    fireEvent.click(screen.getByRole('button', { name: '只读查询' }));
    const echoed = await screen.findByRole('cell', { name: 'SELECT count(*) FROM notes;' });
    expect(within(echoed.closest('table') as HTMLElement).getByRole('columnheader', { name: 'echo' })).toBeInTheDocument();
    expect(screen.getByText(/1 行 · 3ms/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /新建查询/ }));
    expect(editor.value).toBe('SELECT * FROM "notes" LIMIT 50;');
    expect(screen.queryByRole('cell', { name: 'SELECT count(*) FROM notes;' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /查询 2/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /查询 1/ }));
    expect(editor.value).toBe('SELECT count(*) FROM notes;');
    expect(screen.getByRole('cell', { name: 'SELECT count(*) FROM notes;' })).toBeInTheDocument();
  });

  it('renames and closes tabs without losing the remaining ones', async () => {
    await openConsole();
    fireEvent.click(screen.getByRole('button', { name: /新建查询/ }));
    fireEvent.doubleClick(screen.getByRole('button', { name: '查询 2' }));
    const rename = await screen.findByRole('textbox', { name: '标签名称' });
    fireEvent.change(rename, { target: { value: '订单核对' } });
    fireEvent.keyDown(rename, { key: 'Enter' });
    expect(screen.getByRole('tab', { name: /订单核对/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '关闭 订单核对' }));
    expect(screen.queryByRole('tab', { name: /订单核对/ })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /查询 1/ })).toBeInTheDocument();
  });

  it('inserts templates into the active tab only', async () => {
    await openConsole();
    const editor = screen.getByRole('textbox', { name: 'SQL 查询语句' }) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'SELECT 1;' } });
    fireEvent.click(screen.getByRole('button', { name: /新建查询/ }));
    expect(editor.value).toBe('SELECT * FROM "notes" LIMIT 50;');
    fireEvent.click(screen.getByRole('button', { name: '所有表' }));
    expect(editor.value).toContain('sqlite_master');
    fireEvent.click(screen.getByRole('tab', { name: /查询 1/ }));
    expect(editor.value).toBe('SELECT 1;');
  });
});
