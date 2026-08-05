/**
 * Derived-value evaluation — the runtime half of `data.addComputed`
 * and `data.addRollup`.
 *
 * The division of labour the spec layer fixed: **the spec declares the
 * computation, the runtime evaluates it.** Nothing here participates in code
 * generation, so §L4A determinism is unaffected — a rollup changes what a page
 * shows, never what the generator writes.
 *
 * Two evaluation strategies, because the two cases are genuinely different:
 *
 *   - **Computed fields evaluate in JavaScript** ({@link evaluateComputed}). The
 *     row is already in memory and the expression is arithmetic over its own
 *     columns, so a database round-trip would buy nothing.
 *   - **Rollups evaluate in SQL** ({@link buildRollupQuery}). The rows being
 *     aggregated are *not* fetched — that is the whole point — so the aggregate
 *     has to happen in the database, batched across the page of owner rows so a
 *     list of 25 costs one query per rollup rather than 25.
 *
 * The one place they meet: a rollup may aggregate a computed field
 * (`max(weight * (1 + reps/30))`), so the expression compiler emits SQL too
 * ({@link computedToSql}). Both paths walk the same closed AST, which is why
 * they cannot disagree about what a formula means.
 *
 * Layering: `@maxstack/core` does not depend on `@maxstack/spec`, so everything
 * here is structural and keyed by **column and table names**, not the spec's
 * branded ids. The caller resolves ids → names (the same grounding step
 * `SpecEntityShape` already goes through).
 */

/** Mirrors the spec layer's `AggFn` structurally. */
export type DerivedAggFn =
	| 'count'
	| 'countDistinct'
	| 'sum'
	| 'avg'
	| 'min'
	| 'max'

/** Mirrors the spec layer's `TimeBucket` structurally. */
export type DerivedBucket = 'day' | 'week' | 'month' | 'quarter' | 'year'

/** Mirrors the spec layer's `ComputedExpr`, with column *names* at the leaves. */
export type ComputedNode =
	| { kind: 'field'; field: string }
	| { kind: 'literal'; value: number }
	| {
			kind: 'binary'
			op: '+' | '-' | '*' | '/'
			left: ComputedNode
			right: ComputedNode
	  }

/** A computed field, resolved to column names. */
export interface ComputedShape {
	/** Accessor name the value is exposed under on the row. */
	name: string
	expr: ComputedNode
}

/**
 * One hop of a rollup's relation path: `column` is a foreign key on the *current*
 * table, and `table` is what it points at. The spec validator has already proven
 * the chain is well-formed and that the last hop lands on the owning entity.
 */
export interface RollupHop {
	column: string
	table: string
}

/** A rollup, resolved to table and column names. */
export interface RollupShape {
	/** Accessor name the value is exposed under on the owner row. */
	name: string
	/** Table whose rows are aggregated. */
	over: string
	/**
	 * Path from `over` up to the owning table. Omitted for a table-wide rollup
	 * (one value shared by every owner row).
	 */
	via?: RollupHop[]
	fn: DerivedAggFn
	/** Column on `over` to aggregate. Omitted for `count`. */
	column?: string
	/**
	 * Set instead of `column` when the rollup aggregates a *computed* field: the
	 * expression is inlined into the aggregate (`max(weight * (1 + reps/30))`).
	 */
	computed?: ComputedNode
	where?: { column: string; equals: string | number | boolean }[]
	groupBy?: { column: string; bucket?: DerivedBucket }
	/** Max groups per owner. Required by the spec validator whenever grouped. */
	limit?: number
}

/** One bucket of a grouped rollup's series. */
export interface RollupBucket {
	/** The group key — a column value, or an ISO date for a bucketed rollup. */
	key: string | null
	value: number | null
}

// ---------------------------------------------------------------------------
// Identifier + literal safety
// ---------------------------------------------------------------------------

/**
 * Quote a SQL identifier. Table and column names reach here from the spec, which
 * the op validator has already resolved against real entities — but this is the
 * boundary where a name becomes executable SQL, so it is escaped here rather
 * than on the assumption that every caller upstream stayed honest.
 */
function quoteIdent(name: string): string {
	return `"${name.replaceAll('"', '""')}"`
}

