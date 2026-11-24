# Changelog

All notable changes to Veqsio (community edition). The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
version numbers follow [Semantic Versioning](https://semver.org/). Every `## [x.y.z]` section is published as the notes of the GitHub
release `vx.y.z` (see `scripts/release.sh`). The enterprise edition (`veqsio-ee`) uses the same version numbers.

## [1.3.1] - 2026-11-24

[security]

### Security
- Session and single sign-on cookies are marked `Secure` again on HTTPS installations. The API bundle had fixed `NODE_ENV` at build time, which also switched off the production checks for SAML (browser binding of the login), LDAP (no plain-text bind) and the OIDC/SAML redirect addresses. The build now keeps it a runtime setting and fails if it does not. Installations served over plain `http://` keep working without the flag; `COOKIE_SECURE=true|false` overrides the choice.
- Portal-only customers can no longer list or look up the users of the organisation (`/rest/api/2/user`, `/rest/api/2/user/search`, which returned names and e-mail addresses) or read the internal wiki (`/rest/api/2/pages`). They still see their own profile.
- The web app no longer sends the `X-Powered-By` header.

### Fixed
- Background jobs could exhaust the database connection pool and stall every request (each job held one connection for its lock and waited for a second one). Job locks now use their own small pool (`DB_JOB_LOCK_POOL_MAX`, default 16).
- `SERVERINFO_HIDE_VERSION=1` leaves the version out of the public `serverInfo` response.
- Integration tests: hooks get the same 30 s timeout as tests (random failures on slow CI runners).

## [1.3.0] - 2026-11-20

### Added
- Veqsio for Open Source: open-source projects get a free licence with every paid feature (see `docs/open-source-program.md`).
- Interface language for dates, numbers and relative times ("5 minutes ago", "in 2 days") follows the chosen language with the correct plural forms, and the page language (`<html lang>`) is set on every page.
- About 700 more interface texts are translated into German, Spanish, Russian, French, Portuguese, Chinese and Japanese: messages built in code, board and service desk screens, confirmations, tooltips, the Administration overview, the names and descriptions of settings and features, standard status and priority names, and the weekday names in the calendar.
- `THIRD-PARTY-NOTICES.md` and a `licenses/` folder; the Docker images contain `/licenses` (the licence, `NOTICE`, the third-party notices and the licence of the Geist font).
- Installer: `--no-telemetry`, and it prints what the anonymous usage statistics contain and how to switch them off.

### Changed
- Anonymous usage statistics stay on by default (a daily count with a random id, the version, the edition and a rough size, nothing else; see `docs/telemetry.md`), and this is now stated openly in the installer, the documentation and on the web site.
- `LICENSE` is the verbatim text of the GNU AGPL-3.0 from gnu.org (three links used `http://`).
- Documentation brought up to date: README and the site docs (installer options, usage statistics, the notification bell, the Valkey upgrade note, tested platforms).

### Fixed
- `VEQSIO_TELEMETRY=off` in `.env` did not reach the API container of the Docker Compose installation (the variable was not in the Compose file), so the documented off-switch only worked through the setting.
- The calendar showed English weekday names, and English was shown for relative times and for the greeting on the dashboard in every other language.

## [1.2.3] - 2026-11-20

### Fixed
- About 600 interface texts (messages built in code, board and service desk screens, confirmations, tooltips) were passed through the translation function but had no
  translation and showed in English. They are now translated into German, Spanish, Russian, French, Portuguese, Chinese and Japanese.

## [1.2.2] - 2026-11-20

### Fixed
- The calendar showed English weekday names; they now follow the interface language. The Administration overview and its menu now translate the section descriptions and hints.
- Installation with a domain and automatic HTTPS (Let's Encrypt) was tested on a clean server together with the upgrade path.

## [1.2.1] - 2026-11-20

### Fixed
- Upgrading from 1.2.0 or earlier: Valkey 8 cannot read the data file of Redis 7.4 (RDB format 12) and stopped in a restart loop. The Compose files now use a new volume
  (`valkey_data`), so the old file is simply ignored. Only sessions and caches are lost, so people sign in once more. The old `redis_data` volume can be removed
  after the upgrade (`docker volume rm <project>_redis_data`).

## [1.2.0] - 2026-11-20

### Changed
- Valkey 8 (BSD-3-Clause) replaces Redis 7 in the Docker Compose files, the installer, CI and Veqsio Cloud: Redis 7.4 and later are no longer under an
  open-source licence. The protocol is the same and no configuration changes. Redis only holds sessions and caches; if an upgrade cannot read the old
  data, people simply sign in again.
- The copyright notice names Workizon Ltd and the Veqsio contributors, and every package declares `AGPL-3.0-only` (the SDK, the MCP server, the client and the
  example module said `AGPL-3.0-or-later`).

### Added
- `THIRD-PARTY-NOTICES.md` (generated by `scripts/gen-third-party-notices.ts`): the open-source packages, fonts and images Veqsio is built from, with their licences.

## [1.1.1] - 2026-11-20

### Fixed
- `install.sh` failed without `--domain` ("VEQSIO_DOMAIN is missing a value") because every `docker compose` command expanded the certbot service. Installations
  with and without a domain, and upgrades, were tested on a clean server.
- A React hydration error (#418) in the console of browsers whose language is not English.

## [1.1.0] - 2026-11-20

### Added
- In-app notification inbox: the bell in the header shows a real, per-user list (assignments, mentions, comments, updates, new issues and
  sprint events) with an unread counter, mark-as-read and links to the issue. Only people who can see an issue are notified about it.
- Interface translations for German, Spanish, Russian, French, Portuguese (Brazil), Simplified Chinese and Japanese, including menus,
  tooltips, placeholders, toasts and dialogs.
- Optional anonymous usage statistics (setting `shareUsageStats`, see `docs/telemetry.md`).

### Changed
- Dates and numbers follow the interface language instead of the browser language; the page language (`<html lang>`) is set on every page.

### Fixed
- The notification bell showed placeholder items that linked to issues that do not exist.
- The public demo banner showed a half-translated sentence.

## [1.0.0] - 2026-11-13

- First version: issue tracking, boards and backlogs, workflows, permissions and issue security, service desk, pages, automation,
  integrations, import from other tools.
