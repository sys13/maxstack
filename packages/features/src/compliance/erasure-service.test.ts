import type { PGlite } from '@electric-sql/pglite'
import { ResourceRegistry } from '@maxstack/core'
import { createDrizzleStore } from '@maxstack/core/demo'
import { bootPglite } from '@maxstack/core/testing'
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eraseUserData, ScopeMismatchError } from './erasure-service.ts'
import type { RetentionPolicy } from './retention.ts'

const note = pgTable('note', {
	id: uuid('id').primaryKey().defaultRandom(),
	authorId: text('authorId').notNull(),
	body: text('body').notNull(),
	deletedAt: timestamp('deletedAt'),
})

const DDL = `
CREATE TABLE note (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "authorId" text NOT NULL,
  body text NOT NULL,
  "deletedAt" timestamp
);
`

let client: PGlite
let registry: ResourceRegistry
let store: ReturnType<typeof createDrizzleStore>

beforeAll(async () => {
	client = await bootPglite()
	await client.exec(DDL)
	registry = new ResourceRegistry()
	// softDelete: true too — erasure must still hard-delete (see the policy
	// note in erasure-service.ts), not merely stamp `deletedAt`.
	registry.register(note, { softDelete: true })
	store = createDrizzleStore(drizzle({ client }), registry)
})

/**
 * Issue #188 requires every registered table to be classified before a
 * compliance flow will run. `tag` is the operational one — a global lookup with
 * no personal data — and saying so is now a written claim rather than a silent
 * skip.
 */
const POLICIES: RetentionPolicy[] = [
	{ resource: 'note', class: 'personal' },
	{
		resource: 'tag',
		class: 'operational',
		reason: 'A global vocabulary list; rows are not about any person.',
	},
]

afterAll(async () => {
	await client.close()
})

describe('eraseUserData', () => {
	it('refuses to run unless requestedBy matches the target user', async () => {
		await expect(
			eraseUserData(
				{ registry, store, policies: POLICIES },
				'u1',
				'someone-else',
			),
		).rejects.toThrow(ScopeMismatchError)
	})

	it('hard-deletes only the requesting user’s own rows, never another user’s', async () => {
		await store.create('note', { authorId: 'u1', body: 'mine 1' })
		await store.create('note', { authorId: 'u1', body: 'mine 2' })
		const other = await store.create('note', {
			authorId: 'u2',
			body: 'not mine',
		})

		const report = await eraseUserData(
			{ registry, store, policies: POLICIES },
			'u1',
			'u1',
		)
		expect(report.entries).toEqual([
			{ resource: 'note', erased: 2, via: 'owner' },
		])

		const remaining = await store.list('note', {})
		expect(remaining).toHaveLength(1)
		expect(remaining[0]?.id).toBe(other.id)
	})

	it('is a true hard delete even on a softDelete: true resource', async () => {
		await store.create('note', { authorId: 'u3', body: 'erase me for real' })
		await eraseUserData({ registry, store, policies: POLICIES }, 'u3', 'u3')
		// Gone from the raw store, not just `deletedAt`-stamped.
		const rows = await store.list('note', { filter: { authorId: 'u3' } })
		expect(rows).toHaveLength(0)
	})

	it('is a no-op (empty report) for a user who owns nothing', async () => {
		const report = await eraseUserData(
			{ registry, store, policies: POLICIES },
			'ghost',
			'ghost',
		)
		expect(report.entries).toEqual([])
	})
})
