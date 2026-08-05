# Portals — the declared outside

Everything this platform derives is an authenticated admin surface. A portal is
the exception, declared: **a page over your own data that somebody who is not a
member of your app can reach.** Public, or with a link, or with a role.

Five ops:
`portals.declare`, `portals.setFields`, `portals.setWrites`, `portals.pause`,
`portals.remove`.

```
portals.declare {
  portal: {
    id: 'ptl-archive', key: 'archive', entityId: 'e-post',
    description: 'The public archive of published posts.',
    audience: 'public', scope: 'collection',
    readFields: ['fld-post-title', 'fld-post-body'],
    filter: { fieldId: 'fld-post-published', equals: true },
    writes: [], layout: 'feed', paused: false,
  }
}
```

That is `/p/archive`, themed by the app's own `theme.set`, showing two columns of
the published posts and nothing else.

## Where enforcement lives, and why it is not the route

**Nothing here is enforced by a route.** A design where "the public route only
selects these columns" is wrong, and it is worth being precise about why, because
it is the obvious design and it is the one that fails.

This established the
finding mechanically rather than as a matter of taste: `/mcp` and the admin
loaders reach the data layer **without passing any route-level gate at all**.
That is why api-key scoping lives inside `canPerformAction` rather than in the
REST handlers. Public exposure is the same problem with a much worse blast
radius, so it lives at the same depth:

| Rule | Where it is enforced | Which callers it covers |
|---|---|---|
| Which resource and action a portal may reach | `portalGrants`, inside `canPerformAction`/`authorize` | all |
| Which columns come back | `projectForPortal`, inside `opList`/`opGet`/`opGetMany` | all |
| Which rows are reachable | forced filter in `opList`/`opCount`, row check in `opGet`/`opUpdate` | all |
| Which fields a write may set | `assertPortalWriteShape`, inside `opCreate`/`opUpdate` | all |
| The hourly budget | `assertPortalBudget`, inside `opCreate`/`opUpdate` | all |

The rendered routes (`apps/web/app/routes/p.$key.tsx`,
`p.$key.$id.tsx`) contain **no filtering, no column selection and no access
check**. They resolve a credential into a narrowed identity and call the ordinary
ops. A test asserts neither module imports the store — so the day somebody adds
`store.list` there to "just filter the columns", the build fails.

The consequence worth stating: **if those route files were deleted, nothing would
become more exposed.** The portals would 404 and every other caller would behave
exactly as it does today.

## Default deny

`portalGrants` sits beside `scopeGrants` and has the same three properties:

1. **A non-portal identity is unaffected.** No `user.portal` ⇒ `true`. A session,
   an api key and an MCP call behave exactly as they did before this layer
   existed; a portal composes as a pure narrowing.
2. **It is a filter, never a grant.** The resource's own rule is still evaluated,
   so a portal cannot reach something the resource denies. The *grant* — what
   makes a public read legal at all — is produced by `accessWithPortals` in
   `from-spec.ts`, mechanically, from the declaration. Keeping the two apart
   means the thing that makes something reachable is always visible in the
   exposure report.
3. **It is closed by default, including on resources with no rules.**
   `canPerformAction` is open-by-default everywhere else. Portals, like api keys,
   are the deliberate exception: "the entity had no rule yet" must never be how
   the internet reaches a new table. An entity added next month is unreachable by
   every existing portal, with nobody having to remember anything. There is a
   test for exactly this, against a resource registered with no `access` at all.

And one property api keys do not have: **`delete` is never grantable.** Not a
declaration, not a spelling, no path. The vocabulary has no `delete` write
action, and `portalGrants` refuses it a second time, so adding one to the
vocabulary later would still not make it reachable.

A portal identity is also **not authenticated**. `expandShortcut('authenticated')`
excludes it, because a synthetic user object built for a public URL is truthy and
a naive `!!user` would have admitted every anonymous visitor to every rule
anybody ever wrote as `'authenticated'`. Nobody writing that word meant "or
anybody who followed a link". A `role` portal is a real session and stays
authenticated.

## Why there is no "all except"

`readFields` is a required, non-empty allowlist. There is deliberately **no
spelling of "everything"** and no exclusion list.

An "all except" projection is correct on the day it is written and wrong forever
after. Somebody adds `internalNotes` in six months; it is not on the exclusion
list, because the list was written before the column existed; it is public the
moment it is declared. Nobody reviews that change as an exposure, because it is
an `data.addField` — the most routine op in the vocabulary.

The same argument applies twice more:

- **Write allowlists** are opt-in per field for the same reason, sharpened: an
  exclusion would let a field added later be *set* from the internet.
