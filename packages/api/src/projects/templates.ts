/**
 * Project templates ("Software", "Kanban", ...) and "copy settings from an existing project".
 * Both only ADD configuration to a freshly created project, inside the caller's transaction. Statuses, workflows and
 * permission schemes stay with the instance defaults that createProjectWithDefaults already attached.
 */
import { and, asc, eq, ilike, inArray } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import type { db } from '../db';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface TemplateIssueDef { name: string; issueType: string; summaryPattern: string; body: string; labels?: string[]; components?: string[] }
export interface ProjectTemplateDef {
  id: 'software' | 'kanban' | 'business' | 'bug';
  name: string;
  description: string;
  board: { name: string; type: 'scrum' | 'kanban' };
  components: string[];
  versions: string[];
  issueTemplates: TemplateIssueDef[];
}

export const PROJECT_TEMPLATES: readonly ProjectTemplateDef[] = [
  {
    id: 'software', name: 'Software (Scrum)', description: 'Sprints, a backlog and a first version. Templates for bugs, user stories and technical tasks.',
    board: { name: 'Scrum board', type: 'scrum' }, components: [], versions: ['1.0'],
    issueTemplates: [
      { name: 'Bug report', issueType: 'Bug', summaryPattern: '', body: '## Steps to reproduce\n1. \n\n## Expected result\n\n## Actual result\n\n## Environment\n', labels: ['bug'] },
      { name: 'User story', issueType: 'Story', summaryPattern: 'As a <user>, I want <goal>', body: '## Story\nAs a ..., I want ..., so that ...\n\n## Acceptance criteria\n- [ ] \n' },
      { name: 'Technical task', issueType: 'Task', summaryPattern: '', body: '## What and why\n\n## Done when\n- [ ] \n' },
    ],
  },
  {
    id: 'kanban', name: 'Kanban', description: 'A continuous-flow board without sprints. Templates for tasks and bugs.',
    board: { name: 'Kanban board', type: 'kanban' }, components: [], versions: [],
    issueTemplates: [
      { name: 'Task', issueType: 'Task', summaryPattern: '', body: '## What needs to be done\n\n## Done when\n- [ ] \n' },
      { name: 'Bug report', issueType: 'Bug', summaryPattern: '', body: '## What happened\n\n## What should have happened\n\n## How to reproduce\n', labels: ['bug'] },
    ],
  },
  {
    id: 'business', name: 'Business / task tracking', description: 'Plain task tracking for teams outside software: a simple board and checklist-style templates.',
    board: { name: 'Task board', type: 'kanban' }, components: [], versions: [],
    issueTemplates: [
      { name: 'Task', issueType: 'Task', summaryPattern: '', body: '## Goal\n\n## Steps\n- [ ] \n\n## Due\n' },
      { name: 'Request', issueType: 'Task', summaryPattern: 'Request: ', body: '## What is needed\n\n## Why\n\n## By when\n', labels: ['request'] },
    ],
  },
  {
    id: 'bug', name: 'Bug tracking', description: 'Triage-focused: components for the usual areas and a detailed bug report template.',
    board: { name: 'Bug triage', type: 'kanban' }, components: ['Frontend', 'Backend', 'Infrastructure'], versions: [],
    issueTemplates: [
      { name: 'Bug report', issueType: 'Bug', summaryPattern: '', body: '## Summary\n\n## Steps to reproduce\n1. \n\n## Expected result\n\n## Actual result\n\n## Version / environment\n\n## Severity and impact\n', labels: ['bug'] },
      { name: 'Regression', issueType: 'Bug', summaryPattern: 'Regression: ', body: '## Worked in version\n\n## Broke in version\n\n## Steps to reproduce\n1. \n', labels: ['bug', 'regression'] },
    ],
  },
];

export const findProjectTemplate = (id: string) => PROJECT_TEMPLATES.find((t) => t.id === id);

export interface ApplyReport { board: string | null; components: number; versions: number; issueTemplates: number; skippedTemplates: string[]; roleActors: number }
export const emptyReport = (): ApplyReport => ({ board: null, components: 0, versions: 0, issueTemplates: 0, skippedTemplates: [], roleActors: 0 });

async function addComponents(tx: Tx, projectId: number, items: Array<{ name: string; description?: string | null; leadId?: number | null }>): Promise<number> {
  const have = new Set((await tx.select({ n: schema.components.name }).from(schema.components).where(eq(schema.components.projectId, projectId))).map((r) => r.n.toLowerCase()));
  const rows = items.filter((i) => !have.has(i.name.toLowerCase()));
  if (rows.length) await tx.insert(schema.components).values(rows.map((r) => ({ projectId, name: r.name, description: r.description ?? null, leadId: r.leadId ?? null })));
  return rows.length;
}

async function addVersions(tx: Tx, projectId: number, items: Array<{ name: string; description?: string | null }>): Promise<number> {
  const have = new Set((await tx.select({ n: schema.versions.name }).from(schema.versions).where(eq(schema.versions.projectId, projectId))).map((r) => r.n.toLowerCase()));
  const rows = items.filter((i) => !have.has(i.name.toLowerCase()));
  if (rows.length) await tx.insert(schema.versions).values(rows.map((r) => ({ projectId, name: r.name, description: r.description ?? null })));
  return rows.length;
}

