/**
 * `maxstack add view <page> [dir]` — scaffold an *owned* view module for a
 * page: the infer-then-eject workflow as a first-class verb (Plan v5 task
 * 36). It writes `routes/<module-key>.tsx` — a module on the same
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
 *
 * ## The noun is a page, not a resource (issue #434)
 *
 * It used to be `add view <resource>`, writing its manifest entry under the bare
 * resource. Everything else in the ownership path is page-scoped — eject, the
 * manifest, `OWNED_ROUTES`, the never-clobber writer — because a page is the
 * unit a user owns, and the two agree only when an entity has exactly one page.
 * On a second page there was no argument that could reach it: before #392 the
 * resource-keyed entry hijacked *every* page over the entity, and after it the
 * verb silently landed on the first. So the argument now resolves to one page —
 * by route path, page id or module key, falling back to the sole page over a
 * named resource — and the entry is keyed by module key, matching eject.
 *
 * `OWNED_SLOTS` staying resource-keyed is deliberate and untouched: block slots
 * genuinely live in one `<resource>.slots.tsx` that every page over the entity
 * composes from (`generateResourcePage`'s "two keys, deliberately").
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
import {
	renderViewModule,
	resolveView,
	resolveViewTarget,
	viewFile,
} from '../lib/view.ts'

/** `e-task` → `task` — the same derivation the runtime's page composition uses
 * (`project-routes.ts`), so the page-existence check below matches how the
 * server decides which owned route renders where. */
const resourceOf = (entityId: string) => entityId.replace(/^e-/, '')

export async function addViewCommand(
	dir: string | undefined,
	/** A page — its route path, its id, or the module key gen filed it under —
	 * or a resource, which resolves to its sole page (issue #434). */
	target: string,
	options: { force?: boolean } = {},
): Promise<void> {
	const project = await loadProject(dir ?? '.')
	const spec = await project.spec.load()

	// Which PAGE this scaffold lands on. Throws when a resource has several
	// pages and none was named — silently taking the first is the bug (#434).
	const { resource, moduleKey, page } = resolveViewTarget(spec, target)

	// Introspect the resource out of the spec (throws with the known list if the
	// name is unknown).
	const view = resolveView(spec, resource)
	const file = viewFile(moduleKey)

	// An owned view renders where the target page mounts (`project.page.tsx`),
	// so that page is what decides which list component the module should emit —
	// resolved before the write, not after it (issue #360). One page, not "the
	// first page over the resource that declares a surface": since #434 this
	// command owns exactly the one module it was pointed at.
	const hasPage = page !== undefined
	const surface = page
		? pageDescriptor(page, spec.data.entities).list
		: undefined
	const content = renderViewModule(view, surface, target)

	const fs = createNodeFs(project.appPath)
	const manifest: RouteManifest = (await fs.exists(MANIFEST_FILENAME))
		? parseManifest(await fs.read(MANIFEST_FILENAME))
		: emptyManifest()
	const prior = manifest.entries.find((e) => e.id === moduleKey)

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
			// The module key, matching what `maxstack eject` writes and what the
			// mount looks the owned module up by (#434).
			id: moduleKey,
			// Reuse the route path the generator recorded; otherwise the page's own
			// route, and only then a derived one.
			routePath: prior?.routePath ?? page?.route ?? `/${resource}`,
			file,
		},
		content,
		{ force: options.force === true },
	)
	if (result.action === 'skipped-user-owned') {
		throw new Error(
			`refusing to overwrite ${project.config.appDir}/${file} — you own it` +
				`\n  ("${moduleKey}" is \`${result.ownership}\` in the route manifest).` +
				'\n' +
				'\n  Re-running `add view` would replace the whole module, so every hand' +
				'\n  edit in it would be gone with no diff and no undo.' +
				'\n' +
				'\n  If you meant to regenerate it — the upgrade path to the current' +
				'\n  scaffold shape — save your edits first and opt in:' +
				`\n      maxstack add view ${target}${dir && dir !== '.' ? ` ${dir}` : ''} --force`,
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
		`  route "${moduleKey}"${page ? ` (${page.route})` : ''} is now ejected —` +
			`\n  this file is YOURS: regeneration never touches it again, and it no` +
			`\n  longer picks up generator improvements.`,
	)
	console.log(
		`  The render is yours; the LOADER is not. Rows, columns, permissions,` +
			`\n  reference titles and signed file URLs still resolve from spec/ per` +
			`\n  request and arrive as props — so this page keeps its spec entry.`,
	)

	// The one case this verb still reaches that `maxstack eject` no longer has:
	// the page a scaffolded view would render at is arranged by a
	// calendar/timeline/board block, or its list region is owned by a
	// `mode: 'replace'` slot. The props contract serves it — `project.page.tsx`
	// builds the list props before the owned-route branch either way — so the
	// emitted module *works*; it just draws a table where a working board used
	// to be, because `add view` only ever emits a table and an owned module
	// replaces the page's whole surface.
	//
	// Since #349 stage 2 there is a better answer than "don't", and the warning
	// names it: `maxstack gen` writes the board/calendar/timeline module itself
	// now, so ejecting *that* keeps the arrangement.
	//
	// Only the targeted page is examined, not every page over the resource: a
	// sibling's board is that sibling's business now that this verb owns one
	// module (#434).
	if (page && !surface) {
		console.log(
			`  ⚠ "${page.name}" arranges these rows` +
				`\n    with a view block (calendar / timeline / board) or a` +
				`\n    list-replacing slot. An owned module replaces the page's whole` +
				`\n    surface, so this scaffold renders a TABLE there instead.` +
				`\n    Keep the arrangement instead: "maxstack gen" already writes that` +
				`\n    page's own module, so "maxstack eject ${moduleKey}" hands over the` +
				`\n    real board / calendar / timeline. A block slot keeps it too, and` +
				`\n    costs no eject.`,
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
