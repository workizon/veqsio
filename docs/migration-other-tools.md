# Importing from Linear, Asana, ClickUp and JSON

Admin page: **Administration > Import from other tools** (`/admin/migration`). It lists every source: Jira (live REST), Jira backup file, Linear, Asana, ClickUp, CSV and JSON. Everything on it is restricted to system administrators.

All four new importers share one engine and behave the same way:

1. **Connect** with a personal token (Linear, Asana, ClickUp) or choose a file (JSON). The token is sent to the provider only from the Veqsio server, is used for the running job and is **never stored, logged or returned**. Error messages are scrubbed of the token.
2. **Preview (dry run)**: reads everything from the source and reports, without writing anything, how many projects, issues, comments, links, sub-issues and sprints would be created or updated, which people match existing users, which statuses, issue types, priorities and labels are new, and which source data Veqsio cannot hold.
3. **Import everything now**: one click, everything selected by default (the Jira page works the same way). You can also pick projects and edit the project key of each.
4. **Progress, error log, cancel**: the page shows a progress bar and an error log; **Cancel** stops after the current issue. What was imported before the cancel is kept, and running the import again continues without duplicating it.
5. **Run again later**: re-running is an update, not a duplicate (see Idempotency).

Recent runs (preview or import) are listed on the hub page. Only one real import per source can run at a time.

## People

Assignees, creators and comment authors are matched to existing users by **e-mail** (case-insensitive), then by username and display name (the same rules as the Jira importer). Unmatched people:

- with **Create placeholder users** on (default): a user is created with the e-mail from the source, no password and an active account. They can sign in through SSO or a password reset. If the source exposes no e-mail (for example Asana comment authors), a stable placeholder address `<source>-<id>@migrated.invalid` is used.
- with it off: assignee stays empty, the reporter and comment author fall back to the administrator who ran the import.

The preview lists the people that would be created. The API also accepts `userMapping` (`{ "source e-mail or username": "veqsio-username" }`) for explicit mapping; there is no UI for that yet.

## Idempotency

Every imported project, issue, comment and sprint is recorded in the table `migration_external_refs` (source, entity type, external id, Veqsio id). A second run finds the rows through it and **updates** them: fields are replaced with the current source values (labels and components are rebuilt, comments are matched by their source id, links and sprint membership are not duplicated). Choose **leave untouched** for "Issues imported before" to skip them instead. Local edits to imported fields of an updated issue are overwritten, so use re-runs for catching up until the cutover. Comments and issues created only in Veqsio are never deleted.

Projects: a team/project that was imported before is reused through its reference. A new one gets the suggested key (Linear: the team key; otherwise initials of the name), made unique if taken. If you type a key of an existing project yourself, the data is **merged into that project** (a warning says so).

## Reported as not imported

Each preview and import report has a "Data that Veqsio cannot hold" list with counts (for example `custom field "Budget": 12`, `attachments: 3`, `checklists: 5`) and a standing warning listing what the source tool has that is never imported. Imported statuses use the default workflow until you assign a workflow scheme to the new projects; permission and notification schemes are not created either.

## Linear

Token: Linear > Settings > Account > Security & access > **Personal API keys** (read-only is enough). Uses `https://api.linear.app/graphql`.

| Linear | Veqsio |
| --- | --- |
| Team | Project (key = team key if free) with a board |
| Workflow state | Status (category from the state type: backlog/unstarted = to do, started = in progress, completed/canceled = done) and a board column |
| Cycle | Sprint (completed = closed, running = active, else future) on a scrum board |
| Linear project | Component |
| Issue | Issue; with a parent it becomes issue type Sub-task; label "Bug" sets issue type Bug |
| Priority | Urgent = Highest, High, Medium, Low; No priority = empty |
| Estimate | Story points |
| Completed / canceled | Resolution Done / Won't Do |
| Labels, due date, started date, assignee, creator, comments | same (labels: spaces become `-`) |
| Relations | Issue links: blocks = Blocks, duplicate = Duplicate, related and similar = Relates |

Not imported: attachments and linked URLs, reactions, subscribers, customer requests, initiatives, project milestones, SLAs, templates, documents, issue history. Archived issues are included.

## Asana

Token: Asana developer console > **Personal access tokens**. Uses `https://app.asana.com/api/1.0`.

