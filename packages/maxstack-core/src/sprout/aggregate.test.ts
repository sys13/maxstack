/**
 * `opAggregate` over pglite (#299) — the read behind an `aggregate` block.
 *
 * Four things are asserted here, and only the first is about arithmetic:
 *
 *   1. The grouped numbers are right, for the three shapes a dashboard is
 *      actually made of: count by enum, sum/avg of a number by a dimension,
 *      count over a date bucket.
 *   2. **The gate runs on the aggregate query, not on rows fetched and summed.**
 *      A tenant-scoped resource must count only the active org's rows — a count
 *      that crosses the boundary is a leak whether or not the rows come back
 *      with it — and a hostile caller filter must not be able to widen it.
 *   3. Soft-deleted rows are out of the count by default, in by request, the
 *      same as a list.
 *   4. An undeclared group or measure column **throws**. That is the one place
 *      this path deliberately differs from `opList`, whose unknown-filter rule
 *      is to ignore: ignoring a filter widens toward a cap that already
 *      applied; ignoring a `GROUP BY` returns a wrong number that looks right.
 */

import type { PGlite } from '@electric-sql/pglite'
import {
	boolean,
	integer,
	pgTable,
	text,
	timestamp,
	uuid,
} from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDrizzleStore } from '../demo/store.ts'
import { bootPglite } from '../testing/pglite-snapshot.ts'
import {
	type OpContext,
	opAggregate,
	UnsupportedOperationError,
	ValidationError,
} from './operations.ts'
import { ResourceRegistry } from './registry.ts'
import { withMeta } from './schema-builder.ts'
import type { AggregateQuery } from './store.ts'

const ticket = pgTable('ticket', {
	id: uuid('id').primaryKey().defaultRandom(),
	title: withMeta(text('title'), { label: 'Title', required: true }).notNull(),
	status: withMeta(text('status'), {
		label: 'Status',
		enumValues: ['open', 'closed'],
	}),
	urgent: boolean('urgent'),
	points: integer('points'),
	openedAt: timestamp('openedAt', { withTimezone: true }),
	deletedAt: timestamp('deletedAt', { withTimezone: true }),
	organizationId: text('organizationId'),
})

const DDL = `
CREATE TABLE "ticket" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "title" text NOT NULL,
  "status" text,
  "urgent" boolean,
  "points" integer,
  "openedAt" timestamptz,
  "deletedAt" timestamptz,
  "organizationId" text
);
`

const acme = { id: 'u-acme', role: 'admin', orgId: 'org-acme' }
const globex = { id: 'u-globex', role: 'admin', orgId: 'org-globex' }

let client: PGlite
let ctxFor: (user: OpContext['user']) => OpContext
/** A context whose store cannot group — the refusal case. */
let ungroupable: OpContext

/** Sorted by key so an assertion never depends on the measure ordering. */
const byKey = (rows: { key: string | null; value: number | null }[]) =>
	[...rows]
		.sort((a, b) => String(a.key).localeCompare(String(b.key)))
		.map((r) => [r.key, r.value])

beforeAll(async () => {
	client = await bootPglite()
	await client.exec(DDL)
	const registry = new ResourceRegistry()
	registry.register(ticket, {
		tenantField: 'organizationId',
		softDelete: true,
	})
	const db = drizzle({ client })
	const store = createDrizzleStore(db, registry)
	ctxFor = (user) => ({ registry, store, user })
	const { aggregate: _dropped, ...withoutAggregate } = store
	ungroupable = { registry, store: withoutAggregate, user: acme }

	await client.exec(`
		INSERT INTO "ticket" ("title","status","urgent","points","openedAt","organizationId") VALUES
			('a','open',   true,  3, '2026-01-10T00:00:00Z','org-acme'),
			('b','open',   false, 5, '2026-01-20T00:00:00Z','org-acme'),
			('c','closed', true,  10,'2026-02-02T00:00:00Z','org-acme'),
			('d',NULL,     NULL,  NULL,'2026-02-05T00:00:00Z','org-acme'),
			('e','open',   true,  99,'2026-03-01T00:00:00Z','org-globex'),
			('f','closed', false, 99,'2026-03-02T00:00:00Z','org-globex');
	`)
	// One soft-deleted acme row, so the default scope has something to exclude.
	await client.exec(`
		INSERT INTO "ticket" ("title","status","points","openedAt","deletedAt","organizationId")
		VALUES ('gone','open',1000,'2026-01-11T00:00:00Z','2026-04-01T00:00:00Z','org-acme');
	`)
})

afterAll(async () => {
	await client.close()
})

const countByStatus: AggregateQuery = {
	groupColumn: 'status',
	fn: 'count',
	limit: 12,
}