/** The Postgres aggregate for each {@link DerivedAggFn}. */
const AGG_SQL: Record<DerivedAggFn, (operand: string) => string> = {
	count: () => 'count(*)',
	countDistinct: (operand) => `count(distinct ${operand})`,
	sum: (operand) => `sum(${operand})`,
	avg: (operand) => `avg(${operand})`,
	min: (operand) => `min(${operand})`,
	max: (operand) => `max(${operand})`,
}

// ---------------------------------------------------------------------------
// Computed fields
// ---------------------------------------------------------------------------

/**
 * Evaluate a computed expression against an in-memory row.
 *
 * Returns `null` rather than `NaN` when the arithmetic cannot be done — a null
 * column (every spec column is nullable at the DB layer, since a required field
 * added to a populated table must not fail the ALTER), a non-numeric value, or a
 * division by zero. `null` is what "no value" already means everywhere else on a
 * row, and it renders as an empty cell instead of the string "NaN".
 */
export function evaluateComputed(
	expr: ComputedNode,
	row: Record<string, unknown>,
): number | null {
	switch (expr.kind) {
		case 'literal':
			return expr.value
		case 'field': {
			const raw = row[expr.field]
			if (raw === null || raw === undefined) return null
			const n = typeof raw === 'number' ? raw : Number(raw)
			return Number.isFinite(n) ? n : null
		}
		case 'binary': {
			const left = evaluateComputed(expr.left, row)
			const right = evaluateComputed(expr.right, row)
			if (left === null || right === null) return null
			switch (expr.op) {
				case '+':
					return left + right
				case '-':
					return left - right
				case '*':
					return left * right
				case '/':
					// Division by zero is the one runtime arithmetic failure the spec
					// validator cannot catch statically (it only rejects a literal 0).
					return right === 0 ? null : left / right
			}
		}
	}
}

/**
 * Compile a computed expression to a SQL scalar over `alias`.
 *
 * Used only when a rollup aggregates a computed field. Parenthesised at every
 * binary node so operator precedence comes from the AST rather than from SQL's —
 * `(a + b) * c` and `a + (b * c)` are different trees and must stay different
 * queries. Division uses `nullif(divisor, 0)` so a zero divisor yields NULL
 * (skipped by the aggregate) instead of erroring the whole query, matching
 * {@link evaluateComputed}'s `null`.
 */
export function computedToSql(expr: ComputedNode, alias: string): string {
	switch (expr.kind) {
		case 'literal':
			// A literal is validated finite by the spec layer; formatting it directly
			// keeps the parameter list for row values only.
			return `(${Number(expr.value)})`
		case 'field':
			return `${alias}.${quoteIdent(expr.field)}`
		case 'binary': {
			const left = computedToSql(expr.left, alias)
			const right = computedToSql(expr.right, alias)
			if (expr.op === '/') return `(${left} / nullif(${right}, 0))`
			return `(${left} ${expr.op} ${right})`
		}
	}
}

/**
 * Attach every computed field to a set of rows, in place of nothing — the rows
 * are returned as new objects so a caller's cached rows are never mutated.
 */
export function applyComputed<T extends Record<string, unknown>>(
	rows: readonly T[],
	computed: readonly ComputedShape[],
): (T & Record<string, number | null>)[] {
	if (computed.length === 0)
		return rows as (T & Record<string, number | null>)[]
	return rows.map((row) => {
		const derived: Record<string, number | null> = {}
		for (const c of computed) derived[c.name] = evaluateComputed(c.expr, row)
		return { ...row, ...derived }
	})
}

// ---------------------------------------------------------------------------
// Rollups
// ---------------------------------------------------------------------------

/** A parameterized SQL query. */
export interface DerivedQuery {
	text: string
	params: unknown[]
}

/**
 * Build the batched aggregate query for one rollup.
 *
 * Shape, for a two-hop grouped rollup (recipebox's shopping list):
 *
 * ```sql
 * SELECT t1."mealplanId"::text AS owner_id,
 *        t0."name"             AS group_key,
 *        sum(t0."quantity")    AS value
 *   FROM "ingredient" t0
 *   JOIN "recipe" t1 ON t1."id" = t0."recipeId"
 *  WHERE t1."mealplanId"::text = ANY($1::text[])
 *  GROUP BY owner_id, group_key
 *  ORDER BY value DESC NULLS LAST
 *  LIMIT $2
 * ```
 *
 * `ownerIds` scopes the aggregate to the page of rows actually being rendered,
 * which is what makes a list of 25 owners cost one query instead of 25. The ids
 * are compared as `text` on both sides so the same SQL works whether the owner's
 * key is a `uuid` (spec entities) or a `text` id (bundle infra tables, #37).
 *
 * The overall `LIMIT` is `owners × limit`: the per-owner cap is applied when the
 * flat result is folded into series ({@link groupRollupRows}). A window function
 * would enforce it in the database, but it would also make this query
 * unrunnable on any backend without `row_number()` — and the total bound is what
 * actually protects the request.
 */
