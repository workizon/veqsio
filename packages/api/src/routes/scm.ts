import { Hono } from 'hono';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { and, eq, inArray, desc, sql } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import type { AppContext } from '../auth/middleware';
import { requirePermission, requireIssueAccess, checkProjectPermission } from '../middleware/permissions';
import { encryptSecret, decryptSecret } from '../auth/secrets';
import { getAvailableTransitions, doTransition } from '../workflow/engine';
import { assertPublicUrl } from '../plugins/ssrf';
import { PROVIDERS, extractIssueKeys, parseSmartCommits, parseWebhook, verifyWebhook, type Provider, type ScmEvent } from '../scm/parse';
import { branchUrl, createBranch, ScmError, suggestBranchName, validBranchName } from '../scm/providers';
import { publishIssueById } from '../realtime/publish';

const app = new Hono<AppContext>();

app.use('/rest/api/2/project/*/repositories*', sessionMiddleware);
app.use('/rest/api/2/issue/*/development*', sessionMiddleware);
app.use('/rest/api/2/project/*/versions/*/release-notes', sessionMiddleware);

import { issueVisibleSql } from '../security/issue-security';

type Repo = typeof schema.scmRepositories.$inferSelect;
const publicRepo = (r: Repo) => ({ id: r.id, projectId: r.projectId, provider: r.provider, baseUrl: r.baseUrl || null, name: r.name, defaultBranch: r.defaultBranch, hasToken: !!r.accessTokenEnc, createdAt: r.createdAt });

function webhookUrl(c: any, r: Repo, secret: string): string {
  const base = (process.env.PUBLIC_URL || process.env.BASE_URL || new URL(c.req.url).origin).replace(/\/+$/, '');
  return `${base}/rest/webhooks/scm/${r.id}${r.provider === 'bitbucket' ? `?token=${secret}` : ''}`;
}

async function getIssue(idOrKey: string) {
  const isNum = /^\d{1,9}$/.test(idOrKey);
  const [row] = await db.select({ id: schema.issues.id, key: schema.issues.issueKey, summary: schema.issues.summary, projectId: schema.issues.projectId })
    .from(schema.issues).where(isNum ? eq(schema.issues.id, Number(idOrKey)) : eq(schema.issues.issueKey, idOrKey.toUpperCase())).limit(1);
  return row;
}

async function projectByKey(key: string) {
  const [p] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, key)).limit(1);
  return p;
}

const repoBody = z.object({
  provider: z.enum(PROVIDERS as unknown as [Provider, ...Provider[]]),
  name: z.string().trim().min(3).max(255).regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/, 'name must look like owner/repo'),
  baseUrl: z.string().trim().url().max(500).nullable().optional(),
  defaultBranch: z.string().trim().min(1).max(255).optional(),
  accessToken: z.string().min(1).max(500).nullable().optional(),
}).strict();

app.get('/rest/api/2/project/:key/repositories', requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  const p = await projectByKey(c.req.param('key'));
  if (!p) return c.json({ errorMessages: ['Project not found'] }, 404);
  const rows = await db.select().from(schema.scmRepositories).where(eq(schema.scmRepositories.projectId, p.id)).orderBy(schema.scmRepositories.id);
  return c.json(rows.map(publicRepo));
});

app.post('/rest/api/2/project/:key/repositories', requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  const p = await projectByKey(c.req.param('key'));
  if (!p) return c.json({ errorMessages: ['Project not found'] }, 404);
  const parsed = repoBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ errorMessages: parsed.error.issues.map((i) => i.message) }, 400);
  const b = parsed.data;
  if (b.provider === 'gitea' && !b.baseUrl) return c.json({ errorMessages: ['baseUrl is required for Gitea'] }, 400);
  if (b.baseUrl) {
    try { await assertPublicUrl(b.baseUrl); } catch (e: any) { return c.json({ errorMessages: [e.message || 'baseUrl is not allowed'] }, 400); }
  }
  const secret = randomBytes(24).toString('base64url');
  try {
    const [row] = await db.insert(schema.scmRepositories).values({
      projectId: p.id, provider: b.provider, baseUrl: b.baseUrl ? b.baseUrl.replace(/\/+$/, '') : '', name: b.name,
      defaultBranch: b.defaultBranch ?? 'main', webhookSecretEnc: encryptSecret(secret),
      accessTokenEnc: b.accessToken ? encryptSecret(b.accessToken) : null, createdBy: c.get('user')!.id,
    }).returning();
    // The secret is shown once, together with the URL to paste into the provider's webhook settings.
    return c.json({ ...publicRepo(row), webhookUrl: webhookUrl(c, row, secret), webhookSecret: secret }, 201);
  } catch (e: any) {
    if (String(e?.cause?.code ?? e?.code) === '23505') return c.json({ errorMessages: ['This repository is already linked'] }, 409);
    throw e;
  }
});

