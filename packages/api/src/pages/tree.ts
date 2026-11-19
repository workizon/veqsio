/** Pure helpers for the page tree: ordering, descendants, cycle checks and sibling positions. */

export interface TreeNode { id: number; parentId: number | null; position: number; title: string }

export function compareSiblings(a: TreeNode, b: TreeNode): number {
  return a.position - b.position || a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }) || a.id - b.id;
}

/** Flat list in depth-first display order (parents before children, siblings by position, then title, then id). Orphans (parent missing from the list) are shown at the top level. */
export function orderTree<T extends TreeNode>(nodes: T[]): Array<T & { depth: number }> {
  const ids = new Set(nodes.map((n) => n.id));
  const kids = new Map<number | null, T[]>();
  for (const n of nodes) {
    const key = n.parentId !== null && ids.has(n.parentId) && n.parentId !== n.id ? n.parentId : null;
    const list = kids.get(key) ?? [];
    list.push(n);
    kids.set(key, list);
  }
  for (const list of kids.values()) list.sort(compareSiblings);
  const out: Array<T & { depth: number }> = [];
  const seen = new Set<number>();
  const walk = (parent: number | null, depth: number) => {
    for (const n of kids.get(parent) ?? []) {
      if (seen.has(n.id)) continue; // defensive: a cycle in bad data must not loop
      seen.add(n.id);
      out.push({ ...n, depth });
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** Ids of all pages below `id` (not including it). */
export function descendantIds(nodes: TreeNode[], id: number): number[] {
  const kids = new Map<number, number[]>();
  for (const n of nodes) if (n.parentId !== null) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n.id]);
  const out: number[] = [];
  const seen = new Set<number>([id]);
  const stack = [...(kids.get(id) ?? [])];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    stack.push(...(kids.get(cur) ?? []));
  }
  return out;
}

/** True when making `newParentId` the parent of `id` would put a page below itself. */
export function wouldCreateCycle(nodes: TreeNode[], id: number, newParentId: number | null): boolean {
  if (newParentId === null) return false;
  if (newParentId === id) return true;
  return descendantIds(nodes, id).includes(newParentId);
}

/** Position for a page appended after the given siblings. */
export function nextPosition(siblings: Array<{ position: number }>): number {
  return siblings.length ? Math.max(...siblings.map((s) => s.position)) + 1 : 0;
}

/**
 * New sibling order after moving `id` to index `index` (0-based, clamped) among `siblings` (the moved page may or may not
 * already be in the list). Returns ids in order; the caller renumbers positions 0..n-1.
 */
export function reorderSiblings(siblings: TreeNode[], id: number, index: number): number[] {
  const rest = [...siblings].sort(compareSiblings).map((s) => s.id).filter((x) => x !== id);
  const at = Math.max(0, Math.min(index, rest.length));
  rest.splice(at, 0, id);
  return rest;
}
