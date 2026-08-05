import type { PGlite } from '@electric-sql/pglite'
import { ResourceRegistry } from '@maxstack/core'
import { createDrizzleStore } from '@maxstack/core/demo'
import { bootPglite } from '@maxstack/core/testing'
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { exportUserData } from './export-service.ts'
import type { RetentionPolicy } from './retention.ts'

// A minimal, self-contained schema — one owned resource (`note`, via
// `authorId`) and one unowned resource (`tag`, no conventional owner column)
// — enough to prove the export walks owner columns and skips resources
// without one, without depending on the demo app's schema.
const note = pgTable('note', {
	id: uuid('id').primaryKey().defaultRandom(),
	authorId: text('authorId').notNull(),
	body: text('body').notNull(),
	deletedAt: timestamp('deletedAt'),
})

const tag = pgTable('tag', {
	id: uuid('id').primaryKey().defaultRandom(),
	name: text('name').notNull(),
})

const DDL = `
CREATE TABLE note (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "authorId" text NOT NULL,
  body text NOT NULL,
  "deletedAt" timestamp
);
CREATE TABLE tag (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);
`

let client: PGlite
let registry: ResourceRegistry
let store: ReturnType<typeof createDrizzleStore>

beforeAll(async () => {
	client = await bootPglite()
	await client.exec(DDL)
	registry = new ResourceRegistry()
	registry.register(note, { softDelete: true })
	registry.register(tag, {})
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

describe('exportUserData', () => {
	it('collects only the requested user’s rows, keyed by resource', async () => {
		await store.create('note', { authorId: 'u1', body: 'mine' })
		await store.create('note', { authorId: 'u1', body: 'also mine' })
		await store.create('note', { authorId: 'u2', body: 'not mine' })
		await store.create('tag', { name: 'unowned, no owner column' })

		const dump = await exportUserData(
			{ registry, store, policies: POLICIES },
			'u1',
		)
		expect(dump.userId).toBe('u1')
		expect(dump.resources.note).toHaveLength(2)
		expect(dump.resources.note?.every((r) => r.authorId === 'u1')).toBe(true)
		// `tag` has no conventional owner column — never appears in the dump.
		expect(dump.resources.tag).toBeUndefined()
	})

	it('includes soft-deleted rows (still the user’s data until purged)', async () => {
		const created = await store.create('note', {
			authorId: 'u3',
			body: 'will be soft-deleted',
		})
		await store.update('note', created.id as string, { deletedAt: new Date() })

		const dump = await exportUserData(
			{ registry, store, policies: POLICIES },
			'u3',
		)
		expect(dump.resources.note).toHaveLength(1)
	})

	it('folds in caller-supplied extra data (account/session/audit/consent)', async () => {
		const dump = await exportUserData(
			{ registry, store, policies: POLICIES },
			'u1',
			{
				account: { email: 'u1@example.com' },
			},
		)
		expect(dump.extra).toEqual({ account: { email: 'u1@example.com' } })
	})

	it('produces an empty resources map for a user who owns nothing', async () => {
		const dump = await exportUserData(
			{ registry, store, policies: POLICIES },
			'ghost',
		)
		expect(dump.resources).toEqual({})
	})
})
