# Full-text search

> Declare which fields are searchable and how much each one counts toward the
> rank. The platform builds the index, ranks the results, and filters them by
> the same rules a list query passes.

Op family:
`search.declare`, `search.setFields`, `search.setIndexing`, `search.remove`.

---

## The shortest version

```jsonc
{
  "op": "search.declare",
  "args": {
    "index": {
      "id": "idx-post-search",
      "key": "post-search",
      "description": "Ranked search over post titles and bodies.",
      "entityId": "e-post",
      "language": "english",
      "fields": [
        { "fieldId": "fld-post-title", "weight": "A" },
        { "fieldId": "fld-post-body",  "weight": "B" }
      ],
      "indexed": true
    }
  }
}
```

That declaration gets you three surfaces, and you write no code for any of them:

| Surface | How |
|---|---|
| Admin | The list view's existing search box starts returning ranked results |
| REST | `GET /api/post/search?q=gin+index&limit=20` |
| MCP | The tool `search_post`, offered to any agent that may read `post` |

---

## Why this is not the search box you already had

`ListOptions.search` has always existed, and it compiles to `ILIKE '%q%'` OR-ed
across every text column. It is worth being precise about the difference,
because "we already have search" is the objection this primitive has to answer.

| | `ILIKE '%q%'` | A declared index |
|---|---|---|
| Can use an index | No — unanchored, so every keystroke is a full scan | Yes, GIN |
| Knows what a word is | No — `cat` matches `certificate` | Yes |
| Stems | No — `running` does not find `run` | Yes |
| Ranks | **No** — rows come back in table order | Yes, weighted |

The last row is the one the corpus ask was about. Finding the rows was never the
gap; ordering them by how well they match was.

---

## The declaration, field by field

### `entityId` — one index, one entity

There is no index spanning entities, and this is a security decision rather than
an implementation limit. A shared index necessarily holds rows from tables with
different `access` rules, and it could only ever be gated once, for all of them.

Searching several entities is a **fan-out**: one `opSearch` per entity, each
passing that entity's own `read` gate. If a caller may read `post` but not
`comment`, the comment rows are absent from the results, absent from the count,
and absent from the ranking — because the query against `comment` never runs.

### `fields` and `weight` — the ranking

Weights are Postgres's own `A`–`D`, not a 0–100 scale this vocabulary invented.
A `tsvector` holds exactly four levels, so a wider scale would silently round,
and a mapping would be a second representation that can disagree with the first.

| Weight | Multiplier | Typical use |
|---|---|---|
| `A` | 1.0 | Title, name |
| `B` | 0.4 | Body, description |
| `C` | 0.2 | Tags, category |
| `D` | 0.1 | Anything you want findable but never ranked highly |

Only `string` and `enum` fields may be indexed. The refusals each have a reason,
and it is not "text only":

- **A reference** stores the referenced row's id. Indexing it makes search match
  raw uuids — it surfaces ids to anyone with a search box and matches nothing a
  person would type. Index the referenced entity instead.
- **`number`, `boolean`, `date`** are already answerable by a *filter*, which is
  exact and indexed. Ranking by them returns worse answers than the facility
  that already exists.
- **`json`**'s text form is punctuation and key names, so indexing it makes
  `type` match every row that has a `type` key.
- **`file`** holds an opaque storage key — never the bytes, never the filename.
  Extracting text from an uploaded document is a real capability and it is not
  this one.

### `language` — the stemmer

One of the 30 configurations core Postgres ships. It lives on the index rather
than in deployment config because the query must be parsed with the same
configuration the index was built with; a global setting would silently
invalidate every index the day somebody changed it.

Use **`simple`** for identifiers, SKUs, tags, or any corpus that is not prose in
one language: it does no stemming and removes no stop words.

### `indexed` — the write-cost lever

Required, never defaulted. A GIN index is paid for on every insert and update of
the indexed columns, and on a write-heavy table that is a real bill. Whether to
pay it is a decision about somebody's production database, and a default is how
that decision gets made by whoever wrote the code generator.

**Turning it off changes only the cost.** The same query runs, over the same
expression, returning the same rows in the same order — as a sequential scan.
That is the property that matters: nobody has to choose between "fast" and
"correct", which is the choice that makes people leave an index on a table that
cannot afford it.

```jsonc
{ "op": "search.setIndexing", "args": { "indexId": "idx-post-search", "indexed": false } }
```

---

## Operating it

### The DDL is additive in both directions

`indexed: true` emits `CREATE INDEX IF NOT EXISTS … USING GIN ((…))`; `false`
emits `DROP INDEX IF EXISTS …`. Both are safe, and the reason the drop is safe
is structural: this is an **expression index**, so it stores nothing that is not
recomputable from the columns it reads. There is no stored column, no table
rewrite, and no new key on the row — declaring an index changes no form, no REST
payload and no generated type.

### Removing a declaration is gated on un-indexing first

