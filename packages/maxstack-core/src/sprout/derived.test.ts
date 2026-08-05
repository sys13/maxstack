import { describe, expect, it, vi } from 'vitest'
import { bootPglite } from '../testing/pglite-snapshot.ts'
import {
	applyComputed,
	buildRollupQuery,
	type ComputedNode,
	computedToSql,
	emptyRollupValue,
	evaluateComputed,
	groupRollupRows,
	type RollupShape,
	resolveRollups,
} from './derived.ts'

/** `weight * (1 + reps / 30)` — Epley's estimated one-rep-max (gymlog's ask). */
const epley: ComputedNode = {
	kind: 'binary',
	op: '*',
	left: { kind: 'field', field: 'weight' },
	right: {
		kind: 'binary',
		op: '+',
		left: { kind: 'literal', value: 1 },
		right: {
			kind: 'binary',
			op: '/',
			left: { kind: 'field', field: 'reps' },
			right: { kind: 'literal', value: 30 },
		},
	},
}

describe('evaluateComputed', () => {
	it('evaluates the Epley formula against a row', () => {
		// 100 * (1 + 10/30) = 133.33…
		expect(evaluateComputed(epley, { weight: 100, reps: 10 })).toBeCloseTo(
			133.333,
			2,
		)
	})

	it('respects the AST’s parenthesisation, not SQL precedence', () => {
		const a: ComputedNode = {
			kind: 'binary',
			op: '*',
			left: {
				kind: 'binary',
				op: '+',
				left: { kind: 'literal', value: 2 },
				right: { kind: 'literal', value: 3 },
			},
			right: { kind: 'literal', value: 4 },
		}
		const b: ComputedNode = {
			kind: 'binary',
			op: '+',
			left: { kind: 'literal', value: 2 },
			right: {
				kind: 'binary',
				op: '*',
				left: { kind: 'literal', value: 3 },
				right: { kind: 'literal', value: 4 },
			},
		}
		expect(evaluateComputed(a, {})).toBe(20)
		expect(evaluateComputed(b, {})).toBe(14)
	})

	// Every spec column is nullable at the DB layer (a required field added to a
	// populated table must not fail the ALTER), so nulls are the normal case.
	it('returns null rather than NaN when a column is null or missing', () => {
		expect(evaluateComputed(epley, { weight: null, reps: 10 })).toBeNull()
		expect(evaluateComputed(epley, { reps: 10 })).toBeNull()
		expect(evaluateComputed(epley, { weight: 'heavy', reps: 10 })).toBeNull()
	})

	it('parses numeric strings, which is how Postgres returns numeric', () => {
		expect(evaluateComputed(epley, { weight: '100', reps: '10' })).toBeCloseTo(
			133.333,
			2,
		)
	})

	// The spec validator rejects division by a *literal* zero; a zero that arrives
	// in the data can only be caught here.
	it('returns null on a runtime division by zero', () => {
		const div: ComputedNode = {
			kind: 'binary',
			op: '/',
			left: { kind: 'field', field: 'a' },
			right: { kind: 'field', field: 'b' },
		}
		expect(evaluateComputed(div, { a: 1, b: 0 })).toBeNull()
		expect(evaluateComputed(div, { a: 1, b: 2 })).toBe(0.5)
	})
})

describe('applyComputed', () => {
	it('attaches each computed value without mutating the input rows', () => {
		const rows = [
			{ id: '1', weight: 100, reps: 10 },
			{ id: '2', weight: 90, reps: 5 },
		]
		const out = applyComputed(rows, [{ name: 'estimated1rm', expr: epley }])
		expect(out[0]?.estimated1rm).toBeCloseTo(133.333, 2)
		expect(out[1]?.estimated1rm).toBeCloseTo(105, 2)
		expect(rows[0]).not.toHaveProperty('estimated1rm')
	})

	it('is a no-op with no computed fields', () => {
		const rows = [{ id: '1' }]
		expect(applyComputed(rows, [])).toEqual(rows)
	})
})

