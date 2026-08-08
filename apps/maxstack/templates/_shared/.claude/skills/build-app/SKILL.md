---
name: build-app
description: The default path for building or changing anything in this maxstack app — turning a plain-language request ("build a reading list app", "add tags to posts", "add a page for X", "make it look beautiful", "let users share it") into spec ops, regenerated code, and honest verification. Use BEFORE writing any application code, whenever asked to build, create, add, change, restyle, or extend any app, feature, page, screen, entity, field, or UI in this project.
---

# build-app

This project's app is **generated from a typed spec**. You build it by changing
the spec, not by writing route files. The generated tree under `app/` is
overwritten on every regeneration, and a PreToolUse hook will refuse edits to it
— so going around this loop doesn't work, it just fails later and louder.

Tools appear as `mcp__maxstack__*`. They come from a stdio server your client
spawns itself, so they're in every session; nothing needs to be running first.
(If they're genuinely absent, see `/plan-and-scope` → "If the tools are absent"
for the CLI equivalents — same validated op path.)

## The loop

**1. `init` first.** One call, once per session, before anything else. It
returns what's already here — entities, pages, requirements, slots, the API —
*and* what you could be using and probably don't know exists: every spec-op by
name, and the installable bundles. Never assume the spec is empty, never assume
what's in it, and never hand-build something the catalog already ships. Anything
this host couldn't answer is named in `unavailable`; that means unknown, not
absent.

**2. Model the data.** One entity per noun the user described, with the fields
that noun actually needs. Send them as a **batch** — `init {ops:[…]}` takes the
whole list, validates each op against what the previous ones would produce (so
`data.addEntity` and its eight `data.addField`s go together), and reports one
merged `effect` for the chain. It writes nothing until you add `{apply: true}`,
which is your chance to read that effect first. One op at a time is
`apply_spec_change {op:"data.addEntity", args:{…}}`; the CLI sugar is `maxstack
add-entity <slug> --field title:text!`.

A batch is all-or-nothing: one bad op and *nothing* lands, including the ops
before it. Fix that op and resend the whole list.

A batch reply answers about the batch. The orientation blocks step 1 gave you —
`data`, `pages`, `slots`, `api`, `vocabulary`, `catalog` — come back omitted
rather than re-sent, named in `omitted` so absent never reads as empty. Call
`init` with no `ops` when you want the whole picture again.

The canonical field types are exactly six — `string` · `number` · `boolean` ·
`date` · `enum` · `json`. Raw ops accept **only** these. The CLI `--field` DSL
also takes aliases it folds into them (`text`→`string`, `int`/`float`→`number`,
`bool`→`boolean`, `datetime`→`date`). `text` is sugar, not a type: a raw op
carrying it is rejected. DSL shape is `name:type`, `!` for required,
`enum(a,b,c)` for options, `ref:e-other` (or `->e-other`) for a reference.

When you shell out, **quote any spec carrying `(` or `->`** — both are shell
syntax. Unquoted `owner:->e-user` is the word `owner:-` plus a redirect that
writes an empty file named `e-user`, and the error you get back names a field
type `-` you never typed. `maxstack add-entity bottle --field title:text!
--field 'status:enum(todo,done)' --field owner:ref:e-user`.

Don't go spelunking for this. `query_spec {section:"ops"}` returns the full
vocabulary — every op's name, layer and summary — and
`query_spec {section:"ops", ops:["data.addField", …]}` returns the argument
JSON Schema for the handful you name. Ask for the ones you're about to use:
every schema at once is a payload hosts refuse.

**3. Add the pages.** `page.addPage` per screen the user asked for (`maxstack
add-page <entity>`). An entity with no page isn't reachable in the app.

**4. Regenerate.** `run_generator {generator:"page"}` (or `maxstack gen`). Under
this project's default `reviewMode: "auto"` a CLI write already lands, accepts
and regenerates on its own — including yours, because the mode keys off the
write path and not the author. If `maxstack.json` says `reviewMode: "review"`,
CLI writes queue instead and need `--accept --gen` to land, accept and
regenerate in one shot; say so when you report what you changed, because then
your work is waiting in `/workbench` rather than live.

**5. Check.** `run_checks` — spec referential integrity. Green here means the
spec is coherent; it does **not** mean the feature works.

**6. Drive it.** See *Verifying honestly* below.

## "Make it beautiful" / custom UI

This is the request most likely to push you off the loop. Work down this ladder
and stop at the first rung that fits — do not start at the bottom:

1. **Is it the look of the whole app, or which shape the list takes?** Both are
   **spec ops** — this rung answers most "make it beautiful" requests outright:

   - `theme.set` gives the app a designed identity: a curated preset
     (`zinc` · `ocean` · `forest` · `sunset` · `mono` · `rose` · `amber`) plus
     optional `accent` (`#hex`), `radius` (`sm|md|lg|full`), `density`
     (`comfortable|compact`), `font` (`sans|serif|mono|rounded|humanist`), and
     `typeScale` (`compact|default|relaxed`). Last-wins; generated pages honor
     it immediately, light and dark.
   - `page.setBlockVariant` picks the list's presentation: `table` (admin
     grid), `cards` (responsive card grid), or `feed` (stacked
     title/description/date — the reading-list look).

   ```json
   {"op":"theme.set","args":{"theme":{"preset":"ocean","radius":"lg","font":"humanist"}}}
   ```
   ```json
   {"op":"page.setBlockVariant","args":{"pageId":"pg-<page>","blockId":"blk-<table>","variant":"cards"}}
   ```

   CLI sugar: `maxstack theme ocean --radius lg --font humanist`.

