/**
 * Determinism with declared recurrence (gating requirement:
 * *"jobs must not break determinism: generation output cannot depend on whether
 * a job has run."*).
 *
 * maxstack meets it in the stronger form. Generation reads the **declaration**
 * and nothing else: not the job table, not the run history, not whether the
 * schedule is paused. So there is one branch rather than two kept in step.
 *
 * That property is easy to assert and easy to silently lose — the day somebody
 * threads "hide the handler stub for a paused schedule" into the generator, it
 * dies with every other test still green. So this file pins it against a corpus
 * app (`invoicer`, whose frozen `ch-recurring-invoices` ask is the reason this
 * primitive exists) and pins it in the direction that catches the regression:
 * specs whose *runtime* behavior genuinely differs must emit identical trees.
 *
 * The corpus app is cloned and scheduled here rather than in `examples/src/`
 * for the reason `flag-determinism.test.ts` gives: the frozen backlog is a
 * measuring instrument, and this test needs a realistic spec, not a scored one.
 */

import { invoicerExample } from '@maxstack/examples'
import { createMemFs, generateSchedules } from '@maxstack/core/ownership'
import {
	createMemoryJobStore,
	JobQueue,
	occurrenceKey,
} from '@maxstack/features/jobs'
import { specToScheduleDescriptors } from '@maxstack/spec-derive'
import {
	activeSchedules,
	type ApplyMeta,
	applyOp,
	nextOccurrence,
	type SpecSystem,
} from '@maxstack/spec'
import { describe, expect, it } from 'vitest'

const meta = (n: number): ApplyMeta => ({
	actor: { surface: 'harness' },
	id: `op-sch-${n}`,
	origin: 'human',
	appliedAt: '2026-07-27',
})

/** The corpus app with a monthly invoice run declared. */
function scheduledCorpusApp(opts: { paused?: boolean } = {}): SpecSystem {
	const entity = invoicerExample.spec.data.entities.find(
		(e) => e.id === 'e-invoice',
	)
	if (!entity) throw new Error('invoicer benchmark has no invoice entity')
	let spec = applyOp(
		structuredClone(invoicerExample.spec),
		{
			op: 'schedules.declare',
			args: {
				schedule: {
					id: 'sch-invoice-recurring',
					key: 'invoice.recurring',
					description: 'Issue and send the recurring invoices for the period.',
					timezone: 'America/New_York',
					recurrence: { kind: 'monthly', onDayOfMonth: 31, atTime: '09:00' },
					runAs: { kind: 'service', role: 'billing' },
					entityId: 'e-invoice',
				},
			},
		},
		meta(1),
	)
	if (opts.paused)
		spec = applyOp(
			spec,
			{
				op: 'schedules.pause',
				args: { scheduleId: 'sch-invoice-recurring', paused: true },
			},
			meta(2),
		)
	return spec
}

/** The generated scheduling seam for a spec, as a file map. */
async function generateSeam(spec: SpecSystem): Promise<Map<string, string>> {
	const fs = createMemFs()
	await generateSchedules(fs, specToScheduleDescriptors(spec))
	return fs.snapshot()
}

describe('determinism with declared recurrence', () => {
	it('emits the same tree whether or not the schedule has ever run', async () => {
		// The literal requirement. Two runtimes: one that has never ticked, one
		// with a full run history including a dead letter. Same declaration ⇒ same
		// files, because the generator cannot reach a job row at all.
		const spec = scheduledCorpusApp()
		const before = await generateSeam(spec)

		const store = createMemoryJobStore()
		const queue = new JobQueue({ store })
		const schedule = activeSchedules(spec)[0]
		if (!schedule) throw new Error('expected an active schedule')
		const at = nextOccurrence(schedule, new Date('2026-01-01T00:00:00Z'))
		if (!at) throw new Error('expected an occurrence')
		await queue.enqueue({
			type: 'schedule.run',
			scheduleKey: schedule.key,
			scheduledFor: at,
			idempotencyKey: occurrenceKey(schedule.key, at),
			runAs: schedule.runAs,
		})
		await queue.tick() // no handler ⇒ dead-letters, the noisiest possible state
		expect(await queue.deadLetter()).toHaveLength(1)

		expect(await generateSeam(spec)).toEqual(before)
	})

	it('a paused schedule emits the same tree as a running one', async () => {
		// Pausing is a *runtime* fact. If it moved the generated tree, then every
		// on-call pause would produce a regeneration diff to review at 3am, and
		// resuming would produce another.
		const running = scheduledCorpusApp()
		const paused = scheduledCorpusApp({ paused: true })
		// Not vacuous: the two specs genuinely disagree about what fires.
		expect(activeSchedules(running)).toHaveLength(1)
		expect(activeSchedules(paused)).toHaveLength(0)
		expect(await generateSeam(paused)).toEqual(await generateSeam(running))
	})

	it('regenerating the same spec twice is byte-identical', async () => {
		const spec = scheduledCorpusApp()
		expect(await generateSeam(spec)).toEqual(await generateSeam(spec))
	})

	it('a project with no declared schedule grows no scheduling files at all', async () => {
		expect([...(await generateSeam(invoicerExample.spec)).keys()]).toEqual([])
	})
})