describe('computedToSql', () => {
	it('compiles the AST with explicit parentheses at every binary node', () => {
		expect(computedToSql(epley, 't0')).toBe(
			'(t0."weight" * ((1) + (t0."reps" / nullif((30), 0))))',
		)
	})

	// Matches `evaluateComputed`'s null: a zero divisor must skip the row's
	// contribution to the aggregate, not error the whole query.
	it('guards division with nullif so a zero divisor yields NULL', () => {
		expect(computedToSql(epley, 't0')).toContain('nullif((30), 0)')
	})

	it('escapes embedded quotes in a column name', () => {
		expect(computedToSql({ kind: 'field', field: 'we"ird' }, 't0')).toBe(
			't0."we""ird"',
		)
	})
})

// ---------------------------------------------------------------------------

const lifetimeSpend: RollupShape = {
	name: 'lifetimeSpend',
	over: 'order',
	via: [{ column: 'clientId', table: 'client' }],
	fn: 'sum',
	column: 'amount',
}

/** recipebox: a meal plan's shopping list, two hops up from its ingredients. */
const shoppingList: RollupShape = {
	name: 'shoppingList',
	over: 'ingredient',
	via: [
		{ column: 'recipeId', table: 'recipe' },
		{ column: 'mealplanId', table: 'mealplan' },
	],
	fn: 'sum',
	column: 'quantity',
	groupBy: { column: 'name' },
	limit: 200,
}

describe('buildRollupQuery', () => {
	it('builds a batched one-hop scalar aggregate', () => {
		const q = buildRollupQuery(lifetimeSpend, ['c1', 'c2'])
		expect(q.text).toContain('SELECT t0."clientId"::text AS owner_id')
		expect(q.text).toContain('sum(t0."amount") AS value')
		expect(q.text).toContain('FROM "order" t0')
		expect(q.text).toContain('GROUP BY owner_id')
		// One query for the whole page — never one per row.
		expect(q.text).toContain('= ANY($1::text[])')
		expect(q.params[0]).toEqual(['c1', 'c2'])
		// No JOIN needed for a single hop.
		expect(q.text).not.toContain('JOIN')
	})

	it('joins each intermediate table for a multi-hop path', () => {
		const q = buildRollupQuery(shoppingList, ['m1'])
		expect(q.text).toContain('FROM "ingredient" t0')
		expect(q.text).toContain('JOIN "recipe" t1 ON t1."id" = t0."recipeId"')
		// The owner key is the LAST hop's FK, read off the last joined table.
		expect(q.text).toContain('SELECT t1."mealplanId"::text AS owner_id')
		expect(q.text).toContain('GROUP BY owner_id, group_key')
	})

	it('compares ids as text so uuid and text keys share one query shape', () => {
		// Spec entities have uuid ids; bundle infra tables have text ids.
		const q = buildRollupQuery(lifetimeSpend, ['c1'])
		expect(q.text).toContain('t0."clientId"::text = ANY($1::text[])')
	})

	it('date-truncs a bucketed group key and binds the bucket as a parameter', () => {
		const q = buildRollupQuery(
			{
				...lifetimeSpend,
				groupBy: { column: 'placedAt', bucket: 'month' },
				limit: 12,
			},
			['c1'],
		)
		expect(q.text).toContain('date_trunc($1, t0."placedAt") AS group_key')
		expect(q.params[0]).toBe('month')
	})

	// A time series reads chronologically; a shopping list / top-N reads
	// largest-first. The ordering is what makes the per-owner truncation in
	// groupRollupRows keep the *right* rows rather than an arbitrary subset.
	it('orders a bucketed series by key and a value-grouped one by value', () => {
		expect(
			buildRollupQuery(
				{
					...lifetimeSpend,
					groupBy: { column: 'at', bucket: 'week' },
					limit: 4,
				},
				['c1'],
			).text,
		).toContain('ORDER BY group_key ASC NULLS LAST')
		expect(buildRollupQuery(shoppingList, ['m1']).text).toContain(
			'ORDER BY value DESC NULLS LAST',
		)
	})

	it('caps a grouped query at owners × limit', () => {
		const q = buildRollupQuery(shoppingList, ['m1', 'm2', 'm3'])
		expect(q.params.at(-1)).toBe(600)
	})

	it('emits count(*) with no operand, and countDistinct with one', () => {
		expect(
			buildRollupQuery({ ...lifetimeSpend, fn: 'count', column: undefined }, [
				'c1',
			]).text,
		).toContain('count(*) AS value')
		expect(
			buildRollupQuery({ ...lifetimeSpend, fn: 'countDistinct' }, ['c1']).text,
		).toContain('count(distinct t0."amount") AS value')
	})

	it('inlines a computed expression into the aggregate', () => {
		const q = buildRollupQuery(
			{
				name: 'peak1rm',
				over: 'logentry',
				via: [{ column: 'workoutId', table: 'workout' }],
				fn: 'max',
				computed: epley,
				groupBy: { column: 'loggedAt', bucket: 'week' },
				limit: 52,
			},
			['w1'],
		)
		expect(q.text).toContain(
			'max((t0."weight" * ((1) + (t0."reps" / nullif((30), 0))))) AS value',
		)
	})

	it('binds filter values as parameters, never interpolated', () => {
		const q = buildRollupQuery(
			{ ...lifetimeSpend, where: [{ column: 'status', equals: "o'brien" }] },
			['c1'],
		)
		expect(q.text).toContain('t0."status" = $2')
		expect(q.params[1]).toBe("o'brien")
		expect(q.text).not.toContain("o'brien")
	})

	it('omits owner grouping entirely for a table-wide rollup', () => {
		const q = buildRollupQuery(
			{ name: 'totalOrders', over: 'order', fn: 'count' },
			[],
		)
		expect(q.text).not.toContain('owner_id')
		expect(q.text).not.toContain('GROUP BY')
		expect(q.params).toEqual([])
	})
})

