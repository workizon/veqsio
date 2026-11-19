# Intake / triage

Intake gives a project a queue for incoming requests and ideas. A submission is **not an issue** until a project member accepts it, so the backlog and boards stay clean. It is meant for software and business projects; customer-facing help centres with SLAs remain the job of the Service Desk (a service desk project cannot enable intake).

Switchable in **Administration → Features and modules** (id `intake`). Switched off, every intake API answers 404 and the menu entry, settings tab and public form disappear; data is kept.

## Turn it on
**Project settings → Intake** (needs the Administer Project permission): enable the queue, optionally the public form and email intake. Open the queue at **Projects → Intake** or `/projects/<KEY>/intake`.

## Who may do what
| Action | Permission |
| --- | --- |
| Submit to intake in the app / API | Browse Projects |
| See the queue and triage (accept, decline, snooze, duplicate, reopen, bulk) | Create Issues (accepting creates an issue, so no new permission rule is needed) |
| Settings, public form link, email secret | Administer Project |

A project you cannot browse answers 404. A requester who is not allowed to triage sees only their own "Submit" button.

## Triage
Statuses: `pending`, `snoozed`, `accepted`, `declined`, `duplicate`. The queue has tabs with counts.

- **Accept**: creates a real issue in the project (issue type required, priority and assignee optional, summary editable, optional note appended to the description). The item links to the issue (`acceptedIssue`). Issues are created by the person triaging; the description ends with "Submitted via intake (source) by name <email>".
- **Decline**: with an optional reason.
- **Snooze until a date** (within 366 days): the item leaves Pending and **returns to Pending automatically** when the date has passed. This happens on every queue read and by a job that runs every minute.
- **Duplicate of an issue** of the same project (issue key); the item keeps the link.
- **Reopen** a declined, duplicate or snoozed item.
- **Bulk**: up to 100 items per request with the same action and parameters; each item is decided on its own and reported on its own (`succeeded`, `failed`, per-item `error`).
- Accepted items are final. Decisions are atomic: if two people decide the same item at once, one gets `409`.
- When the requester's email is known, they get an email on accept and decline (through the normal email queue; all data is HTML-escaped). Snooze, duplicate and reopen send nothing.

Keyboard in the queue: arrow keys or `j`/`k` move, `Space` selects, `a` accept, `d` decline, `s` snooze, `u` duplicate.

## Sources
| Source (`source`) | How |
| --- | --- |
| `app` | "Submit to intake" in the queue. The requester is the signed-in user. |
| `api` | Same endpoint with a personal access token. |
| `form` | Public form, below. |
| `email` | Inbound email webhook, below. |

Attachments on intake items are **not built**.

### Public form
`/intake/<slug>` where `<slug>` is 24 random URL-safe characters (144 bits). Enable it per project and choose title, introduction and for each of name / email / description whether it is not asked, optional or required (the title is always required). **New link** rotates the slug; the old link stops immediately.

The anonymous API is `GET /rest/public/intake/<slug>` (returns only `title`, `intro`, `fields`; never the project name or key) and `POST /rest/public/intake/<slug>` with `{title, description?, name?, email?, website?}`. It answers `201 {"status":"received"}` without an id. Unknown, disabled or rotated slugs answer 404.

Spam and abuse protection, without a captcha:
- **Honeypot**: the hidden `website` field. A filled value answers exactly like a success and stores nothing.
- **Per-IP limit**: 5 submissions per 10 minutes (`INTAKE_PUBLIC_IP_MAX`, `INTAKE_PUBLIC_IP_WINDOW_MS`); also counts requests for unknown slugs. 429 with `Retry-After`. The address is the one added by your reverse proxy (`TRUSTED_PROXY_HOPS`, see the deployment guide).
- **Per-form limit**: 60 submissions per hour for one form (`INTAKE_PUBLIC_SLUG_MAX`), against floods from many addresses.
- **Queue cap**: at most 2000 pending form items (`INTAKE_PUBLIC_PENDING_CAP`); beyond that the form answers 429 until someone triages.
- **Size limits**: body 20 000 characters (413), title 200, details 10 000, name 100, email 254. Unknown JSON keys are rejected; fields the form does not collect are discarded. Control characters are stripped.
- The page is marked `noindex`; no cookies are used.

### Email intake
Veqsio **does not poll a mailbox**. A mail gateway or automation posts each message to

`POST /rest/api/2/intake/<slug>/email` with header `X-Veqsio-Inbound-Secret: <secret>` and JSON `{messageId, from, subject?, text?, headers?}`

(the same payload and secret mechanism as the Service Desk email channel, whose parsing helpers it reuses: sender address validation, quoted reply and signature stripping, auto-reply detection). Create the secret under **Project settings → Intake → Email intake** (shown once, only a hash is stored), then tick "Accept email".

- The subject (without `Re:`/`Fwd:`) becomes the title, the cleaned text the details, the sender the requester.
- Redelivery of the same `messageId` is ignored (`{"status":"duplicate"}`); auto-replies and bulk mail answer `{"status":"rejected"}`.
- 401 for a wrong secret, 404 when intake or email intake is off or the slug is wrong, 413 above 300 000 characters, 429 above 120 requests per minute per address (`INTAKE_EMAIL_IP_MAX`).
- The slug is shared with the public form, so **New link** also changes the webhook address.

## REST API
All under `/rest/api/2/project/<KEY>/intake` (session or personal access token; tokens need `write:projects` for changes):

| Method and path | Purpose |
| --- | --- |
| `GET /info` | `{enabled, canTriage, canAdmin, canSubmit}` |
| `GET /items?status=&q=&startAt=&maxResults=` | queue page with `counts` per status (default status `pending`) |
| `GET /items/<itemId>` | one item |
| `POST /items` | submit `{title, description?, requesterName?, requesterEmail?}` |
| `POST /items/<itemId>/accept` | `{issueTypeId, priorityId?, assigneeId?, summary?, note?, reason?}` |
| `POST /items/<itemId>/decline` | `{reason?}` |
| `POST /items/<itemId>/snooze` | `{until}` ISO date-time |
| `POST /items/<itemId>/duplicate` | `{issue, reason?}` |
| `POST /items/<itemId>/reopen` | |
| `POST /bulk` | `{ids[], action, ...params}` |
| `GET` / `PUT /settings` | `{enabled, publicFormEnabled, formTitle, formIntro, fields, emailEnabled}` |
| `POST /settings/rotate-slug` | new public link |
| `POST /settings/rotate-email-secret` | returns `secret` once |

## Not built
Attachments on intake items, an "intake responsibility" (auto-assignment of triagers or round robin), email polling (IMAP), captcha providers, per-project custom form fields beyond name / email / details, notifications to triagers when something new arrives, an audit trail of repeated decisions on one item (only the last decision is stored).
