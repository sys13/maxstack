/**
 * `relatedRecords` over the real registry + store.
 *
 * The panel's own rendering is covered in `@maxstack/ui`; what has to be proved
 * here is the half that cannot be proved from a fixture: that the *declared*
 * FKs of a live registry are enough to find a record's children, with no
 * per-entity wiring — and that the rows it returns are that record's, not every
 * row of the child table.
 */

import type { OpContext, SproutUser } from '@maxstack/core'
import { opCreate, ResourceRegistry } from '@maxstack/core'
import { article, comment } from '@maxstack/core/demo'
import { beforeAll, describe, expect, it } from 'vitest'
import { getSprout, relatedRecords } from './sprout.server'

const admin: SproutUser = { id: 'admin', role: 'admin' }

let ctx: OpContext

beforeAll(async () => {
	const { registry, store } = await getSprout()
	ctx = { registry, store, user: admin }
})

describe('relatedRecords', () => {
	it('returns the rows that reference the record, derived from the declared FK', async () => {
		const article = await opCreate(ctx, 'article', { title: 'Subject' })
		const other = await opCreate(ctx, 'article', { title: 'Unrelated' })
		const id = String(article.id)
		await opCreate(ctx, 'comment', { articleId: id, body: 'first' })
		await opCreate(ctx, 'comment', { articleId: id, body: 'second' })
		await opCreate(ctx, 'comment', {
			articleId: String(other.id),
			body: 'elsewhere',
		})

		const groups = await relatedRecords(ctx, 'article', id)
		const comments = groups.find((g) => g.resource === 'comment')
		expect(comments).toBeDefined()
		expect(comments?.fk).toBe('articleId')
		// The other article's comment is not this record's, and a count that
		// included it would be the panel's whole failure mode.
		expect(comments?.count).toBe(2)
		expect(comments?.rows.map((r) => r.body).sort()).toEqual([
			'first',
			'second',
		])
		// The child's introspection travels with the rows, so the panel can infer
		// its columns without a second lookup on the client.
		expect(comments?.introspection.name).toBe('comment')
	})

	it('reports a declared relation with no rows as an empty group, not a missing one', async () => {
		const article = await opCreate(ctx, 'article', { title: 'Childless' })
		const groups = await relatedRecords(ctx, 'article', String(article.id))
		const comments = groups.find((g) => g.resource === 'comment')
		// Present and honest: a section that disappeared when empty would be
		// indistinguishable from a relation nobody declared.
		expect(comments?.count).toBe(0)
		expect(comments?.rows).toEqual([])
	})

	it('caps the rows it reads while still reporting the true total', async () => {
		const article = await opCreate(ctx, 'article', { title: 'Busy' })
		const id = String(article.id)
		for (let i = 0; i < 4; i++)
			await opCreate(ctx, 'comment', { articleId: id, body: `c${i}` })

		const groups = await relatedRecords(ctx, 'article', id, { limit: 2 })
		const comments = groups.find((g) => g.resource === 'comment')
		expect(comments?.rows).toHaveLength(2)
		expect(comments?.count).toBe(4)
	})

	it('reads the same page of a relation twice — ordered, not whatever arrived', async () => {
		const author = await opCreate(ctx, 'author', { name: 'Ordered' })
		const authorId = String(author.id)
		// `task` carries a `createdAt`, so the panel's page is newest-first. The
		// rows are written oldest-first and out of insertion order relative to
		// their timestamps, so an unordered LIMIT could return any two of them.
		const written = ['oldest', 'middle', 'newest']
		for (const [i, title] of written.entries())
			await ctx.store.create('task', {
				title,
				authorId,
				createdAt: `2026-01-0${i + 1} 00:00:00`,
			})

		const page = async () =>
			(await relatedRecords(ctx, 'author', authorId, { limit: 2 }))
				.find((g) => g.resource === 'task')
				?.rows.map((r) => r.title)

		expect(await page()).toEqual(['newest', 'middle'])
		// The property that matters: the same first page, not merely a plausible
		// one. A `LIMIT` with no `ORDER BY` makes "2 of 3" a different 2 per
		// render, and the count beside the heading then describes rows the panel
		// can never show.
		expect(await page()).toEqual(['newest', 'middle'])
	})

	it('falls back to a stable key when the child has no creation timestamp', async () => {
		const article = await opCreate(ctx, 'article', { title: 'Stable' })
		const id = String(article.id)
		for (let i = 0; i < 3; i++)
			await opCreate(ctx, 'comment', { articleId: id, body: `c${i}` })

		const all = (await relatedRecords(ctx, 'article', id, { limit: 10 })).find(
			(g) => g.resource === 'comment',
		)
		// `comment` has no `createdAt`, so the order is its primary key —
		// arbitrary for a random uuid, and precisely therefore not the insertion
		// order the store would otherwise have handed back.
		const ids = all?.rows.map((r) => String(r.id))
		expect(ids).toEqual([...(ids ?? [])].sort())

		const page = async () =>
			(await relatedRecords(ctx, 'article', id, { limit: 2 }))
				.find((g) => g.resource === 'comment')
				?.rows.map((r) => r.id)
		expect(await page()).toEqual(await page())
	})

	it('does not render a tenant column as a relation', async () => {
		// An FK named as `tenantField` is the scope every read of that resource
		// already runs under, not an edge between two records: read as an inverse
		// it says "every row of this entity", which on the org's own record page
		// is one section per entity in the app, each listing the whole table.
		const registry = new ResourceRegistry()
		registry.register(article, { titleField: 'title' })
		registry.register(comment, { titleField: 'body' })
		const control = { ...ctx, registry }
		const parent = await opCreate(control, 'article', { title: 'Tenant' })
		const id = String(parent.id)
		await opCreate(control, 'comment', { articleId: id, body: 'child' })
		expect(
			(await relatedRecords(control, 'article', id)).map((g) => g.resource),
		).toEqual(['comment'])

		const scoped = new ResourceRegistry()
		scoped.register(article, { titleField: 'title' })
		scoped.register(comment, { titleField: 'body', tenantField: 'articleId' })
		// An identity with `articleId` as its active org, so the tenant scope is
		// satisfied and `opList` succeeds — otherwise the section would vanish on
		// a thrown scope error and this would prove nothing.
		const tenant = {
			...ctx,
			registry: scoped,
			user: { ...admin, orgId: id },
		}
		expect(await relatedRecords(tenant, 'article', id)).toEqual([])
	})

	it('yields nothing for a record nothing points at', async () => {
		const tag = await opCreate(ctx, 'tag', { name: `t-${Date.now()}` })
		// `article.tags` is an array reference, whose inverse is not an equality
		// filter — so a tag has no derived children here (that is
		// `<ReferenceManyToManyField>`'s job).
		expect(await relatedRecords(ctx, 'tag', String(tag.id))).toEqual([])
	})
})