describe('groupRollupRows', () => {
	it('maps each owner to its scalar value', () => {
		const out = groupRollupRows(lifetimeSpend, [
			{ owner_id: 'c1', value: '150.5' },
			{ owner_id: 'c2', value: 20 },
		])
		expect(out.get('c1')).toBe(150.5)
		expect(out.get('c2')).toBe(20)
	})

	// Postgres returns `numeric` (sum/avg) as a string.
	it('parses numeric-as-string aggregates', () => {
		expect(
			groupRollupRows(lifetimeSpend, [{ owner_id: 'c1', value: '3.25' }]).get(
				'c1',
			),
		).toBe(3.25)
	})

	it('folds grouped rows into a per-owner series', () => {
		const out = groupRollupRows(shoppingList, [
			{ owner_id: 'm1', group_key: 'flour', value: 3 },
			{ owner_id: 'm1', group_key: 'sugar', value: 2 },
			{ owner_id: 'm2', group_key: 'salt', value: 1 },
		])
		expect(out.get('m1')).toEqual([
			{ key: 'flour', value: 3 },
			{ key: 'sugar', value: 2 },
		])
		expect(out.get('m2')).toEqual([{ key: 'salt', value: 1 }])
	})

	// The query's LIMIT is a total across the page; the per-owner cap can only be
	// enforced where the owner boundaries are known.
	it('truncates each owner’s series to the declared limit', () => {
		const rollup = { ...shoppingList, limit: 2 }
		const out = groupRollupRows(rollup, [
			{ owner_id: 'm1', group_key: 'a', value: 3 },
			{ owner_id: 'm1', group_key: 'b', value: 2 },
			{ owner_id: 'm1', group_key: 'c', value: 1 },
		])
		expect(out.get('m1')).toHaveLength(2)
		expect((out.get('m1') as { key: string }[]).map((b) => b.key)).toEqual([
			'a',
			'b',
		])
	})

	it('normalizes a Date group key to an ISO string', () => {
		const out = groupRollupRows(
			{ ...shoppingList, groupBy: { column: 'at', bucket: 'month' } },
			[
				{
					owner_id: 'm1',
					group_key: new Date('2026-07-01T00:00:00Z'),
					value: 5,
				},
			],
		)
		expect((out.get('m1') as { key: string }[])[0]?.key).toBe(
			'2026-07-01T00:00:00.000Z',
		)
	})

	it('keys a table-wide rollup under null', () => {
		const out = groupRollupRows(
			{ name: 'totalOrders', over: 'order', fn: 'count' },
			[{ value: 42 }],
		)
		expect(out.get(null)).toBe(42)
	})
})

