# Plugins

Veqsio extends through **out-of-process plugins**, not a code marketplace. A plugin is an HTTP service you (or a vendor) run anywhere. It is described by a manifest, receives signed webhook events, calls the Veqsio REST API with a scoped token, and may show declarative panels in sandboxed iframes.

**Design rules**

- Third-party code never runs inside the Veqsio API process. There is no dynamic `import`, `eval` or plugin sandbox to escape from.
- Scopes are granted explicitly by a system administrator when enabling a plugin, never implicitly. Updates that request more are not granted until re-approved.
- Plugins see only what a dedicated service user may see (permission schemes apply as for any user, deny by default).
- Everything Veqsio fetches for a plugin (manifest, deliveries) goes through an SSRF-safe client.

A runnable example is in [`examples/hello-plugin`](../examples/hello-plugin).

## Manifest reference

Served as JSON (at most 64 KiB). Unknown fields are rejected. Validated in `packages/api/src/plugins/manifest.ts`.

```json
{
  "schemaVersion": 1,
  "key": "com.acme.foo",
  "name": "Foo",
  "version": "1.2.3",
  "description": "What it does",
  "vendor": { "name": "Acme", "url": "https://acme.example" },
  "baseUrl": "https://foo.acme.example",
  "scopes": ["read:issues"],
  "events": ["issue.created", "comment.added"],
  "webhookPath": "/veqsio/events",
  "config": [
    { "key": "apiKey", "label": "API key", "type": "secret", "required": true },
    { "key": "mode", "label": "Mode", "type": "select", "options": ["fast", "safe"] }
  ],
  "uiPanels": [{ "location": "issue.sidebar", "title": "Foo", "path": "/panel" }]
}
```

| Field | Rules |
| --- | --- |
| `schemaVersion` | Must be `1`. |
| `key` | Reverse-DNS, lower case, at least three labels (`com.acme.foo`), max 128 chars. Unique per instance. |
| `version` | Semver (`1.2.3`, `1.0.0-beta.1`). |
| `vendor.url`, `baseUrl` | `https` only, no credentials, no query or fragment. (`http` is accepted only when the operator sets `PLUGINS_ALLOW_PRIVATE_HOSTS=true` for development.) |
| `scopes` | Any of `read:issues`, `write:issues`, `read:projects`, `write:projects` (the PAT scope names). `*`, `admin` and `read:*`/`write:*` are not available to plugins. `write:x` implies `read:x`. |
| `events` | Any of `issue.created`, `issue.updated`, `issue.deleted`, `issue.transitioned`, `comment.added`, `sprint.started`, `sprint.closed`, `sla.breached`. Requires `webhookPath`. (`sla.warning` is a webhook event for outgoing webhooks, not a plugin event yet.) |
| `webhookPath`, `uiPanels[].path` | Absolute path on `baseUrl`: starts with a single `/`, no query, fragment, backslash, whitespace or dot segments. |
| `config[]` | Admin-editable settings. `type` is `text`, `secret`, `select` (needs `options`), `boolean` or `number`. At most 50 fields. `secret` values are encrypted at rest (AES-256-GCM, `SECRETS_ENCRYPTION_KEY`) and never returned by the admin API. |
| `uiPanels[]` | `location` is `issue.sidebar`, `issue.tab`, `project.page` or `admin.page`. All four are rendered: the issue sidebar, a section at the bottom of the issue page (`issue.tab`), the bottom of the project overview (`project.page`) and the bottom of the Administration home (`admin.page`). Every panel is a sandboxed iframe; it only receives `?issue=` and `?project=` in the URL. |

## Lifecycle (admin API)

All under `/rest/api/2/admin/plugins`, system administrators only (plugin tokens are refused).

| Call | Purpose |
| --- | --- |
| `POST /` with `{ "url" }` or `{ "manifest" }` | Install (disabled). Returns the **signing secret once**. Creates the service user `plugin:<key>` (inactive for login). |
| `GET /`, `GET /:id` | List and read. Never contains tokens or secrets. |
| `POST /:id/enable` with `{ "grantScopes": [...] }` | Enable. `grantScopes` is required when the manifest requests scopes and must be a subset of them. The API token is returned **once**, the first time. Required settings must exist. |
| `POST /:id/disable` | Disable. The token stops working immediately. |
| `PUT /:id` with `{ "url" or "manifest", "confirm", "approveScopes" }` | Update. Without `confirm` it returns the diff (scopes, events, base URL) and changes nothing. With `confirm`, scopes no longer requested are revoked and **new scopes are granted only if listed in `approveScopes`**. A changed `baseUrl` disables the plugin. The key cannot change. |
| `DELETE /:id` | Uninstall: token dead, settings and delivery log deleted, service user deactivated. |
| `GET/PUT /:id/settings` | Read (secrets show `hasValue` only) / write `{ "values": { key: value } }`; `null` clears, omitted keys are kept. |
| `POST /:id/token`, `POST /:id/signing-secret` | Rotate. The old value stops working at once; the new one is shown once. |
| `GET /:id/deliveries?limit=` | Delivery log (status, HTTP status, attempts, latency, error). |

Manifest download: https only (private, loopback and link-local ranges refused), 10 s timeout, 64 KiB cap, redirects only within the same host, each hop re-checked.

## Events

Veqsio POSTs JSON to `baseUrl + webhookPath`:

