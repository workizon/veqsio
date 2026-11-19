import {
  eq, ne, gt, gte, lt, lte, and, or, isNull, isNotNull, like, notLike, ilike, notIlike, inArray, notInArray,
  asc, desc, sql,
} from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import type { JQLNode, JQLValue, JQLContext, JQLResult, JQLOperator } from './types';
import { JQLError } from './types';

const VALID_FIELDS = new Set<string>([
  'text', 'summary', 'description', 'status', 'priority', 'assignee', 'reporter',
  'project', 'issuetype', 'created', 'updated', 'duedate', 'labels', 'components',
  'fixversion', 'milestone', 'key', 'resolution', 'resolved', 'id', 'parent', 'sprint', 'flagged', 'level', 'watcher', 'voter',
]);

function validateField(field: string): void {
  const lower = field.toLowerCase();
  if (VALID_FIELDS.has(lower)) return;
  if (/^customfield_\d+$/i.test(field)) return;
  throw new JQLError(`Unknown field: ${field}`);
}

function resolveFieldColumn(field: string): any {
  const f = field.toLowerCase();
  switch (f) {
    case 'summary': return schema.issues.summary;
    case 'description': return schema.issues.description;
    case 'status': return schema.issues.statusId;
    case 'priority': return schema.issues.priorityId;
    case 'assignee': return schema.issues.assigneeId;
    case 'reporter': return schema.issues.reporterId;
    case 'project': return schema.issues.projectId;
    case 'issuetype': return schema.issues.issueTypeId;
    case 'created': return schema.issues.createdAt;
    case 'updated': return schema.issues.updatedAt;
    case 'duedate': return schema.issues.dueDate;
    case 'key': return schema.issues.issueKey;
    case 'resolution': return schema.issues.resolutionId;
    case 'resolved': return schema.issues.resolvedAt;
    case 'id': return schema.issues.id;
    case 'parent': return schema.issues.parentId;
    case 'labels': return schema.issues.id; // special multi-value handled elsewhere
    case 'components': return schema.issues.id; // special multi-value handled elsewhere
    case 'fixversion': return schema.issues.id; // special multi-value handled elsewhere
    case 'level': return schema.issues.securityLevelId; // security level, handled in buildLevelCondition
    case 'milestone': return schema.issues.id; // special multi-value handled elsewhere
    case 'text': return null; // special full-text search
    default:
      if (/^customfield_\d+$/i.test(field)) {
        return { isCustomField: true, fieldId: Number(field.split('_')[1]) };
      }
      throw new JQLError(`Unknown field column: ${field}`);
  }
}

function resolveOrderColumn(field: string): any {
  const f = field.toLowerCase();
  switch (f) {
    case 'summary': return schema.issues.summary;
    case 'description': return schema.issues.description;
    case 'status': return schema.issues.statusId;
    case 'priority': return schema.issues.priorityId;
    case 'assignee': return schema.issues.assigneeId;
    case 'reporter': return schema.issues.reporterId;
    case 'project': return schema.issues.projectId;
    case 'issuetype': return schema.issues.issueTypeId;
    case 'created': return schema.issues.createdAt;
    case 'updated': return schema.issues.updatedAt;
    case 'duedate': return schema.issues.dueDate;
    case 'key': return schema.issues.issueKey;
    case 'resolution': return schema.issues.resolutionId;
    case 'resolved': return schema.issues.resolvedAt;
    case 'id': return schema.issues.id;
    case 'flagged': return schema.issues.flagged;
    default:
      throw new JQLError(`Cannot order by unknown field: ${field}`);
  }
}

function resolveScalarValue(val: JQLValue, ctx: JQLContext): string | number | boolean | null {
  switch (val.type) {
    case 'string': return val.value;
    case 'number': return val.value;
    case 'boolean': return val.value;
    case 'null': return null;
    case 'empty': return null;
    default:
      throw new JQLError(`Unsupported scalar value type: ${val.type}`);
  }
}

function resolveFunctionValue(val: JQLValue, ctx: JQLContext): string | number | boolean | Date | number[] | null {
  if (val.type !== 'function') {
    return resolveScalarValue(val, ctx) as any;
  }
  const name = val.name.toLowerCase();
  switch (name) {
    case 'currentuser': {
      if (ctx.currentUserId === undefined) throw new JQLError('currentUser() requires context.currentUserId');
      return ctx.currentUserId;
    }
    case 'startofday':
      return startOfDay(0);
    case 'endofday':
      return endOfDay(0);
    case 'startofweek':
      return startOfWeek(0);
    case 'endofweek':
      return endOfWeek(0);
    case 'startofmonth':
      return startOfMonth(0);
    case 'endofmonth':
      return endOfMonth(0);
    case 'now':
      return new Date();
    case 'opensprints':
      return ctx.openSprintIds ?? [];
    case 'closedsprints':
      return ctx.closedSprintIds ?? [];
    case 'membersof': {
      const groupName = resolveScalarValue(val.args[0], ctx);
      if (!groupName || typeof groupName !== 'string') throw new JQLError('membersOf() requires a string group name');
      return ctx.groupMembers?.[groupName] ?? [];
    }
    default:
      throw new JQLError(`Unknown function: ${name}`);
  }
}

function startOfDay(offsetDays = 0): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d;
}

function endOfDay(offsetDays = 0): Date {
  const d = new Date();
  d.setUTCHours(23, 59, 59, 999);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d;
}

