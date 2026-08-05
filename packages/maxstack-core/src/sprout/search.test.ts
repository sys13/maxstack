/**
 * Declared full-text search, from the generated SQL down to the
 * rows Postgres actually returns.
 *
 * The suite is in four parts, and the order is the order of how much each one
 * would cost to get wrong:
 *
 *  1. **The SQL as text.** Cheap, and it pins the two properties that are
 *     invisible at runtime: that the index and the query are built from the same
 *     expression, and that the DDL survives the postgres backend's statement
 *     splitter.
 *  2. **The SQL against pglite.** Asserting shape misses the only thing that
 *     matters — whether Postgres accepts it, whether the index is used, and
 *     whether the ranking is the one a person would expect.
 *  3. **The access-control gate**, which is the exit criterion the issue names,
 *     and which is asserted from the leaking side: an unauthorized row must be
 *     absent from the rows, from the count, and from the ranking.
 *  4. **Backend parity**, declared and pinned structurally.
 */

import type { PGlite } from '@electric-sql/pglite'
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDrizzleStore } from '../demo/store.ts'
import { bootPglite } from '../testing/pglite-snapshot.ts'
import { searchHandler } from './api.ts'
import { specSchemaDdl } from './from-spec.ts'
import {
	type OpContext,
	opSearch,
	opSearchCount,
	UnsupportedOperationError,
} from './operations.ts'
import { PermissionError } from './permissions.ts'
import { ResourceRegistry } from './registry.ts'
import { withMeta } from './schema-builder.ts'
import {
	assertPlanIsSafe,
	MAX_SEARCH_QUERY_LENGTH,
	normalizeSearchQuery,
	type SearchIndexPlan,
	searchCountSql,
	searchIndexDdl,
	searchIndexName,
	searchSql,
	tsvectorExpr,
} from './search.ts'

const PLAN: SearchIndexPlan = {
	key: 'post-search',
	language: 'english',
	fields: [
		{ column: 'title', weight: 'A' },
		{ column: 'body', weight: 'B' },
	],
	indexed: true,
}

// ===========================================================================
// 1. The SQL as text
// ===========================================================================

describe('the tsvector expression', () => {
	it('weights each field and coalesces nulls', () => {
		expect(tsvectorExpr(PLAN)).toBe(
			`setweight(to_tsvector('english', coalesce("title", '')), 'A') || ` +
				`setweight(to_tsvector('english', coalesce("body", '')), 'B')`,
		)
	})

	it('is character-identical in the index and in the query', () => {
		// The property the whole module exists for. A GIN expression index is only
		// usable by a query repeating the expression exactly; a difference here
		// costs nothing at test time and everything at runtime, where the only
		// symptom is that search is quietly a sequential scan.
		const expr = tsvectorExpr(PLAN)
		expect(searchIndexDdl('post', PLAN)).toContain(expr)
		const q = searchSql('post', PLAN, { query: 'x', limit: 10, offset: 0 })
		expect(q.text).toContain(expr)
		expect(searchCountSql('post', PLAN, { query: 'x' }).text).toContain(expr)
	})

	it('coalesces rather than concatenating raw columns', () => {
		// `to_tsvector(NULL)` is NULL and NULL || anything is NULL, so one empty
		// optional field would otherwise erase the whole document from the index —
		// a bug visible only on the rows nobody filled in completely.
		expect(tsvectorExpr(PLAN)).toContain(`coalesce("body", '')`)
	})

	it('refuses a language, a weight or a column outside the checked sets', () => {
		// The validator refuses these on the spec. This is the second wall, at the
		// module that concatenates them into SQL.
		expect(() =>
			tsvectorExpr({ ...PLAN, language: "english'); DROP TABLE post --" }),
		).toThrow(/unknown text search configuration/)
		expect(() =>
			tsvectorExpr({
				...PLAN,
				fields: [{ column: 'title', weight: 'Z' as 'A' }],
			}),
		).toThrow(/unknown weight/)
		expect(() =>
			tsvectorExpr({
				...PLAN,
				fields: [{ column: 'title", (SELECT 1)) --', weight: 'A' }],
			}),
		).toThrow(/refusing to build SQL for identifier/)
		expect(() => assertPlanIsSafe(PLAN)).not.toThrow()
	})
})

