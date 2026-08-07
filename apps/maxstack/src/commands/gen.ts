/**
 * `maxstack gen [dir]` — regenerate the app tree from the project's spec through
 * the never-clobber ownership writer. Safe to run any time: generated files are
 * refreshed, user-owned and ejected files are left untouched.
 */

import { generateProject, isRegenStable } from '../lib/generate.ts'
import { loadProject } from '../lib/project.ts'

export async function genCommand(dir: string | undefined): Promise<void> {
	const project = await loadProject(dir ?? '.')
	const { writes, artifacts, pruned } = await generateProject(project)

	// Prunes first, and with their reason: a run that *removes* something from
	// the tree is the one line in this output nobody should have to infer from a
	// diff, and `unwired`/`kept-owned` each leave a file behind that only the
	// maintainer can decide about.
	for (const p of pruned) {
		console.log(`  ${p.action.padEnd(20)} ${p.file}`)
		console.log(`  ${' '.repeat(20)} ${p.reason}`)
	}
	for (const w of writes) console.log(`  ${w.action.padEnd(20)} ${w.file}`)
	for (const a of artifacts) console.log(`  ${'artifact'.padEnd(20)} ${a}`)
	console.log(
		`\n✔ generated ${writes.length} route writes · ${artifacts.length} artifacts` +
			(pruned.length > 0 ? ` · ${pruned.length} pruned` : '') +
			(isRegenStable(writes) ? ' (regen stable)' : ''),
	)
}
