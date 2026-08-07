/**
 * Render the owned-code manifest module (`owned.generated.tsx`) — the Bar 2
 * seam that lets a deployed/dev bundle *execute* a project's owned slot and
 * ejected-route modules instead of merely listing their names.
 *
 * Two callers share this exact function (no forked logic):
 *
 *   - `maxstack build`/`deploy` (`vendorRuntime` in the CLI's `build.ts`) write
 *     the result to `<vendored-runtime>/apps/web/app/owned.generated.tsx`,
 *     importing from the mirrored `./project/` tree (the default `importBase`).
 *   - `maxstack dev` (a vite plugin in `apps/web/vite-owned-slots-plugin.ts`)
 *     generates the same module as an in-memory virtual module, importing
 *     directly from the project's real (un-mirrored) app dir by passing an
 *     absolute `importBase`.
 *
 * ## The non-page seams reach the runtime the same way
 *
 * A schedule handler, a source refiner, an import parser and a bespoke live
 * surface are owned code with exactly the Bar 2 problem: the file is on disk and
 * the runtime never imports it. Each of those seams already generates a
 * *framework-owned registry* next to the stubs, so the work here is not another
 * scan of the tree — it is re-exporting the registry the generator wrote, under
 * a name the runtime imports unconditionally. A project that declared none of
 * them gets the same empty object the committed stub carries.
 */

import type { RouteManifest } from './manifest.ts'

/** A JS identifier-safe alias for a resource id (`reading-item` → `reading_item`). */
function alias(id: string): string {
	return id.replace(/[^A-Za-z0-9_$]/g, '_')
}

export interface RenderOwnedManifestOptions {
	/**
	 * Import specifier prefix for owned modules, joined with each entry's
	 * repo-relative `slotFile`/`file` path. Defaults to `./project` — the
	 * vendored build's mirrored tree. Dev passes an absolute path to the
	 * project's actual app dir instead (no mirror exists there).
	 */
	importBase?: string
}

/**
 * One non-page seam's generated registry, and the name the runtime reads it by.
 *
 * Keyed off the manifest entry id the generator records the registry under
 * (`schedules:registry` &co) rather than off a hard-coded path, so a registry a
 * maintainer ejected and moved is still the one that gets imported.
 */
interface SeamRegistry {
	/** The manifest entry id its generator writes the registry under. */
	entryId: string
	/** The named export the generated registry module carries. */
	binding: string
	/** What this module re-exports it as. */
	exportName: string
	/** The type to import for the annotation below. */
	typeName: string
	/** Where {@link typeName} is imported from. */
	typeModule: string
	/** The registry's value type, as written in the emitted annotation. */
	valueType: string
}

/**
 * Every seam whose registry the runtime executes. The absence of one is not an
 * error: a project that declared no schedules has no `schedules:registry` entry
 * because the generator emits nothing for it, and the empty object below is the
 * honest answer rather than a missing import.
 */
const SEAM_REGISTRIES: readonly SeamRegistry[] = [
	{
		entryId: 'schedules:registry',
		binding: 'scheduleHandlers',
		exportName: 'OWNED_SCHEDULE_HANDLERS',
		typeName: 'ScheduleHandler',
		typeModule: '@maxstack/features/jobs',
		valueType: 'ScheduleHandler',
	},
	{
		entryId: 'sources:registry',
		binding: 'sourceRefiners',
		exportName: 'OWNED_SOURCE_REFINERS',
		typeName: 'SourceRefiner',
		typeModule: '@maxstack/features/sources',
		valueType: 'SourceRefiner',
	},
	{
		entryId: 'imports:registry',
		binding: 'importParsers',
		exportName: 'OWNED_IMPORT_PARSERS',
		typeName: 'ImportParser',
		typeModule: '@maxstack/core',
		valueType: 'ImportParser',
	},
	{
		entryId: 'live:registry',
		binding: 'liveSurfaces',
		exportName: 'OWNED_LIVE_SURFACES',
		typeName: 'ComponentType',
		typeModule: 'react',
		valueType: 'ComponentType<never>',
	},
]

/**
 * Slot files (any entry with a `slotFile`) become a namespace import keyed by
 * resource; `ejected` route modules become a default import. With no owned
 * modules this is the same empty stub the committed default carries — a
 * project that ejected nothing still builds.
 */
export function renderOwnedManifest(
	manifest: RouteManifest,
	opts: RenderOwnedManifestOptions = {},
): string {
	const importBase = opts.importBase ?? './project'
	const slots = manifest.entries.filter((e) => e.slotFile)
	// An *ejected* entry is imported for its default export, which is a page
	// component — a seam registry has named exports and no default, so ejecting
	// one would otherwise emit an import that cannot resolve and break the build
	// of the project that ejected it. It is still re-exported below, from the
	// same path, because ejecting a registry does not stop it being the registry.
	const routes = manifest.entries.filter(
		(e) =>
			e.ownership === 'ejected' &&
			!SEAM_REGISTRIES.some((s) => s.entryId === e.id),
	)

	// `OwnedRouteProps` is what an ejected page is *rendered with* — the rows,
	// introspection and capabilities its loader produced. Before #349 this map
	// was `Record<string, ComponentType>` and the runtime mounted an owned route
	// with no props at all, which is why the emitted page could only ever be a
	// heading: it had no way to reach the data it was supposed to be rendering.
	const imports: string[] = [
		"import type { OwnedRouteProps } from '@maxstack/ui'",
		"import type { ComponentType } from 'react'",
	]
	// A seam type is imported whether or not the project declared that seam: the
	// empty registry is annotated too, so the module's shape does not depend on
	// what the spec happens to contain.
	for (const seam of SEAM_REGISTRIES) {
		if (seam.typeModule === 'react') continue
		imports.push(`import type { ${seam.typeName} } from '${seam.typeModule}'`)
	}
	const slotEntries: string[] = []
	for (const e of slots) {
		const a = alias(e.id)
		imports.push(`import * as slots_${a} from '${importBase}/${e.slotFile}'`)
		slotEntries.push(
			`\t${JSON.stringify(e.id)}: slots_${a} as unknown as Record<string, ComponentType>,`,
		)
	}
	const routeEntries: string[] = []
	for (const e of routes) {
		const a = alias(e.id)
		imports.push(`import route_${a} from '${importBase}/${e.file}'`)
		routeEntries.push(`\t${JSON.stringify(e.id)}: route_${a},`)
	}

	// The non-page seams: re-export the registry each generator wrote, or the
	// empty object when the project declared nothing that emits one.
	const seamExports: string[] = []
	for (const seam of SEAM_REGISTRIES) {
		const entry = manifest.entries.find((e) => e.id === seam.entryId)
		const type = `Record<string, ${seam.valueType}>`
		if (!entry) {
			seamExports.push('', `export const ${seam.exportName}: ${type} = {}`)
			continue
		}
		const local = `registry_${alias(seam.entryId)}`
		imports.push(
			`import { ${seam.binding} as ${local} } from '${importBase}/${entry.file}'`,
		)
		seamExports.push('', `export const ${seam.exportName}: ${type} = ${local}`)
	}

	return `${[
		'// AUTO-GENERATED — DO NOT EDIT (regenerated on every build/dev boot).',
		...imports,
		'',
		'export const OWNED_SLOTS: Record<string, Record<string, ComponentType>> = {',
		...slotEntries,
		'}',
		'',
		'export const OWNED_ROUTES: Record<string, ComponentType<OwnedRouteProps>> = {',
		...routeEntries,
		'}',
		...seamExports,
	].join('\n')}\n`
}
