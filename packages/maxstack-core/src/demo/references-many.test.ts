import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { countHandler } from '../sprout/api.ts'
import { introspectTable } from '../sprout/introspection.ts'
import type { OpContext } from '../sprout/operations.ts'
import { resolveReferences } from '../sprout/references.ts'
import { ResourceRegistry } from '../sprout/registry.ts'
import { article, comment, tag } from './schema.ts'
import { createDemoDb, type DemoDb } from './store.ts'

/**
 * The "many" side of a reference, end-to-end over pglite (Plan v5 task 38):
 * `article.tags` (an array reference) resolves to tag names in one batched
 * `getMany`, and `comment`s are counted without loading them.
 */
let demo: DemoDb
let registry: ResourceRegistry
let ctx: OpContext

beforeAll(async () => {
	registry = new ResourceRegistry()
	registry.register(tag, { access: { read: 'public' }, titleField: 'name' })
	registry.register(article, {
		access: { read: 'public' },
		titleField: 'title',
	})
	registry.register(comment, { access: { read: 'public' } })
	demo = await createDemoDb(registry)
	ctx = { registry, store: demo.store, user: { id: 'admin', role: 'admin' } }
})

afterAll(async () => {
	await demo.client.close()
})

describe('array references + child count (task 38)', () => {
	it('resolves a tags[] array reference to tag names in one getMany', async () => {
		const a = await demo.store.create('tag', { name: 'Ecosystem' })
		const b = await demo.store.create('tag', { name: 'DX' })
		const post = await demo.store.create('article', {
			title: 'Hello',
			tags: [a.id, b.id],
		})

		const rows = await demo.store.list('article')
		const resource = introspectTable(article)
		let calls = 0
		const map = await resolveReferences(resource, rows, {
			getMany: async (table, ids) => {
				calls++
				return demo.store.getMany(table, ids)
			},
		})

		expect(calls).toBe(1) // batched — no N+1
		const created = rows.find((r) => r.id === post.id)
		expect(created?.tags).toEqual([a.id, b.id]) // stored as a real json array
		expect(map.tag?.[String(a.id)]).toBe('Ecosystem')
		expect(map.tag?.[String(b.id)]).toBe('DX')
	})

	it('counts an article’s comments without fetching them', async () => {
		const post = await demo.store.create('article', { title: 'Counted' })
		await demo.store.create('comment', { articleId: post.id, body: 'one' })
		await demo.store.create('comment', { articleId: post.id, body: 'two' })
		// An unrelated comment on another article must not inflate the count.
		const other = await demo.store.create('article', { title: 'Other' })
		await demo.store.create('comment', { articleId: other.id, body: 'nope' })

		const n = await demo.store.count('comment', {
			filter: { articleId: String(post.id) },
		})
		expect(n).toBe(2)

		const res = await countHandler(ctx, 'comment', {
			filter: { articleId: String(post.id) },
		})
		expect(res.status).toBe(200)
		expect(res.body).toEqual({ count: 2 })
	})
})
