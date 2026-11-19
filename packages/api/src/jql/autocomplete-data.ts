/**
 * Static JQL autocomplete metadata (fields, functions, reserved words),
 * shaped like Jira's /rest/api/2/jql/autocompletedata response.
 */

export interface AutocompleteField {
  value: string;
  displayName: string;
  orderable: 'true' | 'false';
  searchable: 'true' | 'false';
  auto?: 'true';
  cfid?: string;
  operators: string[];
  types: string[];
}

export interface AutocompleteFunction {
  value: string;
  displayName: string;
  isList?: 'true';
  types: string[];
}

const EQ_OPS = ['=', '!=', 'in', 'not in', 'is', 'is not'];
const TEXT_OPS = ['~', '!~', 'is', 'is not'];
const CMP_OPS = ['=', '!=', '>', '>=', '<', '<=', 'in', 'not in', 'is', 'is not'];
const HISTORY_OPS = ['was', 'was in', 'was not in', 'changed'];

function f(
  value: string,
  displayName: string,
  type: string,
  operators: string[],
  opts: { orderable?: boolean; auto?: boolean; history?: boolean } = {},
): AutocompleteField {
  const field: AutocompleteField = {
    value,
    displayName,
    orderable: opts.orderable === false ? 'false' : 'true',
    searchable: 'true',
    operators: opts.history ? [...operators, ...HISTORY_OPS] : operators,
    types: [type],
  };
  if (opts.auto) field.auto = 'true';
  return field;
}

export const AUTOCOMPLETE_FIELDS: AutocompleteField[] = [
  f('assignee', 'assignee', 'com.atlassian.jira.user.ApplicationUser', EQ_OPS, { auto: true, history: true }),
  f('component', 'component', 'com.atlassian.jira.bc.project.component.ProjectComponent', EQ_OPS, { auto: true, orderable: false }),
  f('created', 'created', 'java.util.Date', CMP_OPS, {}),
  f('description', 'description', 'java.lang.String', TEXT_OPS, { orderable: true }),
  f('duedate', 'dueDate', 'java.util.Date', CMP_OPS, {}),
  f('fixversion', 'fixVersion', 'com.atlassian.jira.project.version.Version', EQ_OPS, { auto: true, orderable: false }),
  f('flagged', 'Flagged', 'com.atlassian.jira.issue.fields.FlaggedField', EQ_OPS, { orderable: true }),
  f('milestone', 'milestone', 'java.lang.String', EQ_OPS, { orderable: false }),
  f('id', 'id', 'java.lang.Long', CMP_OPS, {}),
  f('issuekey', 'issueKey', 'com.atlassian.jira.issue.Issue', CMP_OPS, {}),
  f('issuetype', 'issueType', 'com.atlassian.jira.issue.issuetype.IssueType', EQ_OPS, { auto: true, history: true }),
  f('key', 'key', 'com.atlassian.jira.issue.Issue', CMP_OPS, {}),
  f('labels', 'labels', 'java.lang.String', EQ_OPS, { auto: true, orderable: false }),
  f('level', 'level', 'com.atlassian.jira.issue.security.IssueSecurityLevel', EQ_OPS, { auto: true, orderable: false }),
  f('parent', 'parent', 'com.atlassian.jira.issue.Issue', EQ_OPS, {}),
  f('priority', 'priority', 'com.atlassian.jira.issue.priority.Priority', EQ_OPS, { auto: true, history: true }),
  f('project', 'project', 'com.atlassian.jira.project.Project', EQ_OPS, { auto: true, history: true }),
  f('voter', 'voter', 'com.atlassian.jira.user.ApplicationUser', EQ_OPS, { auto: true, orderable: false }),
  f('watcher', 'watcher', 'com.atlassian.jira.user.ApplicationUser', EQ_OPS, { auto: true, orderable: false }),
  f('reporter', 'reporter', 'com.atlassian.jira.user.ApplicationUser', EQ_OPS, { auto: true, history: true }),
  f('resolution', 'resolution', 'com.atlassian.jira.issue.resolution.Resolution', EQ_OPS, { auto: true, history: true }),
  f('resolved', 'resolved', 'java.util.Date', CMP_OPS, {}),
  f('status', 'status', 'com.atlassian.jira.issue.status.Status', EQ_OPS, { auto: true, history: true }),
  f('summary', 'summary', 'java.lang.String', TEXT_OPS, {}),
  f('text', 'text', 'java.lang.String', ['~', '!~'], { orderable: false }),
  f('updated', 'updated', 'java.util.Date', CMP_OPS, {}),
];

