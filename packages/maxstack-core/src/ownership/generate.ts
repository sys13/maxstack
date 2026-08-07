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
} from './emit.ts'
import {
	MANIFEST_FILENAME,
	parseManifest,
	type RouteManifest,
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
