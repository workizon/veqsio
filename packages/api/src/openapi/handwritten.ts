/**
 * Hand-written part of the OpenAPI description: schemas and per-operation documentation for the most important
 * endpoints. Everything else in the route table is described generically by spec.ts (path, method, parameters,
 * authentication, standard error responses), so the document always lists every route; the entries here add request
 * and response bodies, query parameters and prose.
 *
 * Keys of OPERATIONS are "METHOD /openapi/path" with {param} placeholders, exactly as in the generated document. The
 * test tests/integration/openapi.api.ts fails when a key here does not exist in the route table.
 */
type Json = Record<string, unknown>;

const s = (type: string, extra: Json = {}): Json => ({ type, ...extra });
const str = (description?: string, extra: Json = {}): Json => s('string', { ...(description ? { description } : {}), ...extra });
const int = (description?: string, extra: Json = {}): Json => s('integer', { ...(description ? { description } : {}), ...extra });
const bool = (description?: string): Json => s('boolean', description ? { description } : {});
const arr = (items: Json): Json => s('array', { items });
const obj = (properties: Json, required: string[] = [], extra: Json = {}): Json => ({ type: 'object', properties, ...(required.length ? { required } : {}), ...extra });
const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const nullable = (schema: Json): Json => ({ oneOf: [schema, { type: 'null' }] });
const idRef = obj({ id: int(), key: str() }, [], { description: 'Reference by numeric id (project/issue type/priority/user/...) or key where the endpoint accepts it.' });