| Asana | Veqsio |
| --- | --- |
| Project | Project (key from the initials of the name unless you set one) with a kanban board |
| Section | Status and board column ("Untitled section" = To Do) |
| Completed task | Status Done (or the section if it is already a done-like column), resolution Done |
| Task, subtask (up to 5 levels) | Issue / Sub-task; milestone tasks become issue type Milestone |
| Assignee, creator | matched by e-mail |
| Comments | Stories of type comment (system activity is skipped) |
| Tags | Labels |
| Due date / time, start date | Due date, start date |
| Estimated / actual time | Time estimate / time spent |
| Custom field "Priority" (enum) | Priority; a numeric field called Story points, Points, Estimate or Effort becomes story points |

Not imported: other custom fields, attachments, followers, dependencies, portfolios, goals, approvals, activity history. A task that is in several projects is imported once, into the first project processed. Asana allows about 150 requests per minute; comments cost one request per task, so large workspaces take a while (use the progress bar; 429 responses are retried honouring `Retry-After`).

## ClickUp

Token: ClickUp > avatar > Settings > Apps > **API Token** (`pk_...`). Uses `https://api.clickup.com/api/v2`.

| ClickUp | Veqsio |
| --- | --- |
| Space (default) or List ("One Veqsio project per") | Project |
| Folder / List (when the space is the project) | Component named `Folder / List` |
| Status (with type open / custom / done / closed) | Status and board column (closed/done = done; custom = in progress) |
| Task, subtask | Issue / Sub-task (including closed tasks) |
| First assignee, creator | matched by e-mail |
| Tags, priority (urgent..low), points | Labels, priority (Highest..Low), story points |
| Time estimate / time spent | Time estimate / time spent |
| Dependencies ("blocking") and linked tasks | Issue links Blocks and Relates |
| Comments | Comments |

Not imported: additional assignees, checklists, custom fields, attachments, Sprint folders, docs, whiteboards, time tracking entries. ClickUp allows about 100 requests per minute (`X-RateLimit-Reset` and `Retry-After` are honoured).

## JSON file

Upload a UTF-8 JSON file up to 50 MB (and 200,000 issues). Unknown properties never fail the import: they are reported as warnings. Invalid issues (no title, duplicate id) are skipped with a warning naming them.

```json
{
  "version": 1,
  "projects": [
    {
      "id": "web",
      "key": "WEB",
      "name": "Website",
      "description": "Public website",
      "lead": "lead@example.com",
      "statuses": ["Backlog", { "name": "In Progress", "category": "in_progress" }, { "name": "Shipped", "category": "done" }],
      "sprints": [
        { "id": "s1", "name": "Sprint 1", "state": "closed", "startDate": "2024-01-03", "endDate": "2024-01-14", "completeDate": "2024-01-14" }
      ],
      "issues": [
        {
          "id": "1",
          "title": "Set up hosting",
          "description": "Pick a provider",
          "type": "Task",
          "status": "Shipped",
          "priority": "High",
          "resolution": "Done",
          "assignee": "dev@example.com",
          "reporter": { "email": "lead@example.com", "name": "Lena Lead" },
          "createdAt": "2024-01-03T08:00:00Z",
          "updatedAt": "2024-01-10T08:00:00Z",
          "resolvedAt": "2024-01-10T08:00:00Z",
          "dueDate": "2024-01-12",
          "startDate": "2024-01-03",
          "labels": ["infra"],
          "components": ["Platform"],
          "parent": "0",
          "storyPoints": 3,
          "timeEstimate": "1d",
          "timeSpent": 7200,
          "sprint": "s1",
          "comments": [{ "id": "c1", "author": "lead@example.com", "body": "Use the EU region", "createdAt": "2024-01-04T08:00:00Z" }],
          "links": [{ "type": "blocks", "target": "2" }],
          "url": "https://old-tool.example/1"
        }
      ]
    }
  ]
}
```

