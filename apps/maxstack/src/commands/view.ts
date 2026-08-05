/**
 * `maxstack add view <resource> [dir]` — scaffold an *owned* view module for a
 * resource: the infer-then-eject workflow as a first-class verb (Plan v5 task
 * 36). It writes `routes/<resource>.tsx` with the resource's inferred columns
 * spelled out as explicit `<ResourceList>` props (the "guesser output"), then
 * flips that route to `ejected` in the manifest so `maxstack gen` never
 * regenerates over it — your column edits survive regeneration.
 *
 * The runtime already knows how to execute an ejected route: `maxstack build`
 * wires every `ejected` entry into `OWNED_ROUTES`, and the generic project page
 * renders that owned module in place of the inferred list (the Bar-2 seam).
 */

import { resolve } from 'node:path'
import { formatLabel } from '@maxstack/core'
import {
	createNodeFs,
	emptyManifest,
	MANIFEST_FILENAME,
	parseManifest,
	type RouteManifest,
	serializeManifest,
	upsertEntry,
} from '@maxstack/core/ownership'
import { getAcceptedOrAll } from '@maxstack/spec'
import { loadProject } from '../lib/project.ts'
import { renderViewModule, resolveView, viewFile } from '../lib/view.ts'

/** `e-task` → `task` — the same derivation the runtime's page composition uses
 * (`project-routes.ts`), so the page-existence check below matches how the
 * server decides which owned route renders where. */
const resourceOf = (entityId: string) => entityId.replace(/^e-/, '')

export async function addViewCommand(
	dir: string | undefined,
	resource: string,
): Promise<void> {
	const project = await loadProject(dir ?? '.')
	const spec = await project.spec.load()

	// Introspect the resource out of the spec (throws with the known list if the
	// name is unknown) and render its owned view module.
	const view = resolveView(spec, resource)
	const file = viewFile(resource)
	const content = renderViewModule(view)

	const fs = createNodeFs(project.appPath)
	await fs.write(file, content)

	// Flip the route to `ejected` so regeneration skips it. Reuse the existing
	// entry's route path when the resource was already generated; otherwise derive
	// one from the resource name.
	const manifest: RouteManifest = (await fs.exists(MANIFEST_FILENAME))
		? parseManifest(await fs.read(MANIFEST_FILENAME))
		: emptyManifest()
	const prior = manifest.entries.find((e) => e.id === resource)
	const next = upsertEntry(manifest, {
		id: resource,
		routePath: prior?.routePath ?? `/${resource}`,
		file,
		ownership: 'ejected',
	})
	await fs.write(MANIFEST_FILENAME, serializeManifest(next))

	const label = formatLabel(resource)
	const cols = view.introspection.columns.filter(
		(c) => c.name !== view.introspection.primaryKey && c.meta?.hidden !== true,
	).length
	console.log(`✔ scaffolded view: ${project.config.appDir}/${file}`)
	console.log(
		`  ${label}: ${cols} inferred column(s) written out` +
			(view.titleField
				? ` · "${view.titleField}" cell ejected as an example`
				: ''),
	)
	console.log(
		`  route "${resource}" is now ejected — this file is YOURS: regeneration` +
			`\n  never touches it again, and it no longer picks up generator improvements.`,
	)

	// An owned view renders where a spec page's entity resolves to this resource
	// (`project.page.tsx`). Without one it has no URL — say so now, with the fix,
	// instead of letting the user discover a 404 in `dev`.
	const hasPage = getAcceptedOrAll(spec.pages.pages).some(
		(p) => p.entityId && resourceOf(p.entityId) === resource,
	)
	if (!hasPage) {
		const entityId =
			getAcceptedOrAll(spec.data.entities).find(
				(e) => resourceOf(e.id) === resource,
			)?.id ?? `e-${resource}`
		const op = JSON.stringify({
			op: 'page.addPage',
			args: {
				page: {
					id: `p-${resource}`,
					name: label,
					route: `/${resource}`,
					entityId,
					blocks: [{ id: `b-${resource}-table`, type: 'table' }],
				},
			},
		})
		console.log(
			`  ⚠ no accepted page in the spec targets "${resource}", so this view has` +
				`\n    no URL to render at yet. Add one:` +
				`\n      maxstack op --op '${op}' --accept --gen`,
		)
	}

	console.log(`  edit ${resolve(project.appPath, file)} to customize.`)
	console.log(
		'  owned code runs in `maxstack dev` from a maxstack checkout as-is; from an' +
			'\n  npm install serve it with `maxstack dev --owned` (or `maxstack build`).',
	)
}