describe('opAggregate — the shapes a dashboard is made of', () => {
	it('counts rows by an enum dimension, keeping the null bucket', async () => {
		const rows = await opAggregate(ctxFor(acme), 'ticket', countByStatus)
		// `null` is a real bucket — the tickets with no status — not an error and
		// not the empty string.
		expect(byKey(rows)).toEqual([
			['closed', 1],
			[null, 1],
			['open', 2],
		])
	})

	it('sums and averages a number by a dimension', async () => {
		const summed = await opAggregate(ctxFor(acme), 'ticket', {
			groupColumn: 'status',
			fn: 'sum',
			measureColumn: 'points',
			limit: 12,
		})
		expect(byKey(summed)).toEqual([
			['closed', 10],
			[null, null],
			['open', 8],
		])
		const averaged = await opAggregate(ctxFor(acme), 'ticket', {
			groupColumn: 'status',
			fn: 'avg',
			measureColumn: 'points',
			limit: 12,
		})
		// A plain number, not the arbitrary-precision `numeric` string Postgres
		// returns for an average — a bar cannot be drawn from "4.0000000000000000".
		expect(byKey(averaged)).toEqual([
			['closed', 10],
			[null, null],
			['open', 4],
		])
	})

	it('counts over a date bucket, one bucket per month', async () => {
		const rows = await opAggregate(ctxFor(acme), 'ticket', {
			groupColumn: 'openedAt',
			bucket: 'month',
			fn: 'count',
			limit: 12,
		})
		expect(
			byKey(rows).map(([key, value]) => [String(key).slice(0, 7), value]),
		).toEqual([
			['2026-01', 2],
			['2026-02', 2],
		])
	})

	it('groups by a boolean, keeping false distinct from null', async () => {
		const rows = await opAggregate(ctxFor(acme), 'ticket', {
			groupColumn: 'urgent',
			fn: 'count',
			limit: 12,
		})
		expect(byKey(rows)).toEqual([
			['false', 1],
			[null, 1],
			['true', 2],
		])
	})

	it('returns the largest buckets first and honors the limit', async () => {
		const rows = await opAggregate(ctxFor(acme), 'ticket', {
			...countByStatus,
			limit: 1,
		})
		expect(rows).toEqual([{ key: 'open', value: 2, count: 2 }])
	})

	it('narrows to a declared filter without leaving the gate', async () => {
		const rows = await opAggregate(ctxFor(acme), 'ticket', countByStatus, {
			filter: { urgent: true },
		})
		expect(byKey(rows)).toEqual([
			['closed', 1],
			['open', 1],
		])
	})
})

describe('opAggregate — the aggregate itself is what the gate covers', () => {
	it('counts only the active org, and a hostile filter cannot widen it', async () => {
		const acmeRows = await opAggregate(ctxFor(acme), 'ticket', countByStatus)
		expect(acmeRows.reduce((n, r) => n + r.count, 0)).toBe(4)
		const globexRows = await opAggregate(
			ctxFor(globex),
			'ticket',
			countByStatus,
		)
		expect(byKey(globexRows)).toEqual([
			['closed', 1],
			['open', 1],
		])
		// The forced tenant scope is spread last, so naming the column does not
		// let the caller choose its value — the count stays acme's, exactly as
		// `opList` refuses the same widening.
		const widened = await opAggregate(ctxFor(acme), 'ticket', countByStatus, {
			filter: { organizationId: 'org-globex' },
		})
		expect(byKey(widened)).toEqual(byKey(acmeRows))
	})

	it('excludes soft-deleted rows by default and includes them on request', async () => {
		const live = await opAggregate(ctxFor(acme), 'ticket', {
			groupColumn: 'status',
			fn: 'sum',
			measureColumn: 'points',
			limit: 12,
		})
		expect(byKey(live)).toContainEqual(['open', 8])
		const all = await opAggregate(
			ctxFor(acme),
			'ticket',
			{
				groupColumn: 'status',
				fn: 'sum',
				measureColumn: 'points',
				limit: 12,
			},
			{ includeDeleted: true },
		)
		expect(byKey(all)).toContainEqual(['open', 1008])
	})
})

describe('opAggregate — an aggregate has no safe degradation', () => {
	it('refuses an undeclared group column instead of collapsing the groups', async () => {
		await expect(
			opAggregate(ctxFor(acme), 'ticket', {
				groupColumn: 'nosuchcolumn',
				fn: 'count',
				limit: 12,
			}),
		).rejects.toBeInstanceOf(ValidationError)
	})

	it('refuses an undeclared measure column', async () => {
		await expect(
			opAggregate(ctxFor(acme), 'ticket', {
				groupColumn: 'status',
				fn: 'sum',
				measureColumn: 'nosuchcolumn',
				limit: 12,
			}),
		).rejects.toBeInstanceOf(ValidationError)
	})

	it('refuses outright when the store cannot group, rather than summing a page', async () => {
		await expect(
			opAggregate(ungroupable, 'ticket', countByStatus),
		).rejects.toBeInstanceOf(UnsupportedOperationError)
	})
})
