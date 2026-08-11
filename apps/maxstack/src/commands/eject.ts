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
import { routeChoices } from '../lib/choices.ts'
import { loadProject } from '../lib/project.ts'
import { type Interaction, nonInteractive, resolveArg } from '../lib/prompt.ts'

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
	'  surface — list, board, calendar or timeline — from them. Edit it freely.',
	'  The loader itself is still framework code and still resolves this page',
	'  from spec/ at request time, so the page keeps its spec entry.',
]

/**
 * Printed when the file being ejected is a placeholder rather than the page.
 *
 * An ejected module *replaces* the framework's surface, so ejecting a page the
 * generator could not write trades a working page for a heading. That is a
 * foot-gun the command has to name before it fires, not a comment to find
 * afterwards.
 *
 * It used to say this of every view page, and stopped being true of most of
 * them in stage 2 of #349: board, calendar and timeline pages materialize now,
 * and so does a page whose list a `mode: 'replace'` slot owns. What is left is
 * an `aggregate` block — a chart over a GROUP BY the server computes, which
 * never reaches the rows contract an owned module is handed — and a page with
 * no entity behind it. The condition itself is unchanged and needs no
 * maintenance: the warning fires on {@link isMaterializedPage} reading the file
 * being handed over, so a page that starts materializing stops being warned
 * about on the same commit. Only these words had to catch up.
 */
const UNMATERIALIZED_WARNING = [
	'⚠ This route module is a PLACEHOLDER, not the page.',
	'  Its surface is an aggregate block (a chart over a GROUP BY the server',
	'  computes), or the page has no entity behind it — neither of which the',
	'  generator can yet emit as owned code. List, board, calendar and timeline',
	'  pages do materialize; this one does not.',
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
	routeId: string | undefined,
	opts: EjectOptions,
	io: Interaction = nonInteractive,
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

	// The manifest is the list the "unknown route id" error below already prints
	// after a wrong guess (#421). Offering it first is the same list, one round
	// trip earlier.
	const chosen = await resolveArg(routeId, 'route-id', io, (prompter) =>
		prompter.select(
			'Which route do you want to own?',
			routeChoices(manifest.entries),
		),
	)
	const entry = manifest.entries.find((e) => e.id === chosen)
	if (!entry) {
		const ids = manifest.entries.map((e) => e.id).join(', ')
		throw new Error(`unknown route id "${chosen}". known: ${ids || '(none)'}`)
	}

	const destFile = opts.to ?? entry.file

	// --dry-run: show what taking whole-file ownership would land, and never
	// touch the manifest. Rung-4 eject is scary without a diff —
	// this is the preview.
	if (opts.dryRun) {
		if (entry.ownership === 'ejected') {
			console.log(
				`· "${chosen}" is already ejected (${entry.file}) — nothing to do.`,
			)
			return
		}
		const source = await fs.read(entry.file)
		console.log(`eject --dry-run: "${chosen}"`)
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
	const { manifest: next, result } = await eject(fs, manifest, chosen, destFile)
	await fs.write(MANIFEST_FILENAME, serializeManifest(next))

	console.log(`✔ ${result.action}: ${result.file} (now ${result.ownership})`)
	console.log(`  "maxstack gen" will no longer overwrite it.`)
	for (const line of describeHandover(source)) console.log(line)
}

/** What the user is actually being handed — the honest half of #349. */
function describeHandover(source: string): string[] {
	return isMaterializedPage(source) ? OWNERSHIP_NOTE : UNMATERIALIZED_WARNING
}
