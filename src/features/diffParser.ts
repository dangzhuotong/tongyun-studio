export type DiffLineKind = 'context' | 'add' | 'delete' | 'hunk' | 'file' | 'meta';

export interface ParsedDiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffStats {
  added: number;
  deleted: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const FILE_HEADER_RE = /^(diff --git|index |--- |\+\+\+ )/;
const META_RE = /^(new file|deleted file|similarity |rename |Binary files|GIT binary patch|mode |old mode|new mode|\\ No newline)/;

/** Parses `git diff` text into per-line records with old/new line numbers for the gutter. */
export function parseDiff(diff: string): ParsedDiffLine[] {
  const lines: ParsedDiffLine[] = [];
  let oldLine: number | null = 0;
  let newLine: number | null = 0;
  for (const text of diff.split('\n')) {
    if (text.startsWith('@@')) {
      const match = HUNK_RE.exec(text);
      oldLine = match ? Number(match[1]) : null;
      newLine = match ? Number(match[2]) : null;
      lines.push({ kind: 'hunk', text, oldLine: null, newLine: null });
      continue;
    }
    if (FILE_HEADER_RE.test(text)) {
      lines.push({ kind: 'file', text, oldLine: null, newLine: null });
      continue;
    }
    if (META_RE.test(text)) {
      lines.push({ kind: 'meta', text, oldLine: null, newLine: null });
      continue;
    }
    if (text.startsWith('+')) {
      lines.push({ kind: 'add', text, oldLine: null, newLine: newLine ?? 0 });
      if (newLine !== null) newLine += 1;
      continue;
    }
    if (text.startsWith('-')) {
      lines.push({ kind: 'delete', text, oldLine: oldLine ?? 0, newLine: null });
      if (oldLine !== null) oldLine += 1;
      continue;
    }
    if (text === '') {
      continue;
    }
    lines.push({ kind: 'context', text, oldLine: oldLine ?? 0, newLine: newLine ?? 0 });
    if (oldLine !== null) oldLine += 1;
    if (newLine !== null) newLine += 1;
  }
  return lines;
}

/** Adds and deletes actually present in the diff, ignoring headers and hunk markers. */
export function diffStats(lines: ParsedDiffLine[]): DiffStats {
  let added = 0;
  let deleted = 0;
  for (const line of lines) {
    if (line.kind === 'add') added += 1;
    if (line.kind === 'delete') deleted += 1;
  }
  return { added, deleted };
}

/** Groups lines into one block per hunk; anything before the first hunk header is file noise. */
export function splitHunks(lines: ParsedDiffLine[]): ParsedDiffLine[][] {
  const blocks: ParsedDiffLine[][] = [];
  let current: ParsedDiffLine[] = [];
  for (const line of lines) {
    if (line.kind === 'hunk') {
      if (current.length > 0) blocks.push(current);
      current = [line];
      continue;
    }
    if (current.length === 0) continue;
    current.push(line);
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

export function formatStats(stats: DiffStats): string {
  return `+${stats.added} −${stats.deleted}`;
}
