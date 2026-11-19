# Relations, status groups and project status updates

All changes are in migration `0017_relations_status_updates` and are additive.

## Issue relations and dependencies

Built-in link types (inserted by the migration if missing, matched by name, so existing data and renamed
installs are untouched; `seed.ts` adds the same ones on a fresh install):

| Type | Outward sentence | Inward sentence |
| --- | --- | --- |
| Relates | relates to | relates to |
| Blocks | blocks | is blocked by |
| Duplicate | duplicates | is duplicated by |
| Implements | implements | is implemented by |
| Cloners | clones | is cloned by |
| Starts before | starts before | starts after |
| Finishes before | finishes before | finishes after |

A link is stored once (`issue_links`) and shown on both issues with the matching sentence, grouped by sentence in
the issue view ("Linked issues"). In `POST /rest/api/2/issueLink` the `inwardIssue` shows the inward sentence and
the `outwardIssue` the outward one ("outward blocks inward").

Rules: no self links, no duplicate of the same type (for symmetric types like "relates to" also not reversed),
creating or removing a link needs `LINK_ISSUES` in the project of both issues (404 if the caller cannot browse an
issue). Errors: 400 invalid, 404 unknown type or issue, 409 already exists.

### Dependencies (scheduling)

`Starts before` and `Finishes before` are dependency types. The issue on the outward side is the predecessor.

- Only one dependency per pair of issues, in either direction and across both types (409).
- Cycles are rejected, also indirect ones (400, "would create a cycle").
- Date check, shown as a "Dates conflict" badge on the link and in the roadmap:
  - Finishes before: conflict when the predecessor's due date is after the day the successor starts.
  - Starts before: conflict when the predecessor starts after the successor starts.
  - Issues without the needed dates never conflict. Dependencies are not enforced when dates change, only flagged.
- The roadmap (`GET /rest/agile/1.0/project/KEY/roadmap`) returns `dependencies: [{from, to, kind, conflict, message}]`
  (`kind` is `blocks`, `starts_before` or `finishes_before`; links between child issues are lifted to their epics).
  The timeline draws an arrow from predecessor to successor (dashed for starts-before, red for a conflict) and lists
  conflicts above the chart.

### Custom link types

Administration → Issue link types (`/admin/link-types`), API `GET/POST /rest/api/2/admin/linktype`,
`PUT/DELETE /rest/api/2/admin/linktype/:typeId` (SYSTEM_ADMIN). Name, inward and outward sentence. Built-in types
cannot be changed or deleted (409); a type that is in use cannot be deleted (409 with `linkCount`).
Custom types are plain relations; only the two built-in types schedule.

## Status groups

A status category is one of five groups: `backlog` (Backlog), `to_do` (To do / Unstarted), `in_progress`
(In progress / Started), `done` (Done / Completed), `cancelled` (Cancelled). Old spellings (`todo`, `new`) keep
working.

- Where only three buckets exist (Jira-style `statusCategory`, board columns, "is resolved", resolution required
  on the transition) Backlog is to do and Cancelled is done. A cancelled status therefore closes the issue and
  asks for a resolution.
- Cancelled work is neither completed nor outstanding: it is left out of the total and the percentage of roadmap
  items, epic progress, sub-task progress, dashboard progress, the epic report, burndown, velocity, cumulative flow
  and control chart, and out of "completed points" when a sprint is completed (it stays in the closed sprint, the
  summary reports `cancelled`). The sprint backlog hides cancelled issues together with done ones.
- A status that is used by issues cannot be deleted: `DELETE /rest/api/2/admin/status/:id` answers 409 with
  `issueCount` (also listed per status in `GET /admin/status`).
- Exactly one workflow is the default (workflows without a scheme use it). `PUT /admin/workflow/:id {isDefault:true}`
  moves the default in one transaction; unsetting or deleting the default is refused (409); a partial unique index
  guards it in the database. The migration keeps the lowest id if an old database had several.
- The workflow designer offers all five groups with a hint for each.

## Project status updates

Feature switch `updates` (instance-wide under Administration → Features, and per project in the project's feature
switches). When off, the API answers 404, the badge and the panel disappear, data is kept.

- `GET /rest/api/2/project/KEY/status-updates` history (newest 100) and `latest`; needs `BROWSE_PROJECTS` (404 otherwise).
- `POST` the same path `{state: on_track | at_risk | off_track, body?}` (max 10,000 characters); needs `EDIT_ISSUES` (403 for browse-only users).
- The same two routes exist for an epic: `/rest/api/2/issue/KEY-1/status-updates` (other issue types: 400).
- `GET /rest/api/2/status-updates/latest` the current state of every browsable project, used for the badge on the projects list.
- The project page `/projects/KEY` shows the current state as a coloured badge (the label is always printed) and the
  history with a form to post.
- A posted update queues an e-mail ("module notice", text escaped) to the project lead; for epics also to the assignee
  and watchers. Only people who can browse the project receive it, never the author.

Initiatives reuse this table, see [initiatives-and-milestones.md](initiatives-and-milestones.md). Not built: editing or deleting updates, in-app notifications, a per-project watcher list.

## Sprint automation
Backlog → **Automation** (needs Manage Sprints). When enabled, completing a sprint creates the next one (name counts up, starts on the completion day, default 14 days; an existing future sprint is reused) and, if chosen, carries unfinished issues into it. A target picked in the Complete dialog always wins. API: `PUT /rest/agile/1.0/board/:id/sprint-automation`; the setting is returned in the planning payload (`board.sprintAutomation`). Not built: starting the next sprint automatically, scheduled start/stop, capacity-based filling.
