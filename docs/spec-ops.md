<!-- GENERATED FILE — DO NOT EDIT BY HAND.
     Source: `SPEC_OP_VOCABULARY` in `packages/spec/src/base/spec-ops.ts`
     Regenerate: pnpm docs:reference   (the validate gate checks this is current) -->

# Spec-op reference

The 69 typed operations that can change a project spec — the whole
vocabulary. Nothing else writes to the spec: the CLI sugar, the MCP tools, and
the workbench UI all compile down to these, which is what makes a change
reviewable, attributable, and replayable.

The same vocabulary is available **at runtime** to any agent, with these exact
arg schemas, via `query_spec {section:"ops", ops:[…]}` — see
[`mcp-reference.md`](mcp-reference.md). You should never have to guess an arg
shape.

## Applying one

```sh
# raw, from a file or inline
maxstack op --op '{"op":"data.addField","args":{...}}' --accept --gen

# or the sugar, which compiles to the same op
maxstack add-field task dueOn:date! --accept --gen
```

Ops are **additive** except the four setters (`page.setBlockOrder`,
`page.setBlockVariant`, `page.setBlockFields`, `theme.set`), which are
last-wins replacements, and `provenance.review`, which decides existing rows.

`provenance` is optional on every add-op and best **omitted** — the server
stamps the correct default. Supplying it partially is an error; it is all five
keys or nothing.

## The vocabulary

