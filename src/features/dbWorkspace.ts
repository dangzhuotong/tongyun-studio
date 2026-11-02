import type { ColumnChange, RowChangePlan, SqlQueryResult } from '../contracts';

export interface QueryTab {
  id: string;
  name: string;
  sql: string;
  dbPath: string;
  result: SqlQueryResult | null;
  running: boolean;
}

export const SQL_NULL_SENTINEL = 'NULL';

export type TemplateKind = 'sample' | 'tables' | 'describe';

export function templateSql(kind: TemplateKind, table?: string | null): string {
  if (kind === 'tables') {
    return "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name;";
  }
  if (kind === 'describe') {
    return `PRAGMA table_info("${table ?? 'table_name'}");`;
  }
  return `SELECT * FROM "${table ?? 'table_name'}" LIMIT 50;`;
}

let tabSequence = 0;

export function createQueryTab(dbPath: string, tabs: QueryTab[], table?: string | null): QueryTab {
  const used = new Set(tabs.map(tab => tab.name));
  let index = 1;
  while (used.has(`查询 ${index}`)) index += 1;
  tabSequence += 1;
  return {
    id: `tab-${Date.now().toString(36)}-${tabSequence}`,
    name: `查询 ${index}`,
    sql: templateSql('sample', table ?? null),
    dbPath,
    result: null,
    running: false,
  };
}

export function renameQueryTab(tabs: QueryTab[], id: string, name: string): QueryTab[] {
  const trimmed = name.trim();
  if (!trimmed) return tabs;
  return tabs.map(tab => (tab.id === id ? { ...tab, name: trimmed.slice(0, 40) } : tab));
}

export function closeQueryTab(
  tabs: QueryTab[],
  activeId: string,
): { tabs: QueryTab[]; activeId: string } {
  if (tabs.length <= 1) {
    const only = { ...tabs[0], result: null, running: false };
    return { tabs: [only], activeId: only.id };
  }
  const index = tabs.findIndex(tab => tab.id === activeId);
  const remaining = tabs.filter(tab => tab.id !== activeId);
  const nextIndex = Math.min(Math.max(index, 0), remaining.length - 1);
  return { tabs: remaining, activeId: remaining[nextIndex].id };
}

export function applyTabResult(
  tabs: QueryTab[],
  id: string,
  patch: Partial<Pick<QueryTab, 'result' | 'running' | 'dbPath' | 'sql' | 'name'>>,
): QueryTab[] {
  return tabs.map(tab => (tab.id === id ? { ...tab, ...patch } : tab));
}

/** cursorStack[p] is the cursor that loads page p + 2; index p is the 1-based page it came from. */
export function rememberCursor(
  stack: Record<number, string>,
  page: number,
  nextCursor: string | null,
): Record<number, string> {
  if (!nextCursor) return stack;
  return { ...stack, [page]: nextCursor };
}

export function cursorForPage(stack: Record<number, string>, page: number): string | null {
  if (page <= 1) return null;
  return stack[page - 1] ?? null;
}

function cellToText(cell: unknown): string {
  if (cell === null || cell === undefined) return '';
  if (cell === SQL_NULL_SENTINEL) return '';
  return String(cell);
}

export function toCsv(columns: string[], rows: unknown[][]): string {
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const lines = [columns.map(escape).join(',')];
  for (const row of rows) {
    lines.push(columns.map((_, index) => escape(cellToText(row[index]))).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function toJson(columns: string[], rows: unknown[][]): string {
  const objects = rows.map(row => {
    const record: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      const cell = row[index];
      record[column] = cell === null || cell === undefined || cell === SQL_NULL_SENTINEL ? null : cell;
    });
    return record;
  });
  return JSON.stringify(objects, null, 2);
}

export function buildColumnChanges(
  columns: string[],
  originalRow: string[],
  edits: Record<number, string>,
): ColumnChange[] {
  return Object.entries(edits)
    .map(([index, newValue]) => {
      const column = columns[Number(index)];
      return { column, oldValue: originalRow[Number(index)] ?? '', newValue };
    })
    .filter(change => change.column !== undefined && change.oldValue !== change.newValue);
}

export function describeParameters(values: (string | null)[]): string {
  return values.map(value => (value === null ? 'NULL' : `'${value.replace(/'/g, "''")}'`)).join(', ');
}

export function formatPlanForClipboard(plan: RowChangePlan, kind: 'forward' | 'rollback'): string {
  const sql = kind === 'forward' ? plan.forwardSql : plan.rollbackSql;
  const params = kind === 'forward' ? plan.forwardParameters : plan.rollbackParameters;
  return `-- ${kind === 'forward' ? '正向变更' : '反向回滚'} · ${plan.table} · ${sql}\n${sql}\n-- 绑定参数: [${describeParameters(params)}]`;
}
