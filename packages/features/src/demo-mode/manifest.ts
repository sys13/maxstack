/**
 * The demo-seed manifest (closes #101) — a record, in the project's
 * data dir, of exactly which rows `maxstack demo` created.
 *
 * Two gating requirements of "one command to a populated app" are really one
 * requirement about *honesty*: a user must never mistake demo rows for their
 * own, and removing them must be one command that touches nothing else. Both
 * need the same fact — which ids the seeder wrote — and neither can be
 * recovered after the fact, because the whole point of the generic seeder is
 * that a seeded row is an ordinary row (it deletes through the same
 * route, it has no special column, nothing about the schema knows it exists).
 *
 * So the marker lives *beside* the data rather than inside it:
 *
 *   - No schema change, so a project that never seeds pays nothing and a
 *     seeded project's tables stay exactly what the spec says they are.
 *   - Deleting the manifest, or the data dir, degrades to "these are your
 *     rows now" — the safe direction. A stale id is a no-op delete.
 *   - It never claims rows it did not create: a resource the seeder skipped
 *     (it already had data) contributes nothing, so `--clear` cannot eat
 *     hand-entered rows.
 *
 * Bundle fixtures are deliberately *not* tracked. They are reapplied on every
 * grounding as part of the bundle's own contract, so "clearing" them would only
 * mean watching them come back.
 */

/** The on-disk file, relative to the project data dir. */
export const DEMO_MANIFEST_FILENAME = 'demo-seed.json'

export interface DemoSeedManifest {
	version: 1
	/** ISO timestamp of the most recent seed that contributed to this file. */
	seededAt: string
	/** Primary keys created by the seeder, keyed by resource name. */
	rows: Record<string, string[]>
}

/** The minimal filesystem surface this needs — injected so the module stays
 * testable and free of a hard `node:fs` dependency in a package that also runs
 * in bundler-resolved contexts. */
export interface ManifestFs {
	readFile(path: string, encoding: 'utf8'): Promise<string>
	writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>
	rm(path: string, opts: { force: boolean }): Promise<void>
}

async function nodeFs(): Promise<ManifestFs> {
	const fs = await import('node:fs/promises')
	return {
		readFile: (p, e) => fs.readFile(p, e),
		writeFile: (p, d, e) => fs.writeFile(p, d, e),
		rm: (p, o) => fs.rm(p, o),
	}
}

const manifestPath = (dataDir: string): string =>
	`${dataDir}/${DEMO_MANIFEST_FILENAME}`

/** An empty manifest — what a project with no seeded rows looks like. */
export function emptyManifest(seededAt = ''): DemoSeedManifest {
	return { version: 1, seededAt, rows: {} }
}

/**
 * Read the manifest, treating *any* problem — missing file, unreadable dir,
 * malformed JSON, a future version — as "nothing was seeded". A manifest is a
 * convenience marker over ordinary rows; refusing to load a page because it is
 * corrupt would be the tail wagging the dog.
 */
export async function readDemoManifest(
	dataDir: string,
	fs?: ManifestFs,
): Promise<DemoSeedManifest> {
	const io = fs ?? (await nodeFs())
	try {
		const parsed = JSON.parse(await io.readFile(manifestPath(dataDir), 'utf8'))
		if (!parsed || typeof parsed !== 'object') return emptyManifest()
		if ((parsed as DemoSeedManifest).version !== 1) return emptyManifest()
		const rows = (parsed as DemoSeedManifest).rows
		if (!rows || typeof rows !== 'object') return emptyManifest()
		// Keep only the string[] entries: a hand-edited file must not be able to
		// hand `store.delete` a non-string id.
		const clean: Record<string, string[]> = {}
		for (const [resource, ids] of Object.entries(rows)) {
			if (!Array.isArray(ids)) continue
			const strings = ids.filter((id): id is string => typeof id === 'string')
			if (strings.length) clean[resource] = strings
		}
		return {
			version: 1,
			seededAt: String((parsed as DemoSeedManifest).seededAt ?? ''),
			rows: clean,
		}
	} catch {
		return emptyManifest()
	}
}

/** Fold newly-created ids into a manifest, deduped and order-preserving —
 * re-running `demo` after adding an entity must extend the record, not replace
 * it, or the first seed's rows silently become "yours". */
export function mergeManifest(
	current: DemoSeedManifest,
	created: Record<string, string[]>,
	seededAt: string,
): DemoSeedManifest {
	const rows: Record<string, string[]> = { ...current.rows }
	for (const [resource, ids] of Object.entries(created)) {
		if (!ids.length) continue
		const seen = new Set(rows[resource] ?? [])
		const next = [...(rows[resource] ?? [])]
		for (const id of ids) {
			if (seen.has(id)) continue
			seen.add(id)
			next.push(id)
		}
		rows[resource] = next
	}
	return { version: 1, seededAt, rows }
}

export async function writeDemoManifest(
	dataDir: string,
	manifest: DemoSeedManifest,
	fs?: ManifestFs,
): Promise<void> {
	const io = fs ?? (await nodeFs())
	await io.writeFile(
		manifestPath(dataDir),
		`${JSON.stringify(manifest, null, '\t')}\n`,
		'utf8',
	)
}

export async function removeDemoManifest(
	dataDir: string,
	fs?: ManifestFs,
): Promise<void> {
	const io = fs ?? (await nodeFs())
	await io.rm(manifestPath(dataDir), { force: true })
}

/** Total tracked rows — the number the in-app demo notice reports. */
export function manifestRowCount(manifest: DemoSeedManifest): number {
	return Object.values(manifest.rows).reduce((n, ids) => n + ids.length, 0)
}
