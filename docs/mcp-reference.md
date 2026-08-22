<!-- GENERATED FILE — DO NOT EDIT BY HAND.
     Source: `platformTools()` in `packages/mcp/src/tools.ts`
     Regenerate: pnpm docs:reference   (the validate gate checks this is current) -->

# MCP reference

The 15 **platform tools** a spec-driving agent uses. They are the same
surface the CLI write verbs sit on, so an agent and a human are making
genuinely the same changes — reviewed the same way, logged the same way.

## Connecting

`maxstack init` scaffolds a `.mcp.json` that registers the server over
**stdio**, so the client spawns it and the tools are present in every session
— no port, no ordering against `maxstack dev`:

```json
{ "mcpServers": { "maxstack": { "command": "maxstack", "args": ["mcp"] } } }
```

Tools then appear as `mcp__maxstack__<name>`. If they are absent (a session
that started before the project existed, or a client without MCP), the
sanctioned fallback is the CLI — `maxstack op`, `add-entity`, `add-field`,
`add-page`, `theme` reach the identical op path. See
[`cli-reference.md`](cli-reference.md).

## The loop

1. `query_spec` — read the project, including `{section:"ops"}` for the full
   op vocabulary, and `{section:"ops", ops:[…]}` for the arg schemas of the
   ops you name.
2. `propose_spec_change` — validate + diff a typed op. **Never writes.**
3. `apply_spec_change` — land it (re-validated server-side; rejects anything
   that would break referential integrity).
4. `run_generator` → `run_checks` — turn the spec change into code, then prove
   the gate is green.

Only `apply_spec_change` and `record_decision` mutate, and both go through the
same validator, so a broken spec cannot land.

## Tools

3 of these are **host-gated**: they are present only when the host wired
the provider behind them, so a session may legitimately not see them. That is a
fact about your host, not about the vocabulary — each says below what it needs.
They were missing from this page entirely for a while, because it was
generated against a context with no optional providers.

### `init`

CALL THIS FIRST, before anything else, in every session. One call for the whole picture: what this project is, every entity, page, requirement and slot it declares, the API it serves, every spec-op there is by name, layer and one-line summary (the arg schemas are one query_spec {section:"ops", ops:[…]} away — see `vocabulary`), the generators and checks available here, the installable bundle catalog, and what is already pending review. It answers "what am I working on, and what could I be using that I do not know exists?" — which is otherwise eight separate query_spec/browse_catalog/review_queue calls, and in practice does not get asked at all, because an agent that reads a summary stops there and hand-builds what a bundle would have given it. Anything this host cannot answer is NAMED in `unavailable` rather than omitted, so a thin host's short report can never be mistaken for a complete one. Optionally pass `ops` — a whole batch of typed spec-ops validated as one unit, each against the spec the previous ones would produce, so `data.addEntity` plus its eight `data.addField`s is ONE call instead of nine. The batch is all-or-nothing (one op refuses, nothing is written) and reports ONE merged app-shaped `effect` for the chain rather than an unreadable pile of per-op ones. `apply` defaults to false: without it nothing is written and you get the effect to consent to first. Because that is two calls over the same batch, a call carrying `ops` answers about the batch and TRIMS the orientation you already have — `data`, `pages`, `slots`, `api`, `vocabulary` and `catalog` come back omitted, named in `omitted` rather than silently missing, and `effect` describes what the batch moved. Call init with no `ops` whenever you want the whole picture again. This does NOT scaffold a project — `maxstack init` is the human's entry point and this tool only ever runs inside a project that already exists.

**Input**

