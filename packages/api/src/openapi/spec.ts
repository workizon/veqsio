/**
 * OpenAPI 3.1 document for the REST API, built from the Hono route table (so it can never miss a route) plus the
 * hand-written overlay in handwritten.ts (request/response schemas and prose for the important endpoints).
 *
 * The document contains NO instance data: relative server URL, no hostnames, no user names, no settings.
 */
import { VERSION } from '../version';
import { OPERATIONS, SCHEMAS, type OpDoc } from './handwritten';

export interface RouteLike { method: string; path: string }
type Json = Record<string, any>;

/** Routes that exist in the route table but are intentionally not part of the public description. */
export const EXCLUDED: Array<{ match: (method: string, path: string) => boolean; reason: string }> = [
  { match: (_m, p) => p.startsWith('/mock-storage/'), reason: 'development-only attachment storage (STORAGE_TYPE=mock)' },
  { match: (_m, p) => p.includes('*'), reason: 'wildcard mounts (module host: /rest/modules/{id}/*) are documented by each module' },
  { match: (_m, p) => !/^\/(rest|scim)\//.test(p) && !['/health', '/ready', '/metrics'].includes(p), reason: 'not under /rest or /scim' },
];

/** Operations that need no session. Keep in sync with PUBLIC_ROUTES in tests/integration/security.api.ts. */
const PUBLIC = new Set([
  'GET /health', 'GET /ready', 'GET /rest/api/2/openapi.json', 'GET /rest/api/2/serverInfo', 'GET /rest/api/2/admin/health', 'POST /rest/auth/1/session',
  'GET /rest/public/config', 'GET /rest/public/projects', 'GET /rest/public/projects/{key}', 'GET /rest/public/projects/{key}/issues',
  'GET /rest/public/issues/{issueKey}', 'GET /rest/public/sitemap', 'GET /rest/api/2/settings/public', 'GET /rest/api/2/branding',
  'GET /rest/api/2/branding/file/{slot}', 'POST /rest/auth/1/password-reset/request', 'POST /rest/auth/1/password-reset/confirm',
  'GET /rest/auth/1/sso/microsoft', 'GET /rest/auth/1/sso/microsoft/callback', 'GET /rest/auth/1/oidc/providers',
  'GET /rest/auth/1/oidc/{slug}/login', 'GET /rest/auth/1/oidc/{slug}/callback', 'GET /rest/public/intake/{slug}', 'POST /rest/public/intake/{slug}',
]);
/** Own, non-session authentication. */
const OWN_AUTH: Record<string, 'signature' | 'metrics'> = {
  'POST /rest/webhooks/scm/{id}': 'signature',
  'POST /rest/api/2/intake/{slug}/email': 'signature',
  'POST /rest/servicedeskapi/inbound-email/{slug}': 'signature',
  'POST /rest/api/2/webhooks/inbound/{slug}': 'signature',
  'GET /metrics': 'metrics',
};

/** Hono `/a/:id/b/:x{[0-9]+}` -> OpenAPI `/a/{id}/b/{x}`. */
export function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)(\{[^}]*\})?\??/g, '{$1}').replace(/\/+$/, '') || '/';
}

