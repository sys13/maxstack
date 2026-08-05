import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { MANIFEST_FILENAME, serializeManifest } from '@maxstack/core/ownership'
import type { Plugin } from 'vite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ownedSlotDevPlugin } from './vite-owned-slots-plugin.ts'

// `resolveId`/`load` hooks are plain (async) functions on the returned Plugin
// object. `resolveId` uses `this.resolve` for the bare-specifier re-anchoring
// case, so calls that exercise that path need a minimal Rollup-plugin-context
// stand-in; calls that don't (e.g. the `~/owned.generated` interception) can
// omit it.
function call(hook: unknown, thisArg: unknown, ...args: unknown[]): unknown {
	return (hook as (...a: unknown[]) => unknown).apply(thisArg, args)
}

describe('ownedSlotDevPlugin', () => {
	let projectAppDir: string

	beforeEach(async () => {
		projectAppDir = await mkdtemp(join(tmpdir(), 'maxstack-owned-slot-'))
	})

	afterEach(async () => {
		delete process.env.MAXSTACK_PROJECT_APP_DIR
		await rm(projectAppDir, { recursive: true, force: true })
	})

	it('is inert (no resolveId/load hooks) when MAXSTACK_PROJECT_APP_DIR is unset', () => {
		delete process.env.MAXSTACK_PROJECT_APP_DIR
		const plugin = ownedSlotDevPlugin() as Plugin
		expect(plugin.resolveId).toBeUndefined()
		expect(plugin.load).toBeUndefined()
	})

	it('intercepts ~/owned.generated and regenerates it from the project manifest', async () => {
		process.env.MAXSTACK_PROJECT_APP_DIR = projectAppDir
		await writeFile(
			resolve(projectAppDir, MANIFEST_FILENAME),
			serializeManifest({
				version: 1,
				entries: [
					{
						id: 'story',
						routePath: '/stories',
						file: 'routes/story.tsx',
						slotFile: 'routes/story.slots.tsx',
						ownership: 'generated',
					},
				],
			}),
		)

		const plugin = ownedSlotDevPlugin() as Plugin
		const resolved = await call(plugin.resolveId, null, '~/owned.generated')
		expect(typeof resolved).toBe('string')

		// The virtual module's code is stripped to plain JS (no TS-only syntax
		// like `import type`/`as unknown as`) — a `\0`-prefixed virtual id
		// skips Vite's normal extension-based esbuild transform, so leaving TS
		// syntax in would 500 the dev server (see the `load` hook's comment).
		const code = (await call(plugin.load, null, resolved)) as string
		// esbuild's transform (stripping the TS-only syntax) re-quotes to
		// double quotes — assert on content, not the exact original quoting.
		expect(code).toContain('import * as slots_story from')
		expect(code).toContain(`${projectAppDir}/routes/story.slots.tsx`)
		expect(code).toContain('slots_story')
		expect(code).toContain('"story"')
		expect(code).not.toContain('import type')
		expect(code).not.toContain('as unknown as')

		// Unrelated ids with no importer pass through untouched.
		expect(await call(plugin.resolveId, null, 'react')).toBeNull()
	})

	it('falls back to empty registries when the project has no manifest yet', async () => {
		process.env.MAXSTACK_PROJECT_APP_DIR = projectAppDir
		const plugin = ownedSlotDevPlugin() as Plugin
		const resolved = (await call(
			plugin.resolveId,
			null,
			'~/owned.generated',
		)) as string
		const code = (await call(plugin.load, null, resolved)) as string
		expect(code).toContain('export const OWNED_SLOTS')
		expect(code).not.toContain(`${projectAppDir}/`)
	})

	it('re-anchors a bare import from a project-owned file at apps/web (issue #41 node_modules gap)', async () => {
		process.env.MAXSTACK_PROJECT_APP_DIR = projectAppDir
		const plugin = ownedSlotDevPlugin() as Plugin
		const importerInProject = resolve(projectAppDir, 'routes/note.tsx')
		const resolveCalls: Array<[string, string | undefined]> = []
		const pluginContext = {
			resolve: async (id: string, importer?: string) => {
				resolveCalls.push([id, importer])
				return { id: `RESOLVED:${id}` }
			},
		}

		const resolved = await call(
			plugin.resolveId,
			pluginContext,
			'@maxstack/ui',
			importerInProject,
		)
		expect(resolved).toEqual({ id: 'RESOLVED:@maxstack/ui' })
		// Re-anchored at this plugin file's own location (inside apps/web),
		// not at the importer (which lives outside apps/web entirely).
		expect(resolveCalls[0]?.[1]).not.toBe(importerInProject)
		expect(resolveCalls[0]?.[1]).toContain('apps/web')

		// Relative/absolute/virtual specifiers are left alone (no re-anchor).
		const relative = await call(
			plugin.resolveId,
			pluginContext,
			'./helpers.ts',
			importerInProject,
		)
		expect(relative).toBeNull()
	})
})
