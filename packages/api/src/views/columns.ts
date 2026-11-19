/**
 * Column definitions shared by the view executor and the exporters (pure).
 * A cell value is a string, number, null or a list of strings (labels, components, ...).
 */
import type { ColumnId } from './config';
import type { GroupableIssue } from './grouping';

export type CellValue = string | number | null | string[];

export const COLUMN_LABELS: Record<ColumnId, string> = {
  key: 'Key', summary: 'Summary', type: 'Type', status: 'Status', priority: 'Priority', assignee: 'Assignee',
  reporter: 'Reporter', project: 'Project', labels: 'Labels', components: 'Components', fixVersions: 'Fix versions',
  sprint: 'Sprint', storyPoints: 'Story points', created: 'Created', updated: 'Updated', resolved: 'Resolved',
  resolution: 'Resolution', duedate: 'Due date', startdate: 'Start date',
};

const names = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String((x as any)?.name ?? x)) : []);

export function columnValue(issue: GroupableIssue, col: ColumnId): CellValue {
  const f = issue.fields ?? {};
  switch (col) {
    case 'key': return issue.key;
    case 'summary': return f.summary ?? null;
    case 'type': return f.issuetype?.name ?? null;
    case 'status': return f.status?.name ?? null;
    case 'priority': return f.priority?.name ?? null;
    case 'assignee': return f.assignee?.displayName ?? null;
    case 'reporter': return f.reporter?.displayName ?? null;
    case 'project': return f.project?.key ?? null;
    case 'labels': return Array.isArray(f.labels) ? f.labels.map(String) : [];
    case 'components': return names(f.components);
    case 'fixVersions': return names(f.fixVersions);
    case 'sprint': return f.sprint?.name ?? null;
    case 'storyPoints': return typeof f.storyPoints === 'number' ? f.storyPoints : null;
    case 'created': return f.created ?? null;
    case 'updated': return f.updated ?? null;
    case 'resolved': return f.resolved ?? null;
    case 'resolution': return f.resolution?.name ?? null;
    case 'duedate': return f.duedate ?? null;
    case 'startdate': return f.startdate ?? null;
  }
}
