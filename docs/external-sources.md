# External data sources — declared fetch, typed mapping, scheduled sync


Two asks in the benchmark corpus said the same thing from opposite ends.
bookclub: *"fetch cover art and metadata from an ISBN lookup service."*
crmlite: *"sync an email inbox and thread messages per contact."* One is a
single request about one row; the other is a collection pulled over and over.
Both were off-surface — no op, no slot, no guidance — and both are now
declarations.

```jsonc
// Enrichment: call an API about one row, map the answer back onto it.
{ "op": "sources.declare",
  "args": { "source": {
    "id": "src-isbn-lookup", "key": "isbn.lookup",
    "description": "Fill in a book's cover art and page count from its ISBN.",
    "mode": "enrich", "entityId": "e-book",
    "request": { "url": "https://openlibrary.org/isbn/{isbn}.json" },
    "auth": { "kind": "none" },
    "mapping": [
      { "from": "title",           "to": "fld-book-title" },
      { "from": "number_of_pages", "to": "fld-book-pages" },
      { "from": "covers[0]",       "to": "fld-book-cover" }
    ],
    "limits": { "requestsPerMinute": 30, "timeoutMs": 5000,
                "maxAttempts": 3, "backoffMs": 1000 },
    "triggers": [{ "kind": "create" }, { "kind": "manual" }],
    "inputField": "fld-book-isbn" } } }
```

That declaration is the whole implementation. It emits **no code at all** — no
registry, no stub, not even a `sources/` directory.

## The spec never contains a secret

This is the highest-risk surface in the L2 vocabulary, and it is the one place
where a convention would not have been enough. A spec is committed, diffed,
rendered in the workbench and handed to agents. A credential that leaks into one
leaks everywhere at once, and it cannot be un-leaked.

So `auth` holds a **name**:

```jsonc
"auth": { "kind": "bearer", "secretName": "MAILBOX_TOKEN" }
```

…and `validateOp` refuses the alternatives, in both directions:

| Refused | Why not just scan values |
| --- | --- |
| A credential **header name** — `authorization`, `x-api-key`, `cookie`, … | These exist to carry a credential. The only reason to write one into a spec is to inline one. |
| A credential **query parameter name** — `key`, `api_key`, `token`, `access_token`, `secret`, `signature`, … | Same. `auth: {kind: "query"}` serves the APIs that only offer this. |
| Credentials in the URL (`https://u:p@host`) | They would be logged and replayed on every attempt. |
| A **value** matching a known credential format — Bearer/Basic, `sk-`, `ghp_`, `AKIA`, `xox`, `AIza`, a JWT, a PEM private key | The obvious cases, caught by shape. |
| A **value** with ≥32 characters of mixed-case alphanumerics | The catch-all for a format nobody enumerated. |
| A `secretName` that is not env-var shaped | Very often a value somebody pasted into the name field. |

Refusing the *names* is the load-bearing half. A value scan clever enough to
recognise every credential format is a scan that will one day meet a format it
does not know; refusing `Authorization:` outright does not have that failure
mode. And the check is deliberately quiet on ordinary strings — a 32-character
lowercase run is a slug, not a token — because a check people learn to work
around is worse than no check.

A refusal never echoes the rejected string back. A validation error goes to a
log, and a log is not a secret store.

## The endpoint is constrained, twice

Everything here is "make this server issue a request somewhere", which is the
definition of SSRF. It is checked at declaration time and again immediately
before every request, because those catch different things.

**At declaration time** (`sourceUrlErrors`, pure, no DNS — it runs inside
`validateOp`): https only; no embedded credentials; ports 443/8443 or none; no
fragment; and no internal-address literal, in every spelling — `127.0.0.1`,
`localhost`, `169.254.169.254`, the decimal `2130706433`, the octal
`0177.0.0.1`, `::1`, `::ffff:127.0.0.1`, `fd00::`, `*.internal`, `*.local`.

**At request time** (`fetchSource`): the declared URL's origin **is** the
allowlist, so a request to any other origin is refused; `assertPublicUrl` —
the inbound-receiver check, deliberately reused rather than re-implemented — resolves the host
and checks every answer, closing the rebinding window that a declaration-time
check cannot; and **redirects are never followed**, because a 302 to an internal
address walks past all of the above in one hop.

