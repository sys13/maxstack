# The derived surface, verified against a running app

> The harness and the benchmark corpus that surround this probe live in the
> maintainer's own repository rather than here, because they are measurement
> machinery rather than part of the framework. The app probed below is one an
> ordinary reader can build from this tree with the commands shown; the drift
> guards named afterwards are not. This is the evidence page for the
> per-resource counts in [`harness-metrics.md`](../harness-metrics.md); see
> [measurement.md](../measurement.md) for what the numbers do and do not say.

## Why

The landing page publishes a leverage figure (artifacts derived per authored
declaration) whose runtime half was originally computed by counting *exported
handlers* in `maxstack-core`. Exported is not the same as reachable. This is the
record of probing a real running app to find out which it was.

**It was not.** The first published count was inflated by two REST operations per
entity. The numbers below are the corrected, probe-verified ones.

> **Superseded in part — see [Follow-up](#follow-up-2026-07-26-the-two-orphans-got-routes)
> at the end.** The two unreachable handlers this document found have since been
> wired to routes and re-probed, moving REST from 6 to 7. The original probe
> below is left as written, because an evidence file that quietly edits itself
> to match today's answer is not evidence.

## Method

Built the CLI from the workspace and drove a project end to end — no test
doubles, no in-memory `MemFs`:

```
maxstack init proofapp --desc "a proof app" --backend pglite
maxstack add-entity task --field title:text! --field done:bool --field priority:text --accept --gen
maxstack add-page task
maxstack gen
maxstack dev            # pglite on localhost:3000
```

Then probed every surface the page claims, with `curl` against the running
server.

## What a plain declared entity actually gets

### REST — 6 reachable operations (not 8)

| Operation | Request | Result |
| --- | --- | --- |
| list | `GET /api/task` | 200 |
| getMany | `GET /api/task?ids=<id>` | 200 |
| create | `POST /api/task` | 201, row returned with all declared fields |
| get | `GET /api/task/<id>` | 200 |
| update | `PATCH /api/task/<id>` | 200 |
| delete | `DELETE /api/task/<id>` | 200 |

`sprout/api.ts` exports **eight** handlers, but `countHandler` and
`restoreHandler` are wired to no route:

| Claimed but unreachable | Request | Result |
| --- | --- | --- |
| count | `GET /api/task/count` | **500** (parsed as an id) |
| restore | `POST /api/task/<id>/restore` | **404** |

`grep -rn "countHandler\|restoreHandler" apps/web/app` returns nothing. The
drift guard in the harness's first-build test now counts the handlers the two
API route modules actually import, and a second test asserts that core exports
strictly more than are reachable — so this specific mistake cannot silently
return.

### MCP — 5 tools per resource (as claimed)

`POST /mcp` `tools/list` returned 13 tools: 8 platform tools plus exactly
`list_task, get_task, create_task, update_task, delete_task`.

### Admin — 3 screens per entity (not 4)

| Screen | Path | Result |
| --- | --- | --- |
| list | `/admin/task` | 200 |
| new | `/admin/task/new` | 200 |
| detail/edit | `/admin/task/<id>` | 200, renders the row and all three declared field labels |
| trash | `/admin/task/trash` | **404** — route is registered but requires soft-delete |

The trash screen is not counted: a surface conditional on another feature is not
one the declaration buys by default.

**Corrected total: 11 REST+MCP operations and 3 screens per entity**, against a
previously published "13 per entity".

## Effect on the published figure

| Figure | Before (exports-counted) | After (probe-verified) |
| --- | --- | --- |
| `artifactsPerDeclaration` median | 7.7 | **7.2** |
| range across 11 benchmarks | 4.8–7.9 | **4.5–7.5** |
| REST + MCP per entity | 13 | **11** |

`leverage` (files-only floor) is unaffected at 4.4 — it never counted the
runtime half.

## Two other page claims, tested

**"Add a field and it's writable on the very next request — no restart."** Held.
With the dev server still running from before the fields existed:

```
maxstack add-field task dueOn:date
maxstack add-field task notes:text
```

`POST /api/task` with `dueOn` and `notes` returned 201 with both persisted, and
`create_task`'s MCP input schema listed all five fields — no restart, no
migration step.

**"Nothing it built yesterday breaks today."** Held. Ejected `routes/task.tsx`,
appended a hand-written `MY_MARKER` export, then landed two schema changes and
ran `maxstack gen` three times. The file was byte-identical before and after
(sha `88da3ed6…`), and the marker survived.

## Caveat

This is one app on one backend (pglite), exercising one entity. It verifies the
per-entity surface counts and the two invariants above; it is not a
multi-backend or multi-entity conformance suite.

## Follow-up (2026-07-26): the two orphans got routes

The finding above — two exported handlers reachable from nothing — is the kind
that has two possible fixes: cut the number, or build the thing. The number was
cut first, because that was the honest immediate move. This is the second half.

`countHandler` and `restoreHandler` are now wired
(`apps/web/app/routes/api.resource.count.tsx`,
`api.resource.$id.restore.tsx`), and re-probed against a running app the same
way — `curl` against `pnpm dev`, no test doubles.

### count — universal, so it counts

| Request | Result |
| --- | --- |
| `GET /api/project/count` (spec-declared entity) | 200 `{"count":1}` |
| `GET /api/project/count?search=a` | 200 — shares the list route's filter dialect |

Verified against the full lifecycle on a seeded resource: `{"count":2}` → create
→ `3` → delete → `2` → restore → `3`.

### restore — reachable, but *not* counted

| Request | Result |
| --- | --- |
| `POST /api/comment/<id>/restore` (soft-delete resource) | 200, row returned with `deletedAt: null` |
| `POST /api/project/<id>/restore` (plain declared entity) | **422** — "does not declare soft delete" |
| `GET /api/project/<id>/restore` | 405 JSON, not a framework error page |

The 422 is the point. `registerSpecEntities` never sets `softDelete`, so on a
plain declared entity restore is a route that can never succeed. It is therefore
excluded from the per-entity count under the same rule as the trash screen —
which means wiring two handlers moved the figure by **one**, not two. A test in the
harness asserts `from-spec.ts` still never sets `softDelete`, so if declared
entities ever gain soft delete, the constant is raised deliberately.

### The trash screen no longer 404s

`/admin/<resource>/trash` on a resource without soft delete returned 404, which
reads as a broken admin rather than an inapplicable feature. It now returns 200
with an explanation ("Deleting a row removes it immediately — declare
`softDelete` to get a recovery window"). It is still not counted: the rule is
about what the declaration buys, not about what returns 200.

### Effect on the published figure

| Figure | Probe #1 (this doc) | After the numerator fix | After wiring `count` |
| --- | --- | --- | --- |
| `artifactsPerDeclaration` median | 7.2 | 6.0 | **6.3** |
| range across 11 benchmarks | 4.5–7.5 | 3.9–6.2 | **4.2–6.5** |
| REST + MCP per entity | 11 | 11 | **12** |

The middle column is a separate correction, not part of this probe: the leverage
numerator was counting the agent-filled e2e suites as platform-derived output
(see `docs/harness-metrics.md` § Leverage). Both changes are in the published
figure now.

### Still not verified

Unchanged from the caveat above, and worth restating because the numbers moved:
one app, one backend (pglite), one entity, no bundles installed. In particular
the count may differ with `maxstack add auth`, which flips writes to
authenticated — this probe posted unauthenticated and got 201s.
