# Service desk automation

Service desk → Settings → **Automation**. A rule has a trigger and an action and runs **once per request** (the ledger table `sd_automation_runs` prevents repeats), except the customer-reply trigger, which acts on every reply to a resolved request.

| Trigger | Fires when |
| --- | --- |
| SLA at x% | an unfinished SLA has used x% (1 to 99) of its target and is not breached; optional: only one SLA |
| SLA breached | an unfinished SLA is past its target |
| Waiting for the customer | a request has been in the status "Waiting for customer" for n days |
| Customer reply | the customer answers (portal or e-mail) on a resolved request |
| New request | a request is created (portal, e-mail or raised by an agent); optional conditions: mentions any of some words (summary or description, case-insensitive), arrives by a channel |

| Action | Does |
| --- | --- |
| Notify | e-mails the assignee, or all desk agents when unassigned (only people who can see the issue) |
| Reassign | sets the assignee |
| Change priority | sets the priority |
| Move to a status | performs the workflow transition to the named status (with an optional comment); **auto-close** is a "waiting for n days" rule that moves to Resolved; **auto-reopen** is a "customer reply" rule that moves to your reopen status |
| Comment | adds a public comment; placeholders `{{issue.key}}` and `{{days}}` |
| Add labels / set the request type | new-request rules only: **auto-categorisation** and **auto-prioritisation** of incoming requests (combine with Reassign and Change priority) |

New-request rules run in order of creation, each at most once per request, and see the changes of the rules before them. Examples: `mentions printer, scanner → label hardware`; `arrives by e-mail and mentions outage → priority Highest`.

Rules act as the user who last saved them, so history entries, comments and workflow conditions (who may move, validators) apply as for that person. A failing action (for example a status that cannot be reached) is recorded in the rule's run log and does not stop other rules. The check runs every minute (job `servicedesk-automation`, advisory-locked so only one node runs it); a reply to a resolved request is handled immediately. Rules need desk administrator rights to change; agents can read them and the run log (`GET .../automation/:id/runs`).

Not built: keyword matching by regular expression or by AI (see the optional AI assist for suggestions), business-hours-aware waiting (days are calendar days), a rule editor for conditions beyond the SLA choice, rules for other triggers (status changes, new request), notifying a team or channel instead of a person.

## Knowledge base suggestions on the portal
While a customer types the summary of a request, the portal shows up to three matching published articles with a snippet around the match. Matching is word-based (stop words are ignored; a title match counts three times a body match; helpful votes and views break ties) and every search is logged without the user, so the knowledge base report can list searches that found nothing.
