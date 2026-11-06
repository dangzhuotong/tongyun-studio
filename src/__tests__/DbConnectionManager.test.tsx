import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import DatabasePanel from '../features/DatabasePanel';
import * as bridge from '../bridge';
import type { DbColumnInfo, SavedDbConnection, SqlQueryResult } from '../contracts';

vi.mock('../bridge', () => {
  const mysql: SavedDbConnection = {
    id: 'c-mysql',
    name: '订单主库（只读）',
    engine: 'mysql',
    host: '10.0.0.8',
    port: 3306,
    user: 'readonly',
    database: 'orders',
    tls: false,
    readOnly: true,
    revision: 3,
    updatedAt: '2026-11-03T08:00:00Z',
    hasPassword: true,
  };
  const redis: SavedDbConnection = {
    ...mysql,
    id: 'c-redis',
    name: '会话缓存',
    engine: 'redis',
    port: 6379,
    user: '',
    database: '0',
    hasPassword: false,
  };
  return {
    isDesktop: true,
    listDbConnections: vi.fn(async () => [mysql, redis]),
    saveDbConnection: vi.fn(async (input) => ({ ...mysql, id: input.id || 'c-mysql', name: input.name, revision: 4 })),
    deleteDbConnection: vi.fn(async () => [redis]),
    testDbConnection: vi.fn(async () => ({
      ok: false,
      engine: 'mysql',
      latencyMs: 5001,
      detail: '连接超时或被拒绝：10.0.0.8:3306 端口不通',
      errorCode: 'CONN_FAILED',
    })),
    connectionTables: vi.fn(async () => [{ name: 'orders', kind: 'BASE TABLE' }]),
    connectionColumns: vi.fn(async () => [
      { cid: 1, name: 'id', dataType: 'bigint', notNull: true, dfltValue: null, pk: true },
    ]),
    connectionRedisKeys: vi.fn(async () => [{ name: 'user:1', kind: 'string' }]),
    runConnectionQuery: vi.fn(async (_id: string, query: string): Promise<SqlQueryResult> =>
      /^\s*update/i.test(query)
        ? { columns: [], rows: [], rowCount: 0, durationMs: 0, error: 'GUARD_READONLY：该连接开启了只读保护，仅允许 SELECT / SHOW / EXPLAIN 等查询' }
        : { columns: ['id'], rows: [['1']], rowCount: 1, durationMs: 7, error: null }),
    executeSqlQuery: vi.fn(async (): Promise<SqlQueryResult> => ({ columns: [], rows: [], rowCount: 0, durationMs: 0, error: null })),
    getDbTables: vi.fn(async () => []),
    getTableColumns: vi.fn(async () => [] as DbColumnInfo[]),
    getTableData: vi.fn(async () => ({ columns: [], rows: [], totalRows: 0, page: 1, pageSize: 50 })),
    readProjectFileContent: vi.fn(async () => ''),
    openProjectFile: vi.fn(async () => {}),
  };
});

const SECRET = 'sup3r-s3cret';

