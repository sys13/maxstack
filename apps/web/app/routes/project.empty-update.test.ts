/**
 * A generated page's record surface, given an update body that changes nothing
 * (#388).
 *
 * `project.action-refusals.test.ts` next door pins the *shape* refusals with the
 * write handlers stubbed, which is right for a gate that runs before them. This
 * one cannot: the defect is that the body sailed **through** the gate, validated
 * successfully into `{}`, and died in the driver — so the handler has to be real
 * and so does the store. `POST /decks/:id` with `{"bogus": 1}` is exactly the
 * guess #376's session made one key over, and it was a 500 until now.
 *
 * The REST half of the same refusal is pinned in core, where the handler lives:
 * `packages/maxstack-core/src/sprout/empty-update.test.ts`.
 */

import {
	createSpecDb,
	type OpContext,
	ResourceRegistry,
	registerSpecEntities,
	type SpecEntityShape,
} from '@maxstack/core'
import { beforeAll, describe, expect, it, vi } from 'vitest'

const DECK: SpecEntityShape = {
	name: 'deck',
	fields: [
		{ name: 'title', type: 'string', required: true },
		{ name: 'notes', type: 'string', required: false },
	],
}

const page = { slug: 'decks', route: '/decks', resource: 'deck' }

let ctx: OpContext
let rowId: string

vi.mock('~/project.server', () => ({
	resolveProjectResource: async () => ({
		page,
		nav: [],
		resource: 'deck',
		primaryKey: 'id',
		introspection: { name: 'deck', columns: [], primaryKey: 'id' },
	}),
	projectChrome: async () => ({ title: 'Decks', theme: {}, demoRows: 0 }),
}))

vi.mock('~/sprout.server', () => ({
	getContext: async () => ctx,
	referenceFieldOptions: async () => ({}),
	relatedRecords: async () => [],
	resolveRowFiles: () => ({}),
}))

vi.mock('~/live.server', () => ({ liveSlotFor: async () => undefined }))

const { action } = await import('./project.edit.server')

/** What `data(body, init)` carries — see the sibling file's note on the type. */
interface Refused {
	data: { error: string }
	init?: { status?: number }
}

const post = async (body: unknown) =>
	(await action({
		request: new Request('http://x/decks/r1', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		}),
		params: { page: 'decks', id: rowId },
	})) as Refused

beforeAll(async () => {
	const registry = new ResourceRegistry()
	registerSpecEntities(registry, [DECK])
	const { store } = await createSpecDb(registry, [DECK])
	ctx = { registry, store, user: { id: 'u-admin', role: 'admin' } }
	rowId = String((await store.create('deck', { title: 'First' })).id)
})

describe('POST /decks/:id with a JSON body that changes nothing', () => {
	it('refuses an empty object with 400 rather than a driver 500', async () => {
		const res = await post({})
		expect(res.init?.status).toBe(400)
		expect(res.data.error).toContain('the body was empty')
	})

	it('refuses an all-unknown-keys body with 400, naming the keys', async () => {
		// One key over from the `{"intent":"delete"}` #376 special-cased: the class
		// was alive under every *other* unknown key.
		const res = await post({ bogus: 1 })
		expect(res.init?.status).toBe(400)
		expect(res.data.error).toContain('No such field on deck: bogus')
		expect(res.data.error).toContain('query_spec {section:"api"}')
	})

	it('still redirects after an update that does change something', async () => {
		const res = (await post({ title: 'Renamed' })) as unknown as Response
		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toBe('/decks')
	})
})
