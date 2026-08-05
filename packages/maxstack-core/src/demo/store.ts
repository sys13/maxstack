/**
 * A generic `SproutStore` over drizzle + pglite, driven by the registry: it
 * resolves the drizzle table object for a resource and does CRUD against it.
 *
 * Assumption (demo-scoped): a table's JS property names equal its DB column
 * names, so `store` data keys map straight to columns. A camel↔snake naming
 * layer is future work — noted in the reference designis the FK
 * display enrichment; the naming map belongs with it.
 */

import type { PGlite } from '@electric-sql/pglite'
import {
	and,
	asc,
	count as countRows,
	desc,
	eq,
	gte,
	ilike,
	inArray,
	isNull,
	lte,
	or,
	type SQL,
} from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
// Type-only: the pglite driver is Node-only and would otherwise be pulled into
// any client bundle importing `@maxstack/core` (this module hosts the core,
// backend-agnostic `createDrizzleStore`). The one helper that instantiates
// pglite — `createDemoDb` — lazy-imports the driver, matching the lazy-import
// idiom in `sprout/backend.ts` (postgres.js, node:fs).
import type { drizzle } from 'drizzle-orm/pglite'
import type { ResourceRegistry } from '../sprout/registry.ts'
import {
	type SearchHit,
	type SearchIndexPlan,
	searchCountSql,
	searchSql,
} from '../sprout/search.ts'
import type {
	ListOptions,
	RawQueryRunner,
	Row,
	SearchOptions,
	SproutStore,
} from '../sprout/store.ts'
import { DEMO_DDL } from './schema.ts'

type AnyDb = ReturnType<typeof drizzle>

function tableFor(registry: ResourceRegistry, resource: string) {
	const entry = registry.get(resource)
	if (!entry) throw new Error(`Unknown resource: ${resource}`)
	const table = entry.table as unknown as Record<string, unknown> & PgTable
	const pkCol = (table as Record<string, unknown>)[entry.resource.primaryKey]
	return { table, pkCol }
}

/** Resolve a column object by name, or null if the resource has no such column
 * (so a stale filter/search field is ignored rather than throwing). */
function columnOf(table: Record<string, unknown>, name: string): unknown {
	return table[name] !== undefined ? table[name] : null
}

/** True for a range bound worth emitting — present and not a blank string (a
 * cleared range input arrives as `''`, which must be a no-op, not `>= ''`). */
function hasBound(v: string | number | undefined): v is string | number {
	return v != null && v !== ''
}

/** Coerce a range comparand to the shape drizzle will hand the driver for this
 * column. A Date-mode timestamp column (drizzle `columnType === 'PgTimestamp'`)
 * maps its value via `Date.prototype.toISOString`, so a URL/JSON string bound
 * must become a `Date`; a string-mode timestamp (`PgTimestampString`) and every
 * numeric/text column take the raw comparand. An unparseable date falls back to
 * the raw value rather than emitting an `Invalid Date`. */
function coerceBound(col: unknown, v: string | number): unknown {
	if ((col as { columnType?: string }).columnType !== 'PgTimestamp') return v
	const d = new Date(v)
	return Number.isNaN(d.getTime()) ? v : d
}

/**
 * The overlap clause — the one predicate that has to see two
 * columns at once.
 *
 * ```
 *   (end IS NULL     AND start >= from AND start <= to)
 *   OR (end IS NOT NULL AND start <= to  AND end   >= from)
 * ```
 *
 * The null branch is not a special case bolted on: a row with no end **is** a
 * point at its start, so it belongs in the window exactly when its start does.
 * Writing this as two `range` bounds silently drops every such row, which is
 * why ranged calendars read a cap instead of a window until now — and a
 * calendar that silently drops a row is the worst failure a calendar has.
 *
 * An unknown column makes the whole clause a no-op, matching `whereFor`'s rule
 * for `filter` and `range`. Safe in the same way and for the same reason:
 * dropping it *widens* to the row cap that already applied, and no
 * authorization predicate travels through here (`opList` AND-s the tenant and
 * soft-delete scopes separately, exactly as `searchPredicates` documents).
 */
function overlapWhere(
	table: Record<string, unknown>,
	window: ListOptions['overlaps'],
): SQL | undefined {
	if (!window) return undefined
	const startCol = columnOf(table, window.startColumn)
	const endCol = columnOf(table, window.endColumn)
	if (!startCol || !endCol) return undefined
	const from = coerceBound(startCol, window.from)
	const to = coerceBound(startCol, window.to)
	const endFrom = coerceBound(endCol, window.from)
	const point = and(
		isNull(endCol as never),
		gte(startCol as never, from as never),
		lte(startCol as never, to as never),
	)
	// No `IS NOT NULL` here: `end >= from` evaluates to NULL when `end` is NULL,
	// and NULL is not true, so a row with no end cannot match this branch. It is
	// caught by `point` above or by neither — never by both.
	const span = and(
		lte(startCol as never, to as never),
		gte(endCol as never, endFrom as never),
	)
	// `or` of two `and`s rather than a flattened expression: the two branches ask
	// different questions of different columns, and flattening them is how the
	// null case quietly stops being tested.
	return or(point as SQL, span as SQL)
}

