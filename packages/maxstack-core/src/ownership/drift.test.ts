import { describe, expect, it } from 'vitest'
import {
	BLOCK_SLOT_ROLES_VERSION,
	blockSlotsForResource,
} from './block-slots.ts'
import {
	driftSummaryLine,
	formatOwnershipDrift,
	ownershipDrift,
} from './drift.ts'
import { emitResourcePage, type PageDescriptor } from './emit.ts'
import {
	fillBlockSlot,
	generateResourcePage,
	pageFilePaths,
} from './generate.ts'
import {
	MANIFEST_FILENAME,
	parseManifest,
	serializeManifest,
} from './manifest.ts'
import { createMemFs } from './memfs.ts'
import { type RegenTarget, regenerateAsDiff } from './regen.ts'
import { eject, writeGenerated } from './write.ts'

const TASK: PageDescriptor = {
	resource: 'task',
	title: 'Tasks',
	routePath: '/admin/tasks',
	slots: [],
}

/** What the generator would emit for a descriptor — the "current derivation". */
function targetFor(descriptor: PageDescriptor): RegenTarget {
	return {
		id: descriptor.resource,
		file: pageFilePaths(descriptor.resource).routeFile,
		routePath: descriptor.routePath,
		nextContent: emitResourcePage(descriptor),
	}
}

/** A project with `task` generated and then ejected in place. */
async function ejectedProject() {
	const fs = createMemFs()
	await generateResourcePage(fs, TASK)
	const manifest = parseManifest(await fs.read(MANIFEST_FILENAME))
	const ejected = await eject(
		fs,
		manifest,
		'task',
		pageFilePaths('task').routeFile,
	)
	// `eject` is pure w.r.t. the manifest — it returns the new one and the caller
	// persists it, exactly as `ejectCommand` does. Skipping this is how a project
	// ends up with an ejected file the on-disk manifest still calls `generated`,
	// which the next regeneration would overwrite.
	await fs.write(MANIFEST_FILENAME, serializeManifest(ejected.manifest))
	return { fs, manifest: ejected.manifest }
}

describe('ownershipDrift', () => {
	it('reports nothing when nothing is owned', async () => {
		const fs = createMemFs()
		const { manifest } = await generateResourcePage(fs, TASK)
		const report = await ownershipDrift(fs, manifest, [targetFor(TASK)])
		expect(report.ownedCount).toBe(0)
		expect(formatOwnershipDrift(report)).toContain('You own nothing yet')
		expect(driftSummaryLine(report)).toBeUndefined()
	})

	it('an in-place eject already counts as drift — by exactly the banner', async () => {
		const { fs, manifest } = await ejectedProject()
		// Eject rewrote the banner in place, so the file is deliberately NOT
		// byte-identical to the generated module — which is the honest answer: it
		// has already diverged, by exactly the banner.
		const report = await ownershipDrift(fs, manifest, [targetFor(TASK)])
		expect(report.ownedCount).toBe(1)
		expect(report.owned[0]?.ownership).toBe('ejected')
		expect(report.owned[0]?.status).toBe('drifted')
		expect(report.owned[0]?.patch).toContain('EJECTED — you own this file now')
	})

	it('is byte-exact: an identical file reports in-sync with an empty patch', async () => {
		const fs = createMemFs()
		let manifest = parseManifest('{"version":1,"entries":[]}')
		const content = emitResourcePage(TASK)
		const written = await writeGenerated(
			fs,
			manifest,
			{
				id: 'task',
				routePath: TASK.routePath,
				file: pageFilePaths('task').routeFile,
			},
			content,
		)
		manifest = {
			...written.manifest,
			entries: written.manifest.entries.map((e) => ({
				...e,
				ownership: 'ejected' as const,
			})),
		}
		const report = await ownershipDrift(fs, manifest, [targetFor(TASK)])
		expect(report.owned[0]?.status).toBe('in-sync')
		expect(report.owned[0]?.patch).toBe('')
		expect(report.driftedCount).toBe(0)
		expect(driftSummaryLine(report)).toBeUndefined()
	})

	it('a filled slot is "authored", not drifted — the generator never derives it again', async () => {
		const fs = createMemFs()
		const withSlot: PageDescriptor = { ...TASK, slots: ['toolbar'] }
		const { manifest } = await generateResourcePage(fs, withSlot)
		// The maintainer writes real code into it.
		const slotFile = pageFilePaths('task').slotFile
		await fs.write(slotFile, 'export function toolbar() { return null }\n')

		const report = await ownershipDrift(fs, manifest, [targetFor(withSlot)])
		const slot = report.owned.find((o) => o.file === slotFile)
		expect(slot?.ownership).toBe('user')
		expect(slot?.status).toBe('authored')
		expect(slot?.patch).toBe('')
		// Diffing a filled slot against its stub would manufacture drift out of the
		// feature working, which is the fastest way to make a report nobody reads.
		expect(report.driftedCount).toBe(0)
	})

	it('reports a file whose page left the spec as underived, not as an error', async () => {
		const { fs, manifest } = await ejectedProject()
		const report = await ownershipDrift(fs, manifest, [])
		expect(report.owned[0]?.status).toBe('underived')
		expect(report.owned[0]?.family).toBe('page')
		expect(report.owned[0]?.explanation).toContain('no longer in the spec')
		expect(report.underivedCount).toBe(1)
	})

	it('reports a tracked file that is not on disk', async () => {
		const { manifest } = await ejectedProject()
		const empty = createMemFs()
		const report = await ownershipDrift(empty, manifest, [targetFor(TASK)])
		expect(report.owned[0]?.status).toBe('missing')
		expect(report.missingCount).toBe(1)
		expect(driftSummaryLine(report)).toContain('not on disk')
	})
})

