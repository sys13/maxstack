/**
 * **Reconciling a project DOWN to its spec** — the direction generation never
 * walked.
 *
 * `prunePages` (in `generate.ts`) does it for route modules; {@link pruneSeams}
 * does it for the four non-page seams — schedules, sources, imports and live
 * channels. Both make the *same* decision about every file, and that decision
 * lives here once ({@link retireGeneratedFile}) rather than twice: never-clobber
 * is the invariant the whole generator rests on, and an invariant with two
 * implementations is an invariant with two behaviours.
 */

import {
	hashContent,
	MANIFEST_FILENAME,
	parseManifest,
	type RouteManifest,
	type RouteManifestEntry,
	removeEntry,
	serializeManifest,
} from './manifest.ts'
import type { Fs } from './write.ts'

/** What pruning did about one thing the spec no longer justifies. */
export type PruneAction =
	/**
	 * It was still genuinely generated — bytes matching the hash the generator
	 * recorded — so the file was deleted along with its manifest entry and any
	 * wiring pointing at it.
	 */
	| 'deleted'
	/**
	 * Tracked `generated`, but its bytes are not the generator's any more:
	 * somebody edited it in place. The manifest entry and the wiring are dropped
	 * — the app stops running something the spec does not declare — and the
	 * **file is left on disk**.
	 */
	| 'unwired'
	/**
	 * `ejected` or `user`. Nothing was touched at all: not the file, not the
	 * manifest entry, not the wiring.
	 */
	| 'kept-owned'
	/**
	 * Route modules only. The module is still live, but the path it serves moved:
	 * its old `routes.ts` line was removed so the emitter can insert the current
	 * one. Nothing is deleted.
	 */
	| 'repathed'

export interface PruneResult {
	id: string
	file: string
	action: PruneAction
	/** One line naming why this outcome and not deletion. */
	reason: string
}

/** Load the ownership manifest, or an empty one when the project has none. */
export async function loadOwnershipManifest(fs: Fs): Promise<RouteManifest> {
	if (await fs.exists(MANIFEST_FILENAME)) {
		return parseManifest(await fs.read(MANIFEST_FILENAME))
	}
	return { version: 1, entries: [] }
}

/**
 * The ownership decision for one manifest entry the spec has stopped
 * justifying — the single table both pruners read.
 *
 * The invariant is that regeneration never deletes manual items, so what may be
 * deleted is exactly what is still the framework's:
 *
 *   - `generated` + on-disk bytes matching the recorded hash → the file is ours,
 *     byte for byte. Deleted, here, as a side effect: the caller could not make
 *     this decision without redoing it.
 *   - `generated` + bytes that have moved → those bytes are somebody's work,
 *     whatever the manifest says about who owns the file. Deleting them to
 *     enforce a spec change would be exactly the clobber the invariant forbids.
 *     The file stays and only the wiring goes — `unwired` stops the thing
 *     running without destroying anything, and the maintainer deletes it
 *     deliberately.
 *   - `ejected` / `user` → untouched entirely. The maintainer took ownership;
 *     what happens to that file is theirs to decide, and the drift report
 *     already has a name (`underived`) and a per-family sentence for the state
 *     it is now in.
 *
 * An absent hash means the manifest cannot vouch for the bytes, which is the
 * same position as bytes that have moved — treated as the user's. An absent
 * *file* is `deleted` with nothing to do, because "already gone" is the state
 * pruning wants.
 */
export async function retireGeneratedFile(
	fs: Fs,
	entry: RouteManifestEntry,
): Promise<{ action: 'deleted' | 'unwired' | 'kept-owned'; onDisk: boolean }> {
	const onDisk = await fs.exists(entry.file)
	if (entry.ownership !== 'generated') return { action: 'kept-owned', onDisk }

	const stillOurs =
		!onDisk ||
		(entry.hash !== undefined &&
			hashContent(await fs.read(entry.file)) === entry.hash)
	if (!stillOurs) return { action: 'unwired', onDisk }

	if (onDisk) await fs.remove(entry.file)
	return { action: 'deleted', onDisk }
}

// ===========================================================================
// The four non-page seams (issue #355)
// ===========================================================================

/**
 * One seam family, as pruning needs to see it.
 *
 * Built from the spec by the caller (`seamFamilies` in `@maxstack/mcp`) so the
 * live-key filters — `refine`, `format: 'custom'`, `slot` — are derived exactly
 * once and the pruner, the emitter and the drift report cannot disagree about
 * which declarations open a slot.
 */
export interface SeamFamily {
	/** The declaration, as a noun for prose: `schedule`, `source`, … */
	noun: string
	/** The write-once half, as a noun: `handler`, `refiner`, `parser`, `surface`. */
	stub: string
	/** Manifest id of the framework-owned registry (`schedules:registry`). */
	registryId: string
	/**
	 * Manifest id prefix of a write-once entry, **including** the colon
	 * (`schedule:`). The generators write these through `writeUserFileOnce`,
	 * which appends `:slot`, so the full id is `schedule:<key>:slot`.
	 */
	stubPrefix: string
	/**
	 * The keys that still declare this seam **and** still open a slot. Empty
	 * means the family emits nothing at all, which is when its registry becomes
	 * stale — see {@link pruneSeams}.
	 */
	liveKeys: readonly string[]
}

