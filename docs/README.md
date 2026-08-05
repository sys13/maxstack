# maxstack docs

Two genres live here and they read differently: **guides** you follow, and
**reference** you consult. Every file below is filed under one.

Four of the reference pages are generated from the code they document —
[`cli-reference.md`](cli-reference.md), [`spec-ops.md`](spec-ops.md),
[`mcp-reference.md`](mcp-reference.md) and
[`bundle-reference.md`](bundle-reference.md). Don't hand-edit them; run
`pnpm docs:reference`. A drift check in `pnpm validate` fails any change that
adds a verb, flag or op without regenerating them.

## Start here

- [**quickstart.md**](quickstart.md) — from nothing to a running app you have
  changed yourself.
- [**user-guide.md**](user-guide.md) — the full tour: specs, ops, ownership,
  agents, deployment.
- [**../ARCHITECTURE.md**](../ARCHITECTURE.md) — the layer map, and how a change
  flows through it.

## Reference

- [**cli-reference.md**](cli-reference.md) — every verb and flag.
- [**spec-ops.md**](spec-ops.md) — the full spec-op vocabulary.
- [**mcp-reference.md**](mcp-reference.md) — the tools an agent gets.
- [**bundle-reference.md**](bundle-reference.md) — the feature-bundle catalog.

## Working with the spec

- [**ownership.md**](ownership.md) — spec-op, slot, eject: what you own, and
  what regeneration will touch.
- [**block-slots.md**](block-slots.md) — bespoke UI inside a generated page.
- [**workbench.md**](workbench.md) — the review surface.
- [**bulk-review.md**](bulk-review.md) — clearing the queue safely, and what
  refuses to be batched.
- [**write-paths.md**](write-paths.md) — every path that can land a spec op, and
  who may accept.

## Capabilities

- [**board-views.md**](board-views.md) · [**date-views.md**](date-views.md) —
  boards, calendars and timelines derived from declared fields.
- [**search.md**](search.md) — full-text search.
- [**storage.md**](storage.md) — file fields and object storage.
- [**documents.md**](documents.md) — PDF generation.
- [**imports.md**](imports.md) — CSV and spreadsheet import.
- [**external-sources.md**](external-sources.md) — pulling from third-party
  APIs, and the SSRF boundary.
- [**live.md**](live.md) — live-updating surfaces.
- [**portals.md**](portals.md) — deliberately public endpoints.
- [**api-keys.md**](api-keys.md) — programmatic access and scopes.
- [**flags-and-preferences.md**](flags-and-preferences.md) — feature flags and
  per-user preferences.

## Operating an app

- [**deploy.md**](deploy.md) — Docker and Fly.
- [**security-baseline.md**](security-baseline.md) — the security posture, and
  what the dev-mode admin fallback does. To *report* a vulnerability, see
  [../SECURITY.md](../SECURITY.md).

## How it is checked

- [**measurement.md**](measurement.md) — what is measured, how, and what the
  numbers do not claim.
- [**combination-safety.md**](combination-safety.md) — why any subset of the
  bundle catalog has to work.
- [**upgrade-safety.md**](upgrade-safety.md) — why an upgrade may not silently
  change what you added by hand.

## Contributing

- [**../CONTRIBUTING.md**](../CONTRIBUTING.md) — setup, the gate, and why each
  check exists.
- [**development.md**](development.md) — the traps worth knowing before you
  touch the runtime.
