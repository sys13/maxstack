/**
 * Demo-data seeder (task 63 "Onboarding & demo mode") — populate
 * representative sample rows for every resource in a project's registry,
 * generically from column introspection. There is no per-app fixture list to
 * maintain: any spec-defined project gets plausible rows for free, which is
 * what makes this reusable from both the onboarding wizard's "load demo data"
 * button (`apps/web/app/routes/onboarding.tsx`) and a headless CLI script
 * (`apps/web/scripts/seed-demo.ts`, wired to `maxstack demo`).
 *
 * Idempotent: a resource that already has rows is left alone (its existing
 * rows are sampled so *other* resources can still reference them), so
 * reopening the wizard or re-running the CLI command never duplicates data.
 *
 * Seeds resources in FK-dependency order (referenced tables first) so
 * `reference` / `arrayReference` columns resolve to real ids instead of
 * dangling ones.
 */

import type {
	ResourceRegistry,
	Row,
	SproutColumn,
	SproutStore,
} from '@maxstack/core'

export interface SeedDemoDataOptions {
	registry: ResourceRegistry
	store: SproutStore
	/** Rows to create per resource that doesn't already have data. Default 5. */
	rowsPerResource?: number
}

export interface SeedDemoDataResult {
	/** Resources that received new demo rows. */
	seeded: string[]
	/** Resources left alone because they already had rows. */
	skipped: string[]
	/**
	 * The primary keys created, keyed by resource. A seeded row is
	 * an ordinary row by design — no marker column, deletable through the same
	 * route as any other — so *this* is the only record of which rows were demo
	 * data. `demo --clear` and the in-app demo notice both read it, via
	 * `manifest.ts`. Only rows this call created: a skipped resource contributes
	 * nothing, so a clear can never reach hand-entered data.
	 */
	created: Record<string, string[]>
}

/** Column-name fragments that usually carry a server-managed default
 * (timestamps, soft-delete markers) — left unset so the store's own default
 * applies rather than a fake value. */
const MANAGED_NAME = /created|updated|deleted/i

/** Seed demo rows into every registered resource that doesn't already have
 * data, in dependency order. Safe to call repeatedly. */
export async function seedDemoData(
	opts: SeedDemoDataOptions,
): Promise<SeedDemoDataResult> {
	const { registry, store } = opts
	const rowsPerResource = opts.rowsPerResource ?? 5
	const seeded: string[] = []
	const skipped: string[] = []
	const created: Record<string, string[]> = {}
	// Rows available for FK sampling, per resource — either freshly seeded or
	// an existing sample when the resource already had data.
	const available = new Map<string, Row[]>()

	for (const name of dependencyOrder(registry)) {
		const entry = registry.get(name)
		if (!entry) continue

		const existing = (await store.list(name, {
			limit: rowsPerResource,
		})) as Row[]
		if (existing.length > 0) {
			available.set(name, existing)
			skipped.push(name)
			continue
		}

		const rows: Row[] = []
		for (let i = 0; i < rowsPerResource; i++) {
			const data = buildRow(entry.resource.columns, i, available)
			const created = await store.create(name, data)
			rows.push(created as Row)
			// Make this row available to later rows in the same resource (e.g. a
			// nullable self-reference such as a parent category).
			available.set(name, rows)
		}
		if (rows.length > 0) {
			seeded.push(name)
			const pk = entry.resource.primaryKey
			created[name] = rows
				.map((r) => r[pk])
				.filter((id): id is string => typeof id === 'string')
		}
	}

	return { seeded, skipped, created }
}

export interface ClearDemoDataResult {
	/** Rows actually deleted, keyed by resource. */
	deleted: Record<string, number>
	/**
	 * Ids the manifest listed that were no longer there — already deleted by
	 * hand, or lost with a reset store. Reported rather than swallowed: a clear
	 * that silently "succeeds" on a store it never touched is how a user ends up
	 * believing demo data is gone when it is not.
	 */
	missing: number
}

/**
 * Delete exactly the rows a previous seed created.
 *
 * Reverse dependency order, so a referenced row goes after the rows referencing
 * it and an FK constraint never rejects a delete that should have succeeded.
 * Ids come from the manifest and nowhere else — this never scans for
 * "demo-looking" rows, because a heuristic that deleted a user's real row once
 * would be worse than never having shipped the command.
 */
export async function clearDemoData(opts: {
	registry: ResourceRegistry
	store: SproutStore
	rows: Record<string, readonly string[]>
}): Promise<ClearDemoDataResult> {
	const deleted: Record<string, number> = {}
	let missing = 0
	const order = dependencyOrder(opts.registry).reverse()
	// A manifest can name a resource the spec no longer has (an entity was
	// removed after seeding); those ids are unreachable, so count them missing
	// rather than dropping them on the floor.
	const known = new Set(order)
	for (const [resource, ids] of Object.entries(opts.rows)) {
		if (!known.has(resource)) missing += ids.length
	}

	for (const resource of order) {
		const ids = opts.rows[resource]
		if (!ids?.length) continue
		let count = 0
		for (const id of ids) {
			if (await opts.store.delete(resource, id)) count++
			else missing++
		}
		if (count > 0) deleted[resource] = count
	}
	return { deleted, missing }
}

