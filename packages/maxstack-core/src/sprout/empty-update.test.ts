/**
 * An update body with nothing writable in it (#388).
 *
 * `opUpdate` validates with a `z.object`, which **strips** unknown keys, so
 * `{}` and `{"bogus": 1}` both validate *successfully* into `{}` — and
 * `store.update(resource, id, {})` reached drizzle's `.set({})`, which throws
 * "No values to set". The caller got a 500 for an unambiguous caller error,
 * which is the exact failure #376 was about one level up: a 5xx reads as "I
 * found a bug in the platform", and an agent stops instead of correcting itself.
 *
 * The regression pinned here is therefore, in order: it is **4xx**, it is
 * specifically **400** rather than the 422 a rejected *value* gets, and the
 * message **names the keys that were dropped** — a refusal that says only "no"
 * costs the same round trip the 500 did.
 *
 * `updateHandler` is exercised rather than the RR7 route, because the route
 * (`apps/web/app/routes/api.resource.$id.tsx`) is a five-line adapter over it:
 * parse the JSON, call this, return the status. The page action's own half is
 * pinned in `apps/web/app/routes/project.empty-update.test.ts`, against a real
 * store, because that path has a second JSON branch of its own.
 */

import { describe, expect, it } from 'vitest'
import { updateHandler } from './api.ts'
import {
	createSpecDb,
	registerSpecEntities,
	type SpecEntityShape,
} from './from-spec.ts'
import { EmptyUpdateError, type OpContext, opUpdate } from './operations.ts'
import { ResourceRegistry } from './registry.ts'

const NOTE: SpecEntityShape = {
	name: 'note',
	fields: [
		{ name: 'title', type: 'string', required: true },
		{ name: 'body', type: 'string', required: false },
	],
}

async function project(): Promise<OpContext> {
	const registry = new ResourceRegistry()
	registerSpecEntities(registry, [NOTE])
	const { store } = await createSpecDb(registry, [NOTE])
	return { registry, store, user: { id: 'u-admin', role: 'admin' } }
}

async function seeded(): Promise<{ ctx: OpContext; id: string }> {
	const ctx = await project()
	const row = await ctx.store.create('note', { title: 'First' })
	return { ctx, id: String(row.id) }
}

describe('PATCH /api/note/:id with nothing writable in the body', () => {
	it('is 400, not a 500 out of the driver, for an empty body', async () => {
		const { ctx, id } = await seeded()
		const res = await updateHandler(ctx, 'note', id, {})
		expect(res.status).toBe(400)
		const body = res.body as { error: string }
		// Not "Internal error" plus a correlation id, which is what the driver's
		// "No values to set" was rendered as after #336.
		expect(body.error).not.toContain('Internal error')
		expect(body.error).toContain('the body was empty')
		expect(body.error).toContain('query_spec {section:"api"}')
	})

	it('is 400 for a body of only unknown keys, and names them', async () => {
		const { ctx, id } = await seeded()
		const res = await updateHandler(ctx, 'note', id, { bogus: 1, nope: 'x' })
		expect(res.status).toBe(400)
		const body = res.body as {
			error: string
			unknownFields: string[]
			immutableFields: string[]
		}
		// The whole value of refusing rather than 500ing: the caller is told which
		// of the keys it sent do not exist, so the next call is the right one.
		expect(body.error).toContain('No such field on note: bogus, nope')
		expect(body.unknownFields).toEqual(['bogus', 'nope'])
		expect(body.immutableFields).toEqual([])
	})

	it('says "not writable" rather than "no such field" for a real column an update may not write', async () => {
		const { ctx, id } = await seeded()
		// `id` IS a column — it is simply not writable, like the tenant and
		// soft-delete columns `opUpdate` strips. Telling the caller it does not
		// exist would send it looking for a typo it did not make.
		const res = await updateHandler(ctx, 'note', id, { id })
		expect(res.status).toBe(400)
		const body = res.body as { error: string; immutableFields: string[] }
		expect(body.error).toContain('Not writable through update: id')
		expect(body.immutableFields).toEqual(['id'])
	})

	it('throws EmptyUpdateError from `opUpdate`, not from the store', async () => {
		const { ctx, id } = await seeded()
		// Thrown at the operation, so every surface — REST, MCP, the page action,
		// an owned caller — refuses with one sentence rather than four.
		await expect(
			opUpdate(ctx, 'note', id, { bogus: 1 }),
		).rejects.toBeInstanceOf(EmptyUpdateError)
	})

	it('still updates when one real field survives beside an unknown key', async () => {
		const { ctx, id } = await seeded()
		// The refusal is about an update that would change *nothing*. An unknown
		// key alongside a real one is stripped exactly as before — narrowing this
		// to the empty case is what keeps it from being a breaking change.
		const res = await updateHandler(ctx, 'note', id, {
			title: 'Renamed',
			bogus: 1,
		})
		expect(res.status).toBe(200)
		expect((res.body as { title: string }).title).toBe('Renamed')
	})

	it('still 404s an absent row before it looks at the body', async () => {
		const { ctx } = await seeded()
		// Order matters: an empty body for a row the caller may not even know
		// about must not leak that the row is missing as a 400 about fields.
		const res = await updateHandler(
			ctx,
			'note',
			'00000000-0000-4000-8000-000000000000',
			{},
		)
		expect(res.status).toBe(404)
	})
})