const TAGS: Array<[RegExp, string]> = [
  [/^\/(health|ready|metrics)$/, 'Operations'],
  [/^\/rest\/api\/2\/(openapi|admin\/jobs|admin\/backup-status)/, 'Operations'],
  [/^\/rest\/auth\//, 'Authentication'],
  [/^\/scim\//, 'SCIM'],
  [/^\/rest\/public\//, 'Public API'],
  [/^\/rest\/servicedeskapi\//, 'Service desk'],
  [/^\/rest\/agile\//, 'Boards and sprints'],
  [/^\/rest\/webhooks\//, 'Inbound webhooks'],
  [/^\/rest\/api\/2\/webhooks\/inbound/, 'Inbound webhooks'],
  [/^\/rest\/api\/2\/(webhook|application-links?)/, 'Webhooks'],
  [/^\/rest\/api\/2\/admin\/agents|^\/rest\/api\/2\/agent-runs|\/agent-runs$|\/agents$/, 'Agents'],
  [/^\/rest\/api\/2\/(admin|license|audit|system|branding|features|instance)/, 'Administration'],
  [/^\/rest\/api\/2\/(search|jql)/, 'Search'],
  [/^\/rest\/api\/2\/filter/, 'Filters'],
  [/^\/rest\/api\/2\/(board|sprint)/, 'Boards and sprints'],
  [/^\/rest\/api\/2\/issue\/\{[^}]+\}\/transitions/, 'Transitions'],
  [/^\/rest\/api\/2\/issue\/\{[^}]+\}\/comment/, 'Comments'],
  [/^\/rest\/api\/2\/(issue|issueLink|bulk)/, 'Issues'],
  [/^\/rest\/api\/2\/(user|group|myself)/, 'Users'],
  [/^\/rest\/api\/2\/project/, 'Projects'],
  [/^\/rest\/api\/2\/(dashboard|gadget)/, 'Dashboards'],
  [/^\/rest\/api\/2\/(pages?|views?|roadmap|initiative|milestone|release|status-update)/, 'Planning and content'],
  [/^\/rest\/api\/2\/(intake|approval|recurring|template)/, 'Intake, approvals and templates'],
  [/^\/rest\/api\/2\/(migration|import|csv|tokens?|token)/, 'Import and tokens'],
];
export function tagFor(path: string): string {
  for (const [re, tag] of TAGS) if (re.test(path)) return tag;
  return 'Other';
}

const paramNames = (path: string) => [...path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
const intLike = (n: string) => /^(id|.+Id)$/.test(n) && n !== 'idOrKey';

function words(path: string): string {
  const segs = path.split('/').filter((x) => x && !x.startsWith('{') && !/^(rest|api|2|1|1\.0)$/.test(x));
  return segs.join(' / ') || 'root';
}
const VERB: Record<string, string> = { get: 'Get', post: 'Create or run', put: 'Update', patch: 'Update', delete: 'Delete' };

function operationId(method: string, path: string): string {
  const parts = path.replace(/^\//, '').split('/').map((p) => p.replace(/[{}]/g, '').replace(/[^A-Za-z0-9]+/g, ' '));
  const camel = parts.join(' ').trim().split(/\s+/).map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1))).join('');
  return method.toLowerCase() + camel[0].toUpperCase() + camel.slice(1);
}

const STD_ERRORS: Record<string, string> = { 400: 'Invalid request', 401: 'Not authenticated', 403: 'Not permitted', 404: 'Not found (also returned when the caller may not know the resource exists)', 429: 'Rate limited (Retry-After header)' };

function buildOperation(method: string, path: string, doc: OpDoc | undefined): Json {
  const key = `${method.toUpperCase()} ${path}`;
  const security = doc?.security ?? (OWN_AUTH[key] ? OWN_AUTH[key] : PUBLIC.has(key) ? 'none' : 'session');
  const op: Json = {
    operationId: operationId(method, path),
    tags: [doc?.tag ?? tagFor(path)],
    summary: doc?.summary ?? `${VERB[method] ?? method} ${words(path)}`,
    parameters: [] as Json[],
    responses: {} as Json,
    'x-documented': doc ? 'handwritten' : 'generated',
  };
  if (doc?.description) op.description = doc.description + (doc.permission ? `\n\nRequires permission: \`${doc.permission}\`.` : '');
  else if (doc?.permission) op.description = `Requires permission: \`${doc.permission}\`.`;
  for (const name of paramNames(path)) {
    op.parameters.push({ name, in: 'path', required: true, schema: { type: intLike(name) ? 'integer' : 'string' } });
  }
  for (const q of doc?.query ?? []) {
    op.parameters.push({ name: q.name, in: 'query', required: !!q.required, description: q.description, schema: q.schema ?? { type: 'string' } });
  }
  if (!op.parameters.length) delete op.parameters;
  if (doc?.body) op.requestBody = { required: true, content: { 'application/json': { schema: doc.body } } };
  else if (['post', 'put', 'patch'].includes(method) && !doc) op.requestBody = { required: false, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } };

  if (security === 'none') op.security = [];
  else if (security === 'metrics') op.security = [{ metricsToken: [] }];
  else if (security === 'signature') op.security = [{ webhookSignature: [] }];
  else if (security === 'agent') op.security = [{ bearerAuth: [] }];
  else op.security = [{ cookieAuth: [] }, { bearerAuth: [] }];

  const res = doc?.responses ?? { 200: [null, 'Success'] };
  for (const [code, [schema, description]] of Object.entries(res)) {
    op.responses[code] = schema
      ? { description, content: { 'application/json': { schema } } }
      : { description };
  }
  if (security !== 'none') for (const code of ['401', '403']) if (!op.responses[code]) op.responses[code] = { description: STD_ERRORS[code], content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
  if (paramNames(path).length && !op.responses['404']) op.responses['404'] = { description: STD_ERRORS['404'], content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
  if (['post', 'put', 'patch'].includes(method) && !op.responses['400']) op.responses['400'] = { description: STD_ERRORS['400'], content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
  return op;
}

export interface RouteReport { path: string; method: string; documented: 'handwritten' | 'generated' }

/** Unique, sorted list of documented (path, method) pairs and the routes left out on purpose. */
export function collectRoutes(routes: RouteLike[]): { included: Array<{ method: string; path: string; openapiPath: string }>; excluded: Array<{ method: string; path: string; reason: string }> } {
  const seen = new Set<string>();
  const included: Array<{ method: string; path: string; openapiPath: string }> = [];
  const excluded: Array<{ method: string; path: string; reason: string }> = [];
  for (const r of routes) {
    if (r.method === 'ALL') continue; // middleware registrations
    const k = `${r.method} ${r.path}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const ex = EXCLUDED.find((e) => e.match(r.method, r.path));
    if (ex) { excluded.push({ method: r.method, path: r.path, reason: ex.reason }); continue; }
    included.push({ method: r.method, path: r.path, openapiPath: toOpenApiPath(r.path) });
  }
  return { included, excluded };
}

export function buildOpenApi(routes: RouteLike[]): Json {
  const { included } = collectRoutes(routes);
  const paths: Json = {};
  for (const r of included.sort((a, b) => a.openapiPath.localeCompare(b.openapiPath) || a.method.localeCompare(b.method))) {
    const method = r.method.toLowerCase();
    const doc = OPERATIONS[`${r.method} ${r.openapiPath}`];
    paths[r.openapiPath] ??= {};
    paths[r.openapiPath][method] = buildOperation(method, r.openapiPath, doc);
  }
  const tagNames = [...new Set(Object.values(paths).flatMap((p: any) => Object.values(p).flatMap((o: any) => o.tags)))].sort() as string[];
  return {
    openapi: '3.1.0',
    info: {
      title: 'Veqsio REST API',
      version: VERSION,
      summary: 'Jira-compatible REST API of Veqsio.',
      description: [
        'Authenticate with the `session` cookie (POST /rest/auth/1/session) or a personal access token (`Authorization: Bearer <token>`).',
        'Errors are JSON `{"errorMessages": [...]}`. Resources the caller may not see answer 404, not 403.',
        'Endpoints marked `x-documented: generated` are described from the route table only (path, method, parameters, authentication); those marked `handwritten` also carry schemas.',
        'This document is generated from the running server and contains no instance specific data.',
      ].join('\n\n'),
      license: { name: 'AGPL-3.0-only', url: 'https://www.gnu.org/licenses/agpl-3.0.html' },
    },
    servers: [{ url: '/', description: 'This instance' }],
    tags: tagNames.map((name) => ({ name })),
    paths,
    components: {
      schemas: SCHEMAS,
      securitySchemes: {
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'session' },
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Personal access token, plugin token or agent token.' },
        metricsToken: { type: 'http', scheme: 'bearer', description: 'The value of METRICS_TOKEN.' },
        webhookSignature: { type: 'apiKey', in: 'header', name: 'X-Veqsio-Signature', description: 'sha256=<HMAC-SHA256 of the raw body with the source secret>; some sources use a shared-secret header instead.' },
      },
    },
  };
}
