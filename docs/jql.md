# JQL reference (extras)

The search API (`GET /rest/api/2/search?jql=...`) compiles JQL to SQL. Results are always limited to projects the caller may browse. This page lists the pieces added on top of the basic `field operator value` grammar; the field and operator list is offered by the autocomplete (`/rest/api/2/jql/autocompletedata`).

## LIMIT

```
project = TEST ORDER BY created DESC LIMIT 25
status = Open LIMIT 10
```

- `LIMIT n` goes after `ORDER BY` (or after the conditions); `n` is a whole number from 1 to 1000, anything else is a 400.
- It caps the whole result set: `total` is at most `n`. Paging still works inside it: `startAt` and `maxResults` page through the first `n` issues (`LIMIT 3` with `startAt=2&maxResults=5` returns one issue). Without `LIMIT` nothing changes; `maxResults` keeps its own maximum of 1000.
- `LIMIT` applies to the search API and the issue navigator. Other consumers of JQL (board filters, dashboards gadgets, saved views, SLA goals, automation) parse it but ignore the cap.

## Relation functions

Used with the `key` or `id` field (they stand for a set of issues) with `IN`, `NOT IN`, `=` or `!=`. The issue key argument is required.

| Function | Meaning |
| --- | --- |
| `linkedIssues("ABC-1")` | issues linked to ABC-1 in any direction |
| `linkedIssues("ABC-1", "blocks")` | issues ABC-1 blocks. The second argument is a link type name or its inward / outward sentence ("blocks", "is blocked by", "relates to"); a sentence selects the direction |
| `blockedBy("ABC-1")` | issues that block ABC-1 |
| `blocking("ABC-1")` | issues that ABC-1 blocks |
| `subtasksOf("ABC-1")` | children of ABC-1 |
| `issuesWithoutParent()` | issues without a parent |

```
key in blockedBy("ABC-1") AND status != Done
project = ABC AND key in issuesWithoutParent() ORDER BY created DESC LIMIT 50
key not in linkedIssues("ABC-1", "relates to")
```

`blockedBy` and `blocking` match the built-in "Blocks" link type (inward "is blocked by", outward "blocks"). The functions are in the autocomplete data for the `key` field. `IN` now also accepts any list-returning function directly (`assignee in membersOf("devs")`).

## Not built

Rollup / aggregate functions (sum of estimate or worklog), `linkedToAny`, a `timeInStatus` field and natural-language to JQL are not implemented.