The two host checks agree by test rather than by hope
(`sources/ssrf.agreement.test.ts` runs both over one table of bypass
spellings). They are separate functions because `@maxstack/spec` sits below
`@maxstack/features` in the package graph and importing upward would be a cycle.

## Generation never makes a network call

The spec declares the source; only the running app fetches. Nothing in
`sources.ts` does IO, and nothing the ownership generators read can reach a
response — so this holds by construction rather than by discipline.

It is asserted the only way that stays true:
`apps/maxstack/src/lib/source-determinism.test.ts` replaces `globalThis.fetch`
with a function that throws and generates the corpus apps anyway. The same file
pins the other direction — a source that has fetched a thousand times and one
that has never run emit identical trees, and so do a paused source and a running
one. An eval that hits the network is not reproducible, and a pause that
rewrites the app is a regeneration diff to review at 3am.

## The mapping is typed by the column, not by the mapping

`from` is a path into the response — dotted keys and `[n]` indices, and nothing
else. No wildcards, no filters, no expressions. `to` is a field id, and **that
column's declared type is the mapping's type**, so there is no second type
declaration to drift from the first.

Three rules follow, and all three are about not making a row worse than it was:

- **A value that cannot be coerced is refused, not written.** A provider that
  starts returning `"about four hundred"` where it returned `412` does not put
  `NaN` in the column and does not take the page down. The run reports which
  field, which path, and why.
- **Absent is absent.** A path that resolves to nothing produces no entry —
  not `null`. A book with no cover keeps the cover somebody typed in.
- **A `file` column is refused outright.** It holds a storage key only the
  upload path can mint; writing a remote URL there produces a key that resolves
  to nothing, which is an integration that looks like it worked. Map the URL to
  a `string` field.

## Sync is keyed, bounded, and safe to repeat

```jsonc
"collection": { "path": "messages", "idPath": "id",
                "idField": "fld-message-remote-id", "maxRecords": 200 }
```

`idField` is required and must be a `string` column. Without a stable remote id
every run appends the same rows again — the failure people discover a week later
with 40,000 duplicate contacts. A record that arrives *without* one is skipped
rather than inserted, because inserting it would produce a row the next run
cannot match. `maxRecords` is required and bounded; a run that hits the cap says
so, since "we synced 200 of 4,000" and "there are 200" are different facts.

Sync is driven by a declared schedule (`triggers: [{kind: "schedule",
scheduleKey: "inbox.poll"}]`, validated against `schedules.declare`) or by a
webhook receiver. Enrichment is driven by `create`/`update`/`manual`.

## Failure is normal, not exceptional

A third party is down at some point on every schedule that exists, so that is
designed for rather than handled.

**Enrichment is queued, never inline in a write.** The obvious implementation of
"enrich on create" fetches inside the create — and then adding a book stops
working when somebody else's server does. Queuing decouples them: the create
returns the row the person typed, and the enrichment lands when it lands.

**A run produces intent, never rows.** `runEnrichment`/`runSync` return
`SourceWrite[]`, which the host applies through the same validated write path a
form posts to. So a value a third party supplied goes through the column's zod
schema, the entity's WIP limits and the op log — because it goes through the
identical code path a person typing into the form does. A source has no
privileges of its own. (Same shape as inbound receivers, for the
same reason.)

**"No privileges of its own" is structural, not a promise**. Every
run **borrows** an identity, and the worker refuses — before the fetch — a job
that reached it without one; there is no service account to fall back on and no
enqueue helper that will omit it.

| trigger | whose authority the run borrows |
| --- | --- |
| `schedule` | the schedule's declared `runAs` |
| `create` / `update` | the identity whose committed write triggered it |
| `manual` | the operator who pressed **Run now** on `/jobs` |

So a source can never reach a row the thing that triggered it could not. Two
consequences worth knowing: a schedule declared *purely* to drive a sync does
not demand a handler file (the platform claims the occurrence itself), and a
source's own writes never re-trigger an `update`-triggered enrichment — without
that guard a source would enrich its own output forever.

**The retry budget is declared, not inherited.** `limits` is required in full:
`requestsPerMinute`, `timeoutMs`, `maxAttempts`, `backoffMs`. An inherited retry
policy against a partner is how a transient 503 becomes a self-inflicted denial
of service that *they* notice first. The budget becomes the job queue's, so a
source that is down waits durably across a restart rather than holding a worker
for `maxAttempts × timeoutMs`. Retryable and permanent failures are separated: a
429 or a 5xx is worth another attempt, a 404 or a refused URL is not.

