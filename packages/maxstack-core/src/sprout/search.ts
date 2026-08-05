/**
 * The SQL behind a declared search index.
 *
 * This module has one job and one property, and the property is the reason the
 * job is a module rather than two pieces of inline SQL.
 *
 * **The index expression and the query expression must be character-identical.**
 * A GIN index on an expression is only usable by a query that repeats that
 * expression exactly; Postgres matches them structurally, and a difference as
 * small as a reordered `||` operand means the planner ignores the index and
 * silently falls back to a sequential scan. Nothing fails, nothing logs, and the
 * only symptom is that search is slow on a table big enough that nobody wants to
 * experiment on it. So {@link tsvectorExpr} is the single source of that string:
 * `searchIndexDdl` emits it into `CREATE INDEX` and `searchSql` emits it into
 * the `WHERE` and the `ORDER BY`, and a test asserts the DDL literally contains
 * what the query builds.
 *
 * ## Why the SQL is assembled as text rather than through a query builder
 *
 * A `regconfig` literal, a `setweight` weight and a column identifier are all
 * positions where Postgres does not accept a bind parameter — `to_tsvector($1,
 * …)` is legal but makes the expression non-immutable, so it cannot be indexed
 * at all. The values that go into those positions are therefore interpolated,
 * and the safety argument is upstream: `searchIndexErrors` refuses any language
 * outside {@link SEARCH_LANGUAGES}, any weight outside `A`–`D`, and any field
 * that is not a declared field of the entity. {@link assertPlanIsSafe} restates
 * those three as a runtime assertion at the boundary, so this module is safe on
 * its own terms even if it is ever called from somewhere that skipped the
 * validator.
 *
 * **The query text itself is always a bind parameter.** It is the one value here
 * that comes from a person, and it never touches the SQL string.
 */

/**
 * A field's contribution to the rank. Structurally duplicated from the spec's
 * `SearchWeight` because `@maxstack/core` does not depend on `@maxstack/spec`
 * (the same layering `SpecFieldShape` lives under) — and duplicated
 * *deliberately* rather than widened to `string`, because this value is
 * interpolated into SQL and a `string` here would move the safety argument out
 * of the type system. `search.agreement.test.ts` in `@maxstack/features` — the
 * lowest package that may import both — pins the two lists to the same values.
 */
export type SearchWeight = 'A' | 'B' | 'C' | 'D'

/** Runtime guard for {@link SearchWeight}. Mirrors the spec's `SEARCH_WEIGHTS`. */
export const SEARCH_WEIGHTS: readonly SearchWeight[] = ['A', 'B', 'C', 'D']

/**
 * The text-search configurations a plan may name. Mirrors the spec's
 * `SEARCH_LANGUAGES`, pinned by the same agreement test — a value that is in one
 * list and not the other would either refuse a valid spec at boot or, in the
 * dangerous direction, let an unchecked value reach a `regconfig` literal.
 */
export const SEARCH_LANGUAGES: readonly string[] = [
	'simple',
	'arabic',
	'armenian',
	'basque',
	'catalan',
	'danish',
	'dutch',
	'english',
	'estonian',
	'finnish',
	'french',
	'german',
	'greek',
	'hindi',
	'hungarian',
	'indonesian',
	'irish',
	'italian',
	'lithuanian',
	'nepali',
	'norwegian',
	'portuguese',
	'romanian',
	'russian',
	'serbian',
	'spanish',
	'swedish',
	'tamil',
	'turkish',
	'yiddish',
]

/**
 * A grounded search index: the spec's field *ids* resolved to column *names*,
 * which is the form the database layer needs and the only form it gets. Same
 * shape of translation `SpecFieldShape.reference` makes — core stays free of the
 * `fld-` id convention.
 */
export interface SearchIndexPlan {
	/** The declaration's key. Becomes the database identifier via {@link searchIndexName}. */
	key: string
	/** A text-search configuration name, already checked against the enum. */
	language: string
	/** Columns in rank order, already sorted by the spec layer. */
	fields: readonly { column: string; weight: SearchWeight }[]
	/** Whether the physical GIN index exists. See the op's doc comment. */
	indexed: boolean
}

/** One ranked row. `rank` is `ts_rank`'s score for this row against this query. */
export interface SearchHit {
	row: Record<string, unknown>
	rank: number
}

/**
 * The maximum length of a query string the search path will accept.
 *
 * `websearch_to_tsquery` does not throw on hostile input, but it does *work* on
 * it, and a megabyte of text is a megabyte of tokenizing per row scanned. Bounded
 * here rather than at the route so every caller — REST, MCP, the admin loader —
 * gets the same bound, which is the same argument `authorize()` makes about
 * living below the routes.
 */
export const MAX_SEARCH_QUERY_LENGTH = 200

/** The database identifier for an index. Mirrors the spec's `searchIndexName`. */
export function searchIndexName(key: string): string {
	return `search_${key.replace(/-/g, '_')}`
}

/** Double-quote a SQL identifier, refusing anything that would need escaping. */
function quoteIdent(name: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
		throw new Error(
			`search: refusing to build SQL for identifier ${JSON.stringify(name)}`,
		)
	return `"${name}"`
}

/**
 * Restate the validator's three enum constraints as a runtime check.
 *
 * Deliberately redundant with `searchIndexErrors`. That function runs on the
 * spec, and everything that reaches here should have passed it — but "should
 * have" is the load-bearing word in every injection postmortem, and this module
 * is the one that concatenates strings into SQL. The cost of being sure is four
 * comparisons per index per boot.
 */
export function assertPlanIsSafe(plan: SearchIndexPlan): void {
	if (!SEARCH_LANGUAGES.includes(plan.language))
		throw new Error(
			`search: unknown text search configuration ${plan.language}`,
		)
	for (const field of plan.fields) {
		if (!SEARCH_WEIGHTS.includes(field.weight))
			throw new Error(`search: unknown weight ${field.weight}`)
		quoteIdent(field.column)
	}
}

