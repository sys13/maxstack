/**
 * The page generator — orchestrates emit + never-clobber write + manifest +
 * route-manifest AST insertion into one call. This is the "small target" the
 * Phase 2 bake-off runs on: declare a resource
 * page with a slot, generate it, and get back a project where the route module
 * is framework-owned, the slot file is user-owned, and the routes manifest was
 * edited through the AST.
 */

import {
	BLOCK_SLOT_ROLES_VERSION,
	type BlockSlotDescriptor,
	blockSlotPropsImport,
	emitBlockSlotStub,
} from './block-slots.ts'
import {
	addRouteToManifest,
	EMPTY_ROUTES_MANIFEST,
	emitMissingSlotStubs,
	emitResourcePage,
	emitUserSlotStub,
	exportedSlotNames,
	type PageDescriptor,
	pageModuleKey,
	removeRoutesToModule,
} from './emit.ts'
import {
	hashContent,
	isRouteModuleEntry,
	MANIFEST_FILENAME,
	parseManifest,
	type RouteManifest,
	removeEntry,
	serializeManifest,
	upsertEntry,
} from './manifest.ts'
import type { Fs, WriteResult } from './write.ts'
import { writeGenerated, writeUserFileOnce } from './write.ts'

export interface GenerateResult {
	manifest: RouteManifest
	results: WriteResult[]
}

/** Where a resource's files live, relative to the project root. */
export function pageFilePaths(resource: string): {
	routeFile: string
	slotFile: string
	routesManifest: string
} {
	return {
		routeFile: `routes/${resource}.tsx`,
		slotFile: `routes/${resource}.slots.tsx`,
		routesManifest: 'routes.ts',
	}
}

async function loadManifest(fs: Fs): Promise<RouteManifest> {
	if (await fs.exists(MANIFEST_FILENAME)) {
		return parseManifest(await fs.read(MANIFEST_FILENAME))
	}
	return { version: 1, entries: [] }
}

async function loadRoutesManifest(fs: Fs): Promise<string> {
	const paths = pageFilePaths('_')
	if (await fs.exists(paths.routesManifest)) {
		return fs.read(paths.routesManifest)
	}
	return EMPTY_ROUTES_MANIFEST
}

/**
 * Scaffold the user-owned slot stub, append-only. Absent file → create it with
 * every declared slot's render stub (the first-generation seed). Present file →
 * **append** a stub for each declared slot not already exported, and touch
 * nothing that's there — so a slot added to a live page (via `page.addBlock`)
 * gets its `render={slots.X}` counterpart scaffolded instead of dangling
 * (task-9 gap), while every existing user edit is preserved byte-for-byte.
 *
 * This is an **authoring** action (the user declared a new slot), distinct from
 * framework regeneration: it only ever *adds* a symbol, never rewrites one, so
 * it does not violate never-clobber. Idempotent — a second call with the same
 * slots is a no-op (`unchanged`), which keeps it safe to call on every regen.
 */
export async function syncUserSlotStub(
	fs: Fs,
	manifest: RouteManifest,
	id: string,
	file: string,
	descriptor: PageDescriptor,
): Promise<{ manifest: RouteManifest; result: WriteResult; added: string[] }> {
	const tracked = manifest.entries.find((e) => e.file === file)
	const existsOnDisk = await fs.exists(file)

	// First generation: seed the file with all slots (never-clobber-once).
	if (!existsOnDisk && !tracked) {
		const seeded = await writeUserFileOnce(
			fs,
			manifest,
			id,
			file,
			emitUserSlotStub(descriptor),
		)
		return { ...seeded, added: descriptor.slots }
	}

	// Existing user file: append stubs for any newly-declared slots only.
	const current = existsOnDisk ? await fs.read(file) : ''
	const { stubs, added } = emitMissingSlotStubs(current, descriptor)
	if (added.length === 0) {
		return {
			manifest,
			result: { file, action: 'unchanged', ownership: 'user' },
			added,
		}
	}
	const separator = current.length > 0 && !current.endsWith('\n\n') ? '\n' : ''
	await fs.write(file, `${current}${separator}${stubs}`)
	const next = tracked
		? manifest
		: upsertEntry(manifest, {
				id: `${id}:slot`,
				routePath: '',
				file,
				ownership: 'user',
			})
	return {
		manifest: next,
		result: { file, action: 'appended', ownership: 'user' },
		added,
	}
}

