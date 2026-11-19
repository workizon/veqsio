# Migration playbook: from Jira (or another tool) to Veqsio

A checklist for moving a team without a hard stop. It uses only what Veqsio does today; where something is manual, it says so. Plan on days, not hours, for a few hundred users.

## 0. Before you start (discovery)

- **List what you use**, not what you own: number of projects, issues, attachments (size), users who signed in during the last 90 days, apps/plugins, automation rules, workflows, custom fields, dashboards, filters, and every integration that talks to Jira (CI, chat, monitoring, SSO).
- **Decide scope.** Archive dead projects in Jira instead of importing them. Importing fewer, cleaner projects is the cheapest simplification.
- **Check licences and hosting.** Self-hosted: size the server using [deployment.md](deployment.md). Note what only exists in paid modules ([editions-and-switches.md](editions-and-switches.md)).
- **Pick the cutover window** and a rollback rule ("if X is not working by Y, keep working in Jira").
- **Have an administrator account** on both sides, and for Jira Cloud an API token for a user who can see every project you import.

## 1. Prepare Veqsio

1. Install and sign in as administrator ([deployment.md](deployment.md)). Run the backup script once and test a restore ([backup-and-recovery.md](backup-and-recovery.md)); do this **before** the first import.
2. Configure SSO/LDAP/SCIM first so people are matched to the right accounts by e-mail.
2b. **People.** The import from Jira Cloud or Data Center creates the users, groups (with members), project role members and the administrator groups (`jira-administrators`, `system-administrators` and similar become holders of the global ADMINISTER permission here; the report names them). Accounts that already exist, for example from SSO or SCIM, are matched by e-mail; the others are created without a password. Where Jira hides e-mail addresses (Cloud privacy settings) accounts get a placeholder address ending in `@migrated.invalid` until it is corrected. Passwords are never copied.
2e. **Screens and avatars.** On Jira Cloud the screens of the workflow transitions (tabs and fields) are copied and put on the transitions that use them; Data Center has no screens API. Avatars of people and projects are copied (PNG, JPEG, GIF, WebP up to 2 MB). On Jira Cloud the global permissions of single people are read through the permission check; Data Center has none. The wizard has a preview for people and one for custom fields.
2c. **Configuration.** Custom issue types (with the sub-task flag and description), priorities in their order, statuses with their category, resolutions, link types, and the issue types each project offers (as an issue type scheme, one per distinct set) are created; entries that already exist are kept.
2d. **Custom fields.** The Jira id (`customfield_10042`) of each field is remembered, so a second import and `customfield_10042` / `cf[10042]` in JQL find the same field. A field is matched by that id first, then by name and a compatible type; a same-named field of another type is not written into (a new field with a suffix is created and the report says why). List options, cascading options (as "Parent / Child"), where each field applies (projects and issue types) and the default option are copied; Jira Cloud through the field context API, Data Center from the create metadata. Required flags and per-context defaults are not migrated. The wizard shows a preview of every field with the chance to override the choice. Required flags are read from the create metadata (Jira up to 9 and the per-type endpoints of Jira 10 and Cloud) and become a field configuration per project and issue type; the create form and the API then insist on them. Per-context default values (Jira Cloud) fill empty fields of new issues.
3. Recreate what does not migrate: issue type / priority / security schemes, screens and field configurations. The import (from Jira Cloud or Jira Data Center / Server, with an administrator's token) brings workflows, custom fields, boards and the **permission and notification schemes** of the imported projects: grants to groups, project roles, users, the project lead, any logged-in user and anyone are copied (groups and roles that do not exist here are created, users are matched by e-mail or name); grants to the reporter or assignee and notifications to single users, groups or roles have no counterpart here and are listed in the import report. Without administrator rights the import carries on and says so. Use the permission helper (Administration → Security) to check that a sample user can do what they could in Jira. Use the permission helper (Administration → Security) to check that a sample user can do what they could in Jira.
4. Rebuild integrations (Slack/Teams, Git providers, inbound webhooks) in Veqsio; they are not part of an import.

## 2. Dry run

- Administration → Import and migration. Choose the source and **Preview**: nothing is written; you get counts, warnings and the people that would be created or matched.
- Read the warnings as a to-do list: unsupported fields, unmapped statuses, users without e-mail, oversize attachments.
- Fix problems at the source or pick different projects, and preview again until the warnings are acceptable.

## 3. Pilot (parallel run)

1. Import **one or two** friendly projects for real. Imports are re-runnable and update rather than duplicate.
2. Let the pilot team **work in Veqsio for one or two weeks**, while Jira stays read-write for everyone else. Compare: issue counts per status, a handful of JQL queries on both sides, boards and sprints, attachments open, comments and history look right, permissions.
3. Keep a list of differences and decide for each: fix in config, accept, or workaround. Share it with the team.

## 4. Full import and sync

1. Import the remaining projects. For Jira the live import supports **Sync changes from Jira**: run it daily while people still use Jira, so the cutover only has a small delta.
2. Check automatically what you can: issue counts per project, the highest issue key per project, attachment count.
3. Train people: a one-page "where is X" cheat sheet (JQL works, boards, backlog, filters, notifications). Veqsio uses Jira's REST shape, so many existing scripts keep working after you change the base URL; test the important ones.

## 5. Cutover

1. Announce a freeze window. Make Jira read-only (revoke the create/edit permissions, or archive the projects).
2. Run the **final sync**. Compare counts again.
3. Switch integrations (CI, chat, monitoring) to Veqsio, update bookmarks and short links, and point the old Jira hostname at a notice page or redirect.
4. Take a **backup of Veqsio right after cutover** and keep the Jira export/backup for at least the retention period your company needs.

## 6. After cutover

- First week: a visible channel for problems; triage daily.
- Remove the placeholder users the import created for people who left (Administration → Users).
- Review the audit log and the configuration health check (Administration → Security / System).
- Decommission Jira only after a full sprint cycle without anyone going back to it.

## Jira Service Management

After the projects are imported, run **Import service desks** on the same page. It creates the desk for each imported project and brings request types with their forms, groups, queues, organizations and customers. SLA goals, automation rules and portal branding are not exposed by the Jira API: recreate them in Veqsio (Service desk → SLAs and Automation) and compare a few requests side by side during the pilot.

## Large Jira backups

Administration, Migration, Jira backup uploads the file in chunks of 32 MB and resumes after a network error, so the size of the file is limited by disk space, not by a single request: the default maximum is **8 GB** (`MIGRATION_MAX_BYTES`). This matters behind a proxy: Cloudflare accepts at most 100 MB per request on the Free and Pro plans, and a reverse proxy usually has its own limit (nginx `client_max_body_size`, Caddy `request_body max_size`). Chunks stay far below those limits. Individual attachments are a different case: an attachment is one request, so its size is bounded by the same proxy limit (100 MB by default, `STORAGE_MAX_FILE_SIZE`). In Veqsio Cloud the data volume grows automatically while a big import runs.

## What is not migrated

Permission and notification schemes when the import runs from a backup file or without an administrator token (from Jira Cloud or Data Center with an administrator's token they are copied; people are matched by account id or login, project roles by name), automation rules, dashboards and gadgets, apps/plugins and their data, SSO configuration, and anything the preview lists as unsupported. Attachments larger than the configured limit are reported. Record these in your discovery list and rebuild them by hand.

## Rollback

Until the Jira freeze is lifted, rollback is simply "unfreeze Jira". After new work happened in Veqsio, there is no automatic export back to Jira; export the delta (CSV) and re-enter it. This is why the pilot and the sync period exist.

See also: [migration-other-tools.md](migration-other-tools.md) for Linear, Asana, ClickUp and JSON files.