```json
{ "event": "issue.created", "timestamp": "2026-01-01T10:00:00.000Z",
  "payload": { "issueKey": "ABC-1", "issueId": 12, "projectId": 3, "type": "issue.created" } }
```

Payloads are intentionally small: ids, keys, event type, `actor.displayName` where known, and `changedFields` (field names) for updates. Fetch details with the plugin token; what you can read is then governed by your scopes and the service user's permissions. **Internal service-desk comments never produce `comment.added` deliveries and their bodies are never sent.** An event is only sent if the plugin has the matching read scope granted (`read:issues` for issue, comment and SLA events, `read:projects` for sprint events).

Headers:

| Header | Meaning |
| --- | --- |
| `X-Veqsio-Event` | Event name. |
| `X-Veqsio-Delivery` | UUID, identical across retries of one delivery. Use it for idempotency. |
| `X-Veqsio-Timestamp` | Unix seconds when this attempt was signed. |
| `X-Veqsio-Signature` | `v1=` + hex HMAC-SHA256 of `"<timestamp>.<raw body>"` with the plugin's signing secret. |

Respond `2xx` within 10 seconds. Network errors, timeouts, `5xx`, `429` and `408` are retried (3 attempts, 1 s then 2 s backoff); other `4xx` are not. Redirects are not followed. After **20 consecutive failed deliveries** the plugin is disabled automatically and the reason is shown in the admin page. Tune with `PLUGINS_FAILURE_THRESHOLD`, `PLUGINS_MAX_ATTEMPTS`, `PLUGINS_RETRY_BASE_MS`, `PLUGINS_DELIVERY_TIMEOUT_MS`.

### Verifying signatures

Always verify the **raw** body, use a constant-time comparison, and reject timestamps older than 5 minutes.

JavaScript:

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

Python:

```python
import hmac, hashlib, time

def verify(secret: str, timestamp: str, raw_body: bytes, signature: str) -> bool:
    if not timestamp.isdigit() or abs(time.time() - int(timestamp)) > 300:
        return False
    mac = hmac.new(secret.encode(), timestamp.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest("v1=" + mac, signature)
```

## Calling the Veqsio API

Send `Authorization: Bearer vqp_...`. The token authenticates as the service user `plugin:<key>` and is limited to the **granted scopes** (same rules as personal access tokens, see [security.md](security.md)). It works only while the plugin is installed and enabled. It can never reach `/rest/api/2/admin`, `/scim`, token management, migration or other admin endpoints, whatever the service user's permissions.

The service user starts with no permissions. Add it to groups or project roles like any user (for example a read-only role on the projects the plugin may see). Scopes narrow; they never grant more than the service user has.

`GET /rest/api/2/plugins/self/settings` returns the plugin's own settings, secrets decrypted, to the plugin only.

## UI panels

`GET /rest/api/2/plugins/panels?location=issue.sidebar` (any signed-in user) lists enabled plugins' panels. The web app renders each in

```html
<iframe sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" src="<baseUrl+path>?issue=ABC-1&project=ABC">
```

- No `allow-same-origin`: the panel has an opaque origin, cannot read Veqsio cookies, storage or DOM, and Veqsio passes no tokens. Only `issue` (key) and `project` (key) are appended. A panel that needs data calls its own backend, which uses its plugin token.
- Messages to the parent use `postMessage(msg, '*')` (the only valid target for an opaque origin) with `source: "veqsio-plugin"`:
  - `{ source: 'veqsio-plugin', type: 'resize', height: 320 }` (clamped to 40-2000 px)
  - `{ source: 'veqsio-plugin', type: 'navigate', path: '/issues/ABC-2' }` (same-origin paths only; `//host`, schemes and backslashes are ignored)
- The host accepts messages only from that panel's own frame (`event.source`) and only with origin `"null"`. Anything else is ignored. Veqsio sends nothing to the panel.
- Your panel's server must allow being framed (no `X-Frame-Options: DENY`; use `Content-Security-Policy: frame-ancestors https://your-veqsio-host`).

## Security model

| Threat | Mitigation |
| --- | --- |
| Malicious plugin code on the server | None runs there. Plugins are separate processes/hosts. |
| Over-broad access | Scopes granted explicitly at enable; added scopes need re-approval; no wildcard or admin scopes; service user permissions deny by default. |
| Token theft | Shown once, stored as SHA-256 hash, rotatable, dead immediately on disable/uninstall; checked against the database on every request. |
| Forged or replayed deliveries | HMAC-SHA256 over timestamp and body, 5-minute window, per-plugin secret stored encrypted. |
| SSRF via manifest URL or `baseUrl` | https only, private/loopback/link-local/metadata blocked (names are resolved and checked), no redirects for deliveries, redirect only same-host for manifests. Residual: DNS rebinding between check and connect; add an egress firewall if you install untrusted plugins. |
| Data leakage in events | Whitelisted lightweight payloads, no internal comments, scope-gated events. |
| UI attacks | Sandboxed iframes without same-origin, no credentials, strict message protocol. See the CSP guidance in [security.md](security.md). |
| Runaway/failing plugins | 10 s timeout, bounded retries, circuit breaker. |
| Secret exposure | Config secrets encrypted at rest, never returned; signing secret and tokens never logged. |

Known limitation: the signing secret and token are shown once; there is no recovery, only rotation.
