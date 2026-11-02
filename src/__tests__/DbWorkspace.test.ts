import { describe, it, expect } from 'vitest';
import {
  applyTabResult,
  buildColumnChanges,
  closeQueryTab,
  createQueryTab,
  cursorForPage,
  formatPlanForClipboard,
  rememberCursor,
  renameQueryTab,
  templateSql,
  toCsv,
  toJson,
  type QueryTab,
} from '../features/dbWorkspace';
import type { RowChangePlan } from '../contracts';

const tab = (id: string, name: string, patch: Partial<QueryTab> = {}): QueryTab => ({
  id,
  name,
  sql: 'SELECT 1;',
  dbPath: 'local.db',
  result: null,
  running: false,
  ...patch,
});

describe('query tab model', () => {
  it('names a new tab after the next free slot', () => {
    const created = createQueryTab('a.db', [tab('1', '查询 1'), tab('2', '查询 3')]);
    expect(created.name).toBe('查询 2');
    expect(created.dbPath).toBe('a.db');
    expect(created.result).toBeNull();
    expect(created.sql).toBe('SELECT * FROM "table_name" LIMIT 50;');
    expect(createQueryTab('a.db', [], 'orders').sql).toBe('SELECT * FROM "orders" LIMIT 50;');
  });

  it('keeps at least one tab and moves the active id when closing', () => {
    const tabs = [tab('a', '查询 1'), tab('b', '查询 2'), tab('c', '查询 3')];
    expect(closeQueryTab(tabs, 'b').activeId).toBe('c');
    expect(closeQueryTab(tabs, 'c').activeId).toBe('b');
    const last = closeQueryTab([tab('a', '查询 1')], 'a');
    expect(last.tabs).toHaveLength(1);
    expect(last.activeId).toBe('a');
  });

  it('drops the cached result only when the last tab is reset', () => {
    const withResult = closeQueryTab([tab('a', '查询 1', { result: { columns: [], rows: [], rowCount: 0, durationMs: 0, error: null } })], 'a');
    expect(withResult.tabs[0].result).toBeNull();
    const kept = closeQueryTab([tab('a', '查询 1', { result: { columns: [], rows: [], rowCount: 0, durationMs: 0, error: null } }), tab('b', '查询 2')], 'b');
    expect(kept.tabs[0].result).not.toBeNull();
  });

  it('renames non-blank tabs and patches results by id', () => {
    const tabs = [tab('a', '查询 1'), tab('b', '查询 2')];
    expect(renameQueryTab(tabs, 'a', '  订单核对  ')[0].name).toBe('订单核对');
    expect(renameQueryTab(tabs, 'a', '   ')[0].name).toBe('查询 1');
    const patched = applyTabResult(tabs, 'b', { running: true });
    expect(patched.find(t => t.id === 'b')?.running).toBe(true);
    expect(patched.find(t => t.id === 'a')?.running).toBe(false);
    // A closed tab id never resurrects a result.
    expect(applyTabResult(patched, 'gone', { running: true })).toEqual(patched);
  });
});

describe('sql templates', () => {
  it('builds sample, table list and describe templates against the selected table', () => {
    expect(templateSql('sample', 'orders')).toBe('SELECT * FROM "orders" LIMIT 50;');
    expect(templateSql('tables')).toContain('sqlite_master');
    expect(templateSql('describe', 'orders')).toBe('PRAGMA table_info("orders");');
    expect(templateSql('sample')).toBe('SELECT * FROM "table_name" LIMIT 50;');
  });
});

describe('keyset cursor stack', () => {
  it('stores the cursor of the page just read and uses it for the next one', () => {
    let stack: Record<number, string> = {};
    stack = rememberCursor(stack, 1, '2');
    stack = rememberCursor(stack, 2, '4');
    expect(cursorForPage(stack, 1)).toBeNull();
    expect(cursorForPage(stack, 2)).toBe('2');
    expect(cursorForPage(stack, 3)).toBe('4');
    expect(rememberCursor(stack, 3, null)).toBe(stack);
  });
});

describe('result export', () => {
  it('escapes CSV fields and turns the NULL sentinel into an empty cell', () => {
    const csv = toCsv(
      ['id', 'label', 'note'],
      [
        ['1', 'has "quotes", comma', 'plain'],
        ['2', 'multi\nline', 'NULL'],
      ],
    );
    expect(csv).toBe(
      '"id","label","note"\r\n"1","has ""quotes"", comma","plain"\r\n"2","multi\nline",""\r\n',
    );
  });

  it('exports JSON objects with real nulls and keeps numeric strings honest', () => {
    const parsed = JSON.parse(toJson(['id', 'note'], [['1', 'NULL'], ['2', 'text']])) as Record<string, unknown>[];
    expect(parsed).toEqual([
      { id: '1', note: null },
      { id: '2', note: 'text' },
    ]);
  });

  it('exports an empty result set as headers only', () => {
    expect(toCsv(['a'], [])).toBe('"a"\r\n');
    expect(toJson(['a'], [])).toBe('[]');
  });
});

describe('row change collection', () => {
  it('keeps only edited cells and remembers the previous value', () => {
    const changes = buildColumnChanges(['id', 'label', 'note'], ['7', 'old', 'NULL'], { 1: 'new', 2: 'NULL', 0: '7' });
    expect(changes).toEqual([
      { column: 'label', oldValue: 'old', newValue: 'new' },
    ]);
  });

  it('renders the plan with bound parameters for the clipboard', () => {
    const plan: RowChangePlan = {
      table: 'notes',
      forwardSql: 'UPDATE "notes" SET "label" = ? WHERE "id" = 2;',
      forwardParameters: ["o'k"],
      rollbackSql: 'UPDATE "notes" SET "label" = ? WHERE "id" = 2;',
      rollbackParameters: [null],
      keyPredicate: '"id" = 2',
      changedColumns: ['label'],
    };
    expect(formatPlanForClipboard(plan, 'forward')).toBe(
      "-- 正向变更 · notes · UPDATE \"notes\" SET \"label\" = ? WHERE \"id\" = 2;\nUPDATE \"notes\" SET \"label\" = ? WHERE \"id\" = 2;\n-- 绑定参数: ['o''k']",
    );
    expect(formatPlanForClipboard(plan, 'rollback')).toContain('-- 绑定参数: [NULL]');
  });
});
