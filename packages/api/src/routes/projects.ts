import { Hono } from 'hono';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import { requireProjectPermission, requireGlobalPermission } from '../rbac/middleware';
import * as schema from '@veqsio/db';
import { eq, count, desc, inArray, and, isNull, isNotNull } from 'drizzle-orm';
import { cacheMiddleware, invalidateProjectCache } from '../middleware/cache';
import type { AppContext } from '../auth/middleware';
import { createProjectWithDefaults, isValidProjectKey, projectKeyTaken } from '../projects/service';

import { db } from '../db';
import { getInstanceSettings } from '../settings/instance';
import { requirePermission, checkProjectPermission } from '../middleware/permissions';
import { applyProjectTemplate, copyProjectSettings, emptyReport, findProjectTemplate } from '../projects/templates';
import { getBrowsableProjectIds } from '../services/browse';

const app = new Hono<AppContext>();
app.use('/rest/api/2/project*', sessionMiddleware);

app.get('/rest/api/2/project', requireAuth, cacheMiddleware(600), async (c) => {
  try {
    const user = c.get('user')!;
    // archived=exclude (default) | include | only. Archived projects stay out of lists and pickers unless asked for.
    const mode = c.req.query('archived') ?? 'exclude';
    if (!['exclude', 'include', 'only'].includes(mode)) return c.json({ errorMessages: ['archived must be exclude, include or only'] }, 400);
    // Only projects the caller may browse
    const browsable = await getBrowsableProjectIds(user);
    const where = mode === 'include' ? inArray(schema.projects.id, browsable)
      : and(inArray(schema.projects.id, browsable), mode === 'only' ? isNotNull(schema.projects.archivedAt) : isNull(schema.projects.archivedAt));
    const projects = browsable.length === 0 ? [] : await db.select().from(schema.projects).where(where).orderBy(desc(schema.projects.createdAt));
    return c.json(
      projects.map(p => ({
        id: p.id,
        key: p.projectKey,
        name: p.name,
        description: p.description,
        lead: { id: p.leadId },
        avatarUrls: p.avatarUrl ? { '48x48': p.avatarUrl } : {},
        projectCategory: p.category,
        archived: !!p.archivedAt,
        archivedAt: p.archivedAt,
      }))
    );
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to fetch projects'] }, 500);
  }
});

app.get('/rest/api/2/project/:key', requireAuth, requirePermission('BROWSE_PROJECTS'), cacheMiddleware(600), async (c) => {
  try {
    const key = c.req.param('key');
    const project = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, key)).limit(1);
    if (project.length === 0) return c.json({ errorMessages: ['Project not found'] }, 404);
    const p = project[0];

    const lead = p.leadId
      ? (await db.select().from(schema.users).where(eq(schema.users.id, p.leadId)).limit(1))[0]
      : null;

    const schemeAssoc = await db
      .select()
      .from(schema.issueTypeSchemeAssociations)
      .where(eq(schema.issueTypeSchemeAssociations.projectId, p.id))
      .limit(1);

    let issueTypes: (typeof schema.issueTypes.$inferSelect)[] = [];
    if (schemeAssoc.length > 0) {
      const items = await db
        .select()
        .from(schema.issueTypeSchemeItems)
        .where(eq(schema.issueTypeSchemeItems.schemeId, schemeAssoc[0].schemeId));
      const typeIds = items.map((i) => i.issueTypeId);
      if (typeIds.length > 0) {
        issueTypes = await db
          .select()
          .from(schema.issueTypes)
          .where(inArray(schema.issueTypes.id, typeIds));
      }
    }

    return c.json({
      id: p.id,
      key: p.projectKey,
      name: p.name,
      description: p.description,
      lead: lead ? { id: lead.id, displayName: lead.displayName } : null,
      avatarUrls: p.avatarUrl ? { '48x48': p.avatarUrl } : {},
      projectCategory: p.category,
      isPublic: p.isPublic,
      publicIndexing: p.publicIndexing,
      publicBoard: p.publicBoard,
      publicRoadmap: p.publicRoadmap,
      archived: !!p.archivedAt,
      archivedAt: p.archivedAt,
      issueTypes: issueTypes.map((t) => ({
        id: String(t.id),
        name: t.name,
        description: t.description,
        iconUrl: t.iconUrl,
        subtask: t.isSubtask,
      })),
    });
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to fetch project'] }, 500);
  }
});