describe('DatabasePanel 多引擎连接管理', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('展示连接列表的引擎、目标与只读/口令标记，且不回显口令', async () => {
    const { container } = render(<DatabasePanel project={null} inspection={null} />);
    await waitFor(() => expect(screen.getByText('连接列表 (2)')).toBeInTheDocument());

    expect(screen.getByText('订单主库（只读）')).toBeInTheDocument();
    expect(screen.getByText('10.0.0.8:3306/orders')).toBeInTheDocument();
    expect(screen.getAllByTitle('只读保护已开启')).toHaveLength(2);
    expect(screen.getAllByTitle('口令已加密保存')).toHaveLength(1);
    expect(screen.getAllByText('Redis')).toHaveLength(1);
    // 后端只回 hasPassword，UI 拿不到也渲染不出明文
    expect((await bridge.listDbConnections())[0]).not.toHaveProperty('password');
    expect(container.textContent ?? '').not.toContain(SECRET);
  });

  it('选择连接后按引擎拉取对象树，并用引擎方言读取首屏', async () => {
    render(<DatabasePanel project={null} inspection={null} />);
    await waitFor(() => expect(screen.getByText('连接列表 (2)')).toBeInTheDocument());

    fireEvent.click(screen.getByText('订单主库（只读）'));
    await waitFor(() => expect(bridge.connectionTables).toHaveBeenCalledWith('c-mysql'));
    await waitFor(() =>
      expect(bridge.runConnectionQuery).toHaveBeenCalledWith('c-mysql', 'SELECT * FROM `orders` LIMIT 50'),
    );
    expect(screen.getByText('表与视图 (1)')).toBeInTheDocument();

    fireEvent.click(screen.getByText('会话缓存'));
    await waitFor(() => expect(bridge.connectionRedisKeys).toHaveBeenCalledWith('c-redis', '*'));
    await waitFor(() => expect(bridge.runConnectionQuery).toHaveBeenCalledWith('c-redis', 'GET user:1'));
    expect(screen.getByText('键与类型 (1)')).toBeInTheDocument();
    // 项目 SQLite 通道不参与连接模式
    expect(bridge.getDbTables).not.toHaveBeenCalled();
  });

  it('只读连接执行写入时把拦截原因回显在结果区', async () => {
    const notify = vi.fn();
    render(<DatabasePanel project={null} inspection={null} onNotify={notify} />);
    await waitFor(() => expect(screen.getByText('连接列表 (2)')).toBeInTheDocument());
    fireEvent.click(screen.getByText('订单主库（只读）'));
    await waitFor(() => expect(bridge.connectionTables).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /SQL 控制台/i }));
    expect(screen.getByText(/只读保护已开启，非只读语句会被拦截/)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('输入单条 SELECT 或只读表结构查询…'), {
      target: { value: 'UPDATE orders SET amount = 9 WHERE id = 1;' },
    });
    fireEvent.click(screen.getByRole('button', { name: /只读查询/i }));

    await waitFor(() => expect(screen.getByText(/· 异常/)).toBeInTheDocument());
    expect(screen.getByText(/GUARD_READONLY/)).toBeInTheDocument();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('GUARD_READONLY'));
  });

  it('新建连接默认只读，未改动密码时不回传口令，测试连接先保存再探针', async () => {
    render(<DatabasePanel project={null} inspection={null} />);
    await waitFor(() => expect(screen.getByText('连接列表 (2)')).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole('button', { name: /新建连接/i })[0]);
    expect(screen.getByRole('heading', { name: '新建数据库连接' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /只读保护/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /使用 SSL/ })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: 'PostgreSQL' }));
    expect(screen.getByRole('checkbox', { name: /使用 SSL/ })).toBeDisabled();
    expect(screen.getByPlaceholderText('analytics')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'MySQL / TiDB / MariaDB' }));

    fireEvent.change(screen.getByPlaceholderText('例如：订单主库（只读）'), { target: { value: '报表库' } });
    fireEvent.click(screen.getByRole('button', { name: /保存连接/i }));
    await waitFor(() => expect(bridge.saveDbConnection).toHaveBeenCalled());
    expect(bridge.saveDbConnection).toHaveBeenCalledWith(
      expect.objectContaining({ name: '报表库', engine: 'mysql', port: 3306, readOnly: true, password: null }),
    );
    await waitFor(() => expect(screen.queryByRole('heading', { name: '新建数据库连接' })).not.toBeInTheDocument());

    fireEvent.click(screen.getAllByRole('button', { name: /新建连接/i })[0]);
    fireEvent.change(screen.getByPlaceholderText('例如：订单主库（只读）'), { target: { value: '报表库2' } });
    const pwd = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(pwd, { target: { value: SECRET } });
    fireEvent.click(screen.getByRole('button', { name: /测试连接/i }));
    await waitFor(() => expect(bridge.testDbConnection).toHaveBeenCalledWith('c-mysql'));
    expect(bridge.saveDbConnection).toHaveBeenLastCalledWith(expect.objectContaining({ password: SECRET }));
    await waitFor(() => expect(screen.getByText(/CONN_FAILED/)).toBeInTheDocument());
    expect(screen.getByText(/端口不通/)).toBeInTheDocument();
    // 测试连接保持弹窗打开，探针结果有落点；记录此时已经保存
    expect(screen.getByRole('heading', { name: '编辑连接：报表库2' })).toBeInTheDocument();
    const dialog = within(screen.getByRole('dialog', { name: '连接配置' }));
    expect(dialog.getByRole('button', { name: /删除连接/i })).toBeInTheDocument();
    expect(dialog.getByRole('button', { name: /测试连接/i })).toBeInTheDocument();
  });

  it('删除连接后刷新列表并给出提示', async () => {
    const notify = vi.fn();
    render(<DatabasePanel project={null} inspection={null} onNotify={notify} />);
    await waitFor(() => expect(screen.getByText('连接列表 (2)')).toBeInTheDocument());

    fireEvent.click(screen.getAllByTitle('删除连接')[0]);
    await waitFor(() => expect(bridge.deleteDbConnection).toHaveBeenCalledWith('c-mysql'));
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('已删除连接'));
    await waitFor(() => expect(screen.getByText('连接列表 (1)')).toBeInTheDocument());
  });

  it('编辑已有连接：口令不改动则保留，显式清空才删除', async () => {
    render(<DatabasePanel project={null} inspection={null} />);
    await waitFor(() => expect(screen.getByText('连接列表 (2)')).toBeInTheDocument());

    fireEvent.click(screen.getAllByTitle('编辑连接')[0]);
    expect(screen.getByRole('heading', { name: '编辑连接：订单主库（只读）' })).toBeInTheDocument();
    expect(screen.getByText('当前已保存加密口令')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /保存连接/i }));
    await waitFor(() => expect(bridge.saveDbConnection).toHaveBeenCalled());
    expect(bridge.saveDbConnection).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c-mysql', revision: 3, password: null }),
    );

    fireEvent.click(screen.getAllByTitle('编辑连接')[0]);
    const pwd = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(pwd, { target: { value: SECRET } });
    fireEvent.change(pwd, { target: { value: '' } });
    expect(screen.getByText('当前已保存加密口令')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /保存连接/i }));
    await waitFor(() => expect(bridge.saveDbConnection).toHaveBeenCalledTimes(2));
    expect(bridge.saveDbConnection).toHaveBeenLastCalledWith(expect.objectContaining({ password: '' }));
    // 口令只流向后端一次，界面与列表不回显明文
    expect(document.body.textContent ?? '').not.toContain(SECRET);
    expect(document.querySelectorAll('input[type="password"]').length).toBe(0);
  });
});
