# Initiatives, milestones and releases

All changes are in migration `0021_initiatives_milestones` and are additive. Initiatives and milestones each have a
feature switch (Administration -> Features): `initiatives` for the whole instance, `milestones` for the instance and
per project. When a switch is off the API answers 404 and the menu entries disappear; data is kept.

## Initiatives (`/initiatives`)

A workspace-level grouping above epics and projects.

- Fields: name, description, owner, status (`planned`, `active`, `completed`, `cancelled`), start and target date
  (the target must not be before the start).
- Linked items: any number of **epics** and **projects** (many-to-many; an epic or project can be in several
  initiatives). Linking a project includes all of its issues except epics; linking an epic includes its child issues.
- **Progress** is rolled up over the child issues of the linked epics plus the issues of the linked projects. An issue
  reached twice counts once. Status groups are the ones in [relations-and-status-updates.md](relations-and-status-updates.md):
  done is completed, **cancelled issues are left out of total and percentage** (they are reported as `cancelled`).
  The detail page also shows progress per epic and per project.
- **Health** reuses the project status-update model: `project_status_updates` has a nullable `initiative_id`
  (and `project_id` is nullable now), so the history, the On track / At risk / Off track badge and the 10,000 character
  limit work exactly as for projects. Initiative updates never show up in a project's history or on the projects
  list. They follow the `updates` switch too.
- **Timeline strip** on the detail page: where today lies between start and target ("15 days left", "Starts in 16 days",
  "5 days past the target"); a completed or cancelled initiative is shown as finished.

### Who can do what

This is a global-style rule, not tied to a project permission scheme:

| Action | Allowed for |
| --- | --- |
| Create | everybody signed in; the creator becomes the owner. Only administrators may name another owner (403 otherwise) |
| Edit, delete, change owner, link, unlink, post a health update | the initiative owner and administrators |
| Read | administrators, the owner, and everybody who can browse **at least one** linked epic or project |

Permission trimming: a viewer only sees, and is only counted against, the linked epics and projects they can browse
(BROWSE_PROJECTS). Counts (`epicCount`, `projectCount`) and the progress rollup are computed over the visible items
only, and nothing in the response reveals how many items were hidden. An initiative the caller may not read is answered
with **404**, never 403; a reader who may not manage it gets 403 on write. Linking needs browse access to the epic or
project (404 otherwise), only epics can be linked by issue key (400), a duplicate link is 409.

### API

| Method and path | |
| --- | --- |
| `GET /rest/api/2/initiatives` | readable initiatives with trimmed counts, progress and latest health |
| `POST /rest/api/2/initiatives` | `{name, description?, ownerId?, status?, startDate?, targetDate?}` |
| `GET / PUT / DELETE /rest/api/2/initiatives/:id` | detail (linked `epics` and `projects` with progress), update, delete |
| `POST /rest/api/2/initiatives/:id/links` | `{projectKey}` or `{issueKey}` (an epic) |
| `DELETE /rest/api/2/initiatives/:id/projects/:projectKey` and `.../epics/:issueKey` | unlink |
| `GET / POST /rest/api/2/initiatives/:id/status-updates` | health history; `{state, body?}` |

## Milestones (per project)

A named target date inside a project that issues are linked to (an issue can be in several milestones).

- Fields: name (unique per project), description, target date, state `open` or `reached` (with a `reachedAt` time;
  reopening clears it). An open milestone with a past target date is flagged **overdue**.
- **Rule:** only issues of the milestone's own project can be linked (400 otherwise, also through the issue endpoint).
  Moving an issue to another project removes its milestone links.
- Progress counts the linked issues by status group, cancelled excluded.
- Permissions: read needs BROWSE_PROJECTS (404 otherwise); create, edit, mark reached and delete need PROJECT_ADMIN
  (403); linking and unlinking issues needs EDIT_ISSUES (403).
- Where it shows: the **project page** (`/projects/KEY`, milestones section with progress, issue list, mark reached),
  the **issue sidebar** (a "Milestones" field with add and remove; hidden when the project has none), the
  **roadmap** (`/roadmap`: a flag marker per dated milestone on its own "Milestones" row, colour and accessible text
  for open / overdue / reached) and **JQL**.
- **JQL:** `milestone = "Beta"`, `milestone in ("Beta", "GA")`, `milestone != "Beta"`, `milestone is EMPTY`,
  `milestone ~ "bet"` (names are matched case-insensitively; ordering by milestone is not supported).

### API

| Method and path | |
| --- | --- |
| `GET / POST /rest/api/2/project/:key/milestones` | list (with `canManage`) / create `{name, description?, targetDate?}` |
| `GET / PUT / DELETE /rest/api/2/project/:key/milestones/:id` | detail with issues / `{name?, description?, targetDate?, state?}` / delete |
| `POST /rest/api/2/project/:key/milestones/:id/issues` | `{issueKey}` |
| `DELETE /rest/api/2/project/:key/milestones/:id/issues/:issueKey` | unlink |
| `GET / PUT /rest/api/2/issue/:idOrKey/milestones` | milestones of an issue / `{milestoneIds}` replaces the set |
| `GET /rest/agile/1.0/project/:key/roadmap` | now also returns `milestones` (dated ones, with percent) |

## Releases (`/projects/KEY/releases`)

Per project, the versions (newest first, archived ones on request) with their fix-version issues, progress (cancelled
excluded), the number of issues still open, an overdue flag, and the release notes (the existing
`GET /rest/api/2/project/:key/versions/:id/release-notes`, shown grouped by issue type and as Markdown).

- `GET /rest/api/2/project/:key/releases[?archived=true]` needs BROWSE_PROJECTS (404 otherwise) and returns
  `canRelease` (PROJECT_ADMIN).
- **Mark released** uses the existing version rules, i.e. `PUT /rest/api/2/project/:key/versions/:id {released: true}`
  which needs PROJECT_ADMIN (403 otherwise). The page asks for confirmation and warns when issues are not done; the
  release date defaults to today when the version has none.

## Not built

Milestone and initiative notifications, initiative-level permissions beyond owner/admin, milestone dependencies, an
initiative roadmap row, linking issues of other projects to a milestone, bulk-assigning milestones, a UI for the
version fix-version field on the releases page, browser verification (the pages compile and are type-checked; the
logic is covered by unit and API tests).