- `ops` — `array` · An opening batch of typed spec-ops, in order, each {op, args} exactly as propose_spec_change takes one. Validated as a unit against the running projection, so later ops may depend on earlier ones. All-or-nothing.
  each item:
  - `op` — `string` · **required** · one of `prd.addRequirement`, `prd.addScopeItem`, `prd.addRisk`, `prd.addMetric`, `prd.recordDecision`, `data.addEntity`, `data.addField`, `data.setFieldReference`, `data.setFieldOpenReference`, `data.setFieldLimits`, `data.setFieldDisplay`, `data.setFieldFilter`, `data.addComputed`, `data.addRollup`, `page.addPage`, `page.addBlock`, `page.setBlockOrder`, `page.setBlockVariant`, `page.setBlockFields`, `page.setBlockEditable`, `page.setBlockCreatable`, `page.setE2ETests`, `page.addCalendar`, `page.addTimeline`, `page.addBoard`, `page.addAggregate`, `pricing.addTier`, `theme.set`, `site.set`, `access.defineRole`, `access.defineGroup`, `access.grant`, `access.revoke`, `access.bindRole`, `access.setDefault`, `flags.declare`, `flags.setTargeting`, `flags.gate`, `flags.remove`, `schedules.declare`, `schedules.setRecurrence`, `schedules.pause`, `schedules.remove`, `sources.declare`, `sources.setMapping`, `sources.setLimits`, `sources.pause`, `sources.remove`, `search.declare`, `search.setFields`, `search.setIndexing`, `search.remove`, `documents.declare`, `documents.setSections`, `documents.setDelivery`, `documents.remove`, `imports.declare`, `imports.setMapping`, `imports.setUpsertKey`, `imports.pause`, `imports.remove`, `portals.declare`, `portals.setFields`, `portals.setWrites`, `portals.pause`, `portals.remove`, `live.declare`, `live.setFields`, `live.setLimits`, `live.pause`, `live.remove`, `view.addAction`, `view.setActionEffect`, `view.removeAction`, `provenance.review` · The spec-op name. Call query_spec {section:"ops"} for the full vocabulary — every op's layer and summary — and query_spec {section:"ops", ops:[...]} for the JSON Schema of the args of the ones you name.
  - `args` — `object` · **required** · The op-specific arguments (e.g. data.addField needs {entityId, field:{id,name,type,required}}, where field.type is one of string|number|boolean|date|enum|json — use "string" for text, not "text"). On add-op rows, provenance is optional and best OMITTED — the server stamps the correct default; if supplied it must be the full {isSuggested, isAccepted, isAddedManually, suggestedDescription, priority} object. Structural ops are additive, except the set-ops: page.setBlockOrder retunes an existing table block's {pageId, blockId, order:{field, direction}}; page.setBlockVariant sets its presentation {pageId, blockId, variant: "table"|"cards"|"feed"}; page.setBlockFields picks which entity fields it renders and in what order {pageId, blockId, fields:["title","rating",…]} (first = the title column); theme.set replaces the whole app theme {theme:{preset, accent?, radius?, density?, font?, typeScale?}} (last-wins).
- `apply` — `boolean` · With `ops`: commit the batch (default false — validate, diff and report the merged effect, writing nothing). Applied rows land ACCEPTED with AI provenance and go live immediately; they are not queued for review, so say this out loud rather than defaulting into it.
- `with` — `array` · Bundle slugs to preview installing, as browse_catalog {preview} would. Nothing is installed.
- `vocabulary` — `string` · one of `summary`, `full` · How much of the op vocabulary to return. "summary" (default) is every op's name, layer and one-line summary — what you need to know an op EXISTS — and costs about a sixth of "full", which adds the JSON Schema for every op's args. Prefer the default: "full" is ~113k characters and most hosts REFUSE a response that size. You never have to guess an arg shape either way, because query_spec {section:"ops", ops:["page.addPage", ...]} returns the schemas for the ops you name, a handful at a time. Only an orienting call returns a vocabulary at all: a call carrying `ops` omits it either way.

### `query_spec`

Read the project spec, or the API generated from it. Pick a section; "summary" gives counts + title, "ops" lists the spec-op vocabulary you can propose — pass `ops` alongside it to get the JSON Schema for those ops' args, so you never have to guess the arg shape — "requirements" lists ids + user stories + acceptance criteria, "data" lists the entities and their fields as the SPEC declares them, "api" is what a CLIENT talks to (per resource: the REST routes, plus a JSON Schema for the POST body and for the PATCH body, including which fields accept null to clear them) so you never have to probe a running server, "pages" lists the declared pages and — beside each — the contract of the page's OWN routes (`<route>`, `<route>/new`, `<route>/parse`, `<route>/:id`) with the payload shape each one accepts, so driving the app the way a USER does needs no probing either, and "slots" lists every place bespoke UI can be written *without* ejecting (page-level extension slots plus the derived block-level slots, with the typed props each one receives).

