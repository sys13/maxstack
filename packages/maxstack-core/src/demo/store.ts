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
	max as maxOf,
	min as minOf,
	or,
	type SQL,
	sql,
	sum as sumOf,
} from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
// Type-only: the pglite driver is Node-only and would otherwise be pulled into
// any client bundle importing `@maxstack/core` (this module hosts the core,
// backend-agnostic `createDrizzleStore`). The one helper that instantiates
// pglite — `createDemoDb` — lazy-imports the driver, matching the lazy-import
// idiom in `sprout/backend.ts` (postgres.js, node:fs).
import type { drizzle } from 'drizzle-orm/pglite'
import { classifyConstraintViolation } from '../sprout/constraints.ts'
import type { DerivedAggFn } from '../sprout/derived.ts'
import type { ResourceRegistry } from '../sprout/registry.ts'
import {
	type SearchHit,
	type SearchIndexPlan,
	searchCountSql,
	searchSql,
} from '../sprout/search.ts'
import type {
	AggregateBucket,
	AggregateQuery,
	ListOptions,
	RawQueryRunner,
	Row,
	SearchOptions,
	SproutStore,
} from '../sprout/store.ts'
import type { SproutColumnType } from '../sprout/types.ts'
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

/**
 * The SQL each aggregate compiles to, as a **closed map**.
 *
 * A `Record<DerivedAggFn, ...>` rather than a string interpolation: the
 * function name arrives from a spec declaration, and looking it up in a map the
 * type checker proves total means an unexpected value is a missing key (a
 * `TypeError` at the call, loudly) rather than a fragment of SQL text.
 *
 * `avg` is cast to `double precision` because Postgres returns a `numeric`
 * average with full scale — `3.3333333333333333` as a string — and the caller
 * wants a number to draw a bar with, not an arbitrary-precision decimal.
 */
const AGGREGATE_SQL: Record<DerivedAggFn, (operand: SQL) => SQL<unknown>> = {
	count: () => sql`count(*)`,
	countDistinct: (operand) => sql`count(distinct ${operand})`,
	sum: (operand) => sumOf(operand as never) as SQL<unknown>,
	avg: (operand) => sql`avg(${operand})::double precision`,
	min: (operand) => minOf(operand as never) as SQL<unknown>,
	max: (operand) => maxOf(operand as never) as SQL<unknown>,
}

/**
 * Normalize a group key to the string the UI buckets by.
 *
 * A `Date` (a timestamp column read in date mode, which is what `date_trunc`
 * comes back as) becomes its ISO instant so the key is stable across the wire;
 * a boolean or number becomes its text form so `false` and `0` stay distinct
 * from the null bucket. `null` stays `null` — "rows with no value" is a real
 * bucket, and folding it into an empty string would merge it with a blank one.
 */