| Op | Layer | What it does |
| --- | --- | --- |
| [`prd.addRequirement`](#prdaddrequirement) | `product` | Add a requirement (optionally into a roadmap phase). |
| [`prd.addScopeItem`](#prdaddscopeitem) | `product` | Add a MoSCoW scope item. |
| [`prd.addRisk`](#prdaddrisk) | `product` | Add a risk. |
| [`prd.addMetric`](#prdaddmetric) | `product` | Add a supporting metric. |
| [`prd.recordDecision`](#prdrecorddecision) | `product` | Append a decision to the ledger. |
| [`data.addEntity`](#dataaddentity) | `data` | Add a data entity. |
| [`data.addField`](#dataaddfield) | `data` | Add a field to an entity. |
| [`data.setFieldReference`](#datasetfieldreference) | `data` | Declare that an existing string field is a foreign key to another entity. The one op that changes a shipped column’s type; the migration reconciles it behind a guard and fails loudly on a value that is not an id. |
| [`data.setFieldOpenReference`](#datasetfieldopenreference) | `data` | Declare that a string field holds an id of one of several entities, and that the PROJECT decides which (billing’s "subject" is a user in a per-seat app and an organization in a per-workspace one). Declares the ambiguity; data.setFieldReference resolves it and refuses anything off the list. Emits the same text column, so it is additive on an installed bundle. |
| [`data.setFieldLimits`](#datasetfieldlimits) | `data` | Set per-value row caps on an enum field — a Kanban WIP limit ({"doing": 3}). Enforced on every create/update (REST, MCP, forms and board drags alike), never only in the UI. Last-wins; {} clears every cap. |
| [`data.setFieldDisplay`](#datasetfielddisplay) | `data` | State how a NUMBER field is drawn and on what scale, instead of letting its NAME decide. A number called "rating" or "stars" otherwise renders as a 5-star widget and one called "duration" as 3m 20s. format wins over the name in both directions: "number" is the escape hatch that keeps a column called rating a plain number; "rating" promotes a column called score. min/max/step declare the scale (a rating out of 10, a 0–100 score). Presentation only — nothing here constrains what may be stored, and a value outside the range is displayed honestly rather than clamped. Last-wins; {} clears the declaration and returns the field to inference. |
| [`data.setFieldFilter`](#datasetfieldfilter) | `data` | Say whether a field is one of a list's FILTER CONTROLS and with which operators, instead of letting its TYPE decide. By default an enum filters as a dropdown, a reference as a record dropdown, a boolean as yes/no, a number or date as a >= / <= range pair, and a plain string not at all (it is searched by the search box instead). filterable:false takes a column out of the filter bar AND out of search — and REST refuses a filter on it too, so it means one thing everywhere. filterable:true gives a plain string an exact-match input. operators narrows the spellings: ["eq"] turns a range pair into one exact-match input, ["range"] drops equality. A NARROWING only — a page can be filtered by exactly the columns it renders, and this cannot reach past them. Last-wins; {} clears the declaration and returns the field to inference. |
| [`data.addComputed`](#dataaddcomputed) | `data` | Add a value computed from a row's own numeric fields (never stored; evaluated on read). |
| [`data.addRollup`](#dataaddrollup) | `data` | Add an aggregate over a related entity's rows. With groupBy it yields a series (chart/list); without, a scalar. |
| [`page.addPage`](#pageaddpage) | `page` | Add a page. |
| [`page.addBlock`](#pageaddblock) | `page` | Add a block to a page. |
| [`page.setBlockOrder`](#pagesetblockorder) | `page` | Set the row ordering of a list/table block (spec-as-data ranking, e.g. points desc). |
| [`page.setBlockVariant`](#pagesetblockvariant) | `page` | Set a list/table block’s presentation: table (default admin grid) \| cards (responsive card grid) \| feed (stacked title/description/date rows). A filled replace-mode slot on the same page supersedes sibling block presentation — it renders INSTEAD of this list, so on such a page this op changes the spec and nothing a user can see. |
| [`page.setBlockFields`](#pagesetblockfields) | `page` | Choose which entity fields a list/table block renders, in order (first = the title column). Overrides the zero-config column picks. |
| [`page.setBlockEditable`](#pagesetblockeditable) | `page` | Name the fields a list/table block edits IN PLACE — click a cell, type, done, no trip to the form. The cell submits to the record’s own edit route, so an inline edit runs the same validation, permission check, value limits and audit entry as the form; the list gets no write path of its own. References, files, json and rank keys are refused — a cell editor cannot represent them. Last-wins; pass [] to make the list read-only again. |
| [`page.setBlockCreatable`](#pagesetblockcreatable) | `page` | Name the fields a NEW ROW added from the list collects — type across the bottom row, hit Add, no trip to the New form. The row posts to the resource’s own create route, so it runs the same validation, permission check, value limits and audit entry as the form; the list gets no write path of its own. Stricter than setBlockEditable in one way: every REQUIRED field of the entity must be named, or the create could never succeed and the op is refused. References, files, json and rank keys are refused — a row form cannot collect them. Last-wins; pass [] to take the affordance away again. |
| [`page.setE2ETests`](#pagesete2etests) | `page` | Set a page’s natural-language e2e tests — one sentence per behaviour. `run_generator e2e-tests` scaffolds a Playwright spec per sentence and `run_checks` runs them, which is the cheap verification path. |
| [`page.addCalendar`](#pageaddcalendar) | `page` | Add a calendar block: the page’s rows arranged by one of its date fields, as a month grid, a week grid, or a density heatmap. |
| [`page.addTimeline`](#pageaddtimeline) | `page` | Add a timeline (Gantt) block: the page’s rows as bars across a start/end date range, with optional dependency arrows from a self-referencing field. |
| [`page.addBoard`](#pageaddboard) | `page` | Add a Kanban board block: the page’s rows as cards in columns grouped by one of its enum fields, moved between columns by drag or keyboard. WIP limits are declared on the field (data.setFieldLimits), not here. |
| [`page.addAggregate`](#pageaddaggregate) | `page` | Add an aggregate block: a GROUP BY over the page’s rows — count by enum, sum/avg of a number by a dimension, count per month — drawn as bars or a table. This is what a dashboard tile is; data.addRollup is the per-row number instead. |
| [`pricing.addTier`](#pricingaddtier) | `pricing` | Add a pricing tier. |
| [`theme.set`](#themeset) | `theme` | Set the app’s visual theme: a curated preset (zinc \| ocean \| forest \| sunset \| mono \| rose \| amber) plus optional accent (#hex), radius (sm\|md\|lg\|full), density (comfortable\|compact), font (sans\|serif\|mono\|rounded\|humanist), typeScale (compact\|default\|relaxed). Last-wins — replaces the whole theme. |
| [`site.set`](#siteset) | `site` | Set the app’s public identity: domain (origin only — scheme + host, no path, no trailing slash, never localhost), name, plus optional tagline, description, social handles and defaultOgImage. Every canonical, OG card and sitemap entry is built against domain. Last-wins — replaces the whole declaration, so an omitted optional key is cleared. |
| [`flags.declare`](#flagsdeclare) | `flags` | Declare a feature flag: a key, a default, and optional targeting (roles \| organizations \| rolloutPercent). Evaluated server-side per viewer; generation never reads a flag’s value. |
| [`flags.setTargeting`](#flagssettargeting) | `flags` | Replace a flag’s targeting wholesale (last-wins). Omit `targeting` to clear it and return the flag to its bare default — this is how a rollout is ramped, paused, or completed. |
| [`flags.gate`](#flagsgate) | `flags` | Gate a page or block on a declared flag, or ungate it with flag:null. A gated surface is composed only for viewers the flag is on for; the generated code is identical either way. |
| [`flags.remove`](#flagsremove) | `flags` | Remove a flag declaration. Refused while any page or block still gates on it — ungate those surfaces first. This is the cleanup half of the flag lifecycle; a flag system without it accumulates dead flags forever. |
| [`schedules.declare`](#schedulesdeclare) | `schedules` | Declare a schedule: a named recurrence, the IANA timezone it is read in, and the identity its runs carry. Delivery is at-least-once — the handler gets an idempotency key and must tolerate a repeat. |
| [`schedules.setRecurrence`](#schedulessetrecurrence) | `schedules` | Replace a schedule’s recurrence wholesale (last-wins), optionally moving its timezone with it. This is how a run is moved, slowed down, or re-anchored. |
| [`schedules.pause`](#schedulespause) | `schedules` | Stop or resume a schedule, keeping its declaration and its run history. The 3am operation: the reason to stop a job is usually that something downstream is wrong, and deleting the declaration also deletes what you need to turn it back on. |
| [`schedules.remove`](#schedulesremove) | `schedules` | Remove a schedule declaration. Refused while it is still active — pause it first, so removal is always deliberate rather than the fastest way to silence a page. |
| [`sources.declare`](#sourcesdeclare) | `sources` | Declare an external data source: an endpoint, the credential it uses BY NAME, a typed mapping from the response onto entity fields, and the request budget it may spend. Two refusals are absolute — a credential anywhere in the declaration, and an endpoint the runtime must not reach. Generation never fetches; only the running app does. |
| [`sources.setMapping`](#sourcessetmapping) | `sources` | Replace a source’s response mapping wholesale (last-wins). The edit a third party forces when it renames a field in its response — which is the most common reason to touch a source at all. |
| [`sources.setLimits`](#sourcessetlimits) | `sources` | Replace a source’s rate limit and retry budget wholesale (last-wins). Separate from the mapping because "we are being rate-limited, slow down" is a different conversation from "these fields moved". |
| [`sources.pause`](#sourcespause) | `sources` | Stop or resume a source, keeping its declaration and its run history. The 3am operation: the reason to stop an integration is usually that the other end is misbehaving, and deleting the declaration also deletes what you need to turn it back on. |
| [`sources.remove`](#sourcesremove) | `sources` | Remove a source declaration. Refused while it is still active — pause it first, so removal is always deliberate rather than the fastest way to silence a failing integration. |
| [`search.declare`](#searchdeclare) | `search` | Declare a ranked full-text index over one entity: which fields are searchable, how much each counts toward the rank, which language stems them, and whether the physical index exists. Ranked search then works in admin, over REST and over MCP, filtered by the same read rules a list query passes. |
| [`search.setFields`](#searchsetfields) | `search` | Replace an index’s field list and weights wholesale, last-wins. The edit you make when a new field should be searchable, or when the top result for a common query is obviously wrong — which is always a change to the relative weights, never to one of them alone. |
| [`search.setIndexing`](#searchsetindexing) | `search` | Create or drop the physical index, leaving the declaration alone. The cost lever an operator reaches for under load. It changes no answer — search still runs over the same expression with the same ranking, as a sequential scan — and it is reversible in one additive statement, because an expression index stores nothing that is not derivable from the columns it reads. |
| [`search.remove`](#searchremove) | `search` | Remove a search index declaration. Refused while the physical index still exists — set indexed:false first, because the DDL is emitted from the declaration and removing it first would strand a real index on a real table with nothing left in the spec that knows its name. |
| [`documents.declare`](#documentsdeclare) | `documents` | Declare a document template over one entity: the sections it prints, the paper it is laid out for, and where a rendered copy goes. Renders to print-ready HTML and to PDF from one compiled layout — no headless browser — and rendering is a read of the row, through the same gate a GET passes. |
| [`documents.setSections`](#documentssetsections) | `documents` | Replace a template’s sections wholesale, last-wins. Wholesale because the sections are only correct relative to each other — "move the totals above the line items" is not an edit to either one. |
| [`documents.setDelivery`](#documentssetdelivery) | `documents` | Change where a rendered document goes, leaving the layout alone. Its own op because this is the outward-facing half: turning email on starts sending mail to customers, and turning every target off is how a template is retired. |
| [`documents.remove`](#documentsremove) | `documents` | Remove a document template declaration. Refused while any delivery target is still on — the URL and the object path are emitted from the declaration, so removing it first turns a bookmarked link into a 404 and an archive write into an error. Retire it with documents.setDelivery first. |
| [`imports.declare`](#importsdeclare) | `imports` | Declare an importer over one entity: the file format, the column-to-field mapping, the upsert key that decides whether existing rows can be overwritten, and the row ceiling. Running it is ALWAYS two steps — a dry-run reporting exactly what would change, then an explicit apply — and that is structural rather than a policy: the apply function takes a plan and there is no overload that takes bytes. |
| [`imports.setMapping`](#importssetmapping) | `imports` | Replace an importer’s column mapping wholesale, last-wins. The edit a partner forces when their export gains a column or renames two — which is one edit to one mapping rather than three patches, because a mapping is only correct relative to the whole file’s shape. |
| [`imports.setUpsertKey`](#importssetupsertkey) | `imports` | Change whether — and on what — this importer may OVERWRITE rows that already exist. Its own op precisely so a reviewer can answer "can this destroy data?" from the op name, before reading a single argument. null makes it insert-only; a field id makes matching rows update in place. Nothing else in the vocabulary changes that answer, and this op changes nothing else. |
| [`imports.pause`](#importspause) | `imports` | Stop or resume an importer, keeping its declaration, its mapping and its parser file. The operational lever: the reason to stop an importer is usually that a partner’s export changed shape, and deleting the declaration to stop it also deletes the mapping you need to fix it. Pausing is also the retire step before imports.remove. |
| [`imports.remove`](#importsremove) | `imports` | Remove an importer declaration. Refused while it is not paused — pause it first, so removal is never the fastest way to silence something somebody is mid-way through using. |
| [`portals.declare`](#portalsdeclare) | `portals` | Declare a PUBLIC, token-scoped or role-scoped surface over one entity: who is on the other side, which rows they may reach, EXACTLY which fields they may read, and which writes (if any) they may perform under which hourly budget. This is the highest-consequence op in the vocabulary — every other op changes what the app does for people already inside it; this one decides what somebody who has never signed in can read. Enforcement lives in the permission layer and the read/write ops, never in a route. |
| [`portals.setFields`](#portalssetfields) | `portals` | Replace a portal’s field projection wholesale, last-wins — THE EXPOSURE EDIT. Its own op so that "what can the outside see?" is answerable from the op name, before reading a single argument, and so a diff that widens a public surface never arrives disguised as a general-purpose edit. |
| [`portals.setWrites`](#portalssetwrites) | `portals` | Replace a portal’s write surface wholesale, last-wins. Separate from portals.setFields because turning on an anonymous create is a different decision from showing one more column, and the two should not share a diff line. |
| [`portals.pause`](#portalspause) | `portals` | Take a portal offline, or put it back. The op somebody runs at 3am: it requires removing nothing, so the declaration, the projection and every minted token survive and bringing the surface back is one op rather than a re-review. Also the retire step portals.remove insists on first. |
| [`portals.remove`](#portalsremove) | `portals` | Remove a portal declaration. Refused while it is not paused — pause it first, so removal is never the fastest way to silence something somebody is mid-way through using, and so the thing that stopped the exposure is the thing that is easy to undo. |
| [`live.declare`](#livedeclare) | `live` | Declare a LIVE channel over one entity: whether subscribers receive changed rows or the identities of who is viewing a record, bounded to which rows, carrying exactly which columns, under an explicit subscriber ceiling and per-subscriber message rate. The scope line is deliberately narrow — we push changes and we report presence. There is no event kind, no caller-composed payload and no cursor channel: every message exists because a ROW CHANGED, which is what makes it authorizable per message as a read of that row. Conflict resolution beyond last-write-wins is out by recorded decision (d-live-last-write-wins), not by omission. At most one "query" and one "presence" channel per entity. |
| [`live.setFields`](#livesetfields) | `live` | Replace a live channel’s pushed columns wholesale, last-wins — THE PAYLOAD EDIT. Its own op so that "what does a subscriber actually receive?" is answerable from the op name, before reading a single argument: a push is a read, and what it carries is its own review. |
| [`live.setLimits`](#livesetlimits) | `live` | Replace a live channel’s two ceilings — THE LOAD LEVER, the op an operator reaches for when a channel is the reason the app is slow. Separate from live.setFields because "we are sending too much" and "we are sending the wrong thing" are different problems found by different people. Both values are restated together rather than patched individually: they multiply into the load the process actually carries, and adjusting one without the other is how the product of the two stops being something anybody reviewed. |
| [`live.pause`](#livepause) | `live` | Take a live channel offline, or put it back. The 3am lever: it removes nothing, so the declaration, the projection and both ceilings survive and bringing the channel back is one op rather than a re-review. Safe to pull because subscribers fall back to polling the ordinary list endpoint — a paused channel makes the app slower, not broken. Also the retire step live.remove insists on first. |
| [`live.remove`](#liveremove) | `live` | Remove a live declaration. Refused while it is not paused — pause it first, confirm the polling fallback carried the surface, then remove, so removal is never the fastest way to silence something somebody is mid-way through using. |
| [`view.addAction`](#viewaddaction) | `view` | Declare a LIST ACTION over one entity: a named, capped, role-gated write a user runs from a list — on one row, on a ticked selection, or both. THE ONE OP IN THE VOCABULARY THAT LETS ONE CLICK WRITE TO MANY ROWS. It is declared on the entity rather than on a page for the reason a WIP limit lives on the field rather than on the board: a rule the screen enforces is one an agent driving REST or MCP walks straight past, so the endpoint, the MCP tool and the toolbar are three doors onto one server operation. The selection is the ids the caller sent — there is deliberately no "everything matching the current filter" spelling. Every row is written through the ordinary update path, so tenant scope, per-value limits, validation, the row audit entry and the live publish all apply unchanged and cannot drift. No delete, no create, no side effect: those are different primitives and an action whose declaration does not say what it does is worse than no action. |
| [`view.setActionEffect`](#viewsetactioneffect) | `view` | Replace a list action’s write wholesale, last-wins — THE PAYLOAD EDIT. Its own op so that "what does this button actually do to a row?" is answerable from the op name, before reading a single argument. Wholesale rather than patched: a write set is only correct as a whole, and a patch language would let one be half-migrated between two reviews — which for a write means a button that sets the new status and leaves the old assignee. |
| [`view.removeAction`](#viewremoveaction) | `view` | Remove a list action. Unlike portals.remove and live.remove there is no pause step first, and the asymmetry is deliberate: a portal and a live channel are surfaces somebody may be mid-way through using, so removal must not be the fastest way to silence one. An action is a button — removing it takes a capability away, which fails closed, so a two-step ritual would buy nothing and would leave the dangerous declaration in place for the length of it. |
| [`provenance.review`](#provenancereview) | `system` | Accept or reject a suggestion, or reset a settled row back to undecided (a provenance transition, logged for audit — reject is a soft-reject, never a delete, and reset is the undo for an accepted batch). With cascade:true the decision also covers the target’s still-undecided nested rows (fields/blocks); a cascading reset instead covers its settled ones, since those are what an undo has to take back. Never touches a manual row. |

## Layer: product

### `prd.addRequirement`

Add a requirement (optionally into a roadmap phase).

**Arguments**

- `requirement` — `object` · **required**
  - `id` — `string` · **required** · branded id, prefix "r-".
  - `userStory` — `string` · **required**
  - `acceptanceCriteria` — `array` · **required**
  - `priority` — `string` · **required** · one of `P0`, `P1`, `P2`, `P3`
  - `edgeCasesAndErrorStates` — `array` · **required**
  - `priorityRationale` — `object`
    - `reasoning` — `string` · **required**
    - `heuristicApplied` — `string`
  - `estimate` — `object` · confidence is 0–1.
    - `effort` — `number` · **required**
    - `impact` — `number` · **required**
    - `confidence` — `number` · **required**
  - `servesMetricIds` — `array`
  - `interactionsWithExisting` — `array`
  - `enhancesRequirementIds` — `array`
  - `ownerId` — `string` · stakeholder id, prefix "sh-".
- `intoPhaseId` — `string` · optional roadmap phase id (prefix "p-") to slot it into.

### `prd.addScopeItem`

Add a MoSCoW scope item.

**Arguments**

- `bucket` — `string` · **required** · one of `mustHave`, `shouldHave`, `couldHave`, `wontHave`
- `item` — `object` · **required**
  - `id` — `string` · **required** · branded id, prefix "s-".
  - `description` — `string` · **required**
  - `rationale` — `object`
    - `reasoning` — `string` · **required**
    - `heuristicApplied` — `string`
  - `realizedByRequirementId` — `string` · requirement id, prefix "r-".

### `prd.addRisk`

Add a risk.

**Arguments**

- `risk` — `object` · **required**
  - `id` — `string` · **required** · branded id, prefix "rk-".
  - `description` — `string` · **required**
  - `type` — `string` · **required** · one of `technical_risk`, `market_risk`, `dependency_risk`, `operational_risk`
  - `likelihood` — `number` · **required** · 0–1.
  - `impact` — `number` · **required** · 0–1.
  - `mitigation` — `string` · **required**
  - `threatensAssumptionIds` — `array`
  - `validatedByActivityId` — `string` · activity id, prefix "a-".
  - `ownerId` — `string` · stakeholder id, prefix "sh-".

### `prd.addMetric`

Add a supporting metric.

**Arguments**

- `metric` — `object` · **required**
  - `id` — `string` · **required** · branded id, prefix "m-".
  - `name` — `string` · **required**
  - `definition` — `string` · **required**
  - `baseline` — `number` · where we are today; may be 0.
  - `target` — `string`
  - `timeframe` — `string`
  - `measuredByEventIds` — `array`
  - `ownerId` — `string` · stakeholder id, prefix "sh-".

### `prd.recordDecision`

Append a decision to the ledger.

**Arguments**

- `entry` — `object` · **required**
  - `id` — `string` · **required** · branded id, prefix "d-".
  - `question` — `string` · **required**
  - `options` — `array` · **required**
    each item:
    - `id` — `string` · **required**
    - `description` — `string` · **required**
    - `pros` — `array` · **required**
    - `cons` — `array` · **required**
  - `chosenOptionId` — `string | null` · **required** · null while pending; else must match an option id.
  - `rationale` — `string` · **required**
  - `status` — `string` · **required** · one of `pending`, `resolved`
  - `decidedAt` — `string | null` · **required** · YYYY-MM-DD; null while pending.
  - `origin` — `string` · **required** · one of `ai`, `human`
  - `recordedAt` — `string` · **required** · YYYY-MM-DD.
  - `recommendedOptionId` — `string` · must be one of options[].id.

## Layer: data

### `data.addEntity`

Add a data entity.

**Arguments**

- `entity` — `object` · **required**
  - `id` — `string` · **required** · branded id, prefix "e-".
  - `name` — `string` · **required**
  - `description` — `string`
  - `fields` — `array` · **required**
    each item:
    - `id` — `string` · **required** · branded id, prefix "fld-".
    - `name` — `string` · **required**
    - `type` — `string` · **required** · one of `string`, `number`, `boolean`, `date`, `enum`, `json`, `file` · one of the seven canonical types; "text" is CLI sugar and is rejected in a raw op (use "string"). "file" stores a storage key and requires the "file" block below. "date" is a timestamp WITHOUT time zone — a wall clock, not an instant; it reads back as "2026-03-08 09:00:00" and re-zoning such a value moves it by the offset. The generated API says the same thing from the other side: it takes the wall clock as written and DISCARDS a trailing "Z" or "+HH:MM" rather than shifting the value.
    - `required` — `boolean` · **required**
    - `reference` — `string` · target entity id (e-…) for a belongs-to FK; the virtual "e-user" grounds to the auth user table.
    - `options` — `array` · enum options for type:"enum" — bare strings like ["book","article"] are canonicalized to {label,value}.
      each item: `string` or `object`
    - `file` — `object` · required for type:"file", rejected on every other type. The column stores a storage key; the runtime re-signs it into a short-lived URL on read.
      - `accept` — `array` · **required** · MIME allowlist, e.g. ["image/png","image/jpeg"] or ["image/*"]. Non-empty; a bare "*" wildcard is rejected.
      - `maxSizeBytes` — `number` · **required** · hard per-file cap in bytes, enforced server-side (max 104857600).
      - `derivatives` — `array` · image variants materialized at upload, addressable as "<key>@<name>". Image-only allowlists.
        each item:
        - `name` — `string` · **required** · lowercase slug, e.g. "thumb".
        - `width` — `number` · **required**
        - `height` — `number`
        - `fit` — `string` · one of `cover`, `contain`
    - `rank` — `boolean` · type:"string" only — marks the field a manual-ordering key: never null (database default), hidden and read-only in forms, and the column a board orders cards by.
    - `limits` — `object` · type:"enum" only — per-value row caps ({"doing":3} = a WIP limit of 3). Enforced on every create/update, not just in the UI. Keys must be declared option values.
    - `provenance` — `object` · OPTIONAL — best OMITTED; the server stamps the correct default (accepted). If supplied it must be the full 5-key object.
      - `isSuggested` — `boolean` · **required**
      - `isAccepted` — `boolean | null` · **required** · null = undecided.
      - `isAddedManually` — `boolean | null` · **required**
      - `suggestedDescription` — `string | null` · **required**
      - `priority` — `string` · **required** · one of `medium`, `high`
  - `provenance` — `object` · OPTIONAL — best OMITTED; the server stamps the correct default (accepted). If supplied it must be the full 5-key object.
    - `isSuggested` — `boolean` · **required**
    - `isAccepted` — `boolean | null` · **required** · null = undecided.
    - `isAddedManually` — `boolean | null` · **required**
    - `suggestedDescription` — `string | null` · **required**
    - `priority` — `string` · **required** · one of `medium`, `high`

### `data.addField`

Add a field to an entity.

**Arguments**

- `entityId` — `string` · **required** · target entity id, prefix "e-".
- `field` — `object` · **required**
  - `id` — `string` · **required** · branded id, prefix "fld-".
  - `name` — `string` · **required**
  - `type` — `string` · **required** · one of `string`, `number`, `boolean`, `date`, `enum`, `json`, `file` · one of the seven canonical types; "text" is CLI sugar and is rejected in a raw op (use "string"). "file" stores a storage key and requires the "file" block below. "date" is a timestamp WITHOUT time zone — a wall clock, not an instant; it reads back as "2026-03-08 09:00:00" and re-zoning such a value moves it by the offset. The generated API says the same thing from the other side: it takes the wall clock as written and DISCARDS a trailing "Z" or "+HH:MM" rather than shifting the value.
  - `required` — `boolean` · **required**
  - `reference` — `string` · target entity id (e-…) for a belongs-to FK; the virtual "e-user" grounds to the auth user table.
  - `options` — `array` · enum options for type:"enum" — bare strings like ["book","article"] are canonicalized to {label,value}.
    each item: `string` or `object`
  - `file` — `object` · required for type:"file", rejected on every other type. The column stores a storage key; the runtime re-signs it into a short-lived URL on read.
    - `accept` — `array` · **required** · MIME allowlist, e.g. ["image/png","image/jpeg"] or ["image/*"]. Non-empty; a bare "*" wildcard is rejected.
    - `maxSizeBytes` — `number` · **required** · hard per-file cap in bytes, enforced server-side (max 104857600).
    - `derivatives` — `array` · image variants materialized at upload, addressable as "<key>@<name>". Image-only allowlists.
      each item:
      - `name` — `string` · **required** · lowercase slug, e.g. "thumb".
      - `width` — `number` · **required**
      - `height` — `number`
      - `fit` — `string` · one of `cover`, `contain`
  - `rank` — `boolean` · type:"string" only — marks the field a manual-ordering key: never null (database default), hidden and read-only in forms, and the column a board orders cards by.
  - `limits` — `object` · type:"enum" only — per-value row caps ({"doing":3} = a WIP limit of 3). Enforced on every create/update, not just in the UI. Keys must be declared option values.
  - `provenance` — `object` · OPTIONAL — best OMITTED; the server stamps the correct default (accepted). If supplied it must be the full 5-key object.
    - `isSuggested` — `boolean` · **required**
    - `isAccepted` — `boolean | null` · **required** · null = undecided.
    - `isAddedManually` — `boolean | null` · **required**
    - `suggestedDescription` — `string | null` · **required**
    - `priority` — `string` · **required** · one of `medium`, `high`

### `data.setFieldReference`

Declare that an existing string field is a foreign key to another entity. The one op that changes a shipped column’s type; the migration reconciles it behind a guard and fails loudly on a value that is not an id.

**Arguments**

- `entityId` — `string` · **required** · entity that owns the field, prefix "e-".
- `fieldId` — `string` · **required** · the field to declare, prefix "fld-". Must be a string/enum field that does not already reference something.
- `reference` — `string` · **required** · the entity the field points at, prefix "e-" (a spec entity, or a virtual one such as the auth user).

### `data.setFieldOpenReference`

Declare that a string field holds an id of one of several entities, and that the PROJECT decides which (billing’s "subject" is a user in a per-seat app and an organization in a per-workspace one). Declares the ambiguity; data.setFieldReference resolves it and refuses anything off the list. Emits the same text column, so it is additive on an installed bundle.

**Arguments**

- `entityId` — `string` · **required** · entity that owns the field, prefix "e-".
- `fieldId` — `string` · **required** · the field to open, prefix "fld-". Must be a string/enum field that does not already reference something.
- `candidates` — `array` · **required** · the entities this field could point at, prefix "e-". Two or more — one candidate is a reference, not an ambiguity.

### `data.setFieldLimits`

Set per-value row caps on an enum field — a Kanban WIP limit ({"doing": 3}). Enforced on every create/update (REST, MCP, forms and board drags alike), never only in the UI. Last-wins; {} clears every cap.

**Arguments**

- `entityId` — `string` · **required** · entity that owns the field, prefix "e-".
- `fieldId` — `string` · **required** · the enum field to cap, prefix "fld-". It must carry declared options.
- `limits` — `object` · **required** · map of option VALUE -> cap, e.g. {"doing": 3}. Each cap is a positive integer ≤ 10000. An option with no entry is uncapped. Pass {} to clear.

### `data.setFieldDisplay`

State how a NUMBER field is drawn and on what scale, instead of letting its NAME decide. A number called "rating" or "stars" otherwise renders as a 5-star widget and one called "duration" as 3m 20s. format wins over the name in both directions: "number" is the escape hatch that keeps a column called rating a plain number; "rating" promotes a column called score. min/max/step declare the scale (a rating out of 10, a 0–100 score). Presentation only — nothing here constrains what may be stored, and a value outside the range is displayed honestly rather than clamped. Last-wins; {} clears the declaration and returns the field to inference.

**Arguments**

- `entityId` — `string` · **required** · entity that owns the field, prefix "e-".
- `fieldId` — `string` · **required** · the number field to present, prefix "fld-". Refused on any other field type.
- `display` — `object` · **required**
  - `format` — `string` · one of `number`, `grouped`, `percent`, `currency`, `rating`, `slider`, `duration` · "number" (plain — the escape hatch from the name heuristic), "grouped", "percent", "currency", "rating" (stars, out of max), "slider" (range over min/max/step), "duration" (seconds, read as 1h 2m 3s).
  - `min` — `number` · low end of the scale.
  - `max` — `number` · high end of the scale — the star count for a rating (default 5 when unstated).
  - `step` — `number` · granularity of the scale; must be positive.

### `data.setFieldFilter`

Say whether a field is one of a list's FILTER CONTROLS and with which operators, instead of letting its TYPE decide. By default an enum filters as a dropdown, a reference as a record dropdown, a boolean as yes/no, a number or date as a >= / <= range pair, and a plain string not at all (it is searched by the search box instead). filterable:false takes a column out of the filter bar AND out of search — and REST refuses a filter on it too, so it means one thing everywhere. filterable:true gives a plain string an exact-match input. operators narrows the spellings: ["eq"] turns a range pair into one exact-match input, ["range"] drops equality. A NARROWING only — a page can be filtered by exactly the columns it renders, and this cannot reach past them. Last-wins; {} clears the declaration and returns the field to inference.

**Arguments**

- `entityId` — `string` · **required** · entity that owns the field, prefix "e-".
- `fieldId` — `string` · **required** · the field to declare a filter control for, prefix "fld-".
- `filter` — `object` · **required**
  - `filterable` — `boolean` · false = not a filter control and not searched; true = force a control onto a column the type gives none. Omit to derive from the type.
  - `operators` — `array` · "eq" (one exact value) and/or "range" (inclusive >= / <= bounds). Non-empty; "range" is refused on anything but a number or date field. Omit to derive from the type.

### `data.addComputed`

Add a value computed from a row's own numeric fields (never stored; evaluated on read).

**Arguments**

- `entityId` — `string` · **required** · target entity id, prefix "e-".
- `computed` — `object` · **required**
  - `id` — `string` · **required** · branded id, prefix "drv-".
  - `name` — `string` · **required** · accessor name; must not collide with a field or another derived value.
  - `expr` — `object` · **required** · Closed arithmetic AST over the row's own NUMBER fields — no strings, no parsing, no eval. One of {kind:"field",field:"fld-…"} · {kind:"literal",value:<number>} · {kind:"binary",op:"+|-|*|/",left:<node>,right:<node>}, where each operand is itself a node of the same three shapes (nesting up to 16 deep). e.g. estimated 1RM = weight * (1 + reps/30) is {kind:"binary",op:"*",left:{kind:"field",field:"fld-weight"},right:{kind:"binary",op:"+",left:{kind:"literal",value:1},right:{kind:"binary",op:"/",left:{kind:"field",field:"fld-reps"},right:{kind:"literal",value:30}}}}.
    - `kind` — `string` · **required** · one of `field`, `literal`, `binary`
    - `field` — `string` · kind:"field" — a number field id.
    - `value` — `number` · kind:"literal" — a finite number.
    - `op` — `string` · one of `+`, `-`, `*`, `/`
    - `left` — `object` · kind:"binary" — the left operand, itself an expression node.
    - `right` — `object` · kind:"binary" — the right operand, itself an expression node.
  - `provenance` — `object` · OPTIONAL — best OMITTED; the server stamps the correct default (accepted). If supplied it must be the full 5-key object.
    - `isSuggested` — `boolean` · **required**
    - `isAccepted` — `boolean | null` · **required** · null = undecided.
    - `isAddedManually` — `boolean | null` · **required**
    - `suggestedDescription` — `string | null` · **required**
    - `priority` — `string` · **required** · one of `medium`, `high`

### `data.addRollup`

Add an aggregate over a related entity's rows. With groupBy it yields a series (chart/list); without, a scalar.

**Arguments**

- `entityId` — `string` · **required** · entity the rollup is exposed on, prefix "e-".
- `rollup` — `object` · **required**
  - `id` — `string` · **required** · branded id, prefix "drv-".
  - `name` — `string` · **required** · accessor name; must not collide with a field or another derived value.
  - `over` — `string` · **required** · entity whose rows are aggregated (the "many" side), prefix "e-".
  - `via` — `any` · path of reference fields from `over` up to `entityId`: a single "fld-…" for the common one-hop case, or an array of up to 3 for a multi-hop path (each element an FK on the previous hop's target). Set = per-row; omit = table-wide.
  - `fn` — `string` · **required** · one of `count`, `countDistinct`, `sum`, `avg`, `min`, `max`
  - `field` — `string` · value on `over` to aggregate. Required for every fn but "count". A stored field ("fld-…") or a computed field ("drv-…") — never another rollup, which is what keeps the derived graph acyclic.
  - `where` — `array` · equality constraints on `over`'s fields (AND-ed).
    each item:
    - `field` — `string` · **required**
    - `equals` — `any` · **required**
  - `groupBy` — `object` · group the aggregate into a series. With `bucket`, the key is a truncated date (a time series).
    - `field` — `string` · **required**
    - `bucket` — `string` · one of `day`, `week`, `month`, `quarter`, `year`
  - `limit` — `number` · max groups returned; REQUIRED when groupBy is set (the cost bound). Cap 1000.
  - `provenance` — `object` · OPTIONAL — best OMITTED; the server stamps the correct default (accepted). If supplied it must be the full 5-key object.
    - `isSuggested` — `boolean` · **required**
    - `isAccepted` — `boolean | null` · **required** · null = undecided.
    - `isAddedManually` — `boolean | null` · **required**
    - `suggestedDescription` — `string | null` · **required**
    - `priority` — `string` · **required** · one of `medium`, `high`

## Layer: page

### `page.addPage`

Add a page.

**Arguments**

- `page` — `object` · **required**
  - `id` — `string` · **required** · branded id, prefix "pg-".
  - `name` — `string` · **required**
  - `route` — `string` · **required** · the page's URL, leading slash, e.g. "/invoices". May be more than one segment ("/app/invoices"). Use "/" for the app's main surface — a page declared at "/" is served as the app's root, and an app whose primary surface lives there reads as an app rather than as an index of pages. Without one, "/" is a generated list of links to the pages below it.
  - `blocks` — `array` · **required**
    each item:
    - `id` — `string` · **required** · branded id, prefix "blk-".
    - `type` — `string` · **required** · a template-registry key: "table", "form", "hero", "slot:<name>", …
    - `variant` — `string` · one of `table`, `cards`, `feed` · presentation for list/table blocks.
    - `order` — `object`
      - `field` — `string` · **required** · a field on the page’s backing entity, e.g. "points".
      - `direction` — `string` · one of `asc`, `desc` · defaults to "asc".
    - `mode` — `string` · one of `append`, `replace` · only meaningful on slot:<name> blocks.
    - `provenance` — `object` · OPTIONAL — best OMITTED; the server stamps the correct default (accepted). If supplied it must be the full 5-key object.
      - `isSuggested` — `boolean` · **required**
      - `isAccepted` — `boolean | null` · **required** · null = undecided.
      - `isAddedManually` — `boolean | null` · **required**
      - `suggestedDescription` — `string | null` · **required**
      - `priority` — `string` · **required** · one of `medium`, `high`
  - `entityId` — `string` · backing entity id (prefix "e-") for a CRUD page.
  - `e2eTests` — `array` · natural-language e2e test descriptions.
  - `provenance` — `object` · OPTIONAL — best OMITTED; the server stamps the correct default (accepted). If supplied it must be the full 5-key object.
    - `isSuggested` — `boolean` · **required**
    - `isAccepted` — `boolean | null` · **required** · null = undecided.
    - `isAddedManually` — `boolean | null` · **required**
    - `suggestedDescription` — `string | null` · **required**
    - `priority` — `string` · **required** · one of `medium`, `high`

### `page.addBlock`

Add a block to a page.

**Arguments**

- `pageId` — `string` · **required** · target page id, prefix "pg-".
- `block` — `object` · **required**
  - `id` — `string` · **required** · branded id, prefix "blk-".
  - `type` — `string` · **required** · a template-registry key: "table", "form", "hero", "slot:<name>", …
  - `variant` — `string` · one of `table`, `cards`, `feed` · presentation for list/table blocks.
  - `order` — `object`
    - `field` — `string` · **required** · a field on the page’s backing entity, e.g. "points".
    - `direction` — `string` · one of `asc`, `desc` · defaults to "asc".
  - `mode` — `string` · one of `append`, `replace` · only meaningful on slot:<name> blocks.
  - `provenance` — `object` · OPTIONAL — best OMITTED; the server stamps the correct default (accepted). If supplied it must be the full 5-key object.
    - `isSuggested` — `boolean` · **required**
    - `isAccepted` — `boolean | null` · **required** · null = undecided.
    - `isAddedManually` — `boolean | null` · **required**
    - `suggestedDescription` — `string | null` · **required**
    - `priority` — `string` · **required** · one of `medium`, `high`

### `page.setBlockOrder`

Set the row ordering of a list/table block (spec-as-data ranking, e.g. points desc).

**Arguments**

- `pageId` — `string` · **required** · page id, prefix "pg-".
- `blockId` — `string` · **required** · block id, prefix "blk-".
- `order` — `object` · **required**
  - `field` — `string` · **required** · a field on the page’s backing entity, e.g. "points".
  - `direction` — `string` · one of `asc`, `desc` · defaults to "asc".

### `page.setBlockVariant`

Set a list/table block’s presentation: table (default admin grid) | cards (responsive card grid) | feed (stacked title/description/date rows). A filled replace-mode slot on the same page supersedes sibling block presentation — it renders INSTEAD of this list, so on such a page this op changes the spec and nothing a user can see.

**Arguments**

- `pageId` — `string` · **required** · page id, prefix "pg-".
- `blockId` — `string` · **required** · block id, prefix "blk-".
- `variant` — `string` · **required** · one of `table`, `cards`, `feed`

### `page.setBlockFields`

Choose which entity fields a list/table block renders, in order (first = the title column). Overrides the zero-config column picks.

**Arguments**

- `pageId` — `string` · **required** · page id, prefix "pg-".
- `blockId` — `string` · **required** · block id, prefix "blk-".
- `fields` — `array` · **required** · entity FIELD NAMES (not ids), in render order; the first is the title column.

### `page.setBlockEditable`

Name the fields a list/table block edits IN PLACE — click a cell, type, done, no trip to the form. The cell submits to the record’s own edit route, so an inline edit runs the same validation, permission check, value limits and audit entry as the form; the list gets no write path of its own. References, files, json and rank keys are refused — a cell editor cannot represent them. Last-wins; pass [] to make the list read-only again.

**Arguments**

- `pageId` — `string` · **required** · page id, prefix "pg-".
- `blockId` — `string` · **required** · block id, prefix "blk-".
- `editable` — `array` · **required** · entity FIELD NAMES (not ids) whose cells edit in place. Simple types only: string, number, boolean, enum (with options), date. This array REPLACES the block’s current list; pass [] to clear.

### `page.setBlockCreatable`

Name the fields a NEW ROW added from the list collects — type across the bottom row, hit Add, no trip to the New form. The row posts to the resource’s own create route, so it runs the same validation, permission check, value limits and audit entry as the form; the list gets no write path of its own. Stricter than setBlockEditable in one way: every REQUIRED field of the entity must be named, or the create could never succeed and the op is refused. References, files, json and rank keys are refused — a row form cannot collect them. Last-wins; pass [] to take the affordance away again.

**Arguments**

- `pageId` — `string` · **required** · page id, prefix "pg-".
- `blockId` — `string` · **required** · block id, prefix "blk-".
- `creatable` — `array` · **required** · entity FIELD NAMES (not ids) the new-row form collects. Simple types only: string, number, boolean, enum (with options), date — and every required field of the entity must appear. This array REPLACES the block’s current list; pass [] to clear.

### `page.setE2ETests`

Set a page’s natural-language e2e tests — one sentence per behaviour. `run_generator e2e-tests` scaffolds a Playwright spec per sentence and `run_checks` runs them, which is the cheap verification path.

**Arguments**

- `pageId` — `string` · **required** · page id, prefix "pg-".
- `e2eTests` — `array` · **required** · natural-language test descriptions, e.g. "a signed-in user can archive a deck". Last-wins: this array REPLACES the page’s current list. Pass [] to clear.

### `page.addCalendar`

Add a calendar block: the page’s rows arranged by one of its date fields, as a month grid, a week grid, or a density heatmap.

**Arguments**

- `pageId` — `string` · **required** · page id, prefix "pg-".
- `blockId` — `string` · **required** · new block id, prefix "blk-".
- `calendar` — `object` · **required**
  - `dateField` — `string` · **required** · FIELD NAME (not id) of a `date` field on the page’s backing entity — the day each row is placed on.
  - `endField` — `string` · optional second `date` field ending a multi-day entry.
  - `display` — `string` · **required** · one of `month`, `week`, `heatmap` · month/week place each row on its day; heatmap draws rows-per-day density over a rolling year.
  - `timezone` — `string` · **required** · IANA timezone the days are bucketed in, e.g. "America/New_York". REQUIRED and never inferred.
  - `titleField` — `string` · field rendered as the entry label.
  - `reschedule` — `boolean` · allow moving an entry to another day (drag or keyboard); the move is an ordinary validated update of dateField. Not allowed with display "heatmap".
- `provenance` — `object` · OPTIONAL — best OMITTED; the server stamps the correct default (accepted). If supplied it must be the full 5-key object.
  - `isSuggested` — `boolean` · **required**
  - `isAccepted` — `boolean | null` · **required** · null = undecided.
  - `isAddedManually` — `boolean | null` · **required**
  - `suggestedDescription` — `string | null` · **required**
  - `priority` — `string` · **required** · one of `medium`, `high`

### `page.addTimeline`

Add a timeline (Gantt) block: the page’s rows as bars across a start/end date range, with optional dependency arrows from a self-referencing field.

**Arguments**

- `pageId` — `string` · **required** · page id, prefix "pg-".
- `blockId` — `string` · **required** · new block id, prefix "blk-".
- `timeline` — `object` · **required**
  - `startField` — `string` · **required** · FIELD NAME (not id) of the `date` field a bar starts at.
  - `endField` — `string` · **required** · FIELD NAME of the `date` field a bar ends at. Required — a bar has two ends.
  - `timezone` — `string` · **required** · IANA timezone the days are bucketed in. REQUIRED and never inferred.
  - `titleField` — `string` · field rendered as the bar label.
  - `dependsOn` — `string` · FIELD NAME of a field referencing the SAME entity — drawn as an arrow. Presentation only: no rescheduling of dependents, no critical path.
  - `reschedule` — `boolean` · allow moving a bar (start and end shift together, duration preserved) through the same validated update path as a form edit.
- `provenance` — `object` · OPTIONAL — best OMITTED; the server stamps the correct default (accepted). If supplied it must be the full 5-key object.
  - `isSuggested` — `boolean` · **required**
  - `isAccepted` — `boolean | null` · **required** · null = undecided.
  - `isAddedManually` — `boolean | null` · **required**
  - `suggestedDescription` — `string | null` · **required**
  - `priority` — `string` · **required** · one of `medium`, `high`

### `page.addBoard`

Add a Kanban board block: the page’s rows as cards in columns grouped by one of its enum fields, moved between columns by drag or keyboard. WIP limits are declared on the field (data.setFieldLimits), not here.

**Arguments**

- `pageId` — `string` · **required** · page id, prefix "pg-".
- `blockId` — `string` · **required** · new block id, prefix "blk-".
- `board` — `object` · **required**
  - `groupField` — `string` · **required** · FIELD NAME (not id) of an `enum` field on the page’s backing entity that carries declared options — those options ARE the board’s columns, in the order declared.
  - `rankField` — `string` · FIELD NAME of a field declared with rank:true — persists manual order within a column. Omit for column-only moves.
  - `titleField` — `string` · field rendered as the card title.
  - `cardFields` — `array` · extra FIELD NAMES rendered on the card below its title; enums render as chips.
  - `move` — `boolean` · allow moving a card (drag or keyboard); the move is an ordinary validated update of groupField (and rankField), and is refused when it would exceed the target column’s declared WIP limit.
- `provenance` — `object` · OPTIONAL — best OMITTED; the server stamps the correct default (accepted). If supplied it must be the full 5-key object.
  - `isSuggested` — `boolean` · **required**
  - `isAccepted` — `boolean | null` · **required** · null = undecided.
  - `isAddedManually` — `boolean | null` · **required**
  - `suggestedDescription` — `string | null` · **required**
  - `priority` — `string` · **required** · one of `medium`, `high`

### `page.addAggregate`

Add an aggregate block: a GROUP BY over the page’s rows — count by enum, sum/avg of a number by a dimension, count per month — drawn as bars or a table. This is what a dashboard tile is; data.addRollup is the per-row number instead.

**Arguments**

- `pageId` — `string` · **required** · page id, prefix "pg-".
- `blockId` — `string` · **required** · new block id, prefix "blk-".
- `aggregate` — `object` · **required**
  - `groupField` — `string` · **required** · FIELD NAME (not id) of the dimension the rows are bucketed by. Must be one of enum, boolean, date — a GROUP BY over free text or a raw number has unbounded cardinality, so it is refused rather than truncated.
  - `bucket` — `string` · one of `day`, `week`, `month`, `quarter`, `year` · how a `date` groupField is truncated. REQUIRED when groupField is a date, refused otherwise.
  - `fn` — `string` · **required** · one of `count`, `countDistinct`, `sum`, `avg`, `min`, `max` · the aggregate drawn per bucket. `count` counts rows; everything else needs measureField.
  - `measureField` — `string` · FIELD NAME aggregated. REQUIRED for countDistinct, sum, avg, min, max; refused for "count"; must be a number field for sum, avg.
  - `where` — `array` · declared equality predicates narrowing which rows are aggregated ("open tickets by priority"). AND-ed under the tenant and soft-delete scopes, so it can only narrow.
    each item:
    - `field` — `string` · **required** · FIELD NAME.
    - `equals` — `any` · **required** · the value it must equal; null tests IS NULL.
  - `display` — `string` · one of `bar`, `table` · how buckets are drawn. Defaults to "bar".
  - `limit` — `number` · max buckets returned, largest measure first (1–50).
- `provenance` — `object` · OPTIONAL — best OMITTED; the server stamps the correct default (accepted). If supplied it must be the full 5-key object.
  - `isSuggested` — `boolean` · **required**
  - `isAccepted` — `boolean | null` · **required** · null = undecided.
  - `isAddedManually` — `boolean | null` · **required**
  - `suggestedDescription` — `string | null` · **required**
  - `priority` — `string` · **required** · one of `medium`, `high`

## Layer: pricing

### `pricing.addTier`

Add a pricing tier.

**Arguments**

- `tier` — `object` · **required**
  - `id` — `string` · **required** · branded id, prefix "tr-".
  - `name` — `string` · **required**
  - `priceMonthly` — `number` · **required**
  - `features` — `array` · **required**
  - `provenance` — `object` · OPTIONAL — best OMITTED; the server stamps the correct default (accepted). If supplied it must be the full 5-key object.
    - `isSuggested` — `boolean` · **required**
    - `isAccepted` — `boolean | null` · **required** · null = undecided.
    - `isAddedManually` — `boolean | null` · **required**
    - `suggestedDescription` — `string | null` · **required**
    - `priority` — `string` · **required** · one of `medium`, `high`

## Layer: theme

### `theme.set`

Set the app’s visual theme: a curated preset (zinc | ocean | forest | sunset | mono | rose | amber) plus optional accent (#hex), radius (sm|md|lg|full), density (comfortable|compact), font (sans|serif|mono|rounded|humanist), typeScale (compact|default|relaxed). Last-wins — replaces the whole theme.

**Arguments**

- `theme` — `object` · **required**
  - `preset` — `string` · **required** · one of `zinc`, `ocean`, `forest`, `sunset`, `mono`, `rose`, `amber`
  - `accent` — `string` · #rgb or #rrggbb.
  - `radius` — `string` · one of `sm`, `md`, `lg`, `full`
  - `density` — `string` · one of `comfortable`, `compact`
  - `font` — `string` · one of `sans`, `serif`, `mono`, `rounded`, `humanist`
  - `typeScale` — `string` · one of `compact`, `default`, `relaxed`

## Layer: site

### `site.set`

Set the app’s public identity: domain (origin only — scheme + host, no path, no trailing slash, never localhost), name, plus optional tagline, description, social handles and defaultOgImage. Every canonical, OG card and sitemap entry is built against domain. Last-wins — replaces the whole declaration, so an omitted optional key is cleared.

**Arguments**

- `site` — `object` · **required**
  - `domain` — `string` · **required** · The origin, as in "https://example.com". Scheme + host (+ port if non-default) ONLY: no path, no trailing slash, no query, no fragment, no credentials. A local host (localhost, 127.0.0.1, *.local, *.test) is refused — a canonical pointing at a laptop tells a crawler the real page lives on a host it cannot reach. For local development declare no site at all.
  - `name` — `string` · **required** · What the app calls itself — the OG site name and the suffix of every derived page title. At most 40 characters, because it is appended to every title and a title is bounded at 60.
  - `tagline` — `string` · A short phrase, at most 80 characters. Not a paragraph.
  - `description` — `string` · The fallback meta description for a public route that declares none. 50–160 characters, because it is emitted verbatim on the pages that use it.
  - `defaultOgImage` — `string` · Fallback card image: an absolute https URL, or a rooted path like "/og.png" resolved against domain. A relative path is refused — a crawler resolves it against whichever page it found the tag on.
  - `social` — `object`
    - `twitter` — `string` · Handle like "@example", not a profile URL.
    - `github` — `string`
    - `mastodon` — `string`
    - `linkedin` — `string`

## Layer: flags

### `flags.declare`

Declare a feature flag: a key, a default, and optional targeting (roles | organizations | rolloutPercent). Evaluated server-side per viewer; generation never reads a flag’s value.

**Arguments**

- `flag` — `object` · **required**
  - `id` — `string` · **required** · branded id, prefix "flg-".
  - `key` — `string` · **required** · the stable key a gated surface names, e.g. "checkout-v2".
  - `description` — `string` · **required** · what the flag turns on, in one line.
  - `default` — `boolean` · **required** · the value when no targeting rule matches.
  - `targeting` — `object` · who the flag is ALSO on for, beyond its default. Keys are OR-ed. Rejected when default is already true.
    - `roles` — `array` · roles the flag is on for, e.g. ["admin"].
    - `organizations` — `array` · organization ids the flag is on for.
    - `rolloutPercent` — `number` · integer 0–100; a stable hash bucket of subject:key, so ramping up never turns anyone back off. A viewer with no subject id is never bucketed on.
  - `provenance` — `object` · OPTIONAL — best OMITTED; the server stamps the correct default (accepted). If supplied it must be the full 5-key object.
    - `isSuggested` — `boolean` · **required**
    - `isAccepted` — `boolean | null` · **required** · null = undecided.
    - `isAddedManually` — `boolean | null` · **required**
    - `suggestedDescription` — `string | null` · **required**
    - `priority` — `string` · **required** · one of `medium`, `high`

### `flags.setTargeting`

Replace a flag’s targeting wholesale (last-wins). Omit `targeting` to clear it and return the flag to its bare default — this is how a rollout is ramped, paused, or completed.

**Arguments**

- `flagId` — `string` · **required** · flag id, prefix "flg-".
- `targeting` — `object` · who the flag is ALSO on for, beyond its default. Keys are OR-ed. Rejected when default is already true.
  - `roles` — `array` · roles the flag is on for, e.g. ["admin"].
  - `organizations` — `array` · organization ids the flag is on for.
  - `rolloutPercent` — `number` · integer 0–100; a stable hash bucket of subject:key, so ramping up never turns anyone back off. A viewer with no subject id is never bucketed on.

### `flags.gate`

Gate a page or block on a declared flag, or ungate it with flag:null. A gated surface is composed only for viewers the flag is on for; the generated code is identical either way.

**Arguments**

- `target` — `object` · **required**
  - `kind` — `string` · **required** · one of `page`, `block`
  - `id` — `string` · **required** · the gated row’s id.
  - `parentId` — `string` · required for kind:"block" — its page id.
- `flag` — `string | null` · **required** · a declared flag key, or null to ungate.

### `flags.remove`

Remove a flag declaration. Refused while any page or block still gates on it — ungate those surfaces first. This is the cleanup half of the flag lifecycle; a flag system without it accumulates dead flags forever.

**Arguments**

- `flagId` — `string` · **required** · flag id, prefix "flg-".

## Layer: schedules

### `schedules.declare`

Declare a schedule: a named recurrence, the IANA timezone it is read in, and the identity its runs carry. Delivery is at-least-once — the handler gets an idempotency key and must tolerate a repeat.

**Arguments**

- `schedule` — `object` · **required**
  - `id` — `string` · **required** · branded id, prefix "sch-".
  - `key` — `string` · **required** · the stable key the handler slot is registered under and every job row carries, e.g. "invoice.recurring".
  - `description` — `string` · **required** · what the schedule does, in one line.
  - `timezone` — `string` · **required** · IANA zone the wall-clock kinds are read in, e.g. "America/New_York". Not the server’s zone — a server that moves region must not move everybody’s monthly run.
  - `recurrence` — `object` · **required** · how often it fires. Deliberately not a cron string: `0 0 31 * *` silently skips four months a year and cannot carry a timezone at all.
    - `kind` — `string` · **required** · one of `interval`, `daily`, `weekly`, `monthly`
    - `everyMinutes` — `number` · kind:"interval" only — integer 1–10080, elapsed absolute time anchored on the declaration date (so DST never doubles or skips it).
    - `atTime` — `string` · kind:"daily"/"weekly"/"monthly" — HH:MM, read on the clock in the declared timezone.
    - `onWeekday` — `number` · kind:"weekly" only — integer 0–6, 0 = Sunday.
    - `onDayOfMonth` — `number` · kind:"monthly" only — integer 1–31. A day past the end of a short month clamps to that month’s last day; it is never skipped and never rolls into the next month.
  - `runAs` — `object` · **required** · whose authority every run carries. REQUIRED, no default, and no admin shorthand: scheduled work that acquires authority nobody wrote down is an authorization bypass with a cron expression in front of it.
    - `kind` — `string` · **required** · one of `service`, `user`
    - `role` — `string` · kind:"service" — a named service role, resolved through the same RBAC/entitlement path a human session is.
    - `userId` — `string` · kind:"user" — the user whose role, org and plan the run gets.
    - `orgId` — `string` · optional — the organization the run acts in. Required in practice for work that touches tenant-scoped data: a background run has no request, so it has no org switcher to resolve one from, and without this it reaches no tenant-scoped row at all. Re-verified against membership at run time for kind:"user"; taken as declared for kind:"service". Mutually exclusive with eachOrg.
    - `eachOrg` — `boolean` · optional — run once PER ORG instead of once in one declared org: the tenant-scoped answer for an app that needs the same nightly work for every customer, rather than one schedule per customer that somebody has to add on signup and remove on churn. Every org for kind:"service"; the orgs they are a member of (verified at run time) for kind:"user". Bounded at 200 runs per occurrence — a fan-out spends a request per tenant against somebody else's rate limit on every fire — and a wider one runs the bound's worth and reports what it left out. Cannot be combined with orgId.
    - `maxOrgs` — `number` · optional, eachOrg only — lower the fan-out bound below 200. An integer 1–200.
  - `entityId` — `string` · optional — the entity the work operates over, when there is one. Declared so "the monthly invoice run" is a reviewable statement about invoices.
  - `paused` — `boolean` · declare it stopped; resume with schedules.pause.
  - `provenance` — `object` · OPTIONAL — best OMITTED; the server stamps the correct default (accepted). If supplied it must be the full 5-key object.
    - `isSuggested` — `boolean` · **required**
    - `isAccepted` — `boolean | null` · **required** · null = undecided.
    - `isAddedManually` — `boolean | null` · **required**
    - `suggestedDescription` — `string | null` · **required**
    - `priority` — `string` · **required** · one of `medium`, `high`

### `schedules.setRecurrence`

Replace a schedule’s recurrence wholesale (last-wins), optionally moving its timezone with it. This is how a run is moved, slowed down, or re-anchored.

**Arguments**

- `scheduleId` — `string` · **required** · schedule id, prefix "sch-".
- `recurrence` — `object` · **required** · how often it fires. Deliberately not a cron string: `0 0 31 * *` silently skips four months a year and cannot carry a timezone at all.
  - `kind` — `string` · **required** · one of `interval`, `daily`, `weekly`, `monthly`
  - `everyMinutes` — `number` · kind:"interval" only — integer 1–10080, elapsed absolute time anchored on the declaration date (so DST never doubles or skips it).
  - `atTime` — `string` · kind:"daily"/"weekly"/"monthly" — HH:MM, read on the clock in the declared timezone.
  - `onWeekday` — `number` · kind:"weekly" only — integer 0–6, 0 = Sunday.
  - `onDayOfMonth` — `number` · kind:"monthly" only — integer 1–31. A day past the end of a short month clamps to that month’s last day; it is never skipped and never rolls into the next month.
- `timezone` — `string` · optional — leave it out to keep the declared zone.

### `schedules.pause`

Stop or resume a schedule, keeping its declaration and its run history. The 3am operation: the reason to stop a job is usually that something downstream is wrong, and deleting the declaration also deletes what you need to turn it back on.

**Arguments**

- `scheduleId` — `string` · **required** · schedule id, prefix "sch-".
- `paused` — `boolean` · **required** · true stops it, false resumes.

### `schedules.remove`

Remove a schedule declaration. Refused while it is still active — pause it first, so removal is always deliberate rather than the fastest way to silence a page.

**Arguments**

- `scheduleId` — `string` · **required** · schedule id, prefix "sch-".

## Layer: sources

### `sources.declare`

Declare an external data source: an endpoint, the credential it uses BY NAME, a typed mapping from the response onto entity fields, and the request budget it may spend. Two refusals are absolute — a credential anywhere in the declaration, and an endpoint the runtime must not reach. Generation never fetches; only the running app does.

**Arguments**

- `source` — `object` · **required**
  - `id` — `string` · **required** · branded id, prefix "src-".
  - `key` — `string` · **required** · the stable key every job row, log line and refiner module carries, e.g. "isbn.lookup".
  - `description` — `string` · **required** · what the source is for, in one line.
  - `mode` — `string` · **required** · one of `enrich`, `sync` · "enrich" = one request about one row, mapped back onto it. "sync" = a remote collection upserted into the entity by a stable remote id.
  - `entityId` — `string` · **required** · the entity the mapped values are written to.
  - `request` — `object` · **required** · the request issued. Its origin IS the allowlist: the runtime refuses anything else and never follows a redirect.
    - `url` — `string` · **required** · absolute https URL. No credentials, no fragment, port 443/8443 or none, and never an internal address (loopback / link-local / RFC1918 / CGNAT, in every spelling). In enrich mode it may carry {fieldName} placeholders resolved from the triggering row and percent-encoded by the runtime.
    - `method` — `string` · one of `GET`, `POST`
    - `query` — `object` · static query parameters; values may carry {fieldName} placeholders. Credential parameter names (key, api_key, token, access_token, secret, signature, …) are refused — use auth.
    - `headers` — `object` · static request headers. Credential header names (authorization, x-api-key, cookie, …) are refused outright — use auth.
  - `auth` — `object` · **required** · how the request authenticates. REQUIRED — {kind:"none"} states that the endpoint is public. Every other variant carries secretName, which is the NAME of a deployment secret (e.g. "OPENLIBRARY_TOKEN"), NEVER the secret. A credential-shaped string anywhere in this op is refused: a spec is committed, diffed, shown in the workbench and passed to agents, so one leak is every leak.
    - `kind` — `string` · **required** · one of `none`, `bearer`, `header`, `query`
    - `secretName` — `string` · kind:"bearer"/"header"/"query" — the secret’s NAME, env-var shaped and uppercase.
    - `header` — `string` · kind:"header" — the header the secret is sent in.
    - `param` — `string` · kind:"query" — the query parameter the secret is sent in.
  - `mapping` — `array` · **required** · response paths → entity fields. 1–32 entries. The mapping is typed by the TARGET COLUMN's declared type — there is no second type to drift from it — and a value that cannot be coerced is dropped with a reason rather than written as a lie.
    each item:
    - `from` — `string` · **required** · path into the response: dotted keys and [n] indices, e.g. "cover.large" or "authors[0].name". No wildcards, no filters, no expressions.
    - `to` — `string` · **required** · field id on the source’s entity.
  - `limits` — `object` · **required** · how hard this app may lean on somebody else’s server, and how patiently it waits. Every key is REQUIRED: an inherited retry policy against a third party is how a transient 503 becomes a self-inflicted denial of service the partner notices first.
    - `requestsPerMinute` — `number` · **required** · integer 1–600, across the whole deployment.
    - `timeoutMs` — `number` · **required** · integer 100–30000 — a hung socket is not a retry.
    - `maxAttempts` — `number` · **required** · integer 1–10, including the first. 1 = no retry.
    - `backoffMs` — `number` · **required** · integer 100–300000 — the first backoff; it doubles per attempt.
  - `triggers` — `array` · **required** · what runs the source. enrich: create/update/manual. sync: schedule/webhook/manual. A create/update trigger ENQUEUES work — enrichment never runs inline in a write, so a source that is down cannot fail a create.
    each item:
    - `kind` — `string` · **required** · one of `create`, `update`, `manual`, `webhook`, `schedule`
    - `scheduleKey` — `string` · kind:"schedule" — the key of an already-declared schedule (schedules.declare).
  - `inputField` — `string` · enrich mode only, and REQUIRED there — the field whose value drives the lookup. Enrichment is skipped when it is empty.
  - `collection` — `object` · sync mode only, and REQUIRED there: how the response’s records are found and keyed. Without a stable remote id every run appends the same rows again.
    - `path` — `string` · path to the array of records; omit when the response document IS the array.
    - `idPath` — `string` · **required** · path, within one record, to its stable remote id.
    - `idField` — `string` · **required** · the STRING field id the remote id is stored in — the upsert key. Stored, not hidden: "which remote record is this" is a question support asks.
    - `maxRecords` — `number` · **required** · integer 1–1000; a run that hits the bound reports the truncation rather than hiding it.
  - `refine` — `boolean` · emit the user-owned refiner slot sources/<key>.refine.ts and take its return value as final. For what a path cannot say — resolving a remote record to a local foreign key, reconciling two providers. Off by default; a project that does not need one grows no file.
  - `paused` — `boolean` · declare it stopped; resume with sources.pause.
  - `provenance` — `object` · OPTIONAL — best OMITTED; the server stamps the correct default (accepted). If supplied it must be the full 5-key object.
    - `isSuggested` — `boolean` · **required**
    - `isAccepted` — `boolean | null` · **required** · null = undecided.
    - `isAddedManually` — `boolean | null` · **required**
    - `suggestedDescription` — `string | null` · **required**
    - `priority` — `string` · **required** · one of `medium`, `high`

### `sources.setMapping`

Replace a source’s response mapping wholesale (last-wins). The edit a third party forces when it renames a field in its response — which is the most common reason to touch a source at all.

**Arguments**

- `sourceId` — `string` · **required** · source id, prefix "src-".
- `mapping` — `array` · **required** · response paths → entity fields. 1–32 entries. The mapping is typed by the TARGET COLUMN's declared type — there is no second type to drift from it — and a value that cannot be coerced is dropped with a reason rather than written as a lie.
  each item:
  - `from` — `string` · **required** · path into the response: dotted keys and [n] indices, e.g. "cover.large" or "authors[0].name". No wildcards, no filters, no expressions.
  - `to` — `string` · **required** · field id on the source’s entity.

### `sources.setLimits`

Replace a source’s rate limit and retry budget wholesale (last-wins). Separate from the mapping because "we are being rate-limited, slow down" is a different conversation from "these fields moved".

**Arguments**

- `sourceId` — `string` · **required** · source id, prefix "src-".
- `limits` — `object` · **required** · how hard this app may lean on somebody else’s server, and how patiently it waits. Every key is REQUIRED: an inherited retry policy against a third party is how a transient 503 becomes a self-inflicted denial of service the partner notices first.
  - `requestsPerMinute` — `number` · **required** · integer 1–600, across the whole deployment.
  - `timeoutMs` — `number` · **required** · integer 100–30000 — a hung socket is not a retry.
  - `maxAttempts` — `number` · **required** · integer 1–10, including the first. 1 = no retry.
  - `backoffMs` — `number` · **required** · integer 100–300000 — the first backoff; it doubles per attempt.

### `sources.pause`

Stop or resume a source, keeping its declaration and its run history. The 3am operation: the reason to stop an integration is usually that the other end is misbehaving, and deleting the declaration also deletes what you need to turn it back on.

**Arguments**

- `sourceId` — `string` · **required** · source id, prefix "src-".
- `paused` — `boolean` · **required** · true stops it fetching, false resumes.

### `sources.remove`

Remove a source declaration. Refused while it is still active — pause it first, so removal is always deliberate rather than the fastest way to silence a failing integration.

**Arguments**

- `sourceId` — `string` · **required** · source id, prefix "src-".

## Layer: search

### `search.declare`

Declare a ranked full-text index over one entity: which fields are searchable, how much each counts toward the rank, which language stems them, and whether the physical index exists. Ranked search then works in admin, over REST and over MCP, filtered by the same read rules a list query passes.

**Arguments**

- `index` — `object` · **required**
  - `id` — `string` · **required** · branded id, prefix "idx-".
  - `key` — `string` · **required** · the name the database object carries, and what shows up in EXPLAIN when somebody goes looking for why a write got slow.
  - `description` — `string` · **required** · what this index is for, in one line. An index nobody can explain is one nobody can decide to stop paying for.
  - `entityId` — `string` · **required** · entity id, prefix "e-". One index per entity: an entity has one answer to "what does searching this mean", and the weights are how you express the rest. Searching several entities is a fan-out where each one passes its own read gate — a shared index would hold rows from tables with different rules and could only ever be gated once, for all of them.
  - `language` — `string` · **required** · one of `simple`, `arabic`, `armenian`, `basque`, `catalan`, `danish`, `dutch`, `english`, `estonian`, `finnish`, `french`, `german`, `greek`, `hindi`, `hungarian`, `indonesian`, `irish`, `italian`, `lithuanian`, `nepali`, `norwegian`, `portuguese`, `romanian`, `russian`, `serbian`, `spanish`, `swedish`, `tamil`, `turkish`, `yiddish` · the stemmer and stop-word list. On the index rather than global because the query must be parsed with the same configuration the index was built with — a deployment-level setting would silently invalidate every index when somebody changed it. Use "simple" for identifiers, tags, SKUs, or any corpus that is not prose in one language.
  - `fields` — `array` · **required** · which fields are searchable and how much each counts toward the rank. 1–8 entries, no field twice. Order does not matter — the emitted index is sorted by weight, so two specs that declare the same weighting produce the same index.
    each item:
    - `fieldId` — `string` · **required** · field id (prefix "fld-") of the index's entity. Must be a string or enum field: a reference stores an id rather than text, and a number/boolean/date is already answerable by a filter, exactly and with an index.
    - `weight` — `string` · **required** · one of `A`, `B`, `C`, `D` · how much a match here counts: A=1, B=0.4, C=0.2, D=0.1. Postgres's own four levels, not a scale this vocabulary invented — a tsvector holds exactly four, so a wider scale would silently round.
  - `indexed` — `boolean` · **required** · whether the GIN index physically exists. Required, not defaulted: whether this costs every write is a decision about somebody’s production database. false is the write-heavy opt-out and changes only the cost — the same query runs over the same expression and returns the same ranked rows, as a sequential scan.
  - `provenance` — `object` · OPTIONAL — best OMITTED; the server stamps the correct default (accepted). If supplied it must be the full 5-key object.
    - `isSuggested` — `boolean` · **required**
    - `isAccepted` — `boolean | null` · **required** · null = undecided.
    - `isAddedManually` — `boolean | null` · **required**
    - `suggestedDescription` — `string | null` · **required**
    - `priority` — `string` · **required** · one of `medium`, `high`

### `search.setFields`

Replace an index’s field list and weights wholesale, last-wins. The edit you make when a new field should be searchable, or when the top result for a common query is obviously wrong — which is always a change to the relative weights, never to one of them alone.

**Arguments**

- `indexId` — `string` · **required** · search index id, prefix "idx-".
- `fields` — `array` · **required** · which fields are searchable and how much each counts toward the rank. 1–8 entries, no field twice. Order does not matter — the emitted index is sorted by weight, so two specs that declare the same weighting produce the same index.
  each item:
  - `fieldId` — `string` · **required** · field id (prefix "fld-") of the index's entity. Must be a string or enum field: a reference stores an id rather than text, and a number/boolean/date is already answerable by a filter, exactly and with an index.
  - `weight` — `string` · **required** · one of `A`, `B`, `C`, `D` · how much a match here counts: A=1, B=0.4, C=0.2, D=0.1. Postgres's own four levels, not a scale this vocabulary invented — a tsvector holds exactly four, so a wider scale would silently round.

### `search.setIndexing`

Create or drop the physical index, leaving the declaration alone. The cost lever an operator reaches for under load. It changes no answer — search still runs over the same expression with the same ranking, as a sequential scan — and it is reversible in one additive statement, because an expression index stores nothing that is not derivable from the columns it reads.

**Arguments**

- `indexId` — `string` · **required** · search index id, prefix "idx-".
- `indexed` — `boolean` · **required** · true creates the GIN index, false drops it. Dropping loses no data by construction.

### `search.remove`

Remove a search index declaration. Refused while the physical index still exists — set indexed:false first, because the DDL is emitted from the declaration and removing it first would strand a real index on a real table with nothing left in the spec that knows its name.

**Arguments**

- `indexId` — `string` · **required** · search index id, prefix "idx-".

## Layer: documents

### `documents.declare`

Declare a document template over one entity: the sections it prints, the paper it is laid out for, and where a rendered copy goes. Renders to print-ready HTML and to PDF from one compiled layout — no headless browser — and rendering is a read of the row, through the same gate a GET passes.

**Arguments**

- `template` — `object` · **required**
  - `id` — `string` · **required** · branded id, prefix "doc-".
  - `key` — `string` · **required** · the URL segment and stored object-key prefix — the string a person types and a support ticket quotes.
  - `description` — `string` · **required** · what this document is, in one line. A document nobody can explain is one nobody can decide to stop sending.
  - `entityId` — `string` · **required** · entity id, prefix "e-". SEVERAL templates per entity is fine and expected — an invoice, a receipt and a statement are three documents about one row, unlike a search index, where one entity has one answer to what searching it means.
  - `pageSize` — `string` · **required** · one of `a4`, `letter` · the paper. On the template rather than a global setting because a business with clients on two continents sends both.
  - `sections` — `array` · **required** · the document, top to bottom. 1–32 entries. There is no nesting, no width and no color: a section is a heading, a paragraph, a labelled block of this row’s fields, a table of related rows, a rule, or a slot for bespoke layout. Styling comes from the app’s theme (theme.set), so a document matches the product without declaring anything.
    each item:
    - `kind` — `string` · **required** · one of `heading`, `text`, `fields`, `table`, `rule`, `slot`
    - `level` — `number` · kind:"heading" — 1 for the document title, 2 for a section head. There is no 3.
    - `text` — `string` · kind:"heading"/"text" — the words. May carry {fieldName} placeholders resolved against the row (e.g. "Invoice {number}"); a placeholder that is not a field or derived value on the entity is refused here rather than printed literally on something a customer receives. There is deliberately no {today}: same row + same template must give the same bytes, and an issue date is a date FIELD on the row.
    - `fieldIds` — `array` · kind:"fields"/"table" — field ids (prefix "fld-") or derived-value ids (prefix "drv-"), in print order. Up to 24 in a fields block and 8 in a table. Derived values are included on purpose: an invoice total is a rollup you already declared, so this layer ships no arithmetic of its own. Only string, number, boolean, date, enum fields print — json is punctuation and file holds a storage key.
    - `columns` — `number` · kind:"fields" — 1 or 2. Pairs down one column or two; two is the shape of an address block. There is no 3, because a third column is a layout language.
    - `caption` — `string` · kind:"fields"/"table" — optional block caption ("Bill to"). Placeholders allowed.
    - `over` — `string` · kind:"table" — entity id (prefix "e-") on the many side. Spelled exactly as a rollup spells it, because it means exactly the same thing. At most 500 rows print, and a row past that is reported on the page ("showing the first N of M") rather than dropped — a document that quietly omits billable lines is the worst bug this feature could have.
    - `via` — `string` · kind:"table" — the field id on `over` that references THIS template’s entity. Checked against its target, not just its existence: a via pointing at some other entity would fetch rows and print somebody else’s line items under this customer’s letterhead.
    - `orderBy` — `string` · kind:"table" — a STORED field id of `over` to order the rows by. Absent means primary-key order, which is still deterministic; what is never allowed is table order, because a document whose rows move between renders is not byte-identical.
    - `direction` — `string` · one of `asc`, `desc` · kind:"table" — "asc" when absent.
    - `name` — `string` · kind:"slot" — the identifier an owned module is registered under. The fill returns layout blocks rather than HTML or PDF operators, so a bespoke region still renders to both targets and still cannot reach a row the caller may not read.
  - `delivery` — `object` · **required** · where a rendered document goes. REQUIRED, and every target defaults to off — "who receives this" is not something a code generator should decide. `store` composes the storage bundle and `email` the email bundle; neither grew a document-shaped special case to make that work.
    - `download` — `boolean` · **required** · serve it over HTTP at /documents/<key>/<id>.html|.pdf, behind the same read gate as the row.
    - `store` — `object` · write it to the storage bundle.
      - `path` — `string` · **required** · object key template, e.g. "invoices/{number}.pdf". At least one {placeholder} is REQUIRED: a constant path is one object key for every row, so the archive would hold exactly one document however many were sent.
      - `format` — `string` · **required** · one of `html`, `pdf`
    - `email` — `object` · attach it to a transactional email through the email bundle.
      - `template` — `string` · **required** · the name the body template is registered under.
      - `subject` — `string` · **required** · subject line. Placeholders allowed.
      - `to` — `object` · **required** · the recipient address, as a field path of at most one hop. Two hops is a query, and an outbound email should never traverse a path nobody wrote down.
        - `via` — `string` · optional — a REFERENCE field id on this entity to follow first (an invoice’s client).
        - `fieldId` — `string` · **required** · a string field id holding the address, on the referenced entity when via is set.
      - `format` — `string` · **required** · one of `html`, `pdf`
  - `provenance` — `object` · OPTIONAL — best OMITTED; the server stamps the correct default (accepted). If supplied it must be the full 5-key object.
    - `isSuggested` — `boolean` · **required**
    - `isAccepted` — `boolean | null` · **required** · null = undecided.
    - `isAddedManually` — `boolean | null` · **required**
    - `suggestedDescription` — `string | null` · **required**
    - `priority` — `string` · **required** · one of `medium`, `high`

### `documents.setSections`

Replace a template’s sections wholesale, last-wins. Wholesale because the sections are only correct relative to each other — "move the totals above the line items" is not an edit to either one.

**Arguments**

- `templateId` — `string` · **required** · document template id, prefix "doc-".
- `sections` — `array` · **required** · the document, top to bottom. 1–32 entries. There is no nesting, no width and no color: a section is a heading, a paragraph, a labelled block of this row’s fields, a table of related rows, a rule, or a slot for bespoke layout. Styling comes from the app’s theme (theme.set), so a document matches the product without declaring anything.
  each item:
  - `kind` — `string` · **required** · one of `heading`, `text`, `fields`, `table`, `rule`, `slot`
  - `level` — `number` · kind:"heading" — 1 for the document title, 2 for a section head. There is no 3.
  - `text` — `string` · kind:"heading"/"text" — the words. May carry {fieldName} placeholders resolved against the row (e.g. "Invoice {number}"); a placeholder that is not a field or derived value on the entity is refused here rather than printed literally on something a customer receives. There is deliberately no {today}: same row + same template must give the same bytes, and an issue date is a date FIELD on the row.
  - `fieldIds` — `array` · kind:"fields"/"table" — field ids (prefix "fld-") or derived-value ids (prefix "drv-"), in print order. Up to 24 in a fields block and 8 in a table. Derived values are included on purpose: an invoice total is a rollup you already declared, so this layer ships no arithmetic of its own. Only string, number, boolean, date, enum fields print — json is punctuation and file holds a storage key.
  - `columns` — `number` · kind:"fields" — 1 or 2. Pairs down one column or two; two is the shape of an address block. There is no 3, because a third column is a layout language.
  - `caption` — `string` · kind:"fields"/"table" — optional block caption ("Bill to"). Placeholders allowed.
  - `over` — `string` · kind:"table" — entity id (prefix "e-") on the many side. Spelled exactly as a rollup spells it, because it means exactly the same thing. At most 500 rows print, and a row past that is reported on the page ("showing the first N of M") rather than dropped — a document that quietly omits billable lines is the worst bug this feature could have.
  - `via` — `string` · kind:"table" — the field id on `over` that references THIS template’s entity. Checked against its target, not just its existence: a via pointing at some other entity would fetch rows and print somebody else’s line items under this customer’s letterhead.
  - `orderBy` — `string` · kind:"table" — a STORED field id of `over` to order the rows by. Absent means primary-key order, which is still deterministic; what is never allowed is table order, because a document whose rows move between renders is not byte-identical.
  - `direction` — `string` · one of `asc`, `desc` · kind:"table" — "asc" when absent.
  - `name` — `string` · kind:"slot" — the identifier an owned module is registered under. The fill returns layout blocks rather than HTML or PDF operators, so a bespoke region still renders to both targets and still cannot reach a row the caller may not read.

### `documents.setDelivery`

Change where a rendered document goes, leaving the layout alone. Its own op because this is the outward-facing half: turning email on starts sending mail to customers, and turning every target off is how a template is retired.

**Arguments**

- `templateId` — `string` · **required** · document template id, prefix "doc-".
- `delivery` — `object` · **required** · where a rendered document goes. REQUIRED, and every target defaults to off — "who receives this" is not something a code generator should decide. `store` composes the storage bundle and `email` the email bundle; neither grew a document-shaped special case to make that work.
  - `download` — `boolean` · **required** · serve it over HTTP at /documents/<key>/<id>.html|.pdf, behind the same read gate as the row.
  - `store` — `object` · write it to the storage bundle.
    - `path` — `string` · **required** · object key template, e.g. "invoices/{number}.pdf". At least one {placeholder} is REQUIRED: a constant path is one object key for every row, so the archive would hold exactly one document however many were sent.
    - `format` — `string` · **required** · one of `html`, `pdf`
  - `email` — `object` · attach it to a transactional email through the email bundle.
    - `template` — `string` · **required** · the name the body template is registered under.
    - `subject` — `string` · **required** · subject line. Placeholders allowed.
    - `to` — `object` · **required** · the recipient address, as a field path of at most one hop. Two hops is a query, and an outbound email should never traverse a path nobody wrote down.
      - `via` — `string` · optional — a REFERENCE field id on this entity to follow first (an invoice’s client).
      - `fieldId` — `string` · **required** · a string field id holding the address, on the referenced entity when via is set.
    - `format` — `string` · **required** · one of `html`, `pdf`

### `documents.remove`

Remove a document template declaration. Refused while any delivery target is still on — the URL and the object path are emitted from the declaration, so removing it first turns a bookmarked link into a 404 and an archive write into an error. Retire it with documents.setDelivery first.

**Arguments**

- `templateId` — `string` · **required** · document template id, prefix "doc-".

## Layer: imports

### `imports.declare`

Declare an importer over one entity: the file format, the column-to-field mapping, the upsert key that decides whether existing rows can be overwritten, and the row ceiling. Running it is ALWAYS two steps — a dry-run reporting exactly what would change, then an explicit apply — and that is structural rather than a policy: the apply function takes a plan and there is no overload that takes bytes.

**Arguments**

- `importer` — `object` · **required**
  - `id` — `string` · **required** · branded id, prefix "imp-".
  - `key` — `string` · **required** · the URL segment, the audit label, and (for a custom importer) the parser module name — the string a person types and a support ticket quotes.
  - `description` — `string` · **required** · what this importer is for, in one line. An importer nobody can explain is one nobody can decide to pause.
  - `entityId` — `string` · **required** · entity id, prefix "e-". SEVERAL importers per entity is fine and expected — "the CSV our old tool exports" and "an Anki deck" are two different files about one table, unlike a search index, where one entity has one answer to what searching it means.
  - `format` — `string` · **required** · one of `csv`, `ndjson`, `json`, `custom` · csv/ndjson/json are read incrementally over chunks, so a large file costs memory proportional to one row rather than to the file. "custom" is the honest fourth: the platform does not know how to read a .apkg or an .xlsx, and saying so with a typed parser slot is what keeps the vocabulary from growing a parser per vendor.
  - `parserSlot` — `string` · REQUIRED iff format is "custom", refused otherwise. Names the user-owned module (imports/<key>.parse.ts) that turns bytes into raw records. Those records then feed the IDENTICAL mapping, validation and write pipeline a CSV takes — the bespoke half stops at parsing and never reaches the write path, which is what keeps the slot from being a bypass.
  - `columns` — `array` · **required** · which file column lands on which entity field. 1–48 entries, no column twice and no FIELD twice — two columns writing one field is data loss whose winner depends on declaration order. The cell is parsed as the TARGET FIELD's declared type, so there is no second type here to drift from the column's, and there is deliberately no transform language: splitting a value or looking one up is what the parser slot is for.
    each item:
    - `column` — `string` · **required** · the header name (csv) or object key (ndjson/json, and whatever a custom parser yields). Matched exactly, after trimming.
    - `fieldId` — `string` · **required** · field id (prefix "fld-") of THIS importer's entity — checked against its owner, because an id from another entity resolves and would map this file's column onto somebody else's table. Importable types: string, number, boolean, date, enum, json. A file field is refused: it stores a storage key only the upload path can mint, so a value from a file would be a key nobody minted.
  - `upsertFieldId` — `string | null` · **required** · the field that decides whether a row ALREADY EXISTS — the single lever that decides whether running this importer can overwrite somebody's data. REQUIRED and nullable, never defaulted. null = insert-only: every line becomes a new row and nothing existing is touched. A field id = matching rows are updated in place. Must be one of string, number, enum, must not be a reference, and must also appear in the column mapping — a key can only identify a row if the file supplies it, and one that does not silently degrades to insert-only, i.e. duplicates. A boolean key is refused because it collapses the whole table onto two rows on the first run; a date matches either nothing or everything sharing a day; equality on json is equality on its serialization.
  - `maxRows` — `number` · **required** · integer 1–50000. Required, never defaulted. A run that exceeds it FAILS LOUDLY rather than truncating: a silently truncated import looks exactly like a successful one, and the missing rows are found weeks later by somebody who assumes they were never in the file.
  - `paused` — `boolean` · **required** · whether the importer accepts uploads. Required, never defaulted — "is this write path open" is a decision about somebody’s production data. Flip it with imports.pause.
  - `provenance` — `object` · OPTIONAL — best OMITTED; the server stamps the correct default (accepted). If supplied it must be the full 5-key object.
    - `isSuggested` — `boolean` · **required**
    - `isAccepted` — `boolean | null` · **required** · null = undecided.
    - `isAddedManually` — `boolean | null` · **required**
    - `suggestedDescription` — `string | null` · **required**
    - `priority` — `string` · **required** · one of `medium`, `high`

### `imports.setMapping`

Replace an importer’s column mapping wholesale, last-wins. The edit a partner forces when their export gains a column or renames two — which is one edit to one mapping rather than three patches, because a mapping is only correct relative to the whole file’s shape.

**Arguments**

- `importerId` — `string` · **required** · importer id, prefix "imp-".
- `columns` — `array` · **required** · which file column lands on which entity field. 1–48 entries, no column twice and no FIELD twice — two columns writing one field is data loss whose winner depends on declaration order. The cell is parsed as the TARGET FIELD's declared type, so there is no second type here to drift from the column's, and there is deliberately no transform language: splitting a value or looking one up is what the parser slot is for.
  each item:
  - `column` — `string` · **required** · the header name (csv) or object key (ndjson/json, and whatever a custom parser yields). Matched exactly, after trimming.
  - `fieldId` — `string` · **required** · field id (prefix "fld-") of THIS importer's entity — checked against its owner, because an id from another entity resolves and would map this file's column onto somebody else's table. Importable types: string, number, boolean, date, enum, json. A file field is refused: it stores a storage key only the upload path can mint, so a value from a file would be a key nobody minted.

### `imports.setUpsertKey`

Change whether — and on what — this importer may OVERWRITE rows that already exist. Its own op precisely so a reviewer can answer "can this destroy data?" from the op name, before reading a single argument. null makes it insert-only; a field id makes matching rows update in place. Nothing else in the vocabulary changes that answer, and this op changes nothing else.

**Arguments**

- `importerId` — `string` · **required** · importer id, prefix "imp-".
- `upsertFieldId` — `string | null` · **required** · the field that decides whether a row ALREADY EXISTS — the single lever that decides whether running this importer can overwrite somebody's data. REQUIRED and nullable, never defaulted. null = insert-only: every line becomes a new row and nothing existing is touched. A field id = matching rows are updated in place. Must be one of string, number, enum, must not be a reference, and must also appear in the column mapping — a key can only identify a row if the file supplies it, and one that does not silently degrades to insert-only, i.e. duplicates. A boolean key is refused because it collapses the whole table onto two rows on the first run; a date matches either nothing or everything sharing a day; equality on json is equality on its serialization.

### `imports.pause`

Stop or resume an importer, keeping its declaration, its mapping and its parser file. The operational lever: the reason to stop an importer is usually that a partner’s export changed shape, and deleting the declaration to stop it also deletes the mapping you need to fix it. Pausing is also the retire step before imports.remove.

**Arguments**

- `importerId` — `string` · **required** · importer id, prefix "imp-".
- `paused` — `boolean` · **required** · true refuses uploads, false accepts them again.

### `imports.remove`

Remove an importer declaration. Refused while it is not paused — pause it first, so removal is never the fastest way to silence something somebody is mid-way through using.

**Arguments**

- `importerId` — `string` · **required** · importer id, prefix "imp-".

## Layer: portals

### `portals.declare`

Declare a PUBLIC, token-scoped or role-scoped surface over one entity: who is on the other side, which rows they may reach, EXACTLY which fields they may read, and which writes (if any) they may perform under which hourly budget. This is the highest-consequence op in the vocabulary — every other op changes what the app does for people already inside it; this one decides what somebody who has never signed in can read. Enforcement lives in the permission layer and the read/write ops, never in a route.

**Arguments**

- `portal` — `object` · **required**
  - `id` — `string` · **required** · branded id, prefix "ptl-".
  - `key` — `string` · **required** · the URL segment (/p/<key>), the audit label and the rate-limit bucket — the string a person types and a support ticket quotes.
  - `description` — `string` · **required** · what this portal is for, in one line. It is printed beside the field list in the exposure report, and a portal nobody can explain is one nobody can decide to pause.
  - `entityId` — `string` · **required** · entity id, prefix "e-". SEVERAL portals per entity is expected: a public archive and a client portal are two different outsides on one table.
  - `audience` — `string` · **required** · one of `public`, `token`, `role` · "public" = no credential at all, the URL is the whole of it. "token" = one holder of one minted, expiring, revocable link (the client a freelancer sent an invoice to). "role" = an ordinary signed-in session whose role matches.
  - `role` — `string` · REQUIRED iff audience is "role", refused otherwise. An unnamed role grants to every session; a role on a public portal reads as a restriction and enforces nothing.
  - `token` — `object` · REQUIRED iff audience is "token", refused otherwise. There is no non-expiring portal token and no default that would produce one by omission — a link somebody emailed a client is a credential sitting in a mail archive, and the only thing that reliably closes it is an expiry chosen when it was minted. The token itself is minted, hashed, expired and revoked by the api-keys bundle; nothing about it is stored in the spec.
    - `ttlHours` — `number` · **required** · integer 1–8760 (one year). Beyond a year the honest answer is an account, not a link.
    - `maxUses` — `number | null` · **required** · REQUIRED and nullable. null = any number of opens before it expires — a recorded decision. An integer is a hard use cap. Omitting the key is an author who has not decided, which is the one thing it may not be.
  - `scope` — `string` · **required** · one of `row`, `collection` · "row" = exactly one row, named by the token that opened it, and therefore REQUIRES audience "token": the only thing that can name one row from outside without being guessable, revocable and expiring is a credential, and a row id in a public URL appears in every log and referrer header and can never be revoked. "collection" = the rows a declared filter admits, and no others.
  - `readFields` — `array` · **required** · EXACTLY the fields this audience may read — 1–32 field ids (prefix "fld-") of THIS portal's entity, checked against its owner because an id from another entity resolves and would project somebody else's column. There is deliberately NO "expose everything" value and NO exclusion list: an "all except" list silently exposes every field added AFTER it was written, which is the exact failure this layer exists to prevent. The runtime rebuilds each row from this list plus the primary key and drops every other key — including derived values, the soft-delete column and the tenant column. A public or token portal may not name a file field (it holds a storage key, i.e. an object path into the bucket) or a reference to e-user (an identity-table primary key, i.e. a way to enumerate accounts).
  - `filter` — `object` · The bound on which rows the outside can enumerate. REQUIRED for scope "collection", refused for scope "row". A collection portal is never unbounded — "the outside can list this table" is not a feature anybody means to ship; "the outside can list the PUBLISHED posts of THIS author" is. It is forced after any caller-supplied filter, exactly as the tenant and soft-delete scopes are, so nothing a caller sends can widen it, and it is server-stamped on create so a portal cannot write a row outside its own bound.
    - `fieldId` — `string` · **required** · field id of this portal's entity. Must be one of string, number, boolean, enum: a bound has to be an equality somebody can read, and a date bound matches a microsecond while a json bound matches a serialization.
    - `equals` — `string | number | boolean` · **required** · the value the bound column must hold. Its type must match the field’s declared type — a mismatched bound matches nothing in Postgres and everything in a reviewer’s head.
  - `writes` — `array` · **required** · What the outside may WRITE. [] means read-only, and that is the common case. At most one entry per action. A "public" portal may declare "create" (a comment form) but NEVER "update": anonymous update means anyone on the internet may edit a row that already exists, and there is no honest product reason to spell that. There is no "delete" at all — not a declaration, not a spelling, no path. A row-scoped portal may not declare "create", because a create reaches a row that does not exist yet and is therefore outside the bound.
    each item:
    - `action` — `string` · **required** · one of `create`, `update` · "create" or "update". Nothing else exists, and "delete" is absent by construction rather than by omission.
    - `fieldIds` — `array` · **required** · the ONLY fields this write may set, opt-in per field. A payload naming anything else is REFUSED, not silently stripped: a caller who thinks their value landed and finds it did not is worse off than one who got an error. May not name the collection filter's field — the bound is server-stamped on create and immutable on update, exactly as the tenant column is, because a writable bound is a portal that can write a row out of its own filter.
    - `rateLimitPerHour` — `number` · **required** · integer 1–100000, and at most 600 for an unauthenticated ("public") portal. REQUIRED, never defaulted: writes from the outside are always budgeted, and how many an hour is acceptable belongs to whoever owns the table. Enforced at the write op, not at the route — and a host with no limiter wired gets NO portal writes rather than unlimited ones.
  - `layout` — `string` · **required** · one of `detail`, `cards`, `feed`, `table` · presentation ONLY, from theme.set’s block-variant vocabulary — it never affects what is exposed, which is why the exposure report does not mention it. "detail" is required for scope "row" and refused for "collection".
  - `paused` — `boolean` · **required** · whether the surface answers at all. Required, never defaulted. Flip it with portals.pause — the op somebody runs at 3am, which loses nothing.
  - `provenance` — `object` · OPTIONAL — best OMITTED; the server stamps the correct default (accepted). If supplied it must be the full 5-key object.
    - `isSuggested` — `boolean` · **required**
    - `isAccepted` — `boolean | null` · **required** · null = undecided.
    - `isAddedManually` — `boolean | null` · **required**
    - `suggestedDescription` — `string | null` · **required**
    - `priority` — `string` · **required** · one of `medium`, `high`

### `portals.setFields`

Replace a portal’s field projection wholesale, last-wins — THE EXPOSURE EDIT. Its own op so that "what can the outside see?" is answerable from the op name, before reading a single argument, and so a diff that widens a public surface never arrives disguised as a general-purpose edit.

**Arguments**

- `portalId` — `string` · **required** · portal id, prefix "ptl-".
- `readFields` — `array` · **required** · EXACTLY the fields this audience may read — 1–32 field ids (prefix "fld-") of THIS portal's entity, checked against its owner because an id from another entity resolves and would project somebody else's column. There is deliberately NO "expose everything" value and NO exclusion list: an "all except" list silently exposes every field added AFTER it was written, which is the exact failure this layer exists to prevent. The runtime rebuilds each row from this list plus the primary key and drops every other key — including derived values, the soft-delete column and the tenant column. A public or token portal may not name a file field (it holds a storage key, i.e. an object path into the bucket) or a reference to e-user (an identity-table primary key, i.e. a way to enumerate accounts).

### `portals.setWrites`

Replace a portal’s write surface wholesale, last-wins. Separate from portals.setFields because turning on an anonymous create is a different decision from showing one more column, and the two should not share a diff line.

**Arguments**

- `portalId` — `string` · **required** · portal id, prefix "ptl-".
- `writes` — `array` · **required** · What the outside may WRITE. [] means read-only, and that is the common case. At most one entry per action. A "public" portal may declare "create" (a comment form) but NEVER "update": anonymous update means anyone on the internet may edit a row that already exists, and there is no honest product reason to spell that. There is no "delete" at all — not a declaration, not a spelling, no path. A row-scoped portal may not declare "create", because a create reaches a row that does not exist yet and is therefore outside the bound.
  each item:
  - `action` — `string` · **required** · one of `create`, `update` · "create" or "update". Nothing else exists, and "delete" is absent by construction rather than by omission.
  - `fieldIds` — `array` · **required** · the ONLY fields this write may set, opt-in per field. A payload naming anything else is REFUSED, not silently stripped: a caller who thinks their value landed and finds it did not is worse off than one who got an error. May not name the collection filter's field — the bound is server-stamped on create and immutable on update, exactly as the tenant column is, because a writable bound is a portal that can write a row out of its own filter.
  - `rateLimitPerHour` — `number` · **required** · integer 1–100000, and at most 600 for an unauthenticated ("public") portal. REQUIRED, never defaulted: writes from the outside are always budgeted, and how many an hour is acceptable belongs to whoever owns the table. Enforced at the write op, not at the route — and a host with no limiter wired gets NO portal writes rather than unlimited ones.

### `portals.pause`

Take a portal offline, or put it back. The op somebody runs at 3am: it requires removing nothing, so the declaration, the projection and every minted token survive and bringing the surface back is one op rather than a re-review. Also the retire step portals.remove insists on first.

**Arguments**

- `portalId` — `string` · **required** · portal id, prefix "ptl-".
- `paused` — `boolean` · **required** · true stops answering, false answers again. Nothing else changes in either direction.

### `portals.remove`

Remove a portal declaration. Refused while it is not paused — pause it first, so removal is never the fastest way to silence something somebody is mid-way through using, and so the thing that stopped the exposure is the thing that is easy to undo.

**Arguments**

- `portalId` — `string` · **required** · portal id, prefix "ptl-".

## Layer: live

### `live.declare`

Declare a LIVE channel over one entity: whether subscribers receive changed rows or the identities of who is viewing a record, bounded to which rows, carrying exactly which columns, under an explicit subscriber ceiling and per-subscriber message rate. The scope line is deliberately narrow — we push changes and we report presence. There is no event kind, no caller-composed payload and no cursor channel: every message exists because a ROW CHANGED, which is what makes it authorizable per message as a read of that row. Conflict resolution beyond last-write-wins is out by recorded decision (d-live-last-write-wins), not by omission. At most one "query" and one "presence" channel per entity.

**Arguments**

- `subscription` — `object` · **required**
  - `id` — `string` · **required** · branded id, prefix "lv-".
  - `key` — `string` · **required** · the channel name in logs and metrics, the /api/live/<key> URL segment and the generated slot module — the string a person types and an incident report quotes.
  - `description` — `string` · **required** · what this channel is for, in one line. It is printed beside the ceilings in the load report, and a channel nobody can explain is one nobody can decide to pause at 3am.
  - `entityId` — `string` · **required** · entity id, prefix "e-". At most ONE channel of each kind per entity: every write to this table pays for every channel over it, so two would double that cost forever with nothing to say which one a surface should read.
  - `kind` — `string` · **required** · one of `query`, `presence` · "query" = changed ROWS are pushed to whoever may read them, which is what makes a derived list, board or calendar update without a refresh. "presence" = the IDENTITIES currently viewing one record, and nothing else about them. There is no third kind, and in particular none that lets a caller push a payload it composed.
  - `fields` — `array` · **required** · EXACTLY the columns a change notification carries — 1–32 field ids (prefix "fld-") of THIS subscription's entity, checked against its owner because an id from another entity resolves and would push somebody else's column. There is deliberately NO "push everything" value and NO exclusion list: a push is a read, and an "all except" list silently pushes every column added AFTER it was written. Only string, number, boolean, date, enum, json may be pushed: a file field is refused outright, because it holds a storage key, i.e. an object path into the bucket, and putting one on a push hands that URL to everybody holding the channel open, on every write. MUST BE EMPTY for kind "presence": presence reports identities and never row data.
  - `scope` — `object` · **required** · The bound on which rows a subscriber may follow. REQUIRED and never unbounded by omission — a subscription with no bound is a broadcast of the whole table, which is the storm this layer exists to make unspellable. "row" = the one row a subscriber names, and the ONLY legal scope for kind "presence" (presence is "who is viewing THIS record"; anything wider is a live directory of everyone in the app). "filtered" = the rows sharing one column value (a project's tasks, a thread's posts) — the shape that scales, because the fan-out set is a fraction of the table. "all" = every row: legitimate for a small internal ops dashboard, a disaster for a customer-facing list, and therefore capped at 100 subscribers.
    - `kind` — `string` · **required** · one of `row`, `filtered`, `all`
    - `fieldId` — `string` · REQUIRED for kind "filtered", refused otherwise. A field id of this subscription's entity, of type string, number, boolean, enum: a bound has to be an equality somebody can read, and a date bound matches a microsecond while a json bound matches a serialization.
  - `maxSubscribers` — `number` · **required** · integer 1–10000, and at most 100 when the scope is "all". REQUIRED, never defaulted: how many connections this channel may hold open is a decision about somebody's deployment, and a default is that decision made by whoever wrote the generator. A connection over the cap is REFUSED with a stated status rather than queued — a queue for connections is a slower way to run out of file descriptors.
  - `maxMessagesPerMinute` — `number` · **required** · integer 1–600, per subscriber. REQUIRED, never defaulted. A subscriber over it is SHED — disconnected with a reason — rather than buffered: an unbounded buffer is how one slow client takes the process down, and a bounded buffer that silently drops leaves a subscriber whose view is wrong with nothing telling it so. It reconnects and re-reads, which is a correct view rather than a stale one.
  - `presenceTtlSeconds` — `number` · integer 1–300. REQUIRED iff kind is "presence", refused otherwise, and never defaulted: a browser tab that crashed sends no goodbye, and the only thing that ever removes its entry is a TTL somebody chose.
  - `maxPresent` — `number` · integer 1–100. REQUIRED iff kind is "presence", refused otherwise. A cap rather than a page — "212 people are viewing this" is a count, and a list of 212 identities is a directory export with a live feed attached.
  - `slot` — `boolean` · **required** · whether the platform opens a user-owned file for bespoke live UI over this channel. false emits NOTHING and is the honest common case: a derived list, board or calendar simply updates, and the declaration is the whole implementation. true says the surface is genuinely bespoke — a drag-and-drop board, a threaded reader — and the platform’s job is to say where that code goes and never overwrite it.
  - `paused` — `boolean` · **required** · whether the channel accepts connections. Required, never defaulted. Flip it with live.pause — safe to pull precisely because subscribers fall back to polling the ordinary list endpoint, so a paused channel makes the app slower rather than broken.
  - `provenance` — `object` · OPTIONAL — best OMITTED; the server stamps the correct default (accepted). If supplied it must be the full 5-key object.
    - `isSuggested` — `boolean` · **required**
    - `isAccepted` — `boolean | null` · **required** · null = undecided.
    - `isAddedManually` — `boolean | null` · **required**
    - `suggestedDescription` — `string | null` · **required**
    - `priority` — `string` · **required** · one of `medium`, `high`

### `live.setFields`

Replace a live channel’s pushed columns wholesale, last-wins — THE PAYLOAD EDIT. Its own op so that "what does a subscriber actually receive?" is answerable from the op name, before reading a single argument: a push is a read, and what it carries is its own review.

**Arguments**

- `subscriptionId` — `string` · **required** · live subscription id, prefix "lv-".
- `fields` — `array` · **required** · EXACTLY the columns a change notification carries — 1–32 field ids (prefix "fld-") of THIS subscription's entity, checked against its owner because an id from another entity resolves and would push somebody else's column. There is deliberately NO "push everything" value and NO exclusion list: a push is a read, and an "all except" list silently pushes every column added AFTER it was written. Only string, number, boolean, date, enum, json may be pushed: a file field is refused outright, because it holds a storage key, i.e. an object path into the bucket, and putting one on a push hands that URL to everybody holding the channel open, on every write. MUST BE EMPTY for kind "presence": presence reports identities and never row data.

### `live.setLimits`

Replace a live channel’s two ceilings — THE LOAD LEVER, the op an operator reaches for when a channel is the reason the app is slow. Separate from live.setFields because "we are sending too much" and "we are sending the wrong thing" are different problems found by different people. Both values are restated together rather than patched individually: they multiply into the load the process actually carries, and adjusting one without the other is how the product of the two stops being something anybody reviewed.

**Arguments**

- `subscriptionId` — `string` · **required** · live subscription id, prefix "lv-".
- `maxSubscribers` — `number` · **required** · integer 1–10000, and at most 100 when the scope is "all". REQUIRED, never defaulted: how many connections this channel may hold open is a decision about somebody's deployment, and a default is that decision made by whoever wrote the generator. A connection over the cap is REFUSED with a stated status rather than queued — a queue for connections is a slower way to run out of file descriptors.
- `maxMessagesPerMinute` — `number` · **required** · integer 1–600, per subscriber. REQUIRED, never defaulted. A subscriber over it is SHED — disconnected with a reason — rather than buffered: an unbounded buffer is how one slow client takes the process down, and a bounded buffer that silently drops leaves a subscriber whose view is wrong with nothing telling it so. It reconnects and re-reads, which is a correct view rather than a stale one.

### `live.pause`

Take a live channel offline, or put it back. The 3am lever: it removes nothing, so the declaration, the projection and both ceilings survive and bringing the channel back is one op rather than a re-review. Safe to pull because subscribers fall back to polling the ordinary list endpoint — a paused channel makes the app slower, not broken. Also the retire step live.remove insists on first.

**Arguments**

- `subscriptionId` — `string` · **required** · live subscription id, prefix "lv-".
- `paused` — `boolean` · **required** · true stops accepting connections and closes the open ones; false starts answering again. The declaration is untouched either way.

### `live.remove`

Remove a live declaration. Refused while it is not paused — pause it first, confirm the polling fallback carried the surface, then remove, so removal is never the fastest way to silence something somebody is mid-way through using.

**Arguments**

- `subscriptionId` — `string` · **required** · live subscription id, prefix "lv-".

## Layer: view

### `view.addAction`

Declare a LIST ACTION over one entity: a named, capped, role-gated write a user runs from a list — on one row, on a ticked selection, or both. THE ONE OP IN THE VOCABULARY THAT LETS ONE CLICK WRITE TO MANY ROWS. It is declared on the entity rather than on a page for the reason a WIP limit lives on the field rather than on the board: a rule the screen enforces is one an agent driving REST or MCP walks straight past, so the endpoint, the MCP tool and the toolbar are three doors onto one server operation. The selection is the ids the caller sent — there is deliberately no "everything matching the current filter" spelling. Every row is written through the ordinary update path, so tenant scope, per-value limits, validation, the row audit entry and the live publish all apply unchanged and cannot drift. No delete, no create, no side effect: those are different primitives and an action whose declaration does not say what it does is worse than no action.

**Arguments**

- `action` — `object` · **required**
  - `id` — `string` · **required** · branded id, prefix "act-".
  - `key` — `string` · **required** · the action name in the /api/<resource>/actions/<key> URL, the audit row and the MCP tool name — the string a person types and an incident report quotes. Separate from label because a reworded button must not move an endpoint.
  - `label` — `string` · **required** · the text on the button.
  - `description` — `string` · **required** · what this action is for, in one line. It is printed beside the write in the action report, and a button that changes hundreds of rows and that nobody can explain is one nobody can decide to remove.
  - `entityId` — `string` · **required** · entity id, prefix "e-". SEVERAL actions per entity is expected — triage, archive and assign are three buttons over one table.
  - `arity` — `string` · **required** · one of `row`, `selection`, `both` · "row" = a control on each row, one id at a time. "selection" = a toolbar over ticked rows. "both" = offered in both places. A declaration rather than an inference from maxSelection: "this may be run on many rows" and "this should have a button on every row" are different product decisions.
  - `effect` — `object` · **required** · what the action WRITES, stated in full — never a payload the caller composes, because an action that let its caller pick the fields would be a PATCH with a button and its declaration would say nothing a reviewer could act on. "set" maps fieldId → a LITERAL (string, number, boolean, or null meaning "clear this column"); at most 8 fields, and past that an action stops being a list control and becomes a migration wearing a button. "choose" names at most ONE enum field whose value the operator picks when they run it, from that field's own declared options — which is what makes "move this deal's stage" one declaration instead of one per stage, while keeping the set of producible values finite and stated in the spec. At least one of the two must contribute. There is deliberately no expression, no now(), and no reference to the row's other columns: the moment a value is computed, the declaration stops being reviewable by reading it. A rank key, a file field and a json field may not be written; the tenant and soft-delete columns need no rule here because the update path strips them from every payload it is given.
    - `set` — `object` · **required** · fieldId → literal value. May be empty only when "choose" is present.
    - `choose` — `string` · field id, prefix "fld-", of an enum field WITH declared options. Its options are the entire bound on what values a run can produce, so an enum without them is free text wearing a dropdown and is refused.
  - `role` — `string` · an EXTRA role the caller must hold, beyond being allowed to update the entity at all. Omit it to mean "whoever may update this entity" — which is not a hole, because an action can never do something its caller could not do row by row. What a role adds is the BATCH being privileged even when the individual writes are not.
  - `maxSelection` — `number` · **required** · integer 1–500. REQUIRED, never defaulted: how many rows one click may rewrite is a decision about somebody's data, and a default is that decision made by whoever wrote the generator. A run over the cap is REFUSED WHOLE rather than truncated to the first N — truncation would silently do part of what somebody asked for and report success. 1 is meaningful and is the right value for a row-arity action: it says the operation is per-row by construction, so a caller posting twelve ids to the endpoint is refused by the declaration rather than by the UI not having offered a checkbox. When somebody needs five thousand, the answer is a schedule, not a bigger number here.
  - `undoable` — `boolean` · **required** · whether the run records what it overwrote. true stores the prior value of exactly the fields written, per row, which is what makes the run reversible — the undo replays those values back through the ordinary update path rather than through a privileged rollback. Required, never defaulted: the record is proportional to the selection, so it is a storage decision as much as a product one, and false is the honest spelling of "this cannot be taken back".
  - `provenance` — `object` · OPTIONAL — best OMITTED; the server stamps the correct default (accepted). If supplied it must be the full 5-key object.
    - `isSuggested` — `boolean` · **required**
    - `isAccepted` — `boolean | null` · **required** · null = undecided.
    - `isAddedManually` — `boolean | null` · **required**
    - `suggestedDescription` — `string | null` · **required**
    - `priority` — `string` · **required** · one of `medium`, `high`

### `view.setActionEffect`

Replace a list action’s write wholesale, last-wins — THE PAYLOAD EDIT. Its own op so that "what does this button actually do to a row?" is answerable from the op name, before reading a single argument. Wholesale rather than patched: a write set is only correct as a whole, and a patch language would let one be half-migrated between two reviews — which for a write means a button that sets the new status and leaves the old assignee.

**Arguments**

- `actionId` — `string` · **required** · action id, prefix "act-".
- `effect` — `object` · **required** · what the action WRITES, stated in full — never a payload the caller composes, because an action that let its caller pick the fields would be a PATCH with a button and its declaration would say nothing a reviewer could act on. "set" maps fieldId → a LITERAL (string, number, boolean, or null meaning "clear this column"); at most 8 fields, and past that an action stops being a list control and becomes a migration wearing a button. "choose" names at most ONE enum field whose value the operator picks when they run it, from that field's own declared options — which is what makes "move this deal's stage" one declaration instead of one per stage, while keeping the set of producible values finite and stated in the spec. At least one of the two must contribute. There is deliberately no expression, no now(), and no reference to the row's other columns: the moment a value is computed, the declaration stops being reviewable by reading it. A rank key, a file field and a json field may not be written; the tenant and soft-delete columns need no rule here because the update path strips them from every payload it is given.
  - `set` — `object` · **required** · fieldId → literal value. May be empty only when "choose" is present.
  - `choose` — `string` · field id, prefix "fld-", of an enum field WITH declared options. Its options are the entire bound on what values a run can produce, so an enum without them is free text wearing a dropdown and is refused.

### `view.removeAction`

Remove a list action. Unlike portals.remove and live.remove there is no pause step first, and the asymmetry is deliberate: a portal and a live channel are surfaces somebody may be mid-way through using, so removal must not be the fastest way to silence one. An action is a button — removing it takes a capability away, which fails closed, so a two-step ritual would buy nothing and would leave the dangerous declaration in place for the length of it.

**Arguments**

- `actionId` — `string` · **required** · action id, prefix "act-".

## Layer: system

### `provenance.review`

Accept or reject a suggestion, or reset a settled row back to undecided (a provenance transition, logged for audit — reject is a soft-reject, never a delete, and reset is the undo for an accepted batch). With cascade:true the decision also covers the target’s still-undecided nested rows (fields/blocks); a cascading reset instead covers its settled ones, since those are what an undo has to take back. Never touches a manual row.

**Arguments**

- `target` — `object` · **required**
  - `kind` — `string` · **required** · one of `entity`, `field`, `page`, `block`, `tier`, `flag`, `schedule`, `source`, `searchIndex`, `portal`, `action`
  - `id` — `string` · **required** · the reviewed row’s id.
  - `parentId` — `string` · required for nested kinds — the entity id of a field, the page id of a block.
- `action` — `string` · **required** · one of `accept`, `reject`, `reset`
- `cascade` — `boolean` · also decide the target’s still-undecided nested rows (fields/blocks).