**Input**

- `section` — `string` · one of `summary`, `product`, `requirements`, `data`, `pages`, `pricing`, `ledger`, `oplog`, `ops`, `theme`, `slots`, `api` · Which slice of the spec to return (default "summary").
- `ops` — `array` · With section "ops": the op names whose full arg JSON Schema you want, e.g. ["page.addPage","data.addField"]. Ask for the handful you are about to use — every schema at once is ~113k characters and hosts refuse a response that size. Omit it to get every op's name, layer and summary without the schemas.

### `workbench`

What needs you, in order, worst first — the answer to "what should I look at?" rather than a list of panels to check. Public exposure that would change ranks above a removal, which ranks above a proposal that cannot be batched, which ranks above drift, which ranks above the routine majority (collapsed into one line, because the routine rows are what the surface exists to make cheap). Every item carries WHY it outranks the next one, and names specific rows rather than a count — nobody can act on a badge. Categories this host cannot evaluate are listed in `unavailable` and the headline refuses to say "nothing needs you" when something went unchecked, because an empty report from a surface that could not look reads exactly like an all-clear from one that did. Read-only. Section `exposure` returns every publicly-reachable field plus the declared-but-not-live portals that are one op away from being public; section `blast-radius` takes a `target` and reports what accepting it does to the built application — which tables, columns, routes, forms, REST payloads and public fields appear, change or STOP EXISTING — because a spec diff under-describes the blast radius and blast radius is what is actually being decided on.

**Input**

- `section` — `string` · one of `attention`, `exposure`, `blast-radius` · Which view to return (default "attention" — the ordered what-needs-you list).
- `target` — `object` · For section "blast-radius": the pending proposal to explain, as {kind, id, parentId?}. Omit to report the effect of accepting everything pending.

### `review_queue`

The review queue: every proposal still undecided, each with a risk classification and the reasons behind it, grouped into the batches that could be cleared in one decision. Also reports which proposals can NEVER be batched (access control, destructive changes, anything the model does not understand) and why. READ-ONLY, and deliberately so: this tool will not accept or reject anything. An agent settling its own proposals is not review, it is a rubber stamp with a protocol in front of it — so use this to tell the maintainer what is waiting and how cheaply it could be cleared ("12 routine fields on Order batch as field:e-order; viewerRole needs you"), and leave the decision to `maxstack review --accept <selector>` or the workbench pane. Risk here is conservative by construction: it starts at high and only known-safe patterns lower it, so an unfamiliar proposal reads as needing attention rather than as fine.

**Input**

_No arguments._

### `ownership_drift`

Report what the maintainer owns — ejected files and filled slots — what each was derived from, and how far behind the current derivation it has drifted, with a unified diff per drifted file. Read-only and non-prescriptive: nothing is applied, and drift is not an error. An ejected file that has diverged is a file doing what ejecting it was for; a filled slot is reported as "authored" because the generator seeded it once and never derives it again. Use this to answer "what am I missing by owning this?" before proposing an eject, and after a bundle upgrade to see what moved underneath a file the platform is not allowed to touch.

**Requires** `context.ownership` — a host with a filesystem, since drift compares files on disk against their derivation. `maxstack mcp` has one; a remote host may not.

**Input**

_No arguments._

### `review_cost`

What approving a change costs the maintainer: engaged time per proposal (attention, with gaps over the idle cutoff excluded), separated from wall-clock elapsed time and never blended with it. Returns the summary, the per-decision rows and the cumulative curve, or null when the project has not opted in — null means nobody measured, NOT that review is free. Read-only. This is the human half of "minutes, not hours": a platform that lands a change in seconds and costs its maintainer twenty minutes to approve has not made anything faster. Use it to check whether the review surface is staying cheap as a project grows, and never as a target for how fast a person should review.

**Requires** `context.reviewCost` — a project that opted into review-cost telemetry. Absent means nobody measured, which is not the same as review being free.

**Input**

_No arguments._

### `browse_catalog`