/** Build the `WHERE` from a list's `filter` (equality), `range` (`>=`/`<=`),
 * `overlaps` (a two-column window), and `search` (ILIKE over
 * `searchFields`). Unknown columns are skipped. Returns `undefined` when
 * empty. */
function whereFor(
	table: Record<string, unknown>,
	opts: ListOptions,
): SQL | undefined {
	const conds: SQL[] = []
	for (const [key, value] of Object.entries(opts.filter ?? {})) {
		const col = columnOf(table, key)
		if (!col) continue
		// `{ deletedAt: null }` (soft-delete's default scope) must compile to
		// `IS NULL`, not `= NULL` — the latter is never true in SQL and would
		// silently hide every row instead of the deleted ones.
		conds.push(
			value === null ? isNull(col as never) : eq(col as never, value as never),
		)
	}
	for (const [key, bound] of Object.entries(opts.range ?? {})) {
		const col = columnOf(table, key)
		if (!col) continue
		if (hasBound(bound.gte))
			conds.push(gte(col as never, coerceBound(col, bound.gte) as never))
		if (hasBound(bound.lte))
			conds.push(lte(col as never, coerceBound(col, bound.lte) as never))
	}
	// The overlap window: both bounds and the null case, as one
	// clause. Two `range` bounds cannot say this — see `ListOptions.overlaps`.
	const overlap = overlapWhere(table, opts.overlaps)
	if (overlap) conds.push(overlap)
	const query = opts.search?.trim()
	if (query) {
		const ors: SQL[] = []
		for (const name of opts.searchFields ?? []) {
			const col = columnOf(table, name)
			if (col) ors.push(ilike(col as never, `%${query}%`))
		}
		const searchCond = ors.length > 1 ? or(...ors) : ors[0]
		if (searchCond) conds.push(searchCond)
	}
	if (conds.length === 0) return undefined
	return conds.length > 1 ? and(...conds) : conds[0]
}

/**
 * Compile a search's equality filters into `$n` predicates.
 *
 * Column names are checked against the real table and an unknown one is
 * *skipped*, matching `whereFor` — but note the asymmetry that matters:
 * `opSearch`'s forced tenant and soft-delete scopes come through here, and a
 * skipped predicate there would widen a read. That is why `opSearch` resolves
 * those columns from the registry before calling, rather than trusting this to
 * carry them. Values are always bound, never interpolated.
 */
function searchPredicates(
	table: Record<string, unknown>,
	opts: Pick<SearchOptions, 'filter' | 'range'>,
	firstParam: number,
): { where: string[]; params: unknown[] } {
	const where: string[] = []
	const params: unknown[] = []
	const usable = (key: string) =>
		columnOf(table, key) !== null && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
	for (const [key, value] of Object.entries(opts.filter ?? {})) {
		if (!usable(key)) continue
		// `null` compiles to `IS NULL`, never `= NULL` — the soft-delete default
		// scope arrives this way, and `= NULL` is never true, so getting it wrong
		// hides every row rather than the deleted ones.
		if (value === null) where.push(`"${key}" IS NULL`)
		else {
			where.push(`"${key}" = $${firstParam + params.length}`)
			params.push(value)
		}
	}
	for (const [key, bound] of Object.entries(opts.range ?? {})) {
		if (!usable(key)) continue
		// Same blank-bound rule `whereFor` applies: a cleared range input arrives
		// as `''` and must be a no-op, not `>= ''`. No `coerceBound` equivalent is
		// needed here — these are bound parameters, so the server infers the type
		// from the column rather than from what the driver guessed in JS.
		if (bound.gte != null && bound.gte !== '') {
			where.push(`"${key}" >= $${firstParam + params.length}`)
			params.push(bound.gte)
		}
		if (bound.lte != null && bound.lte !== '') {
			where.push(`"${key}" <= $${firstParam + params.length}`)
			params.push(bound.lte)
		}
	}
	return { where, params }
}

