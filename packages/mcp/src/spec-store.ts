/**
 * The two {@link SpecStore} hosts:
 *
 *   - {@link createInMemorySpecStore} — tests + the default dev server;
 *   - {@link createFileSpecStore}     — the disk-backed store, so a project's
 *     spec survives server restarts and the workbench, the MCP tools, and a
 *     headless script all see the same durable document.
 *
 * On disk a spec is a **directory** (`spec/`), not one file — the codec
 * (`@maxstack/spec` `spec-codec`) splits it by layer (`product.json`,
 * `data.json`, `pages.json`, `pricing.json`, `ledger.json`), streams the audit
 * trail to an append-friendly `oplog.jsonl`, and compacts provenance, so a
 * long-lived spec stays legible and its git diffs stay local. A project that
 * still has the legacy single `spec.json` is migrated to the directory on first
 * load (see {@link createFileSpecStore}).
 */

import {
	decodeSpecSystem,
	encodeSpecSystem,
	OPTIONAL_SPEC_DIR_FILES,
	SPEC_DIR_FILES,
	type SpecSystem,
	validateSpecSystem,
} from '@maxstack/spec'
import type { SpecStore } from './context.ts'

/**
 * Hold a `SpecSystem` in a closure. `save` replaces it wholesale — callers apply
 * spec-ops to produce the next immutable system and hand it here, so the store
 * never mutates a system in place.
 */
export function createInMemorySpecStore(initial: SpecSystem): SpecStore {
	let current = initial
	return {
		async load() {
			return current
		},
		async save(next) {
			current = next
		},
	}
}

// ===========================================================================
// Legacy v1 monolith (single `spec.json`) — kept for migration + tests
// ===========================================================================

/** Serialize a spec system to the legacy single-document JSON form. */
export function serializeSpecSystem(spec: SpecSystem): string {
	return `${JSON.stringify(spec, null, '\t')}\n`
}

/** Parse + validate a legacy single-document spec (throws on a broken spec). */
export function parseSpecSystem(json: string): SpecSystem {
	return validateSpecSystem(JSON.parse(json) as SpecSystem)
}

// ===========================================================================
// The spec directory (v2) — split, compacted, one file per layer
// ===========================================================================

/** Read + validate a spec directory. Throws an ENOENT-coded error when the
 * directory (its `meta.json`) is absent, so callers can distinguish "no spec
 * here yet" from a genuinely corrupt one. Node-only. */
export async function readSpecDir(dir: string): Promise<SpecSystem> {
	const { readFile } = await import('node:fs/promises')
	const { join } = await import('node:path')
	// meta.json first: its absence is the "not a spec dir" signal (ENOENT).
	const meta = await readFile(join(dir, SPEC_DIR_FILES.meta), 'utf8')
	const files: Record<string, string> = { [SPEC_DIR_FILES.meta]: meta }
	for (const name of Object.values(SPEC_DIR_FILES)) {
		if (name === SPEC_DIR_FILES.meta) continue
		try {
			files[name] = await readFile(join(dir, name), 'utf8')
		} catch (err) {
			// The optional layer files are enumerated ONCE, in the codec
			// (`OPTIONAL_SPEC_DIR_FILES`), because this list and `writeSpecDir`'s
			// have to agree and issue #187 shipped the bug where they did not.
			//
			// Getting it wrong is worse than it looks: the ENOENT escapes as the
			// "not a spec dir" signal, so `load` falls through to the legacy
			// single-file migration and the project reads as having no spec at all.
			// Every file NOT in that list is required once meta.json exists.
			if (
				OPTIONAL_SPEC_DIR_FILES.includes(name) &&
				(err as NodeJS.ErrnoException).code === 'ENOENT'
			) {
				// An absent op log is an empty one; an absent layer file is absent.
				if (name === SPEC_DIR_FILES.oplog) files[name] = ''
				continue
			}
			throw err
		}
	}
	return validateSpecSystem(decodeSpecSystem(files))
}

/** Validate + write a spec system to its directory. Each file is written via
 * write-tmp-then-rename (no torn file), and `meta.json` is written LAST so its
 * presence signals a complete directory. Assumes a single writer per project
 * (the dev server / CLI), the same assumption the whole store already makes. */
export async function writeSpecDir(
	dir: string,
	spec: SpecSystem,
): Promise<void> {
	const { mkdir, rename, writeFile } = await import('node:fs/promises')
	const { join } = await import('node:path')
	await mkdir(dir, { recursive: true })
	const files = encodeSpecSystem(validateSpecSystem(spec))
	const writeAtomic = async (name: string, contents: string) => {
		const target = join(dir, name)
		const tmp = `${target}.tmp`
		await writeFile(tmp, contents)
		await rename(tmp, target)
	}
	// Everything except meta.json first; meta.json last (the completion marker).
	for (const name of Object.values(SPEC_DIR_FILES)) {
		if (name === SPEC_DIR_FILES.meta) continue
		// An optional layer file the encoder did not emit must not be materialized
		// as an empty file, or an untouched project grows one on first load and
		// the codec's absence-means-default rule stops being true on disk. Same
		// single source of truth as the read path above, for the same reason.
		if (OPTIONAL_SPEC_DIR_FILES.includes(name) && files[name] === undefined)
			continue
		await writeAtomic(name, files[name] ?? '')
	}
	await writeAtomic(SPEC_DIR_FILES.meta, files[SPEC_DIR_FILES.meta] ?? '')
}

/**
 * A disk-backed store rooted at the spec **directory** `dir` (e.g.
 * `<project>/spec`). Node-only — the `node:fs` imports are lazy so the pure
 * helpers stay importable anywhere.
 *
 * `load` resolves in three steps:
 *   1. the spec directory at `dir`, if present (read + validate);
 *   2. otherwise the **legacy** single file at `${dir}.json` (e.g.
 *      `<project>/spec.json`): parse it, write it out as a directory, delete the
 *      old file, and return it — a one-time migration on first touch;
 *   3. otherwise seed from `opts.seed` (validated + persisted as a directory), or
 *      throw when there's no seed.
 *
 * `save` validates before writing — a broken spec never lands on disk.
 */
export function createFileSpecStore(
	dir: string,
	opts: {
		seed?: () => SpecSystem
		/**
		 * Called once when a legacy single-file `spec.json` is migrated into the
		 * `spec/` directory (the old file is deleted). Lets a caller announce the
		 * migration — it rewrites the on-disk layout, so a silent run surprises
		 * anyone who then sees it only in `git status`. `from`/`to` are absolute.
		 */
		onMigrate?: (paths: { from: string; to: string }) => void
	} = {},
): SpecStore {
	const legacyPath = `${dir}.json`
	return {
		async load() {
			try {
				return await readSpecDir(dir)
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
			}
			// No directory yet — try to migrate a legacy single-file spec.
			const { readFile, rm } = await import('node:fs/promises')
			try {
				const migrated = parseSpecSystem(await readFile(legacyPath, 'utf8'))
				await writeSpecDir(dir, migrated)
				await rm(legacyPath, { force: true })
				opts.onMigrate?.({ from: legacyPath, to: dir })
				return migrated
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
			}
			// Nothing on disk — seed it, or fail loudly.
			const seed = opts.seed?.()
			if (!seed) throw new Error(`Spec not found (and no seed): ${dir}`)
			const validated = validateSpecSystem(seed)
			await writeSpecDir(dir, validated)
			return validated
		},
		async save(next) {
			await writeSpecDir(dir, next)
		},
	}
}