app.post('/rest/api/2/project/:key/repositories/:id/rotate-secret', requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  const p = await projectByKey(c.req.param('key'));
  const id = Number(c.req.param('id'));
  if (!p || !Number.isInteger(id)) return c.json({ errorMessages: ['Repository not found'] }, 404);
  const secret = randomBytes(24).toString('base64url');
  const [row] = await db.update(schema.scmRepositories).set({ webhookSecretEnc: encryptSecret(secret) })
    .where(and(eq(schema.scmRepositories.id, id), eq(schema.scmRepositories.projectId, p.id))).returning();
  if (!row) return c.json({ errorMessages: ['Repository not found'] }, 404);
  return c.json({ ...publicRepo(row), webhookUrl: webhookUrl(c, row, secret), webhookSecret: secret });
});

app.delete('/rest/api/2/project/:key/repositories/:id', requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  const p = await projectByKey(c.req.param('key'));
  const id = Number(c.req.param('id'));
  if (!p || !Number.isInteger(id)) return c.json({ errorMessages: ['Repository not found'] }, 404);
  const res = await db.delete(schema.scmRepositories).where(and(eq(schema.scmRepositories.id, id), eq(schema.scmRepositories.projectId, p.id))).returning({ id: schema.scmRepositories.id });
  if (!res.length) return c.json({ errorMessages: ['Repository not found'] }, 404);
  return c.json({});
});

/* ----------------------------- webhook ingestion ----------------------------- */

async function applySmartCommits(repo: Repo, ev: ScmEvent, issueByKey: Map<string, { id: number; key: string }>) {
  if (!ev.message || !ev.authorEmail) return;
  const cmds = parseSmartCommits(ev.message).filter((cm) => issueByKey.has(cm.key));
  if (!cmds.length) return;
  // Only act for a known user with the right permission on the project; otherwise the commit is just linked.
  const [user] = await db.select().from(schema.users).where(and(sql`lower(${schema.users.email}) = ${ev.authorEmail.toLowerCase()}`, eq(schema.users.active, true))).limit(1);
  if (!user) return;
  for (const cm of cmds) {
    const issue = issueByKey.get(cm.key)!;
    try {
      if (cm.comment && (await checkProjectPermission(user, repo.projectId, 'ADD_COMMENTS'))) {
        await db.insert(schema.comments).values({ issueId: issue.id, body: cm.comment, authorId: user.id });
        publishIssueById('comment.added', issue.id, user.id);
      }
      if (cm.transition && (await checkProjectPermission(user, repo.projectId, 'TRANSITION_ISSUES'))) {
        const available = await getAvailableTransitions(issue.id, user.id);
        const wanted = cm.transition.toLowerCase();
        const t = available.find((a: any) => a.name.toLowerCase() === wanted || a.to?.name?.toLowerCase() === wanted)
          ?? (wanted === 'done' ? available.find((a: any) => a.to?.statusCategory === 'done') : undefined);
        if (t) await doTransition(issue.id, t.id, user.id, {}, {});
      }
    } catch (e) {
      console.error('[scm] smart commit failed:', (e as Error).message);
    }
  }
}

