/**
 * Group-by bucketing for view results (pure). Works on the issue shape produced by `buildIssueResponses`
 * (plus an optional `fields.sprint` the view executor attaches).
 *
 * Output refers to issues by id so the response stays small; the client joins the groups with the issue list.
 * Grouping is applied to the page that was loaded, and `count` is the number of issues of that page in the bucket.
 */
import type { GroupField } from './config';

export interface GroupableIssue { id: number; key: string; fields: Record<string, any> }

export interface GroupKey { key: string; label: string; order: number }

/** Known values that may be shown even when no issue matches ("show empty groups"). */
export type GroupUniverse = Partial<Record<GroupField, GroupKey[]>>;

export interface SubGroup { key: string; label: string; count: number; issueIds: number[] }
export interface Group { key: string; label: string; count: number; issueIds: number[]; subGroups?: SubGroup[] }

const NONE_LABEL: Record<GroupField, string> = {
  status: 'No status', assignee: 'Unassigned', priority: 'No priority', type: 'No type',
  label: 'No label', sprint: 'No sprint', none: 'All issues',
};

const STATUS_CATEGORY_RANK: Record<string, number> = { new: 0, todo: 0, indeterminate: 1, 'in progress': 1, done: 2 };

/** Buckets one issue falls into for a field (labels: one per label; everything else: exactly one). */
export function bucketsOf(issue: GroupableIssue, field: GroupField): GroupKey[] {
  const f = issue.fields ?? {};
  switch (field) {
    case 'none':
      return [{ key: 'all', label: NONE_LABEL.none, order: 0 }];
    case 'status': {
      const s = f.status;
      if (!s) return [none('status')];
      const rank = STATUS_CATEGORY_RANK[String(s.category ?? '').toLowerCase()] ?? 1;
      return [{ key: `status:${s.id}`, label: String(s.name ?? s.id), order: rank * 1000 + (Number(s.sortOrder) || Number(s.id) || 0) }];
    }
    case 'assignee': {
      const a = f.assignee;
      return a ? [{ key: `assignee:${a.id}`, label: String(a.displayName ?? a.id), order: 1 }] : [none('assignee')];
    }
    case 'priority': {
      const p = f.priority;
      return p ? [{ key: `priority:${p.id}`, label: String(p.name ?? p.id), order: Number(p.sortOrder) || Number(p.id) || 0 }] : [none('priority')];
    }
    case 'type': {
      const t = f.issuetype;
      return t ? [{ key: `type:${t.id}`, label: String(t.name ?? t.id), order: Number(t.id) || 0 }] : [none('type')];
    }
    case 'label': {
      const labels: string[] = Array.isArray(f.labels) ? [...new Set<string>(f.labels.filter((l: unknown) => typeof l === 'string' && l))] : [];
      return labels.length ? labels.map((l) => ({ key: `label:${l}`, label: l, order: 1 })) : [none('label')];
    }
    case 'sprint': {
      const s = f.sprint;
      return s ? [{ key: `sprint:${s.id}`, label: String(s.name ?? s.id), order: sprintRank(s.state) }] : [none('sprint')];
    }
  }
}

function sprintRank(state: unknown): number {
  return state === 'active' ? 0 : state === 'future' ? 1 : 2;
}

function none(field: GroupField): GroupKey {
  return { key: `${field}:none`, label: NONE_LABEL[field], order: Number.MAX_SAFE_INTEGER };
}

function compareKeys(a: GroupKey, b: GroupKey): number {
  if (a.order !== b.order) return a.order < b.order ? -1 : 1;
  return a.label.localeCompare(b.label, 'en', { sensitivity: 'base', numeric: true }) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/**
 * Groups issues by `groupBy`, optionally sub-grouping by `subGroupBy`.
 * Buckets are ordered by their natural order (status by category, priority by sort order, "none" last),
 * then by label. Empty buckets of the supplied universe appear only with `showEmpty`.
 * `groupBy: 'none'` yields one group holding everything (no sub-groups, whatever `subGroupBy` says).
 */
export function groupIssues(
  issues: GroupableIssue[],
  groupBy: GroupField,
  subGroupBy: GroupField,
  opts: { showEmpty?: boolean; universe?: GroupUniverse } = {},
): Group[] {
  const sub: GroupField = groupBy === 'none' || subGroupBy === groupBy ? 'none' : subGroupBy;
  const top = new Map<string, { k: GroupKey; ids: number[]; subs: Map<string, { k: GroupKey; ids: number[] }> }>();
  const subOrder = new Map<string, GroupKey>();

  // The universe also supplies the natural order of known values (e.g. status sort order from the database).
  const known = (field: GroupField, k: GroupKey): GroupKey => opts.universe?.[field]?.find((u) => u.key === k.key) ?? k;
  const entry = (k0: GroupKey) => {
    const k = known(groupBy, k0);
    let e = top.get(k.key);
    if (!e) { e = { k, ids: [], subs: new Map() }; top.set(k.key, e); }
    return e;
  };

  for (const issue of issues) {
    for (const g of bucketsOf(issue, groupBy)) {
      const e = entry(g);
      e.ids.push(issue.id);
      if (sub !== 'none') {
        for (const s of bucketsOf(issue, sub)) {
          const sk = known(sub, s);
          subOrder.set(sk.key, sk);
          let se = e.subs.get(sk.key);
          if (!se) { se = { k: sk, ids: [] }; e.subs.set(sk.key, se); }
          se.ids.push(issue.id);
        }
      }
    }
  }

  if (opts.showEmpty && groupBy !== 'none') {
    for (const k of opts.universe?.[groupBy] ?? []) if (!top.has(k.key)) entry(k);
  }
  if (opts.showEmpty && sub !== 'none') {
    const universeSub = opts.universe?.[sub] ?? [];
    for (const k of universeSub) subOrder.set(k.key, subOrder.get(k.key) ?? k);
  }

  const groups = [...top.values()].sort((a, b) => compareKeys(a.k, b.k)).map((e): Group => {
    const g: Group = { key: e.k.key, label: e.k.label, count: e.ids.length, issueIds: e.ids };
    if (sub !== 'none') {
      const keys = new Map(e.subs);
      if (opts.showEmpty) for (const k of subOrder.values()) if (!keys.has(k.key)) keys.set(k.key, { k, ids: [] });
      g.subGroups = [...keys.values()].sort((a, b) => compareKeys(a.k, b.k))
        .map((s) => ({ key: s.k.key, label: s.k.label, count: s.ids.length, issueIds: s.ids }));
    }
    return g;
  });
  return groups;
}
