# Security Policy

## Supported versions

Veqsio is under active development. Security fixes are made on the `main` branch only; there are no maintained release branches yet. Please reproduce issues against the latest `main` before reporting.

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a security problem.**

Write to security@veqsio.com, or use GitHub's private vulnerability reporting on the repository (the "Security" tab, then "Report a vulnerability"). Include:

- a description of the issue and its impact,
- steps to reproduce, ideally a minimal request or test case,
- the commit or version you tested, and your deployment setup if relevant (for example the object storage backend).

Please do not include real customer data or credentials in a report, and do not access data that is not yours while testing.

## Scope

In scope:

- the API (`packages/api`) and web app (`packages/web`),
- authentication, sessions, personal access tokens and SSO,
- authorization: global permissions, project permission schemes, service desk roles, and the customer portal,
- injection, XSS, CSRF, SSRF, IDOR/BOLA, and mass-assignment issues,
- file upload and download handling, email templates, and the migration importers,
- the Docker Compose production stack, Nginx configuration and scripts in this repository.

Out of scope:

- vulnerabilities in third-party dependencies with no demonstrable impact on Veqsio (report those upstream),
- findings that need an already compromised administrator account or host,
- denial of service by sheer traffic volume, and missing hardening on deployments that ignore `docs/deployment.md`,
- social engineering and physical attacks,
- the demo credentials created by the seed script (they must be changed on any shared environment).

## What to expect

Veqsio is maintained by volunteers, so these are targets, not guarantees:

- acknowledgement of your report within about 5 working days,
- an initial assessment (accepted, needs more information, or declined with reasons) within about 10 working days,
- a fix developed privately for confirmed issues, and coordinated disclosure: we will agree a publication date with you and credit you in the advisory if you wish.

See [`docs/security.md`](docs/security.md) for the security model.
