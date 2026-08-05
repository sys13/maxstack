/**
 * Bundle seeding — apply installed bundles' seed rows to a live store, using the
 * db-plugins registry as the engine (its promotion: the seed-plugin mechanism is
 * what actually loads bundle seeds). Each bundle with seeds becomes a
 * `DatabasePlugin`; seeding runs them in install order and is **idempotent** — an
 * entity that already has rows is skipped, so re-boots and re-installs never
 * duplicate.
 *
 * Called at dev boot from the composition root (`apps/web/app/sprout.server.ts`)
 * over the project's installed-bundle list, so `maxstack add` stays pure (spec +
 * config only) and seeding survives a store that didn't exist at add time.
 */

import { DatabasePluginRegistry } from '../db-plugins/index.ts'
import type { Bundle } from './types.ts'

/** The store surface seeding needs — a structural subset of `SproutStore`. */
export interface SeedStore {
	list(resource: string, opts?: { limit?: number }): Promise<unknown[]>
	create(resource: string, data: Record<string, unknown>): Promise<unknown>
}

/**
 * Seed the given bundles into `store`, idempotently, via the db-plugins registry.
 * Bundles without seeds are ignored.
 */
export async function seedBundles(
	store: SeedStore,
	bundles: readonly Bundle[],
): Promise<void> {
	const registry = new DatabasePluginRegistry<SeedStore>()
	const enabled: string[] = []
	for (const bundle of bundles) {
		const seeds = bundle.runtime.seeds
		if (!seeds || seeds.length === 0) continue
		enabled.push(bundle.slug)
		registry.register({
			name: bundle.slug,
			models: seeds.map((s) => s.entityKey),
			seed: async (db) => {
				for (const seed of seeds) {
					// Idempotent: only seed an entity that has no rows yet.
					const existing = await db.list(seed.entityKey, { limit: 1 })
					if (existing.length > 0) continue
					for (const row of seed.rows) await db.create(seed.entityKey, row)
				}
			},
			// Teardown is not part of the boot-seed flow; the registry keeps its
			// FK-ordered `clear` for callers that need it.
			clear: async () => {},
		})
	}
	await registry.seed(store, enabled)
}
