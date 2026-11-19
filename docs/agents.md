# AI agents

Agents are first-class users: a service account you can assign issues to and @mention. When that happens Veqsio sends a signed event to the agent's HTTP endpoint together with a short-lived token. The agent does its work through the normal REST API (or the [MCP server](mcp.md)), so every permission and workflow rule applies, and reports status back. Switch the whole feature off under Admin > Features and modules (`agents`): routes answer 404 and nothing is triggered; data is kept.

## Concepts

| Concept | What |
| --- | --- |
| Agent | A `users` row named `agent:<id>` (no password, never signs in, no cookie sessions) plus an `agents` row: owner (a human), description, webhook URL, encrypted signing secret, triggers, limits, enabled flag. |
| Permissions | Exactly like any user: add the agent to project roles or groups. Agents are **excluded from the "any logged-in user" grant**, so a new agent sees nothing until you give it a role. Disabling an agent kills its tokens at once. |
| Long-lived token | An ordinary personal access token owned by the agent (Admin > AI agents > key icon) with scopes `read:issues`, `write:issues`, `read:projects`, `write:projects` (never `*`/`admin`). |
| Run | One activation of an agent on an issue: `queued`, `delivered`, `running`, `succeeded`, `failed` or `cancelled`. |
| Run token | `vqr_...`, minted per run, valid 30 minutes (`AGENT_RUN_TOKEN_TTL_MINUTES`), stored only as a SHA-256 hash, dead when the run ends, is stopped or the agent is disabled. |
| Seats | Agents do not use licence seats (`countActiveUsers` excludes the `agent:` prefix). |

The `agent:` user name prefix is reserved: it cannot be registered, created by an admin or created through SCIM. SCIM lists agents with `userType: "agent"` and refuses to modify them.

## Setup

1. Admin > AI agents > New agent. Choose triggers and optionally a webhook URL (https; private, loopback and metadata hosts are refused unless `PLUGINS_ALLOW_PRIVATE_HOSTS=true`, DNS is checked again at delivery). The **signing secret is shown once**.
2. Give the agent access: project settings > Roles > add the user `agent:<id>` to a role that grants Browse, Add comments, Transition (and Edit if it should edit).
3. Create a long-lived token if the agent should work outside runs (optional).
4. Assign an issue to the agent or write `@agent:<id>` in a comment or description. The editor's mention autocomplete inserts it and shows the Agent badge.

Without a webhook URL the agent works in **pull mode**: runs stay `queued` and the agent claims them (see below).

## Triggers

| Trigger | When |
| --- | --- |
| `assigned` | The issue is assigned to the agent (on create or update). |
| `mentioned` | `@agent:<id>` appears in a new comment or in a newly written description. Editing a description does not re-trigger old mentions. |
| `status_changed` | The status of an issue assigned to the agent changes. |
| `commented` | A new comment on an issue assigned to the agent. |

One event starts at most one run per agent (first match in the order above). Internal service-desk comments never trigger or reach an agent. The agent is only triggered for issues it can browse itself, checked at event time and again at delivery.

**Cost and loop guards** (per agent, editable): max concurrent runs (default 3), max active runs per issue (1), max runs per hour (30). A refused trigger is kept in the run log as `cancelled` with `Skipped: <reason>` and does not count toward the hourly limit. Loop protection: an agent's own comments, assignments and status changes never trigger that agent; actions by an agent are one chain level deeper than its own run, and chains deeper than 3 (`AGENTS_MAX_CHAIN_DEPTH`) are skipped, so agent-to-agent mentions cannot ping-pong forever. Runs that never report back are failed after 60 minutes (`AGENT_RUN_TIMEOUT_MINUTES`). After 20 consecutive failed deliveries (`AGENTS_FAILURE_THRESHOLD`) the agent is disabled automatically.

## Delivery

`POST <webhookUrl>` with `Content-Type: application/json`, same transport as plugin events (3 attempts, 1 s then 2 s back-off for network errors, timeouts, 5xx, 429, 408; other 4xx are not retried; redirects are not followed; 10 s timeout). Tune with `AGENTS_MAX_ATTEMPTS`, `AGENTS_RETRY_BASE_MS`, `AGENTS_DELIVERY_TIMEOUT_MS`.

Headers: `X-Veqsio-Event: agent.run.requested`, `X-Veqsio-Delivery` (UUID, stable across retries), `X-Veqsio-Timestamp` (unix seconds), `X-Veqsio-Signature` = `v1=` + hex HMAC-SHA256 of `"<timestamp>.<raw body>"`.

```json
{
  "event": "agent.run.requested",
  "timestamp": "2026-01-01T10:00:00.000Z",
  "deliveryId": "7b0c...",
  "run": { "id": 42, "trigger": "assigned", "chainDepth": 0 },
  "agent": { "id": 3, "username": "agent:helper", "displayName": "Helper Bot" },
  "triggeredBy": { "displayName": "Alice", "username": "alice" },
  "issue": {
    "id": 12, "key": "ABC-7", "summary": "Login fails", "description": "(first 2000 chars)",
    "status": "To Do", "statusCategory": "todo", "type": "Bug", "priority": "High",
    "assignee": { "displayName": "Helper Bot", "username": "agent:helper" }, "reporter": { "displayName": "Alice", "username": "alice" },
    "project": { "id": 1, "key": "ABC", "name": "Alpha" }, "url": "https://jira.example.com/issues/ABC-7"
  },
  "comment": { "id": 9, "author": { "displayName": "Alice", "username": "alice" }, "body": "(first 2000 chars)", "created": "..." },
  "untrustedFields": ["issue.summary", "issue.description", "comment.body"],
  "api": {
    "baseUrl": "https://jira.example.com", "token": "vqr_...", "tokenExpiresAt": "2026-01-01T10:30:00.000Z",
    "capabilities": ["read:issue", "comment:issue", "transition:issue", "report:run"], "runUrl": "/rest/api/2/agent-runs/42"
  }
}
```

