/**
 * Pruning the four non-page seams (issue #355) — the unit half. `apps/maxstack`'s
 * `generate.test.ts` drives the whole declare → generate → undeclare →
 * regenerate cycle through a real project; what is pinned here is the decision
 * table, because a seam's write-once half is hand-written domain logic and the
 * cost of getting the table wrong is somebody's code.
 *
 * Schedules stand in for all four families: they share one implementation
 * (`pruneSeams` over a `SeamFamily`), and the per-family part — which
 * declarations open a slot at all — is `seamFamilies`' job, tested where it
 * lives.
 */

import { describe, expect, it } from 'vitest'
import { MANIFEST_FILENAME, parseManifest } from './manifest.ts'
import { createMemFs, type MemFs } from './memfs.ts'
import { pruneSeams, type SeamFamily } from './prune.ts'
import { generateSchedules, type ScheduleDescriptor } from './schedules.ts'
import { eject } from './write.ts'

const SWEEP: ScheduleDescriptor = {
	key: 'invoice.sweep',
	description: 'Charge what is due',
	runAs: 'the system',
	recurrence: 'every night',
}
const DIGEST: ScheduleDescriptor = {
	key: 'digest.daily',
	description: 'Send the daily digest',
	runAs: 'the system',
	recurrence: 'every morning',
}

const schedules = (...keys: string[]): SeamFamily[] => [
	{
		noun: 'schedule',
		stub: 'handler',
		registryId: 'schedules:registry',
		stubPrefix: 'schedule:',
		liveKeys: keys,
	},
]

/** A project with both schedules generated, as `maxstack gen` would leave it. */
async function generated(): Promise<MemFs> {
	const fs = createMemFs()
	await generateSchedules(fs, [SWEEP, DIGEST])
	return fs
}

const manifestOf = async (fs: MemFs) =>
	parseManifest(await fs.read(MANIFEST_FILENAME))

const REGISTRY = 'jobs/schedules.generated.ts'
const SWEEP_HANDLER = 'jobs/invoice-sweep.handler.ts'

describe('pruneSeams', () => {
	it('is a no-op while every declared key survives', async () => {
		const fs = await generated()
		const before = fs.snapshot()

		const { results } = await pruneSeams(
			fs,
			schedules('invoice.sweep', 'digest.daily'),
		)

		expect(results).toEqual([])
		expect(fs.snapshot()).toEqual(before)
	})

	/**
	 * The case regeneration already handled: one declaration of two goes away, the
	 * registry is re-emitted from the survivor alone, and pruning's only job is to
	 * say out loud that a file on disk is now unreachable. Nothing is deleted —
	 * the handler is the maintainer's code, which is the entire point of a seam.
	 */
	it('keeps an undeclared handler and reports it unwired', async () => {
		const fs = await generated()
		await fs.write(SWEEP_HANDLER, '// the SM-2 maths, by hand\n')

		const { results } = await pruneSeams(fs, schedules('digest.daily'))

		expect(results).toEqual([
			expect.objectContaining({ file: SWEEP_HANDLER, action: 'kept-owned' }),
		])
		expect(await fs.read(SWEEP_HANDLER)).toContain('by hand')
		// The manifest keeps tracking it: it is a file the maintainer owns, and
		// the drift report speaks about it off this entry.
		expect((await manifestOf(fs)).entries.map((e) => e.id)).toContain(
			'schedule:invoice.sweep:slot',
		)
	})

	/**
	 * The actual bug. Every seam generator early-returns on an empty descriptor
	 * list — "no declaration, no directory" — so undeclaring the *last* schedule
	 * wrote nothing, and the registry survived intact with every retired handler
	 * still in it. The manifest entry is what `owned.generated.tsx` keys off, so
	 * the runtime kept importing it and the job queue kept resolving handlers for
	 * work the spec had stopped declaring.
	 */
	it('deletes the registry once the last declaration goes', async () => {
		const fs = await generated()

		const { results } = await pruneSeams(fs, schedules())

		expect(results).toContainEqual(
			expect.objectContaining({ file: REGISTRY, action: 'deleted' }),
		)
		expect(await fs.exists(REGISTRY)).toBe(false)
		// The safety-critical half: without the entry nothing imports it.
		expect((await manifestOf(fs)).entries.map((e) => e.id)).not.toContain(
			'schedules:registry',
		)
		// The handlers survive — both of them, untouched.
		expect(await fs.exists(SWEEP_HANDLER)).toBe(true)
		expect(await fs.exists('jobs/digest-daily.handler.ts')).toBe(true)
	})

	it('is idempotent — a second pass finds nothing left to do', async () => {
		const fs = await generated()
		await pruneSeams(fs, schedules())
		const before = fs.snapshot()

		const { results } = await pruneSeams(fs, schedules())

		// The handlers still report as unwired (they are still on disk and still
		// undeclared) but nothing else moves.
		expect(results.every((r) => r.action === 'kept-owned')).toBe(true)
		expect(fs.snapshot()).toEqual(before)
	})

	it('unwires but does NOT delete a registry somebody edited', async () => {
		const fs = await generated()
		await fs.write(REGISTRY, `${await fs.read(REGISTRY)}\n// mine now\n`)

		const { results } = await pruneSeams(fs, schedules())

		expect(results).toContainEqual(
			expect.objectContaining({ file: REGISTRY, action: 'unwired' }),
		)
		// Manifest entry gone, so the runtime stops importing it …
		expect((await manifestOf(fs)).entries.map((e) => e.id)).not.toContain(
			'schedules:registry',
		)
		// … and the work is not destroyed.
		expect(await fs.read(REGISTRY)).toContain('// mine now')
	})

	it('leaves an ejected registry and its manifest entry completely alone', async () => {
		const fs = await generated()
		const ejected = await eject(
			fs,
			await manifestOf(fs),
			'schedules:registry',
			REGISTRY,
		)
		await fs.write(
			MANIFEST_FILENAME,
			`${JSON.stringify(ejected.manifest, null, '\t')}\n`,
		)

		const { results } = await pruneSeams(fs, schedules())

		expect(results).toContainEqual(
			expect.objectContaining({ file: REGISTRY, action: 'kept-owned' }),
		)
		expect(await fs.exists(REGISTRY)).toBe(true)
		expect((await manifestOf(fs)).entries.map((e) => e.id)).toContain(
			'schedules:registry',
		)
	})

	/**
	 * The one entry pruning does drop: a handler the maintainer has already
	 * deleted. Nothing exists for never-clobber to protect, nothing in the spec
	 * asks for it, and keeping it would make `gen` report the same dead file on
	 * every run with no way for the maintainer to make it stop.
	 */
	it('drops the entry for an undeclared handler already deleted from disk', async () => {
		const fs = await generated()
		await fs.remove(SWEEP_HANDLER)

		const { results } = await pruneSeams(fs, schedules('digest.daily'))

		expect(results).toEqual([])
		expect((await manifestOf(fs)).entries.map((e) => e.id)).not.toContain(
			'schedule:invoice.sweep:slot',
		)
		// The declared one is untouched.
		expect((await manifestOf(fs)).entries.map((e) => e.id)).toContain(
			'schedule:digest.daily:slot',
		)
	})
})
