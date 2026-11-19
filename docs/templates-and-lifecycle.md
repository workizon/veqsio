# Templates, recurring issues, project lifecycle and terminology

Migration `0021_templates_recurring_archive` adds the tables `issue_templates`, `recurring_issues`, `recurring_issue_runs` and the columns `projects.archived_at` / `projects.archived_by`. Everything is additive.

## Issue templates

A template stores the starting point for an issue: name, description, issue type, **summary pattern**, description body (Markdown), default priority, labels, components (by name), assignee and custom field defaults. A template belongs to one project, or is **global** (no project) and is offered everywhere.

Use it in the create dialog (header "Create" button) and on `/issues/create`: a **Create from template** select appears when the chosen project has templates. Choosing one fills the form (every value stays editable). Components are matched by name in the target project; names that do not exist there are skipped, and an inactive default assignee is dropped.

Manage project templates in *Project settings > Templates* and global ones under *Administration > Global issue templates*.

Summary placeholders (unknown ones stay as typed): `{date}` `{year}` `{month}` `{monthName}` `{day}` `{week}` (ISO week) `{weekday}` `{project}`. For a manual use they refer to today in your time zone; for recurring issues to the scheduled day in the rule's time zone.

Custom field defaults are supported by the API (`customFields: [{ fieldId, value }]`) but the template editor has no UI for them yet.

### API

| Method and path | Permission |
|---|---|
| `GET /rest/api/2/issue-template?projectKey=KEY` project templates plus global ones; without `projectKey` only the global ones | `CREATE_ISSUES` in the project (anywhere for global) |
| `GET /rest/api/2/issue-template/{id}` | same |
| `GET /rest/api/2/issue-template/{id}/prefill?projectKey=KEY` the create request the template stands for | same |
| `POST /rest/api/2/issue-template/{id}/issue` body `{ projectKey, summary?, description? }` creates an issue | `CREATE_ISSUES` |
| `POST /rest/api/2/issue-template` body with optional `projectKey` (absent = global) | `PROJECT_ADMIN` of the project, `ADMINISTER` for global |
| `PUT` / `DELETE /rest/api/2/issue-template/{id}` | same |

Bodies are validated with strict schemas (unknown fields are a 400). Names are unique per scope (409). A template used by a recurring issue cannot be deleted (409). Users who may not use a template get 404.

## Recurring issues

*Project settings > Recurring issues* (permission `PROJECT_ADMIN`). A rule creates an issue from a template on a schedule:

- **daily**, **weekly** on selected ISO weekdays (none selected = Monday to Friday), or **monthly** on day N (1-31; shorter months use their last day),
- at `HH:MM` in an IANA **time zone** (09:00 stays 09:00 across daylight saving changes),
- an **owner** (the reporter of the created issues; must be an active user who may create issues in the project), an **active** flag, last and next run and a **run log**.

API: `GET|POST /rest/api/2/project/{key}/recurring-issue`, `PUT|DELETE .../recurring-issue/{id}`, `GET .../recurring-issue/{id}/runs`.

How the scheduler behaves (`packages/api/src/recurring`, started from `index.ts` every minute):

- **Idempotent per slot.** Every scheduled slot gets one row in `recurring_issue_runs`, unique on (rule, slot), inserted *before* the issue is created. Restarts, overlapping ticks and several API instances cannot create a duplicate. The price is at-most-once: if the process dies between inserting the row and creating the issue, that slot stays `pending` and is not retried (a duplicate is judged worse than a missed slot, and the log shows it).
- **Catch-up.** After downtime only the latest missed slot creates an issue; earlier ones are logged as `skipped`. Pausing and resuming a rule does not make up the paused period.
- **Archived projects never run.** Due slots of an archived project are logged as `skipped` and the rule moves on, so restoring does not trigger a burst.
- **Failures** (inactive owner, owner lost the create permission, template gone) are logged as `failed` with the reason and are not retried.

## Project templates and copying settings

When creating a project (*Projects > Create project*, or `POST /rest/api/2/project`) choose **Start from**:

| Template (`template`) | Board | Extras |
|---|---|---|
| `software` Software (Scrum) | Scrum board | version 1.0; templates Bug report, User story, Technical task |
| `kanban` Kanban | Kanban board | templates Task, Bug report |
| `business` Business / task tracking | Kanban "Task board" | templates Task, Request |
| `bug` Bug tracking | Kanban "Bug triage" | components Frontend, Backend, Infrastructure; templates Bug report, Regression |

The board gets one column per existing status (To Do, In Progress, Done order). Statuses, workflows and permission schemes are not changed: the usual instance defaults apply. A template's issue template uses the issue type of the same name, or the first non-sub-task type when the instance has none by that name. `GET /rest/api/2/project-template` lists the catalogue; the response of project creation contains `applied` with what was created.

**Copy of a project** (`copyFrom: { projectKey, components?, versions?, issueTemplates?, roleActors? }`, the first three default to true, `roleActors` to false): components (with leads), version names and descriptions (released and archived versions are not copied, no dates), the project's issue templates and, on request, the people in project roles. The dialog shows a **preview** (`GET /rest/api/2/project/{key}/copy-preview`) of what exists in the source. Copying needs `PROJECT_ADMIN` on the source project (the preview includes role actors). Names that already exist in the new project are not duplicated, so a template and a copy can be combined.

## Archive, restore, delete

- **Archive** (`POST /rest/api/2/project/{key}/archive`) and **restore** (`.../restore`), `PROJECT_ADMIN`; *Project settings > Archive and delete*. Both are recorded in the audit log (`PROJECT_ARCHIVED`, `PROJECT_RESTORED`).
- **Read-only.** A small global guard (`projects/archive-guard.ts`) answers writes (POST/PUT/PATCH/DELETE) that target an archived project with **409** and "This project is archived and read-only. A project administrator can restore it first." It finds the project from the URL (issue, comments, attachments, worklogs, boards, sprints, templates, project sub-resources) and, for creating things, from the body (issue create/bulk/import with project id or key, board create, issue links, template creation). Restore and delete are the only writes let through. Anonymous requests still get 401.
- **Hidden, not gone.** `GET /rest/api/2/project` leaves archived projects out; `?archived=only` returns just them, `?archived=include` both. The board list, default searches and the project pickers skip them too. A search still finds an archived project's issues when the JQL names the project key (`project = OLD`) or `includeArchived=true` is passed; issues, boards and project pages stay reachable by direct link.
- **Delete** (`DELETE /rest/api/2/project/{key}`, global `ADMINISTER`) removes the project with its issues, comments, boards and settings. It needs **two things**: the project must already be archived, and the body must contain `{ "confirmKey": "<KEY>", "confirmPhrase": "delete this project" }` exactly. The UI makes the person type both. Why archived first: deleting is irreversible, so the reversible step comes first, an archived project cannot change (and recurring jobs have stopped) while it is being deleted, and the archive is the window in which a mistake can still be undone. Attachment files in object storage are not removed by this call.
- Project keys stay unique across archived projects (the key column is unique), so an archived key cannot be reused.

## Terminology option

Instance setting `issueTerm` (*Administration > Instance settings > Terminology*): `issue` (default), `work item`, `ticket` or `task`. It is exposed by `GET /rest/api/2/settings/public` (`issueTerm`). In the web app `useTerm()` (`hooks/use-term.ts`, pure helpers in `lib/term.ts`) returns `issue`, `issues`, `Issue`, `Issues` and `t(text)`, which rewrites the word *issue/issues* in an English string keeping capitalisation and fixing the article ("an issue" becomes "a task"); `{issue}`-style tokens also work. Applied to the top and mobile navigation, the Create button and dialog, the create page, the issue list (title, search, empty states), board and backlog empty states, the project list and the recurring/template/lifecycle screens.

Only visible labels change. API field names, JQL, URLs, issue keys, e-mails and the issue type named "Issue"/"Task" are untouched. Not translated yet: the command palette entries, reports, dashboards, service desk, notification texts and the many smaller strings in other pages; they keep saying "issue".

The command palette (group labels, search hint) and the reports unit option also follow the term now. Still saying "issue": most dashboard gadgets, service desk screens, e-mails, many smaller strings.