function startOfWeek(offsetWeeks = 0): Date {
  const d = new Date();
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1); // Monday as first day
  d.setUTCDate(diff + offsetWeeks * 7);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function endOfWeek(offsetWeeks = 0): Date {
  const d = new Date();
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1) + 6;
  d.setUTCDate(diff + offsetWeeks * 7);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

function startOfMonth(offsetMonths = 0): Date {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + offsetMonths, 1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function endOfMonth(offsetMonths = 0): Date {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + offsetMonths + 1, 0);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

/** Parses offsets like -7d, 2w, +3h, -1M, 1y relative to now. Returns null when the text is not an offset. */
export function parseRelativeDate(text: string, now = new Date()): Date | null {
  const m = /^([+-]?)(\d+)([smhdwMy])$/.exec(text.trim());
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const n = Number(m[2]) * sign;
  const d = new Date(now.getTime());
  switch (m[3]) {
    case 's': d.setUTCSeconds(d.getUTCSeconds() + n); break;
    case 'm': d.setUTCMinutes(d.getUTCMinutes() + n); break;
    case 'h': d.setUTCHours(d.getUTCHours() + n); break;
    case 'd': d.setUTCDate(d.getUTCDate() + n); break;
    case 'w': d.setUTCDate(d.getUTCDate() + 7 * n); break;
    case 'M': d.setUTCMonth(d.getUTCMonth() + n); break;
    case 'y': d.setUTCFullYear(d.getUTCFullYear() + n); break;
  }
  return d;
}

function resolveNameToId(
  field: string,
  rawValue: string | number | boolean | Date | number[] | null,
  ctx: JQLContext,
): number | string | boolean | Date | number[] | null {
  if (rawValue === null || typeof rawValue === 'boolean') return rawValue;

  const f = field.toLowerCase();
  const MAX_INT = 2147483647;
  const ID_COLUMNS = new Set(['id', 'status', 'priority', 'issuetype', 'project', 'assignee', 'reporter', 'resolution']);
  const DATE_COLUMNS = new Set(['created', 'updated', 'resolved', 'resolutiondate', 'duedate']);
  if (typeof rawValue === 'number') {
    // A bare number must never reach a typed column unchecked (integer overflow / invalid timestamp = HTTP 500).
    if (DATE_COLUMNS.has(f)) {
      const d = new Date(rawValue);
      if (Number.isNaN(d.getTime())) throw new JQLError(`Date value '${rawValue}' is not valid for field '${field}'`);
      return d as any;
    }
    if (ID_COLUMNS.has(f)) return Number.isInteger(rawValue) && rawValue >= 1 && rawValue <= MAX_INT ? rawValue : -1;
    return rawValue;
  }

  const s = String(rawValue).toLowerCase();

  // These columns are integer ids. A name that matches nothing must not reach SQL as a string
  // (that raises a database error); an id that can never exist simply matches no rows.
  const NO_MATCH = -1;
  const toId = (map: Record<string, number> | undefined): number | string | boolean | null => {
    const hit = map?.[s];
    if (hit !== undefined) return hit;
    return /^\d{1,10}$/.test(String(rawValue)) && Number(rawValue) <= MAX_INT ? Number(rawValue) : NO_MATCH;
  };

  switch (f) {
    case 'status': return toId(ctx.statusNames);
    case 'priority': return toId(ctx.priorityNames);
    case 'issuetype': return toId(ctx.issueTypeNames);
    case 'project': return toId({ ...ctx.projectNames, ...ctx.projectKeys });
    case 'assignee':
    case 'reporter': return toId(ctx.userNames);
    // Jira: `resolution = Unresolved` means "has no resolution" (the callers turn null into IS NULL / IS NOT NULL)
    case 'resolution': return s === 'unresolved' ? null : toId(ctx.resolutionNames);
    case 'created':
    case 'updated':
    case 'resolved':
    case 'resolutiondate':
    case 'duedate': {
      // Timestamp columns need Date objects; a bare string would crash the driver.
      if (String(rawValue) === '') return null;
      const d = rawValue instanceof Date ? rawValue : (parseRelativeDate(String(rawValue)) ?? new Date(String(rawValue)));
      if (Number.isNaN(d.getTime())) throw new JQLError(`Date value '${rawValue}' is not valid for field '${field}'`);
      return d as any;
    }
    default: return rawValue;
  }
}

/** `~` / `!~` only make sense for text columns; on id/timestamp columns they would be a database type error. */
function requireTextColumn(field: string, operator: string): void {
  if (!['summary', 'description', 'environment', 'key', 'issuekey'].includes(field)) {
    throw new JQLError(`Operator ${operator} is not supported for field '${field}'`);
  }
}

/**
 * Issue-set functions: they stand for a set of issues and are used with `key` / `id`:
 *   key in linkedIssues("ABC-1")            every issue linked to ABC-1
 *   key in linkedIssues("ABC-1", "blocks")  issues ABC-1 blocks (link type name, or its inward / outward sentence)
 *   key in blockedBy("ABC-1")               issues that block ABC-1
 *   key in blocking("ABC-1")                issues ABC-1 blocks
 *   key in subtasksOf("ABC-1")              children of ABC-1
 *   key in issuesWithoutParent()            issues that have no parent
 * They compile to a sub-select (no extra round trip); the search scope still limits results to browsable projects.
 */
const SET_FUNCTIONS = new Set(['linkedissues', 'blockedby', 'blocking', 'subtasksof', 'issueswithoutparent']);

function keyArg(val: Extract<JQLValue, { type: 'function' }>, ctx: JQLContext): string {
  if (!val.args.length) throw new JQLError(`${val.name}() needs an issue key, e.g. ${val.name}("ABC-1")`);
  const v = resolveScalarValue(val.args[0], ctx);
  if (typeof v !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(v)) throw new JQLError(`${val.name}() needs an issue key like ABC-1`);
  return v.toUpperCase();
}

function issueSetSql(val: Extract<JQLValue, { type: 'function' }>, ctx: JQLContext): SQL {
  const name = val.name.toLowerCase();
  if (name === 'issueswithoutparent') return sql`(SELECT i.id FROM issues i WHERE i.parent_id IS NULL)`;
  const key = keyArg(val, ctx);
  const self = sql`(SELECT k.id FROM issues k WHERE k.issue_key = ${key})`;
  if (name === 'subtasksof') return sql`(SELECT c.id FROM issues c WHERE c.parent_id = ${self})`;
  // issue_links(issue_id, linked_issue_id): issue_id shows the INWARD sentence ("is blocked by"), linked_issue_id the OUTWARD one ("blocks").
  const inwardSide = (typeCond: SQL | null) => sql`SELECT l.linked_issue_id AS id FROM issue_links l JOIN link_types t ON t.id = l.link_type_id WHERE l.issue_id = ${self}${typeCond ? sql` AND ${typeCond}` : sql``}`;
  const outwardSide = (typeCond: SQL | null) => sql`SELECT l.issue_id AS id FROM issue_links l JOIN link_types t ON t.id = l.link_type_id WHERE l.linked_issue_id = ${self}${typeCond ? sql` AND ${typeCond}` : sql``}`;
  if (name === 'blockedby') return sql`(${inwardSide(sql`(LOWER(t.inward) = 'is blocked by' OR LOWER(t.name) = 'blocks')`)})`;
  if (name === 'blocking') return sql`(${outwardSide(sql`(LOWER(t.outward) = 'blocks' OR LOWER(t.name) = 'blocks')`)})`;
  // linkedIssues(KEY [, type])
  if (val.args.length > 1) {
    const t = resolveScalarValue(val.args[1], ctx);
    if (typeof t !== 'string' || !t.trim()) throw new JQLError('linkedIssues() link type must be text, e.g. "blocks"');
    const lower = t.trim().toLowerCase();
    return sql`(${inwardSide(sql`(LOWER(t.name) = ${lower} OR LOWER(t.inward) = ${lower})`)} UNION ${outwardSide(sql`(LOWER(t.name) = ${lower} OR LOWER(t.outward) = ${lower})`)})`;
  }
  return sql`(SELECT l.linked_issue_id AS id FROM issue_links l WHERE l.issue_id = ${self} UNION SELECT l.issue_id AS id FROM issue_links l WHERE l.linked_issue_id = ${self})`;
}

function buildIssueSetCondition(operator: JQLOperator, value: Extract<JQLValue, { type: 'function' }>, ctx: JQLContext): SQL {
  const set = issueSetSql(value, ctx);
  switch (operator) {
    case '=':
    case 'IN':
      return sql`${schema.issues.id} IN ${set}`;
    case '!=':
    case 'NOT IN':
      return sql`${schema.issues.id} NOT IN ${set}`;
    default:
      throw new JQLError(`Operator ${operator} is not supported with ${value.name}(); use IN or NOT IN`);
  }
}

/**
 * A custom field written the Jira way: `customfield_10042` / `cf[10042]` (Jira's id, remembered from the import, else the id here) or
 * by its name. Returns the `customfield_<id here>` spelling, or null when the text is not a custom field.
 */
export function resolveCustomFieldAlias(field: string, ctx: JQLContext): string | null {
  const m = /^customfield_(\d+)$/i.exec(field)
  if (m) {
    const n = Number(m[1])
    return `customfield_${ctx.customFieldJiraIds?.[n] ?? n}`
  }
  if (VALID_FIELDS.has(field.toLowerCase())) return null
  const byName = ctx.customFieldNames?.[field.toLowerCase()]
  return byName !== undefined ? `customfield_${byName}` : null
}

function buildCondition(field: string, operator: JQLOperator, value: JQLValue, ctx: JQLContext): SQL {
  { const alias = resolveCustomFieldAlias(field, ctx); if (alias) field = alias }
  // Jira spells the field `component`; the autocomplete suggests it, so accept it as an alias of `components`.
  if (field.toLowerCase() === 'component') field = 'components';
  validateField(field);
  if (field.toLowerCase() === 'sprint') return buildSprintCondition(operator, value, ctx);
  if (field.toLowerCase() === 'watcher' || field.toLowerCase() === 'voter') return buildUserSetCondition(field.toLowerCase() as 'watcher' | 'voter', operator, value, ctx);
  if (value.type === 'function' && SET_FUNCTIONS.has(value.name.toLowerCase())) {
    const lf = field.toLowerCase();
    if (lf !== 'key' && lf !== 'id') throw new JQLError(`${value.name}() can only be used with the key or id field`);
    return buildIssueSetCondition(operator, value, ctx);
  }
  if (field.toLowerCase() === 'flagged') return buildFlaggedCondition(operator, value, ctx);
  const col = resolveFieldColumn(field);

  if (col?.isCustomField) {
    return buildCustomFieldCondition(col.fieldId, operator, value, ctx);
  }

  const f = field.toLowerCase();

  // Full-text search on 'text' field
  if (f === 'text') {
    const raw = resolveScalarValue(value, ctx);
    const term = raw === null ? '' : String(raw);
    if (operator === '~') {
      return or(
        ilike(schema.issues.summary, `%${term}%`),
        ilike(schema.issues.description, `%${term}%`),
      ) as SQL;
    }
    if (operator === '!~') {
      return and(
        notIlike(schema.issues.summary, `%${term}%`),
        notIlike(schema.issues.description, `%${term}%`),
      ) as SQL;
    }
    throw new JQLError(`Operator ${operator} not supported for text field`);
  }

  if (f === 'parent') return buildParentCondition(operator, value, ctx);
  if (f === 'level') return buildLevelCondition(operator, value, ctx);

  // Multi-value relational fields: labels, components, fixVersion
  if (f === 'labels' || f === 'components' || f === 'fixversion' || f === 'milestone') {
    return buildRelationalCondition(f, operator, value, ctx);
  }

  switch (operator) {
    case '=': {
      const scalar = resolveFunctionValue(value, ctx);
      const resolvedId = resolveNameToId(field, scalar, ctx);
      if (resolvedId === null) return isNull(col);
      return eq(col, resolvedId);
    }
    case '!=': {
      const scalar = resolveFunctionValue(value, ctx);
      const resolvedId = resolveNameToId(field, scalar, ctx);
      if (resolvedId === null) return isNotNull(col);
      return ne(col, resolvedId);
    }
    case '>': {
      const scalar = resolveFunctionValue(value, ctx);
      const resolvedId = resolveNameToId(field, scalar, ctx);
      return gt(col, resolvedId);
    }
    case '<': {
      const scalar = resolveFunctionValue(value, ctx);
      const resolvedId = resolveNameToId(field, scalar, ctx);
      return lt(col, resolvedId);
    }
    case '>=': {
      const scalar = resolveFunctionValue(value, ctx);
      const resolvedId = resolveNameToId(field, scalar, ctx);
      return gte(col, resolvedId);
    }
    case '<=': {
      const scalar = resolveFunctionValue(value, ctx);
      const resolvedId = resolveNameToId(field, scalar, ctx);
      return lte(col, resolvedId);
    }
    case '~': {
      requireTextColumn(f, operator);
      const scalar = resolveFunctionValue(value, ctx);
      const resolvedId = resolveNameToId(field, scalar, ctx);
      return ilike(col, `%${resolvedId}%`);
    }
    case '!~': {
      requireTextColumn(f, operator);
      const scalar = resolveFunctionValue(value, ctx);
      const resolvedId = resolveNameToId(field, scalar, ctx);
      return notIlike(col, `%${resolvedId}%`);
    }
    case 'IS': {
      if (value.type === 'empty' || value.type === 'null') return isNull(col);
      const scalar = resolveFunctionValue(value, ctx);
      const resolvedId = resolveNameToId(field, scalar, ctx);
      return eq(col, resolvedId);
    }
    case 'IS NOT': {
      if (value.type === 'empty' || value.type === 'null') return isNotNull(col);
      const scalar = resolveFunctionValue(value, ctx);
      const resolvedId = resolveNameToId(field, scalar, ctx);
      return ne(col, resolvedId);
    }
    case 'IN': {
      const list = resolveList(value, ctx).map((v) => resolveNameToId(field, v, ctx));
      const valid = list.filter((v): v is number | string => v !== null);
      if (valid.length === 0) return sql`1=0`;
      return inArray(col, valid);
    }
    case 'NOT IN': {
      const list = resolveList(value, ctx).map((v) => resolveNameToId(field, v, ctx));
      const valid = list.filter((v): v is number | string => v !== null);
      if (valid.length === 0) return sql`1=1`;
      return notInArray(col, valid);
    }
    case 'WAS':
      return buildWasCondition(field, operator, value, ctx);
    case 'WAS IN':
      return buildWasCondition(field, operator, value, ctx);
    case 'WAS NOT IN':
      return buildWasCondition(field, operator, value, ctx);
    case 'CHANGED':
      return buildChangedCondition(field, value, ctx);
    default:
      throw new JQLError(`Unsupported operator: ${operator}`);
  }
}

/**
 * flagged = true | false | Impediment, flagged is EMPTY (not flagged), flagged is not EMPTY (flagged), flagged in (...).
 * "Impediment" is Jira's value for a flagged issue, so filters imported from Jira keep working.
 */
const scalarNode = (v: string | number | boolean | null): JQLValue =>
  v === null ? { type: 'null' } : typeof v === 'boolean' ? { type: 'boolean', value: v } : { type: 'string', value: String(v) };

function buildFlaggedCondition(operator: JQLOperator, value: JQLValue, ctx: JQLContext): SQL {
  const col = schema.issues.flagged;
  const truthy = (v: JQLValue): boolean => {
    if (v.type === 'empty' || v.type === 'null') return false;
    const raw = resolveScalarValue(v, ctx);
    if (typeof raw === 'boolean') return raw;
    const t = String(raw).trim().toLowerCase();
    if (['true', 'yes', 'impediment', '1'].includes(t)) return true;
    if (['false', 'no', '0', ''].includes(t)) return false;
    throw new JQLError(`Invalid value for flagged: ${raw}. Use true, false or Impediment`);
  };
  switch (operator) {
    case '=':
    case 'IS':
      return truthy(value) ? eq(col, true) : eq(col, false);
    case '!=':
    case 'IS NOT':
      return truthy(value) ? eq(col, false) : eq(col, true);
    case 'IN': {
      const list = resolveList(value, ctx).map((v) => truthy(scalarNode(v)));
      if (list.includes(true) && list.includes(false)) return sql`1=1`;
      return list.includes(true) ? eq(col, true) : eq(col, false);
    }
    case 'NOT IN': {
      const list = resolveList(value, ctx).map((v) => truthy(scalarNode(v)));
      if (list.includes(true) && list.includes(false)) return sql`1=0`;
      return list.includes(true) ? eq(col, false) : eq(col, true);
    }
    default:
      throw new JQLError(`Operator ${operator} is not supported for field 'flagged'`);
  }
}

type ScalarList = (string | number | boolean | null)[];

/** sprint = 12, sprint = "Sprint 3", sprint in (1, 2), sprint is EMPTY, sprint in openSprints() */
function buildSprintCondition(operator: JQLOperator, value: JQLValue, ctx: JQLContext): SQL {
  const si = schema.sprintIssues;
  const issueIdCol = schema.issues.id;
  const noSprint = sql`NOT EXISTS (SELECT 1 FROM ${si} WHERE ${si.issueId} = ${issueIdCol})`;
  const anySprint = sql`EXISTS (SELECT 1 FROM ${si} WHERE ${si.issueId} = ${issueIdCol})`;

  const matches = (vals: ScalarList): SQL | null => {
    const ids = vals.filter((v): v is number => typeof v === 'number');
    const names: string[] = [];
    for (const v of vals) {
      if (typeof v !== 'string') continue;
      if (/^\d+$/.test(v)) ids.push(Number(v));
      else names.push(v.toLowerCase());
    }
    const parts: SQL[] = [];
    if (ids.length) parts.push(sql`${si.sprintId} IN ${ids}`);
    if (names.length) parts.push(sql`${si.sprintId} IN (SELECT ${schema.sprints.id} FROM ${schema.sprints} WHERE LOWER(${schema.sprints.name}) IN ${names})`);
    if (!parts.length) return null;
    const cond = parts.length === 1 ? parts[0] : sql`(${parts[0]} OR ${parts[1]})`;
    return sql`EXISTS (SELECT 1 FROM ${si} WHERE ${si.issueId} = ${issueIdCol} AND ${cond})`;
  };

  const isEmpty = value.type === 'empty' || value.type === 'null';
  switch (operator) {
    case 'IS':
      return isEmpty ? noSprint : anySprint;
    case 'IS NOT':
      return isEmpty ? anySprint : noSprint;
    case '=':
    case 'IN': {
      if (isEmpty) return noSprint;
      const m = matches(resolveList(value, ctx));
      return m ?? sql`1=0`;
    }
    case '!=':
    case 'NOT IN': {
      if (isEmpty) return anySprint;
      const m = matches(resolveList(value, ctx));
      return m ? sql`NOT ${m}` : sql`1=1`;
    }
    default:
      throw new JQLError(`Operator ${operator} not supported for sprint`);
  }
}

/** watcher = currentUser(), watcher in (anna, 5), watcher is EMPTY; `voter` works the same on the votes table. */
function buildUserSetCondition(field: 'watcher' | 'voter', operator: JQLOperator, value: JQLValue, ctx: JQLContext): SQL {
  const t = field === 'watcher' ? schema.watchers : schema.votes;
  const issueIdCol = schema.issues.id;
  const anyRow = sql`EXISTS (SELECT 1 FROM ${t} WHERE ${t.issueId} = ${issueIdCol})`;
  const noRow = sql`NOT EXISTS (SELECT 1 FROM ${t} WHERE ${t.issueId} = ${issueIdCol})`;
  const isEmpty = value.type === 'empty' || value.type === 'null';
  const matches = (): SQL => {
    const ids: number[] = [];
    for (const v of resolveList(value, ctx)) {
      if (v === null || typeof v === 'boolean') continue;
      const id = resolveNameToId('reporter', v, ctx);
      if (typeof id === 'number') ids.push(id);
    }
    if (!ids.length) return sql`1=0`;
    return sql`EXISTS (SELECT 1 FROM ${t} WHERE ${t.issueId} = ${issueIdCol} AND ${t.userId} IN ${ids})`;
  };
  switch (operator) {
    case 'IS': return isEmpty ? noRow : anyRow;
    case 'IS NOT': return isEmpty ? anyRow : noRow;
    case '=':
    case 'IN': return isEmpty ? noRow : matches();
    case '!=':
    case 'NOT IN': return isEmpty ? anyRow : sql`NOT ${matches()}`;
    default: throw new JQLError(`Operator ${operator} is not supported for field '${field}'`);
  }
}

/** parent = DEMO-1 (key) or parent = 42 (id), parent in (...), parent is EMPTY */
/** `level` (issue security level): by name (any scheme) or id; `IS EMPTY` finds issues without a level. The caller's own visibility is applied separately. */
function buildLevelCondition(operator: JQLOperator, value: JQLValue, ctx: JQLContext): SQL {
  const col = schema.issues.securityLevelId;
  const isEmpty = value.type === 'empty' || value.type === 'null';
  const matches = (vals: (string | number | boolean | null)[]): SQL | null => {
    const ids: number[] = [];
    const names: string[] = [];
    for (const v of vals) {
      if (typeof v === 'number') ids.push(v);
      else if (typeof v === 'string' && v !== '') names.push(v.toLowerCase());
    }
    const parts: SQL[] = [];
    if (ids.length) parts.push(sql`${col} IN ${ids}`);
    if (names.length) parts.push(sql`${col} IN (SELECT l.id FROM issue_security_levels l WHERE lower(l.name) IN ${names})`);
    if (!parts.length) return null;
    return parts.length === 1 ? parts[0] : sql`(${parts[0]} OR ${parts[1]})`;
  };
  switch (operator) {
    case 'IS': return isEmpty ? isNull(col) : isNotNull(col);
    case 'IS NOT': return isEmpty ? isNotNull(col) : isNull(col);
    case '=':
    case 'IN': {
      if (isEmpty) return isNull(col);
      return matches(resolveList(value, ctx)) ?? sql`1=0`;
    }
    case '!=':
    case 'NOT IN': {
      if (isEmpty) return isNotNull(col);
      const m = matches(resolveList(value, ctx));
      return m ? sql`(${col} IS NULL OR NOT ${m})` : sql`1=1`;
    }
    default:
      throw new JQLError(`Operator ${operator} not supported for level`);
  }
}

function buildParentCondition(operator: JQLOperator, value: JQLValue, ctx: JQLContext): SQL {
  const col = schema.issues.parentId;
  const isEmpty = value.type === 'empty' || value.type === 'null';

  const matches = (vals: ScalarList): SQL | null => {
    const ids = vals.filter((v): v is number => typeof v === 'number');
    const keys: string[] = [];
    for (const v of vals) {
      if (typeof v !== 'string') continue;
      if (/^\d+$/.test(v)) ids.push(Number(v));
      else keys.push(v.toUpperCase());
    }
    const parts: SQL[] = [];
    if (ids.length) parts.push(sql`${col} IN ${ids}`);
    if (keys.length) parts.push(sql`${col} IN (SELECT p.id FROM issues p WHERE p.issue_key IN ${keys})`);
    if (!parts.length) return null;
    return parts.length === 1 ? parts[0] : sql`(${parts[0]} OR ${parts[1]})`;
  };

  switch (operator) {
    case 'IS':
      return isEmpty ? isNull(col) : isNotNull(col);
    case 'IS NOT':
      return isEmpty ? isNotNull(col) : isNull(col);
    case '=':
    case 'IN': {
      if (isEmpty) return isNull(col);
      return matches(resolveList(value, ctx)) ?? sql`1=0`;
    }
    case '!=':
    case 'NOT IN': {
      if (isEmpty) return isNotNull(col);
      const m = matches(resolveList(value, ctx));
      return m ? sql`(${col} IS NULL OR NOT ${m})` : sql`1=1`;
    }
    default:
      throw new JQLError(`Operator ${operator} not supported for parent`);
  }
}

function resolveList(value: JQLValue, ctx: JQLContext): (string | number | boolean | null)[] {
  if (value.type === 'list') {
    return value.values.map((v) => resolveScalarValue(v, ctx));
  }
  if (value.type === 'function') {
    const result = resolveFunctionValue(value, ctx);
    if (Array.isArray(result)) return result;
    return [result as string | number | boolean | null];   // a function that yields a date is not expected inside a list
  }
  return [resolveScalarValue(value, ctx)];
}

function buildCustomFieldCondition(fieldId: number, operator: JQLOperator, value: JQLValue, ctx: JQLContext): SQL {
  const cfv = schema.customFieldValues;
  const issueIdCol = schema.issues.id;
  const scalar = resolveScalarValue(value, ctx);

  // For custom fields we use a sub-select EXISTS pattern via sql template
  // because Drizzle subqueries for IN/EXISTS are verbose. We build raw sql fragments carefully.
  const resolvedId = resolveNameToId('assignee', scalar, ctx); // reuse user resolution

  let valCol: string;
  if (typeof scalar === 'number') valCol = 'number_value';
  else if (typeof scalar === 'boolean') valCol = 'boolean_value';
  else if (scalar === null) valCol = 'string_value';
  else if (typeof scalar === 'string' && /\d{4}-/.test(scalar)) valCol = 'date_value';
  else valCol = 'string_value';

  switch (operator) {
    case '=': {
      if (scalar === null || scalar === '') {
        return sql`NOT EXISTS (SELECT 1 FROM ${cfv} WHERE ${cfv.issueId} = ${issueIdCol} AND ${cfv.customFieldId} = ${fieldId})`;
      }
      return sql`EXISTS (SELECT 1 FROM ${cfv} WHERE ${cfv.issueId} = ${issueIdCol} AND ${cfv.customFieldId} = ${fieldId} AND ${sql.raw(valCol)} = ${scalar})`;
    }
    case '!=': {
      if (scalar === null || scalar === '') {
        return sql`EXISTS (SELECT 1 FROM ${cfv} WHERE ${cfv.issueId} = ${issueIdCol} AND ${cfv.customFieldId} = ${fieldId})`;
      }
      return sql`NOT EXISTS (SELECT 1 FROM ${cfv} WHERE ${cfv.issueId} = ${issueIdCol} AND ${cfv.customFieldId} = ${fieldId} AND ${sql.raw(valCol)} = ${scalar})`;
    }
    case '~': {
      return sql`EXISTS (SELECT 1 FROM ${cfv} WHERE ${cfv.issueId} = ${issueIdCol} AND ${cfv.customFieldId} = ${fieldId} AND ${cfv.textValue} ILIKE ${`%${scalar}%`})`;
    }
    case '!~': {
      return sql`NOT EXISTS (SELECT 1 FROM ${cfv} WHERE ${cfv.issueId} = ${issueIdCol} AND ${cfv.customFieldId} = ${fieldId} AND ${cfv.textValue} ILIKE ${`%${scalar}%`})`;
    }
    case 'IS': {
      if (value.type === 'empty' || value.type === 'null') {
        return sql`NOT EXISTS (SELECT 1 FROM ${cfv} WHERE ${cfv.issueId} = ${issueIdCol} AND ${cfv.customFieldId} = ${fieldId})`;
      }
      return sql`EXISTS (SELECT 1 FROM ${cfv} WHERE ${cfv.issueId} = ${issueIdCol} AND ${cfv.customFieldId} = ${fieldId} AND ${sql.raw(valCol)} = ${scalar})`;
    }
    case 'IS NOT': {
      if (value.type === 'empty' || value.type === 'null') {
        return sql`EXISTS (SELECT 1 FROM ${cfv} WHERE ${cfv.issueId} = ${issueIdCol} AND ${cfv.customFieldId} = ${fieldId})`;
      }
      return sql`NOT EXISTS (SELECT 1 FROM ${cfv} WHERE ${cfv.issueId} = ${issueIdCol} AND ${cfv.customFieldId} = ${fieldId} AND ${sql.raw(valCol)} = ${scalar})`;
    }
    case 'IN': {
      const list = resolveList(value, ctx);
      if (list.length === 0) return sql`1=0`;
      return sql`EXISTS (SELECT 1 FROM ${cfv} WHERE ${cfv.issueId} = ${issueIdCol} AND ${cfv.customFieldId} = ${fieldId} AND ${sql.raw(valCol)} IN ${list})`;
    }
    case 'NOT IN': {
      const list = resolveList(value, ctx);
      if (list.length === 0) return sql`1=1`;
      return sql`NOT EXISTS (SELECT 1 FROM ${cfv} WHERE ${cfv.issueId} = ${issueIdCol} AND ${cfv.customFieldId} = ${fieldId} AND ${sql.raw(valCol)} IN ${list})`;
    }
    default:
      throw new JQLError(`Unsupported operator for custom field: ${operator}`);
  }
}

function buildRelationalCondition(field: string, operator: JQLOperator, value: JQLValue, ctx: JQLContext): SQL {
  const issueIdCol = schema.issues.id;
  const f = field.toLowerCase();

  let joinTable: any;
  let joinCol: any;
  let lookupTable: any;
  let lookupCol: any;
  let lookupIdCol: any;

  if (f === 'labels') {
    joinTable = schema.issueLabels;
    joinCol = schema.issueLabels.labelId;
    lookupTable = schema.labels;
    lookupCol = schema.labels.name;
    lookupIdCol = schema.labels.id;
  } else if (f === 'components') {
    joinTable = schema.issueComponents;
    joinCol = schema.issueComponents.componentId;
    lookupTable = schema.components;
    lookupCol = schema.components.name;
    lookupIdCol = schema.components.id;
  } else if (f === 'fixversion') {
    joinTable = schema.issueFixVersions;
    joinCol = schema.issueFixVersions.versionId;
    lookupTable = schema.versions;
    lookupCol = schema.versions.name;
    lookupIdCol = schema.versions.id;
  } else if (f === 'milestone') {
    joinTable = schema.milestoneIssues;
    joinCol = schema.milestoneIssues.milestoneId;
    lookupTable = schema.milestones;
    lookupCol = schema.milestones.name;
    lookupIdCol = schema.milestones.id;
  } else {
    throw new JQLError(`Unknown relational field: ${field}`);
  }

  const scalar = value.type === 'list' ? null : resolveScalarValue(value, ctx); // lists are handled by IN / NOT IN
  const term = scalar === null ? '' : String(scalar).toLowerCase();

  switch (operator) {
    case '=': {
      return sql`EXISTS (SELECT 1 FROM ${joinTable} INNER JOIN ${lookupTable} ON ${joinCol} = ${lookupIdCol} WHERE ${joinTable.issueId} = ${issueIdCol} AND LOWER(${lookupCol}) = ${term})`;
    }
    case '!=': {
      return sql`NOT EXISTS (SELECT 1 FROM ${joinTable} INNER JOIN ${lookupTable} ON ${joinCol} = ${lookupIdCol} WHERE ${joinTable.issueId} = ${issueIdCol} AND LOWER(${lookupCol}) = ${term})`;
    }
    case 'IS':
    case 'IS NOT': {
      const empty = value.type === 'empty' || value.type === 'null';
      if ((operator === 'IS' && empty) || (operator === 'IS NOT' && !empty)) {
        return sql`NOT EXISTS (SELECT 1 FROM ${joinTable} WHERE ${joinTable.issueId} = ${issueIdCol})`;
      }
      return sql`EXISTS (SELECT 1 FROM ${joinTable} WHERE ${joinTable.issueId} = ${issueIdCol})`;
    }
    case 'IN': {
      const list = resolveList(value, ctx).map((v) => (v === null ? '' : String(v).toLowerCase()));
      if (list.length === 0) return sql`1=0`;
      return sql`EXISTS (SELECT 1 FROM ${joinTable} INNER JOIN ${lookupTable} ON ${joinCol} = ${lookupIdCol} WHERE ${joinTable.issueId} = ${issueIdCol} AND LOWER(${lookupCol}) IN ${list})`;
    }
    case 'NOT IN': {
      const list = resolveList(value, ctx).map((v) => (v === null ? '' : String(v).toLowerCase()));
      if (list.length === 0) return sql`1=1`;
      return sql`NOT EXISTS (SELECT 1 FROM ${joinTable} INNER JOIN ${lookupTable} ON ${joinCol} = ${lookupIdCol} WHERE ${joinTable.issueId} = ${issueIdCol} AND LOWER(${lookupCol}) IN ${list})`;
    }
    case '~': {
      return sql`EXISTS (SELECT 1 FROM ${joinTable} INNER JOIN ${lookupTable} ON ${joinCol} = ${lookupIdCol} WHERE ${joinTable.issueId} = ${issueIdCol} AND LOWER(${lookupCol}) LIKE ${`%${term}%`})`;
    }
    default:
      throw new JQLError(`Operator ${operator} not supported for ${field}`);
  }
}

function buildWasCondition(field: string, operator: string, value: JQLValue, ctx: JQLContext): SQL {
  const issueIdCol = schema.issues.id;
  const hist = schema.issueHistory;
  const f = field.toLowerCase();
  const histFieldName = f === 'status' ? 'status' : f;
  const raw = resolveScalarValue(value, ctx);
  const term = raw === null ? null : String(raw);

  if (operator === 'WAS') {
    return sql`EXISTS (SELECT 1 FROM ${hist} WHERE ${hist.issueId} = ${issueIdCol} AND ${hist.fieldName} = ${histFieldName} AND ${hist.oldValue} = ${term})`;
  }
  if (operator === 'WAS IN') {
    const list = resolveList(value, ctx).map((v) => (v === null ? null : String(v)));
    if (list.length === 0) return sql`1=0`;
    return sql`EXISTS (SELECT 1 FROM ${hist} WHERE ${hist.issueId} = ${issueIdCol} AND ${hist.fieldName} = ${histFieldName} AND ${hist.oldValue} IN ${list})`;
  }
  if (operator === 'WAS NOT IN') {
    const list = resolveList(value, ctx).map((v) => (v === null ? null : String(v)));
    if (list.length === 0) return sql`1=1`;
    return sql`NOT EXISTS (SELECT 1 FROM ${hist} WHERE ${hist.issueId} = ${issueIdCol} AND ${hist.fieldName} = ${histFieldName} AND ${hist.oldValue} IN ${list})`;
  }
  return sql`1=1`;
}

function buildChangedCondition(field: string, value: JQLValue, ctx: JQLContext): SQL {
  const issueIdCol = schema.issues.id;
  const hist = schema.issueHistory;
  const f = field.toLowerCase();
  const histFieldName = f === 'status' ? 'status' : f;

  if ((value as { type: string }).type !== 'changed') {   // `value` is the whole 'changed' node when called from the AST, a plain value otherwise
    return sql`EXISTS (SELECT 1 FROM ${hist} WHERE ${hist.issueId} = ${issueIdCol} AND ${hist.fieldName} = ${histFieldName})`;
  }

  const node = value as any;
  let conditions: SQL[] = [
    sql`${hist.issueId} = ${issueIdCol}`,
    sql`${hist.fieldName} = ${histFieldName}`,
  ];

  if (node.from) {
    const fromVal = String(resolveScalarValue(node.from, ctx));
    conditions.push(sql`${hist.oldValue} = ${fromVal}`);
  }
  if (node.to) {
    const toVal = String(resolveScalarValue(node.to, ctx));
    conditions.push(sql`${hist.newValue} = ${toVal}`);
  }
  if (node.during) {
    const start = resolveScalarValue(node.during[0], ctx);
    const end = resolveScalarValue(node.during[1], ctx);
    conditions.push(sql`${hist.createdAt} BETWEEN ${new Date(String(start))} AND ${new Date(String(end))}`);
  }

  // Build a single exists subquery with concatenated conditions
  // Using raw sql to combine because drizzle doesn't easily variadic AND raw sql
  return sql`EXISTS (SELECT 1 FROM ${hist} WHERE ${sql.join(conditions, sql` AND `)})`;
}

function translateNode(node: JQLNode, ctx: JQLContext): SQL {
  switch (node.type) {
    case 'and': {
      const clauses = node.clauses.map((c) => translateNode(c, ctx));
      return and(...clauses) as SQL;
    }
    case 'or': {
      const clauses = node.clauses.map((c) => translateNode(c, ctx));
      return or(...clauses) as SQL;
    }
    case 'not': {
      const inner = translateNode(node.clause, ctx);
      // Logical NOT in SQL via NOT(...)
      return sql`NOT (${inner})`;
    }
    case 'condition': {
      return buildCondition(node.field, node.operator, node.value, ctx);
    }
    case 'changed': {
      return buildChangedCondition(node.field, { ...node } as any, ctx);
    }
    case 'query': {
      if (node.where) return translateNode(node.where, ctx);
      return sql`1=1`;
    }
    default:
      throw new JQLError(`Unknown node type`);
  }
}

export function translateJQL(node: JQLNode, ctx: JQLContext = {}): JQLResult {
  let where: SQL | undefined;
  const orderBy: SQL[] = [];

  if (node.type === 'query') {
    if (node.where) {
      where = translateNode(node.where, ctx);
    }
    for (const ob of node.orderBy) {
      const col = resolveOrderColumn(ob.field);
      orderBy.push(ob.direction === 'DESC' ? desc(col) : asc(col));
    }
  } else {
    where = translateNode(node, ctx);
  }

  return node.type === 'query' && node.limit !== undefined ? { where, orderBy, limit: node.limit } : { where, orderBy };
}
