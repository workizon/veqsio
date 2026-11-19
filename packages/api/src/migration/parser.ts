import { createReadStream } from 'fs';
import { Readable } from 'stream';
import { XMLParser } from 'fast-xml-parser';
import { createInterface } from 'readline';

// Jira entity types we care about
export const ENTITY_TAGS = [
  'User',
  'Group',
  'GroupRelation',
  'Membership',
  'Project',
  'Issue',
  'Action',
  'FileAttachment',
  'Workflow',
  'WorkflowTransition',
  'CustomField',
  'CustomFieldValue',
  'IssueLink',
  'Component',
  'Version',
  'SearchRequest',
  'PortalPage',
  'PermissionScheme',
  'Permission',
  'IssueType',
  'Status',
  'Priority',
  'Resolution',
  'Label',
  'IssueLabel',
  'ProjectCategory',
  'ProjectRole',
  'ProjectRoleActor',
  'Board',
  'Sprint',
  'SprintIssue',
  'Watchers',
  'Vote',
  'IssueComponent',
  'IssueFixVersion',
  'IssueAffectsVersion',
] as const;

export type EntityTag = (typeof ENTITY_TAGS)[number];

export interface ParsedEntity {
  tag: EntityTag;
  attributes: Record<string, string | number | boolean | undefined>;
  textContent?: string;
  children?: Record<string, string>;
}

export interface BackupStats {
  users: number;
  groups: number;
  memberships: number;
  projects: number;
  issues: number;
  comments: number;
  attachments: number;
  workflows: number;
  workflowTransitions: number;
  customFields: number;
  customFieldValues: number;
  issueLinks: number;
  components: number;
  versions: number;
  filters: number;
  dashboards: number;
  permissionSchemes: number;
  permissionEntries: number;
  issueTypes: number;
  statuses: number;
  priorities: number;
  resolutions: number;
  labels: number;
  issueLabels: number;
  projectCategories: number;
  projectRoles: number;
  projectRoleActors: number;
  boards: number;
  sprints: number;
  sprintIssues: number;
  watchers: number;
  votes: number;
  issueComponents: number;
  issueFixVersions: number;
  issueAffectsVersions: number;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: true,
  trimValues: true,
  alwaysCreateTextNode: false,
  parseTagValue: false,
});

function normalizeAttributes(
  raw: Record<string, unknown>
): Record<string, string | number | boolean | undefined> {
  const out: Record<string, string | number | boolean | undefined> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'boolean' || typeof v === 'number') {
      out[k] = v;
    } else {
      out[k] = String(v);
    }
  }
  return out;
}

function extractTagAndAttributes(xmlFragment: string): ParsedEntity | null {
  try {
    // fast-xml-parser expects a root element; wrap fragment
    const wrapped = `<root>${xmlFragment}</root>`;
    const parsed = parser.parse(wrapped);
    if (!parsed || typeof parsed !== 'object') return null;

    const root = parsed.root;
    if (!root || typeof root !== 'object') return null;

    const keys = Object.keys(root);
    if (keys.length === 0) return null;

    const tag = keys[0] as EntityTag;
    if (!ENTITY_TAGS.includes(tag)) return null;

    const value = root[tag];
    if (value === undefined || value === null) {
      return { tag, attributes: {} };
    }

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return { tag, attributes: { value } };
    }

    const attrs = normalizeAttributes(value as Record<string, unknown>);

    // Extract text child nodes (e.g. <body>text</body> becomes { body: "text" } in attrs sometimes)
    // fast-xml-parser puts text nodes under #text key when alwaysCreateTextNode is false
    const children: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string') {
        children[k] = v;
      } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        const nested = v as Record<string, unknown>;
        if ('#text' in nested && typeof nested['#text'] === 'string') {
          children[k] = nested['#text'];
        }
      }
    }

    return { tag, attributes: attrs, children };
  } catch {
    return null;
  }
}