`comment` is present for comment and mention triggers. The payload is minimal; fetch the rest with the token.

### Verifying the signature

Verify the **raw** body with a constant-time comparison and reject timestamps older than 5 minutes.

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

function verify(secret, timestamp, rawBody, signature) {
  if (!/^\d{1,12}$/.test(timestamp)) return false
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false
  const expected = Buffer.from('v1=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex'))
  const given = Buffer.from(signature)
  return expected.length === given.length && timingSafeEqual(expected, given)
}
```

```python
import hmac, hashlib, time

def verify(secret: str, timestamp: str, raw_body: bytes, signature: str) -> bool:
    if not timestamp.isdigit() or abs(time.time() - int(timestamp)) > 300:
        return False
    mac = hmac.new(secret.encode(), timestamp.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest("v1=" + mac, signature)
```

Use `X-Veqsio-Delivery` / `run.id` for idempotency: answer `2xx` quickly and do the work asynchronously.

## Run API

Authenticate with `Authorization: Bearer <run token or the agent's long-lived token>`. Only the agent that owns a run can address it (others get 404). Needs `write:issues` for long-lived tokens.

| Call | Purpose |
| --- | --- |
| `POST /rest/api/2/agent-runs/:run/started` | `delivered`/`queued` to `running`. |
| `POST /rest/api/2/agent-runs/:run/progress` `{ "note", "comment": true? }` | Latest progress note (shown in the issue's Agents section). With `comment: true` it is also posted as a comment by the agent, subject to the agent's Add comments permission. |
| `POST /rest/api/2/agent-runs/:run/finished` `{ "status": "succeeded"\|"failed", "summary", "resultUrl", "error", "comment" }` | Ends the run and revokes the run token. `resultUrl` must be http(s). |
| `POST /rest/api/2/agent-runs/:run/token` | New 30 minute token for a long job (call with the long-lived token or a still valid run token). |
| `GET /rest/api/2/agent-runs/:run` | Run state. `409` on report calls means the run was stopped or ended: stop working. |
| `GET /rest/api/2/agent-runs?status=queued` | The agent's own runs (pull mode). |
| `POST /rest/api/2/agent-runs` `{ "issue": "ABC-7" }` or `{ "runId": 42 }` | **Claim**: takes a queued run that was not delivered by webhook, or starts a new run on an issue assigned to the agent (same limits). Returns the snapshot and a run token. Needs the long-lived token. |

Humans: `GET /rest/api/2/issue/:key/agent-runs` (anyone who can browse the issue), `POST /rest/api/2/agent-runs/:run/stop` (Edit issues permission on the project): marks the run `cancelled` and revokes its token immediately. Admin: `/rest/api/2/admin/agents` (CRUD, `/enable`, `/disable`, `/signing-secret`, `/tokens`, `/runs`), project admins: `GET /rest/api/2/project/:key/agents`.

### What a run token may do

Deny by default. It authenticates as the agent (the agent's own permissions still apply) and is additionally confined to the run: `GET` on issues and sub-resources and the project record **of the run's project**; `POST` comment and transitions **on the run's issue**; the run's own report endpoints. Everything else answers 403: other projects, editing or deleting issues, search, tokens, admin. For broader work use the agent's long-lived token with the narrowest scopes.

## Security notes

- **Issue text is untrusted input.** Summaries, descriptions and comments can be written by anyone who can edit or comment, including outsiders on service desk and public projects. Treat everything in `untrustedFields` as data, never as instructions: do not let it choose tools, URLs, credentials or which issues to touch. Give agents a role with only the permissions they need, prefer read-only roles plus comment, require a human to merge or deploy.
- Tokens are hashed at rest (SHA-256), shown once, revocable; the signing secret is encrypted at rest (AES-256-GCM, `SECRETS_ENCRYPTION_KEY`) and never returned again.
- The webhook URL is SSRF-guarded (https, no credentials, no private/loopback/link-local/metadata hosts, re-resolved at delivery, redirects refused). Residual: DNS rebinding between check and connect; use an egress policy if agent hosts are not trusted.
- Deliveries contain only data the agent could read itself; internal comments are never sent.
- All routes require authentication and an explicit permission; `PUBLIC_ROUTES` is unchanged.

## Relation to MCP and plugins

- **MCP** ([mcp.md](mcp.md)) is how an assistant *you drive* talks to Veqsio. An agent can use the MCP server with its long-lived token to do the work after a trigger.
- **Plugins** ([plugins.md](plugins.md)) extend Veqsio (events, panels) and run under a service user `plugin:<key>`. Agents are for *doing work on issues*: they are assignable, mentionable, have a run log and a Stop button. Both share the same signed delivery transport and SSRF guard.
