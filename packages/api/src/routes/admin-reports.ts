import { Hono } from 'hono';
import { requireAuth, type AppContext } from '../auth/middleware';
import { requireGlobalPermission } from '../rbac/middleware';
import { toCsv } from '../audit/classify';
import { reviewProjects } from '../admin/permission-review';
import { PERMISSION_INFO } from '../rbac/permission-info';

/** Reports for administrators (SYSTEM_ADMIN): the permission review used for access reviews and security audits. */
const app = new Hono<AppContext>();
const guard = [requireAuth, requireGlobalPermission('SYSTEM_ADMIN')] as const;

const csvResponse = (c: any, file: string, body: string) => {
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="${file}"`);
  return c.body(body);
};
const viaText = (v: { type: string; name: string; group?: string }) => v.type === 'role' ? `role ${v.name}${v.group ? ` (through group ${v.group})` : ''}` : v.type === 'group' ? `group ${v.name}` : v.type === 'lead' ? 'project lead' : 'direct';

/** One row per project: scheme, counts and the findings. ?format=csv downloads it. */
app.get('/rest/api/2/admin/reports/permission-review', ...guard, async (c) => {
  const reviews = await reviewProjects();
  if (c.req.query('format') === 'csv') {
    return csvResponse(c, 'permission-review-projects.csv', toCsv(
      ['Project', 'Name', 'Lead', 'Scheme', 'People with access', 'Active', 'Can browse', 'Project admins', 'Direct grants', 'Groups', 'Roles', 'Anyone may', 'Every signed-in user may', 'Findings'],
      reviews.map((r) => [r.project.key, r.project.name, r.project.lead ?? '', r.scheme?.name ?? '', r.counts.people, r.counts.active, r.counts.browse, r.counts.admins, r.counts.directGrants, r.counts.groups, r.counts.roles,
        r.anyone.map((p) => PERMISSION_INFO[p]?.name ?? p).join('; '), r.loggedIn.map((p) => PERMISSION_INFO[p]?.name ?? p).join('; '), r.findings.map((f) => `[${f.severity}] ${f.text}`).join(' | ')]),
    ));
  }
  return c.json({
    generatedAt: new Date().toISOString(),
    projects: reviews.map((r) => ({ key: r.project.key, name: r.project.name, lead: r.project.lead, scheme: r.scheme, counts: r.counts, anyone: r.anyone, loggedIn: r.loggedIn, findings: r.findings })),
  });
});

/** Everybody who has access to one project and through what. ?format=csv: one row per person, permission and source. */
app.get('/rest/api/2/admin/reports/permission-review/:key', ...guard, async (c) => {
  const key = c.req.param('key').toUpperCase();
  const [r] = await reviewProjects(key);
  if (!r) return c.json({ errorMessages: ['Project not found'] }, 404);
  if (c.req.query('format') === 'csv') {
    const rows: unknown[][] = [];
    for (const p of r.people) for (const perm of p.permissions) for (const v of perm.via) rows.push([r.project.key, p.username, p.displayName, p.email, p.active ? 'active' : 'deactivated', PERMISSION_INFO[perm.key]?.name ?? perm.key, viaText(v)]);
    for (const a of r.anyone) rows.push([r.project.key, '(anyone)', 'Anyone without signing in', '', '', PERMISSION_INFO[a]?.name ?? a, 'anonymous']);
    for (const a of r.loggedIn) rows.push([r.project.key, '(all users)', 'Every signed-in user', '', '', PERMISSION_INFO[a]?.name ?? a, 'any signed-in user']);
    return csvResponse(c, `permission-review-${key}.csv`, toCsv(['Project', 'Username', 'Name', 'E-mail', 'Account', 'Permission', 'Granted through'], rows));
  }
  return c.json({ generatedAt: new Date().toISOString(), ...r, permissionNames: Object.fromEntries(Object.entries(PERMISSION_INFO).map(([k, v]) => [k, v.name])) });
});

export default app;
