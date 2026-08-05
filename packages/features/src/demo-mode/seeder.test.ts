import { ResourceRegistry } from '@maxstack/core'
import { createDrizzleStore } from '@maxstack/core/demo'
import {
	boolean,
	integer,
	pgTable,
	text,
	timestamp,
	uuid,
} from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { usePglite } from '../testing/pglite-fixture.ts'
import { hasAnyData } from './fresh-install.ts'
import { clearDemoData, seedDemoData } from './seeder.ts'

// A minimal, self-contained schema — an `author` resource and a `post`
// resource with a belongs-to FK to it — enough to prove dependency-ordered
// seeding and reference resolution without depending on the demo app's
// schema.
const author = pgTable('author', {
	id: uuid('id').primaryKey().defaultRandom(),
	name: text('name').notNull(),
	createdAt: timestamp('createdAt').notNull().defaultNow(),
})

const post = pgTable('post', {
	id: uuid('id').primaryKey().defaultRandom(),
	title: text('title').notNull(),
	authorId: uuid('authorId')
		.notNull()
		.references(() => author.id),
	published: boolean('published').notNull().default(false),
	views: integer('views').notNull().default(0),
})

const DDL = `
CREATE TABLE author (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE post (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  "authorId" uuid NOT NULL REFERENCES author(id),
  published boolean NOT NULL DEFAULT false,
  views integer NOT NULL DEFAULT 0
);
`

// This file was two chained narratives over two long-lived databases, and four
// of its tests failed under `--sequence.shuffle --sequence.seed=42`. The
// order-dependence was not only a flake risk here: "leaves rows it did not
// create alone" asserted `clearDemoData` deleted nothing, which is trivially
// true against a table whose contents nobody had claimed — the test agreed
// with the code partly for the wrong reason. Likewise "reports a fresh install
// with no data" is an assertion about an *empty* database, and it was the
// file's position, not the fixture, keeping it empty.
//
// One truncated-between-tests database now, and every test seeds the state its
// own assertion is about. As a bonus the file boots pglite once rather than
// twice.
const pg = usePglite(DDL)

let registry: ResourceRegistry
let store: ReturnType<typeof createDrizzleStore>

beforeEach(() => {
	registry = new ResourceRegistry()
	registry.register(author, {})
	registry.register(post, {})
	store = createDrizzleStore(drizzle({ client: pg.client }), registry)
})

describe('seedDemoData', () => {
	it('reports a fresh install with no data', async () => {
		expect(await hasAnyData(registry, store)).toBe(false)
	})

	it('seeds every resource in FK-dependency order, resolving references', async () => {
		const result = await seedDemoData({ registry, store, rowsPerResource: 3 })
		expect(result.seeded.sort()).toEqual(['author', 'post'])
		expect(result.skipped).toEqual([])

		const authors = await store.list('author')
		const posts = await store.list('post')
		expect(authors).toHaveLength(3)
		expect(posts).toHaveLength(3)
		const authorIds = new Set(authors.map((a) => a.id))
		for (const p of posts) {
			expect(authorIds.has(p.authorId)).toBe(true)
		}
		expect(await hasAnyData(registry, store)).toBe(true)
	})

	it('is idempotent — a resource with existing rows is skipped, not duplicated', async () => {
		await seedDemoData({ registry, store, rowsPerResource: 3 })

		const before = await store.list('author')
		const result = await seedDemoData({ registry, store, rowsPerResource: 3 })
		expect(result.seeded).toEqual([])
		expect(result.skipped.sort()).toEqual(['author', 'post'])
		const after = await store.list('author')
		expect(after).toHaveLength(before.length)
	})
})

describe('created ids + clearDemoData (issue #191, closes #101)', () => {
	it('reports the primary keys it created, per resource', async () => {
		const result = await seedDemoData({ registry, store, rowsPerResource: 3 })
		expect(Object.keys(result.created).sort()).toEqual(['author', 'post'])
		expect(result.created.author).toHaveLength(3)
		const live = await store.list('author')
		expect(result.created.author?.sort()).toEqual(
			live.map((r) => String(r.id)).sort(),
		)
	})

	it('leaves rows it did not create alone', async () => {
		await seedDemoData({ registry, store, rowsPerResource: 3 })
		const mine = await store.create('author', { name: 'My own author' })
		// A second seed skips both resources (they have rows), so it claims nothing.
		const again = await seedDemoData({ registry, store, rowsPerResource: 3 })
		expect(again.created).toEqual({})

		const manifest = { author: [], post: [] } as Record<string, string[]>
		const cleared = await clearDemoData({ registry, store, rows: manifest })
		expect(cleared.deleted).toEqual({})
		expect(await store.get('author', String(mine.id))).not.toBeNull()
		// The rows the empty manifest declined to claim are all still there.
		expect(await store.list('author')).toHaveLength(4)
		expect(await store.list('post')).toHaveLength(3)
	})

	it('deletes exactly the tracked rows, children before parents', async () => {
		await seedDemoData({ registry, store, rowsPerResource: 3 })

		const authors = await store.list('author')
		const posts = await store.list('post')
		expect(authors.length).toBeGreaterThan(0)
		expect(posts.length).toBeGreaterThan(0)
		const rows = {
			author: authors.map((r) => String(r.id)),
			post: posts.map((r) => String(r.id)),
		}
		const result = await clearDemoData({ registry, store, rows })
		// FK-safe ordering is the whole point: had `author` gone first, the
		// referencing posts would have made these deletes fail.
		expect(result.deleted.author).toBe(authors.length)
		expect(result.deleted.post).toBe(posts.length)
		expect(result.missing).toBe(0)
		expect(await store.list('author')).toHaveLength(0)
		expect(await store.list('post')).toHaveLength(0)
	})

	it('counts ids that are already gone as missing rather than failing', async () => {
		const result = await clearDemoData({
			registry,
			store,
			rows: {
				author: ['00000000-0000-0000-0000-000000000000'],
				// A resource the registry no longer knows: unreachable, not fatal.
				ghost: ['whatever'],
			},
		})
		expect(result.deleted).toEqual({})
		expect(result.missing).toBe(2)
	})
})
