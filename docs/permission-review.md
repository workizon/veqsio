# Permission review and project permissions

## Permission review (administrators)

`Administration > Security > Permission review` (`/admin/permission-review`) answers "who has access to which project, and how did they get it?" for access reviews and security audits.
It needs the system administrator permission.

- **One row per project:** permission scheme, how many people have access, how many of them administer the project, how many permissions are granted straight to people, and whether the project is open to anyone or to every signed-in user. A badge shows the most serious finding.
- **Findings** (most serious first): anyone, also without signing in, may write (high); a public project that anyone may browse; every signed-in user may write; deactivated accounts that still hold access; permissions granted directly to people instead of roles or groups; groups with permissions but no members; roles in the scheme that nobody holds in this project; many project administrators; a project without a scheme.
- **Click a project** for everyone with access: a matrix (browse, create, edit, transition, delete, admin) and the way each person got it: project role (also *through* a group), group, directly, as project lead. Expand a person for every permission and its source.
- **CSV:** "Export all projects" (summary with findings) and "Export this project" (one row per person, permission and source).

API: `GET /rest/api/2/admin/reports/permission-review` and `GET /rest/api/2/admin/reports/permission-review/{KEY}`, both with `?format=csv`.
The logic is `packages/api/src/admin/permission-review.ts` (pure, covered by tests).

## Project permissions (project settings)

`Project settings > Access > Permissions` shows the permission scheme of the project as Jira does: permissions grouped (Project, Issues, Comments, Attachments, Time tracking, Administration), each with a description and **Granted to** (roles with their member count, groups, people, project lead, every signed-in user, anyone).

System administrators can also change it here: **Grant** and remove holders per permission, **Use a different scheme**, and **Permission helper** (why can this person do this here). A shared scheme is edited as a **private copy for this project** by default, or for all projects that use it, on request.
Project administrators who are not system administrators see the screen read-only, because a scheme is shared between projects.

The other screens in the same section: **Users and roles** (roles with their users and groups, "Add users to a role", search that works with any number of people), **Issue security**, **Notifications** (the rules that apply to the project), and under General **Audit log** (changes to the project and its issues), **Re-index** (Veqsio searches the database directly, so this refreshes cached data) and **Archive and delete**.

API: `GET /rest/api/2/project/{key}/permissions`, `POST .../permissions/grant|revoke`, `GET .../audit`, `POST .../reindex`, `GET .../notifications`.
Default group names are `veqsio-administrators`, `veqsio-developers` and `veqsio-users` (migration 0043 renames the former `jira-*` groups when the new names are free).