app.post('/rest/api/2/project', requireAuth, requireGlobalPermission('CREATE_PROJECT'), async (c) => {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ errorMessages: ['Invalid JSON body'] }, 400); }
  const key = typeof body?.key === 'string' ? body.key.trim().toUpperCase() : '';
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const errors: string[] = [];
  if (!isValidProjectKey(key)) errors.push('Project key must be 2-10 characters: an uppercase letter followed by uppercase letters or digits.');
  if (!name || name.length > 255) errors.push('Project name is required (max 255 characters).');
  if (body?.description != null && (typeof body.description !== 'string' || body.description.length > 5000)) errors.push('Description must be text of at most 5000 characters.');
  if (errors.length) return c.json({ errorMessages: errors }, 400);
  if (await projectKeyTaken(key)) return c.json({ errorMessages: [`A project with key ${key} already exists.`] }, 409);

  // Optional starting point: a built-in template and/or settings copied from a project the caller administers.
  const user = c.get('user')!;
  let templateId: string | null = null;
  if (body?.template != null) {
    if (typeof body.template !== 'string' || !findProjectTemplate(body.template)) return c.json({ errorMessages: ['Unknown project template'] }, 400);
    templateId = body.template;
  }
  let copy: { sourceId: number; opts: { components: boolean; versions: boolean; issueTemplates: boolean; roleActors: boolean } } | null = null;
  if (body?.copyFrom != null) {
    const cf = body.copyFrom;
    const allowed = ['projectKey', 'components', 'versions', 'issueTemplates', 'roleActors'];
    if (typeof cf !== 'object' || Array.isArray(cf) || typeof cf.projectKey !== 'string' || Object.keys(cf).some((k) => !allowed.includes(k)) || allowed.slice(1).some((k) => cf[k] !== undefined && typeof cf[k] !== 'boolean')) {
      return c.json({ errorMessages: ['copyFrom must be { projectKey, components?, versions?, issueTemplates?, roleActors? } with boolean flags'] }, 400);
    }
    const [src] = await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.projectKey, cf.projectKey.toUpperCase())).limit(1);
    if (!src || !(await checkProjectPermission(user, src.id, 'PROJECT_ADMIN'))) return c.json({ errorMessages: ['Source project not found'] }, 404);
    copy = { sourceId: src.id, opts: { components: cf.components !== false, versions: cf.versions !== false, issueTemplates: cf.issueTemplates !== false, roleActors: cf.roleActors === true } };
  }

  try {
    // Same service the service desk wizard uses: issue counter and default schemes, so the project is usable at once.
    const report = emptyReport();
    const project = await db.transaction(async (tx) => {
      const created = await createProjectWithDefaults(tx as any, {
        key, name,
        description: typeof body.description === 'string' ? body.description : null,
        leadId: Number(body.lead?.id) || user.id,
        category: typeof body.projectCategory === 'string' ? body.projectCategory.slice(0, 100) : null,
      });
      if (templateId) await applyProjectTemplate(tx as any, created, templateId, user.id, report);
      if (copy) await copyProjectSettings(tx as any, copy.sourceId, created, copy.opts, report);
      return created;
    });
    await invalidateProjectCache();
    return c.json({ id: project.id, key: project.projectKey, name: project.name, applied: report }, 201);
  } catch (err: any) {
    console.error('[projects] create failed', err);
    return c.json({ errorMessages: ['Failed to create project'] }, 500);
  }
});