export const SCHEMAS: Record<string, Json> = {
  Error: obj({ errorMessages: arr(str()) }, ['errorMessages'], { description: 'Every error response has this shape (Jira compatible).' }),
  LoginRequest: obj({ username: str(undefined, { maxLength: 255 }), password: str(undefined, { maxLength: 1024 }) }, ['username', 'password'], { additionalProperties: false }),
  LoginResponse: obj({ session: obj({ name: str(), value: str('Session id; also set as the HttpOnly `session` cookie.') }), loginInfo: obj({ failedLoginCount: int(), loginCount: int() }) }),
  User: obj({
    id: int(), username: str(), displayName: str(), active: bool(), avatarUrl: nullable(str()),
    emailAddress: str('Only visible to administrators and the user themselves.'),
  }, ['id', 'username', 'displayName']),
  Project: obj({ id: int(), key: str(), name: str(), description: nullable(str()), self: str(), lead: nullable(ref('User')), projectTypeKey: str(), archived: bool() }, ['id', 'key', 'name']),
  ProjectCreate: obj({
    key: str('2-10 characters: an uppercase letter followed by uppercase letters or digits.', { pattern: '^[A-Z][A-Z0-9]{1,9}$' }),
    name: str(undefined, { maxLength: 255 }), description: nullable(str(undefined, { maxLength: 5000 })),
    template: str('Optional built-in project template id (GET /rest/api/2/project-template).'),
    copyFrom: obj({}, [], { description: 'Optional: copy settings from a project the caller administers.', additionalProperties: true }),
  }, ['key', 'name']),
  IssueFields: obj({
    summary: str(), description: nullable(str()), project: idRef, issuetype: idRef, priority: idRef, assignee: idRef, reporter: idRef,
    status: obj({ id: int(), name: str() }), labels: arr(str()), components: arr(obj({ id: int(), name: str() })),
    fixVersions: arr(obj({ id: int(), name: str() })), duedate: nullable(str('YYYY-MM-DD', { format: 'date' })),
    storyPoints: nullable(s('number')), created: str(undefined, { format: 'date-time' }), updated: str(undefined, { format: 'date-time' }),
  }, [], { additionalProperties: true, description: 'Jira-style field map. Custom fields appear under their field ids.' }),
  Issue: obj({ id: int(), key: str('e.g. PROJ-123'), self: str(), fields: ref('IssueFields') }, ['id', 'key', 'fields']),
  IssueCreate: obj({
    fields: obj({
      project: idRef, issuetype: idRef, summary: str(undefined, { minLength: 1 }), description: str(), priority: idRef, assignee: idRef,
      parent: idRef, labels: arr(str()), components: arr(idRef), fixVersions: arr(idRef), duedate: str(undefined, { format: 'date' }),
      storyPoints: s('number'), customFields: obj({}, [], { additionalProperties: true }),
    }, ['project', 'issuetype', 'summary'], { additionalProperties: true }),
  }, ['fields'], { description: 'The body may also be the bare field map (without the `fields` wrapper).' }),
  IssueCreated: obj({ id: int(), key: str(), self: str() }, ['id', 'key', 'self']),
  IssueUpdate: obj({ fields: ref('IssueFields') }, [], { description: 'Only the fields present are changed.' }),
  SearchResults: obj({ expand: str(), startAt: int(), maxResults: int(), total: int(), issues: arr(ref('Issue')) }, ['startAt', 'maxResults', 'total', 'issues']),
  Transition: obj({ id: str(), name: str(), to: obj({ id: int(), name: str() }) }),
  TransitionList: obj({ transitions: arr(ref('Transition')) }),
  TransitionRequest: obj({
    transition: obj({ id: str() }, ['id']), transitionId: str('Alternative to `transition.id`.'),
    comment: str('Optional comment added with the transition.'),
    update: obj({}, [], { additionalProperties: true, description: 'Jira style `update.comment[].add.body` is accepted.' }),
    fields: obj({}, [], { additionalProperties: true }),
  }, [], { description: 'Either `transition.id` or `transitionId` is required.' }),
  Comment: obj({ id: str(), self: str(), author: obj({ id: int(), displayName: str(), isAgent: bool() }), body: str(), internal: bool('Service desk: internal note'), parentId: nullable(str()), created: str(undefined, { format: 'date-time' }) }, ['id', 'body']),
  CommentCreate: obj({ body: str('Markdown text, at most 100000 characters.', { minLength: 1, maxLength: 100000 }) }, ['body']),
  JqlValidateRequest: obj({ jql: str() }, ['jql']),
  Filter: obj({ id: int(), name: str(), jql: str(), favourite: bool(), owner: ref('User'), shares: arr(obj({}, [], { additionalProperties: true })) }, ['id', 'name', 'jql']),
  FilterCreate: obj({ name: str(), jql: str(), favourite: bool(), shares: arr(obj({}, [], { additionalProperties: true })) }, ['name', 'jql'], { additionalProperties: false }),
  Board: obj({ id: str(), name: str(), type: str(), projectId: nullable(int()), filterId: nullable(int()) }, ['id', 'name']),
  Sprint: obj({
    id: int(), name: str(), state: s('string', { enum: ['future', 'active', 'closed'] }), goal: nullable(str()),
    startDate: nullable(str(undefined, { format: 'date-time' })), endDate: nullable(str(undefined, { format: 'date-time' })), completeDate: nullable(str(undefined, { format: 'date-time' })),
  }, ['id', 'name', 'state']),
  SprintCreate: obj({ name: str(undefined, { minLength: 1, maxLength: 255 }), goal: nullable(str(undefined, { maxLength: 2000 })), startDate: nullable(str()), endDate: nullable(str()) }, ['name']),
  Webhook: obj({ id: int(), url: str(undefined, { format: 'uri' }), events: arr(str()), projectId: nullable(int()), active: bool() }, ['id', 'url']),
  WebhookCreate: obj({ url: str(undefined, { format: 'uri' }), events: arr(str('e.g. issue.created, issue.updated, comment.created')), projectId: nullable(int()), secret: str('Used to sign deliveries: X-Veqsio-Signature: sha256=<hmac of the body>.') }, ['url', 'events']),
  InboundResult: obj({ status: s('string', { enum: ['created', 'updated', 'ignored', 'duplicate'] }), key: str('Issue key when an issue was created or updated.'), reason: str() }, ['status'], { description: 'Deliberately terse: nothing about the project or actor is returned.' }),
  PublicProject: obj({ key: str(), name: str(), description: nullable(str()) }, ['key', 'name']),
  PublicIssue: obj({ key: str(), summary: str(), status: str(), type: str(), priority: nullable(str()), created: str(), updated: str(), description: nullable(str()) }, ['key', 'summary'], { description: 'No e-mail addresses, no internal comments.' }),
  AgentRunClaim: obj({ issue: str('Issue key to start a run on (an issue assigned to the agent).'), runId: int('Claim a specific queued run (pull mode).') }, [], { additionalProperties: false }),
  AgentRun: obj({ id: int(), status: s('string', { enum: ['queued', 'delivered', 'running', 'succeeded', 'failed', 'cancelled'] }), issue: str(), summary: nullable(str()), resultUrl: nullable(str()), error: nullable(str()) }, ['id', 'status'], { additionalProperties: true }),
  AgentRunProgress: obj({ note: str(undefined, { minLength: 1, maxLength: 4000 }), comment: bool('Also post the note as an issue comment.') }, ['note'], { additionalProperties: false }),
  AgentRunFinished: obj({ status: s('string', { enum: ['succeeded', 'failed'] }), summary: str(undefined, { maxLength: 4000 }), resultUrl: str(undefined, { format: 'uri' }), error: str(undefined, { maxLength: 1000 }), comment: bool() }, ['status'], { additionalProperties: false }),
  Health: obj({ status: str() }, ['status']),
  Ready: obj({ status: s('string', { enum: ['ready', 'not_ready'] }), checks: arr(obj({ name: str(), ok: bool(), detail: str() }, ['name', 'ok'])) }, ['status', 'checks']),
};

