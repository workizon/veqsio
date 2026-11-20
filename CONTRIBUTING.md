# Contributing to Veqsio

Thanks for helping! A few ground rules keep the project healthy.

> **Pull requests from outside Workizon are not accepted yet.** The Contributor License Agreement below is still being finalised and the CLA bot is switched off. Please do not open a pull request for now; write to us by e-mail instead (see [veqsio.com/sla](https://veqsio.com/sla)). This page will be updated when contributions open.

## Workflow

1. Open an issue (or comment on an existing one) before starting large changes.
2. Branch from the default branch, keep changes focused, and add tests.
3. Run the checks below before opening a pull request.

## Checks

```bash
# API: build, unit + integration tests (needs PostgreSQL; see README)
cd packages/api && bun build src/index.ts --outdir /tmp/veqsio-api --target bun
REDIS_URL=memory: bun test src/**/*.test.ts tests/integration/all.test.ts

# Web: type check and production build
cd packages/web && npx tsc --noEmit && npx next build
```

## Code guidelines

- **Security by default:** new endpoints require authentication and an explicit permission check; validate input with Zod using `.strict()` objects; never return data the caller is not allowed to see (404 instead of 403 when the existence of a resource is itself sensitive).
- **Database changes:** edit `packages/db/schema.ts`, then run `cd packages/db && bun run db:generate` and commit the generated SQL, snapshot and `schema-version.ts` with your change (CI fails when they are missing). Keep changes additive when possible; describe destructive changes and any data migration in the pull request. See `docs/deployment.md` for how upgrades run.
- **Tests:** put pure logic in small modules with unit tests; use the integration suite for HTTP behaviour and authorization rules.
- **UI:** keep pages accessible (labels, roles, keyboard use) and handle loading, empty and error states. UI text is English.
- **Commits:** short imperative subject (`feat(scope): ...`, `fix(scope): ...`).

## Reporting vulnerabilities

Please do not open public issues for security problems. Follow [`SECURITY.md`](SECURITY.md) (GitHub private vulnerability reporting); the security model is described in [`docs/security.md`](docs/security.md). Participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Contributor License Agreement

Before your first pull request can be merged you must sign the [CLA](CLA.md). The CLA bot comments on the pull
request with instructions; you sign once with a single comment and it covers all later contributions. You keep the
copyright in your work. The CLA lets the project distribute the code under the AGPL and also under commercial and
Enterprise licences (see [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)).

Paid modules are developed in a separate private repository and are not accepted as pull requests here. Community
code must never import from `ee/`; `scripts/check-ee-boundary.sh` checks this in CI.