- **A collection portal is always bounded.** `filter` is required. "The outside
  can list this table" is not a feature anybody means to ship; "the outside can
  list the published posts" is.

The projection also drops things nobody thinks of as columns: **derived values**
 that were not declared, the soft-delete column, and the tenant
column. Derived values matter most, because a rollup is attached *after* the
store, so it is not on anyone's mental list of exposed data.

The primary key is the one always-included key. That is a considered exception:
a collection with no ids cannot link, key a list or paginate, and spec entities
carry a `uuid` primary key, which encodes no ordering, no timestamp and no count.
Publishing one tells a reader nothing the row's own presence did not.

## Why anonymous `update` is unspellable

A `public` portal may declare `create` — a comment form, a contact form, a
submission — under a **required** hourly budget. It may not declare `update`, and
the refusal is at validate time.

Anonymous update means anyone on the internet may edit a row that already exists.
There is no honest product reason to spell that as a declaration. The thing
people actually want when they reach for it is "*this* client may edit *their*
invoice", and that is `audience: 'token'` — a link only they were sent, which
expires and can be revoked.

Related refusals, each with a test named after the exposure:

- **`scope: 'row'` requires `audience: 'token'`.** The only thing that can name
  one row from outside without being guessable, revocable and expiring is a
  credential. A row id in a public URL is a credential that appears in every log,
  every referrer header and every REST response, and can never be revoked.
- **A row portal may not declare `create`** — a create reaches a row that does not
  exist yet, which is definitionally outside a bound of one row.
- **A write may not name the bound column.** The bound is server-stamped on create
  and immutable on update, exactly as the tenant column is, because a writable
  bound is a portal that can write a row out of its own filter.
- **A `public` or `token` portal may not expose a `file` field** (it holds a
  storage key, which is an object path into the bucket) **or a reference to
  `e-user`** (an identity-table primary key — a way to enumerate accounts).

## Ordering and search

An `orderBy` or a filter naming a column the portal does not expose is **refused,
not ignored.** This is a real attack rather than tidiness: `ORDER BY salary` over
a bounded public collection never shows a value, but the *permutation* of the
visible rows is a comparison oracle, and a few dozen paged requests reconstruct
the ordering exactly.

Ranked search is **refused entirely** for a portal identity, and
that is a decision rather than an omission. A search index is declared over the
field set that makes the *admin's* search useful; the portal's projection is a
different, narrower list. Two things then leak that no amount of row filtering
fixes: the match predicate (`to_tsquery` runs against the whole tsvector, so a
portal could ask which visible rows contain a word *in a hidden column*), and the
rank (`ts_rank` scores against the same vector, so the result order is a function
of hidden text — the `orderBy` oracle through a different door). Making it safe
would need a second index per portal, over the projection: a second declaration
of the same fields, which is a second thing to drift, on the one surface where
drift is a disclosure.

A portal still gets `opList`'s ordinary substring `search` option over its own
declared columns.

## Tokens: expiry and revocation from day one

A portal token is an opaque 32-byte CSPRNG value. **Only a SHA-256 hash is
stored**; the plaintext is returned once at mint and there is no path that
returns it again.

- **`ttlHours` is required and bounded to one year.** There is no non-expiring
  portal token and no default that would produce one by omission. A link somebody
  emailed a client in 2024 is a credential that has been sitting in a mail archive
  ever since.
- **`maxUses` is required and nullable.** `null` is "any number of opens before it
  expires" — a recorded decision. Omitting it is an author who has not made one.
- **`verify` refuses on revocation, expiry and use cap**, checked against the row
  on every call. No cache: any cache is a window in which a link somebody has just
  killed still works.
- **All four refusals — revoked, expired, used up, unknown — are
  indistinguishable.** A verifier that told them apart is an oracle.
- **Mint and revoke are audited**, with `origin: 'portal'` available on the audit
  entry so a write from outside the app is distinguishable from a session, an api
  key, an MCP call and a cron job.

The token table lives in the **`api-keys` bundle**, not in a new one. Two
reasons. The catalog is at its 16-bundle cap, and a portal token genuinely *is* what that bundle models: a scoped,
expiring, revocable credential, with hashing, `expiresAt`, `revokedAt`,
`lastUsedAt` and per-credential budgeting already there. It is a **separate
table** rather than nullable columns on `api_key`, because the permission layer
reads an absent `apiKeyScope` as "unrestricted session" — a key row that could
exist with no scope would be a credential that widens by omission.

A token carries three facts and no permissions: which portal, which row, and the
hash. **What the portal may see is read from the declaration**, so a token can
never carry a projection the exposure report does not know about.