export interface OpDoc {
  tag?: string;
  summary: string;
  description?: string;
  /** Query parameters. */
  query?: Array<{ name: string; description: string; required?: boolean; schema?: Json }>;
  /** Request body schema (JSON). */
  body?: Json;
  /** Responses by status code: [schema | null, description]. 401/403/404 default to the Error schema. */
  responses?: Record<string, [Json | null, string]>;
  /** none = anonymous; session = cookie or bearer token (default); bearer-metrics / signature = own scheme. */
  security?: 'none' | 'metrics' | 'signature' | 'agent';
  permission?: string;
}

const ok = (schema: Json | null, d = 'Success'): Record<string, [Json | null, string]> => ({ 200: [schema, d] });
const page = { name: 'startAt', description: 'Index of the first result (default 0).', schema: int() } as const;
const max = { name: 'maxResults', description: 'Page size (default 50).', schema: int() } as const;

export const OPERATIONS: Record<string, OpDoc> = {
  /* ------------------------------ operations ------------------------------ */
  'GET /health': { tag: 'Operations', summary: 'Liveness probe', description: 'Always 200 while the process runs; touches neither the database nor Redis.', security: 'none', responses: ok(ref('Health')) },
  'GET /ready': { tag: 'Operations', summary: 'Readiness probe', description: 'Checks database, Redis, schema version and shutdown state. 503 means: do not route traffic here.', security: 'none', responses: { 200: [ref('Ready'), 'Ready'], 503: [ref('Ready'), 'Not ready'] } },
  'GET /metrics': { tag: 'Operations', summary: 'Prometheus metrics', description: 'Text exposition format. Disabled (404) unless METRICS_TOKEN is set; send `Authorization: Bearer <METRICS_TOKEN>`.', security: 'metrics', responses: { 200: [null, 'text/plain; version=0.0.4'], 401: [ref('Error'), 'Missing or wrong token'], 404: [ref('Error'), 'METRICS_TOKEN is not configured'] } },
  'GET /rest/api/2/openapi.json': { tag: 'Operations', summary: 'This OpenAPI document', security: 'none', responses: ok(obj({}, [], { additionalProperties: true }), 'OpenAPI 3.1 document') },
  'GET /rest/api/2/admin/jobs': { tag: 'Operations', summary: 'Background job heartbeats', permission: 'SYSTEM_ADMIN', responses: ok(obj({ jobs: arr(obj({}, [], { additionalProperties: true })) }, [], { additionalProperties: true })) },
  'GET /rest/api/2/admin/backup-status': { tag: 'Operations', summary: 'Last verified backup', description: 'Read from the status file written by scripts/backup.sh and scripts/restore-verify.sh.', permission: 'SYSTEM_ADMIN', responses: ok(obj({}, [], { additionalProperties: true })) },

  /* --------------------------------- auth --------------------------------- */
  'POST /rest/auth/1/session': { tag: 'Authentication', summary: 'Sign in', description: 'Creates a session and sets the `session` cookie. Rate limited per address and user name (429 with Retry-After).', security: 'none', body: ref('LoginRequest'), responses: { 200: [ref('LoginResponse'), 'Signed in'], 400: [ref('Error'), 'Missing credentials'], 401: [ref('Error'), 'Login failed'], 429: [ref('Error'), 'Too many failed attempts'] } },
  'DELETE /rest/auth/1/session': { tag: 'Authentication', summary: 'Sign out', responses: ok(obj({}), 'Signed out') },
  'GET /rest/api/2/myself': { tag: 'Users', summary: 'The signed-in user', responses: ok(ref('User')) },

  /* ------------------------------- projects ------------------------------- */
  'GET /rest/api/2/project': { tag: 'Projects', summary: 'List projects the caller can browse', responses: ok(arr(ref('Project'))) },
  'POST /rest/api/2/project': { tag: 'Projects', summary: 'Create a project', permission: 'CREATE_PROJECT', body: ref('ProjectCreate'), responses: { 201: [obj({ id: int(), key: str(), name: str(), applied: obj({}, [], { additionalProperties: true }) }), 'Created'], 400: [ref('Error'), 'Invalid key or name'], 409: [ref('Error'), 'Key already exists'] } },
  'GET /rest/api/2/project/{key}': { tag: 'Projects', summary: 'Get a project', permission: 'BROWSE_PROJECTS', responses: ok(ref('Project')) },

  /* -------------------------------- issues -------------------------------- */
  'POST /rest/api/2/issue': { tag: 'Issues', summary: 'Create an issue', permission: 'CREATE_ISSUES', body: ref('IssueCreate'), responses: { 201: [ref('IssueCreated'), 'Created'], 400: [ref('Error'), 'Invalid fields'] } },
  'GET /rest/api/2/issue/{idOrKey}': { tag: 'Issues', summary: 'Get an issue', description: '404 both when the issue does not exist and when the caller may not browse its project.', permission: 'BROWSE_PROJECTS', responses: ok(ref('Issue')) },
  'PUT /rest/api/2/issue/{idOrKey}': { tag: 'Issues', summary: 'Update an issue', permission: 'EDIT_ISSUES', body: ref('IssueUpdate'), responses: { 200: [ref('Issue'), 'The updated issue'], 400: [ref('Error'), 'Invalid fields'] } },
  'DELETE /rest/api/2/issue/{idOrKey}': { tag: 'Issues', summary: 'Delete an issue', permission: 'DELETE_ISSUES', responses: { 200: [obj({}), 'Deleted (empty object)'] } },
  'GET /rest/api/2/issue/{idOrKey}/transitions': { tag: 'Transitions', summary: 'Transitions available to the caller now', permission: 'BROWSE_PROJECTS', responses: ok(ref('TransitionList')) },
  'POST /rest/api/2/issue/{idOrKey}/transitions': { tag: 'Transitions', summary: 'Transition an issue', description: 'Runs workflow conditions, validators and post-functions. 400 when the transition is not available or a validator fails.', permission: 'TRANSITION_ISSUES', body: ref('TransitionRequest'), responses: { 200: [obj({}), 'Transitioned (empty object)'], 400: [obj({ errorMessages: arr(str()), validationErrors: arr(str()) }), 'Transition not available / validation failed'] } },
  'GET /rest/api/2/issue/{idOrKey}/comment': { tag: 'Comments', summary: 'List comments', permission: 'BROWSE_PROJECTS', responses: ok(obj({ startAt: int(), maxResults: int(), total: int(), isLast: bool(), comments: arr(ref('Comment')) })) },
  'POST /rest/api/2/issue/{idOrKey}/comment': { tag: 'Comments', summary: 'Add a comment', permission: 'ADD_COMMENTS', body: ref('CommentCreate'), responses: { 201: [ref('Comment'), 'Created'], 400: [ref('Error'), 'Empty or too long'] } },
  'PUT /rest/api/2/issue/{idOrKey}/comment/{commentId}': { tag: 'Comments', summary: 'Edit a comment', body: ref('CommentCreate'), responses: ok(obj({ id: str(), body: str() })) },
  'DELETE /rest/api/2/issue/{idOrKey}/comment/{commentId}': { tag: 'Comments', summary: 'Delete a comment', responses: ok(null, 'Deleted') },

  /* ----------------------------- search and JQL ---------------------------- */
  'GET /rest/api/2/search': { tag: 'Search', summary: 'Search issues with JQL or text', description: 'Results contain only issues in projects the caller may browse. Responses are cached for 60 s per user and query.', query: [{ name: 'jql', description: 'JQL query, e.g. `project = PROJ AND status = "In Progress" ORDER BY created DESC`' }, { name: 'text', description: 'Full-text search when no JQL is given.' }, page, max], responses: { 200: [ref('SearchResults'), 'Page of issues'], 400: [ref('Error'), 'JQL syntax error'] } },
  'POST /rest/api/2/jql/validate': { tag: 'Search', summary: 'Validate a JQL string', body: ref('JqlValidateRequest'), responses: ok(obj({}, [], { additionalProperties: true })) },
  'GET /rest/api/2/jql/autocompletedata': { tag: 'Search', summary: 'Fields, functions and operators for JQL editors', responses: ok(obj({}, [], { additionalProperties: true })) },

  /* --------------------------------- filters ------------------------------- */
  'GET /rest/api/2/filter': { tag: 'Filters', summary: 'List the caller\'s filters', responses: ok(arr(ref('Filter'))) },
  'POST /rest/api/2/filter': { tag: 'Filters', summary: 'Create a filter', body: ref('FilterCreate'), responses: { 201: [ref('Filter'), 'Created'], 400: [ref('Error'), 'Invalid JQL or shares'] } },
  'GET /rest/api/2/filter/{id}': { tag: 'Filters', summary: 'Get a filter', responses: ok(ref('Filter')) },

  /* ------------------------------ users and groups ------------------------- */
  'GET /rest/api/2/user/search': { tag: 'Users', summary: 'Find users', query: [{ name: 'query', description: 'Name or user name fragment.' }], responses: ok(arr(ref('User'))) },

  /* ------------------------------ boards and sprints ----------------------- */
  'GET /rest/api/2/board': { tag: 'Boards and sprints', summary: 'List boards', responses: ok(obj({ startAt: int(), maxResults: int(), total: int(), values: arr(ref('Board')) })) },
  'GET /rest/agile/1.0/board': { tag: 'Boards and sprints', summary: 'List boards (Jira Software compatible)', responses: ok(obj({ values: arr(ref('Board')) })) },
  'GET /rest/agile/1.0/board/{boardId}/sprint': { tag: 'Boards and sprints', summary: 'List sprints of a board', query: [{ name: 'state', description: 'future, active or closed (comma separated).' }], responses: ok(obj({ values: arr(ref('Sprint')) })) },
  'POST /rest/agile/1.0/board/{boardId}/sprint': { tag: 'Boards and sprints', summary: 'Create a sprint', body: ref('SprintCreate'), responses: { 200: [ref('Sprint'), 'Created'], 400: [ref('Error'), 'Invalid sprint'] } },
  'POST /rest/agile/1.0/sprint/{id}/start': { tag: 'Boards and sprints', summary: 'Start a sprint', responses: ok(ref('Sprint')) },
  'POST /rest/agile/1.0/sprint/{id}/complete': { tag: 'Boards and sprints', summary: 'Complete a sprint', responses: ok(ref('Sprint')) },
  'POST /rest/agile/1.0/sprint/{id}/issue': { tag: 'Boards and sprints', summary: 'Move issues into a sprint', body: obj({ issues: arr(str()) }, ['issues']), responses: ok(null, 'Moved') },

  /* -------------------------------- webhooks ------------------------------- */
  'GET /rest/api/2/webhook': { tag: 'Webhooks', summary: 'List outgoing webhooks', permission: 'ADMINISTER', responses: ok(arr(ref('Webhook'))) },
  'POST /rest/api/2/webhook': { tag: 'Webhooks', summary: 'Register an outgoing webhook', description: 'Deliveries are JSON `{event, timestamp, payload}` with headers X-Veqsio-Event, X-Veqsio-Delivery and (with a secret) X-Veqsio-Signature: sha256=HMAC(body). Three attempts with backoff; the hook is disabled after 10 consecutive failures.', permission: 'ADMINISTER', body: ref('WebhookCreate'), responses: { 201: [obj({ id: int(), self: str() }), 'Created'] } },
  'POST /rest/api/2/webhooks/inbound/{slug}': { tag: 'Inbound webhooks', summary: 'Receive an event from an external system', description: 'Authenticated by the per-source secret: HMAC-SHA256 of the raw body in `X-Veqsio-Signature` (or `X-Hub-Signature-256`, `Sentry-Hook-Signature`), or a shared secret header for sources in header mode. Idempotent through `Idempotency-Key`/provider delivery ids. Unknown or disabled slugs give 404; bad signatures 401.', security: 'signature', body: obj({}, [], { additionalProperties: true, description: 'Any JSON object or array; mapped by the source configuration.' }), responses: { 200: [ref('InboundResult'), 'Accepted / ignored / duplicate'], 201: [ref('InboundResult'), 'Issue created'], 401: [ref('Error'), 'Invalid signature'], 404: [ref('Error'), 'Unknown source'], 413: [ref('Error'), 'Payload too large'], 422: [ref('InboundResult'), 'Payload could not be mapped'] } },

  /* ------------------------------- public API ------------------------------ */
  'GET /rest/public/projects': { tag: 'Public API', summary: 'Public projects', description: 'Anonymous, read-only. 404 unless an administrator enabled public projects. Cacheable for 60 s.', security: 'none', responses: { 200: [obj({ projects: arr(obj({ key: str(), name: str(), description: nullable(str()), category: nullable(str()), avatarUrl: nullable(str()), issueCount: int(), updated: str() })) }), 'Projects'], 404: [ref('Error'), 'Disabled'] } },
  'GET /rest/public/projects/{key}': { tag: 'Public API', summary: 'A public project', security: 'none', responses: { 200: [ref('PublicProject'), 'Project'], 404: [ref('Error'), 'Not found or not public'] } },
  'GET /rest/public/projects/{key}/issues': { tag: 'Public API', summary: 'Issues of a public project', security: 'none', query: [page, max], responses: { 200: [obj({}, [], { additionalProperties: true, description: 'Paged list of PublicIssue-like objects.' }), 'Issues'] } },
  'GET /rest/public/issues/{issueKey}': { tag: 'Public API', summary: 'A public issue', security: 'none', responses: { 200: [ref('PublicIssue'), 'Issue'], 404: [ref('Error'), 'Not found'] } },

  /* ------------------------------- agents run API -------------------------- */
  'POST /rest/api/2/agent-runs': { tag: 'Agents', summary: 'Claim or start a run (agent token)', description: 'Called by an agent (service identity with an agent token). Returns the issue snapshot and a short-lived run token confined to that run.', security: 'agent', body: ref('AgentRunClaim'), responses: { 200: [ref('AgentRun'), 'Run claimed'], 403: [ref('Error'), 'Not an agent'] } },
  'GET /rest/api/2/agent-runs/{run}': { tag: 'Agents', summary: 'Get a run', responses: ok(ref('AgentRun')) },
  'POST /rest/api/2/agent-runs/{run}/started': { tag: 'Agents', summary: 'Report that work started', security: 'agent', body: obj({}, [], { additionalProperties: false }), responses: ok(ref('AgentRun')) },
  'POST /rest/api/2/agent-runs/{run}/progress': { tag: 'Agents', summary: 'Report progress', security: 'agent', body: ref('AgentRunProgress'), responses: ok(ref('AgentRun')) },
  'POST /rest/api/2/agent-runs/{run}/finished': { tag: 'Agents', summary: 'Report the result', security: 'agent', body: ref('AgentRunFinished'), responses: ok(ref('AgentRun')) },
  'POST /rest/api/2/agent-runs/{run}/stop': { tag: 'Agents', summary: 'Stop a run (humans only)', responses: ok(ref('AgentRun')) },
};