describe('emptyRollupValue', () => {
	// "No rows" genuinely means count 0 — but a client with no invoices has no
	// *average* invoice, and reporting 0 would be a claim the data can't support.
	it('is 0 for count, null for every other aggregate, [] when grouped', () => {
		expect(emptyRollupValue({ name: 'n', over: 'o', fn: 'count' })).toBe(0)
		expect(emptyRollupValue(lifetimeSpend)).toBeNull()
		expect(emptyRollupValue({ ...lifetimeSpend, fn: 'avg' })).toBeNull()
		expect(emptyRollupValue(shoppingList)).toEqual([])
	})
})

describe('resolveRollups', () => {
	const rows = [
		{ id: 'c1', name: 'Acme' },
		{ id: 'c2', name: 'Globex' },
	]

	it('runs one query per rollup for the whole page, not one per row', async () => {
		const run = vi.fn(async () => [
			{ owner_id: 'c1', value: 100 },
			{ owner_id: 'c2', value: 50 },
		])
		const out = await resolveRollups(rows, [lifetimeSpend], { run })
		expect(run).toHaveBeenCalledTimes(1)
		expect(out[0]?.lifetimeSpend).toBe(100)
		expect(out[1]?.lifetimeSpend).toBe(50)
	})

	it('fills the empty value for an owner with no child rows', async () => {
		const run = vi.fn(async () => [{ owner_id: 'c1', value: 100 }])
		const out = await resolveRollups(rows, [lifetimeSpend], { run })
		expect(out[1]?.lifetimeSpend).toBeNull()
	})

	it('applies a table-wide rollup’s single value to every row', async () => {
		const total: RollupShape = {
			name: 'totalOrders',
			over: 'order',
			fn: 'count',
		}
		const run = vi.fn(async () => [{ value: 7 }])
		const out = await resolveRollups(rows, [total], { run })
		expect(out.map((r) => r.totalOrders)).toEqual([7, 7])
	})

	// A broken aggregate should degrade one card, not 500 the whole list.
	it('degrades a failing rollup instead of taking the page down', async () => {
		const onError = vi.fn()
		const run = vi.fn(async () => {
			throw new Error('relation does not exist')
		})
		const out = await resolveRollups(rows, [lifetimeSpend], { run, onError })
		expect(out).toHaveLength(2)
		expect(out[0]?.lifetimeSpend).toBeNull()
		expect(onError).toHaveBeenCalledOnce()
	})

	it('does not mutate the input rows', async () => {
		const run = vi.fn(async () => [{ owner_id: 'c1', value: 100 }])
		await resolveRollups(rows, [lifetimeSpend], { run })
		expect(rows[0]).not.toHaveProperty('lifetimeSpend')
	})

	it('short-circuits with no rows or no rollups', async () => {
		const run = vi.fn(async () => [])
		expect(await resolveRollups([], [lifetimeSpend], { run })).toEqual([])
		expect(await resolveRollups(rows, [], { run })).toEqual(rows)
		expect(run).not.toHaveBeenCalled()
	})

	it('honors a non-default primary-key column', async () => {
		const run = vi.fn(async () => [{ owner_id: 'k1', value: 5 }])
		const out = await resolveRollups([{ slug: 'k1' }], [lifetimeSpend], {
			run,
			idColumn: 'slug',
		})
		expect(out[0]?.lifetimeSpend).toBe(5)
	})
})

// ===========================================================================
// Against a real database.
//
// Every test above asserts the SQL *as text*, which proves the shape and misses
// the one thing that matters most: whether Postgres accepts it. These run the
// generated queries against pglite over the three corpus shapes #170 exists for.
// ===========================================================================

