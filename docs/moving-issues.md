# Moving an issue to another project

A project can use other issue types, another workflow, other custom fields, components and versions. **Move** therefore checks the move first and applies it only when nothing blocks it.

1. Open the issue, `More > Move`, choose the target project. Nothing changes yet: the dialog shows the result of the check (`POST /rest/api/2/issue/{key}/move?preview=true`).
2. **Issue type.** If the target project's issue type scheme does not offer the current type, the dialog asks for one that it does.
3. **Workflow and status.** If the target workflow contains the current status, the issue keeps it. If not, you must choose a status of the target workflow (a status of the same category is suggested). The dialog shows the workflow before and after.
4. **Fields.** Custom field values the target project or type does not carry are appended to the description, so nothing is lost.
5. **Components and versions** are matched by name in the target project and re-linked; the others are removed. The issue leaves its sprints and milestones, and a link to an epic or parent in another project is removed.
6. **Security level.** It is kept when the target project uses the same issue security scheme, replaced by that scheme's default level when it does not, and a move is blocked when there is no default.
7. **Sub-tasks** move with their parent (their statuses are kept when their new workflow has them, otherwise they start in its initial status). A sub-task cannot be moved on its own.

The issue gets a new key, the change is written to the issue history (project, key, type, status, parent and removed fields) and to the audit log (`ISSUE_MOVED`).
Bulk move accepts the same `issueTypeId` and `statusId`. Inside one project, **Change type** does the same check for the workflow of another type (`docs/issue-history.md`).
The logic is `packages/api/src/history/move-issue.ts`.
