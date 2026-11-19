# MCP server and REST client

Veqsio ships a [Model Context Protocol](https://modelcontextprotocol.io) server so assistants (Claude Desktop, Claude Code, other MCP clients) can work with your instance, and a small typed client for scripts.

| Package | What |
| --- | --- |
| `packages/mcp` (`@veqsio/mcp`) | MCP server over **stdio**, built on the official `@modelcontextprotocol/sdk` |
| `packages/client` (`@veqsio/client`) | Dependency-free typed TypeScript client for the REST API (used by the MCP server). Not to be confused with `packages/sdk`, which is the *module* SDK |

The server talks to Veqsio **only through the public REST API** with a personal access token. It never reads the database. Every permission check of the API applies, and the scopes of the token are enforced by the API (`tokenScopes` middleware). A token that is read-only makes write tools fail with a clear message instead of changing anything.

## Quick start

1. Create a personal access token: **Profile → Access tokens** (`/profile/tokens`). Choose the narrowest scopes that do the job (see below) and a short expiry.
2. Run the server with two environment variables (Bun is required; the repository must be checked out and `bun install` run once):

```bash
VEQSIO_URL=https://jira.example.com VEQSIO_TOKEN=veqsio_... bun /path/to/veqsio/packages/mcp/src/bin.ts
```

| Variable | Meaning |
| --- | --- |
| `VEQSIO_URL` | Base URL of the instance (the API origin, no path). Required. |
| `VEQSIO_TOKEN` | Personal access token. Without it only the three anonymous `*_public_*` tools are offered. |
| `VEQSIO_MCP_READONLY` | `true` (**default**) registers no tools that change data. Set `false` to allow writes. |
| `VEQSIO_TIMEOUT_MS` | Per request timeout, default 20000. |

stdout carries the protocol only; a one-line status goes to stderr.

## Client configuration

### Claude Desktop

`claude_desktop_config.json` (Settings, Developer, Edit config):

```json
{
  "mcpServers": {
    "veqsio": {
      "command": "bun",
      "args": ["/path/to/veqsio/packages/mcp/src/bin.ts"],
      "env": {
        "VEQSIO_URL": "https://jira.example.com",
        "VEQSIO_TOKEN": "veqsio_...",
        "VEQSIO_MCP_READONLY": "true"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add veqsio \
  --env VEQSIO_URL=https://jira.example.com \
  --env VEQSIO_TOKEN=veqsio_... \
  --env VEQSIO_MCP_READONLY=true \
  -- bun /path/to/veqsio/packages/mcp/src/bin.ts
```

Or a project `.mcp.json` (do not commit the token; use an environment variable reference such as `"VEQSIO_TOKEN": "${VEQSIO_TOKEN}"`):

```json
{
  "mcpServers": {
    "veqsio": {
      "command": "bun",
      "args": ["packages/mcp/src/bin.ts"],
      "env": { "VEQSIO_URL": "https://jira.example.com", "VEQSIO_TOKEN": "${VEQSIO_TOKEN}" }
    }
  }
}
```

### Any other MCP client

Start `bun packages/mcp/src/bin.ts` as a stdio server with the variables above. The server speaks MCP (`initialize`, `ping`, `tools/list`, `tools/call`) and declares only the `tools` capability.

## Tools

Names are snake_case; outputs are short text, truncated and paged (`start_at`, `max_results`).

| Tool | Writes | What it does |
| --- | --- | --- |
| `whoami` | | The user and instance the token belongs to |
| `list_projects`, `get_project` | | Browsable projects; a project with its issue types |
| `search_issues` | | JQL search, one line per issue, paged |
| `get_issue` | | Fields, description, sub-tasks, links, newest comments and the development panel (branches, commits, pull requests) when Git integration is on |
| `create_issue` | yes | Reads the project's *createmeta* first: issue type, priority, components and versions are checked by name, sub-tasks need `parent`, assignee may be a username, e-mail or `me`. Unknown values are answered with the allowed list |
| `update_issue` | yes | Summary, description, priority, labels, due date, story points |
| `add_comment` | yes | Comment as the token user |
| `list_transitions` | | Available workflow transitions with required input |
| `transition_issue` | yes | Transition by id, name or target status; resolution and comment when the workflow requires them |
| `assign_issue` | yes | Assign to a user, `me` or `unassigned`; ambiguous names are refused |
| `link_issues` | yes | `A-1 blocks A-2` style, by link type name, outward or inward phrase |
| `list_sprints`, `get_sprint_issues` | | Sprints of a project's boards; issues of a sprint |
| `get_release_notes` | | Release notes (Markdown) of a version by name or id |
| `list_public_projects`, `list_public_issues`, `get_public_issue` | | Anonymous `/rest/public` API: no token is sent; works only when the instance publishes projects ([public-projects.md](public-projects.md)) |

The six write tools (`create_issue`, `update_issue`, `add_comment`, `transition_issue`, `assign_issue`, `link_issues`) are **not registered** in read-only mode, so the model never sees them.

Errors are returned as tool errors (`isError`) with one actionable sentence: 401 (token missing, expired or revoked), 403 (token scope or user permission, the message says which), 404 (missing or not visible), 402 (needs an Enterprise licence), 400 (rejected, with the server's reasons), 429, 5xx and network failures.

## Token scopes

| Goal | Scopes |
| --- | --- |
| Read-only assistant (recommended start) | `read:issues`, `read:projects` (or `read:*`) |
| Assistant that triages and comments | `write:issues`, `read:projects` |
| Needs sprints, boards, release notes | add `read:projects` (boards, sprints, versions, projects) |

Never use `*` or `admin` for an assistant. Scopes are enforced by the API even if you start the server with `VEQSIO_MCP_READONLY=false`. Two layers are intended: the server mode limits what the model is *offered*, the token limits what is *possible*. Use a dedicated Veqsio user for the assistant if it should have fewer permissions than you; the token can never exceed its owner's permissions. Rotate and revoke tokens under Profile → Access tokens.

## Security notes

- **Prompt injection.** Issue summaries, descriptions, comments, release notes and project names can be written by anyone who can edit the issue, including outsiders on service desk and public projects. The server wraps all of that text in `<untrusted-user-content source="...">` elements, neutralises a closing tag inside the text so content cannot break out, and tells the model in the server instructions and tool descriptions that such text is data, never instructions. Short metadata (names, labels, versions) is truncated but not wrapped. Wrapping reduces the risk, it cannot remove it: keep the server read-only unless you need writes, use a token with minimal scopes, and have the client ask for confirmation on write tools (the tools carry `readOnlyHint` annotations, so clients can auto-approve reads and prompt for writes).
- **Least privilege.** Prefer a dedicated user and a read-only token with a short expiry.
- **Token handling.** The token is read from the environment, sent only as a bearer header to `VEQSIO_URL`, never logged and never included in tool output or error messages. Redirects are not followed, so a redirect cannot carry the token elsewhere. Use `https://` URLs outside localhost. Public tools never send the token.
- **Bounded output.** Search pages are capped (50), comments to the 50 newest, text fields are truncated, so one call cannot flood the model context.
- **Rate limits.** Calls count against the API rate limits of that user like any other client.

## Not included

- **No Streamable HTTP endpoint (`/rest/mcp`).** The server is stdio only. A hosted endpoint inside the API would make the API proxy tool calls for the caller with its own authority, needs a session and origin-validation design (DNS rebinding, CORS) and its own scope mapping (`/rest/mcp` is not in the token-scope tables, so a POST would need `write:*` even for reads). That is deliberately left out until it can be done safely; for remote use, run the stdio server where the assistant runs.
- MCP resources and prompts, delete operations, attachments, worklogs, bulk operations, npm publishing.

## Using the client directly

```ts
import { VeqsioClient } from '@veqsio/client'

const veqsio = new VeqsioClient({ baseUrl: 'https://jira.example.com', token: process.env.VEQSIO_TOKEN })
const { issues } = await veqsio.searchIssues('assignee = currentUser() AND resolution = Unresolved', 0, 10)
```

Failures throw `VeqsioError` with `kind` (`auth`, `forbidden`, `not_found`, `license`, `validation`, `rate_limited`, `server`, `network`), `status` and the server's messages. A custom `fetch` can be injected (tests, proxies).

## Tests

```bash
cd packages/mcp && bun test tests/      # protocol handshake over stdio, every tool's request mapping, errors, read-only mode
cd packages/client && bun test src/
```

`packages/api/tests/integration/mcp.api.ts` runs the server against the real application through `app.request` (real tokens, scopes and permissions).

## Resources and prompts

With a token the server also offers **resources**, so a client can attach context without a tool call:

| URI | Content |
| --- | --- |
| `veqsio://issue/PROJ-123` | The issue as `get_issue` shows it (fields, description, comments, links) |
| `veqsio://project/PROJ` | The project as `get_project` shows it |

Resources read through the same handlers as the tools: same permissions (the token's user), same truncation and the same `untrusted-user-content` wrapping. They are templates, not a list.

And four **prompts**, ready-made starting points that only name the tools to use and carry no data: `triage_issue` (key), `summarize_sprint` (project, optional sprint), `draft_release_notes` (project, version), `find_duplicates` (project, description). Without a token neither resources nor prompts are offered.