/**
 * Record a resource's slot file as user-owned, and point its route entry at it.
 *
 * Two entries, two jobs. The `<resource>:slot` entry is what stops the writer
 * from ever clobbering the file; the route entry's `slotFile` is what
 * `renderOwnedManifest` keys `OWNED_SLOTS` off, and therefore what decides
 * whether a filled slot *executes*. Miss the second and the failure is silent
 * in the worst way: the code is on disk, `maxstack slots` reports it filled,
 * and the app still renders the generated block.
 *
 * It also stamps the slot entry with {@link BLOCK_SLOT_ROLES_VERSION} — the role
 * vocabulary this fill was written against. Nothing reads it at write time; it
 * exists so the drift report can say "authored against v1, the platform is on
 * v2" about a file it can never diff.
 */
function registerSlotFile(
	manifest: RouteManifest,
	resource: string,
	file: string,
): RouteManifest {
	let next = manifest
	const tracked = next.entries.find((e) => e.file === file)
	if (!tracked) {
		next = upsertEntry(next, {
			id: `${resource}:slot`,
			routePath: '',
			file,
			ownership: 'user',
			rolesVersion: BLOCK_SLOT_ROLES_VERSION,
		})
	} else if (tracked.rolesVersion !== BLOCK_SLOT_ROLES_VERSION) {
		// The file already existed (seeded as a page-slot stub, or filled under an
		// older vocabulary) and is now being filled under the current one. Stamping
		// it here is what makes the version the report quotes the version the code
		// in the file was actually written against.
		next = upsertEntry(next, {
			...tracked,
			rolesVersion: BLOCK_SLOT_ROLES_VERSION,
		})
	}
	const route = next.entries.find(
		(e) => e.file === pageFilePaths(resource).routeFile,
	)
	if (route && route.slotFile !== file) {
		next = upsertEntry(next, { ...route, slotFile: file })
	}
	return next
}

/**
 * Fill a **block-level slot** — append its typed stub to the
 * resource's user-owned slot file and register that file as owned.
 *
 * Unlike a declared `slot:<name>` block, a block slot is never scaffolded by
 * regeneration: the id exists whether or not anyone writes into it, so
 * seeding stubs for every role on every resource would bloat every project's
 * slot file with placeholders nobody asked for. This is the *authoring* action
 * that materializes one — `maxstack slots fill <id>`.
 *
 * Strictly additive, like {@link syncUserSlotStub}: an already-exported id is a
 * no-op (so re-running never overwrites an implementation), and the props
 * `import type` line is prepended only when the file does not already have one.
 * Nothing existing is ever rewritten.
 */
export async function fillBlockSlot(
	fs: Fs,
	manifest: RouteManifest,
	resource: string,
	slot: BlockSlotDescriptor,
): Promise<{ manifest: RouteManifest; result: WriteResult; added: boolean }> {
	const file = pageFilePaths(resource).slotFile
	const existsOnDisk = await fs.exists(file)
	const current = existsOnDisk ? await fs.read(file) : ''

	if (exportedSlotNames(current).includes(slot.id)) {
		// Already implemented — write nothing, but still make sure the manifest
		// knows about the file. Writing the export by hand is a documented path,
		// and an unregistered slot file is not imported by the owned-code manifest:
		// the code exists, `maxstack slots` reports it filled, and the app renders
		// the generated block anyway. Running `slots fill` is then the obvious
		// thing to reach for, so it has to be the thing that repairs it.
		return {
			manifest: registerSlotFile(manifest, resource, file),
			result: { file, action: 'unchanged', ownership: 'user' },
			added: false,
		}
	}

	const importLine = blockSlotPropsImport([slot])
	const needsImport = !new RegExp(
		`import type \\{[^}]*\\b${slot.props}\\b[^}]*\\} from '@maxstack/ui'`,
	).test(current)
	const head = needsImport ? `${importLine}\n\n` : ''
	const separator = current.length > 0 && !current.endsWith('\n\n') ? '\n' : ''
	await fs.write(
		file,
		`${head}${current}${separator}${emitBlockSlotStub(slot)}\n`,
	)

	return {
		manifest: registerSlotFile(manifest, resource, file),
		result: {
			file,
			action: existsOnDisk ? 'appended' : 'created',
			ownership: 'user',
		},
		added: true,
	}
}

