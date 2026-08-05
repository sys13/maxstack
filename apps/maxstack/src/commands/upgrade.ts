/**
 * `maxstack gen --upgrade [dir]` — the dep-currency story (§3-L2 / task 28). Two moves,
 * in order:
 *
 *   1. **Bundle codemods.** Installed bundles are version-pinned in `maxstack.json`;
 *      when the catalog ships a newer version of a bundle, `planBundleUpgrades`
 *      finds the gap and runs the registered codemods to migrate the project's spec
 *      (each is an idempotent spec-op transform), then the recorded versions are
 *      bumped. A newer bundle with no codemod is a clean version bump.
 *   2. **Framework regen.** Regenerate the app tree against the *current* generators
 *      so the migrated spec + newer framework land through the never-clobber writer.
 *
 * Exits non-zero if the regeneration would clobber owned files.
 */

import { driftSummaryLine, type WriteResult } from '@maxstack/core/ownership'
import {
	applyBundleUpgrades,
	BUNDLES,
	bumpInstalledVersions,
	planBundleUpgrades,
} from '@maxstack/features/bundle'
import { generateProject, projectDrift } from '../lib/generate.ts'
import { loadProject, saveConfig } from '../lib/project.ts'

export async function upgradeCommand(dir: string | undefined): Promise<void> {
	const project = await loadProject(dir ?? '.')

	// 1. Reconcile installed bundle versions against the catalog via codemods.
	const plans = planBundleUpgrades(project.config.bundles, BUNDLES)
	if (plans.length > 0) {
		console.log('migrating installed bundles to the current catalog:\n')
		let spec = await project.spec.load()
		spec = applyBundleUpgrades(spec, plans)
		await project.spec.save(spec)

		// The same bump the upgrade-safety gate runs — one
		// implementation, so the gate checks the shipped path rather than a copy.
		const bumped = bumpInstalledVersions(project.config.bundles, plans)
		await saveConfig(project.root, { ...project.config, bundles: bumped })

		for (const plan of plans) {
			const detail = plan.steps.length
				? plan.steps.map((s) => `      · ${s.description}`).join('\n')
				: '      · clean version bump (no schema migration)'
			console.log(
				`  ${plan.slug} ${plan.fromVersion} → ${plan.toVersion}\n${detail}`,
			)
		}
		console.log()
	}

	// 2. Regenerate against the current framework generators.
	console.log('regenerating against the current framework generators…\n')
	const { writes, artifacts } = await generateProject(project)

	const by = (action: WriteResult['action']) =>
		writes.filter((w) => w.action === action)
	const created = by('created')
	const updated = by('overwritten')
	const appended = by('appended')
	const preserved = by('skipped-user-owned')
	// The unchanged sea is noise; only what the regen actually touched earns a line.
	const touched = [...created, ...updated, ...appended]

	for (const w of touched) console.log(`  ${w.action.padEnd(12)}${w.file}`)
	for (const w of preserved)
		console.log(`  preserved   ${w.file} (owned — left as-is)`)

	const counts = [
		created.length && `${created.length} created`,
		updated.length && `${updated.length} updated`,
		appended.length && `${appended.length} appended`,
	].filter((s): s is string => Boolean(s))
	console.log(
		`\n${counts.length ? counts.join(' · ') : 'no framework changes'}` +
			` · ${preserved.length} owned file(s) preserved` +
			` · ${artifacts.length} artifact(s) refreshed`,
	)

	// The never-clobber writer skips owned files by construction, so a rewritten
	// owned file would mean the guarantee broke. Assert it held; anything else is
	// a normal framework update, not a clobber.
	const clobbered = updated.filter((w) => w.ownership !== 'generated')
	if (clobbered.length === 0) {
		console.log(
			touched.length
				? '✔ upgrade clean — never-clobber held; your owned code is untouched'
				: '✔ already current — nothing to regenerate',
		)
		// The other half of that sentence. "Your owned code is
		// untouched" is true and incomplete: an upgrade is exactly when a file you
		// took ownership of falls further behind what the platform would emit
		// today. One line, pointing at `maxstack drift` — nothing is applied, and a
		// wall of diffs after every upgrade is how a signal gets ignored.
		const drift = driftSummaryLine(
			await projectDrift(project, await project.spec.load()),
		)
		if (drift) console.log(drift)
	} else {
		console.error('\n✖ upgrade clobbered owned files (never-clobber broke):')
		for (const w of clobbered) console.error(`  - ${w.file}`)
		console.error('  this is a framework bug — please report it.')
		process.exitCode = 1
	}
}