export async function ingestScmEvents(repo: Repo, events: ScmEvent[]): Promise<{ linked: number }> {
  let linked = 0;
  const allKeys = [...new Set(events.flatMap((e) => extractIssueKeys(...e.texts)))];
  const issues = allKeys.length
    ? await db.select({ id: schema.issues.id, key: schema.issues.issueKey }).from(schema.issues)
        .where(and(inArray(schema.issues.issueKey, allKeys), eq(schema.issues.projectId, repo.projectId)))
    : [];
  const issueByKey = new Map(issues.map((i) => [i.key, i]));

  for (const ev of events) {
    if (ev.kind === 'build') {
      await db.update(schema.scmLinks).set({ buildStatus: ev.status ?? null, updatedAt: new Date() })
        .where(and(eq(schema.scmLinks.repositoryId, repo.id), eq(schema.scmLinks.branch, ev.ref)));
      const touched = await db.selectDistinct({ id: schema.scmLinks.issueId }).from(schema.scmLinks).where(and(eq(schema.scmLinks.repositoryId, repo.id), eq(schema.scmLinks.branch, ev.ref)));
      for (const t of touched) publishIssueById('issue.updated', t.id, 0);
      continue;
    }
    const keys = extractIssueKeys(...ev.texts).filter((k) => issueByKey.has(k));
    for (const k of keys) {
      const issue = issueByKey.get(k)!;
      const values = {
        repositoryId: repo.id, issueId: issue.id, kind: ev.kind, ref: ev.ref.slice(0, 255), branch: ev.branch?.slice(0, 255) ?? null,
        title: ev.title ?? null, url: ev.url ?? (ev.kind === 'branch' ? branchUrl(repo as any, ev.ref) : null), status: ev.status ?? null, author: ev.author ?? null,
      };
      const inserted = await db.insert(schema.scmLinks).values(values).onConflictDoNothing().returning({ id: schema.scmLinks.id });
      if (inserted.length) {
        linked++;
        // Smart commits run once, on the first delivery of a commit (webhook retries are idempotent).
        if (ev.kind === 'commit') await applySmartCommits(repo, ev, new Map([[k, issue]]));
      } else {
        await db.update(schema.scmLinks).set({ title: values.title, url: values.url, status: values.status, updatedAt: new Date() })
          .where(and(eq(schema.scmLinks.repositoryId, repo.id), eq(schema.scmLinks.issueId, issue.id), eq(schema.scmLinks.kind, ev.kind), eq(schema.scmLinks.ref, values.ref)));
      }
      publishIssueById('issue.updated', issue.id, 0);
    }
  }
  return { linked };
}

// Public by design: authenticated by the per-repository signature or token, never by a session.
app.post('/rest/webhooks/scm/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ errorMessages: ['Not found'] }, 404);
  const [repo] = await db.select().from(schema.scmRepositories).where(eq(schema.scmRepositories.id, id)).limit(1);
  if (!repo) return c.json({ errorMessages: ['Not found'] }, 404);
  const raw = await c.req.text();
  if (raw.length > 5_000_000) return c.json({ errorMessages: ['Payload too large'] }, 413);
  let secret: string;
  try { secret = decryptSecret(repo.webhookSecretEnc); } catch { return c.json({ errorMessages: ['Webhook secret unavailable'] }, 500); }
  if (!verifyWebhook(repo.provider as Provider, (n) => c.req.header(n), raw, secret, c.req.query('token'))) {
    return c.json({ errorMessages: ['Invalid signature'] }, 401);
  }
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return c.json({ errorMessages: ['Invalid JSON'] }, 400); }
  const event = c.req.header('x-github-event') ?? c.req.header('x-gitea-event') ?? c.req.header('x-gitlab-event') ?? c.req.header('x-event-key');
  const events = parseWebhook(repo.provider as Provider, event, payload);
  const { linked } = await ingestScmEvents(repo, events);
  return c.json({ received: events.length, linked });
});

/* ----------------------------- development panel ----------------------------- */

app.get('/rest/api/2/issue/:idOrKey/development', requireAuth, requireIssueAccess(), async (c) => {
  const issue = await getIssue(c.req.param('idOrKey'));
  if (!issue) return c.json({ errorMessages: ['Issue not found'] }, 404);
  const rows = await db.select({ l: schema.scmLinks, r: schema.scmRepositories }).from(schema.scmLinks)
    .innerJoin(schema.scmRepositories, eq(schema.scmRepositories.id, schema.scmLinks.repositoryId))
    .where(eq(schema.scmLinks.issueId, issue.id)).orderBy(desc(schema.scmLinks.updatedAt));
  const shape = (x: (typeof rows)[number]) => ({ id: x.l.id, repository: x.r.name, provider: x.r.provider, ref: x.l.ref, branch: x.l.branch, title: x.l.title, url: x.l.url, status: x.l.status, buildStatus: x.l.buildStatus, author: x.l.author, updated: x.l.updatedAt });
  const repos = await db.select().from(schema.scmRepositories).where(eq(schema.scmRepositories.projectId, issue.projectId));
  const user = c.get('user')!;
  return c.json({
    branches: rows.filter((x) => x.l.kind === 'branch').map(shape),
    commits: rows.filter((x) => x.l.kind === 'commit').map(shape),
    pullRequests: rows.filter((x) => x.l.kind === 'pull_request').map(shape),
    repositories: repos.map((r) => ({ id: r.id, provider: r.provider, name: r.name, canCreateBranch: !!r.accessTokenEnc })),
    suggestedBranch: suggestBranchName(issue.key, issue.summary ?? ''),
    canCreateBranch: await checkProjectPermission(user, issue.projectId, 'EDIT_ISSUES'),
  });
});