export function createDrizzleStore(
	db: AnyDb,
	registry: ResourceRegistry,
	/**
	 * A parameterized SELECT runner. Optional, and its absence is what makes
	 * {@link SproutStore.search} absent — see that method's doc for why the
	 * fallback is a refusal rather than an `ILIKE` scan.
	 */
	run?: RawQueryRunner,
): SproutStore {
	const searchable = run
		? {
				async search(
					resource: string,
					plan: SearchIndexPlan,
					query: string,
					opts: SearchOptions = {},
				): Promise<SearchHit[]> {
					const { table } = tableFor(registry, resource)
					const { where, params } = searchPredicates(
						table as Record<string, unknown>,
						opts,
						2,
					)
					const q = searchSql(resource, plan, {
						query,
						limit: opts.limit ?? 50,
						offset: opts.offset ?? 0,
						extraWhere: where,
						extraParams: params,
					})
					const rows = await run(q.text, q.params)
					// `__rank` is stripped off the row rather than handed back on it: a
					// caller merging it into the record would be adding a column the
					// entity never declared, and the first thing to break is a form.
					return rows.map((raw) => {
						const { __rank, ...row } = raw as Record<string, unknown> & {
							__rank?: unknown
						}
						return { row, rank: Number(__rank ?? 0) }
					})
				},
				async searchCount(
					resource: string,
					plan: SearchIndexPlan,
					query: string,
					opts: SearchOptions = {},
				): Promise<number> {
					const { table } = tableFor(registry, resource)
					const { where, params } = searchPredicates(
						table as Record<string, unknown>,
						opts,
						2,
					)
					const q = searchCountSql(resource, plan, {
						query,
						extraWhere: where,
						extraParams: params,
					})
					const rows = await run(q.text, q.params)
					return Number((rows[0] as { n?: number | string })?.n ?? 0)
				},
			}
		: {}

	return {
		...searchable,
		async list(resource, opts: ListOptions = {}) {
			const { table } = tableFor(registry, resource)
			// Order by a real column only — an unknown `orderBy` (e.g. a stale spec
			// field) is ignored rather than throwing, so a bad block never 500s.
			const orderCol =
				opts.orderBy &&
				(table as Record<string, unknown>)[opts.orderBy] !== undefined
					? ((table as Record<string, unknown>)[opts.orderBy] as never)
					: null
			const where = whereFor(table as Record<string, unknown>, opts)
			const filtered = where
				? db.select().from(table).where(where)
				: db.select().from(table)
			const ordered = orderCol
				? filtered.orderBy(
						opts.orderDir === 'desc' ? desc(orderCol) : asc(orderCol),
					)
				: filtered
			const rows = await ordered
				.limit(opts.limit ?? 50)
				.offset(opts.offset ?? 0)
			return rows as Row[]
		},
		async count(resource, opts: ListOptions = {}) {
			const { table } = tableFor(registry, resource)
			const where = whereFor(table as Record<string, unknown>, opts)
			const base = db.select({ n: countRows() }).from(table)
			const rows = await (where ? base.where(where) : base)
			return Number((rows[0] as { n: number | string })?.n ?? 0)
		},
		async get(resource, id) {
			const { table, pkCol } = tableFor(registry, resource)
			const rows = await db
				.select()
				.from(table)
				.where(eq(pkCol as never, id))
			return (rows[0] as Row) ?? null
		},
		async getMany(resource, ids) {
			if (ids.length === 0) return []
			const { table, pkCol } = tableFor(registry, resource)
			const rows = await db
				.select()
				.from(table)
				.where(inArray(pkCol as never, ids as never))
			return rows as Row[]
		},
		async create(resource, data) {
			const { table } = tableFor(registry, resource)
			const rows = await db
				.insert(table)
				.values(data as never)
				.returning()
			return rows[0] as Row
		},
		async update(resource, id, data) {
			const { table, pkCol } = tableFor(registry, resource)
			const rows = await db
				.update(table)
				.set(data as never)
				.where(eq(pkCol as never, id))
				.returning()
			return (rows[0] as Row) ?? null
		},
		async delete(resource, id) {
			const { table, pkCol } = tableFor(registry, resource)
			const rows = (await db
				.delete(table)
				.where(eq(pkCol as never, id))
				.returning()) as unknown[]
			return rows.length > 0
		},
	}
}

export interface DemoDb {
	client: PGlite
	db: AnyDb
	store: SproutStore
}

/** Spin up an in-memory pglite database with the demo schema materialized. */
export async function createDemoDb(
	registry: ResourceRegistry,
): Promise<DemoDb> {
	const { PGlite } = await import('@electric-sql/pglite')
	const { drizzle } = await import('drizzle-orm/pglite')
	const client = new PGlite()
	await client.exec(DEMO_DDL)
	const db = drizzle({ client })
	const store = createDrizzleStore(db, registry)
	return { client, db, store }
}
