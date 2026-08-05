---
name: verify
description: Launch and drive the maxstack web runtime (apps/web) to verify UI/library changes end-to-end against a real project data dir.
---

# Verify apps/web (and @maxstack/ui through it)

## Launch

```sh
cd maxstack/apps/web
MAXSTACK_DATA_DIR=/absolute/path/to/a/maxstack/project pnpm dev --port 4173
```

- `MAXSTACK_DATA_DIR` points at a project dir containing a `spec/` dir + `db/`.
  Must be an absolute path. Generate one with `maxstack start "..."` if you do
  not have a project to hand. (A legacy single `spec.json` is migrated to `spec/` on first load.)
- The generic admin CRUD surface is `/admin/<resource>` (resource names come
  from `spec/data.json` → `data.entities`, lowercased). REST is `/api/<resource>`
  (GET list, POST create, PATCH `/:id`, DELETE `/:id`) — handy for seeding and
  cleaning up test rows.

## Drive

Claude-in-Chrome if connected; otherwise Playwright works headless:
`npm i playwright` in the scratchpad and drive `http://localhost:4173`.

## Gotchas

- The old "first page load 504s with Outdated Optimize Dep" gotcha is fixed:
  `vite.config.ts` pins `optimizeDeps.include`/`exclude`, so cold
  starts and ui-source edits load clean. If a 504 reappears, a new client dep
  was likely added without updating that pin list.
- Clean up seeded rows via `DELETE /api/<resource>/<id>` — the dogfood db is
  a real working tree file (`<project>/db/`), not a fixture.
- Playwright: editors/controls that unmount on change (e.g. edit-in-place
  cells) need `click({ noWaitAfter: true })`, not `check()`/`fill()` variants
  that re-verify state after the action.