Browse the installable feature-bundle catalog, and preview what installing one would do. With no arguments: every module with its title, one-line description, transitive prerequisites, what it contributes, and — inside a project — what is installed and what could be upgraded. With `preview: ["billing"]`: the exact spec ops the install would apply, the prerequisites it would pull in that you did not ask for, and any reason it would be refused. Nothing is written; installing is `maxstack add <slug>` (or the previewed ops as one `init {ops, apply: true}` batch — an install is always several ops, so a loop over apply_spec_change is the slow way to the same place).

**Requires** `context.catalog` — a host that wired the bundle catalog, since `@maxstack/mcp` deliberately does not import `@maxstack/features`.

**Input**

- `preview` — `array` · Bundle slugs to preview installing, in order. Omit to list the catalog.

### `propose_spec_change`

Validate + diff a typed spec-op WITHOUT applying it (the "suggest" half of suggest→accept). Returns {valid, errors, diff, effect, warnings, next}. `diff` is spec-shaped — what the document would say; `effect` is app-shaped — which tables, columns, routes, forms, REST payloads and public fields would appear, change or STOP EXISTING if you applied it, and it can say the op would change nothing anyone can see. ONE op: a multi-op change belongs in `init {ops}`, which validates the whole chain against the running projection and reports one merged effect — this tool is for the single op you are refining. Always propose before apply, on EITHER path: `init`'s `apply: false` default IS the propose half, so this is not an instruction to spend two calls per op.

**Input**

- `op` — `string` · **required** · one of `prd.addRequirement`, `prd.addScopeItem`, `prd.addRisk`, `prd.addMetric`, `prd.recordDecision`, `data.addEntity`, `data.addField`, `data.setFieldReference`, `data.setFieldOpenReference`, `data.setFieldLimits`, `data.setFieldDisplay`, `data.setFieldFilter`, `data.addComputed`, `data.addRollup`, `page.addPage`, `page.addBlock`, `page.setBlockOrder`, `page.setBlockVariant`, `page.setBlockFields`, `page.setBlockEditable`, `page.setBlockCreatable`, `page.setE2ETests`, `page.addCalendar`, `page.addTimeline`, `page.addBoard`, `page.addAggregate`, `pricing.addTier`, `theme.set`, `site.set`, `access.defineRole`, `access.defineGroup`, `access.grant`, `access.revoke`, `access.bindRole`, `access.setDefault`, `flags.declare`, `flags.setTargeting`, `flags.gate`, `flags.remove`, `schedules.declare`, `schedules.setRecurrence`, `schedules.pause`, `schedules.remove`, `sources.declare`, `sources.setMapping`, `sources.setLimits`, `sources.pause`, `sources.remove`, `search.declare`, `search.setFields`, `search.setIndexing`, `search.remove`, `documents.declare`, `documents.setSections`, `documents.setDelivery`, `documents.remove`, `imports.declare`, `imports.setMapping`, `imports.setUpsertKey`, `imports.pause`, `imports.remove`, `portals.declare`, `portals.setFields`, `portals.setWrites`, `portals.pause`, `portals.remove`, `live.declare`, `live.setFields`, `live.setLimits`, `live.pause`, `live.remove`, `view.addAction`, `view.setActionEffect`, `view.removeAction`, `provenance.review` · The spec-op name. Call query_spec {section:"ops"} for the full vocabulary — every op's layer and summary — and query_spec {section:"ops", ops:[...]} for the JSON Schema of the args of the ones you name.
- `args` — `object` · **required** · The op-specific arguments (e.g. data.addField needs {entityId, field:{id,name,type,required}}, where field.type is one of string|number|boolean|date|enum|json — use "string" for text, not "text"). On add-op rows, provenance is optional and best OMITTED — the server stamps the correct default; if supplied it must be the full {isSuggested, isAccepted, isAddedManually, suggestedDescription, priority} object. Structural ops are additive, except the set-ops: page.setBlockOrder retunes an existing table block's {pageId, blockId, order:{field, direction}}; page.setBlockVariant sets its presentation {pageId, blockId, variant: "table"|"cards"|"feed"}; page.setBlockFields picks which entity fields it renders and in what order {pageId, blockId, fields:["title","rating",…]} (first = the title column); theme.set replaces the whole app theme {theme:{preset, accent?, radius?, density?, font?, typeScale?}} (last-wins).