**There is no MCP tool that mints a token, and there will not be one.** A minted
token is a bearer credential in plaintext; putting one on the wire to an agent
lands it in a transcript, a log and a context window, none of which can be
revoked.

## Rate limiting

Every portal write passes the limiter, bucketed per portal key, action and
caller, at the **declared** `rateLimitPerHour`. The check lives in
`opCreate`/`opUpdate` — where the write is — so a portal write path that bypasses
it is structurally impossible: there is no other way to reach the store.

`rateLimitPerHour` is required and never defaulted, and an unauthenticated write
is capped at 600/hour. Ten a minute is a comment form; past that the budget is
the only thing standing between a public `create` and an unbounded row generator,
and it has stopped standing.

**A portal write with no limiter wired is refused.** That asymmetry with
`derived` (a missing derived resolver merely costs you rollups) is deliberate: a
host that forgot to configure a limiter must get no anonymous writes rather than
unlimited ones.

**The budget is shared across instances on Postgres**. It used to
be per process — buckets in one process's memory — so two containers served a
declared 600/hour at 1,200/hour, silently, because each was individually obeying
the declaration. Buckets now live in `maxstack_rate_bucket`, taken with one
atomic statement so concurrent callers on the same bucket serialize. On pglite
the buckets stay in memory, which is correct rather than reduced: pglite locks
its data dir so a second instance cannot start. The mode is logged at boot, so
an operator reads which one they have instead of inferring it.

## The exposure report

```
maxstack validate
```

prints, whenever a spec declares a portal:

```
⚠ public surfaces — 2 portal(s) over 2 entit(y/ies): 3 field(s) readable with
  no credential at all, 5 readable with a link, 1 writable with no credential.

  /p/archive  [public]  The public archive of published posts.
  ------------------------------------------------------------
  read    post                  title
  read    post                  body
  create  post                  title
```

Not a warning to scroll past — a row per exposed field. The same
`portalExposureReport` fold renders in the workbench (`PortalsPane`) and returns
from the MCP `portal_exposure_report` tool, so nobody is told a different story
about what is exposed.

It reads **only from the declarations**, which is what makes it incapable of
drifting from what the runtime enforces: the runtime grounds the same arrays into
column names and enforces exactly those. A report assembled by walking the
runtime would be a second implementation of the projection, and two
implementations of a security boundary is one more than is safe.

That is a claim, so it is pinned. `apps/web/app/portals.agreement.test.ts`
declares a portal, grounds it, registers it, creates a real database, runs the
ordinary read op, and asserts **the keys of the returned row equal exactly the
fields the report lists as readable** — `toEqual` on the sorted key set, not a
spot check. The report on its own is a document; the agreement test is the
deliverable.

Paused portals appear in the report and are labelled. A pause is one op from
being undone, so a report that hid them would answer "what is exposed today" when
the question is "what could be".

## Review and the 3am lever

A portal is the one declaration where `activePortals` is **accepted-only**, not
`getAcceptedOrAll`'s accepted-else-all. Everywhere else the fallback is a
convenience that lets a fresh, entirely-suggested spec generate something to look
at. Here it would mean an agent could put a table on the internet by *suggesting*
it — default-open, on the one layer whose first non-negotiable is default deny.

`portals.pause` is the op somebody runs at 3am. It requires removing nothing: the
declaration, the projection and every minted token survive, so bringing the
surface back is one op rather than a re-review. Killing the links is a separate
operation (`PortalTokenService.revokeAllFor`), because "is this surface up?" and
"is this particular link still good?" are separate questions, and conflating them
would mean a pause silently invalidated every link a business had sent out.

`portals.remove` is refused while a portal is not paused, on `imports.remove`'s
rule: removal must never be the fastest way to silence something somebody is
mid-way through using.

## What a portal is not

**Not a second serializer.** The fields are the entity's own columns, read
through the ops the admin uses. Nothing here describes how a value is formatted.

**Not a theme.** `layout` picks one of the theme layer's existing block variants. A
micro-site's *look* is `theme.set`, which is what makes a public page a themed
derived page rather than an ejected one.

**Not an auth system.** A `role` portal is an ordinary session whose role the
portal names. A `token` portal's credential is minted, hashed, expired and
revoked by the api-keys bundle.

**Not a document renderer, and not an importer.** Both are refused for a portal
identity: a document is a whole-row rendering with no notion of a projection, and
an importer maps a whole file onto a whole entity. Neither reconciles with a
declared field list, so both refuse rather than happening to be right today.

**Not multi-tenant.** A portal identity carries no `orgId`, so a tenant-scoped
resource refuses it. The only honest source of an active org is a session or an
api key, and a public URL is neither.