export async function* streamEntities(xmlPath: string): AsyncGenerator<ParsedEntity, void, unknown> {
  const fileStream = createReadStream(xmlPath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  let buffer = '';
  const MAX_BUFFER = 10 * 1024 * 1024; // 10MB safety limit per entity

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('<?xml') || trimmed === '<entity-engine-xml>' || trimmed === '</entity-engine-xml>') {
      continue;
    }

    // If the line is a self-contained element (starts with < and ends with >)
    if (trimmed.startsWith('<') && (trimmed.endsWith('/>') || trimmed.endsWith('>'))) {
      // Could be complete on this line, or could be start of multi-line element
      if (trimmed.endsWith('/>')) {
        const entity = extractTagAndAttributes(trimmed);
        if (entity) yield entity;
        continue;
      }

      // Check if it's a closing tag line like </Action>
      if (/^<\/[A-Za-z_][\w]*>\s*$/.test(trimmed)) {
        buffer += trimmed;
        const entity = extractTagAndAttributes(buffer);
        if (entity) yield entity;
        buffer = '';
        continue;
      }

      // Start accumulating multi-line element
      buffer = trimmed;
      continue;
    }

    // Continuation of a multi-line element
    if (buffer) {
      buffer += '\n' + trimmed;
      if (buffer.length > MAX_BUFFER) {
        throw new Error(`Entity buffer exceeded ${MAX_BUFFER} bytes — malformed XML?`);
      }
      if (trimmed.endsWith('>')) {
        const entity = extractTagAndAttributes(buffer);
        if (entity) yield entity;
        buffer = '';
      }
    }
  }

  rl.close();
  fileStream.destroy();
}

export async function analyzeBackup(xmlPath: string): Promise<BackupStats> {
  const stats: BackupStats = {
    users: 0,
    groups: 0,
    memberships: 0,
    projects: 0,
    issues: 0,
    comments: 0,
    attachments: 0,
    workflows: 0,
    workflowTransitions: 0,
    customFields: 0,
    customFieldValues: 0,
    issueLinks: 0,
    components: 0,
    versions: 0,
    filters: 0,
    dashboards: 0,
    permissionSchemes: 0,
    permissionEntries: 0,
    issueTypes: 0,
    statuses: 0,
    priorities: 0,
    resolutions: 0,
    labels: 0,
    issueLabels: 0,
    projectCategories: 0,
    projectRoles: 0,
    projectRoleActors: 0,
    boards: 0,
    sprints: 0,
    sprintIssues: 0,
    watchers: 0,
    votes: 0,
    issueComponents: 0,
    issueFixVersions: 0,
    issueAffectsVersions: 0,
  };

  for await (const entity of streamEntities(xmlPath)) {
    switch (entity.tag) {
      case 'User':
        stats.users++;
        break;
      case 'Group':
        stats.groups++;
        break;
      case 'GroupRelation':
      case 'Membership':
        stats.memberships++;
        break;
      case 'Project':
        stats.projects++;
        break;
      case 'Issue':
        stats.issues++;
        break;
      case 'Action':
        stats.comments++;
        break;
      case 'FileAttachment':
        stats.attachments++;
        break;
      case 'Workflow':
        stats.workflows++;
        break;
      case 'WorkflowTransition':
        stats.workflowTransitions++;
        break;
      case 'CustomField':
        stats.customFields++;
        break;
      case 'CustomFieldValue':
        stats.customFieldValues++;
        break;
      case 'IssueLink':
        stats.issueLinks++;
        break;
      case 'Component':
        stats.components++;
        break;
      case 'Version':
        stats.versions++;
        break;
      case 'SearchRequest':
        stats.filters++;
        break;
      case 'PortalPage':
        stats.dashboards++;
        break;
      case 'PermissionScheme':
        stats.permissionSchemes++;
        break;
      case 'Permission':
        stats.permissionEntries++;
        break;
      case 'IssueType':
        stats.issueTypes++;
        break;
      case 'Status':
        stats.statuses++;
        break;
      case 'Priority':
        stats.priorities++;
        break;
      case 'Resolution':
        stats.resolutions++;
        break;
      case 'Label':
        stats.labels++;
        break;
      case 'IssueLabel':
        stats.issueLabels++;
        break;
      case 'ProjectCategory':
        stats.projectCategories++;
        break;
      case 'ProjectRole':
        stats.projectRoles++;
        break;
      case 'ProjectRoleActor':
        stats.projectRoleActors++;
        break;
      case 'Board':
        stats.boards++;
        break;
      case 'Sprint':
        stats.sprints++;
        break;
      case 'SprintIssue':
        stats.sprintIssues++;
        break;
      case 'Watchers':
        stats.watchers++;
        break;
      case 'Vote':
        stats.votes++;
        break;
      case 'IssueComponent':
        stats.issueComponents++;
        break;
      case 'IssueFixVersion':
        stats.issueFixVersions++;
        break;
      case 'IssueAffectsVersion':
        stats.issueAffectsVersions++;
        break;
    }
  }

  return stats;
}

// Issue key helpers
const ISSUE_KEY_REGEX = /^([A-Z][A-Z0-9]*)-(\d+)$/;

export function parseIssueKey(issueKey: string): { projectKey: string; number: number } | null {
  const m = issueKey.match(ISSUE_KEY_REGEX);
  if (!m) return null;
  return { projectKey: m[1], number: parseInt(m[2], 10) };
}

export function buildIssueKey(projectKey: string, number: number): string {
  return `${projectKey}-${number}`;
}