export async function applyProjectTemplate(tx: Tx, project: { id: number; name: string }, templateId: string, createdBy: number, report: ApplyReport): Promise<void> {
  const t = findProjectTemplate(templateId);
  if (!t) throw new Error(`Unknown project template: ${templateId}`);

  // Board with one column per status, grouped To Do / In Progress / Done (the instance's statuses; none are invented).
  const statuses = await tx.select().from(schema.statuses).orderBy(asc(schema.statuses.id));
  const order: Record<string, number> = { todo: 0, in_progress: 1, done: 2 };
  const sorted = [...statuses].sort((a, b) => (order[a.category ?? 'todo'] ?? 1) - (order[b.category ?? 'todo'] ?? 1) || a.id - b.id).slice(0, 12);
  const [board] = await tx.insert(schema.boards).values({ name: t.board.name, type: t.board.type, projectId: project.id, config: {} }).returning();
  if (sorted.length) await tx.insert(schema.boardColumns).values(sorted.map((s, i) => ({ boardId: board.id, statusId: s.id, name: s.name, sortOrder: i })));
  report.board = `${t.board.name} (${t.board.type})`;

  report.components += await addComponents(tx, project.id, t.components.map((name) => ({ name })));
  report.versions += await addVersions(tx, project.id, t.versions.map((name) => ({ name })));

  const types = await tx.select().from(schema.issueTypes);
  for (const it of t.issueTemplates) {
    const type = types.find((x) => x.name.toLowerCase() === it.issueType.toLowerCase()) ?? types.find((x) => !x.isSubtask);
    if (!type) { report.skippedTemplates.push(it.name); continue; }
    await tx.insert(schema.issueTemplates).values({
      projectId: project.id, name: it.name, issueTypeId: type.id, summaryPattern: it.summaryPattern, body: it.body, labels: it.labels ?? [],
      componentNames: it.components ?? [], customFields: [], createdBy,
    });
    report.issueTemplates++;
  }
}

export interface CopyOptions { components?: boolean; versions?: boolean; issueTemplates?: boolean; roleActors?: boolean }

/** What a copy would bring over, for the preview in the create dialog. */
export async function previewCopy(sourceProjectId: number, q: Pick<Tx, 'select'>) {
  const [components, versions, templates, actors] = await Promise.all([
    q.select({ name: schema.components.name }).from(schema.components).where(eq(schema.components.projectId, sourceProjectId)).orderBy(asc(schema.components.name)),
    q.select({ name: schema.versions.name }).from(schema.versions).where(eq(schema.versions.projectId, sourceProjectId)).orderBy(asc(schema.versions.name)),
    q.select({ name: schema.issueTemplates.name }).from(schema.issueTemplates).where(eq(schema.issueTemplates.projectId, sourceProjectId)).orderBy(asc(schema.issueTemplates.name)),
    q.select({ roleId: schema.projectRoleActors.roleId, role: schema.projectRoles.name }).from(schema.projectRoleActors)
      .innerJoin(schema.projectRoles, eq(schema.projectRoles.id, schema.projectRoleActors.roleId)).where(eq(schema.projectRoleActors.projectId, sourceProjectId)),
  ]);
  const roles = new Map<string, number>();
  for (const a of actors) roles.set(a.role, (roles.get(a.role) ?? 0) + 1);
  return {
    components: components.map((c) => c.name), versions: versions.map((v) => v.name), issueTemplates: templates.map((t) => t.name),
    roleActors: [...roles.entries()].map(([role, actors]) => ({ role, actors })),
  };
}

export async function copyProjectSettings(tx: Tx, sourceId: number, target: { id: number }, opts: CopyOptions, report: ApplyReport): Promise<void> {
  if (opts.components) {
    const rows = await tx.select().from(schema.components).where(eq(schema.components.projectId, sourceId));
    report.components += await addComponents(tx, target.id, rows.map((r) => ({ name: r.name, description: r.description, leadId: r.leadId })));
  }
  if (opts.versions) {
    // Names and descriptions only: dates and the released/archived state belong to the source project's history.
    const rows = await tx.select().from(schema.versions).where(and(eq(schema.versions.projectId, sourceId)));
    report.versions += await addVersions(tx, target.id, rows.filter((r) => !r.archived).map((r) => ({ name: r.name, description: r.description })));
  }
  if (opts.issueTemplates) {
    const rows = await tx.select().from(schema.issueTemplates).where(eq(schema.issueTemplates.projectId, sourceId));
    const have = new Set((await tx.select({ n: schema.issueTemplates.name }).from(schema.issueTemplates).where(eq(schema.issueTemplates.projectId, target.id))).map((r) => r.n.toLowerCase()));
    for (const r of rows) {
      if (have.has(r.name.toLowerCase())) continue;
      const { id: _id, projectId: _p, createdAt: _c, updatedAt: _u, ...rest } = r;
      await tx.insert(schema.issueTemplates).values({ ...rest, projectId: target.id });
      report.issueTemplates++;
    }
  }
  if (opts.roleActors) {
    const rows = await tx.select().from(schema.projectRoleActors).where(eq(schema.projectRoleActors.projectId, sourceId));
    const existing = await tx.select().from(schema.projectRoleActors).where(eq(schema.projectRoleActors.projectId, target.id));
    const seen = new Set(existing.map((a) => `${a.roleId}:${a.userId ?? ''}:${a.groupId ?? ''}`));
    for (const a of rows) {
      const k = `${a.roleId}:${a.userId ?? ''}:${a.groupId ?? ''}`;
      if (seen.has(k)) continue;
      await tx.insert(schema.projectRoleActors).values({ projectId: target.id, roleId: a.roleId, userId: a.userId, groupId: a.groupId });
      seen.add(k); report.roleActors++;
    }
  }
}
