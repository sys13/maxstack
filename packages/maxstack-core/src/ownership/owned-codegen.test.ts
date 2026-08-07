import { describe, expect, it } from 'vitest'
import type { RouteManifest } from './manifest.ts'
import { renderOwnedManifest } from './owned-codegen.ts'

const manifest: RouteManifest = {
	version: 1,
	entries: [
		{
			id: 'story',
			routePath: '/stories',
			file: 'routes/story.tsx',
			slotFile: 'routes/story.slots.tsx',
			ownership: 'generated',
		},
		{
			id: 'reading-item',
			routePath: '/reading',
			file: 'routes/reading-item.tsx',
			ownership: 'ejected',
		},
	],
}

describe('renderOwnedManifest', () => {
	it('imports slot files by resource and ejected routes by default export, relative to ./project by default', () => {
		const out = renderOwnedManifest(manifest)
		expect(out).toContain(
			"import * as slots_story from './project/routes/story.slots.tsx'",
		)
		expect(out).toContain('"story": slots_story')
		expect(out).toContain(
			"import route_reading_item from './project/routes/reading-item.tsx'",
		)
		expect(out).toContain('"reading-item": route_reading_item,')
	})

	// Issue #349. `OWNED_ROUTES` was `Record<string, ComponentType>` and the
	// runtime mounted an ejected page as `<OwnedRoute />` — with no props. That
	// is the reason the emitted page could only ever be a heading: it had no way
	// to reach the rows, columns or capabilities its own loader had produced.
	// Typing the map by what a route is *rendered with* is what makes a
	// materialized ejected page compile.
	it('types owned routes by the props they are rendered with', () => {
		const out = renderOwnedManifest(manifest)
		expect(out).toContain("import type { OwnedRouteProps } from '@maxstack/ui'")
		expect(out).toContain(
			'export const OWNED_ROUTES: Record<string, ComponentType<OwnedRouteProps>> = {',
		)
	})

	it('produces empty registries when nothing is owned', () => {
		const out = renderOwnedManifest({ version: 1, entries: [] })
		expect(out).toContain('export const OWNED_SLOTS')
		expect(out).toContain('export const OWNED_ROUTES')
		expect(out).not.toContain('./project/')
	})

	it('lands an ejected route that still carries a slotFile in BOTH registries', () => {
		// Ejecting a route does not drop its `slotFile` (the manifest keeps it),
		// so a route that had a slot and was then ejected is simultaneously an
		// owned default-export route AND a slot namespace. The emitter must emit
		// both imports and register the id in both maps — otherwise ejecting a
		// route that composed a slot silently loses one seam. (This is the
		// a dogfooded app's shape: `story` ejected, `slotFile` retained.)
		const ejectedWithSlot: RouteManifest = {
			version: 1,
			entries: [
				{
					id: 'story',
					routePath: '/stories',
					file: 'routes/story.tsx',
					slotFile: 'routes/story.slots.tsx',
					ownership: 'ejected',
				},
			],
		}
		const out = renderOwnedManifest(ejectedWithSlot)
		expect(out).toContain(
			"import * as slots_story from './project/routes/story.slots.tsx'",
		)
		expect(out).toContain(
			"import route_story from './project/routes/story.tsx'",
		)
		expect(out).toContain('"story": slots_story')
		expect(out).toContain('"story": route_story,')
	})

	it('re-exports a generated seam registry so the runtime executes it', () => {
		// The registry is framework-owned and the modules it imports are the user's
		// filled handlers/parsers. Surfacing it here is what makes a filled schedule
		// handler *run*: without it the file is on disk, `maxstack drift` reports it
		// authored, and the queue still dead-letters every occurrence.
		const withSeams: RouteManifest = {
			version: 1,
			entries: [
				{
					id: 'schedules:registry',
					routePath: '',
					file: 'jobs/schedules.generated.ts',
					ownership: 'generated',
				},
				{
					id: 'imports:registry',
					routePath: '',
					file: 'imports/imports.generated.ts',
					ownership: 'generated',
				},
			],
		}
		const out = renderOwnedManifest(withSeams)
		expect(out).toContain(
			"import { scheduleHandlers as registry_schedules_registry } from './project/jobs/schedules.generated.ts'",
		)
		expect(out).toContain(
			'export const OWNED_SCHEDULE_HANDLERS: Record<string, ScheduleHandler> = registry_schedules_registry',
		)
		expect(out).toContain(
			'export const OWNED_IMPORT_PARSERS: Record<string, ImportParser> = registry_imports_registry',
		)
		// The two seams this project declared nothing for stay empty rather than
		// importing a registry no generator wrote — the generators' absence rule.
		expect(out).toContain(
			'export const OWNED_SOURCE_REFINERS: Record<string, SourceRefiner> = {}',
		)
		expect(out).toContain(
			'export const OWNED_LIVE_SURFACES: Record<string, ComponentType<never>> = {}',
		)
	})

	it('never imports an ejected seam registry as a route default export', () => {
		// An ejected entry is imported for its default export — a page component.
		// A seam registry has named exports and no default, so treating one as an
		// ejected route emits an import that cannot resolve, and the project that
		// ejected it stops building. It is still re-exported as the registry.
		const ejectedRegistry: RouteManifest = {
			version: 1,
			entries: [
				{
					id: 'schedules:registry',
					routePath: '',
					file: 'jobs/schedules.generated.ts',
					ownership: 'ejected',
				},
			],
		}
		const out = renderOwnedManifest(ejectedRegistry)
		expect(out).not.toContain('import route_')
		expect(out).toContain(
			'export const OWNED_SCHEDULE_HANDLERS: Record<string, ScheduleHandler> = registry_schedules_registry',
		)
	})

	it('annotates every seam registry even when the project declared none', () => {
		// The module's shape must not depend on what the spec happens to contain:
		// the runtime imports these four names unconditionally.
		const out = renderOwnedManifest({ version: 1, entries: [] })
		for (const name of [
			'OWNED_SCHEDULE_HANDLERS',
			'OWNED_SOURCE_REFINERS',
			'OWNED_IMPORT_PARSERS',
			'OWNED_LIVE_SURFACES',
		]) {
			expect(out).toContain(`export const ${name}: Record<string,`)
		}
		expect(out).not.toContain('.generated.ts')
	})

	it('honors a custom importBase (dev: the project app dir, un-mirrored)', () => {
		const out = renderOwnedManifest(manifest, {
			importBase: '/Users/me/myproject/app',
		})
		expect(out).toContain(
			"import * as slots_story from '/Users/me/myproject/app/routes/story.slots.tsx'",
		)
		expect(out).toContain(
			"import route_reading_item from '/Users/me/myproject/app/routes/reading-item.tsx'",
		)
		expect(out).not.toContain('./project/')
	})
})
