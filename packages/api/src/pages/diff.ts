/**
 * Line diff for page versions. Pure functions, no I/O.
 * Common prefix and suffix are stripped first, the middle is aligned with a longest-common-subsequence table.
 * Very large middles (more than MAX_CELLS table cells) are reported as one removal plus one addition instead of
 * spending quadratic time and memory on them.
 */
export type DiffOp = { type: 'eq' | 'add' | 'del'; text: string };
export interface DiffSummary { added: number; removed: number }

const MAX_CELLS = 4_000_000;

export function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.replace(/\r\n?/g, '\n').split('\n');
}

export function diffLines(before: string, after: string): DiffOp[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ type: 'eq', text: a[i] });
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > MAX_CELLS) {
    for (const t of midA) ops.push({ type: 'del', text: t });
    for (const t of midB) ops.push({ type: 'add', text: t });
  } else {
    const n = midA.length;
    const m = midB.length;
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = midA[i] === midB[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { ops.push({ type: 'eq', text: midA[i] }); i++; j++; }
      else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) { ops.push({ type: 'del', text: midA[i] }); i++; }
      else { ops.push({ type: 'add', text: midB[j] }); j++; }
    }
    while (i < n) ops.push({ type: 'del', text: midA[i++] });
    while (j < m) ops.push({ type: 'add', text: midB[j++] });
  }
  for (let i = endA; i < a.length; i++) ops.push({ type: 'eq', text: a[i] });
  return ops;
}

export function summarizeDiff(ops: DiffOp[]): DiffSummary {
  let added = 0;
  let removed = 0;
  for (const o of ops) { if (o.type === 'add') added++; else if (o.type === 'del') removed++; }
  return { added, removed };
}

export function diffSummary(before: string, after: string): DiffSummary {
  return summarizeDiff(diffLines(before, after));
}

/** Collapses long runs of unchanged lines: keeps `context` lines around each change and marks the gap with a `skip` entry. */
export type HunkItem = DiffOp | { type: 'skip'; count: number };
export function collapseDiff(ops: DiffOp[], context = 3): HunkItem[] {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.type === 'eq') return;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true;
  });
  const out: HunkItem[] = [];
  let skipped = 0;
  ops.forEach((o, i) => {
    if (keep[i]) {
      if (skipped) { out.push({ type: 'skip', count: skipped }); skipped = 0; }
      out.push(o);
    } else skipped++;
  });
  if (skipped) out.push({ type: 'skip', count: skipped });
  return out;
}
