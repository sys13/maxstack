/**
 * DB seed-plugin registry — reimplemented core of mxscratchpad's
 * `database/plugins/index.ts`. The archived plugin *bodies* (blog,
 * saas-marketing) are self-described placeholders coupled to a `faker` seeder
 * and app schema that don't exist here, so they are not lifted.
 *
 * The salvaged decisions are the ones that survive the placeholders:
 *   - a name-keyed registry of seed plugins (`register`/`get`/`getAll`/`load`),
 *   - `seed` runs plugins in enable order,
 *   - `clear` runs them in REVERSE order so FK-dependent rows drop before their
 *     parents.
 *
 * Reimplemented generic over the db handle (the original hard-typed `Database`)
 * and stripped of the original's `console.log` seeding chatter.
 */

export interface DatabasePlugin<Db = unknown> {
	name: string
	/** Model/table names this plugin owns (advisory metadata). */
	models: string[]
	seed: (db: Db) => Promise<void>
	clear: (db: Db) => Promise<void>
}

export class DatabasePluginRegistry<Db = unknown> {
	readonly #plugins = new Map<string, DatabasePlugin<Db>>()

	/** Register (or replace) a plugin by name. */
	register(plugin: DatabasePlugin<Db>): void {
		this.#plugins.set(plugin.name, plugin)
	}

	get(name: string): DatabasePlugin<Db> | undefined {
		return this.#plugins.get(name)
	}

	getAll(): DatabasePlugin<Db>[] {
		return [...this.#plugins.values()]
	}

	/** Resolve enabled plugin names to plugins, skipping unknown names. */
	load(enabled: string[]): DatabasePlugin<Db>[] {
		return enabled
			.map((name) => this.#plugins.get(name))
			.filter((p): p is DatabasePlugin<Db> => p !== undefined)
	}

	/** Seed enabled plugins in order. Fails fast on the first error. */
	async seed(db: Db, enabled: string[]): Promise<void> {
		for (const plugin of this.load(enabled)) {
			await plugin.seed(db)
		}
	}

	/**
	 * Clear enabled plugins in REVERSE order so child rows drop before parents.
	 * A failing plugin does not abort the rest (best-effort teardown); the first
	 * error is rethrown after all have been attempted.
	 */
	async clear(db: Db, enabled: string[]): Promise<void> {
		let firstError: unknown
		for (const plugin of this.load(enabled).reverse()) {
			try {
				await plugin.clear(db)
			} catch (error) {
				firstError ??= error
			}
		}
		if (firstError) throw firstError
	}
}
