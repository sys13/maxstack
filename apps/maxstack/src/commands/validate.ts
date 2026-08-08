/**
 * `maxstack validate [dir]` — the standalone gate for a generated project, the
 * thing that unlocks `--gate "pnpm validate"` in the nightly (task 9/10 IOU).
 * No monorepo required:
 *
 *   1. the spec parses + passes referential validation (loading it validates);
 *   2. every generated file on disk still matches its manifest hash (no drift);
 *   3. a fresh regeneration changes nothing the user owns (regen-safety § 6);
 *   4. the project's OWN gate — typecheck, lint, test — over the code the
 * maintainer owns.
 *
 * Steps 1–3 never open a line of owned code, which is why step 4 exists: a gate
 * that only reads the spec and the manifest and then prints "green" is claiming
 * something it did not check. Any part of step 4 the project cannot run is
 * printed as **unexamined** and withholds the green, rather than being silently
 * omitted — an absent check and a passing check must never look the same.
 *
 * Exits non-zero on any failure, and on an incomplete run, so CI fails loudly
 * either way.
 */

import {
	createNodeFs,
	exportedSlotNames,
	hashContent,
	isRouteModuleEntry,
	isSlotBlockType,
	MANIFEST_FILENAME,
	pageFilePaths,
	pageModuleKey,
	parseManifest,
	slotBlockName,
	slotIdHint,
} from '@maxstack/core/ownership'
import {
	orphanedSlots,
	pageDescriptors,
	seamFamilies,
	type UnavailableCheck,
} from '@maxstack/mcp'
import {
	listPortals,
	PRD_SECTION_COUNT,
	portalExposureReport,
	summarizeExposure,
	unauthoredPrdSections,
} from '@maxstack/spec'
import { generateProject, isRegenStable } from '../lib/generate.ts'
import { loadProject, SPEC_DIRNAME } from '../lib/project.ts'
import { projectCheckRunner } from '../lib/project-checks.ts'