/**
 * The weighted `tsvector` expression for a plan — the one string both the index
 * and the query are built from.
 *
 * `coalesce(col, '')` rather than `col` because `to_tsvector` of NULL is NULL,
 * and NULL concatenated with anything is NULL: a single empty optional field
 * would otherwise erase the whole document from the index, which is a bug that
 * only shows up on the rows nobody filled in completely.
 */
export function tsvectorExpr(plan: SearchIndexPlan): string {
	assertPlanIsSafe(plan)
	if (plan.fields.length === 0)
		throw new Error(`search: index "${plan.key}" has no fields`)
	return plan.fields
		.map(
			(f) =>
				`setweight(to_tsvector('${plan.language}', coalesce(${quoteIdent(f.column)}, '')), '${f.weight}')`,
		)
		.join(' || ')
}

/**
 * The DDL for a plan: one statement, either creating the index or dropping it.
 *
 * **Both directions are additive-safe**, which is the property that lets
 * `search.setIndexing` be a routine operation rather than a migration. An
 * expression index stores nothing that is not recomputable from the columns it
 * reads, so `DROP INDEX` cannot lose a row, and `CREATE INDEX` adds no column
 * and rewrites no table.
 *
 * Not `CONCURRENTLY`: it cannot run inside a transaction block, and the boot
 * path applies DDL as one multi-statement `exec`. A deployment large enough to
 * need a concurrent build is one where the declaration should land with
 * `indexed: false` and the index be built by hand — which is exactly what that
 * flag is for, and is stated in `docs/search.md` rather than guessed at here.
 *
 * Contains no semicolon inside a literal or a body, so it survives the postgres
 * backend's naive statement splitter (`backend.ts`). Pinned by a test, because
 * that splitter is a trap the next person emitting DDL will also walk into.
 */
export function searchIndexDdl(table: string, plan: SearchIndexPlan): string {
	const name = quoteIdent(searchIndexName(plan.key))
	if (!plan.indexed) return `DROP INDEX IF EXISTS ${name};`
	return `CREATE INDEX IF NOT EXISTS ${name} ON ${quoteIdent(table)} USING GIN ((${tsvectorExpr(plan)}));`
}

/**
 * The ranked query for a plan, as `{ text, params }` for `backend.query`.
 *
 * Three things about its shape are deliberate:
 *
 * - **`websearch_to_tsquery`, not `to_tsquery`.** The latter raises on input as
 *   ordinary as a trailing `&`, which turns a search box into a 500 nobody can
 *   reproduce on purpose. `websearch_to_tsquery` never raises, and it already
 *   understands quoted phrases, `OR` and `-term` — which is what people type
 *   when they think they are using Google.
 * - **The query is a bind parameter**, appearing once and interpolated never.
 * - **`extraWhere` is appended, never merged.** It carries the caller's scoping
 *   predicates (tenant, soft-delete), and they are AND-ed on last so nothing in
 *   the search half can widen them — the same ordering rule `opList` states
 *   about its forced filters.
 */
export function searchSql(
	table: string,
	plan: SearchIndexPlan,
	opts: {
		query: string
		limit: number
		offset: number
		/** Already-parameterized predicates, AND-ed after the match. */
		extraWhere?: readonly string[]
		/** Bind values for `extraWhere`, in order, starting at `$2`. */
		extraParams?: readonly unknown[]
	},
): { text: string; params: unknown[] } {
	const expr = tsvectorExpr(plan)
	const conds = [
		`(${expr}) @@ websearch_to_tsquery('${plan.language}', $1)`,
		...(opts.extraWhere ?? []),
	]
	const text =
		`SELECT *, ts_rank((${expr}), websearch_to_tsquery('${plan.language}', $1)) AS "__rank"\n` +
		`FROM ${quoteIdent(table)}\n` +
		`WHERE ${conds.join(' AND ')}\n` +
		// Ties broken by a stable column so paging through a result set cannot
		// show the same row twice: rank alone is not a total order, and LIMIT
		// without one is only deterministic by luck.
		`ORDER BY "__rank" DESC, "id" ASC\n` +
		`LIMIT ${Math.trunc(opts.limit)} OFFSET ${Math.trunc(opts.offset)}`
	return { text, params: [opts.query, ...(opts.extraParams ?? [])] }
}

/** The matching-row count for a plan, under the same predicates as {@link searchSql}. */
export function searchCountSql(
	table: string,
	plan: SearchIndexPlan,
	opts: {
		query: string
		extraWhere?: readonly string[]
		extraParams?: readonly unknown[]
	},
): { text: string; params: unknown[] } {
	const expr = tsvectorExpr(plan)
	const conds = [
		`(${expr}) @@ websearch_to_tsquery('${plan.language}', $1)`,
		...(opts.extraWhere ?? []),
	]
	return {
		text: `SELECT count(*)::int AS "n" FROM ${quoteIdent(table)} WHERE ${conds.join(' AND ')}`,
		params: [opts.query, ...(opts.extraParams ?? [])],
	}
}

/**
 * Normalize a caller's query string, or `null` when there is nothing to search
 * for.
 *
 * A blank query returns `null` rather than every row. That is the difference
 * between a search endpoint and a list endpoint, and conflating them is how an
 * empty search box becomes an unbounded table scan the first time a crawler
 * finds the URL.
 */
export function normalizeSearchQuery(query: unknown): string | null {
	if (typeof query !== 'string') return null
	const trimmed = query.trim()
	if (trimmed.length === 0) return null
	return trimmed.slice(0, MAX_SEARCH_QUERY_LENGTH)
}
