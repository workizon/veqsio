# Git integrations

Veqsio links issues to GitHub, GitLab, Gitea (including self-hosted) and Bitbucket. Open **Project settings → Repositories** (needs the Administer Project permission).

## Set-up
1. Link a repository (`owner/name`, optional server URL for self-hosted GitLab / Gitea / GitHub Enterprise, default branch, optional access token).
2. Copy the payload URL and secret shown once into the provider's webhook settings (`POST /rest/webhooks/scm/<id>`):
   - GitHub / Gitea: content type `application/json`, secret = the one shown. Events: push, pull requests, workflow runs (GitHub) / push, pull requests (Gitea).
   - GitLab: "Secret token" = the secret. Triggers: push, merge request, pipeline.
   - Bitbucket Cloud: deliveries are not signed, so the URL itself carries `?token=<secret>`; keep it private.
3. A new secret can be issued at any time ("New secret").

Deliveries are authenticated per repository (HMAC-SHA256 or token, constant-time compare, secret encrypted at rest with the instance key). Retries are idempotent.

## What is linked
Any branch name, commit message, pull/merge request title, branch or description containing an issue key of **the repository's project** (`PROJ-123`, case-insensitive in branch names). The issue shows a **Development** panel: pull requests with status (open / merged / closed), branches, commits and the latest build state (GitHub workflow runs and status events, GitLab pipelines).

## Smart commits
`PROJ-123 #comment text #done` — adds a comment and/or runs a transition whose name (or target status) matches the word (`#in-progress` → "in progress"; `#done` falls back to any transition into a Done-category status). It only runs when the commit author's email matches an active user who has the Add Comments / Transition Issues permission on the project, and only once per commit.

## Create a branch from an issue
With an access token on the repository, **Create branch** on the issue creates `PROJ-123-summary-slug` (or a name you type) from the default branch through the provider's API. Tokens are stored encrypted; the server URL passes the same SSRF guard as plugins.

## Release notes
`GET /rest/api/2/project/<KEY>/versions/<id>/release-notes` returns Markdown grouped by issue type (`?format=json` for JSON) for the issues of a fix version.

## Not built
Per-user OAuth apps (a project token is used), deployments, Bitbucket Server, issue creation from commits, pull request review state.
