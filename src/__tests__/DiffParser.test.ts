import { describe, it, expect } from 'vitest';
import { parseDiff, diffStats, splitHunks, formatStats } from '../features/diffParser';

const sample = [
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
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1,2 @@',
  '+first of new file',
  '\\ No newline at end of file',
].join('\n');

describe('parseDiff', () => {
  it('labels file headers, hunks and body lines', () => {
    const lines = parseDiff(sample);
    expect(lines[0].kind).toBe('file');
    expect(lines[1].kind).toBe('file');
    expect(lines[2].kind).toBe('file');
    expect(lines[3].kind).toBe('file');
    expect(lines[4].kind).toBe('hunk');
    expect(lines.filter(l => l.kind === 'hunk')).toHaveLength(3);
    expect(lines.find(l => l.text.startsWith('new file'))?.kind).toBe('meta');
    expect(lines.find(l => l.text.startsWith('\\ No newline'))?.kind).toBe('meta');
  });

  it('numbers old and new sides independently from each hunk header', () => {
    const lines = parseDiff(sample);
    const contextOne = lines.find(l => l.text === ' context one')!;
    expect({ old: contextOne.oldLine, new: contextOne.newLine }).toEqual({ old: 10, new: 20 });
    const removed = lines.find(l => l.text === '-removed line')!;
    expect({ old: removed.oldLine, new: removed.newLine }).toEqual({ old: 11, new: null });
    const added = lines.find(l => l.text === '+added line')!;
    expect({ old: added.oldLine, new: added.newLine }).toEqual({ old: null, new: 21 });
    const addedTwo = lines.find(l => l.text === '+added line two')!;
    expect({ old: addedTwo.oldLine, new: addedTwo.newLine }).toEqual({ old: null, new: 22 });
    const contextTwo = lines.find(l => l.text === ' context two')!;
    expect({ old: contextTwo.oldLine, new: contextTwo.newLine }).toEqual({ old: 12, new: 23 });
    const lone = lines.find(l => l.text === ' lone context')!;
    expect({ old: lone.oldLine, new: lone.newLine }).toEqual({ old: 40, new: 50 });
  });

  it('starts new-file additions at line 1', () => {
    const firstNew = parseDiff(sample).find(l => l.text === '+first of new file')!;
    expect({ old: firstNew.oldLine, new: firstNew.newLine }).toEqual({ old: null, new: 1 });
  });

  it('counts only real adds and deletes in the stats', () => {
    expect(diffStats(parseDiff(sample))).toEqual({ added: 3, deleted: 1 });
    expect(formatStats({ added: 3, deleted: 1 })).toBe('+3 −1');
  });

  it('splits one block per hunk and drops file headers', () => {
    const blocks = splitHunks(parseDiff(sample));
    expect(blocks).toHaveLength(3);
    expect(blocks[0][0].kind).toBe('hunk');
    expect(blocks[0].some(l => l.kind === 'file')).toBe(false);
    expect(diffStats(blocks[0])).toEqual({ added: 2, deleted: 1 });
    expect(diffStats(blocks[2])).toEqual({ added: 1, deleted: 0 });
  });

  it('handles empty output and binary diffs without inventing numbers', () => {
    expect(parseDiff('')).toEqual([]);
    const binary = parseDiff([
      'diff --git a/x.png b/x.png',
      'index 4444444..5555555 100644',
      'Binary files a/x.png and b/x.png differ',
    ].join('\n'));
    expect(binary.map(l => l.kind)).toEqual(['file', 'file', 'meta']);
    expect(splitHunks(binary)).toEqual([]);
  });
});
