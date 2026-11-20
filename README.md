<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/veqsio-logo-dark.png">
    <img src="docs/assets/veqsio-logo-light.png" alt="Veqsio" width="360">
  </picture>
</p>

Open-source work management for teams: a self-hosted alternative to Jira Software and Jira Service Management, with first-class migration from existing Jira instances.

Veqsio is developed and maintained by [Workizon Ltd](https://workizon.ltd) together with the open-source community.

> Status: active development.

## Features

Everything below is implemented. Items marked "Enterprise module" are paid modules that are **not part of this
repository** (see [License](#license)); the rest is in this repository under the AGPL. The comparison with Jira is in
[`docs/jira-parity.md`](docs/jira-parity.md).

### Work management
- **Projects and issues:** issue types (incl. sub-tasks and epics), statuses with categories, priorities, resolutions, labels, components, versions (fix/affects), issue links, watchers, votes, attachments (with thumbnails and signed URLs), change history, clone and move, bulk operations, CSV export, per-project issue keys.
- **Custom fields** (text, number, date, user, select, multi-select, checkbox, URL) with contexts, field configurations, screens and screen schemes.
- **Story points and time tracking:** story points on issues, original/remaining estimates, worklogs with reports.
- **Issue view like Jira:** status button with every workflow transition, resolve dialog, details panel, inline editing, child issues, linked issues, keyboard shortcuts, quick operations.
- **Issue list panel (like Jira):** the page of an issue shows the list you came from on the left (or the project's latest issues), with a searchable "Order by" menu and a collapse button, and the project menu beside it, also collapsible.
- **Create issue dialog:** a Jira-style window (labels on the left, reporter, attachments by drag and drop, "Assign to me", "Create another") whose fields follow the project: its issue types, priorities, components and **custom fields by type, project and context**; "Configure fields" hides the ones you do not use.
- **Custom fields on the issue view:** shown and editable in the details panel, for the project and issue type of the issue.
- **Move with a workflow check:** moving an issue to another project checks the issue type, the workflow (and asks for a status when the current one does not exist there), custom fields, components, versions, sprints and the security level, and shows the result before anything changes ([docs/moving-issues.md](docs/moving-issues.md)).
- **Tables:** click a Name/Summary header to sort, drag a column border to resize (remembered per table); lists that can hold many rows (groups, users, group members) page and search on the server.
- **Dashboards:** 20+ gadget kinds including number tiles, charts, workload, two-dimensional tables, heat map, sprint and flow charts, service desk gadgets and notes; choose a **default dashboard** that opens first after sign-in.
- **Rich text:** Markdown editor with preview, @mentions, task lists, paste of tables and formatted text from Excel/Sheets/Jira/web pages (converted to Markdown tables), paste of screenshots, Jira wiki markup rendered safely, threaded comments.
- **Workflows:** visual workflow designer with transitions, conditions, validators and post-functions; workflow schemes; transition screens.
- **Issue history depth:** time in status per issue (Transitions tab) and an Average time in status report per project, board or sprint; description version history with diff and restore; work item type switch with preview (fields the new type lacks go into the description with a warning, status mapping, sub-task rules); workflow governance (statuses closed for new issues, workflow change history, `workflowGovernance` any / constrained) ([docs/issue-history.md](docs/issue-history.md)).
- **Search:** JQL parser with autocomplete and validation, `LIMIT n` and relation functions (`linkedIssues`, `blockedBy`, `blocking`, `subtasksOf`, [docs/jql.md](docs/jql.md)), relative dates, sprint/parent fields, saved and favourite filters, sharing by user/group/project/everyone, email subscriptions (daily/weekly digests), PostgreSQL full-text search.
- **Sprint automation:** completing a sprint can create the next one and carry unfinished issues over (board setting in the backlog).
- **Boards and sprints:** Kanban and Scrum boards with swimlanes, quick filters, WIP limits, drag and drop; backlog with real sprint planning (create, start, complete, move issues).
- **Initiatives, milestones and releases:** workspace-level initiatives group epics and projects with rolled-up progress (cancelled work excluded), health updates and a timeline strip, trimmed to what each viewer can browse; per-project milestones with linked issues, roadmap markers, an issue sidebar field and JQL `milestone`; a Releases page per project with progress, release notes and "Mark released" ([docs/initiatives-and-milestones.md](docs/initiatives-and-milestones.md)).
- **Reports:** burndown, velocity, sprint report, cumulative flow, control chart, epic report (units: issues, hours or story points), plus **Roadmap** with epics, releases, dependencies and drag-to-reschedule.
- **Dashboards:** configurable gadgets (pie charts, assigned to me, filter results, activity stream, created vs resolved, average age, resolution time, sprint health).
- **Templates, recurring issues and project lifecycle:** issue templates (per project or global, summary placeholders, "Create from template" in the create dialog), recurring issues on a schedule (daily, weekdays, monthly; time zones; idempotent per slot; run log), project templates (Software, Kanban, Business, Bug tracking) and copy-settings-from-a-project with preview, project archive and restore (read-only, hidden from lists and default searches) and delete only for archived projects with typed confirmation, and a terminology option (call issues issues, work items, tickets or tasks) ([docs/templates-and-lifecycle.md](docs/templates-and-lifecycle.md)).
- **Approvals:** multi-approver approvals on issues and service requests (all / any / n of m / percentage), templates per project, reminders, expiry, auto-approve rules, workflow gating and auto-transitions, customer approvers on the portal ([docs/approvals.md](docs/approvals.md)).
- **Timesheets (Enterprise module):** Tempo-like weekly timesheets on the core worklogs, submit and approve with locking, teams with leads and approvers, accounts, billable flag and effective-dated rates, work attributes, per-cell week-grid editing, planned hours per person and week against actual, utilisation reports with CSV export, reminder emails.
- **Plans (Enterprise module):** Advanced-Roadmaps-like planning: cross-project plans (projects, boards, filters) with sharing and per-viewer permission trimming, a configurable hierarchy above the epic with roll-ups, a timeline with sprints, releases and dependency warnings, team capacity versus load, what-if scenarios that can be applied to the real issues with per-issue results, and Auto-schedule (earliest-deadline-first that respects Blocks dependencies and per-person capacity, saved as a scenario you review before applying).
- **ITSM (Enterprise module):** incident, problem and change management on the service desk: impact x urgency priority matrix, acknowledge (MTTA), major incidents with stakeholder e-mail and the `incident.major` event, one incident timeline, postmortems, known errors with workarounds, scored change risk assessment, CAB and ECAB approvals on the approvals engine, a change calendar with conflict detection and maintenance windows, mandatory post-implementation review, MTTA/MTTR/volume/breach reports.
- **Automation:** rules with triggers, conditions and actions, execution history.
- **Notifications:** email (SMTP) with notification schemes, outgoing webhooks (HMAC-signed, retries, delivery log), in-app updates.
- **Real time:** live refresh of boards and issues, presence ("also viewing") and typing indicators over authorized WebSocket channels.
- **Git integrations:** link GitHub, GitLab, Gitea (self-hosted too) and Bitbucket Cloud repositories to a project; signed webhooks put branches, commits, pull requests and build status on the issue by issue key, smart commits (`PROJ-1 #comment ... #done`), create a branch from an issue, release notes per version (`docs/git-integrations.md`).
- **Feature and module switches:** Administration → Features and modules turns Service Desk, Dashboards, Automation, Approvals, Roadmap, Time tracking, Git integrations, Integrations, Intake, Wiki / Pages, Status updates, Views and Comment reactions on or off for the whole instance (menus hide, API answers 404, data is kept), and enables/disables the installed modules.
- **Intake / triage:** per-project intake queue where submissions are not issues until accepted: accept (creates the issue), decline, snooze (returns automatically), mark duplicate, bulk actions, requester emails; sources are an in-app form, an unguessable public form (honeypot, rate limits, size limits), an inbound email webhook and the REST API (`docs/intake.md`).
- **Public projects and SEO:** projects can be made readable without signing in (read-only, no emails or internal comments, service desk excluded). Server-rendered pages with canonical URLs, Open Graph, JSON-LD, sitemap.xml and robots.txt, an indexing policy (all / search engines only / none) and `llms.txt` plus a Markdown view of every issue for LLM tools (`docs/public-projects.md`).
- **Instance settings:** password policy, attachment size and blocked file types, and an announcement banner, editable at runtime under Administration → Instance settings.
- **Relations and dependencies:** relates to, blocks, duplicates, implements and clones links that show on both issues, custom link types for administrators, and Starts before / Finishes before dependencies (one per pair, no cycles) with date-conflict warnings and arrows on the roadmap ([docs/relations-and-status-updates.md](docs/relations-and-status-updates.md)).
- **Status groups:** Backlog, To do, In progress, Done and Cancelled; Cancelled closes an issue but is left out of progress, velocity and burndown. A status in use cannot be deleted and exactly one workflow is the default.
- **Project status updates:** On track / At risk / Off track posts with history and a badge on the project page and the projects list; per-project switch `updates`.
- **Wiki / Pages:** workspace and project pages with nesting, Markdown editor, table of contents, version history with diff and restore, comments, page locking, full-text search (also in the command palette), issue key links and "convert highlighted text to issue" with a link back ([docs/pages.md](docs/pages.md)).
- **Comment reactions, backlog ranking, bulk create and createmeta** in the issue UI and REST API.

### Service Desk
- **Customer portal** (`/portal/<slug>`): request catalog, dynamic request forms (form builder with field types, visibility and mapping), knowledge-base suggestions while typing, my requests, comments, attachments, participants, CSAT.
- **Agent workspace:** queues with live SLA timers, internal notes hidden from customers, canned responses, SLA badges on the issue view, reports (created vs resolved, workload, CSAT, SLA compliance).
- **SLAs modelled on Jira Service Management:** calendars with time zones, working intervals and holidays; start/pause/stop conditions; goals with criteria; near-breach warnings and breach notifications (email and webhook).
- **Service desk projects from the UI:** creation wizard with templates (IT support), per-desk settings, organisations, public signup or invited customers.
- **Inbound email channel:** mail gateways post emails to a secured endpoint; new mail becomes a request, replies become public comments.
- **Knowledge base:** articles, search, helpfulness votes.

### Migration from Jira
- **XML backup** (Data Center) with dry-run, conflict resolution, pause/resume.
- **Live import over REST** from Jira Cloud and Server/Data Center: projects, issues with original keys, comments, worklogs, links, sub-tasks, labels, components, versions, history, attachments, custom fields, workflows, boards with columns, sprints. One click, re-runnable, with **Sync changes from Jira** until cutover.
- **CSV import** (Jira export compatible) with column mapping and a validation dry-run.
- **Import from other tools**: live import from **Linear**, **Asana** and **ClickUp** with a personal token, plus a documented **JSON file** import. Preview (dry run) with counts and warnings, people matched by e-mail (optional placeholder users), unsupported fields reported, progress, error log and cancel, re-runnable without duplicates ([docs/migration-other-tools.md](docs/migration-other-tools.md)).

### Administration and security
- Users, groups, project roles, global and project **permission schemes**, notification schemes, issue type / screen / field configuration / workflow schemes.
- **Project settings like Jira:** the project menu groups General, Issues, Structure, Access and Integrations; **Permissions** (grant and remove, switch scheme, permission helper), **Users and roles**, **Issue security**, **Notifications**, project **Audit log** and **Re-index** ([docs/permission-review.md](docs/permission-review.md)).
- **Permission review for administrators:** who has access to which project, through roles, groups or directly, with findings for audits and CSV export (`/admin/permission-review`).
- **SLAs like Jira:** list of SLAs on the left; the selected one shows its start, pause and stop conditions and its goals with calendar.
- **Audit log** with filters and CSV export; **configuration health check** (`/admin/health`); backup/restore, mail server and general settings; system info.
- **Identity:** local accounts, password reset, SSO with Microsoft Entra ID and any OpenID Connect provider (PKCE, domain restrictions, group sync, enforce-SSO), **SCIM 2.0** provisioning, personal access tokens with scopes and expiry.
- **Administration is organised in sections** (User management, Projects, Issues, Security, Apps and integrations, Import and migration, System) with a sidebar and a home page; the gear menu follows the same grouping.
- **Who can do what:** a permission scheme grants a permission to a user, a group, a project role, the **project lead**, any logged-in user or anyone; a ready-made **role-based scheme** (Viewers, Commenters, Developers, Administrators) can be created in one click; Edit All / Delete All Worklogs for team leads ([docs/security.md](docs/security.md)).
- **Enterprise identity (licence feature):** SAML 2.0 SSO and LDAP / Active Directory sign-in and sync, in addition to OIDC and SCIM; **issue security levels** that hide issues from everyone outside the level.
- **Sign-in and sessions:** password policy, failed-sign-in lock (threshold and window), inactivity sign-out and maximum session length, all in Instance settings.
- **Custom fields:** values with colour, description and archive (a value that issues carry is archived, not deleted).
- **Configuration as code:** export and import of instance settings, switches and per-project configuration as JSON with a preview ([docs/config-as-code.md](docs/config-as-code.md)).
- **Performance:** load-test and index tooling for 100k and 1M issues in `loadtest/` and `scripts/perf/`.
- **Security by default:** deny-by-default authorization, strict input validation, escaped notifications, rate limits, upload content sniffing, security headers, published threat model ([docs/security.md](docs/security.md)).
- **Open core:** AGPL-3.0 community edition plus paid, licence-gated modules that are delivered separately (offline licence keys). See [License](#license).

### Progressive web app
- Installable on a phone or desktop (web app manifest with the instance name, icons), offline page when the network is down; no API data or user pages are cached.
- Browser push notifications (Web Push, VAPID keys generated per instance): assignments, @mentions, comments on issues you follow and on-call pages; turn on under Personal settings, choose which events you want and set quiet hours with your time zone (on-call pages still get through unless you switch them off).
- Swipe on the board (touch screens only): swipe a card to move it to the previous or next column; the card menu offers the same moves without gestures.
- On-call schedules with alert ingestion: rotations, overrides for leave, who is on call now, alerts from monitoring tools (deduplicated, acknowledge/close, push to the person on call).  Administration → On-call schedules.
- Teamspaces: a team, its projects and one view of its open work (Projects → Teamspaces).
- Customers linked to issues, with importance and revenue (Projects → Customers, panel on every issue).

### Extensibility and AI
- **MCP server and REST client:** a Model Context Protocol server (`packages/mcp`, stdio) lets Claude and other assistants search with JQL, read, create, comment on, assign, link and transition issues and read sprints and release notes. It talks to the REST API with a personal access token, so permissions and token scopes apply; read-only by default; user text is labelled as untrusted data. Includes a typed TypeScript client (`packages/client`) ([docs/mcp.md](docs/mcp.md)).
- **Integrations:** per-project inbound webhooks (Grafana, GitHub Actions, scripts) with their own secret, a safe JSON-path template mapping, HMAC or shared-secret auth, rate and size limits, idempotency keys, dedup keys (repeat = comment, "resolved" = transition to done), a dry-run test and a redacted delivery log; a ready-made Sentry source (`Sentry-Hook-Signature`, level to priority); outgoing Slack (blocks) and Microsoft Teams (adaptive card / MessageCard) notifications per project and as instance default, SSRF-guarded, encrypted, rate limited, with retries and a log. Plus **Copy as prompt** in the issue menu and a **peek view** (`?peek=KEY`) on the issue list, boards and backlog ([docs/integrations.md](docs/integrations.md)).
- **AI agents as users:** agent service accounts you can assign issues to and @mention, with signed webhook triggers, short-lived scoped run tokens, a per-issue run log with a Stop button, rate and loop limits ([docs/agents.md](docs/agents.md)).
- **Plugins:** out-of-process plugins described by a manifest, signed webhook events, scoped API tokens, sandboxed iframe panels ([docs/plugins.md](docs/plugins.md)).
- **Optional AI assist** (off by default, self-hostable models): similar-issue detection (works without any model), thread summaries, triage suggestions, release-note drafts.
- **Jira REST API v2 compatible** endpoints and Jira-style agile API.

### Operations
One-command installer for a clean server (Docker, secrets, migrations, HTTPS via Caddy, upgrades with automatic database backup), Docker Compose production stack, Nginx, Let's Encrypt scripts, Prometheus and Grafana, optional OpenTelemetry traces (OTLP/HTTP, standard `OTEL_*` variables, nothing sent unless you set an endpoint; see [docs/observability.md](docs/observability.md)), structured JSON logs with request ids, a token-protected `/metrics` endpoint, `/health` and `/ready` probes, job heartbeats ([docs/observability.md](docs/observability.md)), multi-node operation with `VEQSIO_ROLE` and advisory-locked jobs ([docs/multi-node.md](docs/multi-node.md)), tested backup and restore-verification scripts ([docs/backup-and-recovery.md](docs/backup-and-recovery.md)), an OpenAPI 3.1 REST reference at `/api-docs` ([docs/api.md](docs/api.md)), versioned database migrations with a startup schema guard, backups, log rotation, deployment guide ([docs/deployment.md](docs/deployment.md)).

### Public demo

`demo.veqsio.com` runs the Enterprise edition with rich seeded data (own issue types and workflow, custom fields, dashboards, service desk, screenshots), is reset every hour (with a countdown in the banner) and refuses outgoing and system functions.

## Screenshots

Seeded demo data (`bun seed-demo.ts`, see below). Images are 2x so they stay sharp on high-density displays.

| | |
| --- | --- |
| **Your work**: stats, assigned issues, projects<br>![Your work](docs/screenshots/home.png) | **Issues** with type, status, priority and assignee<br>![Issues](docs/screenshots/issues.png) |
| **Dashboards** with gradient charts and gadgets<br>![Dashboard](docs/screenshots/dashboard.png) | **Scrum board** with an active sprint<br>![Board](docs/screenshots/board.png) |
| **Backlog** and real sprint planning<br>![Backlog](docs/screenshots/backlog.png) | **Issue view** with details, activity and comments<br>![Issue view](docs/screenshots/issue-view.png) |
| **Workflow transitions** in the status button<br>![Transitions](docs/screenshots/issue-transitions.png) | **JQL** with autocomplete<br>![JQL autocomplete](docs/screenshots/jql-autocomplete.png) |
| **Projects** with progress and shortcuts<br>![Projects](docs/screenshots/projects.png) | **Agile reports**: burndown, velocity, cumulative flow<br>![Reports](docs/screenshots/reports.png) |
| **Workflow designer**: statuses, transitions, conditions, validators, post-functions<br>![Workflow designer](docs/screenshots/workflow-designer.png) | **Service desk queues** with live SLA timers<br>![Service desk queues](docs/screenshots/servicedesk-queues.png) |
| **Service desk reports**: created vs resolved, workload, CSAT, SLA compliance<br>![Service desk reports](docs/screenshots/servicedesk-reports.png) | **Request form builder**: field types, visibility, mapping<br>![Form builder](docs/screenshots/form-builder.png) |
| **SLA metrics** with start, pause and stop conditions and goals<br>![SLA editor](docs/screenshots/sla-editor.png) | **SLA calendars**: time zones, intervals, holidays<br>![Calendar editor](docs/screenshots/calendar-editor.png) |
| **Create a service desk** from a template<br>![Create service desk](docs/screenshots/desk-wizard.png) | **Audit log** with filters and CSV export<br>![Audit log](docs/screenshots/admin-audit.png) |
| **Configuration health check**<br>![Health check](docs/screenshots/admin-health.png) | **Dark theme** on neutral graphite<br>![Dark dashboard](docs/screenshots/dashboard-dark.png) |
| **Dark theme**: board<br>![Dark board](docs/screenshots/board-dark.png) | **Dark theme**: your work<br>![Dark home](docs/screenshots/home-dark.png) |
| **Plans** (module): cross-project roadmaps<br>![Plans](docs/screenshots/plans-list.png) | **Plan timeline** with hierarchy, sprints and dependencies<br>![Plan timeline](docs/screenshots/plans-timeline.png) |
| **Timesheets** (module): weekly grid with submit and approve<br>![Timesheets](docs/screenshots/timesheets.png) | **Pages**: team wiki with history, comments and issue links<br>![Wiki page](docs/screenshots/wiki-page.png) |
| **Customer portal**: search and request types<br>![Customer portal](docs/screenshots/customer-portal.png) | **Portal**: my requests with status tabs<br>![Portal requests](docs/screenshots/portal-requests.png) |
| **Portal**: request with conversation and details<br>![Portal request](docs/screenshots/portal-request.png) | **Plans**: team capacity and utilisation<br>![Plans capacity](docs/screenshots/plans-capacity.png) |
| **ITSM** (module): incidents, problems, changes<br>![ITSM incidents](docs/screenshots/itsm-incidents.png) | **Mobile**: the board on a phone<br><img src="docs/screenshots/mobile-board.png" alt="Mobile board" width="260"> |

## Install on a server (one command)

On a clean Ubuntu, Debian or RHEL-family server (x86_64 or arm64, about 2 GB RAM, 10 GB disk, ports 80/443 open):

```bash
curl -fsSL https://raw.githubusercontent.com/workizon/veqsio/main/install.sh | sudo bash
```

With your own domain, the installer also gets and renews a Let's Encrypt certificate (the DNS record must already point at the server):

```bash
curl -fsSL https://raw.githubusercontent.com/workizon/veqsio/main/install.sh \
  | sudo bash -s -- --domain support.example.com --email admin@example.com
```

The installer detects the OS, installs git, Docker and the Compose plugin if they are missing, downloads Veqsio to `/opt/veqsio`, generates all secrets, builds the images, applies the database migrations, creates the first administrator (random password, printed once) and starts PostgreSQL, Redis, the API, the web app and Caddy. Only Caddy listens on a public port; databases are never exposed.

Run it again to **upgrade** (the database is dumped to `/opt/veqsio/backups` first; existing secrets are kept). Useful options: `--dir`, `--ref <branch|tag>`, `--http-port`, `--https-port`, `--admin-email`, `--admin-password`, `--license-key` (Enterprise licence), `--demo-data` (sample data for a demo or trial; on a terminal the installer also asks, default no), `--swap` (adds swap on small servers), `--dry-run`. `./install.sh --help` lists everything. If you cloned the repository, run `sudo ./install.sh` from the checkout. The raw URL above works once the repository is public; for a private repository clone it and run the script locally.

After the first sign-in: change the administrator password, configure the mail server (Admin > System), and read [docs/deployment.md](docs/deployment.md) for backups, monitoring and object storage. The installer script itself is covered by offline checks (`scripts/test-installer.sh`).

**Tested platforms.** The installer was run end to end on clean servers (2 vCPU, 4 GB RAM, x86_64, plain HTTP on the server IP, `--swap`) on 2026-11-13:

| OS | Result |
|---|---|
| Ubuntu 24.04 | passed |
| Debian 12 | passed |
| Rocky Linux 9.8 | passed (the RHEL family is installed from the Docker CE repository for RHEL 9) |

On each one the install, a re-run (secrets kept, database backed up first), a reboot (all containers restart by themselves), the `/health`, `/login` and sign-in checks, the published ports (only 22, 80 and 443) and creating and reading an issue through the API passed. A first install builds the images on the server and takes about 5 minutes.

**Not tested yet:** arm64, Ubuntu 22.04, a custom domain with Let's Encrypt, `--demo-data` on a fresh server, upgrading from an older release, AlmaLinux, CentOS Stream, Fedora and Amazon Linux (they are accepted by the installer but have not been run).

## Stack

Bun + Hono API, Next.js 15 web app, Drizzle ORM, PostgreSQL 15+, Valkey 8 (or another Redis-compatible server).

```
packages/
  api/     Hono REST API (Bun)
  web/     Next.js frontend
  db/      Drizzle schema, migrations, seed
  shared/  shared types
docs/      design specs, plans, deployment guide, todo
```

## Quick start (development)

Requirements: [Bun](https://bun.sh) 1.1+, Docker (for PostgreSQL and Redis).

```bash
cp .env.example .env
docker compose up -d
bun install
```

Create the schema and seed demo data:

```bash
cd packages/db && bun migrate.ts && bun seed.ts
```

Run the API and the web app (in two terminals):

```bash
cd packages/api && bun run dev
```

```bash
cd packages/web && bun run dev
```

Optional demo data for a public demo or the screenshots above: 10 extra users, 4 projects (scrum and kanban) with about 85 issues, epics, sprints (closed, active, future), versions, components, labels, comments, worklogs, links, saved filters and two dashboards. It is deterministic, only adds rows and refuses to run on a database that already has issues. All demo users share the password `demo12345` (set `DEMO_PASSWORD` to change it); never run it on production data.

```bash
cd packages/db && bun run seed:demo
# optional, needs the API running: adds an IT service desk with 10 customer requests
API_URL=http://localhost:3040 bun scripts/demo/seed-servicedesk.ts
```

Open http://localhost:3001 and sign in with the seeded administrator (`admin` / `admin123`). **Change this password immediately on any shared environment.**

## Tests

The API tests need PostgreSQL and use in-memory Redis:

```bash
cd packages/api
REDIS_URL=memory: \
TEST_DATABASE_URL=postgresql://veqsio:veqsio@localhost:5460/veqsio_test \
DATABASE_URL=postgresql://veqsio:veqsio@localhost:5460/veqsio_test \
bun test src/**/*.test.ts tests/integration/all.test.ts
```

Create the `veqsio_test` database and apply the migrations to it (`DATABASE_URL=... bun migrate.ts` in `packages/db`) before the first run. Use `REDIS_URL=memory:` so the suite does not share Redis with anything else. End-to-end tests: `cd packages/web && npx playwright test`.

## Migrating from Jira

| Source | Where | Notes |
| --- | --- | --- |
| Jira Data Center XML backup | Admin → Import from other tools → Jira backup file | dry-run, conflict resolution, pause/resume |
| Live Jira (Cloud or Server/DC) | Admin → Import from other tools → Jira (live, REST) | API token / PAT; projects, issues, comments, worklogs, links, attachments, history, custom fields, boards, sprints; re-runnable |
| CSV (Jira export compatible) | Admin → Import from other tools → CSV file | column mapping, validation before import |
| Linear, Asana, ClickUp, JSON file | Admin → Import from other tools | token or file; preview first, then one click; see [docs/migration-other-tools.md](docs/migration-other-tools.md) |

Enter the Jira URL and a token, press **Import everything now**, and keep pulling changes with **Sync changes from Jira** until you switch teams over. Workflows are migrated too: real workflows are read from Jira Cloud when available, otherwise a workflow per project and issue type is inferred from the status history of the imported issues (conditions, validators and post-functions are not carried over). A workflow scheme is created per project and only assigned if the project has none yet. Not migrated yet: permission and notification schemes (configure them in the admin screens or use the XML backup import). Credentials entered for the REST import are used only for the running import and are never stored.

## Service Desk

Create a service desk project at `/servicedesk/new` (pick a template, optionally create the backing project, choose public signup or invited customers; or use `POST /rest/servicedeskapi/servicedesk`), then configure it under `/servicedesk/<id>/settings`: details, request types with a visual form builder (field types, conditional fields, validation, mapping to issue fields, internal-only fields, live preview), portal groups, customers and organizations, queues and knowledge base. Share `/portal/<slug>` with customers. Set `publicSignup` to let any signed-in user raise requests. Agents work from `/servicedesk` (queues with live SLA timers, reports) and can leave internal notes that customers never see; SLA breaches trigger an email to the assignee and a `sla.breached` webhook.

**SLAs and calendars.** Desk admins configure calendars at `/servicedesk/<id>/calendars` (time zone, several working intervals per weekday, holidays, a "test your calendar" due-time calculator; "24/7" and "Sample 9-5 Calendar" are built in) and SLA metrics at `/servicedesk/<id>/sla`: when the clock starts, pauses and stops (issue created, status entered/exited, public comment by customer or agent, resolution, assignee, priority, "Waiting for customer"), optional restart, and an ordered goal table (priority / issue type / request type / JQL, duration like `4h 30m`, calendar) ending in "All remaining issues". SLAs created before calendars existed keep working unchanged.

**Email channel.** Desk admins can enable an inbound email channel at `/servicedesk/<id>/email`. Point a mail gateway (Mailgun, SendGrid, Postmark or a forwarder script) at `POST /rest/servicedeskapi/inbound-email/<slug>` with the header `X-Veqsio-Inbound-Secret` (shown once, rotatable) and a JSON body `{ messageId, from, subject, text, headers? }`. New emails become requests via the default request type; replies with the request key in the subject (`Re: [ABC-123] ...`) from the requester or a participant become public comments. Quoted text and signatures are stripped, auto-replies and duplicate message ids are ignored, and unknown senders only get an account when public signup is on.

## Optional AI assist

Off by default, and Veqsio is fully usable without it. Under **Admin > AI assist** (`/admin/ai`) a system administrator can connect any OpenAI-compatible endpoint (OpenAI, Ollama, vLLM, LM Studio, llama.cpp, gateways) or the Anthropic API, and toggle features: summarize a thread, suggest type/priority/labels on the create page, draft release notes from a fix version, and re-rank duplicate candidates. "Similar issues" works without any model (PostgreSQL full-text). Suggestions are never applied automatically, every answer is labelled as AI-generated, and each feature only sees data the requesting user may see (internal service-desk notes only for desk staff).

For a fully self-hosted setup run a local model server, set `AI_ALLOW_PRIVATE_HOSTS=true` on the API and use a base URL such as `http://ollama:11434/v1`; otherwise base URLs must be https. The key is stored encrypted, so set `SECRETS_ENCRYPTION_KEY` in production. Optional tuning: `AI_MAX_CONCURRENT` (default 4) and `AI_BURST_PER_MINUTE` (default 20); the per-user daily limit and input cap are set on the admin page. Prompts and answers are never logged or stored. See [docs/security.md](docs/security.md#ai-assist-threat-model). Tested with a fake provider only, not yet against real models.

## Deployment

See [`docs/deployment.md`](docs/deployment.md) and `docker-compose.prod.yml`.

## License

Veqsio is developed and maintained by **[Workizon Ltd](https://workizon.ltd)**, which is the licensor and the contracting party for the CLA, the commercial licence and the trademark.

- **Community edition:** [AGPL-3.0](LICENSE). Free to use, modify and self-host, including commercially. If you modify Veqsio and offer it to others over a network, you must publish your modifications under the same licence.
- **Enterprise features and paid modules** (Timesheets, Plans, ITSM, Assets/CMDB and more) are **not part of this repository**. They are delivered separately to licence holders under the Veqsio Enterprise License and are unlocked by an offline licence key; the licence verification code in this repository is AGPL. Your data always stays readable when a licence ends.
- **Commercial licence** for organisations that cannot use the AGPL: see [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).
- The name and logo are trademarks: see [TRADEMARK.md](TRADEMARK.md). Contributors sign the [CLA](CLA.md) once.

Which features are free and which need a licence: [docs/editions-and-switches.md](docs/editions-and-switches.md).

## Contributing

**External pull requests are not accepted yet** while the Contributor License Agreement is being finalised. Questions, bug reports and support go by e-mail (see [veqsio.com/sla](https://veqsio.com/sla)), not through GitHub issues. See [`CONTRIBUTING.md`](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Security: see [`SECURITY.md`](SECURITY.md) (report vulnerabilities privately) and [`docs/security.md`](docs/security.md) for the security model.

## Enterprise SSO & provisioning

Besides Microsoft Entra ID, any OpenID Connect provider (Okta, Keycloak, Google Workspace, Auth0, Authentik) can be configured under Admin > OIDC, with PKCE, domain restrictions, optional auto-provisioning, group sync and an enforce-SSO switch. Client secrets are encrypted at rest: set `SECRETS_ENCRYPTION_KEY` (`openssl rand -base64 32`), which is mandatory in production. SCIM 2.0 (`/scim/v2`, Users and Groups, authenticated by a dedicated token from Admin > SCIM) lets your identity provider create, update and deactivate accounts; deprovisioning also revokes sessions and API tokens. Personal access tokens have scopes (`read:*`, `write:issues`, `admin`, ...) and always expire (default 90 days, max 365). Details and the threat model are in [docs/security.md](docs/security.md).

## Plugins

Veqsio is extended by out-of-process plugins: external HTTP services described by a manifest. Veqsio sends them HMAC-signed webhook events (with retries and a circuit breaker), they call the REST API with a scoped token that an administrator grants explicitly, and they can show declarative panels in sandboxed iframes on the issue page. Third-party code never runs inside the API. Install and manage plugins under Admin > Plugins; the manifest reference, signature verification snippets (JS and Python) and security model are in [docs/plugins.md](docs/plugins.md), with a ~60 line example in [`examples/hello-plugin`](examples/hello-plugin).

