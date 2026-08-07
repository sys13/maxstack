/**
 * `maxstack add view <resource> [dir]` — scaffold an *owned* view module for a
 * resource: the infer-then-eject workflow as a first-class verb (Plan v5 task
 * 36). It writes `routes/<resource>.tsx` — a module on the same
 * `OwnedRouteProps` contract `maxstack eject` hands over, with the inferred
 * title cell written out as an editable `columns` override — then flips that
 * route to `ejected` in the manifest so `maxstack gen` never regenerates over
 * it: your cell edits survive regeneration.
 *
 * The runtime already knows how to execute an ejected route: `maxstack build`
 * wires every `ejected` entry into `OWNED_ROUTES`, and the generic project page
 * renders that owned module in place of the inferred list (the Bar-2 seam) —
 * handing it the loader's rows, columns, capabilities, resolved references and
 * signed file URLs, which is what this scaffold renders from (issue #356).
 *
 * The write goes through `writeOwned` (issue #360). A verb whose output is a
 * file stamped THIS FILE IS YOURS is the last place that may write it blind, and
 * this one did until now — so a second run overwrote the user's module wholesale
 * and then re-flipped the manifest entry it had itself already set to `ejected`.
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
	writeOwned,
} from '@maxstack/core/ownership'
import { pageDescriptor } from '@maxstack/mcp'
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
	options: { force?: boolean } = {},
): Promise<void> {
	const project = await loadProject(dir ?? '.')
	const spec = await project.spec.load()

	// Introspect the resource out of the spec (throws with the known list if the
	// name is unknown).
	const view = resolveView(spec, resource)
	const file = viewFile(resource)

	// An owned view renders where a spec page's entity resolves to this resource
	// (`project.page.tsx`), so the page is what decides which list component the
	// module should emit — resolved before the write, not after it (issue #360).
	const pages = getAcceptedOrAll(spec.pages.pages).filter(
		(p) => p.entityId && resourceOf(p.entityId) === resource,
	)
	const hasPage = pages.length > 0
	const surface = pages.map((p) => pageDescriptor(p).list).find((l) => l)
	const content = renderViewModule(view, surface)

	const fs = createNodeFs(project.appPath)
	const manifest: RouteManifest = (await fs.exists(MANIFEST_FILENAME))
		? parseManifest(await fs.read(MANIFEST_FILENAME))
		: emptyManifest()
	const prior = manifest.entries.find((e) => e.id === resource)

	// Never-clobber, through the same layer everything else writes through
	// (issue #360). This used to be a bare `fs.write`, so re-running the command
	// silently overwrote the file it had itself declared THIS FILE IS YOURS —
	// including, since #356, whenever a user took the documented upgrade path from
	// the old props-less shape to this one. `writeOwned` writes over a `generated`
	// entry (that is the infer-then-eject workflow) and refuses everything else.
	//
	// The refusal *throws* rather than printing and returning 0: this is the one
	// verb whose no-op means "your edits were about to be destroyed", and a
	// scripted re-run that reports success while doing nothing is how that lesson
	// gets learned twice. Refusing rather than writing beside it because there is
	// no second place to write: the file's path is the route's path, so a
	// `post.2.tsx` would be a module nothing mounts — a decoy, not an escape.
	const { manifest: next, result } = await writeOwned(
		fs,
		manifest,
		{
			id: resource,
			// Reuse the route path the generator recorded; otherwise derive one.
			routePath: prior?.routePath ?? `/${resource}`,
			file,
		},
		content,
		{ force: options.force === true },
	)
	if (result.action === 'skipped-user-owned') {
		throw new Error(
			`refusing to overwrite ${project.config.appDir}/${file} — you own it` +
				`\n  ("${resource}" is \`${result.ownership}\` in the route manifest).` +
				'\n' +
				'\n  Re-running `add view` would replace the whole module, so every hand' +
				'\n  edit in it would be gone with no diff and no undo.' +
				'\n' +
				'\n  If you meant to regenerate it — the upgrade path to the current' +
				'\n  scaffold shape — save your edits first and opt in:' +
				`\n      maxstack add view ${resource}${dir && dir !== '.' ? ` ${dir}` : ''} --force`,
		)
	}
	await fs.write(MANIFEST_FILENAME, serializeManifest(next))

	const label = formatLabel(resource)
	const cols = view.introspection.columns.filter(
		(c) => c.name !== view.introspection.primaryKey && c.meta?.hidden !== true,
	).length
	console.log(`✔ scaffolded view: ${project.config.appDir}/${file}`)
	console.log(
		`  ${label}: ${cols} inferred column(s), rendered from the loader's live` +
			`\n  introspection` +
			(view.titleField
				? ` · "${view.titleField}" cell ejected as an example`
				: ''),
	)
	console.log(
		`  route "${resource}" is now ejected — this file is YOURS: regeneration` +
			`\n  never touches it again, and it no longer picks up generator improvements.`,
	)
	console.log(
		`  The render is yours; the LOADER is not. Rows, columns, permissions,` +
			`\n  reference titles and signed file URLs still resolve from spec/ per` +
			`\n  request and arrive as props — so this page keeps its spec entry.`,
	)

	// The one case this verb reaches that `maxstack eject` refuses: the page a
	// scaffolded view would render at is arranged by a calendar/timeline/board
	// block, or its list region is owned by a `mode: 'replace'` slot. The props
	// contract still serves it — `project.page.tsx` builds the list props before
	// the owned-route branch either way — so the emitted module *works*; it just
	// draws a table where a working board used to be, because an owned module
	// replaces the page's whole surface. Same trade as ejecting a board, so it
	// gets the same warning rather than a silent downgrade.
	const arranged = pages.filter((p) => !pageDescriptor(p).list)
	if (arranged.length > 0) {
		console.log(
			`  ⚠ ${arranged.map((p) => `"${p.name}"`).join(', ')} arranges these rows` +
				`\n    with a view block (calendar / timeline / board) or a` +
				`\n    list-replacing slot. An owned module replaces the page's whole` +
				`\n    surface, so this scaffold renders a TABLE there instead. Keep the` +
				`\n    arrangement by filling a block slot instead of scaffolding a view.`,
		)
	}

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