/**
 * Generate (or regenerate) a resource page into `fs`. Idempotent: the route
 * module is rewritten only when its content changed, the slot stub is written
 * once and never again, and the route is inserted into `routes.ts` only if
 * absent. Persists the ownership manifest and the routes manifest.
 */
export async function generateResourcePage(
	fs: Fs,
	descriptor: PageDescriptor,
): Promise<GenerateResult> {
	// Two keys, deliberately. The route module is the *page's* — a spec with two
	// pages over one entity used to emit both into one file and overwrite it on
	// every run (#337). The slot file stays the *resource's*: block slots are
	// derived from the entity, `maxstack slots` looks them up by resource, and
	// splitting them per page would strand a fill the moment a second page
	// appeared.
	const paths = {
		...pageFilePaths(pageModuleKey(descriptor)),
		slotFile: pageFilePaths(descriptor.resource).slotFile,
	}
	let manifest = await loadManifest(fs)
	const results: WriteResult[] = []

	// 1. The framework-owned route module (never-clobber-aware).
	//
	//    The slot file is registered when the page declares slots OR when one is
	//    already on disk. The second case is issue #178's: a resource with no
	//    declared `slot:` block can still have a *block* slot filled, and if
	//    regeneration then dropped `slotFile` the owned-code manifest would stop
	//    importing the file and the fill would silently stop rendering.
	const hasSlotFile =
		descriptor.slots.length > 0 || (await fs.exists(paths.slotFile))
	const routeContent = emitResourcePage(descriptor)
	const routeWrite = await writeGenerated(
		fs,
		manifest,
		{
			id: pageModuleKey(descriptor),
			routePath: descriptor.routePath,
			file: paths.routeFile,
			slotFile: hasSlotFile ? paths.slotFile : undefined,
		},
		routeContent,
	)
	manifest = routeWrite.manifest
	results.push(routeWrite.result)

	// 2. The user-owned slot stub — seeded once, then append-only: a slot added
	//    to a live page gets its render stub scaffolded, existing edits untouched.
	if (descriptor.slots.length > 0) {
		const slotWrite = await syncUserSlotStub(
			fs,
			manifest,
			descriptor.resource,
			paths.slotFile,
			descriptor,
		)
		manifest = slotWrite.manifest
		results.push(slotWrite.result)
	}

	// 3. Insert the route via ts-morph (replaces the string `.replace()` splice).
	const routesSource = await loadRoutesManifest(fs)
	const nextRoutes = addRouteToManifest(routesSource, {
		path: descriptor.routePath,
		file: `./${paths.routeFile}`,
	})
	if (nextRoutes !== routesSource) {
		await fs.write(paths.routesManifest, nextRoutes)
	}

	await fs.write(MANIFEST_FILENAME, serializeManifest(manifest))
	return { manifest, results }
}

// ===========================================================================
// Pruning — the direction generation never walked (issue #338)
// ===========================================================================