/** The built-in picture presets are sent as an inline SVG. Accept only plain shapes: no script, styles, links, images or event handlers. */
function isSafePresetSvgDataUrl(v: string): boolean {
  const prefix = 'data:image/svg+xml,';
  if (!v.startsWith(prefix)) return false;
  let svg: string;
  try { svg = decodeURIComponent(v.slice(prefix.length)); } catch { return false; }
  if (!/^<svg [^<>]*>[\s\S]*<\/svg>$/.test(svg)) return false;
  const allowed = new Set(['svg', 'defs', 'lineargradient', 'stop', 'rect', 'circle', 'ellipse', 'path', 'g']);
  for (const m of svg.matchAll(/<\/?([a-zA-Z][\w-]*)([^<>]*)>/g)) {
    if (!allowed.has(m[1].toLowerCase())) return false;
    if (/\son\w+\s*=|href|javascript:|url\(\s*['"]?(?!#)|<|&/i.test(m[2])) return false;
  }
  return !/<!|<\?/.test(svg);
}

app.put('/rest/api/2/project/:key', requireAuth, requirePermission('PROJECT_ADMIN'), async (c) => {
  try {
    const key = c.req.param('key');
    const body = await c.req.json();
    const project = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, key)).limit(1);
    if (project.length === 0) return c.json({ errorMessages: ['Project not found'] }, 404);

    const setObj: Partial<typeof schema.projects.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) setObj.name = body.name;
    if (body.description !== undefined) setObj.description = body.description;
    if (body.lead?.id !== undefined) setObj.leadId = body.lead.id;
    if (body.projectCategory !== undefined) setObj.category = body.projectCategory;
    if (body.avatarUrl !== undefined) {
      const v = body.avatarUrl;
      if (v !== null && v !== '' && !(typeof v === 'string' && v.length <= 2000 && (/^https:\/\//i.test(v) || /^\/(?!\/)[^\\]*$/.test(v) || isSafePresetSvgDataUrl(v)))) return c.json({ errorMessages: ['A picture address starts with https:// or /'] }, 400);
      setObj.avatarUrl = v;
    }
    if (body.isPublic !== undefined) {
      if (typeof body.isPublic !== 'boolean') return c.json({ errorMessages: ['isPublic must be true or false'] }, 400);
      if (body.isPublic) {
        if (!(await getInstanceSettings()).publicProjectsEnabled) return c.json({ errorMessages: ['Public projects are not enabled on this instance. An administrator can allow them under Instance settings.'] }, 400);
        const [desk] = await db.select({ id: schema.serviceDesks.id }).from(schema.serviceDesks).where(eq(schema.serviceDesks.projectId, project[0].id)).limit(1);
        if (desk) return c.json({ errorMessages: ['Service desk projects cannot be public'] }, 400);
      }
      setObj.isPublic = body.isPublic;
    }

    if (body.publicIndexing !== undefined) {
      if (body.publicIndexing !== 'inherit' && body.publicIndexing !== 'none') return c.json({ errorMessages: ['publicIndexing must be inherit or none'] }, 400);
      setObj.publicIndexing = body.publicIndexing;
    }

    for (const k of ['publicBoard', 'publicRoadmap'] as const) {
      if (body[k] !== undefined) {
        if (typeof body[k] !== 'boolean') return c.json({ errorMessages: [`${k} must be true or false`] }, 400);
        setObj[k] = body[k];
      }
    }

    const [updated] = await db.update(schema.projects)
      .set(setObj)
      .where(eq(schema.projects.projectKey, key))
      .returning();

    await invalidateProjectCache(key);
    return c.json({
      id: updated.id,
      key: updated.projectKey,
      name: updated.name,
      description: updated.description,
      leadId: updated.leadId,
      avatarUrl: updated.avatarUrl,
      projectCategory: updated.category,
      isPublic: updated.isPublic,
      publicIndexing: updated.publicIndexing,
      publicBoard: updated.publicBoard,
      publicRoadmap: updated.publicRoadmap,
    });
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to update project'] }, 500);
  }
});

/**
 * Deleting a project destroys every issue, comment, attachment record and board in it, and cannot be undone.
 * Therefore it takes two deliberate steps: the project must be archived first (read-only, so nothing changes under
 * the deletion and scheduled jobs have stopped, and the archive is the undo window), and the request must repeat the
 * project key and the exact phrase. The web app makes the person type both.
 */
export const DELETE_PHRASE = 'delete this project';
app.delete('/rest/api/2/project/:key', requireAuth, requireGlobalPermission('ADMINISTER'), async (c) => {
  try {
    const key = c.req.param('key');
    const [p] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, key)).limit(1);
    if (!p) return c.json({ errorMessages: ['Project not found'] }, 404);
    const body = await c.req.json().catch(() => null) as { confirmKey?: unknown; confirmPhrase?: unknown } | null;
    if (!body || body.confirmKey !== p.projectKey || body.confirmPhrase !== DELETE_PHRASE) {
      return c.json({ errorMessages: [`Deleting a project needs a confirmation: send { "confirmKey": "${p.projectKey}", "confirmPhrase": "${DELETE_PHRASE}" }`] }, 400);
    }
    if (!p.archivedAt) return c.json({ errorMessages: ['Only archived projects can be deleted. Archive the project first; it can be restored until it is deleted.'] }, 409);
    // Collect the stored files first: the rows disappear with the issues, the files in storage would not.
    const files = await db.select({ k: schema.attachments.storageKey }).from(schema.attachments)
      .innerJoin(schema.issues, eq(schema.issues.id, schema.attachments.issueId)).where(eq(schema.issues.projectId, p.id));
    await db.transaction(async (tx) => {
      // These two references to projects have no ON DELETE CASCADE, so they are removed explicitly (children cascade).
      await tx.delete(schema.automationRules).where(eq(schema.automationRules.projectId, p.id));
      await tx.delete(schema.issues).where(eq(schema.issues.projectId, p.id));
      await tx.delete(schema.projects).where(eq(schema.projects.id, p.id));
    });
    await invalidateProjectCache(key);
    // Best effort after the commit: a storage hiccup must not undo or fail a deletion that already happened.
    const { deleteFile } = await import('../storage/service');
    const results = await Promise.allSettled(files.map((f) => deleteFile(f.k)));
    const left = results.filter((r) => r.status === 'rejected').length;
    if (left) console.error(`[projects] ${left} attachment file(s) of ${key} could not be removed from storage`);
    return c.json({});
  } catch (err: any) {
    console.error('[projects] delete failed', err);
    return c.json({ errorMessages: ['Failed to delete project'] }, 500);
  }
});

export default app;