2. **Is it the data or the arrangement?** Sort order, which fields show, an
   extra field, a new page — all spec ops. `page.setBlockOrder` ranks a table;
   `page.setBlockFields` picks *which* fields the list renders, in order (the
   first is the title). Reach for it whenever the list hides something that
   matters — a rating, a status, the review text — instead of writing a
   component to show two more fields.

   ```json
   {"op":"page.setBlockFields","args":{"pageId":"pg-<page>","blockId":"blk-<table>","fields":["title","rating","review","finishedOn"]}}
   ```

   `page.setBlockEditable` names the fields whose cells edit **in place**, so
   changing one value costs a click instead of a trip to the form and back.
   Reach for it on the fields people retype constantly — a status, a rating, a
   due date. Simple types only (text, number, boolean, enum, date): a reference,
   a file and a json blob are refused, because no cell editor can represent
   them. The edit posts to the record's own edit route, so it runs the same
   validation, permissions and audit trail as the form — the list gets no write
   path of its own. Pass `[]` to make the list read-only again.

   ```json
   {"op":"page.setBlockEditable","args":{"pageId":"pg-<page>","blockId":"blk-<table>","editable":["status","rating"]}}
   ```
3. **Is it how one page is composed, beyond theme + variant?** Use a **slot**.
   Add a slot block to the page and
   fill `app/routes/<resource>.slots.tsx` — yours, stubbed once, survives
   regeneration, and the edit hook allows it. This is the answer to most "make
   it look good" requests.

   A slot **appends below the default table** by default. To render *instead of*
   it — the usual intent for a redesign — declare the block with
   `mode: "replace"`:

   ```json
   {"op":"page.addBlock","args":{"pageId":"pg-<page>","block":{
     "id":"blk-shelf","type":"slot:shelf","mode":"replace"}}}
   ```

   Then `run_generator` to scaffold the stub, and write the component. It reads
   its own data with `useLoaderData()` and owns the whole region, including the
   empty state. The page stays spec-driven: new fields still flow into the data
   it reads. Replacement only takes effect once the slot is actually filled, so
   the table stays put while you work.
4. **Only if none of those fit** — `maxstack eject <route-id>` (`--dry-run` first).
   You then own the whole file, but it stops tracking spec changes forever and
   you hand-maintain it. Say so before you do it, and prefer 1 or 2.

Ejecting on first sight of a plain generated page is the classic mistake: it
trades the entire regeneration story for a one-time cosmetic win, and every
later spec change has to be mirrored by hand.

If you do own a route, the contract is: it renders inside the project frame, is
handed **no props**, and therefore **fetches its own data client-side** from
`/api/<resource>` — `GET` list, `POST` create, `PATCH`/`DELETE` on
`/api/<resource>/<id>`, camelCase fields on the wire.

Owned code does **not** run under a plain `maxstack dev` (it serves a prebuilt
runtime). Use `maxstack dev --owned`, or `maxstack build` for an image. Restart
the one server rather than starting a second — two servers over one project
share a single-writer data dir and will silently disagree about your rows.

## Verifying honestly

A green gate is not a working feature. `run_checks` proves the spec is valid; it
says nothing about whether a user can actually do the thing.

Drive the real app: `maxstack dev`, then use the browser tools to submit the
form, edit a row, and delete one. `maxstack demo` seeds sample rows so there's
something to look at.

When you can't drive the UI — no browser available — you may exercise the REST
layer instead, but then **say exactly that**. Report "REST layer confirmed
(POST/GET/PATCH/DELETE on `/api/<resource>`); the form submit and Edit button
were not driven." Do not compress that into "create, read and delete
confirmed" — the gap between those two sentences is the whole product.

State what you verified, how, and what you didn't. An honest partial report is
worth more than a confident summary that turns out to be wrong.

## When driving it turns up a bug: spec, or runtime?

Run `maxstack doctor` — it reports the CLI/runtime versions, whether the runtime
is stale or linked, the store lock, the dev-server record, and whether MCP
answers. Then place the bug:

- **Spec** — what exists: entities, fields, pages, blocks, shown fields, theme.
  Wrong or missing *content* is yours to fix, with an op.
- **Runtime** — how it behaves: rendering, form widgets and their coercion,
  routing, hydration, auth, `/api/<resource>`. That is the prebuilt
  `maxstack-runtime` package, shared by every maxstack project. **Nothing in
  this project can change it.**

A date input that stores the wrong day, a dismissed banner that returns, a form
that posts the wrong shape: runtime bugs. Don't audit the spec for one, don't
eject a route to route around it, don't hand-write an app to escape it. Say it
looks like a runtime bug, and point at
<https://github.com/sys13/maxstack/issues> with the `maxstack doctor` output.

## Don't

- Don't hand-write or hand-edit anything under `app/` except `*.slots.tsx` and
  routes you have explicitly ejected.
- Don't scaffold a fresh app, an HTML file, or another framework. The app exists.
- Don't hand-edit files under `spec/` — they're written by validated ops.
- Don't call it done on a green gate alone.
