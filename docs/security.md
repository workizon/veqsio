# Security model

This document describes how Veqsio protects data and what it assumes. To report a vulnerability, see [`SECURITY.md`](../SECURITY.md).

## Authentication

Three ways to prove who you are, all resolved by `sessionMiddleware` (`packages/api/src/auth/middleware.ts`) into one `user` on the request:

- **Sessions.** Username and password create a server-side session; the browser holds an opaque `session` cookie (`HttpOnly`, `SameSite=Lax`, and `Secure` whenever `WEB_URL` is `https`; an installation served over plain `http` must leave it off or the browser drops the cookie; `COOKIE_SECURE=true|false` overrides). Passwords are stored as bcrypt hashes.
- **Personal access tokens (PATs).** Sent as `Authorization: Bearer <token>`. Only a SHA-256 hash of the token is stored; every token expires (default 90 days, at most 365) and carries scopes (see [Token scopes](#token-scopes)).
- **SSO.** Microsoft Entra ID sign-in (`routes/sso.ts`) and generic OpenID Connect providers (`routes/oidc.ts`, see [Enterprise identity](#enterprise-identity)) end in the same session cookie.
- **SCIM bearer tokens** authenticate only the `/scim/v2` provisioning API and nothing else.

Deactivated users (`users.active = false`) never authenticate: the session middleware drops them whatever credential they present, and password login refuses them.

Anonymous requests get `401` on everything except the health check and the login endpoints.

## Authorization layers

Every protected route applies the layers that fit it. Deny by default.

1. **Global permissions** (`ADMINISTER`, create projects, ...) from permission entries for users and groups.
2. **Project permission schemes.** `requirePermission(...)` / `checkProjectPermission(...)` resolve the project from the issue, comment, or attachment in the URL and check `BROWSE_PROJECTS`, `CREATE_ATTACHMENTS`, and so on against the project's scheme (users, groups, project roles).
3. **Service desk roles** (`servicedesk/service.ts`): `admin`, `agent`, `customer`, `none`. Agent endpoints answer `404` to non-members so desk ids cannot be enumerated. Internal notes are hidden from everyone who is not desk staff.

Resources a caller cannot know about return `404`, not `403`. Request bodies use strict Zod schemas, so unknown keys are rejected rather than silently applied (mass assignment). Ownership is checked in the query that loads the data, not after it.

The generic attachment endpoints (`/rest/api/2/attachment/:id`, `/rest/api/2/issue/:key/attachments`) require `BROWSE_PROJECTS` on the issue's project. Earlier versions only required a login, which let any authenticated user, including portal customers, fetch any attachment by id.

## Customer portal threat model

Portal users are semi-trusted: they authenticate, but may be members of the public (`publicSignup`) or compromised accounts. We assume they will probe other customers' data and try to abuse the desk.

| Threat | Mitigation |
| --- | --- |
| Reading or commenting on another customer's request | `customerRequest` / `loadCustomerRequest` only returns requests where the caller is the requester or a participant; everything else is `404`. |
| Reaching internal data via the generic API | Customers are not project members, so the generic issue, comment and attachment APIs refuse them. |
| Seeing internal notes or agent attachments | Portal reads filter `isInternal = false`; the portal attachment list and download only expose files uploaded by the requester or participants. |
| Spam and request flooding | Per-user, per-desk hourly limits (see below). |
| Malicious uploads | Upload validation (see below); downloads are forced to `attachment`. |
| User enumeration via "add participant" | Same `204` whether or not the account exists. |
| HTML injection in notification emails | All user-controlled values are escaped (see below). |

Staff accounts are trusted with their desk's data and are not rate limited on comments.

## Email escaping

User-controlled strings (summaries, comment bodies, names, desk fields) are HTML-escaped in every email template before interpolation, and line breaks are stripped from subjects to prevent header injection. Do not add a template that interpolates raw values.

## Rate limits

- **Global API limiter** (`middleware/rate-limit.ts`): per-user and per-IP sliding windows, backed by Redis (or memory when `REDIS_URL=memory:`).
- **Portal limits** (`servicedesk/limits.ts`), per user per desk, per hour, returning `429` with `Retry-After` and a generic message:
  - new requests: `PORTAL_MAX_REQUESTS_PER_HOUR` (default 20)
  - comments: `PORTAL_MAX_COMMENTS_PER_HOUR` (default 60; desk staff exempt)
  - attachment uploads: `PORTAL_MAX_UPLOADS_PER_HOUR` (default 60; desk staff exempt)

  Values are read at call time. If Redis is unreachable the portal limiter fails open and logs the error, so an outage does not take the portal down. Behind a proxy, make sure it sets `X-Forwarded-For` correctly for the IP limiter.

## AI assist threat model

AI assist is optional and off by default (`ai_settings.enabled = false`); with it off every model-backed endpoint answers `503 AI is not configured` and no outbound call is ever made. Duplicate detection uses PostgreSQL full-text only and needs no model.

- **Prompt injection.** Issue text is untrusted. It is only ever sent in a user message inside `<untrusted_content>` tags (lookalike tags inside the text are defused), the system prompt tells the model to treat it as data, and the model has no tools and cannot call any API or change any issue. Suggestions are returned to the user and applied only when they click Apply.
- **Output is untrusted too.** Answers are stored/shown as plain text or Markdown through the existing sanitising renderer; additionally the server neutralises raw HTML, strips Markdown images (an exfiltration beacon) and non-http(s) links, and removes control characters. Structured answers (type, priority, labels, re-rank order) are validated against real names and ids; unknown values are dropped and nothing is created.
- **Data exposure.** Each feature re-checks BROWSE_PROJECTS on the issue's project (404 otherwise) and only uses data that caller can see: similar-issue candidates come from projects the caller can browse, label suggestions only from the same project, internal service-desk comments are sent to the model only for desk staff and such summaries carry `containsInternal: true`; responses are `Cache-Control: no-store` and never cached or shared. Portal customers get no AI endpoints. Anything the caller may see is sent to the configured endpoint: use a self-hosted model when data must not leave your network (the admin page says so).
- **Keys and URLs.** The provider key is encrypted at rest with the shared AES-256-GCM helper (`SECRETS_ENCRYPTION_KEY`, mandatory in production), accepted write-only and never returned (`hasKey` only). Base URLs must be https, without credentials, query or fragment; localhost/private hosts need `AI_ALLOW_PRIVATE_HOSTS=true` and link-local/metadata addresses are always refused; redirects are not followed. Only admins configure the URL, so SSRF is limited to what an admin can already reach; DNS rebinding is not defended against (use a network egress policy for strict setups).
- **Abuse and cost.** Per-user daily request limit (counted in `ai_usage`, default 50), per-user burst limit, global concurrency cap (`AI_MAX_CONCURRENT`, default 4), input cap (`max_input_chars`, default 12000, oldest comments dropped first), 30 s timeout, one retry on 429/5xx. Provider failures refund the quota.
- **Logging.** Prompts, keys and model answers are never logged or stored; `ai_usage` holds only user, feature, time and token counts. Provider errors are mapped to generic messages.
- **Not verified:** behaviour against real providers and models; resistance of any particular model to injection (the design assumes the model can be fooled and limits what a fooled model can do).

## Upload validation

Portal uploads (`routes/servicedesk-attachments.ts`, `servicedesk/upload-validation.ts`):

- one file per request, at most `PORTAL_MAX_ATTACHMENT_BYTES` (default 10 MB); oversized bodies are refused by `Content-Length` before they are buffered;
- at most 20 attachments per request;
- the MIME type must pass the storage allowlist (`STORAGE_ALLOWED_MIME_TYPES`) **and** match the file's first bytes for PNG, JPEG, GIF, PDF and ZIP; a declared type that contradicts the content is rejected;
- executables (Windows PE `MZ`, ELF, Mach-O, shebang scripts) are rejected whatever the declared type;
- active content types (HTML, SVG, XML, JavaScript) are never accepted; text types must be free of NUL bytes and must not start with markup;
- file names are sanitized (path separators and control characters removed, max 255 characters); the storage key uses a generated name, never the user's;
- downloads are streamed through the API with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and a sandboxing `Content-Security-Policy`, only after the same ownership check as comments.

There is no antivirus scan yet. A scanning hook (for example ClamAV before `uploadFile`) is the natural next step.

## HTTP security headers

The API sets `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` and `X-Frame-Options: DENY` on all responses (`middleware/security-headers.ts`). It deliberately does **not** set `Strict-Transport-Security` or a `Content-Security-Policy`: TLS termination and the page CSP are owned by the Nginx reverse proxy (see `nginx/` and `docs/deployment.md`).

## Secrets handling

- Secrets (database URL, storage keys, SSO client secret, session and token material) come from environment variables or the deployment's secret store, never from the repository. `.env.example` contains placeholders only.
- **Migrations from Jira.** Credentials for the live REST import (basic username and secret, or bearer token) are accepted per request, used for the duration of the job and never persisted or logged. Upstream error bodies are mapped to short messages so credentials and tokens are not echoed back. Use a dedicated, read-only Jira account or token and revoke it after cutover.
- PATs are stored hashed; passwords are stored with bcrypt.
- Change the seeded `admin` password immediately on any shared environment.

## Enterprise identity

### Generic OIDC single sign-on

Admins (system administrators only) configure any OIDC provider under `/rest/api/2/admin/oidc` (Admin > OIDC). Flow: `GET /rest/auth/1/oidc/:slug/login` then `GET /rest/auth/1/oidc/:slug/callback` (register `<public url>/rest/auth/1/oidc/<slug>/callback` as the redirect URI at the provider).

- **Client secret at rest.** Encrypted with AES-256-GCM (`auth/secrets.ts`), random IV per value, versioned envelope, authentication tag checked on read (tamper detection). The key is `SECRETS_ENCRYPTION_KEY` (32 random bytes, base64: `openssl rand -base64 32`). Outside production a key derived from a constant is used so development works; **in production a missing or malformed key makes saving a provider fail with 409** and nothing is stored in clear text. The API never returns the secret, only `hasSecret`. Rotating the key requires re-entering the secrets (no re-encryption tool yet).
- **CSRF and replay.** `state`, `nonce` and a PKCE (S256) verifier are generated per login, stored server-side (Redis, 10 minute TTL) and consumed on first use. In addition an HttpOnly `oidc_bind` cookie (SameSite=Lax, scoped to `/rest/auth/1/oidc`) ties the callback to the browser that started the flow, which defeats login CSRF (an attacker feeding a victim the attacker's callback URL).
- **ID token validation.** Signature verified against the provider's JWKS from discovery (cached 10 minutes, one refetch for an unknown `kid`, at most every 30 seconds). Only `RS256` and `ES256` are accepted; `none`, `HS*` and anything else are rejected before any key lookup. `iss` (must equal the discovery issuer, which must equal the configured one), `aud` (and `azp` when several audiences), `exp`/`nbf`/`iat` (60 second skew), `nonce` and `sub` are enforced. Discovery, JWKS and token endpoints must be `https` (plain `http` only with `OIDC_ALLOW_HTTP=true` and never in production); redirects are not followed.
- **Account linking.** The stable key is `(provider, sub)` (`user_identities.provider = 'oidc:<slug>'`). A new identity is linked to an existing local account by email **only if** the provider has "link by email" enabled **and** the ID token says `email_verified: true` (strictly boolean). Otherwise the login is refused (`account_exists` / `email_unverified`). A token that says `email_verified: false` never provisions anyone.
- **Provisioning.** Only when "auto-provision" is on and the email domain is in the allowed list (empty list = any domain). The domain list is checked on every login, also for returning users. Deactivated users are refused.
- **Group sync.** Values of the configured groups claim are created as Veqsio groups when missing and the user is added. The groups a provider synced for a user are remembered in the identity's `raw_profile.syncedGroups`; memberships are only removed when this provider added them earlier and no longer lists them, so unrelated manual memberships survive. Limitation: there is no schema flag marking a group "IdP-managed", so if an admin manually adds a user to a group that the IdP also manages and the IdP later drops it, that membership is removed. Groups that grant permissions should therefore be managed in one place.
- **Redirects.** The post-login target (`?next=`) must be a same-origin absolute path (no `//`, backslashes or control characters), otherwise `/dashboard`. Errors redirect to `/login?sso_error=<code>` with a fixed set of codes; provider error text, tokens and codes never appear in URLs or responses. The callback base URL comes from `OIDC_REDIRECT_BASE_URL` / `WEB_URL`, never from request headers in production.
- **Enforce SSO.** When any enabled provider has "enforce SSO", password login is refused for everyone except system administrators (break-glass so a broken IdP cannot lock the instance out). The older Microsoft Entra settings keep their own behaviour.

### SCIM 2.0

`/scim/v2/*` implements `ServiceProviderConfig`, `Schemas`, `ResourceTypes`, `Users` and `Groups` (list with filter, create, get, PUT, PATCH, DELETE). It is authenticated **only** by a dedicated SCIM bearer token created by a system administrator (Admin > SCIM). Only the SHA-256 hash is stored, the token is shown once, comparison is constant time, tokens can be revoked and `last_used_at` is tracked. Sessions and PATs are not accepted on `/scim`, and SCIM tokens are not accepted anywhere else.

- `DELETE /Users/:id` and `active: false` **deactivate** (the account, its issues and history stay). Deactivation revokes every web session (a per-user "revoked before" marker checked on each session read) and every personal access token, immediately. Reactivation does not restore old sessions or tokens.
- Errors use `urn:ietf:params:scim:api:messages:2.0:Error` and `application/scim+json`. Filters are parsed by a small strict parser and translated into parameterised SQL with LIKE wildcards escaped; unknown attributes give `invalidFilter`. Unknown attributes in request bodies are ignored (never applied), which is why SCIM payloads are validated leniently instead of with `.strict()`.
- SCIM users have no password; `userName` and email are stored lower-cased and must be unique (`409 uniqueness`).
- **Trust level.** A SCIM token is administrator-grade: it can create accounts, change the membership of any group (including groups that grant permissions) and deactivate any user, administrators included. Keep it in the IdP's secret store and revoke it when rotating. Not supported: bulk, sort, etags, password changes, value-path filters inside query filters.

### Token scopes

PATs carry `scopes` (default `["*"]`). A cookie session is never limited by scopes. For tokens, `middleware/token-scopes.ts` (mounted globally after the session middleware) is deny-by-default:

| Scope | Allows |
| --- | --- |
| `*`, `admin` | everything the user may do, including `/rest/api/2/admin`, `/scim`, migration, CSV import, SSO settings, token management |
| `read:*` / `write:*` | GET/HEAD / any method on every non-admin endpoint (`write` implies `read`) |
| `read:issues` / `write:issues` | issues, comments, worklogs, attachments, issue links, search (JQL search over POST counts as a read) |
| `read:projects` / `write:projects` | projects, versions, components, boards, sprints, agile API |

Anything that is not admin, issues, projects or the small "common" read set (`/myself`, `/serverInfo`, issue types, statuses, priorities, resolutions, fields) needs `read:*`/`write:*`. Admin families (including `mypersonalaccessTokens`) need `admin` or `*`, so a limited token cannot mint a stronger one; a scoped token also cannot create a `*` token. Request paths are lower-cased and slash-collapsed before matching. Legacy tokens stored as exactly `["read","write"]` (the old default) are treated as `*` so nothing breaks; other legacy `read`/`write` values map to `read:*`/`write:*`. Scopes narrow what a token can reach; they never grant more than the user's own permissions.

Expiry policy: tokens always expire. The default is `PAT_DEFAULT_EXPIRY_DAYS` (90) and the maximum `PAT_MAX_EXPIRY_DAYS` (365). Existing tokens without an expiry are unchanged; revoke and recreate them to adopt the policy.

### Not verified against real identity providers

The OIDC flow is tested against a fake IdP (generated RSA/EC keys, hand-signed JWTs, injected fetch) and SCIM against the documented Okta/Entra request shapes, not against live Okta, Entra, Keycloak or Google. Run a smoke test with your provider before relying on it.

## Plugins

Plugins are external services; see [`docs/plugins.md`](plugins.md) for the contract. Security properties:

- **No in-process code.** The API never imports or evaluates plugin code. Events leave as signed HTTP requests and plugins call back through the normal REST API.
- **Least privilege.** Scopes (`read:issues`, `write:issues`, `read:projects`, `write:projects`; never wildcards or `admin`) are granted by a system administrator at enable time and are never implied. An update that requests more scopes does not receive them until the administrator approves them; removed scopes are revoked. A plugin acts as its service user `plugin:<key>` (inactive for login, no password), so project permissions apply and default to deny. Plugin tokens (`vqp_...`, SHA-256 hashed at rest, shown once) are resolved against the database on every request and only while the plugin is enabled; they cannot reach admin, SCIM, migration or token endpoints, and the plugin admin API additionally refuses plugin principals.
- **Signed deliveries.** `X-Veqsio-Signature: v1=HMAC_SHA256(secret, "<timestamp>.<body>")`, receivers must enforce a 5 minute window. The per-plugin signing secret is stored AES-256-GCM encrypted (`SECRETS_ENCRYPTION_KEY`), shown once, rotatable. Payloads are whitelisted ids/keys; internal service-desk comments never trigger deliveries.
- **SSRF.** Manifest downloads and deliveries accept https only and refuse loopback, private, link-local, CGNAT, multicast and cloud-metadata addresses (hostnames are resolved and every address checked), do not follow redirects (manifests: same host only, each hop re-checked), time out after 10 s and cap manifest size. `PLUGINS_ALLOW_PRIVATE_HOSTS=true` relaxes private ranges and allows http for development only; link-local/metadata stay blocked. DNS rebinding between check and connect is not fully excluded: use an egress firewall for untrusted plugins.
- **Circuit breaker.** 20 consecutive failed deliveries disable the plugin with a visible reason.
- **Settings.** Fields of type `secret` are encrypted at rest and never returned by the admin API (only `hasValue`); the plugin reads them via its own token at `/rest/api/2/plugins/self/settings`.

### Framing plugin panels (CSP)

Panels render in `<iframe sandbox="allow-scripts allow-forms">` without `allow-same-origin`, so the plugin has an opaque origin and cannot touch Veqsio cookies, storage or DOM; no credentials are passed (only `?issue=KEY&project=KEY`). If you set a page CSP at the reverse proxy, allow only your plugin hosts to be framed instead of `*`:

```
Content-Security-Policy: ... frame-src 'self' https://hello-plugin.example.com https://other-plugin.example.net; ...
```

Without a `frame-src`/`default-src` restriction browsers allow any origin. The plugin's own server must permit framing by Veqsio (`frame-ancestors https://veqsio.example.com`). The host page accepts `postMessage` only from the panel's own frame with origin `"null"` and only the documented `resize` and same-origin `navigate` messages.

### Not verified

The plugin system is tested against a local fake plugin server. It has not been exercised with a real third-party plugin, behind the production reverse proxy, or in a browser against real cross-origin iframes. `GET /rest/api/2/issue/:key` is served without per-project permission checks (pre-existing), so a plugin with `read:issues` can read any issue key regardless of its service user's project permissions until that endpoint is permission-checked.

## Automated security suite

`packages/api/tests/integration/security.api.ts` (about 110 tests, part of `all.test.ts`, so it runs with the normal API test command) guards the properties below. It was written first and run against the code as it was; what it caught is listed under [Findings](#findings-from-the-automated-security-suite) with the fix.

| Area | What is asserted |
| --- | --- |
| Authentication sweep | The suite enumerates `app.routes` (every method and path, currently about 310) and calls each one anonymously, with a forged cookie and with a forged bearer token: all must answer `401`, except an explicit allowlist (`PUBLIC_ROUTES` in the test file, each entry with its reason: health, login, SSO and OIDC redirects/callbacks, inbound email which has its own secret, mock storage, server info). A new route that answers anything else to an anonymous caller fails the test until someone adds it to the allowlist on purpose; a stale allowlist entry fails too. SCIM routes must refuse web sessions. |
| Authorization (IDOR) | A second, ordinary user who is a developer in project `OTHER` (and nothing else) attacks data in project `TEST`: issue read/update/delete/clone/move/transition/changelog, comments (list/add/edit/delete), attachments (list/download/delete), worklogs (list/add/edit/delete/by user), filters (read/edit/share/delete/subscribe), dashboards, boards, columns, sprints (read/create/edit/delete/issues), agile reports, roadmap, project read/update/delete/components/versions/roles, watchers, votes, issue links, dev panel, plus issue creation in a foreign project. Each must be denied without leaking the victim's data, and a final test checks the victim's rows are unchanged. List endpoints (issue list, JQL, text search, filters, dashboards, boards, projects) must not contain the other project. A user with no permissions at all is denied the same things, and about 30 administration endpoints refuse ordinary users. |
| SQL injection | Twelve classic payloads through JQL values, field names, `ORDER BY`, text search, `startAt`/`maxResults`, user search, filter search/order, autocomplete, path parameters and the login form: never a `5xx`, never SQL text or parameters in a response, tables unchanged. |
| XSS | Script/HTML payloads stored in issue summary/description, comments, filters and dashboards come back byte-identical inside `application/json` with `X-Content-Type-Options: nosniff`; notification emails escape them; uploaded `.html` is never served inline. |
| Mass assignment | Issue create/update cannot set id, key, project, reporter or timestamps; ordinary users cannot modify accounts; admin user/project updates ignore id, hash and timestamps; filter/dashboard owner comes from the session. |
| CSRF | Cookie-authenticated state-changing requests with a foreign `Origin`, `Sec-Fetch-Site: cross-site`, or a non-JSON body are refused; the real web origin, same-host requests, curl-style clients and bearer tokens keep working; CORS does not reflect foreign origins. |
| Limits | 413 for JSON bodies above the limit (declared or streamed), 400 for malformed JSON and NUL bytes, over-long fields rejected, absurd nesting does not crash. |
| Path traversal | Mock storage cannot read outside its directory and is off unless `STORAGE_TYPE=mock`; hostile upload filenames cannot shape the storage key. |
| Header injection | CR/LF in summaries and comments never reaches an email subject or recipient. |
| Login | Throttling after 10 failures per address+username (429 + `Retry-After`; a per-address ceiling of 40 across usernames; successes do not count; other addresses unaffected), the throttle cannot be dodged by forging `X-Forwarded-For`, unknown user and wrong password are indistinguishable, non-string credentials are a `400`, no password hashes in any response. |

### Findings from the automated security suite

Severity is the author's judgement for a typical self-hosted deployment. "Confirmed" means the suite (or a direct request) demonstrated it against the code as it was; "by inspection" means the route had no check at all and was fixed before the suite existed, so the suite only guards the fix.

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| 1 | Critical | **Unauthenticated arbitrary file read.** `GET /mock-storage/:path{.*}` was mounted in every deployment (not only with `STORAGE_TYPE=mock`) and joined the decoded path onto the storage directory: `GET /mock-storage/..%2f..%2f..%2fetc%2fpasswd` returned `/etc/passwd`. Confirmed against the original handler. | Fixed: the route answers 404 unless `STORAGE_TYPE=mock`, the resolved path must stay inside the storage directory, and responses are `Content-Disposition: attachment` with `nosniff` and a sandbox CSP. |
| 2 | High | **Any logged-in user could read any issue.** `GET /issue/:key`, `GET /issue` (first 50 issues of every project), `GET /issue/:key/changelog` had no project check; transitions, watchers, votes and the dev panel only needed a login. By inspection (the last four confirmed by the suite). | Fixed: `BROWSE_PROJECTS` on the issue's project, otherwise the same `404` as a missing issue (keys cannot be enumerated); the list is limited to browsable projects. |
| 3 | High | **Cross-project writes through the global fallback.** `requirePermission(...)` could not resolve the project for routes whose project is in the body or whose `:key` is an issue key, and then accepted "has the permission in any project": creating issues in, cloning from, moving to a project the user cannot use, creating boards. Clone confirmed (it returned the victim's issue content); create/move/board by inspection. | Fixed: the permission is checked against the project in the URL/body (`requireIssueAccess`, explicit checks on create, clone, move, board create); `resolveProjectId` now understands issue keys, boards, sprints and worklogs. |
| 4 | High | **Worklogs had no authorization at all.** Any authenticated user could list, add, edit and delete worklogs of any issue; the issue id was taken from the body, independent of the key in the URL. Confirmed. | Fixed: browse/`WORK_ON_ISSUES` on the issue, author or `PROJECT_ADMIN` to change, issue id taken from the URL. |
| 5 | High | **Any logged-in user could change any project** (`PUT /project/:key` had only `requireAuth`) **and read boards, columns, sprints, sprint issues and agile reports of projects they cannot browse** (the permission resolved to "somewhere"). Confirmed. | Fixed: `PROJECT_ADMIN` for update; board, sprint, report and project routes resolve the project from the URL; board and project lists are filtered. |
| 6 | High | **Webhooks and notification schemes were open to every logged-in user**: list (including secrets), create (with an arbitrary URL the server then calls: SSRF), edit, delete, test, and delete notification schemes. List confirmed, the rest by inspection. | Fixed: system administrators only. Webhook targets are not restricted to public addresses (self-hosted installs often need internal receivers), so an administrator can still point a webhook at an internal host. |
| 7 | Medium | **Dashboards readable by id** by any user with browse rights anywhere. Confirmed. | Fixed: owner or administrator, else 404. |
| 8 | Medium | **Text search (`GET /search?text=`) searched all projects**; the JQL path was already trimmed. By inspection. | Fixed: results restricted to browsable projects (also in the cache key). |
| 9 | Medium | **No brute-force protection on login.** Only the global limiter existed (1000 requests/min per address) and the address was the *first* `X-Forwarded-For` entry, which the client controls. | Fixed: failure counters per address+username and per address (429 + `Retry-After`); the client address is taken from the proxy-appended end of `X-Forwarded-For` (`TRUSTED_PROXY_HOPS`, default 1; set 0 when there is no proxy). |
| 10 | Medium | **Server errors leaked SQL.** Many handlers return `err.message`, which for a database error contains the statement and its bound parameters (`Failed query: select ... params: ...`). Confirmed through JQL and issue-create errors. | Fixed: the `sanitizeDbErrors` middleware and the global error handler replace such bodies with `Internal server error` (the original is logged). |
| 11 | Medium | **JQL values reached typed columns unchecked.** `status = Nope`, `created >= "2026-01-01"`, `resolution = Unresolved`, `project ~ x` and huge numbers caused SQL errors (500, leaking SQL per finding 10) or, for dates, a `TypeError`. `resolution = Unresolved`, the most common JQL clause, did not work at all. Confirmed by the load test. | Fixed in `jql/translator.ts`: unresolvable names match nothing, dates are parsed and validated (ISO dates and `-30d` style offsets in quotes), `~` is only accepted on text fields, `Unresolved` means "no resolution". |
| 12 | Low | **Malformed requests became 500s**: `POST /session` with `{}`, malformed JSON bodies, NUL bytes, non-numeric ids in the path (`/board/abc`). Confirmed. | Fixed: 400/404 from `request-guards.ts` and input validation on login. |
| 13 | Low | **No request size limit** for JSON bodies (Bun's 128 MiB default). | Fixed: 2 MiB (`JSON_BODY_LIMIT_BYTES`), `413`. Upload endpoints are multipart and keep their own limits. |
| 14 | Low | **CSRF posture relied on SameSite=Lax alone**, and handlers parse JSON regardless of `Content-Type`, so a `text/plain` cross-site form post carried a valid body. No exploit was demonstrated; SameSite=Lax already blocks the classic case in current browsers. | Hardened: `csrfGuard` (see below). |
| 15 | Low | **Authenticated API responses were `Cache-Control: public`**, allowing a shared cache to store per-user data. | Fixed: `private`. |
| 16 | Low | **Username enumeration by timing**: unknown users skipped the bcrypt comparison. | Fixed: a dummy comparison is done. |
| 17 | Low | **Metadata endpoints** (issue types, statuses, priorities, resolutions, fields) were readable anonymously. Confirmed by the route sweep. | Fixed: authentication required. |
| 18 | Info | Notification emails for created/updated/commented issues were never sent: the routes passed the API response shape where the sender expected a database row, every lookup threw `Undefined values are not allowed`, and the exception was swallowed. Found because the failing queries dominated the load-test log. | Fixed (`asIssueRow`). Not a vulnerability, but it means email header injection and escaping could only now be tested end to end: both hold. |
| 19 | Info | `ADD_COMMENTS` was missing from the seeded default permission scheme, so ordinary users of a fresh installation could not comment. | Fixed in `packages/db/seed.ts` (existing installations: add the entry to the scheme). |

**CSRF posture (documented decision).** Cookies are `HttpOnly; SameSite=Lax` (`Secure` in production over HTTPS). On top of that `csrfGuard` refuses cookie-authenticated `POST/PUT/PATCH/DELETE` requests when `Sec-Fetch-Site` is `cross-site`, when an `Origin` header is present that is neither `WEB_URL` (or one of `CORS_ORIGINS`) nor the request's own host, or when the body is not JSON (multipart only on upload endpoints). Requests without those headers (curl, scripts) and bearer-token requests are unaffected. This makes `WEB_URL` mandatory in production, which the deployment guide already requires. CORS allows only `WEB_URL` with credentials.

### What the suite does not cover (honest limits)

- **Real storage backends.** Attachment serving was tested against the mock backend only. With S3/R2 the browser downloads from the storage origin via a signed URL; whether that origin serves uploaded HTML inline depends on the bucket configuration (set `Content-Disposition: attachment` or use a separate domain).
- **SSRF.** Webhook and application-link URLs are not filtered for private addresses (administrator-only after finding 6).
- **Stored XSS in the web app.** The suite proves the API returns payloads as data; whether every React component renders them as text was not audited (React escapes by default; any `dangerouslySetInnerHTML` use was not reviewed in this pass).
- **Service desk portal, SCIM and OIDC authorization** are covered by their own suites (`portal-hardening`, `scim`, `oidc`); the IDOR sweep here targets the core API. Service desk routes are included in the anonymous sweep only.
- **Rate limiting without a proxy**: a deployment that exposes the API directly must set `TRUSTED_PROXY_HOPS=0`, otherwise clients can still choose their own address through `X-Forwarded-For`.
- **Not tested at all:** race conditions, business-logic abuse, dependency vulnerabilities, TLS and header configuration of the reverse proxy, the WebSocket endpoint.
- **Unconfirmed:** during the first heavy load run the API stopped answering database queries (pooled connections stuck waiting for the client) while the log was full of `Undefined values are not allowed` errors from the notification bug (finding 18). Sending `POST /session` with `{}` repeatedly did not reproduce it, so the cause is unproven. It is recorded because a bound `undefined` parameter wedging a `postgres.js` connection would turn any such 500 into an availability problem.

## Role-based permission scheme
Administration → Permission schemes → **From role template** (or `POST /rest/api/2/permissionscheme/templates/role-based`) creates a scheme whose entries are per project role: **Viewers** (browse, see watchers and votes), **Commenters** (Viewers plus comment, edit/delete own comments; they cannot create or edit issues), **Developers** (work on issues) and **Administrators** (project administration and moderation). Roles that do not exist yet are created; nothing existing is changed. Add people to the roles in each project (Project settings → People), then assign the scheme to the projects. Roles are not cumulative: each role lists all of its grants.

## Who can hold a permission
A permission scheme entry can name: a single user (direct), a group, a project role (whose members are users and groups, per project), the **project lead** of the project the check is about, any logged-in user, or anyone (anonymous). Not supported: reporter, assignee and custom-field-valued users as holders of project permissions (issue security levels do support reporter, assignee and project lead as members).

## Automation rules

Automation rules run with the identity of the person who created them and can change issues, add comments and call webhooks, so managing them is administration. A global rule (no project) needs the system administrator permission; a project rule needs project administrator rights on that project. A rule you may not manage does not appear in lists and answers 404 on every route (read, change, toggle, run, delete, history). Webhook actions can only be added by system administrators. A project rule can only be run manually on issues of its own project. Before this was enforced any signed-in user could manage every rule; instances created from earlier builds should review their rules (Automation page) after upgrading.
