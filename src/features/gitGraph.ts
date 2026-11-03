import type { GitGraphEdge, GitLogCommit } from '../contracts';

export interface GitGraphRow {
  oid: string;
  col: number;
  edges: GitGraphEdge[];
  incoming: boolean;
  throughCols: number[];
  laneCount: number;
}

/// Replays the backend lane algorithm so each row can render its own SVG slice.
export function computeGitGraphRows(commits: GitLogCommit[]): GitGraphRow[] {
  const lanes: (string | null)[] = [];
  const rows: GitGraphRow[] = [];
  for (const commit of commits) {
    const activeBefore = new Set(
      lanes.map((lane, index) => (lane !== null ? index : -1)).filter(index => index !== -1),
    );
    let col = lanes.indexOf(commit.oid);
    const incoming = col !== -1;
    if (col === -1) {
      const free = lanes.indexOf(null);
      if (free !== -1) {
        col = free;
      } else {
        lanes.push(null);
        col = lanes.length - 1;
      }
    }
    const edges: GitGraphEdge[] = [];
    if (commit.parents.length === 0) {
      lanes[col] = null;
    } else {
      const firstParent = commit.parents[0];
      const p0Col = lanes.indexOf(firstParent);
      if (p0Col !== -1) {
        edges.push({ fromCol: col, toCol: p0Col });
        if (p0Col !== col) lanes[col] = null;
      } else {
        lanes[col] = firstParent;
        edges.push({ fromCol: col, toCol: col });
      }
      for (const parent of commit.parents.slice(1)) {
        let kCol = lanes.indexOf(parent);
        if (kCol === -1) {
          const free = lanes.indexOf(null);
          if (free !== -1) {
            lanes[free] = parent;
            kCol = free;
          } else {
            lanes.push(parent);
            kCol = lanes.length - 1;
          }
        }
        edges.push({ fromCol: col, toCol: kCol });
      }
    }
    const throughCols: number[] = [];
    for (const index of activeBefore) {
      if (lanes[index] !== null && !(commit.parents.length > 0 && index === col)) {
        throughCols.push(index);
      }
    }
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    let laneCount = Math.max(lanes.length, col + 1);
    for (const edge of edges) laneCount = Math.max(laneCount, edge.toCol + 1);
    rows.push({ oid: commit.oid, col, edges, incoming, throughCols, laneCount });
  }
  return rows;
}

export function relativeCommitTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '-';
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 30 * 86400) return `${Math.floor(diff / 86400)} 天前`;
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}