function bucketKey(value: unknown): string | null {
	if (value == null) return null
	if (value instanceof Date) return value.toISOString()
	return String(value)
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

/**
 * Run a write and classify what the driver refuses.
 *
 * This is the boundary #352 asks for, and it is *here* rather than in the ops
 * because the SQLSTATE only exists on this side of the store interface: a
 * `SproutStore` is the contract the ops speak, and the ops must not learn what
 * a Postgres error looks like to keep working over a store that has no driver
 * at all. So the driver-shaped fact is turned into a platform-shaped error at
 * the one place that has both — the store — and everything above it sees a
 * constructed error it already knows how to render.
 *
 * Anything unrecognised is re-thrown **untouched**, so an unexpected failure
 * keeps its stack and still reaches `fail()` as the generic 500 with the detail
 * on stderr. Wrapping only the writes is deliberate: class-23 violations are
 * raised by INSERT/UPDATE/DELETE, and a read that somehow raised one would be a
 * genuine surprise worth a 500.
 */
async function classifyingWrite<T>(
	registry: ResourceRegistry,
	resource: string,
	run: () => Promise<T>,
): Promise<T> {
	try {
		return await run()
	} catch (error) {
		const columns =
			registry.get(resource)?.resource.columns.map((c) => c.name) ?? []
		const violation = classifyConstraintViolation(error, resource, columns)
		if (violation) throw violation
		throw error
	}
}

/**
 * Values a Postgres primary key can be compared against without the *driver*
 * rejecting the literal.
 *
 * Only the two column types where a malformed literal is a hard parse error
 * (SQLSTATE 22P02) are listed. A `text` key takes anything, so it is absent and
 * {@link SproutStore.acceptsId} answers `true` for it — the same "absence means
 * yes" rule the interface states, applied one level down. Deliberately narrow:
 * a shape this does not recognise keeps today's behaviour rather than inventing
 * a new 404.
 */
const KEY_SHAPES: Partial<Record<SproutColumnType, RegExp>> = {
	uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
	// `serial`/`integer` keys introspect as `number`. Postgres rejects a
	// non-integer literal for them exactly as it rejects a non-uuid for a uuid.
	number: /^-?\d+$/,
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
		acceptsId(resource, id) {
			const entry = registry.get(resource)
			if (!entry) return true
			const pk = entry.resource.columns.find(
				(c) => c.name === entry.resource.primaryKey,
			)
			const shape = pk ? KEY_SHAPES[pk.type] : undefined
			// No declared shape for this key type — the store has nothing to say, so
			// it says yes and the read proceeds exactly as it did before #354.
			return shape ? shape.test(id) : true
		},
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
		async aggregate(
			resource,
			query: AggregateQuery,
			opts: ListOptions = {},
		): Promise<AggregateBucket[]> {
			const { table } = tableFor(registry, resource)
			const cols = table as Record<string, unknown>
			// An unknown group or measure column **throws**, breaking this store's
			// otherwise-universal "skip what you don't recognise" rule — and the
			// asymmetry is the point. Dropping a stale `filter` widens a read toward
			// a cap that already applied, so it is safe and keeps a stale spec from
			// 500ing. Dropping a `GROUP BY` does not widen anything: it collapses the
			// answer to one bucket, which is a *wrong number that looks right*. There
			// is no honest degraded aggregate, so there is no degraded aggregate.
			const groupCol = columnOf(cols, query.groupColumn)
			if (!groupCol)
				throw new Error(
					`aggregate: "${resource}" has no column "${query.groupColumn}" to group by`,
				)
			const measureCol =
				query.fn === 'count' ? null : columnOf(cols, query.measureColumn ?? '')
			if (query.fn !== 'count' && !measureCol)
				throw new Error(
					`aggregate: "${resource}" has no column "${query.measureColumn}" to aggregate`,
				)
			// The bucket is a *bound parameter* to `date_trunc`, never spliced into
			// the statement — so even though it is a closed set upstream, nothing
			// here depends on that having been true.
			const keyExpr = query.bucket
				? sql`date_trunc(${query.bucket}, ${groupCol as SQL})`
				: sql`${groupCol as SQL}`
			const operand = sql`${measureCol as SQL}`
			// A closed map, keyed by the function name: the SQL is chosen, never
			// composed from the caller's string.
			const valueExpr = AGGREGATE_SQL[query.fn](operand)
			const where = whereFor(cols, opts)
			const base = db
				.select({ key: keyExpr, value: valueExpr, n: countRows() })
				.from(table)
			const rows = await (where ? base.where(where) : base)
				// `GROUP BY 1` / `ORDER BY 2 DESC, 1` — *ordinals*, not a second copy
				// of the expressions. Repeating them is what a first cut does, and it
				// fails: drizzle renders a bare column reference unqualified in the
				// select list and table-qualified in the GROUP BY, so Postgres sees two
				// different expressions and refuses the whole statement with "must
				// appear in the GROUP BY clause". Ordinals are literals written here,
				// so they carry nothing from the caller, and they make it structurally
				// impossible for the grouped expression to drift from the selected one.
				.groupBy(sql`1`)
				// Largest first, so a `limit` keeps the buckets that matter rather
				// than an arbitrary slice. Ties fall back to the key for a stable
				// order — an unordered truncation is a chart that reshuffles itself
				// between two identical reads.
				.orderBy(sql`2 desc, 1`)
				.limit(query.limit)
			return (rows as { key: unknown; value: unknown; n: unknown }[]).map(
				(row) => ({
					key: bucketKey(row.key),
					// Postgres returns `numeric` (sum/avg over a numeric column, and
					// every count) as a *string* to avoid float loss. Coerced here, at
					// the one place that knows it came from a driver, so nothing above
					// the store ever compares a number to "12".
					value: row.value == null ? null : Number(row.value),
					count: Number(row.n ?? 0),
				}),
			)
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
			return classifyingWrite(registry, resource, async () => {
				const rows = await db
					.insert(table)
					.values(data as never)
					.returning()
				return rows[0] as Row
			})
		},
		async update(resource, id, data) {
			const { table, pkCol } = tableFor(registry, resource)
			return classifyingWrite(registry, resource, async () => {
				const rows = await db
					.update(table)
					.set(data as never)
					.where(eq(pkCol as never, id))
					.returning()
				return (rows[0] as Row) ?? null
			})
		},
		async delete(resource, id) {
			const { table, pkCol } = tableFor(registry, resource)
			return classifyingWrite(registry, resource, async () => {
				const rows = (await db
					.delete(table)
					.where(eq(pkCol as never, id))
					.returning()) as unknown[]
				return rows.length > 0
			})
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