const branchBody = z.object({ repositoryId: z.number().int(), name: z.string().trim().max(200).optional(), from: z.string().trim().max(200).optional() }).strict();

app.post('/rest/api/2/issue/:idOrKey/development/branch', requireAuth, requireIssueAccess('EDIT_ISSUES'), async (c) => {
  const issue = await getIssue(c.req.param('idOrKey'));
  if (!issue) return c.json({ errorMessages: ['Issue not found'] }, 404);
  const parsed = branchBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ errorMessages: parsed.error.issues.map((i) => i.message) }, 400);
  const [repo] = await db.select().from(schema.scmRepositories)
    .where(and(eq(schema.scmRepositories.id, parsed.data.repositoryId), eq(schema.scmRepositories.projectId, issue.projectId))).limit(1);
  if (!repo) return c.json({ errorMessages: ['Repository not found'] }, 404);
  if (!repo.accessTokenEnc) return c.json({ errorMessages: ['No access token is configured for this repository'] }, 400);
  const name = parsed.data.name || suggestBranchName(issue.key, issue.summary ?? '');
  const base = parsed.data.from || repo.defaultBranch;
  if (!validBranchName(name) || !validBranchName(base)) return c.json({ errorMessages: ['Invalid branch name'] }, 400);
  try {
    await createBranch(repo as any, decryptSecret(repo.accessTokenEnc), name, base);
  } catch (e) {
    if (e instanceof ScmError) return c.json({ errorMessages: [e.message] }, 502);
    return c.json({ errorMessages: [(e as Error).message || 'Failed to create the branch'] }, 502);
  }
  await db.insert(schema.scmLinks).values({ repositoryId: repo.id, issueId: issue.id, kind: 'branch', ref: name, branch: name, title: name, url: branchUrl(repo as any, name), author: c.get('user')!.username })
    .onConflictDoNothing();
  publishIssueById('issue.updated', issue.id, c.get('user')!.id);
  return c.json({ branch: name, url: branchUrl(repo as any, name) }, 201);
});

/* ----------------------------- release notes ----------------------------- */

app.get('/rest/api/2/project/:key/versions/:id/release-notes', requireAuth, requirePermission('BROWSE_PROJECTS'), async (c) => {
  const p = await projectByKey(c.req.param('key'));
  const id = Number(c.req.param('id'));
  if (!p || !Number.isInteger(id)) return c.json({ errorMessages: ['Version not found'] }, 404);
  const [version] = await db.select().from(schema.versions).where(and(eq(schema.versions.id, id), eq(schema.versions.projectId, p.id))).limit(1);
  if (!version) return c.json({ errorMessages: ['Version not found'] }, 404);
  const rows = await db.select({ key: schema.issues.issueKey, summary: schema.issues.summary, type: schema.issueTypes.name })
    .from(schema.issueFixVersions)
    .innerJoin(schema.issues, eq(schema.issues.id, schema.issueFixVersions.issueId))
    .innerJoin(schema.issueTypes, eq(schema.issueTypes.id, schema.issues.issueTypeId))
    .where(and(eq(schema.issueFixVersions.versionId, id), eq(schema.issues.projectId, p.id), issueVisibleSql(c.get('user')!.id))).orderBy(schema.issueTypes.name, schema.issues.id);
  const groups = new Map<string, Array<{ key: string; summary: string }>>();
  for (const r of rows) (groups.get(r.type) ?? groups.set(r.type, []).get(r.type)!).push({ key: r.key, summary: r.summary });
  if (c.req.query('format') === 'json') return c.json({ version: version.name, releaseDate: version.releaseDate, groups: [...groups].map(([type, issues]) => ({ type, issues })) });
  const lines = [`# ${p.name} ${version.name}`, ...(version.releaseDate ? [`Released ${version.releaseDate}`] : []), ...(version.description ? ['', version.description] : [])];
  for (const [type, issues] of groups) {
    lines.push('', `## ${type}${issues.length > 1 && !/s$/i.test(type) ? 's' : ''}`);
    for (const i of issues) lines.push(`- ${i.key} ${i.summary}`);
  }
  if (!rows.length) lines.push('', '_No issues are assigned to this version._');
  return c.text(lines.join('\n') + '\n', 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
});

export default app;
