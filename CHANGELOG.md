# Changelog

All notable changes to Veqsio (community edition). The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
version numbers follow [Semantic Versioning](https://semver.org/). Every `## [x.y.z]` section is published as the notes of the GitHub
release `vx.y.z` (see `scripts/release.sh`). The enterprise edition (`veqsio-ee`) uses the same version numbers.

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
