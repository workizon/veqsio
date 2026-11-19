/**
 * Switchable features of the core product. An administrator can turn a feature off for the whole instance:
 * its API routes then answer 404 and the web app hides its menu entries. Everything is on by default, and the
 * data is never touched, so switching a feature back on restores it exactly as it was.
 * Paid modules (Timesheets, Plans, ITSM) are switched with the module list instead (`/rest/api/2/modules`).
 */
import { eq } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { createMiddleware } from 'hono/factory';
import { db } from '../db';

export interface FeatureDef {
  id: string;
  name: string;
  description: string;
  /** API paths that are closed while the feature is off */
  paths: RegExp[];
  /** other features or modules that stop working properly without this one */
  note?: string;
  /** can also be turned off for a single project (the project key is found in the request path) */
  projectScoped?: boolean;
}

export const FEATURES: readonly FeatureDef[] = [
  { id: 'servicedesk', name: 'Service Desk', description: 'Customer portal, request queues, SLAs, knowledge base and the service desk API.', paths: [/^\/rest\/servicedeskapi\//], note: 'The ITSM module needs it.' },
  { id: 'dashboards', name: 'Dashboards', description: 'Personal and shared dashboards with gadgets.', paths: [/^\/rest\/api\/2\/dashboard/] },
  { id: 'automation', name: 'Automation', description: 'Rules with triggers, conditions and actions.', paths: [/^\/rest\/api\/2\/automation/] },
  { id: 'approvals', projectScoped: true, name: 'Approvals', description: 'Approval requests on issues and the "My approvals" page.', paths: [/^\/rest\/api\/2\/approval/, /^\/rest\/api\/2\/issue\/[^/]+\/approval/, /^\/rest\/api\/2\/project\/[^/]+\/approval-template/] },
  { id: 'roadmap', projectScoped: true, name: 'Roadmap', description: 'The timeline roadmap of a project.', paths: [/^\/rest\/agile\/1\.0\/(project\/[^/]+\/)?roadmap/] },
  { id: 'worklogs', projectScoped: true, name: 'Time tracking', description: 'Work logs on issues.', paths: [/^\/rest\/api\/2\/worklog/, /^\/rest\/api\/2\/issue\/[^/]+\/worklog/], note: 'The Timesheets module needs it.' },
  { id: 'git', projectScoped: true, name: 'Git integrations', description: 'GitHub, GitLab, Gitea and Bitbucket repositories, development panel on issues and smart commits.', paths: [/^\/rest\/webhooks\/scm\//, /^\/rest\/api\/2\/project\/[^/]+\/repositories/, /^\/rest\/api\/2\/issue\/[^/]+\/development/] },
  { id: 'intake', projectScoped: true, name: 'Intake / triage', description: 'Per-project intake queue, public intake form and email intake; submissions become issues when accepted.', paths: [/^\/rest\/api\/2\/project\/[^/]+\/intake/, /^\/rest\/api\/2\/intake\//, /^\/rest\/public\/intake\//] },
  { id: 'reactions', projectScoped: true, name: 'Comment reactions', description: 'Emoji reactions on comments.', paths: [/^\/rest\/api\/2\/issue\/[^/]+\/comment\/[^/]+\/reaction/] },
  { id: 'updates', projectScoped: true, name: 'Status updates', description: 'On track / At risk / Off track updates on projects and epics, with history and a badge on the project.', paths: [/^\/rest\/api\/2\/project\/[^/]+\/status-updates/, /^\/rest\/api\/2\/issue\/[^/]+\/status-updates/, /^\/rest\/api\/2\/status-updates\//] },
  { id: 'pages', name: 'Wiki / Pages', description: 'Wiki pages in the workspace and in projects, with version history, comments and search.', paths: [/^\/rest\/api\/2\/pages(\/|$)/] },
  { id: 'views', name: 'Views', description: 'Saved views (list, table, board, calendar, timeline) with grouping, sharing and CSV / XLSX / JSON export.', paths: [/^\/rest\/api\/2\/views(\/|$)/] },
  { id: 'initiatives', name: 'Initiatives', description: 'Workspace-level initiatives that group epics and projects, with rolled-up progress, health and a timeline.', paths: [/^\/rest\/api\/2\/initiatives(\/|$)/] },
  { id: 'milestones', projectScoped: true, name: 'Milestones', description: 'Project milestones with a target date and linked issues, shown on the roadmap and in the issue sidebar.', paths: [/^\/rest\/api\/2\/project\/[^/]+\/milestones/, /^\/rest\/api\/2\/issue\/[^/]+\/milestones/] },
  { id: 'agents', name: 'AI agents', description: 'Agent service accounts that can be assigned and mentioned, signed run triggers, the per-issue run log and the agent run API.', paths: [/^\/rest\/api\/2\/admin\/agents/, /^\/rest\/api\/2\/agent-runs/, /^\/rest\/api\/2\/issue\/[^/]+\/agent-runs/, /^\/rest\/api\/2\/project\/[^/]+\/agents/], note: 'Agents stop being triggered while it is off; their users and tokens are kept.' },
  { id: 'integrations', projectScoped: true, name: 'Integrations', description: 'Inbound webhooks (alerts, CI, Sentry) that create and update issues, and Slack / Microsoft Teams notification channels.', paths: [/^\/rest\/api\/2\/webhooks\/inbound\//, /^\/rest\/api\/2\/project\/[^/]+\/inbound-sources/, /^\/rest\/api\/2\/project\/[^/]+\/notification-channels/, /^\/rest\/api\/2\/admin\/notification-channels/], note: 'Inbound sources answer 404 and chat channels stay silent while it is off; their configuration is kept.' },
];

const SETTING_KEY = 'features.disabled';
let cache: { at: number; disabled: Set<string> } | null = null;
const TTL_MS = 5_000;

export function invalidateFeatures() { cache = null; }

export async function disabledFeatures(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.disabled;
  const [row] = await db.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, SETTING_KEY)).limit(1);
  let ids: string[] = [];
  try { const v = JSON.parse(row?.value ?? '[]'); if (Array.isArray(v)) ids = v.filter((x) => typeof x === 'string'); } catch { /* corrupted value: everything stays on */ }
  cache = { at: Date.now(), disabled: new Set(ids.filter((id) => FEATURES.some((f) => f.id === id))) };
  return cache.disabled;
}

export async function setFeatureEnabled(id: string, enabled: boolean): Promise<boolean> {
  if (!FEATURES.some((f) => f.id === id)) return false;
  const next = new Set(await disabledFeatures());
  if (enabled) next.delete(id); else next.add(id);
  const value = JSON.stringify([...next]);
  const [existing] = await db.select({ id: schema.systemSettings.id }).from(schema.systemSettings).where(eq(schema.systemSettings.key, SETTING_KEY)).limit(1);
  if (existing) await db.update(schema.systemSettings).set({ value, updatedAt: new Date() }).where(eq(schema.systemSettings.key, SETTING_KEY));
  else await db.insert(schema.systemSettings).values({ key: SETTING_KEY, value });
  invalidateFeatures();
  return true;
}

export function featureOfPath(path: string): FeatureDef | undefined {
  return FEATURES.find((f) => f.paths.some((re) => re.test(path)));
}

/** Project key of a request path, when the path belongs to one project (project/:key/... or issue/KEY-n/...). */
export function projectKeyOfPath(path: string): string | null {
  const m = /^\/rest\/(?:api\/2|agile\/1\.0)\/project\/([^/]+)/.exec(path);
  if (m) return decodeURIComponent(m[1]).toUpperCase();
  const i = /^\/rest\/api\/2\/issue\/([A-Za-z][A-Za-z0-9_]*)-\d+/.exec(path);
  return i ? i[1].toUpperCase() : null;
}

const projectCache = new Map<string, { at: number; off: Set<string> }>();
export function invalidateProjectFeatures() { projectCache.clear(); }

export async function projectDisabledFeatures(projectKey: string): Promise<Set<string>> {
  const hit = projectCache.get(projectKey);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.off;
  const [row] = await db.select({ off: schema.projects.disabledFeatures }).from(schema.projects).where(eq(schema.projects.projectKey, projectKey)).limit(1);
  const off = new Set((row?.off ?? []).filter((id) => FEATURES.some((f) => f.id === id && f.projectScoped)));
  projectCache.set(projectKey, { at: Date.now(), off });
  return off;
}

/** Answers 404 for the API routes of a switched-off feature. */
export function featureGate() {
  return createMiddleware(async (c, next) => {
    const f = featureOfPath(c.req.path);
    if (f && (await disabledFeatures()).has(f.id)) {
      return c.json({ errorMessages: [`${f.name} is switched off on this instance`] }, 404);
    }
    if (f?.projectScoped) {
      const key = projectKeyOfPath(c.req.path);
      if (key && (await projectDisabledFeatures(key)).has(f.id)) {
        return c.json({ errorMessages: [`${f.name} is switched off for this project`] }, 404);
      }
    }
    await next();
  });
}
