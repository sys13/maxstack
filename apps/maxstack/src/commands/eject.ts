/**
 * `maxstack eject [dir] <route-id> [--to <file>]` — take ownership of a
 * generated route module. Runs the never-clobber `eject` primitive: the file's
 * ownership flips to `ejected` in the manifest, so future `maxstack gen` runs
 * skip it and your edits survive.
 */

import {
	createNodeFs,
	eject,
	isMaterializedPage,
	MANIFEST_FILENAME,
	parseManifest,
	type RouteManifest,
	serializeManifest,
} from '@maxstack/core/ownership'
import { loadProject } from '../lib/project.ts'

/**
 * What eject actually hands over, said at the moment of handover (#349).
 *
 * Eject used to print "maxstack gen will no longer overwrite it" and stop,
 * which answers the question nobody was asking. The question is *what is in the
 * file*, and until #349 the answer — a heading and a comment — was so far from
 * "you own this page" that a user could eject every route in a project and be
 * left with a tree that renders nothing. The page renders from this module now;
 * the loader behind it does not, and that is the line worth printing.
 */
const OWNERSHIP_NOTE = [
	'  This module now renders the page: it is handed the loader’s rows,',
	'  columns, permissions and resolved references as props, and composes the',
	'  list from them. Edit it freely.',
	'  The loader itself is still framework code and still resolves this page',
	'  from spec/ at request time, so the page keeps its spec entry.',
]

/**
 * Printed when the file being ejected is a placeholder rather than the page.
 *
 * A view page's surface (calendar / timeline / board) cannot be emitted as
 * owned code yet, and an ejected module *replaces* the framework's surface —
 * so ejecting one trades a working board for a heading. That is a foot-gun the
 * command has to name before it fires, not a comment to find afterwards.
 */
const UNMATERIALIZED_WARNING = [
	'⚠ This route module is a PLACEHOLDER, not the page.',
	'  Its surface is a view block (calendar / timeline / board) or a',
	'  list-replacing slot, which the generator cannot yet emit as owned code.',
	'  The framework renders the real surface only while the route is generated:',
	'  ejecting it replaces that surface with the stub in this file.',
	'  Prefer filling a block slot, which keeps the surface and costs no eject.',
]

interface EjectOptions {
	to?: string
	dryRun?: boolean
}

export async function ejectCommand(
	dir: string | undefined,
	routeId: string,
	opts: EjectOptions,
): Promise<void> {
	const project = await loadProject(dir ?? '.')
	const fs = createNodeFs(project.appPath)

	if (!(await fs.exists(MANIFEST_FILENAME))) {
		throw new Error(
			`no route manifest in ${project.config.appDir}/ — run "maxstack gen" first.`,
		)
	}
	const manifest: RouteManifest = parseManifest(
		await fs.read(MANIFEST_FILENAME),
	)
	const entry = manifest.entries.find((e) => e.id === routeId)
	if (!entry) {
		const ids = manifest.entries.map((e) => e.id).join(', ')
		throw new Error(`unknown route id "${routeId}". known: ${ids || '(none)'}`)
	}

	const destFile = opts.to ?? entry.file

	// --dry-run: show what taking whole-file ownership would land, and never
	// touch the manifest. Rung-4 eject is scary without a diff —
	// this is the preview.
	if (opts.dryRun) {
		if (entry.ownership === 'ejected') {
			console.log(
				`· "${routeId}" is already ejected (${entry.file}) — nothing to do.`,
			)
			return
		}
		const source = await fs.read(entry.file)
		console.log(`eject --dry-run: "${routeId}"`)
		console.log(`  ${entry.file} (${entry.ownership}) → ${destFile} (ejected)`)
		console.log(
			`  after eject, "maxstack gen" stops overwriting it and it's yours to edit.`,
		)
		for (const line of describeHandover(source)) console.log(line)
		console.log(`\n--- ${destFile} (${source.split('\n').length} lines) ---`)
		console.log(source)
		console.log(`--- end preview (nothing written) ---`)
		return
	}

	// Read before the eject: `eject` rewrites the file's banner in place, and
	// what matters is the module being handed over, not the banner on it.
	const source = await fs.read(entry.file)
	const { manifest: next, result } = await eject(
		fs,
		manifest,
		routeId,
		destFile,
	)
	await fs.write(MANIFEST_FILENAME, serializeManifest(next))

	console.log(`✔ ${result.action}: ${result.file} (now ${result.ownership})`)
	console.log(`  "maxstack gen" will no longer overwrite it.`)
	for (const line of describeHandover(source)) console.log(line)
}

/** What the user is actually being handed — the honest half of #349. */
function describeHandover(source: string): string[] {
	return isMaterializedPage(source) ? OWNERSHIP_NOTE : UNMATERIALIZED_WARNING
}