### `apply_spec_change`

Apply a typed spec-op to the spec (the "accept" half — applied rows land accepted with AI provenance and go live in the running app immediately). Re-validates server-side and rejects any op that would break referential integrity; logs it to the op-log with provenance. Returns {applied, diff, effect, warnings, next}. READ `effect` and `warnings` before you report what you changed — `diff` is spec-shaped and cannot tell you that what you applied changes nothing a user can see (a shadowed block, an unbuilt app, a row nothing has accepted yet). `effect.changesBuiltApp === false` means the document moved and the application did not; `null` means this layer is outside what the surface inventory models, which is not the same as "no effect". ONE op: a multi-op change belongs in `init {ops, apply: true}` — one all-or-nothing call, one merged effect, each op validated against the spec the previous ones would produce — rather than a loop over this tool; this is for the single op you are refining.

**Input**

- `op` — `string` · **required** · one of `prd.addRequirement`, `prd.addScopeItem`, `prd.addRisk`, `prd.addMetric`, `prd.recordDecision`, `data.addEntity`, `data.addField`, `data.setFieldReference`, `data.setFieldOpenReference`, `data.setFieldLimits`, `data.setFieldDisplay`, `data.setFieldFilter`, `data.addComputed`, `data.addRollup`, `page.addPage`, `page.addBlock`, `page.setBlockOrder`, `page.setBlockVariant`, `page.setBlockFields`, `page.setBlockEditable`, `page.setBlockCreatable`, `page.setE2ETests`, `page.addCalendar`, `page.addTimeline`, `page.addBoard`, `page.addAggregate`, `pricing.addTier`, `theme.set`, `site.set`, `access.defineRole`, `access.defineGroup`, `access.grant`, `access.revoke`, `access.bindRole`, `access.setDefault`, `flags.declare`, `flags.setTargeting`, `flags.gate`, `flags.remove`, `schedules.declare`, `schedules.setRecurrence`, `schedules.pause`, `schedules.remove`, `sources.declare`, `sources.setMapping`, `sources.setLimits`, `sources.pause`, `sources.remove`, `search.declare`, `search.setFields`, `search.setIndexing`, `search.remove`, `documents.declare`, `documents.setSections`, `documents.setDelivery`, `documents.remove`, `imports.declare`, `imports.setMapping`, `imports.setUpsertKey`, `imports.pause`, `imports.remove`, `portals.declare`, `portals.setFields`, `portals.setWrites`, `portals.pause`, `portals.remove`, `live.declare`, `live.setFields`, `live.setLimits`, `live.pause`, `live.remove`, `view.addAction`, `view.setActionEffect`, `view.removeAction`, `provenance.review` · The spec-op name. Call query_spec {section:"ops"} for the full vocabulary — every op's layer and summary — and query_spec {section:"ops", ops:[...]} for the JSON Schema of the args of the ones you name.
- `args` — `object` · **required** · The op-specific arguments (e.g. data.addField needs {entityId, field:{id,name,type,required}}, where field.type is one of string|number|boolean|date|enum|json — use "string" for text, not "text"). On add-op rows, provenance is optional and best OMITTED — the server stamps the correct default; if supplied it must be the full {isSuggested, isAccepted, isAddedManually, suggestedDescription, priority} object. Structural ops are additive, except the set-ops: page.setBlockOrder retunes an existing table block's {pageId, blockId, order:{field, direction}}; page.setBlockVariant sets its presentation {pageId, blockId, variant: "table"|"cards"|"feed"}; page.setBlockFields picks which entity fields it renders and in what order {pageId, blockId, fields:["title","rating",…]} (first = the title column); theme.set replaces the whole app theme {theme:{preset, accent?, radius?, density?, font?, typeScale?}} (last-wins).

### `run_generator`

Run a code generator against the current spec. This is how spec changes become code. Returns {generator, artifacts, notes} — and WHICH of the two carries the result depends on the host, so read both. A host that cannot write (the web workbench) returns the files as data in `artifacts` ({path, content}) for review. A disk-backed host (the CLI over stdio) has already LANDED them, never-clobber, and reports one line per file in `notes` ("created:", "overwritten:", "appended:", "unchanged:", "skipped-user-owned:", "wrote:") with `artifacts` EMPTY — because echoing back content that is already on disk is a second copy of the same bytes with no reader. An empty `artifacts` therefore does NOT mean nothing was generated; on stdio it is the normal, successful shape, and `notes` is the record of what changed.