describe('what a file was derived from, per family', () => {
	// The bug this closes: `underived` explained itself as "the page this was
	// generated for is no longer in the spec" for EVERY id, including the four
	// seams that never came from a page. A maintainer who ejected a schedule
	// registry was told the platform lost track of a page they never had.
	it.each([
		['schedules:registry', 'schedule', 'no schedule declares this'],
		[
			'schedule:invoice.recurring:slot',
			'schedule',
			'no schedule declares this',
		],
		['sources:registry', 'source', 'no source declares this'],
		['source:inbox.sync:slot', 'source', 'no source declares this'],
		['imports:registry', 'import', 'no importer declares this'],
		['import:anki.apkg:slot', 'import', 'no importer declares this'],
		['live:registry', 'live', 'no live channel declares this'],
		['live:task-board:slot', 'live', 'no live channel declares this'],
	])('explains %s in the terms of its own seam', async (id, family, said) => {
		const fs = createMemFs()
		await fs.write('jobs/whatever.ts', '// mine now\n')
		const manifest = {
			version: 1 as const,
			entries: [
				{
					id,
					routePath: '',
					file: 'jobs/whatever.ts',
					ownership: 'ejected' as const,
				},
			],
		}
		const report = await ownershipDrift(fs, manifest, [])
		expect(report.owned[0]?.status).toBe('underived')
		expect(report.owned[0]?.family).toBe(family)
		expect(report.owned[0]?.explanation).toContain(said)
		// The thing that must never be said about a file that never came from one.
		expect(report.owned[0]?.explanation).not.toContain('the page this was')
	})

	it('does not guess at a namespace it does not know', async () => {
		const fs = createMemFs()
		await fs.write('weird.ts', '// mine\n')
		const report = await ownershipDrift(
			fs,
			{
				version: 1,
				entries: [
					{
						id: 'plugin:acme:thing',
						routePath: '',
						file: 'weird.ts',
						ownership: 'ejected',
					},
				],
			},
			[],
		)
		expect(report.owned[0]?.family).toBe('other')
		expect(report.owned[0]?.explanation).toContain(
			'derives nothing under this id',
		)
	})

	// The second soft edge: a `user` file is always `authored` and can never be
	// diffed — correct, and it used to mean the report said nothing at all when
	// the props its slots are called with changed underneath it.
	it('says so when a filled slot was authored against an older role version', async () => {
		const fs = createMemFs()
		const withSlot: PageDescriptor = { ...TASK, slots: ['toolbar'] }
		const { manifest } = await generateResourcePage(fs, withSlot)
		const slotFile = pageFilePaths('task').slotFile
		const stale = {
			...manifest,
			entries: manifest.entries.map((e) =>
				e.file === slotFile ? { ...e, rolesVersion: 0 } : e,
			),
		}

		const report = await ownershipDrift(fs, stale, [targetFor(withSlot)])
		const slot = report.owned.find((o) => o.file === slotFile)
		// Still authored, still never diffed, still nothing to apply — the version
		// is the only thing compared.
		expect(slot?.status).toBe('authored')
		expect(slot?.patch).toBe('')
		expect(slot?.rolesDrift).toEqual({ authored: 0, current: 1 })
		expect(slot?.explanation).toContain('block-slot roles v0')
		expect(report.rolesDriftCount).toBe(1)
		expect(report.driftedCount).toBe(0)
		expect(driftSummaryLine(report)).toContain('older block-slot role version')
	})

	it('a slot file with no recorded version is silence, not v0', async () => {
		const fs = createMemFs()
		const withSlot: PageDescriptor = { ...TASK, slots: ['toolbar'] }
		const { manifest } = await generateResourcePage(fs, withSlot)
		const report = await ownershipDrift(fs, manifest, [targetFor(withSlot)])
		const slot = report.owned.find(
			(o) => o.file === pageFilePaths('task').slotFile,
		)
		expect(slot?.rolesDrift).toBeUndefined()
		expect(report.rolesDriftCount).toBe(0)
	})

	it('records the role version a block-slot fill was authored against', async () => {
		const fs = createMemFs()
		const { manifest } = await generateResourcePage(fs, TASK)
		const slot = blockSlotsForResource('task')[0]
		if (!slot) throw new Error('no block slots on a resource — impossible')
		const filled = await fillBlockSlot(fs, manifest, 'task', slot)
		const entry = filled.manifest.entries.find(
			(e) => e.file === pageFilePaths('task').slotFile,
		)
		expect(entry?.rolesVersion).toBe(BLOCK_SLOT_ROLES_VERSION)
	})
})