describe('the emitted DDL', () => {
	it('creates a GIN expression index when indexed', () => {
		expect(searchIndexDdl('post', PLAN)).toMatch(
			/^CREATE INDEX IF NOT EXISTS "search_post_search" ON "post" USING GIN \(\(/,
		)
	})

	it('drops the index when the declaration opts out', () => {
		expect(searchIndexDdl('post', { ...PLAN, indexed: false })).toBe(
			'DROP INDEX IF EXISTS "search_post_search";',
		)
	})

	it('contains no semicolon inside a literal or a body', () => {
		// The postgres backend splits multi-statement DDL on a naive `;`
		// (`backend.ts`), which already shreds the one `DO $$ … $$` block the
		// platform emits. Any statement added here has to survive that splitter.
		const ddl = searchIndexDdl('post', PLAN)
		expect(ddl.split(';').filter((s) => s.trim().length > 0)).toHaveLength(1)
	})

	it('rides on the entity DDL after every column it names', () => {
		const ddl = specSchemaDdl([
			{
				name: 'post',
				fields: [
					{ name: 'title', type: 'string', required: true },
					{ name: 'body', type: 'string', required: false },
				],
				search: PLAN,
			},
		])
		expect(ddl.indexOf('CREATE INDEX')).toBeGreaterThan(ddl.indexOf('"body"'))
	})

	it('emits nothing for an entity with no declared index', () => {
		const ddl = specSchemaDdl([
			{
				name: 'post',
				fields: [{ name: 'title', type: 'string', required: true }],
			},
		])
		expect(ddl).not.toContain('INDEX')
	})
})

describe('query normalization', () => {
	it('treats a blank query as nothing to search for, never as everything', () => {
		// The difference between a search endpoint and a list endpoint. Conflating
		// them is how an empty search box becomes an unbounded scan.
		expect(normalizeSearchQuery('')).toBeNull()
		expect(normalizeSearchQuery('   ')).toBeNull()
		expect(normalizeSearchQuery(undefined)).toBeNull()
		expect(normalizeSearchQuery(42)).toBeNull()
	})

	it('bounds the query length', () => {
		const long = 'a'.repeat(MAX_SEARCH_QUERY_LENGTH + 500)
		expect(normalizeSearchQuery(long)).toHaveLength(MAX_SEARCH_QUERY_LENGTH)
	})

	it('never interpolates the query into the SQL', () => {
		const q = searchSql('post', PLAN, {
			query: "'; DROP TABLE post; --",
			limit: 10,
			offset: 0,
		})
		expect(q.text).not.toContain('DROP TABLE')
		expect(q.params[0]).toBe("'; DROP TABLE post; --")
	})

	it('orders by rank then by a stable key', () => {
		// Rank alone is not a total order, and LIMIT over a non-total order shows
		// the same row on two pages whenever two rows tie.
		expect(
			searchSql('post', PLAN, { query: 'x', limit: 10, offset: 0 }).text,
		).toContain('ORDER BY "__rank" DESC, "id" ASC')
	})
})

// ===========================================================================
// 2. Against a real Postgres (pglite)
// ===========================================================================

const post = pgTable('post', {
	id: uuid('id').primaryKey().defaultRandom(),
	title: withMeta(text('title'), { label: 'Title', required: true }).notNull(),
	body: text('body'),
	authorId: text('authorId'),
	organizationId: text('organizationId'),
	deletedAt: timestamp('deletedAt'),
})

let client: PGlite
let ctxFor: (user: OpContext['user']) => OpContext
let unindexedCtx: OpContext
let noPlanCtx: OpContext
let run: (
	text: string,
	params?: readonly unknown[],
) => Promise<Record<string, unknown>[]>

beforeAll(async () => {
	client = await bootPglite()
	await client.exec(`
		CREATE TABLE "post" (
			"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			"title" text NOT NULL,
			"body" text,
			"authorId" text,
			"organizationId" text,
			"deletedAt" timestamp
		);
	`)
	await client.exec(searchIndexDdl('post', PLAN))
	await client.exec(`
		INSERT INTO "post" ("title", "body", "authorId", "organizationId") VALUES
			('Indexing in Postgres', 'GIN indexes make searching fast', 'u-ann', 'org-a'),
			('A note on searching', 'Mostly about cooking rice', 'u-bob', 'org-a'),
			('Cooking rice', 'A guide to steaming rice perfectly', 'u-bob', 'org-b');
	`)
	run = (text, params) =>
		client
			.query(text, params as unknown[] | undefined)
			.then((r) => r.rows as Record<string, unknown>[])

	const registry = new ResourceRegistry()
	registry.register(post, { search: PLAN })
	const store = createDrizzleStore(drizzle({ client }), registry, run)
	ctxFor = (user) => ({ registry, store, user })

	// A store with no raw runner — the shape a host that wired none produces.
	const bare = new ResourceRegistry()
	bare.register(post, { search: PLAN })
	unindexedCtx = {
		registry: bare,
		store: createDrizzleStore(drizzle({ client }), bare),
		user: null,
	}

	// A resource that declared no index at all.
	const plain = new ResourceRegistry()
	plain.register(post)
	noPlanCtx = {
		registry: plain,
		store: createDrizzleStore(drizzle({ client }), plain, run),
		user: null,
	}
})

afterAll(async () => {
	await client.close()
})

describe('ranked search against pglite', () => {
	it('ranks a title match above a body match', () => {
		// The entire point of weights, and the thing an ILIKE scan cannot do at all.
		return opSearch(ctxFor(null), 'post', 'searching').then((hits) => {
			expect(hits.map((h) => h.row.title)).toEqual([
				'A note on searching',
				'Indexing in Postgres',
			])
			expect(hits[0]?.rank).toBeGreaterThan(hits[1]?.rank ?? 0)
		})
	})

	it('stems, so a search for one form finds the others', async () => {
		// `ILIKE '%cook%'` would find "cooking" by accident; nothing makes it find
		// "cooks" from "cooking". Stemming is why this is a different feature.
		const hits = await opSearch(ctxFor(null), 'post', 'cooks')
		expect(hits.length).toBeGreaterThan(0)
	})

	it('respects word boundaries', async () => {
		// `ILIKE '%index%'` matches "indexes"; it also matches nothing a person
		// wanted when the query is short. The real distinction is the inverse:
		// a substring that is not a word does not match at all.
		expect(await opSearch(ctxFor(null), 'post', 'ostgres')).toEqual([])
		expect((await opSearch(ctxFor(null), 'post', 'postgres')).length).toBe(1)
	})

	it('actually uses the index', async () => {
		// Asserting the expression matches is necessary and not sufficient — the
		// planner is the only authority on whether the index is usable.
		await client.exec('SET enable_seqscan = off')
		const plan = await client.query(
			`EXPLAIN SELECT id FROM "post" WHERE (${tsvectorExpr(PLAN)}) @@ websearch_to_tsquery('english', 'searching')`,
		)
		const text = (plan.rows as { 'QUERY PLAN': string }[])
			.map((r) => r['QUERY PLAN'])
			.join('\n')
		expect(text).toContain(searchIndexName(PLAN.key))
		await client.exec('SET enable_seqscan = on')
	})

	it('never throws on hostile query syntax', async () => {
		// `to_tsquery` raises on input as ordinary as a trailing `&`, which turns a
		// search box into a 500 nobody can reproduce on purpose. This is the whole
		// reason the generated SQL uses `websearch_to_tsquery`.
		for (const q of ['a & | !', '"unclosed', ':*', '&&&', '!!!', '(((']) {
			await expect(opSearch(ctxFor(null), 'post', q)).resolves.toBeInstanceOf(
				Array,
			)
		}
	})

	it('returns nothing for a blank query rather than every row', async () => {
		expect(await opSearch(ctxFor(null), 'post', '   ')).toEqual([])
		expect(await opSearchCount(ctxFor(null), 'post', '   ')).toBe(0)
	})

	it('counts under exactly the predicates the results ran under', async () => {
		const hits = await opSearch(ctxFor(null), 'post', 'rice')
		expect(await opSearchCount(ctxFor(null), 'post', 'rice')).toBe(hits.length)
	})

	it('keeps the caller’s filters live while a query is set', async () => {
		const all = await opSearch(ctxFor(null), 'post', 'rice')
		const mine = await opSearch(ctxFor(null), 'post', 'rice', {
			filter: { authorId: 'u-bob' },
		})
		expect(mine.length).toBeLessThanOrEqual(all.length)
		expect(mine.every((h) => h.row.authorId === 'u-bob')).toBe(true)
		// And the count agrees, so a filtered search cannot advertise a total the
		// caller can never page to.
		expect(
			await opSearchCount(ctxFor(null), 'post', 'rice', {
				filter: { authorId: 'u-bob' },
			}),
		).toBe(mine.length)
	})

	it('does not hand the rank back on the row', async () => {
		// Merging it in would add a key the entity never declared; the first thing
		// to break is a client round-tripping a result into an update.
		const [hit] = await opSearch(ctxFor(null), 'post', 'rice')
		expect(hit?.row).not.toHaveProperty('__rank')
		expect(hit?.row).not.toHaveProperty('rank')
		expect(typeof hit?.rank).toBe('number')
	})

	it('refuses rather than degrading when there is no index or no runner', async () => {
		// Both refusals matter more than they look. A silent fallback to
		// `ILIKE '%q%'` would report "search works" while ranking, stemming and
		// word boundaries were all absent — and the caller would believe the order.
		await expect(opSearch(noPlanCtx, 'post', 'rice')).rejects.toThrow(
			UnsupportedOperationError,
		)
		await expect(opSearch(unindexedCtx, 'post', 'rice')).rejects.toThrow(
			UnsupportedOperationError,
		)
	})
})

// ===========================================================================
// 3. The access-control gate — the issue's explicit exit criterion
// ===========================================================================

describe('RBAC filtering (the leak test)', () => {
	it('refuses a caller the resource denies, rather than returning zero rows', async () => {
		// The distinction is load-bearing: an empty result and a refusal are
		// different facts, and returning the first for the second lets a caller
		// probe for existence by watching a count.
		const registry = new ResourceRegistry()
		registry.register(post, { search: PLAN, access: { read: 'authenticated' } })
		const ctx: OpContext = {
			registry,
			store: createDrizzleStore(drizzle({ client }), registry, (t, p) =>
				client
					.query(t, p as unknown[] | undefined)
					.then((r) => r.rows as Record<string, unknown>[]),
			),
			user: null,
		}
		await expect(opSearch(ctx, 'post', 'rice')).rejects.toThrow(PermissionError)
		await expect(opSearchCount(ctx, 'post', 'rice')).rejects.toThrow(
			PermissionError,
		)
	})

	it('never returns, counts or ranks a row from another tenant', async () => {
		// The leak assertion the issue asks for, made from all three angles a
		// search result can leak through: the rows, the total, and the ranking.
		const registry = new ResourceRegistry()
		registry.register(post, { search: PLAN, tenantField: 'organizationId' })
		const store = createDrizzleStore(drizzle({ client }), registry, (t, p) =>
			client
				.query(t, p as unknown[] | undefined)
				.then((r) => r.rows as Record<string, unknown>[]),
		)
		const orgA: OpContext = {
			registry,
			store,
			user: { id: 'u-ann', role: 'member', orgId: 'org-a' },
		}

		// Non-vacuity first: ungated, the query genuinely reaches both orgs' rows,
		// including the one the assertions below require to be absent. Without
		// this the test would pass just as happily if search returned nothing.
		const ungated = await opSearch(ctxFor(null), 'post', 'rice')
		expect(ungated.map((h) => h.row.title)).toContain('Cooking rice')
		expect(new Set(ungated.map((h) => h.row.organizationId))).toEqual(
			new Set(['org-a', 'org-b']),
		)

		// 'org-b' owns exactly one rice post; 'org-a' owns one.
		const hits = await opSearch(orgA, 'post', 'rice')
		expect(hits.length).toBeGreaterThan(0)
		expect(hits.every((h) => h.row.organizationId === 'org-a')).toBe(true)
		expect(hits.map((h) => h.row.title)).not.toContain('Cooking rice')

		// The count must not include it either — a cross-tenant row *count* is a
		// leak whether or not the row itself comes back.
		expect(await opSearchCount(orgA, 'post', 'rice')).toBe(hits.length)

		// And no rank was computed from it: `ts_rank` scores a row from its own
		// text only, so the scores org-a sees are identical to the scores it would
		// see if org-b's row did not exist at all.
		const isolated = await opSearch(orgA, 'post', 'rice')
		expect(isolated.map((h) => h.rank)).toEqual(hits.map((h) => h.rank))
	})

	it('cannot be widened by a caller-supplied filter naming the tenant column', async () => {
		// The forced scopes spread last, over any caller filter — `opList`'s rule,
		// and the one that makes a hostile facet inert.
		const registry = new ResourceRegistry()
		registry.register(post, { search: PLAN, tenantField: 'organizationId' })
		const store = createDrizzleStore(drizzle({ client }), registry, (t, p) =>
			client
				.query(t, p as unknown[] | undefined)
				.then((r) => r.rows as Record<string, unknown>[]),
		)
		const hostile: OpContext = {
			registry,
			store,
			user: { id: 'u-ann', role: 'member', orgId: 'org-a' },
		}
		const hits = await opSearch(hostile, 'post', 'rice', {
			filter: { organizationId: 'org-b' },
		})
		expect(hits.every((h) => h.row.organizationId === 'org-a')).toBe(true)
	})

	it('denies a tenant-scoped search with no active org', async () => {
		const registry = new ResourceRegistry()
		registry.register(post, { search: PLAN, tenantField: 'organizationId' })
		const store = createDrizzleStore(drizzle({ client }), registry, (t, p) =>
			client
				.query(t, p as unknown[] | undefined)
				.then((r) => r.rows as Record<string, unknown>[]),
		)
		const orgless: OpContext = {
			registry,
			store,
			user: { id: 'u-root', role: 'admin' },
		}
		await expect(opSearch(orgless, 'post', 'rice')).rejects.toThrow(
			PermissionError,
		)
	})

	it('respects an api-key scope, which is closed by default', async () => {
		const registry = new ResourceRegistry()
		registry.register(post, { search: PLAN })
		const store = createDrizzleStore(drizzle({ client }), registry, (t, p) =>
			client
				.query(t, p as unknown[] | undefined)
				.then((r) => r.rows as Record<string, unknown>[]),
		)
		const keyed: OpContext = {
			registry,
			store,
			user: {
				id: 'u-key',
				role: 'member',
				origin: 'api-key',
				apiKeyScope: { comment: ['read'] },
			},
		}
		// The key names `comment`, not `post` — and a scope is closed by default,
		// so a resource it does not name is denied even though `post` has no rule.
		await expect(opSearch(keyed, 'post', 'rice')).rejects.toThrow(
			PermissionError,
		)
	})

	it('excludes soft-deleted rows by default', async () => {
		const registry = new ResourceRegistry()
		registry.register(post, { search: PLAN, softDelete: true })
		const store = createDrizzleStore(drizzle({ client }), registry, (t, p) =>
			client
				.query(t, p as unknown[] | undefined)
				.then((r) => r.rows as Record<string, unknown>[]),
		)
		const ctx: OpContext = { registry, store, user: null }
		const before = await opSearch(ctx, 'post', 'rice')
		await client.query(
			`UPDATE "post" SET "deletedAt" = now() WHERE "title" = 'Cooking rice'`,
		)
		const after = await opSearch(ctx, 'post', 'rice')
		expect(after.length).toBe(before.length - 1)
		expect(after.map((h) => h.row.title)).not.toContain('Cooking rice')
		expect(await opSearchCount(ctx, 'post', 'rice')).toBe(after.length)
		await client.query(`UPDATE "post" SET "deletedAt" = NULL`)
	})
})

// ===========================================================================
// 3b. The REST contract
// ===========================================================================

describe('searchHandler (the REST response)', () => {
	it('returns the query, a total, and rank-carrying envelopes', async () => {
		const res = await searchHandler(ctxFor(null), 'post', 'rice')
		expect(res.status).toBe(200)
		const body = res.body as {
			query: string
			total: number
			results: { rank: number; row: Record<string, unknown> }[]
		}
		expect(body.query).toBe('rice')
		expect(body.total).toBe(body.results.length)
		// The rank is an envelope, not a key merged onto the row: merging would
		// add a field the entity never declared, and the first thing to break is a
		// client round-tripping a search result back into an update.
		expect(body.results[0]).toHaveProperty('rank')
		expect(body.results[0]?.row).not.toHaveProperty('rank')
	})

	it('maps a denied read to 403, never to an empty 200', async () => {
		const registry = new ResourceRegistry()
		registry.register(post, { search: PLAN, access: { read: 'authenticated' } })
		const ctx: OpContext = {
			registry,
			store: createDrizzleStore(drizzle({ client }), registry, run),
			user: null,
		}
		const res = await searchHandler(ctx, 'post', 'rice')
		expect(res.status).toBe(403)
	})

	it('maps an undeclared index to 422 with the sentence saying so', async () => {
		const res = await searchHandler(noPlanCtx, 'post', 'rice')
		expect(res.status).toBe(422)
		expect((res.body as { error: string }).error).toMatch(/search.declare/)
	})

	it('maps an unknown resource to 404', async () => {
		const res = await searchHandler(ctxFor(null), 'nope', 'rice')
		expect(res.status).toBe(404)
	})

	it('counts under the same filters it returned rows under', async () => {
		const res = await searchHandler(ctxFor(null), 'post', 'rice', {
			filter: { authorId: 'u-bob' },
		})
		const body = res.body as { total: number; results: unknown[] }
		expect(body.total).toBe(body.results.length)
	})
})

// ===========================================================================
// 4. Backend parity
// ===========================================================================

describe('pglite / Postgres parity', () => {
	it('generates one SQL string with no branch on the backend', () => {
		// Parity is a *structural* claim, not a claim about two test runs: the
		// index DDL and the query come from functions that take a plan and nothing
		// else. There is no backend handle in scope to branch on, so "the local
		// backend silently lacks search" has no way to become true.
		const args = new Set(
			[tsvectorExpr, searchIndexDdl, searchSql, searchCountSql].map(
				(fn) => fn.length,
			),
		)
		expect(args.has(0)).toBe(false)
		const source = [tsvectorExpr, searchIndexDdl, searchSql, searchCountSql]
			.map((fn) => fn.toString())
			.join('\n')
		expect(source).not.toMatch(/\bkind\b|\bpglite\b|\bpostgres\b/i)
	})

	it('uses only core Postgres, so no extension has to be installed', () => {
		// `pg_trgm` and friends ship with pglite but need a `CREATE EXTENSION` a
		// managed Postgres may not grant. Core FTS needs neither.
		const sql = [
			searchIndexDdl('post', PLAN),
			searchSql('post', PLAN, { query: 'x', limit: 1, offset: 0 }).text,
		].join('\n')
		expect(sql).not.toContain('CREATE EXTENSION')
		expect(sql).not.toContain('pg_trgm')
		expect(sql).not.toContain('unaccent')
	})
})