```
search.setIndexing { indexed: false }   →   search.remove
```

`search.remove` is refused while `indexed` is `true`. This is not ceremony: the
DDL is emitted *from the declaration*, so removing the declaration while the
index exists would strand a real GIN index on a real table with nothing left in
the spec that knows its name.

### `CONCURRENTLY` is not used

`CREATE INDEX CONCURRENTLY` cannot run inside a transaction block, and the boot
path applies DDL as one multi-statement `exec`. On a table large enough that a
blocking index build is unacceptable, land the declaration with
`indexed: false`, build the index by hand with `CONCURRENTLY`, then flip
`search.setIndexing` — the `IF NOT EXISTS` makes the flip a no-op against the
index you already built, provided you name it `search_<key>` with `-` replaced
by `_`.

---

## Access control

Search returns rows the caller never named, which is exactly the shape of a leak
that looks like a feature. So it runs through `opSearch`, beside `opList`, and
passes the identical gate in the identical order:

1. `authorize(..., 'read')` — the api-key scope (closed by default) and the
   resource's own rule. **A denial throws**, and never returns an empty result:
   "you may not read this" and "nothing matched" are different facts, and
   returning the first for the second lets a caller probe for existence by
   watching a count.
2. The tenant and soft-delete scopes are forced **after** any caller-supplied
   filter, so a hostile facet naming the tenant column cannot widen anything.

A resource whose `read` rule is the `owner` shortcut is refused wholesale, which
is exactly what `opList` does with it — a row-less rule reads as denied. Search
deliberately does not invent a "return only your own rows" semantics that list
does not have, because that would make search the one read path with its own
access model, which is how two models drift.

The rank leaks nothing: `ts_rank` scores a row using only that row's own text,
so the scores a caller sees are identical to the scores they would see if the
rows they cannot read did not exist. The count runs under identical predicates,
so it can never advertise a total the caller is unable to page to.

Pinned by `packages/maxstack-core/src/sprout/search.test.ts` — including a
non-vacuity assertion that the same query, ungated, genuinely does reach the row
the leak test requires to be absent.

---

## Facets

There is no search-specific facet concept. A search result is filtered and
faceted by exactly what a list is — `ColumnMetadata.filterable`, via
`deriveFacets`. The `?filter.<col>=` / `?filter.<col>.gte=` dialect works
alongside `?q=`, and the admin list view keeps its facets live while a search
term is set. Dropping them would show rows the user had just filtered out, which
reads as the filters being broken rather than as search overriding them.

---

## The query string

Handed to `websearch_to_tsquery`, which understands quoted phrases, `OR`, and
`-term` to exclude — which is what people type when they think they are using
Google.

It is the one tsquery parser that **cannot throw on hostile input**.
`to_tsquery('a &')` raises, and a search box that 500s on a stray ampersand is a
bug nobody can reproduce on purpose.

A blank query returns **nothing**, not everything. That is the difference
between a search endpoint and a list endpoint, and conflating them is how an
empty search box becomes an unbounded table scan the first time a crawler finds
the URL. Query strings are capped at 200 characters, at the op rather than at
the route, so REST, MCP and the admin loader all get the same bound.

---

## pglite and Postgres

Identical, and identical by construction rather than by testing twice. The index
DDL and the ranked query are produced by functions that take a plan and nothing
else — there is no backend handle in scope to branch on, which a test asserts by
reading the functions' own source for a backend discriminator.

Everything used is **core Postgres**: `to_tsvector`, `setweight`, `ts_rank`,
`websearch_to_tsquery`, GIN. No `CREATE EXTENSION`, so there is no privilege
question on a managed Postgres and no missing-extension surprise on a laptop.
`pg_trgm` ships inside pglite and would have bought typo tolerance, but it needs
an extension on the deployed side; that trade is why typo tolerance is not part
of this primitive.

The ranking behavior is exercised against a real Postgres — pglite, in
`search.test.ts` — rather than asserted as SQL text alone, including an
`EXPLAIN` check that the planner genuinely uses the index.

---

## What this deliberately does not do

**Synonyms, typo tolerance, and per-query curated results.** Everything here is
document-time policy keyed on a *field*; all three of those are query-time policy
keyed on the *query string*. They are a different mechanism — a dictionary, an
edit-distance index, and a rules table a non-engineer edits through a UI — and
each needs stored, editable state with its own CRUD and its own review. A weight
vector does not approximate any of them, and claiming otherwise would be the
vocabulary taking ground it does not hold. This is carried in the corpus at full
weight as `ch-search-relevance-tuning`; a product that needs it today reaches
for a search service, and that is the honest answer.

**Cross-entity search as one index.** See `entityId` above — it is a fan-out,
and the reason is access control.

**Highlighting / snippets.** `ts_headline` exists and would fit, but it is a
rendering concern with its own escaping story, and nothing in the corpus asked
for it.