**Input**

- `generator` — `string` · **required** · one of `page`, `docs`, `e2e-tests` · Which generator to run.
- `args` — `object` · Optional generator arguments.

### `run_checks`

Run the validate gate. Omit "checks" to run all. Returns {ok, status, ran, results, unavailable, headline}. `ok` is true ONLY when every check this host knows about actually ran and passed: anything that could not run is listed in `unavailable` with a reason and a remedy, and `status` is then "incomplete", never a green. The one exception is an entry marked `blocking: false`, which had nothing to examine (a project with no owned code yet) — still named, but it does not withhold the green. Read `unavailable` before calling a change done — a check that never executed reads exactly like one that passed, and unexamined code is how a typecheck gets skipped for a whole session.

**Input**

- `checks` — `array` · Which checks to run (default all). Available: spec-validate.

### `explain_feature`

Project-tailored explanation of one feature: pass a requirementId (r-…), entityId (e-…), or pageId (pg-…) and get its user story, acceptance criteria, edge cases, and cross-layer links.

**Input**

- `requirementId` — `string` · e.g. "r-login".
- `entityId` — `string` · e.g. "e-order".
- `pageId` — `string` · e.g. "pg-checkout".

### `list_acceptance_criteria`

The acceptance criteria to build/verify against. Pass a requirementId for one; omit it for every requirement.

**Input**

- `requirementId` — `string` · A single r-… id, or omit for all.

### `record_decision`

Append a decision THIS PROJECT made to the append-only ledger (options + recommendation + choice + rationale). Convenience wrapper over the prd.recordDecision spec-op. Omit chosenOptionId to record a still-pending decision. Append-only: an entry written here cannot be taken back, so it is the wrong home for anything you are not choosing on purpose. A maxstack bug, a workaround for one, or "the framework did the wrong thing so I did X" is a DEFECT — use report_defect, which is built for it.

**Input**

- `id` — `string` · **required** · Decision id (d-…).
- `question` — `string` · **required**
- `options` — `array` · **required** · Each option: {id, description, pros[], cons[]}.
- `recommendedOptionId` — `string`
- `chosenOptionId` — `string` · Omit to leave the decision pending.
- `rationale` — `string` · **required**

### `report_defect`

Report a defect in maxstack ITSELF — the platform, its generated code, its CLI, its API or its docs. Use this the moment you hit one, while you still have the facts: the call you made, what you expected, what happened, and the workaround you used. This is NOT record_decision: a framework bug is not an architectural choice, and writing one into the append-only decision ledger both pollutes the ledger and loses the report. Use record_decision for a choice this PROJECT made; use this for "the platform did the wrong thing". Nothing about your spec or your app changes — this only files the report. Whether it is actually PERSISTED depends on the host, so read `recorded`: the CLI over stdio has a defect sink and answers `{recorded: true, where}`; a host without one (the web workbench) answers `{recorded: false, where: null}` with the filled-in `report` returned in full for you to carry upstream yourself. This tool is listed on every host regardless, because an agent with nowhere to put a defect puts it somewhere wrong.

**Input**

- `title` — `string` · **required** · One line, specific: "PATCH rejects null on a nullable column", not "update is broken".
- `surface` — `string` · **required** · one of `mcp`, `rest-api`, `cli`, `runtime`, `generated-code`, `docs`, `other` · Which part of the platform misbehaved.
- `severity` — `string` · **required** · one of `blocks`, `workaround`, `annoyance` · blocks = there is no way through; workaround = you got past it but paid; annoyance = it cost you nothing but is wrong.
- `what` — `string` · **required** · What you did, concretely enough to reproduce: the exact tool call, request or command.
- `expected` — `string` · **required** · What should have happened.
- `actual` — `string` · **required** · What actually happened — paste the real error or output, not a paraphrase.
- `workaround` — `string` · What you did instead, if anything. Optional, and worth more than it looks: it is the evidence of what the defect actually cost.