describe('the "needs your attention" path', () => {
	// The case the issue calls out as rare, and therefore the one that will be
	// wrong if untested: an upgrade that genuinely needs to change something the
	// user owns. The platform must surface it as a reviewable diff with an
	// explanation — never apply it, and never silently skip it and leave the
	// project in a state that no longer matches the framework around it.
	it('surfaces a breaking derivation change as a diff, and applies none of it', async () => {
		const { fs } = await ejectedProject()
		const before = await fs.read(pageFilePaths('task').routeFile)

		// The breaking upgrade: the page is renamed and moved. Both change what the
		// generator emits for this resource, so the ejected copy is now genuinely
		// behind — this is not cosmetic drift, it is the route the rest of the app
		// links to.
		const upgraded: PageDescriptor = {
			...TASK,
			title: 'Work items',
			routePath: '/admin/work-items',
		}
		const regen = await generateResourcePage(fs, upgraded)

		// 1. Nothing was applied. The file is byte-identical.
		expect(await fs.read(pageFilePaths('task').routeFile)).toBe(before)
		expect(regen.results[0]?.action).toBe('skipped-user-owned')

		// 2. Nothing was silently skipped either — the regeneration review says the
		//    file is protected, and *why*.
		const review = await regenerateAsDiff(fs, regen.manifest, [
			targetFor(upgraded),
		])
		expect(review.files[0]?.status).toBe('protected')
		expect(review.files[0]?.protectedReason).toBe('ejected')

		// 3. …and the drift report is where the reviewable diff and the explanation
		//    live. "Protected" alone tells you the file is safe and says nothing
		//    about what moved underneath it.
		const drift = await ownershipDrift(fs, regen.manifest, [
			targetFor(upgraded),
		])
		const entry = drift.owned[0]
		expect(entry?.status).toBe('drifted')
		expect(entry?.patch).toContain('Work items')
		expect(entry?.patch).toContain('current derivation')
		expect(entry?.patch).toContain('your file')
		expect(entry?.behind).toBeGreaterThan(0)
		expect(entry?.explanation).toContain('Nothing will be applied')

		// 4. The one line a command may print about it — a pointer, not a wall.
		const line = driftSummaryLine(drift)
		expect(line).toContain('maxstack drift')
		expect(line?.split('\n')).toHaveLength(1)
	})

	it('never writes: the report is a read of the filesystem', async () => {
		const { fs, manifest } = await ejectedProject()
		const snapshot = fs.snapshot()
		await ownershipDrift(fs, manifest, [targetFor(TASK)])
		expect([...fs.snapshot()]).toEqual([...snapshot])
	})
})

describe('formatOwnershipDrift', () => {
	it('reads as information rather than as a demand', async () => {
		const { fs, manifest } = await ejectedProject()
		const report = await ownershipDrift(fs, manifest, [targetFor(TASK)])
		const text = formatOwnershipDrift(report)
		expect(text).toContain('1 owned file(s)')
		expect(text).toContain(
			'Drift is not a problem to fix. It is the cost of owning a file',
		)
		// Patches are opt-in: the default report is a summary, not a diff dump.
		expect(text).not.toContain('@@')
		expect(formatOwnershipDrift(report, { patches: true })).toContain('@@')
	})
})
