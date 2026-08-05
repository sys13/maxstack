/**
 * The ownership manifest — `.generated.routes.json`.
 *
 * A durable record of who owns each file the generator touches. It is the data
 * behind the never-clobber invariant: the writer consults the manifest before
 * every write and refuses to overwrite anything the manifest marks `ejected`
 * or `user`. Regeneration re-derives only `generated` files.
 *
 * Lineage: `.generated.routes.json` from mx_1/saaskit-one-ejectable (decision
 * `d-lift-eject` in the project's lineage record is the reference). Reimplemented here — the
 * original stored a flat string[] of generated paths; this carries per-entry
 * ownership + a content hash so regeneration-as-diff (bet B) can tell a stale
 * generated file from a hand-touched one.
 */

/** How the framework is allowed to treat a file on disk. */
export type Ownership =
	/** Emitted by a generator; regeneration may overwrite it. */
	| 'generated'
	/** Copied out with `eject`; the user owns it whole — never overwrite. */
	| 'ejected'
	/** Authored by the user (e.g. a slot file); the generator only stubs it once. */
	| 'user'

export interface RouteManifestEntry {
	/** Stable id — the resource name the route was generated for. */
	id: string
	/** The app route path, e.g. `/admin/tasks`. */
	routePath: string
	/** Repo-relative path of the route module. */
	file: string
	ownership: Ownership
	/**
	 * Repo-relative path of the user-owned slot file this route composes from,
	 * if any. Always `user`-owned; the generator writes it once as a stub and
	 * never again (never-clobber).
	 */
	slotFile?: string
	/**
	 * Hash of the generated content the last time the framework emitted `file`.
	 * Present only for `generated`/`ejected` entries. Lets regeneration detect
	 * whether an on-disk file still matches what the generator produced (drift).
	 */
	hash?: string
	/**
	 * The block-slot role vocabulary this file was authored against
	 * (`BLOCK_SLOT_ROLES_VERSION` at fill time). Recorded on a `user` slot file
	 * when a block slot is filled into it, and on nothing else.
	 *
	 * A `user` file is never re-derived, so byte comparison can say nothing about
	 * it. This is the one thing about it that *can* move underneath
	 * the maintainer without touching their bytes: the props a role's slot is
	 * called with are part of a versioned public API, and a file authored against
	 * v1 while the platform is on v2 is a fact the drift report should state
	 * rather than a silence it should keep. Absent means "authored before the
	 * version was recorded" — treated as no information, never as v0.
	 */
	rolesVersion?: number
}

export interface RouteManifest {
	version: 1
	entries: RouteManifestEntry[]
	/**
	 * How much of the spec's op log the last generation run consumed — the length
	 * of `spec.opLog` at the moment `maxstack gen` finished.
	 *
	 * This is the one fact on disk that answers "has anything been generated from
	 * that decision yet?", which the spec cannot answer about itself: the spec
	 * records what was applied, never what was *derived* from it. The undo offer
	 * in the review surfaces is only honest while the answer is no.
	 *
	 * A **count**, deliberately, not a timestamp and not an op id. The op log is
	 * append-only (`assertAppendOnly` guards it), so a prefix length is a total
	 * order that survives clock skew, same-day `appliedAt` granularity — the CLI
	 * stamps dates, not instants — and ids being rewritten by a codec round trip.
	 *
	 * Absent means "no generation has been recorded", which is the state of every
	 * manifest written before this field existed. Treated as "nothing generated"
	 * rather than "unknown": a manifest that predates the field also predates any
	 * of the seams that consume it, and refusing every undo on old projects would
	 * be a worse lie than the one being fixed.
	 */
	generatedFromOpCount?: number
}

export const MANIFEST_FILENAME = '.generated.routes.json'

export function emptyManifest(): RouteManifest {
	return { version: 1, entries: [] }
}

/**
 * A stable, dependency-free content hash (FNV-1a, 32-bit, hex). Not
 * cryptographic — it only needs to detect that a file's bytes changed, and it
 * must be deterministic so a byte-identical regeneration hashes identically.
 */
export function hashContent(content: string): string {
	let h = 0x811c9dc5
	for (let i = 0; i < content.length; i++) {
		h ^= content.charCodeAt(i)
		// h *= 16777619, kept in 32-bit unsigned via Math.imul.
		h = Math.imul(h, 0x01000193)
	}
	return (h >>> 0).toString(16).padStart(8, '0')
}

export function findEntry(
	manifest: RouteManifest,
	id: string,
): RouteManifestEntry | undefined {
	return manifest.entries.find((e) => e.id === id)
}

/**
 * Insert or replace an entry (matched by `id`), returning a new manifest. The
 * manifest is treated as immutable — callers persist the returned value.
 */
export function upsertEntry(
	manifest: RouteManifest,
	entry: RouteManifestEntry,
): RouteManifest {
	const entries = manifest.entries.filter((e) => e.id !== entry.id)
	entries.push(entry)
	entries.sort((a, b) => a.id.localeCompare(b.id))
	return { ...manifest, entries }
}

/**
 * Stamp the generation watermark — how much of the op log this run
 * generated from. Immutable like {@link upsertEntry}; the caller persists it.
 *
 * Monotonic by construction: a run that somehow saw a shorter log than the last
 * one leaves the recorded count alone. The watermark answers "has anything been
 * generated from op N yet", and the answer never goes back to no.
 */
export function recordGeneration(
	manifest: RouteManifest,
	opCount: number,
): RouteManifest {
	return {
		...manifest,
		generatedFromOpCount: Math.max(manifest.generatedFromOpCount ?? 0, opCount),
	}
}

/** The recorded watermark, or null when no generation has been recorded. */
export function generationWatermark(manifest: RouteManifest): number | null {
	return manifest.generatedFromOpCount ?? null
}

export function serializeManifest(manifest: RouteManifest): string {
	return `${JSON.stringify(manifest, null, '\t')}\n`
}

export function parseManifest(raw: string): RouteManifest {
	const parsed = JSON.parse(raw) as RouteManifest
	if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
		throw new Error('Malformed route manifest')
	}
	return parsed
}
