# Editions and switches

Which parts of Veqsio are free, which need a licence, and which can be switched off. (Plane gates much of its product behind paid plans; Veqsio keeps the core product in the AGPL community edition.)

## Community edition (AGPL-3.0, always available)
Projects, issues, workflows, boards and backlog, sprints and reports, JQL and filters, dashboards, roadmap, calendar, automation, approvals, time tracking (worklogs), Service Desk, Wiki / Pages, Intake / triage, Git integrations, public projects and SEO pages, importers (Jira live/XML/CSV, Linear, Asana, ClickUp, JSON), plugins, MCP server and REST API, notifications and webhooks, OIDC single sign-on (a single provider), password policy, audit log, feature and module switches, instance settings.

## Needs a licence key (paid modules and enterprise features)
| Licence feature | What it unlocks |
| --- | --- |
| `module_timesheets` | Timesheets module (weekly timesheets, approval, locking) — also in the Team plan |
| `module_plans` | Plans (advanced roadmaps) |
| `itsm`, `sla_automation` | ITSM module: incident, problem, change management |
| `assets_cmdb` | Assets and CMDB module: schemas, objects, dependency graph, import, query |
| `sso_saml`, `sso_oidc_generic`, `scim`, `ldap` | Enterprise identity |
| `issue_security`, `advanced_permissions` | Issue security levels, advanced permission rules (issue security also in Team) |
| `audit_export`, `audit_retention` | Audit export and retention (export also in Team) |
| `ha_cluster`, `priority_support` | High availability, support |

Plans: **community** (no key), **team** (`audit_export`, `issue_security`, `module_timesheets`), **enterprise** (everything). The list is `packages/api/src/license/features.ts`; data stays readable when a licence ends.

## Switches an administrator controls
Administration → **Features and modules** turns these on or off for the whole instance (menus hide, the API answers 404, data is kept): Service Desk, Dashboards, Automation, Approvals, Roadmap, Time tracking, Git integrations, Integrations (inbound webhooks, Slack / Teams), Intake, Wiki / Pages, Comment reactions, and every installed module. Projects can switch Approvals, Roadmap, Git integrations, Integrations, Intake and Comment reactions off for themselves (Project settings → Features).

Administration → **Instance settings** holds the password policy, attachment limits, public access (allow public projects, search-engine and AI-crawler policy) and the announcement banner.