| Field | Notes |
| --- | --- |
| `projects[].id` | Required, unique in the file. With `key` (optional, made unique unless you override it) |
| `projects[].statuses` | Optional list of names or `{ name, category: todo / in_progress / done }`. Statuses used by issues are added automatically; the category is guessed from the name (done, closed, complete, in progress, review ...) when not given. They become board columns |
| `issues[].id` | Strongly recommended and unique inside the project: it is what makes re-uploading an update. Issues without an id get a positional id and a warning |
| `title` (or `summary`) | Required |
| `type`, `priority`, `resolution`, `status` | Free text; `priority` words such as urgent, critical, normal, minor are mapped to Highest..Lowest |
| `assignee`, `reporter` (or `creator`), `lead`, comment `author` | An e-mail string, a name string or `{ id, email, name }` |
| Dates | ISO 8601 or `yyyy-mm-dd` (or `dd/Mon/yy ...`); an unparseable date is ignored with a warning; numbers are epoch seconds or milliseconds |
| `storyPoints` | Number or numeric string |
| `timeEstimate`, `timeSpent` | Seconds, or text like `2d 4h` (8-hour days) |
| `parent` | Id of another issue in the same project (may appear later in the file) |
| `sprint` | Id of an entry in `sprints` |
| `links[]` | `type`: `blocks`, `relates` (default) or `duplicates`; `target` = issue id in the same project |
| `comments[]` | `body` required; `id` optional (positional otherwise) |

The optional `namespace` option (letters, digits, `-`, `_`) is part of every identity. Use a different namespace to import a second, unrelated file whose ids overlap with the first.

## CSV

The CSV wizard (`/admin/import/csv`) already has a column mapping step: every target field has a drop-down (several columns for labels, components, versions and comments), the mapping is suggested from the header names, and a validation run reports row errors, warnings and new reference data before anything is written. Column-name suggestions now also cover exports of Asana (Name, Section/Column, Assignee Email, Notes, Tags, Parent task, Completed At), ClickUp (Task Name, Task Content, Date Created, Time Estimated) and Linear (Title, Estimate, Parent issue). The CSV importer needs an existing target project and project-admin rights; for whole workspaces use the live importers.

## API (system administrators)

| Method and path | Purpose |
| --- | --- |
| `GET /rest/api/2/migration/tools/sources` | Description of the sources, what maps and what does not |
| `POST /rest/api/2/migration/tools/:source/test` | `{ "token" }` -> `{ ok, user }` (`400` with `code: AUTH_FAILED` for a rejected token) |
| `POST /rest/api/2/migration/tools/:source/analyze` | Lists teams / projects / spaces (or the projects of a JSON file) with a proposed free key |
| `POST /rest/api/2/migration/tools/:source/run` | `{ token or json, dryRun (default true), options }` -> `202 { sessionId }`. JSON files may also be sent as `multipart/form-data` with the fields `file`, `dryRun` and `options` (JSON text) |
| `GET /rest/api/2/migration/tools/sessions[/:sessionId]` | History, progress and the final report |
| `POST /rest/api/2/migration/tools/sessions/:sessionId/cancel` | Stop a running import |

`:source` is `linear`, `asana`, `clickup` or `json`. `options`: `containerIds`, `projectKeys` (`{ containerId: "KEY" }`), `includeComments`, `onExisting` (`update` / `skip`), `createMissingUsers`, `userMapping`, `groupBy` (ClickUp: `space` / `list`), `workspaceId`, `updatedSince` (ISO time, only issues changed since), `namespace` (JSON). The request body for JSON uploads through the plain JSON API is limited by `JSON_BODY_LIMIT_BYTES` (2 MiB by default); use multipart for larger files.

## Security notes

- Provider hosts are fixed (`api.linear.app`, `app.asana.com`, `api.clickup.com`); no user supplied URL is ever fetched, and every request (including pagination links returned by a provider) is checked against that origin, so a malicious payload cannot redirect your token elsewhere. There is therefore no SSRF surface and no use for the plugin SSRF guard.
- Tokens are not persisted (consistent with the Jira REST importer); the stored session only keeps non-secret options and the final report. Re-enter the token to run again.
- Rate limits: HTTP 429 and 5xx are retried with `Retry-After` / reset-time aware back-off (Linear's `RATELIMITED` GraphQL error too); authentication failures (401/403) are not retried and are reported as such.

## Tests

`packages/api/tests/integration/migration-tools.api.ts` runs every importer against hand-written fixtures in `packages/api/tests/fixtures` (`linear.json`, `asana.json`, `clickup.json`, `generic.json`) through an injectable `fetch`; no test calls an external service. They cover pagination, 429 with `Retry-After`, auth failure, the mapping, dry run versus real run, idempotent re-run, user matching and placeholder users, cancel and access control.