export async function validateCommand(dir: string | undefined): Promise<void> {
	const project = await loadProject(dir ?? '.')
	const failures: string[] = []

	// 1. Spec validity — `load()` parses + runs referential validation.
	const spec = await project.spec.load()
	console.log(
		`✔ spec valid: ${spec.data.entities.length} entities · ${spec.pages.pages.length} pages`,
	)

	// 1a. The product doc — how much of it is still the `maxstack init`
	// skeleton (#343).
	//
	// `init` has to write a structurally complete PRD (an incomplete one does not
	// validate), which means a fresh project starts with a fluent, plausible
	// product brief that nobody wrote: a persona, a competitor, a milestone with
	// a real date, a kill criterion. It survived every op because nothing ever
	// mentioned it. This is the mention.
	//
	// Printed, not failed. Not having written the PRD on op three is a normal
	// state and failing the gate for it would teach people to ignore the gate —
	// but silence let a seven-op project ship a brief about a product it wasn't.
	{
		const unauthored = unauthoredPrdSections(spec.product)
		if (unauthored.length > 0) {
			console.warn(
				`\n⚠ product doc: ${unauthored.length} of ${PRD_SECTION_COUNT} sections are still the "maxstack init" skeleton — nobody authored them:`,
			)
			for (const gap of unauthored)
				console.warn(`  - ${gap.path} — ${gap.hint}`)
			console.warn(
				`  Nothing here is a decision until you write it. Edit ${SPEC_DIRNAME}/product.json, or the Product pane in \`maxstack workbench\`.\n`,
			)
		} else {
			console.log(
				`✔ product doc authored: none of its ${PRD_SECTION_COUNT} sections is init boilerplate`,
			)
		}
	}

	// 1b. Slot-name hygiene — a `slot:<name>` block's id normally stems-match
	// its own type suffix (`blk-pack-loadout` / `slot:pack_loadout`); when it
	// doesn't, it's almost always a copy-paste mistake, so flag it.
	// This is advisory only: the runtime and generator both key slots off the
	// type suffix, so a divergent id no longer breaks anything.
	for (const page of spec.pages.pages) {
		for (const block of page.blocks) {
			if (!isSlotBlockType(block.type)) continue
			const declared = slotBlockName(block.type)
			const hint = slotIdHint(block.id)
			if (declared !== hint) {
				console.warn(
					`⚠ ${page.id}: block "${block.id}" is type "${block.type}" (slot "${declared}"), but its id reads as "${hint}" — double-check this is the intended slot`,
				)
			}
		}
	}

	// 1d. The exposure report — every publicly-reachable field, as a
	// table, whenever the spec declares a portal.
	//
	// Printed rather than warned, and printed in full rather than summarized. A
	// warning is a line somebody scrolls past; a table with a row per exposed
	// field is the thing a reviewer actually reads before a public surface ships,
	// and it is the same `portalExposureReport` the workbench pane and the MCP
	// tool render, so nobody is told a different story about what is exposed.
	//
	// It is NOT a failure. Declaring a portal is a legitimate decision and the
	// gate's job here is visibility: the refusals that could be mechanical are
	// already mechanical, in `validateOp` and `collectSpecSystemErrors`, which is
	// why `spec.load()` above has already refused every unsafe declaration.
	{
		const report = portalExposureReport(spec)
		if (report.length > 0) {
			const fieldName = (id: string) =>
				spec.data.entities.flatMap((e) => e.fields).find((f) => f.id === id)
					?.name ?? id
			const portals = new Map(listPortals(spec).map((p) => [p.key, p]))
			console.log(`\n⚠ public surfaces — ${summarizeExposure(report)}`)
			let current = ''
			for (const row of report) {
				if (row.portalKey !== current) {
					current = row.portalKey
					const portal = portals.get(current)
					console.log(
						`\n  /p/${current}  [${row.audience}${portal?.paused ? ', PAUSED' : ''}]  ${portal?.description ?? ''}`,
					)
					console.log(`  ${'-'.repeat(60)}`)
				}
				console.log(
					`  ${row.access.padEnd(6)}  ${row.entityId.replace(/^e-/, '').padEnd(20)}  ${fieldName(row.fieldId)}`,
				)
			}
			console.log('')
		}
	}

	// 2. Manifest integrity — generated/ejected files match their recorded hash.
	const fs = createNodeFs(project.appPath)

	// 1c. No orphaned slots — the "no dangling slots" gate at block
	// granularity, and the mirror image of the harness's dangling-*reference*
	// count. Block slot ids are a public API: once a maintainer has written
	// `exercise__row`, renaming the field it names or dropping the page stops
	// calling their code. Nothing errors; the bespoke UI simply disappears from
	// an otherwise-working app, which is the worst possible failure mode for a
	// seam whose entire promise is "safe to write into". So it fails the gate,
	// loudly, and names the fix.
	{
		const filled: Record<string, string[]> = {}
		for (const page of spec.pages.pages) {
			if (!page.entityId) continue
			const resource = page.entityId.replace(/^e-/, '')
			if (filled[resource]) continue
			const file = pageFilePaths(resource).slotFile
			filled[resource] = (await fs.exists(file))
				? exportedSlotNames(await fs.read(file))
				: []
		}
		const orphans = orphanedSlots(spec, filled)
		for (const orphan of orphans) {
			failures.push(
				`orphaned slot "${orphan.id}" in ${pageFilePaths(orphan.resource).slotFile}: ${orphan.reason}. ` +
					'Restore the field/page it renders, or delete the export (run `maxstack slots` to see what is available).',
			)
		}
		if (orphans.length === 0) console.log('✔ no orphaned slots')
	}
	if (await fs.exists(MANIFEST_FILENAME)) {
		const manifest = parseManifest(await fs.read(MANIFEST_FILENAME))
		const before = failures.length
		// The set difference this check was missing (#338). Everything below only
		// ever verified the entries it *found* — that each one's file exists and
		// still hashes to what was recorded — so `manifest intact: N tracked files`
		// passed happily on a manifest tracking a route for an entity the spec had
		// dropped three runs earlier. A stale entry is a perfectly intact entry;
		// what makes it wrong is that nothing in the spec justifies it, and that is
		// a question about correspondence, not integrity. One set difference, and
		// it would have caught this the first time `gen` ran after the deletion.
		//
		// `generated` only: an `ejected` or `user` module with no page behind it is
		// a supported state the drift report calls `underived`, not a defect —
		// pruning deliberately leaves those alone, so failing on them would be a
		// gate nobody could ever get green.
		const live = new Set(
			pageDescriptors(spec.pages.pages, spec.data.entities).map((d) =>
				pageModuleKey(d),
			),
		)
		for (const entry of manifest.entries) {
			if (entry.ownership !== 'generated') continue
			if (!isRouteModuleEntry(entry) || live.has(entry.id)) continue
			failures.push(
				`stale route: ${entry.file} serves ${entry.routePath}, but no page in the spec declares it. ` +
					'It is in the route table and will 500 on a resource the app no longer has. ' +
					'Regeneration prunes it — run "maxstack gen" (this run\'s regen pass already has; re-run to confirm).',
			)
		}
		// The same set difference for the seam registries (#355). Scoped to the
		// case that regeneration cannot fix by itself: while one declaration
		// survives, the registry is re-emitted from the live descriptors and the
		// retired key is gone. It is the *last* one that used to persist forever,
		// because every seam generator early-returns on an empty descriptor list
		// and an early return writes nothing. A registry left behind is not inert
		// like a stale route — the runtime imports it through
		// `owned.generated.tsx`, so its handlers stay resolvable to the job queue.
		for (const family of seamFamilies(spec)) {
			if (family.registryContent !== undefined) continue
			const entry = manifest.entries.find((e) => e.id === family.registryId)
			if (entry?.ownership !== 'generated') continue
			failures.push(
				`stale ${family.noun} registry: ${entry.file} is still tracked and still imported by the runtime, ` +
					`but the spec declares no ${family.noun} that needs one. Every ${family.stub} it names stays resolvable. ` +
					'Regeneration prunes it — run "maxstack gen".',
			)
		}
		for (const entry of manifest.entries) {
			if (entry.ownership !== 'generated' || !entry.hash) continue
			if (!(await fs.exists(entry.file))) {
				failures.push(`missing generated file: ${entry.file}`)
				continue
			}
			if (hashContent(await fs.read(entry.file)) !== entry.hash) {
				failures.push(
					`drift: ${entry.file} no longer matches the generator (eject it or run "maxstack gen")`,
				)
			}
		}
		if (failures.length === before) {
			console.log(
				`✔ manifest intact: ${manifest.entries.length} tracked files, all declared by the spec`,
			)
		}
	} else {
		console.log('· app is runtime-derived; no generated route tree expected')
	}

	// 3. Regen-safety — a regeneration must not clobber anything the user owns.
	const { writes } = await generateProject(project)
	if (isRegenStable(writes)) {
		console.log('✔ regeneration stable (never-clobber holds)')
	} else {
		const unsafe = writes.filter(
			(w) => w.action !== 'unchanged' && w.action !== 'skipped-user-owned',
		)
		for (const w of unsafe) failures.push(`unsafe regen ${w.action}: ${w.file}`)
	}

	// 4. The project's own gate over the code the maintainer owns.
	//
	// Everything above this line reads the spec and the manifest — not one line
	// of owned code. `run_checks` had the same hole, and the same consequence: a
	// green that means "the spec is fine and nobody looked at your app". So the
	// checks run here, and — the half that matters — anything that CANNOT run is
	// printed as unexamined and withholds the green, rather than being omitted.
	// This is the `workbench` house rule (an `unavailable` list, and no all-clear
	// while something went unchecked) applied to the gate that claims most.
	const runner = await projectCheckRunner(project)
	const shellChecks = runner.list().filter((c) => c.name !== 'spec-validate')
	for (const check of shellChecks) {
		const [result] = await runner.run(spec, [check.name])
		if (!result) continue
		if (result.ok) console.log(`✔ ${result.name} passed`)
		else failures.push(`${result.name} failed:\n${indent(result.output)}`)
	}
	const allUnavailable = (await runner.unavailable?.()) ?? []
	// Only the blocking ones withhold the green: a project that owns
	// no code yet has nothing for typecheck/lint/test to examine, and failing a
	// scaffold on op zero teaches an agent to ignore this whole report. The
	// non-blocking ones are still printed — just under what they are.
	const unavailable = allUnavailable.filter((u) => u.blocking !== false)
	const notApplicable = allUnavailable.filter((u) => u.blocking === false)

	if (failures.length) {
		console.error(`\n✖ validate failed:`)
		for (const f of failures) console.error(`  - ${f}`)
		printUnavailable(unavailable)
		process.exitCode = 1
		return
	}
	if (unavailable.length > 0) {
		// Deliberately NOT green, and deliberately not a failure either. Calling it
		// green would be the lie; calling it a failure would punish a project for a
		// script it never claimed to have. It is incomplete, it says which parts,
		// and it exits non-zero so nothing downstream treats it as a pass.
		console.error(`\n⚠ validate INCOMPLETE — not a green.`)
		printUnavailable(unavailable)
		printNotApplicable(notApplicable)
		process.exitCode = 1
		return
	}
	printNotApplicable(notApplicable)
	console.log('\n✔ validate gate green')
}

function indent(text: string): string {
	return text
		.split('\n')
		.map((l) => `      ${l}`)
		.join('\n')
}

function printUnavailable(unavailable: UnavailableCheck[]): void {
	if (unavailable.length === 0) return
	console.error(
		`\n  ${unavailable.length} check(s) never ran — that code is unexamined:`,
	)
	for (const u of unavailable) {
		console.error(`  - ${u.name}: ${u.reason}`)
		if (u.remedy) console.error(`      ${u.remedy}`)
	}
}

/**
 * The checks that had nothing to examine. Printed, never dropped —
 * the point is that the maintainer can see the gate will start demanding them
 * the moment there is owned code — but on stdout and without withholding the
 * green, because there is nothing here to act on.
 */
function printNotApplicable(notApplicable: UnavailableCheck[]): void {
	if (notApplicable.length === 0) return
	console.log(
		`· ${notApplicable.map((u) => u.name).join(', ')} not run — this project owns no code yet (they become required as soon as it does)`,
	)
}
