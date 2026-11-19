# Public projects

A project can be made readable by anyone on the internet without signing in, like a public Jira project.

## Turn it on
1. An administrator enables **Instance settings → Public access → Allow public projects** (off by default).
2. A project administrator ticks **Public access** in *Project settings → Details*.

Public pages: `/p` (projects), `/p/KEY` (issue list with search and paging), `/p/KEY/KEY-1` (issue), `/p/KEY/KEY-1/markdown` (the same issue as Markdown).

## What is exposed (read-only)
Summary, description, type, status, priority, labels, fix versions, dates, assignee and reporter **display names**, and non-internal comments. Never: email addresses or usernames, internal comments, attachments, custom fields, links, worklogs, history, approvals. Service desk projects can never be public. The data comes from a separate allowlisted API (`/rest/public/*`), not from the signed-in endpoints, so no permission scheme change is involved. Turning the instance switch off (or the project flag) closes everything immediately (answers are cached for up to 60 seconds).

## Search engines, LLMs
`Instance settings → Search engines and AI crawlers`:
- **all** — indexable, `robots.txt` allows `/p/`, `/llms.txt` lists the projects for language-model tools.
- **search** (default) — indexable by search engines; known AI-training crawlers (GPTBot, ClaudeBot, CCBot, Google-Extended, PerplexityBot and others) are disallowed in `robots.txt`; no `llms.txt`.
- **none** — `robots.txt` disallows everything and pages carry `noindex`.

Each page has a title, description, canonical URL (set the instance Base URL under System), Open Graph and Twitter tags, `DiscussionForumPosting` JSON-LD with comments, and an alternate Markdown link. `/sitemap.xml` lists public projects and up to 50,000 issues. Search result pages and deep paging are `noindex`. `robots.txt` is advisory: it does not stop a crawler that ignores it, so do not make a project public if the content must stay confidential.

Not built: attachments and images on public pages, per-project indexing choice, public boards/roadmaps, subscribe by email.

## Board, roadmap and indexing per project

Three more switches live in **Project settings → Public access**, all off by default:

- **Ask search engines not to index this project** (`publicIndexing: none`). The project stays readable by anyone with the link; it is left out of the sitemap and its pages (and the Markdown view) say noindex. The instance setting under Search engines still applies on top: if the instance says none, every project is noindex.
- **Show a read-only board** (`publicBoard`). `/p/KEY/board` shows the columns of the project's first board with the newest 25 issues in each (key, summary, type and priority only). Issues with a security level never appear, as everywhere in the public view.
- **Show a roadmap** (`publicRoadmap`). `/p/KEY/roadmap` lists the versions that are not archived with name, description, dates and how many of their issues are done. Check your version descriptions before turning it on: they become public.

API: `GET /rest/public/projects/:key/board` and `/roadmap` (404 unless the instance has public projects enabled, the project is public and the switch is on). Project pages also carry schema.org JSON-LD (CollectionPage and BreadcrumbList).
