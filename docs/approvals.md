# Approvals

Multi-approver decisions on issues and service requests, modelled on Jira Service Management.

## Concepts

- **Template** (`approval_templates`, per project): name, approver users and groups, decision rule, optional automatic
  rules, reminder interval, expiry and optional follow-up transitions. Managed by project administrators under
  `/projects/<KEY>/settings/approvals` or, for service desks, Project settings > Approvals.
- **Approval** (`approvals`): one round on one issue. Status: `pending`, `approved`, `declined`, `cancelled`, `expired`.
  The approver set is **snapshotted** into `approval_approvers` when the approval is created (groups are expanded then;
  later group changes do not affect running approvals). The requester is always removed from the approvers
  (separation of duties); if nobody is left the request is refused with 400.
- **Decision** (`approval_decisions`): append-only, unique per (approval, approver). A decision can not be changed.

## Decision rules

| rule | approved when | declined when |
| --- | --- | --- |
| `all` | every approver approved | any approver declined |
| `any` | one approver approved | every approver declined |
| `n_of_m` (+ threshold n) | n approved | fewer than n approvals are still reachable |
| `percentage` (+ threshold p) | ceil(m*p/100) approved | that number is no longer reachable |

"Early decline" means the approval completes as soon as the approved outcome is mathematically impossible. The pure
logic lives in `packages/api/src/approvals/engine.ts` (unit tested).

## Concurrency and idempotency

Every state change runs in a transaction that locks the approval row (`SELECT ... FOR UPDATE`). Two simultaneous
last decisions are serialised: the first completes the approval, the second either completes nothing (rule `all`
with more approvers pending evaluates again) or is refused with 409. Completion happens exactly once, therefore the
follow-up actions (requester email, `approval.decided` webhook, automatic transition) happen exactly once.
Those actions run after the transaction committed; if the process dies in between they are lost (the approval stays
completed, the transition has to be done by hand). Reminders are claimed with a conditional UPDATE, so several API
instances do not send duplicates.

## Automatic rules

`autoApproveWhen` / `autoDeclineWhen` are `{ field: 'priority' | 'issuetype', op: 'eq' | 'neq' | 'in', value }`,
compared case-insensitively by name when the approval is created. A matching rule completes the approval immediately
(`completedBy = auto_rule`). If both match, decline wins. A missing field never matches.

## Workflow integration

- **Validator `approval_required`** (optional `template` name): blocks the transition unless the LATEST non-cancelled
  approval on the issue (of that template, if given) is approved. It also blocks when none was requested, or it is
  pending, declined or expired. It is a validator, not a condition: the transition stays visible and explains why it fails.
- **Post-function `request_approval`** (`template` name, resolved in the issue's project): creates an approval from the
  template when the transition runs, in the same transaction. A second pending approval of the same template is not
  created. Emails and webhooks go out after the transition committed. The user running the transition cannot be an approver.
- **Automatic transition on completion**: a template can name `onApprovedTransitionId` / `onDeclinedTransitionId`.
  The transition runs through `doTransition` as a **system actor**: user conditions are not evaluated (there is no
  user) and history entries have no author, but **all validators still run, except the `approval_required` validator
  itself**. If the transition fails (wrong source status, another validator) it is logged and the issue stays; the
  approval remains completed. Only the creator-facing template editor can set these ids, and they must exist.

## API

| | |
| --- | --- |
| `POST /rest/api/2/issue/:key/approval` | request (needs TRANSITION_ISSUES): `{templateId}` or ad hoc `{name?, approverUserIds, approverGroupIds, rule, ruleThreshold?, reminderIntervalHours?, expiryHours?}` |
| `GET /rest/api/2/issue/:key/approval` | project browsers (and desk staff for requests) see everything; an assigned approver who may not browse sees only their own approvals without other decisions; everyone else 404 |
| `POST /rest/api/2/approval/:id/decision` | `{decision: approved \| declined, comment?}`; assigned approvers only (everyone else 404, even superusers); 409 when not pending / already decided / expired; rate limited per user (`APPROVAL_MAX_DECISIONS_PER_HOUR`, default 60) |
| `DELETE /rest/api/2/approval/:id` | cancel a pending approval: the requester or a project administrator, others 404 |
| `GET /rest/api/2/approval/pending` | my pending approvals, paged (`startAt`, `maxResults` up to 100) |
| `GET/POST/PUT/DELETE /rest/api/2/project/:key/approval-template[/:id]` | project administrators write; agents with TRANSITION_ISSUES may list a summary |
| `GET /rest/servicedeskapi/portal/:slug/approvals[?key=KEY]` | portal approver: pending approvals addressed to me on this desk (or all of mine on request KEY); request key and summary only |
| `POST /rest/servicedeskapi/portal/:slug/approvals/:id/decision` | portal decision; 404 for anything not addressed to me or not on this desk |

All bodies are strict zod objects. Customers who are approvers never see other approvers, decisions of others,
internal comments or issue fields beyond the request summary.

## Notifications

- Email `approval-requested` to the approvers on creation and as reminder (only to those who have not decided);
  email `approval-decided` to the requester on completion. User content is escaped (`escapeTemplateData`).
- Webhooks and plugin events `approval.requested` and `approval.decided`.
- Background job `approvals/reminders.ts` (every 5 minutes, overlap guarded in `index.ts`) expires overdue approvals
  and sends due reminders.
- Audit log actions: `approval.request`, `approval.decision` (no comment text), `approval.cancel`, `approval-template.*`.

## Not included

No approver taken from a user field (e.g. "reporter's manager": there is no manager field), no per-transition condition
variant, no editing of a decision after it was made, no approval forms, no escalation to a deputy on expiry.
