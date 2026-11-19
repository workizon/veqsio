# Testing

| Layer | Where | Command | Needs |
| --- | --- | --- | --- |
| API unit tests | `packages/api/src/**/*.test.ts` | `bun test src/**/*.test.ts` | nothing (a few use the in-memory Redis) |
| API integration tests | `packages/api/tests/integration/*.api.ts`, loaded by `all.test.ts` | see below | PostgreSQL |
| Security suite | `packages/api/tests/integration/security.api.ts` (part of the integration run) | same | PostgreSQL |
| Web unit tests | `packages/web/tests/*.test.ts` | `cd packages/web && bun test tests` | nothing |
| End-to-end | `packages/web/e2e/*.playwright.ts` | see [End-to-end](#end-to-end-playwright) | API + web + seeded database + Chromium |
| Load and scale | `loadtest/`, `scripts/perf/` | see the scripts | PostgreSQL, Redis, a seeded database |

## API tests

The integration suite truncates tables, so it needs a database of its own (never a shared one):

```bash
createdb veqsio_test
(cd packages/db && DATABASE_URL=postgresql://veqsio:veqsio@localhost:5432/veqsio_test bunx drizzle-kit push --force)
cd packages/api
REDIS_URL=memory: \
TEST_DATABASE_URL=postgresql://veqsio:veqsio@localhost:5432/veqsio_test \
DATABASE_URL=postgresql://veqsio:veqsio@localhost:5432/veqsio_test \
bun test src/**/*.test.ts tests/integration/all.test.ts
```

`all.test.ts` sets `STORAGE_TYPE=mock` before importing the individual suites. To run one suite on its own, set `STORAGE_TYPE=mock` in the environment as well (the storage configuration is read when the app is imported), for example:

```bash
STORAGE_TYPE=mock REDIS_URL=memory: TEST_DATABASE_URL=... DATABASE_URL=... bun test ./tests/integration/security.api.ts
```

State at the time of writing: 512 tests in 23 files, all passing, about 50 seconds.

### The security suite guards regressions

`security.api.ts` enumerates the Hono route table, so it fails when a new route is reachable without authentication until the route is added to the explicit `PUBLIC_ROUTES` allowlist in that file. It also runs an IDOR sweep over about 50 endpoint families. Details and the findings it produced are in [security.md](security.md#automated-security-suite).

## End-to-end (Playwright)

Specs live in `packages/web/e2e/` and are matched by `playwright.config.ts` (`*.playwright.ts`, projects `chromium` and `firefox`). They talk to a running web app (`PLAYWRIGHT_BASE_URL`, default `http://localhost:3001`) that talks to a running API.

**Status of the existing specs.** `auth`, `issues`, `board` and `sprint` were written early and have not been maintained alongside the UI:

- They assume the seed data of `packages/db/seed.ts` plus a project called "Test Project" with key `TEST` that the seed does not create (`issues.playwright.ts` selects it by label). A fresh database has only `DEMO`.
- Selectors are text and placeholder based (`input[placeholder="Username"]`, `text=Welcome to Veqsio`, `button:has-text("Sign In")`); several screens changed since (login page, board and sprint screens, realtime updates).
- Board drag-and-drop and sprint lifecycle specs assume an empty fresh project and fixed column names.
- `retries`/`workers` are tuned for CI only; `firefox` needs a browser the sandbox image does not have.

Treat `auth`, `issues`, `board` and `sprint` as **unverified against the current UI**. They were not part of the verified test run for this change.

**Smoke test.** `packages/web/e2e/smoke.playwright.ts` is the one spec kept deliberately small: log in, create an issue in the seeded `DEMO` project, find it on the board. See the header of that file for the exact environment variables. How it was run and whether it passed is recorded in the "E2E smoke run" section below.

### Running Playwright against a local stack

```bash
# 1. database + schema + seed (admin / admin123, project DEMO)
createdb veqsio_e2e
(cd packages/db && DATABASE_URL=postgresql://veqsio:veqsio@localhost:5432/veqsio_e2e bunx drizzle-kit push --force && DATABASE_URL=... bun seed.ts)

# 2. API
(cd packages/api && PORT=3040 REDIS_URL=memory: DATABASE_URL=... STORAGE_TYPE=mock WEB_URL=http://localhost:3001 bun src/index.ts) &

# 3. web (dev server is enough; production build: npx next build && npx next start -p 3001)
(cd packages/web && NEXT_PUBLIC_API_URL=http://localhost:3040 npx next dev -p 3001) &

# 4. run (Chromium only, no traces; the sandbox Chromium is preinstalled)
cd packages/web
PLAYWRIGHT_BASE_URL=http://localhost:3001 \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium-1243/chrome-linux/chrome \
npx playwright test e2e/smoke.playwright.ts --project=chromium --trace off
```

`WEB_URL` must match the origin the browser uses: the API refuses cookie-authenticated writes from any other `Origin` (see the CSRF notes in [security.md](security.md)).

## Not covered

- Migration tests against a real Jira backup (todo item 17 stays open).
- Unit tests for every service and repository (the integration suites cover most behaviour through the HTTP API).
- Cross-browser runs.
