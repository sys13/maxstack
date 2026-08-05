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
import { opCreate } from '@maxstack/core'
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

	it('yields nothing for a record nothing points at', async () => {
		const tag = await opCreate(ctx, 'tag', { name: `t-${Date.now()}` })
		// `article.tags` is an array reference, whose inverse is not an equality
		// filter — so a tag has no derived children here (that is
		// `<ReferenceManyToManyField>`'s job).
		expect(await relatedRecords(ctx, 'tag', String(tag.id))).toEqual([])
	})
})
