import { describe, it, expect } from 'vitest';
import { computeGitGraphRows, relativeCommitTime } from '../features/gitGraph';
import type { GitLogCommit } from '../contracts';

function commit(
  oid: string,
  parents: string[],
  extra: Partial<GitLogCommit> = {},
): GitLogCommit {
  return {
    oid,
    shortOid: oid.slice(0, 7),
    parents,
    authorName: 'Test',
    authorEmail: 'test@example.invalid',
    timestamp: 1730000000,
    summary: `commit ${oid}`,
    refs: [],
    col: 0,
    edges: [],
    ...extra,
  };
}

describe('computeGitGraphRows', () => {
  it('keeps a linear history in lane 0', () => {
    const rows = computeGitGraphRows([
      commit('c2', ['c1']),
      commit('c1', []),
    ]);
    expect(rows.map(r => r.col)).toEqual([0, 0]);
    expect(rows[0].incoming).toBe(false);
    expect(rows[1].incoming).toBe(true);
    expect(rows[0].edges).toEqual([{ fromCol: 0, toCol: 0 }]);
    expect(rows[1].edges).toEqual([]);
  });

  it('tracks lanes through merge topology', () => {
    // merge m with parents [c4, f]; both sides rooted at c2 -> c1
    const rows = computeGitGraphRows([
      commit('m0', ['c4', 'f1']),
      commit('c4', ['c2']),
      commit('f1', ['c2']),
      commit('c2', ['c1']),
      commit('c1', []),
    ]);
    expect(rows[0].col).toBe(0);
    expect(rows[0].edges).toEqual([
      { fromCol: 0, toCol: 0 },
      { fromCol: 0, toCol: 1 },
    ]);
    expect(rows[1].col).toBe(0);
    expect(rows[1].incoming).toBe(true);
    expect(rows[2].col).toBe(1);
    expect(rows[2].incoming).toBe(true);
    // side lane collapses after f1 is consumed; c4 row shows the crossing edge
    expect(rows[2].edges).toEqual([{ fromCol: 1, toCol: 0 }]);
    expect(rows[3].col).toBe(0);
    expect(rows[3].laneCount).toBe(1);
  });

  it('assigns a fresh lane for unborn parents', () => {
    const rows = computeGitGraphRows([
      commit('a1', []),
      commit('b1', ['a1']),
    ]);
    expect(rows[0].col).toBe(0);
    expect(rows[1].col).toBe(0);
  });

  it('formats relative commit time', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(relativeCommitTime(now - 30)).toBe('刚刚');
    expect(relativeCommitTime(now - 120)).toBe('2 分钟前');
    expect(relativeCommitTime(now - 7200)).toBe('2 小时前');
    expect(relativeCommitTime(now - 3 * 86400)).toBe('3 天前');
    expect(relativeCommitTime(0)).toBe('-');
  });
});
