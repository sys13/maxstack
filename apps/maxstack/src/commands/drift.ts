/**
 * `maxstack drift [dir]` — the ownership drift report.
 *
 * "Eject any file, own it forever" is the promise that makes the whole ownership
 * ladder trustworthy. The half nobody ships is the other one: **the eject tax is
 * deferred, and you pay it silently.** A framework improvement lands in every
 * generated route except the one you took, and nothing tells you.
 *
 * So this reports what you own, what it was derived from, and how far behind the
 * current derivation it has drifted — and does nothing else. Never writes, never
 * proposes a write, never fails. It is pull, not push: `gen` and `upgrade` print
 * at most one line pointing here, because drift reporting that nags is drift
 * reporting people turn off.
 */

import { formatOwnershipDrift } from '@maxstack/core/ownership'
import { projectDrift } from '../lib/generate.ts'
import { loadProject } from '../lib/project.ts'

export interface DriftOptions {
	json?: boolean
	/** Print the unified diff for every drifted file, not just the summary. */
	patches?: boolean
}

export async function driftCommand(
	dir: string | undefined,
	opts: DriftOptions = {},
): Promise<void> {
	const project = await loadProject(dir ?? '.')
	const spec = await project.spec.load()
	const report = await projectDrift(project, spec)

	if (opts.json) {
		console.log(JSON.stringify(report, null, '\t'))
		return
	}
	console.log(formatOwnershipDrift(report, { patches: opts.patches === true }))
	if (!opts.patches && report.driftedCount > 0) {
		console.log('\nRun with --patches to see the diffs.')
	}
}
