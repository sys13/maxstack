/**
 * `maxstack dev`'s owned-slot hot loop.
 *
 * `maxstack build`/`deploy` wire a project's owned slot/ejected-route code
 * into the runtime by writing `apps/web/app/owned.generated.tsx` from
 * `renderOwnedManifest` (`@maxstack/core`) — but that only happens inside the
 * *vendored* tree (`<project>/.maxstack/runtime/`), never in the live
 * `apps/web` checkout `maxstack dev` spawns `pnpm run dev` in. So the
 * committed empty stub (`app/owned.generated.tsx`) is all dev ever imports:
 * filled slot files render the "fill it in" hint forever, even after you've
 * filled them.
 *
 * This plugin closes that seam for dev *without* touching the committed
 * stub file (so `maxstack dev` never leaves the checkout's git tree dirty,
 * and a bare `pnpm run dev` outside `maxstack dev` is unaffected): it
 * intercepts the `~/owned.generated` import as a virtual module and
 * (re)generates its content in memory, on demand, from the project's real
 * route manifest — reusing the exact same `renderOwnedManifest` function
 * `build.ts` calls, just pointed at the project's actual (un-mirrored) app
 * dir instead of a vendored `./project/` copy.
 *
 * Only active when `MAXSTACK_PROJECT_APP_DIR` is set — `devCommand`
 * (`apps/maxstack/src/commands/harness.ts`) sets it to `project.appPath`
 * when it spawns this dev server. Also only active for `vite dev`
 * (`apply: 'serve'`): `vite build`/`react-router build` (what `maxstack
 * build` runs, in the vendored tree, over a file `vendorRuntime` already
 * wrote to disk) never sees this plugin at all.
 *
 * One more wrinkle from skipping the mirror-copy: a project's owned files
 * live wherever the project is on disk, so bare imports inside them (e.g.
 * `@maxstack/ui`) fail plain Node resolution — there's no `node_modules`
 * anywhere above a project directory that isn't part of this workspace.
 * `vendorRuntime`'s physical copy into `apps/web/app/project/` sidesteps
 * this for free (the copy resolves node_modules the normal way, from
 * inside `apps/web`); dev re-anchors those bare specifiers at `apps/web`
 * itself instead (see `resolveId` below).
 */

import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	MANIFEST_FILENAME,
	parseManifest,
	type RouteManifest,
	renderOwnedManifest,
} from '@maxstack/core/ownership'
import type { Plugin } from 'vite'
import { transformWithEsbuild } from 'vite'

const OWNED_GENERATED_SPECIFIER = '~/owned.generated'
const VIRTUAL_MODULE_ID = '\0virtual:maxstack-owned-generated'

/** This plugin file's own path — always inside `apps/web`, so it's a valid
 * anchor for "resolve this bare specifier as if from apps/web itself". */
const APPS_WEB_ANCHOR = fileURLToPath(import.meta.url)

function isBareSpecifier(id: string): boolean {
	return !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0')
}

async function loadManifest(manifestPath: string): Promise<RouteManifest> {
	try {
		return parseManifest(await readFile(manifestPath, 'utf8'))
	} catch {
		// Fresh project, no manifest yet — same empty registries as the stub.
		return { version: 1, entries: [] }
	}
}

export function ownedSlotDevPlugin(): Plugin {
	const projectAppDir = process.env.MAXSTACK_PROJECT_APP_DIR
	if (!projectAppDir) {
		// Not running under `maxstack dev` — leave `~/owned.generated` alone,
		// so it resolves to the committed stub as it always has.
		return { name: 'maxstack-owned-slot-dev', apply: 'serve' }
	}
	const manifestPath = resolve(projectAppDir, MANIFEST_FILENAME)

	return {
		name: 'maxstack-owned-slot-dev',
		apply: 'serve',
		// Run ahead of vite's native tsconfig-paths resolution
		// (`resolve.tsconfigPaths`) so we intercept the specifier before `~/*`
		// is mapped to the on-disk stub file.
		enforce: 'pre',
		async resolveId(id, importer) {
			if (id === OWNED_GENERATED_SPECIFIER) return VIRTUAL_MODULE_ID
			// A bare import inside a project-owned file (imported by us from
			// `projectAppDir`, outside apps/web) — re-anchor it at apps/web so
			// it finds this workspace's node_modules, the same resolution a
			// physical `apps/web/app/project/` mirror-copy would get for free.
			if (
				importer?.startsWith(`${projectAppDir}${sep}`) &&
				isBareSpecifier(id)
			) {
				const resolved = await this.resolve(id, APPS_WEB_ANCHOR, {
					skipSelf: true,
				})
				if (resolved) return resolved
			}
			return null
		},
		async load(id) {
			if (id !== VIRTUAL_MODULE_ID) return null
			const manifest = await loadManifest(manifestPath)
			const source = renderOwnedManifest(manifest, {
				importBase: projectAppDir,
			})
			// Virtual (`\0`-prefixed) module ids skip Vite's normal
			// extension-based esbuild transform, so TS-only syntax in the
			// generated source (`import type { ... }`, `as unknown as ...`)
			// reaches Rollup's plain-JS parser and fails. Strip it ourselves —
			// `renderOwnedManifest`'s output is always valid TSX.
			const { code } = await transformWithEsbuild(source, id, {
				loader: 'tsx',
			})
			return code
		},
		configureServer(server) {
			// The manifest changes when routes are (re)generated — new slot
			// stubs, an eject, a resource added/removed. Slot *content* edits to
			// an already-imported file get vite's ordinary HMR for free (the
			// virtual module imports it by real path), no regeneration needed.
			server.watcher.add(manifestPath)
			const onManifestChange = (changed: string) => {
				if (changed !== manifestPath) return
				const mod = server.moduleGraph.getModuleById(VIRTUAL_MODULE_ID)
				if (mod) server.moduleGraph.invalidateModule(mod)
				// OWNED_ROUTES/OWNED_SLOTS gate a structural render decision
				// (project.page.tsx), so nudge the whole page rather than try to
				// selectively HMR it.
				server.ws.send({ type: 'full-reload' })
			}
			server.watcher.on('add', onManifestChange)
			server.watcher.on('change', onManifestChange)
		},
	}
}
