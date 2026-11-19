# Veqsio vs Jira: parity matrix and where we go further

Legend: ✅ done · 🟡 partial · ⬜ planned. Status reflects the code on the main development branch.

## 1. Parity with Jira Software / Jira Service Management

| Area | Jira capability | Veqsio |
| --- | --- | --- |
| Issues | Types, statuses, priorities, resolutions, labels, components, versions, links, sub-tasks, watchers, votes, attachments, history | ✅ |
| Custom fields | Text, number, date, user, select, multi-select, checkbox, URL; contexts | 🟡 (types ✅, per-context screens/options partly) |
| Workflows | Transitions, conditions, validators, post-functions, schemes | ✅ (workflow editor UI 🟡) |
| Schemes | Permission, notification, issue type, screen, field configuration, workflow | ✅ |
| Search | JQL parser, saved filters, favourites, CSV export | ✅ (JQL autocomplete, filter sharing and email subscriptions included) |
| Boards | Kanban/Scrum, swimlanes, quick filters, WIP limits, drag and drop | ✅ |
| Sprints | Backlog, sprint planning, start/complete, parallel sprints | ✅ (parallel sprints 🟡) |
| Reports | Burndown, velocity, sprint report, cumulative flow, control chart, epic report | ✅ (incl. story points) |
| Dashboards | Gadgets, sharing | ✅ (more gadgets ⬜) |
| Time tracking | Worklogs, estimates, reports | ✅ (permissions ⬜) |
| Automation | Rules with triggers, conditions, actions | ✅ |
| Notifications | Email, webhooks, notification schemes | ✅ |
| Roadmaps | Timeline / roadmap view | ✅ (`/roadmap`: epics, releases, dependencies, drag to reschedule) |
| Service Management | Portal, request types, queues, SLAs, KB, CSAT, customer organizations | ✅ (approvals ⬜, assets ⬜) |
| Service email channel | Inbound email to requests | 🟡 in progress |
| Admin | Users, groups, roles, audit log, system settings, mail server | ✅ |
| SSO | SAML / OIDC / SCIM | 🟡 (Microsoft Entra ID ✅; generic OIDC ✅; SCIM 2.0 ✅; SAML ⬜) |
| REST API | Jira REST v2 compatible endpoints, PATs | ✅ |
| Migration | From Jira (XML backup, REST, CSV); also from Linear, Asana, ClickUp and JSON | ✅ (workflows in progress) |
| Rich text | Wiki markup / ADF editor | 🟡 Markdown editor with live preview, Jira wiki markup rendered safely, table/image paste (no ADF) |
| Apps / extensions | Marketplace apps (Connect/Forge) | 🟡 Out-of-process plugins: manifest, signed webhooks, scoped API token, sandboxed iframe panels (`docs/plugins.md`); no marketplace catalog |
| Mobile | PWA / responsive | 🟡 |
| AI assist (Atlassian Intelligence) | Summaries, similar issues, triage, release notes | 🟡 optional, bring-your-own or self-hosted model; fake-provider tested only |

## 2. Where Veqsio is meant to be better

These are the product bets that justify switching rather than staying on Jira. Each is scoped so it can ship incrementally.

1. **Migration you can trust.** One-click live import with continuous re-sync until cutover, dry-run validation, per-project reports, idempotent re-runs. Jira's own importers are the weakest part of its ecosystem.
2. **One product for engineering and service teams.** Service desk, portal, SLAs and knowledge base are built in, not a separately licensed product.
3. **Self-hosted, no per-seat pricing.** Open source; one Docker Compose stack; predictable cost at any size.
4. **Honest performance.** Redis caching, PostgreSQL full-text search, keyset pagination for large lists; target 1M+ issues per instance.
5. **Security by default.** Strict input validation, deny-by-default authorization, 404 over 403 for hidden data, escaped notifications, rate limits, upload sniffing. Published threat model in `docs/security.md`.
6. **Real-time collaboration** (planned): live boards, presence, typing indicators.
7. **Built-in AI assist** (optional, off by default, self-hostable models; see `/admin/ai`): duplicate detection (works without any model), triage suggestions, thread summaries, release-note drafts. Never applies changes by itself; not yet verified against a real model.
8. **Developer-friendly extensibility**: a plugin manifest (✅ out-of-process plugins with signed webhooks and scoped tokens), typed webhooks, an OpenAPI spec and an event stream, instead of a closed marketplace.
9. **Simple administration**: fewer scheme layers, with sensible templates (software, IT support, HR, business) and an admin "health check" (✅ `/admin/health`) that finds misconfiguration (stuck statuses, unused fields, missing permissions, failing mail).

## 3. Order of work

1. Finish in-flight work (service desk templates, canned responses, email channel, workflow migration, portal hardening).
2. Close the highest-impact parity gaps: rich-text editor and issue detail polish, JQL autocomplete and filter sharing/subscriptions, story points, roadmap/timeline.
3. Enterprise readiness: generic OIDC + SAML, SCIM, audit log coverage, OpenAPI docs, granular token scopes, issue security levels.
4. Differentiators: real-time collaboration, AI assist, plugin system, admin health check, PWA.
5. Release hygiene: license, docs site, upgrade guide, load and security test suites.