/**
 * Every table this one points at.
 *
 * Reads `resource.relations` alone, which is now the whole graph: since issue
 * #209 the introspector builds it from the columns, so a spec entity's
 * reference (which arrives as column metadata, not as a drizzle foreign key)
 * is an edge like any other. This function previously had to union `relations`
 * with `column.references` / `column.meta.arrayReference` by hand, because
 * reading `relations` alone was blind to exactly the references a maxstack
 * project actually has — the child seeded before the parent, found no parent
 * rows to sample, and wrote `null` into every FK of a freshly started app.
 */
function referencedTables(entry: {
	resource: { name: string; relations: { references: { table: string } }[] }
}): string[] {
	return [
		...new Set(entry.resource.relations.map((rel) => rel.references.table)),
	]
}

/** Topologically order resources so a referenced table is seeded before the
 * table that references it. Cycles (including self-references) just fall back
 * to registration order for the tied members — self/circular refs are always
 * nullable in practice, so seeding order doesn't matter for them. */
function dependencyOrder(registry: ResourceRegistry): string[] {
	const all = registry.all()
	const visited = new Set<string>()
	const order: string[] = []

	function visit(name: string, stack: Set<string>): void {
		if (visited.has(name) || stack.has(name)) return
		const entry = registry.get(name)
		if (!entry) return
		stack.add(name)
		for (const table of referencedTables(entry)) {
			if (table !== name) visit(table, stack)
		}
		stack.delete(name)
		visited.add(name)
		order.push(name)
	}

	for (const entry of all) visit(entry.resource.name, new Set())
	return order
}

/** Build one fake row from a resource's column shapes, resolving `reference` /
 * `arrayReference` columns against already-seeded rows when available. */
function buildRow(
	columns: SproutColumn[],
	index: number,
	available: Map<string, Row[]>,
): Row {
	const row: Row = {}
	for (const column of columns) {
		if (column.isPrimaryKey) continue
		if (column.meta.hidden || column.meta.readOnly) continue
		if (column.hasDefault && MANAGED_NAME.test(column.name)) continue

		const value = sampleValue(column, index, available)
		if (value === undefined) continue
		row[column.name] = value
	}
	return row
}

function sampleValue(
	column: SproutColumn,
	index: number,
	available: Map<string, Row[]>,
): unknown {
	const label = column.meta.label ?? titleCase(column.name)

	// Single-row reference (belongs-to FK).
	if (column.references) {
		const id = sampleReferenceId(column.references.table, available, index)
		if (id !== undefined) return id
		if (column.nullable) return null
		return undefined
	}

	// Array-of-ids reference (task 38's `arrayReference`).
	if (column.meta.arrayReference) {
		const rows = available.get(column.meta.arrayReference.table) ?? []
		if (rows.length === 0) return column.nullable ? null : []
		const count = Math.min(rows.length, 1 + (index % 2))
		return rows.slice(0, count).map((r) => r.id)
	}

	if (
		column.type === 'enum' &&
		column.enumValues &&
		column.enumValues.length > 0
	) {
		return column.enumValues[index % column.enumValues.length]
	}

	switch (column.type) {
		case 'string':
			if (column.meta.isFile) return undefined
			if (/email/i.test(column.name)) return `demo${index + 1}@example.com`
			if (column.meta.markdown) {
				return `# ${label} ${index + 1}\n\nSample content generated by demo mode — replace with the real thing.`
			}
			return `Sample ${label} ${index + 1}`
		case 'number': {
			const min = column.meta.min ?? 1
			const max = column.meta.max ?? min + 100
			const span = Math.max(max - min, 1)
			return min + (index % (span + 1))
		}
		case 'boolean':
			return index % 2 === 0
		case 'date':
			return new Date(Date.now() - index * 86_400_000).toISOString()
		case 'uuid':
			return crypto.randomUUID()
		case 'json':
			return column.nullable ? null : {}
		default:
			return undefined
	}
}

/** Pick the parent row this child points at. Round-robin by row index rather
 * than random: it still spreads children across parents, and it makes a seed
 * reproducible — `maxstack start` is gated in CI, and a random FK would make
 * the same description produce a different app on every run. */
function sampleReferenceId(
	table: string,
	available: Map<string, Row[]>,
	index: number,
): string | undefined {
	const rows = available.get(table)
	if (!rows || rows.length === 0) return undefined
	const row = rows[index % rows.length]
	return row?.id as string | undefined
}

function titleCase(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.split(/[_\s]+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ')
}