/** What pruning did about one stale route module. */
export type PruneAction =
	/**
	 * The module was still genuinely generated — banner intact, bytes matching
	 * the hash the generator recorded — so the file was deleted along with its
	 * manifest entry and its `routes.ts` line.
	 */
	| 'deleted'
	/**
	 * The module is tracked `generated` but its bytes are not the generator's any
	 * more: somebody edited it in place. The route and the manifest entry are
	 * dropped — the app stops serving a page the spec does not declare — and the
	 * **file is left on disk**.
	 */
	| 'unwired'
	/**
	 * The module is `ejected` or `user`. Nothing was touched at all: not the
	 * file, not the manifest entry, not the route.
	 */
	| 'kept-owned'
	/**
	 * The module is still live, but the path it serves moved: its old
	 * `routes.ts` line was removed so the emitter can insert the current one.
	 * The file is regenerated as usual; nothing is deleted.
	 */
	| 'repathed'

export interface PruneResult {
	id: string
	file: string
	action: PruneAction
	/** One line naming why this outcome and not deletion. */
	reason: string
}

/**
 * Reconcile a project's route modules **down** to the pages the spec still
 * declares: the step `maxstack gen` never had.
 *
 * Generation was add-and-overwrite only. Nothing ever read the manifest and
 * asked which of its entries the spec still justifies, so deleting an entity
 * left its route module on disk, its line in `routes.ts` and its entry in
 * `.generated.routes.json` — a route that 500s on a resource the app no longer
 * has, reachable, linked from nothing, and unremovable except by hand (#338).
 * The spec is meant to be the source of truth for the app tree, and for removals
 * it simply was not: the tree only grew.
 *
 * ## Run this BEFORE emitting, not after
 *
 * The stale set is computed from the descriptors, which are known before a byte
 * is written, and pruning first is what makes the module-inheritance case work.
 * Delete the first of two pages over one entity and the survivor inherits the
 * bare `routes/<resource>.tsx` it did not previously own (#337's disambiguation
 * is positional). Prune first and its `routes.ts` line — still pointing at the
 * retired sibling's module — is gone before `addRouteToManifest` runs, so the
 * path is re-inserted against the module that now serves it. Prune afterwards
 * and the insert would be a no-op (that path is "already present"), leaving the
 * route wired to a module that had just been deleted.
 *
 * ## Never-clobber decides every case
 *
 * The invariant is that regeneration never deletes manual items, so what may be
 * deleted is exactly what is still the framework's:
 *
 *   - `generated` + on-disk bytes matching the recorded hash → the file is ours,
 *     byte for byte, and we delete it. This is the ordinary case and the one the
 *     issue is about.
 *   - `generated` + bytes that have moved → those bytes are somebody's work,
 *     whatever the manifest says about who owns the file. Deleting them to
 *     enforce a spec change would be exactly the clobber the invariant forbids,
 *     and the edit is evidence of intent that a manifest field cannot outrank.
 *     So the file **stays** and only the wiring goes. That is the honest split:
 *     unwiring stops the 500 (the actual defect) without destroying anything,
 *     and an inert `.tsx` nobody imports costs the maintainer a deletion they
 *     can make deliberately. Reported, so it is not silent.
 *   - `ejected` / `user` → untouched entirely, including the route. The
 *     maintainer took ownership of that module; unwiring it would delete a route
 *     from their app, which is a product decision that is theirs. The drift
 *     report already has a name for this state (`underived`) and a sentence for
 *     it — "the page this was generated for is no longer in the spec … the file
 *     is still yours and still runs" — so the manifest entry stays too, or that
 *     report would go blind the moment pruning shipped.
 *
 * The user-owned `routes/<resource>.slots.tsx` beside a pruned module is never
 * deleted and never unregistered, for the plainest reason available: it is hand
 * written code, it is `user`-owned, and it is keyed by the **resource**, not by
 * the module — a sibling page over the same entity may still be composing from
 * it. When nothing is, `validate`'s existing orphaned-slot gate already fails
 * and names the two ways out (restore the page, or delete the export). A prune
 * that deleted fills would be answering that question on the maintainer's
 * behalf, in the destructive direction, from a spec edit that never mentioned
 * them.
 *
 * ## A live module whose path moved is the same defect
 *
 * `addRouteToManifest` is keyed by route *path*, so a module that starts serving
 * a different path gains a line and keeps the old one. That is not a corner
 * case bolted on here — it is how the inheritance case above actually presents.
 * Delete the first of two pages over an entity and the survivor inherits the
 * bare module while keeping its own path, which leaves `/books` (the deleted
 * page's path) wired to a module now rendering the shelf: a route the spec does
 * not declare, serving the wrong page, from a deletion the maintainer did make.
 * So a live entry whose recorded `routePath` is not the one the spec gives it
 * now has its old line removed too, and the emitter inserts the current one a
 * moment later. Nothing is deleted and nothing is unwired — the module is fine;
 * only the table pointing at it was stale. (It fixes the plain rename for the
 * same reason, which is the same bug with fewer steps.)
 */
