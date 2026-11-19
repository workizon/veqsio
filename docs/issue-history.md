# Issue history depth, type switching and workflow governance

Migration `0024_history_governance` (additive): `statuses.allow_new_issues` and the `workflow_change_log` table. Time in status and description versions need no new storage; they are derived from `issue_history`.

## Time in status

Every stay of an issue in a status is computed from the `status` rows of its history (status names, old and new). The initial status runs from the creation of the issue; the current status runs until now. Per issue you get the list of stays (status, entered, left, duration, who moved it) and totals per status and per status category.

- Issue view: the **Transitions** tab in the activity section shows a bar and a table. API: `GET /rest/api/2/issue/:key/time-in-status` (BROWSE_PROJECTS; hidden issues answer 404).
- **Average time in status** report: `GET /rest/api/2/reports/time-in-status?project=KEY` or `?boardId=N` or `?sprintId=N` (exactly one). Average length of one stay per status over the issues of the project, the board's project or the sprint, plus averages per category. The caller needs BROWSE_PROJECTS on the project, otherwise 404. At most the newest 5000 issues are used (`truncated: true` when capped). In the web app: Reports, "Average time in status".
- Limits: a status that was renamed keeps its old name in older rows, so renamed statuses show as two entries; moving an issue to another project resets its status without a status row; the board report uses the whole project of the board (the board filter is not applied). There is no JQL field for time in status.

## Description history

Every description change already stores old and new text in the history, so a version is one such row. Version 1 is the text the issue was created with (shown once the description was changed at least once).

- `GET /rest/api/2/issue/:key/description-history` lists versions (newest first, with author, time and added/removed lines).
- `GET /rest/api/2/issue/:key/description-history/:version` returns the text and two line diffs (changes in that version, and what restoring would change); the diff comes from the same helper as page versions.
- `POST /rest/api/2/issue/:key/description-history/:version/restore` needs EDIT_ISSUES. The old text is saved as a new version and a new history entry; nothing is deleted. Restoring the current version is a 409.
- Viewers with BROWSE_PROJECTS can read versions. UI: the history button next to the description opens a drawer with the list, the diff and "Restore this version". Issue security levels are not considered (only the normal browse check).
- Descriptions changed by paths that do not write history rows (for example a bulk import) have no version for that change.

## Work item type switch

`POST /rest/api/2/issue/:key/change-type` with `{ issueTypeId, statusId?, parentKey? }`; add `?preview=true` for a dry run that changes nothing. Needs EDIT_ISSUES. The dialog is "Change type" in the issue menu and previews on every change.

- **Custom fields**: values of fields the new type does not carry (a field context that excludes the type, or a field configuration that hides it) are removed from the issue and appended to the description as a block `Warning: fields removed by the type change A -> B (date)` with one line per field. History gets one entry per field and one for the description.
- **Workflow**: the new type may use another workflow. If the current status is not part of it, a status of the new workflow must be chosen (`statusId`; the preview suggests one of the same category). Applying without it is a 409. The new type must be in the project's issue type scheme.
- **Sub-tasks**: a standard issue becoming a sub-task needs a parent (`parentKey`, same project, not a sub-task, or its existing parent); an issue that has sub-tasks cannot become one; a sub-task becoming standard leaves its parent.
- History entries for `issuetype`, `status`, `parent` and the fields; audit action `ISSUE_TYPE_CHANGED` (names of dropped fields only, not values).
- Not done: the issue key stays the same (type switches inside a project only), no bulk type change, resolution is not touched.

## Workflow governance

- **Allow new issues** per status: Administration, Workflows, select a status, "Allow new issues in this status" (or `PUT /rest/api/2/admin/status/:id {allowNewIssues:false}`). Creating an issue whose initial status is closed is refused with a clear message. Moving issues into the status is not affected.
- **Who may move**: transitions are restricted by conditions (project role, group, permission, assignee check); the engine already enforced them. The transition panel now says in words who may move issues through it, and the workflow detail API returns `whoMayMove` per transition.
- **Change history**: `GET /rest/api/2/admin/workflow/:id/history` and the "Change history" list in the designer show who created, renamed, retargeted or deleted transitions, added or removed conditions, validators and post-functions, changed statuses (name, category, allow new issues), made a workflow the default and assigned a workflow scheme. Entries are written from the moment this version is installed; the layout (positions) is not logged.
- **Workspace governance setting** `workflowGovernance` (Administration, Settings, "Workflow"): `any` (default) or `constrained`. `GET|PUT /rest/api/2/project/:key/workflow-scheme` lets a project administrator assign a workflow scheme to their project while the mode is `any`; with `constrained` that call is a 403 and only system administrators can assign schemes (`POST /rest/api/2/admin/workflowscheme/:id/assign`, always system admin only).
- Not done: a `required` mode, per-project pins, approvals as part of the governance mode, restoring an earlier workflow version from the history, project-settings UI for the scheme assignment (API only).

## JQL extras

See [jql.md](jql.md): `LIMIT n` and the relation functions `linkedIssues`, `blockedBy`, `blocking`, `subtasksOf`, `issuesWithoutParent`.