export const AUTOCOMPLETE_FUNCTIONS: AutocompleteFunction[] = [
  { value: 'currentUser()', displayName: 'currentUser()', types: ['com.atlassian.jira.user.ApplicationUser'] },
  { value: 'membersOf("group")', displayName: 'membersOf()', isList: 'true', types: ['com.atlassian.jira.user.ApplicationUser'] },
  { value: 'openSprints()', displayName: 'openSprints()', isList: 'true', types: ['com.atlassian.greenhopper.service.sprint.Sprint'] },
  { value: 'closedSprints()', displayName: 'closedSprints()', isList: 'true', types: ['com.atlassian.greenhopper.service.sprint.Sprint'] },
  { value: 'linkedIssues("KEY-1", "blocks")', displayName: 'linkedIssues()', isList: 'true', types: ['com.atlassian.jira.issue.Issue'] },
  { value: 'blockedBy("KEY-1")', displayName: 'blockedBy()', isList: 'true', types: ['com.atlassian.jira.issue.Issue'] },
  { value: 'blocking("KEY-1")', displayName: 'blocking()', isList: 'true', types: ['com.atlassian.jira.issue.Issue'] },
  { value: 'subtasksOf("KEY-1")', displayName: 'subtasksOf()', isList: 'true', types: ['com.atlassian.jira.issue.Issue'] },
  { value: 'issuesWithoutParent()', displayName: 'issuesWithoutParent()', isList: 'true', types: ['com.atlassian.jira.issue.Issue'] },
  { value: 'now()', displayName: 'now()', types: ['java.util.Date'] },
  { value: 'startOfDay()', displayName: 'startOfDay()', types: ['java.util.Date'] },
  { value: 'endOfDay()', displayName: 'endOfDay()', types: ['java.util.Date'] },
  { value: 'startOfWeek()', displayName: 'startOfWeek()', types: ['java.util.Date'] },
  { value: 'endOfWeek()', displayName: 'endOfWeek()', types: ['java.util.Date'] },
  { value: 'startOfMonth()', displayName: 'startOfMonth()', types: ['java.util.Date'] },
  { value: 'endOfMonth()', displayName: 'endOfMonth()', types: ['java.util.Date'] },
];

export const JQL_RESERVED_WORDS = [
  'and', 'or', 'not', 'in', 'is', 'was', 'were', 'changed', 'from', 'to', 'during', 'by',
  'order', 'asc', 'desc', 'empty', 'null',
];

/** Fields whose values can be suggested by the suggestions endpoint. */
export const SUGGESTIBLE_FIELDS = new Set([
  'assignee', 'reporter', 'status', 'priority', 'issuetype', 'project',
  'resolution', 'component', 'components', 'fixversion', 'labels',
]);

/** Case-insensitive substring match; prefix matches are sorted first. */
export function filterAndRank<T extends { displayName: string }>(items: T[], query: string, limit: number): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice(0, limit);
  const starts: T[] = [];
  const contains: T[] = [];
  for (const it of items) {
    const n = it.displayName.toLowerCase();
    if (n.startsWith(q)) starts.push(it);
    else if (n.includes(q)) contains.push(it);
  }
  return [...starts, ...contains].slice(0, limit);
}