export function buildRollupQuery(
	rollup: RollupShape,
	ownerIds: readonly string[],
): DerivedQuery {
	const params: unknown[] = []
	const bind = (value: unknown): string => {
		params.push(value)
		return `$${params.length}`
	}

	const hops = rollup.via ?? []
	const base = 't0'
	// Joins: hop i (from 1) brings in the table hop i-1 pointed at.
	const joins: string[] = []
	for (let i = 1; i < hops.length; i++) {
		const hop = hops[i - 1]
		if (!hop) continue
		const prev = `t${i - 1}`
		const alias = `t${i}`
		joins.push(
			`JOIN ${quoteIdent(hop.table)} ${alias} ON ${alias}."id" = ${prev}.${quoteIdent(hop.column)}`,
		)
	}
	// The owner key is the LAST hop's foreign key, read off the last joined table.
	const lastHop = hops.at(-1)
	const ownerExpr =
		lastHop === undefined
			? undefined
			: `t${hops.length - 1}.${quoteIdent(lastHop.column)}`

	// The aggregate operand: a plain column, an inlined computed expression, or
	// nothing at all for count(*).
	const operand = rollup.computed
		? computedToSql(rollup.computed, base)
		: rollup.column
			? `${base}.${quoteIdent(rollup.column)}`
			: '*'
	const agg = AGG_SQL[rollup.fn](operand)

	const select: string[] = []
	if (ownerExpr) select.push(`${ownerExpr}::text AS owner_id`)
	if (rollup.groupBy) {
		const col = `${base}.${quoteIdent(rollup.groupBy.column)}`
		select.push(
			rollup.groupBy.bucket
				? `date_trunc(${bind(rollup.groupBy.bucket)}, ${col}) AS group_key`
				: `${col} AS group_key`,
		)
	}
	select.push(`${agg} AS value`)

	const where: string[] = []
	if (ownerExpr)
		where.push(`${ownerExpr}::text = ANY(${bind(ownerIds)}::text[])`)
	for (const filter of rollup.where ?? []) {
		where.push(`${base}.${quoteIdent(filter.column)} = ${bind(filter.equals)}`)
	}

	const groupTerms: string[] = []
	if (ownerExpr) groupTerms.push('owner_id')
	if (rollup.groupBy) groupTerms.push('group_key')

	const parts = [
		`SELECT ${select.join(', ')}`,
		`FROM ${quoteIdent(rollup.over)} ${base}`,
		...joins,
	]
	if (where.length > 0) parts.push(`WHERE ${where.join(' AND ')}`)
	if (groupTerms.length > 0) parts.push(`GROUP BY ${groupTerms.join(', ')}`)
	if (rollup.groupBy) {
		// A time series reads chronologically; a value-grouped rollup (a shopping
		// list, a top-N) reads largest-first. Neither default is arbitrary, and both
		// are what makes the truncation in `groupRollupRows` keep the right rows.
		parts.push(
			rollup.groupBy.bucket
				? 'ORDER BY group_key ASC NULLS LAST'
				: 'ORDER BY value DESC NULLS LAST',
		)
		const cap = (rollup.limit ?? 1) * Math.max(1, ownerIds.length)
		parts.push(`LIMIT ${bind(cap)}`)
	}

	return { text: parts.join('\n'), params }
}

/** A row as the aggregate query returns it. */
export interface RollupResultRow {
	owner_id?: string | null
	group_key?: unknown
	value?: unknown
}

/** Coerce an aggregate's value to a number, or null. Postgres returns
 * `numeric` as a string, so `sum`/`avg` arrive as text and must be parsed. */
function toNumber(value: unknown): number | null {
	if (value === null || value === undefined) return null
	const n = typeof value === 'number' ? value : Number(value)
	return Number.isFinite(n) ? n : null
}

