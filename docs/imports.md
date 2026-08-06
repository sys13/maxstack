# Importers

> Declare which entity a file lands in, which column maps to which field, and —
> explicitly — whether an existing row may be overwritten. The platform parses,
> validates every row against the same rules the forms use, shows you exactly
> what would change, and writes only after you say so.

Op family:
`imports.declare`, `imports.setMapping`, `imports.setUpsertKey`, `imports.pause`,
`imports.remove`.

---

## The shortest version

```jsonc
{
  "op": "imports.declare",
  "args": {
    "importer": {
      "id": "imp-cards",
      "key": "cards-csv",
      "description": "Import cards from the CSV our old tool exports.",
      "entityId": "e-card",
      "format": "csv",
      "columns": [
        { "column": "GUID",  "fieldId": "fld-card-guid" },
        { "column": "Front", "fieldId": "fld-card-front" },
        { "column": "Back",  "fieldId": "fld-card-back" }
      ],
      "upsertFieldId": "fld-card-guid",
      "maxRows": 20000,
      "paused": false
    }
  }
}
```

That declaration gets you two surfaces, and you write no code for either:

| Surface | How |
|---|---|
| App | `/imports/cards-csv` — upload, read the report, confirm |
| MCP | `plan_import { importer: "cards-csv" }`, dry-run only ([why](#why-mcp-gets-a-dry-run-and-no-apply)) |

---

## Import is the easiest way to destroy a user's data

That sentence is the design brief, not a caveat at the end of one. Every choice
below follows from it, and the ones that look like friction are the point.

The failure this feature usually ships looks like this. Somebody exports a
filtered view — last quarter's orders, say — and imports it back into a table
holding everything. The wizard offers a tidy-looking checkbox called *"remove
rows not in this file"*. It runs. It reports success. Nobody notices for a week.

Nothing here can do that, and not because it is discouraged.

---

## The dry-run is a shape, not a rule

```ts
planImport(ctx, key, source, opts?): Promise<ImportPlan>
opApplyImport(ctx, plan): Promise<ImportResult>
```

`opApplyImport` takes an `ImportPlan` and **nothing else**. There is no overload
that takes bytes, no `{ dryRun: false }`, and no way to construct a plan except
by calling `planImport` — which reads the file, validates every row, and resolves
every upsert match first.

So "you must dry-run before writing" is not a policy anybody has to remember, a
comment anybody can miss, or a check anybody can skip under deadline. It is the
only shape the call has. This is the same structural trick
[`documents.md`](documents.md) uses to make "rendering a document is a read of
the row" true all the way down: put the guarantee in the type, and the shortcut
stops being expressible.

A rule would have been cheaper and would have held for about two quarters. The
first *"we already validated this upstream, let us skip the plan"* is always
reasonable, and it is always the one that runs against production.

The web surface goes one step further: the confirm re-posts the **file**, and the
action re-plans server-side. Holding the plan in a hidden field and applying what
comes back is the obvious implementation and the wrong one — **a client-supplied
plan is a client-supplied write list**, row ids to overwrite and values to write
into them, already carrying the platform's own "validated" stamp. The cost of
re-planning is parsing the upload twice. The benefit is that the only plan that
can ever be applied is one this server built.

---

## The upsert key

`upsertFieldId` is **required and nullable**, and it has **its own op**.

| Value | What running the importer does |
|---|---|
| `null` | Insert-only. Every line becomes a new row; nothing existing is touched. |
| A field id | Rows whose key matches are **updated in place**. |

Three properties, each answering a specific way this goes wrong:

**It is never defaulted.** A default is how the most consequential decision about
an importer gets made by whoever wrote the code generator rather than by whoever
owns the table. `undefined` is refused; `null` is a decision and is recorded as
one.

**It has its own op.** `imports.setUpsertKey` exists so that a reviewer can
answer *"can this change destroy data?"* from the op **name**, before reading a
single argument. Folded into a general-purpose edit op, that answer would live
inside an argument, and a reviewer skimming a list of op names would not see it.
The diff summary says the consequence rather than the value:

```
Make importer "imp-cards" INSERT-ONLY — it can no longer overwrite existing rows
Let importer "imp-cards" OVERWRITE existing rows, matched on fld-card-guid
```

**Only some field types may be one.** A key has to identify a row.

| Type | Allowed | Why |
|---|---|---|
| `string`, `number`, `enum` | Yes | Each can carry an identity: a SKU, an external id, a slug |
| `boolean` | **No** | It partitions the table into two buckets, so the first run overwrites *every row* with the last matching line of the file. That is "just overwrite everything", reachable by picking the wrong entry from a dropdown |
| `date` | **No** | A timestamp is a *when*, not a *which*. It matches nothing (no two rows share a microsecond) or everything sharing a day, depending on the exporting tool's precision |
| `json` | **No** | Equality is equality on the serialization: the same document with keys reordered is a different row |
| `file` | **No** | Not importable at all, and a storage key identifies a blob rather than a row |
| a reference | **No** | It holds the *parent's* id, so matching on it overwrites every row sharing a parent |

The key must also appear in `columns`: you cannot match on a value the file does
not supply, and an unmatched key silently degrades to insert-only — which is to
say, to duplicates.

Ambiguity is refused at plan time too. The match lookup asks for two rows; if two
come back the line is rejected rather than resolved by taking the first, because
overwriting one of several rows that share a key is the outcome this importer
could never explain afterwards.

---

## There is no delete path

No `deleteMissing`. No "replace the table". No truncate. Not because it is hard —
because the feature is always the same shape when it exists, and the shape is a
checkbox that reads as tidy-up.

Reconciling a local table against a remote truth is a real capability with a
different shape: a stable remote id, a run history, and a schedule. That is
[`external-sources.md`](external-sources.md) (`sources.declare` in `sync` mode),
which already exists and has the failure handling a repeated exchange needs.

The same instinct applies one level down, at the cell. **A blank cell is an
absent value, not an empty one** — it is omitted from the row rather than written
as `''` or `null`. On an upsert that is what stops an export that is missing a
column, or a row where somebody cleared a cell, from blanking out data that is
already there. Clearing a value is an edit somebody makes deliberately; it is not
something a partial export should do to a thousand rows at once.

---

## Validation is the forms' validation

Row values go through `validateData` — the *same function* the admin forms, the
REST routes and the MCP tools call, not a lookalike. An import must not be a way
to get invalid data past the rules, and the way to guarantee that is to call the
one function rather than to assert that two functions agree.

Everything downstream is inherited for the same reason: writes go through
`opCreate`/`opUpdate` and there is **no other path out of the apply function**.
So an import gets, without re-implementing any of it:

- tenancy stamping (a row can only be created in the caller's org);
- soft-delete scoping (a deleted row is not a match);
- per-value caps — the WIP limits of [`board-views.md`](board-views.md);
- the `customValidation` hook;
- audit attribution, including `origin` and `apiKeyId`, so **an import performed
  by an agent is attributed like any other write** — because it *is* any other
  write.

The upsert lookup goes through `opList`, so it is gated and tenant-scoped: an
importer can never overwrite a row in another org, and — because the lookup is a
gated read rather than a store query — can never *discover* one either.

Access is checked up front and both actions are checked when both apply:
`planImport` authorizes `create`, and `update` too when the importer declares an
upsert key. A plan for an upserting importer *will* contain updates, and
discovering at apply time that they are forbidden means discovering it after
somebody has read a report promising them.

---

## Streaming, and the row ceiling

Each built-in reader is an async generator from chunks to records, so memory is
proportional to the widest single record rather than to the upload.

| Format | How it reads |
|---|---|
| `csv` | RFC 4180, character by character: quoted cells, embedded commas and newlines, `""` escapes, `\r\n`. No delimiter sniffing — a guess that is right most of the time mis-parses one customer's file into plausible-looking wrong rows |
| `ndjson` | One object per line, parsed as the line completes. The naturally streaming format, and the one to prefer for a large export |
| `json` | A top-level array, scanned incrementally: a small scanner tracks depth, string state and escapes to find each element's boundaries, then `JSON.parse`s **one element at a time**. `JSON.parse` on the whole document would materialize the file *and* its parsed form before a single row was validated |
| `custom` | Your parser. [Below](#the-parser-slot) |

The **plan** is bounded separately, by the importer's declared `maxRows`
(1–50,000). Exceeding it **fails the whole run**. It does not truncate, and that
is deliberate: a truncated import is indistinguishable from a successful one at
every surface that reports it — same green banner, same "imported N rows" — and
the absent rows are found weeks later by somebody who assumes they were never in
the file.

The hard ceiling exists because the plan is held whole so it can be shown,
checked and confirmed; that is the price of the dry-run being mandatory. Past
50,000 rows the honest tool is a backfill script with a database connection, and
saying so is better than an importer that dies halfway with a heap error.

---

## The failure report

`importFailureCsv(plan)` returns the rejected rows as a downloadable CSV:

```csv
line,fields,values,reasons
3,ease,x,"""x"" is not a number"
7,front,,required
```

**One row per failing input line**, so the file is the same length as the list of
problems and can be worked through top to bottom. A line with two bad cells lists
both fields, both offending values and both reasons in its own row rather than
becoming two rows, because the unit somebody fixes is a line in their
spreadsheet. Values are quoted per RFC 4180, and the output is deterministic
byte-for-byte — no clock, no locale, no `Intl` (whose output depends on the ICU
build). This file is evidence somebody attaches to a ticket and compares against
a later run.

Apply is **per row, never all-or-nothing across rows.** A row that fails at write
time failed for a reason that did not exist when the plan was built — a racing
writer took the last slot in a WIP-limited column, a unique index rejected a
duplicate — and the rows that landed are correct. Rolling them back would mean
deleting rows this module just created, which is the delete path it deliberately
does not have. The returned counts reconcile exactly with the plan, and a row the
plan marked `invalid` is **never attempted**: that is what makes the report
somebody read the thing that actually governs the write.

---

## The parser slot

`format: 'custom'` is the honest fourth format. The platform does not know how to
read a `.apkg` — a zip holding a SQLite database, a media manifest and positional
note fields — or an `.xlsx`, or a vendor's proprietary dump. Teaching the
vocabulary about archive formats would be the framework-as-cage failure, one
format at a time, forever.

So the declaration names a module and the ownership generator emits the seam:

| File | Owner |
|---|---|
| `imports/imports.generated.ts` | **Framework.** A registry mapping each custom importer to its parser. Re-emitted every regeneration |
| `imports/<key>.parse.ts` | **You.** Written once, never touched again |

```ts
type ImportParser = (
  chunks: AsyncIterable<Uint8Array>,
) => AsyncIterable<Record<string, string>>
```

**The bespoke half stops at parsing, and that is what keeps the slot from being a
bypass.** A parser yields the same record shape the CSV reader yields, and those
records go through the identical mapping, the identical `validateData`, the
identical gated upsert lookup and the identical `opCreate`/`opUpdate`. It is
handed bytes and nothing else — no store, no registry, no user, no plan — so
there is nothing it could write and no row it could see. Same argument
[`external-sources.md`](external-sources.md) makes about re-typing a refiner's
return value, made one step earlier.

An importer that declares `custom` and finds no parser **throws, naming the file
that is missing**. It never returns an empty plan: "your file had no rows" is a
different and far more confusing problem than "the parser has not been written".

An importer reading `csv`, `ndjson` or `json` emits **nothing at all** — not a
stub, not an empty registry, not an `imports/` directory. The declaration is the
implementation. That is the honest half of the win and it is asserted rather than
claimed (`ownership/imports.test.ts`).

---

## Why MCP gets a dry-run and no apply

A declared importer is reachable through `plan_import` (which takes the importer
key as an argument, since the generated tool surface became fixed-size)
and there is no apply tool, and the omission is deliberate rather than
unfinished.

The dry-run guarantee lives in `opApplyImport`'s signature. Over a wire protocol
that guarantee has nowhere to live: an `apply_import` tool would have to accept a
plan *the client sent back*, and the gate would be reduced to trusting the caller
to return the plan it was given — the same failure the web surface avoids by
re-planning.

So an agent can read a file, see exactly what would change, and report it; a
person confirms on the surface that still holds the plan it built. When an agent
does apply an import there, the writes are attributed like any other agent write,
because `opCreate`/`opUpdate` stamp `origin` and `apiKeyId` from the context and
the import path has no other way to write.

---

## The operational levers

`imports.pause` is the one somebody reaches for at 3am, and it keeps the
declaration, the mapping and the parser file — the reason to stop an importer is
usually that a partner's export changed shape, and deleting the declaration to
stop it also deletes the mapping you need to fix it.

`imports.remove` is **refused while the importer is not paused**. Pause, confirm
nothing downstream broke, then remove — the same two-step `sources.remove`
requires, for the same reason: removal must never be the fastest way to silence
something somebody is mid-way through using.

`paused` is required and never defaulted, on the same posture
`SearchIndexSpec.indexed` and `SourceSpec.paused` take: "is this write path open"
is a decision about somebody's production data.

---

## What is deliberately not here

**A transform language.** A column maps to a field and the *field's declared
type* is what the cell is parsed as — the same bargain `SourceMapping` strikes,
for the same reason: a second type declaration is a second thing to drift from
the column's. Splitting a full name into two columns, or looking a code up
against another table, is what the parser slot is for.

**A saved mapping wizard.** The mapping is in the spec, which is committed and
diffed. A mapping a user drew in a modal and the server remembered is a
declaration with no review, no history and no diff.

**Scheduled or URL-sourced imports.** An importer reads bytes somebody handed it.
Pulling a file from a third party on a timer is `sources` plus `schedules`, both
of which already exist.

**Export.** Reading a file and writing one are not the same feature, and the
corpus carries the difference as a live gap: `ch-apkg-roundtrip` is a
bidirectional, identity-preserving, stateful exchange, and no amount of
importer is one.