describe('generated SQL runs against pglite', () => {
	/** Run a built query through pglite and normalize to `RollupResultRow`s. */
	async function runner(client: {
		query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>
	}) {
		return async (q: { text: string; params: unknown[] }) => {
			const res = await client.query(q.text, q.params)
			return res.rows as Parameters<typeof groupRollupRows>[1]
		}
	}

	it('sums a one-hop scalar rollup per owner (invoicer-shaped)', async () => {
		const client = await bootPglite()
		await client.exec(`
			CREATE TABLE "client" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "name" text);
			CREATE TABLE "order" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
				"amount" real, "status" text, "clientId" uuid);
			INSERT INTO "client" ("id","name") VALUES
				('11111111-1111-1111-1111-111111111111','Acme'),
				('22222222-2222-2222-2222-222222222222','Globex'),
				('33333333-3333-3333-3333-333333333333','Empty');
			INSERT INTO "order" ("amount","status","clientId") VALUES
				(100,'paid','11111111-1111-1111-1111-111111111111'),
				(50.5,'paid','11111111-1111-1111-1111-111111111111'),
				(9,'draft','11111111-1111-1111-1111-111111111111'),
				(20,'paid','22222222-2222-2222-2222-222222222222');
		`)
		const rows = [
			{ id: '11111111-1111-1111-1111-111111111111' },
			{ id: '22222222-2222-2222-2222-222222222222' },
			{ id: '33333333-3333-3333-3333-333333333333' },
		]
		const out = await resolveRollups(
			rows,
			[
				lifetimeSpend,
				{
					...lifetimeSpend,
					name: 'paidSpend',
					where: [{ column: 'status', equals: 'paid' }],
				},
				{
					name: 'orderCount',
					over: 'order',
					via: lifetimeSpend.via,
					fn: 'count',
				},
			],
			{ run: await runner(client) },
		)
		expect(out[0]?.lifetimeSpend).toBeCloseTo(159.5, 1)
		// The filter really narrows the aggregate.
		expect(out[0]?.paidSpend).toBeCloseTo(150.5, 1)
		expect(out[0]?.orderCount).toBe(3)
		expect(out[1]?.lifetimeSpend).toBeCloseTo(20, 1)
		// An owner with no children: count 0, sum null — not 0.
		expect(out[2]?.lifetimeSpend).toBeNull()
		expect(out[2]?.orderCount).toBe(0)
		await client.close()
	})

	it('walks a two-hop join and groups (recipebox shopping list)', async () => {
		const client = await bootPglite()
		await client.exec(`
			CREATE TABLE "mealplan" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "week" timestamp);
			CREATE TABLE "recipe" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
				"name" text, "mealplanId" uuid);
			CREATE TABLE "ingredient" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
				"name" text, "quantity" real, "recipeId" uuid);
			INSERT INTO "mealplan" ("id") VALUES ('aaaaaaaa-0000-0000-0000-000000000001');
			INSERT INTO "recipe" ("id","name","mealplanId") VALUES
				('bbbbbbbb-0000-0000-0000-000000000001','Soup','aaaaaaaa-0000-0000-0000-000000000001'),
				('bbbbbbbb-0000-0000-0000-000000000002','Stew','aaaaaaaa-0000-0000-0000-000000000001');
			INSERT INTO "ingredient" ("name","quantity","recipeId") VALUES
				('onion',2,'bbbbbbbb-0000-0000-0000-000000000001'),
				('onion',3,'bbbbbbbb-0000-0000-0000-000000000002'),
				('salt',1,'bbbbbbbb-0000-0000-0000-000000000001');
		`)
		const out = await resolveRollups(
			[{ id: 'aaaaaaaa-0000-0000-0000-000000000001' }],
			[shoppingList],
			{ run: await runner(client) },
		)
		// The whole point of two hops: onion is summed ACROSS both recipes in the
		// plan (2 + 3), which a one-hop rollup could not have reached.
		expect(out[0]?.shoppingList).toEqual([
			{ key: 'onion', value: 5 },
			{ key: 'salt', value: 1 },
		])
		await client.close()
	})

	it('max-es an inlined computed expression into a weekly series (gymlog 1RM)', async () => {
		const client = await bootPglite()
		await client.exec(`
			CREATE TABLE "workout" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid());
			CREATE TABLE "logentry" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
				"reps" real, "weight" real, "loggedAt" timestamp, "workoutId" uuid);
			INSERT INTO "workout" ("id") VALUES ('cccccccc-0000-0000-0000-000000000001');
			INSERT INTO "logentry" ("reps","weight","loggedAt","workoutId") VALUES
				(10,100,'2026-07-06','cccccccc-0000-0000-0000-000000000001'),
				(5,110,'2026-07-07','cccccccc-0000-0000-0000-000000000001'),
				(8,105,'2026-07-13','cccccccc-0000-0000-0000-000000000001');
		`)
		const out = await resolveRollups(
			[{ id: 'cccccccc-0000-0000-0000-000000000001' }],
			[
				{
					name: 'peak1rm',
					over: 'logentry',
					via: [{ column: 'workoutId', table: 'workout' }],
					fn: 'max',
					computed: epley,
					groupBy: { column: 'loggedAt', bucket: 'week' },
					limit: 52,
				},
			],
			{ run: await runner(client) },
		)
		const series = out[0]?.peak1rm as { key: string; value: number }[]
		expect(series).toHaveLength(2)
		// Week of Jul 6: max(100*(1+10/30)=133.3, 110*(1+5/30)=128.3) = 133.3
		expect(series[0]?.value).toBeCloseTo(133.333, 2)
		// Week of Jul 13: 105*(1+8/30) = 133.0
		expect(series[1]?.value).toBeCloseTo(133, 1)
		// Chronological, because a series is ordered by key.
		expect(new Date(series[0]?.key ?? 0) < new Date(series[1]?.key ?? 0)).toBe(
			true,
		)
		await client.close()
	})

	it('groups a table-wide rollup by a column (saas-starter metering)', async () => {
		// The saas-starter shape: usage events grouped by subject and month, with no
		// declared relation to traverse (see #208 — bundle FKs are untyped strings).
		const client = await bootPglite()
		await client.exec(`
			CREATE TABLE "usage_event" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
				"subject" text, "meter" text, "quantity" real, "at" timestamp);
			INSERT INTO "usage_event" ("subject","meter","quantity","at") VALUES
				('org_a','api_calls',100,'2026-06-15'),
				('org_a','api_calls',50,'2026-06-20'),
				('org_a','api_calls',10,'2026-07-02'),
				('org_b','api_calls',5,'2026-07-02');
		`)
		const out = await resolveRollups(
			[{ id: 'ignored' }],
			[
				{
					name: 'meteredByMonth',
					over: 'usage_event',
					fn: 'sum',
					column: 'quantity',
					where: [{ column: 'meter', equals: 'api_calls' }],
					groupBy: { column: 'at', bucket: 'month' },
					limit: 12,
				},
			],
			{ run: await runner(client) },
		)
		const series = out[0]?.meteredByMonth as { value: number }[]
		expect(series.map((b) => b.value)).toEqual([150, 15])
		await client.close()
	})

	it('escaped identifiers survive a round-trip', async () => {
		// quoteIdent is the boundary where a spec name becomes executable SQL.
		const client = await bootPglite()
		await client.exec(`
			CREATE TABLE "we""ird" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "n" real, "ownerId" uuid);
			INSERT INTO "we""ird" ("n","ownerId") VALUES (4,'dddddddd-0000-0000-0000-000000000001');
		`)
		const out = await resolveRollups(
			[{ id: 'dddddddd-0000-0000-0000-000000000001' }],
			[
				{
					name: 'total',
					over: 'we"ird',
					via: [{ column: 'ownerId', table: 'owner' }],
					fn: 'sum',
					column: 'n',
				},
			],
			{ run: await runner(client) },
		)
		expect(out[0]?.total).toBe(4)
		await client.close()
	})
})
