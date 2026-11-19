# Modules (minimal host)

Status: **minimal**. The SDK (`packages/sdk`: manifest, `defineModule`, `defineWebModule`, events) and the per-module
migration runner (`packages/api/src/modules/migrations.ts`) existed; the rest of the framework (install/uninstall flow,
admin marketplace UI, example module sources) is not in this tree. To build the Timesheets module a small host was added;
the integrator can replace it with the full framework as long as the contracts below stay.

## Layout

- Community modules: `modules/<id>/` (AGPL). Paid modules are delivered separately and are placed in `ee/modules/<id>/`
  (or any directory listed in `VEQSIO_MODULE_DIRS`); their manifest has `"edition": "enterprise"` and a `feature` key.
  A checkout without them simply finds fewer modules. Each module has `veqsio.module.json`, `src/server.ts` (default export of
  `defineModule`), optional `src/web.tsx` (default export of `defineWebModule`) and `package.json` (workspace).
- Community code never imports `ee/`. The API loads modules with a runtime `import()` of a discovered path
  (`packages/api/src/modules/host.ts`); the web app uses a build-time generated, git-ignored registry
  (`packages/web/scripts/gen-module-registry.ts`, excluded in `scripts/check-ee-boundary.sh`).
- Tables of a module start with `<id with _>_` (`timesheets_`); migrations are SQL strings in `defineModule({ migrations })`.

## Host behaviour (`packages/api/src/modules/host.ts`)

- Discovery in `modules/*`, `ee/modules/*` and `VEQSIO_MODULE_DIRS` (comma separated); `devOnly` modules need `VEQSIO_DEV_MODULES=1`.
- `syncModules()` (called at API start): registers modules in `installed_modules` (enabled by default), runs migrations of
  licensed modules. `startModuleJobs()` runs `defineModule({ jobs })` on an interval with an overlap guard.
- Requests to `/rest/modules/<id>/*`: 401 anonymous; 402 when the licence lacks the module's `feature`; 404 when disabled
  or when the route is not declared in `contributes.server.routes` (use `{ "method": "*", "path": "/*" }` to declare all);
  then the module's Hono sub-app handles it with the session user.
- `GET /rest/api/2/modules/active` (web contributions of serving modules), `GET /rest/api/2/modules` and
  `PUT /rest/api/2/modules/:id {enabled}` (administrators).
- Web: pages are served under `/m/<id>/<path>` using the `navItems` / `adminPages` of the manifest.

## Extension points available to modules

- `hooks.beforeWorklogChange(change, ctx)`: veto create/update/delete of a worklog (`packages/api/src/modules/hooks.ts`,
  used by `packages/api/src/services/worklogs.ts`). Fail closed.
- `jobs`: background jobs. `routes`: HTTP routes. `events`: in-process event bus (core does not emit worklog events yet).

- Workflow `module_check` validators (`transitionChecks`): named checks a module provides; skipped while the module is not serving.
- `deskTemplates`: service desk templates offered in the wizard; `hooks.afterRequestCreated`: after a portal request was stored.
- `ctx.core`: desk role, staff desks, notice e-mail, events, approvals, issue creation, transitions.
- Web: `issuePanels` render on the issue view, `navItems[].hidden` keeps a page out of the top navigation.

Known gaps: no uninstall flow, no settings UI, no signed/external modules. The API container image ships `modules/`, `ee/` and the
workspace packages they import next to `dist/index.js` and sets `VEQSIO_MODULE_DIRS=/app/modules,/app/ee/modules`, so bundled
modules load in Docker installs too.