/** Normalize a group key: dates to ISO strings, everything else to a string. */
function toKey(value: unknown): string | null {
	if (value === null || value === undefined) return null
	if (value instanceof Date) return value.toISOString()
	return String(value)
}

/**
 * Fold a flat aggregate result into per-owner values.
 *
 * Scalar rollups produce one number per owner. Grouped rollups produce a series,
 * truncated to the declared `limit` **per owner** — the query's `LIMIT` is a
 * total across the page, so the per-owner cap is enforced here where the owner
 * boundaries are actually known.
 *
 * A table-wide rollup (no `via`) has no `owner_id`; its single value is returned
 * under the `null` key and the caller applies it to every row.
 */
export function groupRollupRows(
	rollup: RollupShape,
	rows: readonly RollupResultRow[],
): Map<string | null, number | null | RollupBucket[]> {
	const out = new Map<string | null, number | null | RollupBucket[]>()
	for (const row of rows) {
		const owner = rollup.via ? (row.owner_id ?? null) : null
		if (!rollup.groupBy) {
			out.set(owner, toNumber(row.value))
			continue
		}
		const series = (out.get(owner) as RollupBucket[] | undefined) ?? []
		if (series.length < (rollup.limit ?? series.length + 1)) {
			series.push({ key: toKey(row.group_key), value: toNumber(row.value) })
		}
		out.set(owner, series)
	}
	return out
}

/**
 * The empty value for a rollup with no matching child rows.
 *
 * `count` is 0 — no rows genuinely means none. Every other aggregate is `null`,
 * not 0: a client with no invoices has no *average* invoice, and reporting 0
 * would be a claim the data does not support. Grouped rollups are an empty
 * series.
 */
export function emptyRollupValue(
	rollup: RollupShape,
): number | null | RollupBucket[] {
	if (rollup.groupBy) return []
	return rollup.fn === 'count' ? 0 : null
}

/** Runs a parameterized query and returns rows. Injected so this module needs no
 * driver, and the same code path serves pglite and Postgres. */
export type DerivedQueryRunner = (
	query: DerivedQuery,
) => Promise<readonly RollupResultRow[]>

/**
 * Resolve every rollup for a page of owner rows and attach the values.
 *
 * One query per rollup, batched across the page — never per row. Rows come back
 * as new objects; the input is not mutated. A rollup whose query fails is not
 * allowed to take the page down with it: the value lands as its empty form and
 * the error is surfaced through `onError` for the caller to log, because a
 * broken aggregate should degrade one card, not 500 the list.
 */
export async function resolveRollups<T extends Record<string, unknown>>(
	rows: readonly T[],
	rollups: readonly RollupShape[],
	deps: {
		run: DerivedQueryRunner
		/** Primary-key column of the owner rows (default `id`). */
		idColumn?: string
		onError?: (rollup: RollupShape, err: unknown) => void
	},
): Promise<(T & Record<string, number | null | RollupBucket[]>)[]> {
	if (rows.length === 0 || rollups.length === 0)
		return [...rows] as (T & Record<string, number | null | RollupBucket[]>)[]
	const idColumn = deps.idColumn ?? 'id'
	const ownerIds = rows
		.map((r) => r[idColumn])
		.filter((v): v is string | number => v !== null && v !== undefined)
		.map(String)

	const resolved = new Map<
		string,
		Map<string | null, number | null | RollupBucket[]>
	>()
	for (const rollup of rollups) {
		try {
			const result = await deps.run(buildRollupQuery(rollup, ownerIds))
			resolved.set(rollup.name, groupRollupRows(rollup, result))
		} catch (err) {
			deps.onError?.(rollup, err)
			resolved.set(rollup.name, new Map())
		}
	}

	return rows.map((row) => {
		const derived: Record<string, number | null | RollupBucket[]> = {}
		for (const rollup of rollups) {
			const byOwner = resolved.get(rollup.name)
			const key = rollup.via ? String(row[idColumn]) : null
			// `?? empty` is deliberate over a `has` check: a scalar rollup whose
			// aggregate came back NULL and one with no matching rows both mean "no
			// value", and for `count` both must read as 0.
			derived[rollup.name] = byOwner?.get(key) ?? emptyRollupValue(rollup)
		}
		return { ...row, ...derived }
	})
}
