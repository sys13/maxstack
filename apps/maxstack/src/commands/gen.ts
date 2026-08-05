/**
 * `maxstack gen [dir]` — regenerate the app tree from the project's spec through
 * the never-clobber ownership writer. Safe to run any time: generated files are
 * refreshed, user-owned and ejected files are left untouched.
 */

import { generateProject, isRegenStable } from '../lib/generate.ts'
import { loadProject } from '../lib/project.ts'

export async function genCommand(dir: string | undefined): Promise<void> {
	const project = await loadProject(dir ?? '.')
	const { writes, artifacts } = await generateProject(project)

	for (const w of writes) console.log(`  ${w.action.padEnd(20)} ${w.file}`)
	for (const a of artifacts) console.log(`  ${'artifact'.padEnd(20)} ${a}`)
	console.log(
		`\n✔ generated ${writes.length} route writes · ${artifacts.length} artifacts` +
			(isRegenStable(writes) ? ' (regen stable)' : ''),
	)
}