export async function prunePages(
	fs: Fs,
	/** Module key → the route path the spec gives that module right now. */
	liveModules: ReadonlyMap<string, string>,
): Promise<{ manifest: RouteManifest; results: PruneResult[] }> {
	let manifest = await loadManifest(fs)
	const routeEntries = manifest.entries.filter(isRouteModuleEntry)
	const stale = routeEntries.filter((entry) => !liveModules.has(entry.id))
	const repathed = routeEntries.filter((entry) => {
		const path = liveModules.get(entry.id)
		return path !== undefined && path !== entry.routePath
	})
	if (stale.length === 0 && repathed.length === 0) {
		return { manifest, results: [] }
	}

	const routesPath = pageFilePaths('_').routesManifest
	const routesBefore = await loadRoutesManifest(fs)
	let routes = routesBefore
	const results: PruneResult[] = []

	for (const entry of repathed) {
		const path = liveModules.get(entry.id) ?? entry.routePath
		routes = removeRoutesToModule(routes, `./${entry.file}`)
		// The manifest is corrected here rather than left to the emitter: an
		// unchanged file regenerates as `unchanged` and never upserts its entry, so
		// a module whose page moved path without changing a byte of its content
		// would otherwise keep the old path recorded forever — and the next run
		// would report it repathed all over again.
		manifest = upsertEntry(manifest, { ...entry, routePath: path })
		results.push({
			id: entry.id,
			file: entry.file,
			action: 'repathed',
			reason: `the spec now serves this module at ${path}, not ${entry.routePath} — the old route table line is gone`,
		})
	}

	for (const entry of stale) {
		if (entry.ownership !== 'generated') {
			results.push({
				id: entry.id,
				file: entry.file,
				action: 'kept-owned',
				reason: `you own this module (${entry.ownership}) — the page it came from is gone from the spec, but nothing here is the framework's to remove`,
			})
			continue
		}

		const onDisk = await fs.exists(entry.file)
		// An absent hash means the manifest cannot vouch for the bytes, which is
		// the same position as bytes that have moved — treat it as the user's.
		const stillOurs =
			!onDisk ||
			(entry.hash !== undefined &&
				hashContent(await fs.read(entry.file)) === entry.hash)

		if (stillOurs) {
			if (onDisk) await fs.remove(entry.file)
			results.push({
				id: entry.id,
				file: entry.file,
				action: 'deleted',
				reason: onDisk
					? "no page in the spec declares this route any more, and the file was still the generator's byte for byte"
					: 'no page in the spec declares this route any more, and the file was already gone',
			})
		} else {
			results.push({
				id: entry.id,
				file: entry.file,
				action: 'unwired',
				reason:
					'no page in the spec declares this route any more, but the file has been edited since it was generated — the route and the manifest entry are gone, the file is left for you to delete',
			})
		}

		routes = removeRoutesToModule(routes, `./${entry.file}`)
		manifest = removeEntry(manifest, entry.id)
	}

	if (routes !== routesBefore) await fs.write(routesPath, routes)
	await fs.write(MANIFEST_FILENAME, serializeManifest(manifest))
	return { manifest, results }
}
