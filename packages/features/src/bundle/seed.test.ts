import { describe, expect, it } from 'vitest'
import { getBundle } from './catalog.ts'
import { type SeedStore, seedBundles } from './seed.ts'

function fakeStore() {
	const rows: Record<string, Record<string, unknown>[]> = {}
	const store: SeedStore = {
		list: async (resource, opts) =>
			(rows[resource] ?? []).slice(0, opts?.limit),
		create: async (resource, data) => {
			rows[resource] ??= []
			rows[resource].push(data)
			return data
		},
	}
	return { store, rows }
}

describe('seedBundles', () => {
	it('inserts a bundle’s seed rows through the db-plugins engine', async () => {
		const { store, rows } = fakeStore()
		const members = getBundle('members')
		if (!members) throw new Error('members bundle missing')
		await seedBundles(store, [members])
		expect(rows.organization).toHaveLength(1)
		expect(rows.organization?.[0]?.name).toBe('Acme Inc')
	})

	it('is idempotent — an entity that already has rows is skipped', async () => {
		const { store, rows } = fakeStore()
		const members = getBundle('members')
		if (!members) throw new Error('members bundle missing')
		await seedBundles(store, [members])
		await seedBundles(store, [members])
		expect(rows.organization).toHaveLength(1)
	})

	it('ignores bundles without seeds', async () => {
		const { store, rows } = fakeStore()
		const auth = getBundle('auth')
		if (!auth) throw new Error('auth bundle missing')
		await seedBundles(store, [auth])
		expect(Object.keys(rows)).toHaveLength(0)
	})
})
