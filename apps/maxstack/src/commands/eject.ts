/**
 * `maxstack eject [dir] <route-id> [--to <file>]` — take ownership of a
 * generated route module. Runs the never-clobber `eject` primitive: the file's
 * ownership flips to `ejected` in the manifest, so future `maxstack gen` runs
 * skip it and your edits survive.
 */

import {
	createNodeFs,
	eject,
	MANIFEST_FILENAME,
	parseManifest,
	type RouteManifest,
	serializeManifest,
} from '@maxstack/core/ownership'
import { loadProject } from '../lib/project.ts'

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
		console.log(`\n--- ${destFile} (${source.split('\n').length} lines) ---`)
		console.log(source)
		console.log(`--- end preview (nothing written) ---`)
		return
	}

	const { manifest: next, result } = await eject(
		fs,
		manifest,
		routeId,
		destFile,
	)
	await fs.write(MANIFEST_FILENAME, serializeManifest(next))

	console.log(`✔ ${result.action}: ${result.file} (now ${result.ownership})`)
	console.log(`  "maxstack gen" will no longer overwrite it.`)
}