**Health is a sentence, not a stack trace**, and it comes from the job table
rather than a `source_status` table — the same argument the schedule layer makes about
schedules, so "did the 09:00 sync run" has one answer instead of two that can
disagree.

| State | What it means | What it renders as |
| --- | --- | --- |
| `never-run` | declared, not yet fired | *"has not run yet"* |
| `ok` | last run succeeded, recently | *"is up to date (last updated …)"* |
| `stale` | no success in over a day | *"showing older data (last updated …)"* |
| `failing` | last run failed | *"is failing: …  — showing the data from the last successful run"* |
| `paused` | stopped by `sources.pause` | *"showing the data from before it stopped"* |

`stale` is its own state on purpose: "this data is older than it should be" and
"this integration is broken" are different facts, and collapsing them gives you
either a red banner nobody believes or a green one that lies.

## The refiner slot — and the line it draws

Most integrations need no code. crmlite's does: attaching each synced message to
the contact whose address sent it is a lookup against local rows, not a path
into a response.

The two ways to handle that alone are both bad. Teach the mapping language about
foreign-key resolution — and then about the next product's variation on it,
forever, which is the framework-as-cage failure. Or leave the maintainer to
eject the whole surface.

So a source may declare `refine: true`, and the platform writes
`sources/<key>.refine.ts` **once** and never again, plus a framework-owned
registry it rewrites every time. The refiner is called with the raw remote
record *and* the values the declared mapping already produced, and returns the
final values — declaration does the boring 90%, code expresses only what is
genuinely code.

It is an extension point, not a bypass: **its return value is re-coerced against
the entity's declared types**, so a refiner cannot write something a form could
not.

That is what moved crmlite's inbox ask from off-surface (weight 8) to slot fill
(weight 3). Note what it is *not*: a spec op. The threading is real code in a
real file, and calling it weight 1 would be claiming the platform did something
it did not.

## Where the line is drawn

A source **reads**. Everything that follows from that is deliberate, and each of
these stays off-surface, carried at full weight in the corpus:

- **Writing back to a third party.** There is no op, argument or field anywhere
  in `sources.ts` that names an outbound mutation. Bidirectional reconciliation
  is not an extension of this primitive; it is a larger one wearing its name.
  (`ch-inbox-writeback`.)
- **Reconciling two providers.** A declared source is single-origin by
  construction — the request URL *is* the allowlist, and that is a security
  property, not an omission. Per-field provenance and a hand edit that outranks
  the next fetch are not modelled either. (`ch-metadata-reconcile`.)
- **Ingesting remote bytes.** Mapping onto a `file` column is refused; a
  storage key is minted by the upload path or not at all.

## The ops

| Op | What it does |
| --- | --- |
| `sources.declare` | endpoint, credential *by name*, typed mapping, budget, triggers |
| `sources.setMapping` | replace the mapping wholesale — the edit a provider forces when it renames a response field |
| `sources.setLimits` | replace the rate limit and retry budget wholesale |
| `sources.pause` | stop or resume fetching, keeping the declaration and the history |
| `sources.remove` | refused while active; pause first, confirm, then remove |

`sources.setMapping` and `sources.setLimits` re-validate the **whole**
declaration rather than the argument in isolation: a mapping is only correct
relative to the entity it writes and the mode it runs in, and checking it alone
would accept a sync whose new mapping overwrites its own remote-id column.

## Where to look

| Concern | File |
| --- | --- |
| The declaration, the secret scan, the URL check, the typed coercion | `packages/spec/src/base/sources.ts` |
| Op validation shared by `validateOp` and the layer check | `packages/spec/src/base/spec-system.schema.ts` (`sourceErrors`) |
| The guarded request | `packages/features/src/sources/fetch.ts` |
| Response → values, pure | `packages/features/src/sources/mapping.ts` |
| Run → write intent | `packages/features/src/sources/service.ts` |
| Queue wiring and health | `packages/features/src/sources/queue.ts` |
| The refiner seam | `packages/maxstack-core/src/ownership/sources.ts` |
| Zero-network assertion | `apps/maxstack/src/lib/source-determinism.test.ts` |