/** The declared key a write-once manifest id belongs to, or undefined. */
export function seamStubKey(
	family: SeamFamily,
	id: string,
): string | undefined {
	if (!id.startsWith(family.stubPrefix) || !id.endsWith(':slot'))
		return undefined
	return id.slice(family.stubPrefix.length, -':slot'.length)
}

/**
 * Reconcile the seam registries down to what the spec still declares — the same
 * pass `prunePages` is for route modules, over the families it deliberately did
 * not touch (#355).
 *
 * ## What was actually broken, and what was not
 *
 * Most of the unwiring already worked, by accident of how the registries are
 * emitted: `emitScheduleRegistry` &co are pure functions of the current
 * descriptors, so dropping one schedule of three re-emits a registry with two
 * entries and the third stops being registered. The hole is the **last** one.
 * Every generator opens with an absence rule — "no declaration, no directory" —
 * implemented as an early return on an empty descriptor list, and an early
 * return writes nothing, so undeclaring the final schedule left
 * `jobs/schedules.generated.ts` on disk with all of its entries, its manifest
 * entry intact, and therefore `owned.generated.tsx` still importing it and
 * `registerScheduleHandlers` still holding every retired handler.
 *
 * That is worse than #338's dead route in one specific way, and it is the reason
 * this is a separate pass rather than a nice-to-have: a stale route is inert
 * until somebody navigates to it, whereas a schedule or a source is *machinery*.
 * The scheduler ticks from the spec, so nothing new fires — but a job already
 * queued, or a retry, resolves its handler through that registry, and the work
 * on the other side of a handler reaches external systems and writes rows.
 * Unwiring is the safety-critical half here; deleting the file is bookkeeping.
 *
 * ## The write-once halves are never deleted, and that is the normal case
 *
 * A seam's whole point is that the maintainer writes the body, so
 * "generated-but-edited" — the exceptional branch for a route module — is what
 * *every* handler, refiner, parser and surface looks like. They are `user`-owned
 * and {@link retireGeneratedFile} would keep them anyway; pruning reports them
 * so an unwired handler is a line in `gen`'s output rather than a file that went
 * quiet. The one entry that is dropped is one whose file the maintainer has
 * already deleted: the manifest was tracking something that neither exists nor
 * is declared, never-clobber has nothing left to protect, and leaving it would
 * make the report repeat forever with no way to silence it.
 *
 * ## Empty registry, or no registry
 *
 * Deleted, not emitted empty. The absence rule says a project that declared no
 * schedules never had a `jobs/` directory, and reconciling *down* to the spec
 * means landing in the state the spec would have produced from scratch — an
 * empty registry is a file the generator would never have written. It is also
 * the one case where deletion is unambiguously safe: an empty registry has no
 * content anybody could have wanted.
 */
export async function pruneSeams(
	fs: Fs,
	families: readonly SeamFamily[],
): Promise<{ manifest: RouteManifest; results: PruneResult[] }> {
	let manifest = await loadOwnershipManifest(fs)
	const results: PruneResult[] = []
	let changed = false

	for (const family of families) {
		const live = new Set(family.liveKeys)

		// 1. The registry, but only once the family emits nothing at all. While one
		//    declaration survives, re-emission is the unwiring: the registry is a
		//    pure function of the live descriptors.
		if (live.size === 0) {
			const entry = manifest.entries.find((e) => e.id === family.registryId)
			if (entry) {
				const { action, onDisk } = await retireGeneratedFile(fs, entry)
				results.push({
					id: entry.id,
					file: entry.file,
					action,
					reason:
						action === 'deleted'
							? onDisk
								? `the spec declares no ${family.noun} that needs a registry, and the file was still the generator's byte for byte — nothing is registered now`
								: `the spec declares no ${family.noun} that needs a registry, and the file was already gone`
							: action === 'unwired'
								? `the spec declares no ${family.noun} that needs a registry, but the file has been edited since it was generated — the runtime stops importing it, and the file is left for you to delete`
								: `you own this registry (${entry.ownership}) — the spec declares no ${family.noun} that needs it, but nothing here is the framework's to remove. The runtime still imports it, so its entries still run until you say otherwise`,
				})
				if (action !== 'kept-owned') {
					manifest = removeEntry(manifest, entry.id)
					changed = true
				}
			}
		}

		// 2. The write-once halves. Snapshot first — the loop reassigns `manifest`.
		for (const entry of [...manifest.entries]) {
			const key = seamStubKey(family, entry.id)
			if (key === undefined || live.has(key)) continue

			if (!(await fs.exists(entry.file))) {
				manifest = removeEntry(manifest, entry.id)
				changed = true
				continue
			}
			results.push({
				id: entry.id,
				file: entry.file,
				action: 'kept-owned',
				reason: `no ${family.noun} declares "${key}" any more — the registry no longer imports this ${family.stub}, so nothing calls it. The file is yours and stays where it is`,
			})
		}
	}

	if (changed) await fs.write(MANIFEST_FILENAME, serializeManifest(manifest))
	return { manifest, results }
}
