/**
 * The gating clauses of issue #181, as tests:
 *
 *  - at-least-once, with an idempotency key that actually stops a duplicate;
 *  - a run runs as *somebody*, and refuses to run when it does not know who;
 *  - retries, dead-letter visibility, and a bounded catch-up whose gap is
 *    reported rather than absorbed.
 */

import { manual, type ScheduleSpec } from '@maxstack/spec'
import { describe, expect, it } from 'vitest'
import {
	occurrenceKey,
	registerScheduleHandlers,
	SCHEDULED_JOB_TYPE,
	Scheduler,
} from './scheduler.ts'
import {
	createMemoryJobStore,
	JobQueue,
	PermanentJobError,
	type ScheduleHandlerContext,
} from './service.ts'

const schedule = (overrides: Partial<ScheduleSpec> = {}): ScheduleSpec => ({
	id: 'sch-digest',
	key: 'digest.daily',
	description: 'Send the daily digest',
	timezone: 'UTC',
	recurrence: { kind: 'interval', everyMinutes: 60 },
	runAs: { kind: 'service', role: 'notifier' },
	declaredAt: '2026-03-01',
	provenance: manual(),
	...overrides,
})

const setup = (schedules: ScheduleSpec[], catchUpLimit = 10) => {
	const store = createMemoryJobStore()
	const queue = new JobQueue({ store })
	const scheduler = new Scheduler({
		queue,
		schedules: () => schedules,
		catchUpLimit,
	})
	return { store, queue, scheduler }
}

describe('idempotency — the at-least-once contract', () => {
	it('a second enqueue with the same key returns the first row, not a second job', async () => {
		const store = createMemoryJobStore()
		const queue = new JobQueue({ store })
		const first = await queue.enqueue({ type: 'x', idempotencyKey: 'k1' })
		const second = await queue.enqueue({ type: 'x', idempotencyKey: 'k1' })
		expect(second.id).toBe(first.id)
		expect(store.jobs).toHaveLength(1)
	})

	it('resolves a genuine race in the store, not in the application', async () => {
		// Both callers read "absent" and both insert. The store raises the same
		// unique violation Postgres would; the loser must read the winner back
		// rather than throw — this is the property that makes a multi-process
		// scheduler safe without a lock table.
		const store = createMemoryJobStore()
		const queue = new JobQueue({ store })
		const [a, b] = await Promise.all([
			queue.enqueue({ type: 'x', idempotencyKey: 'race' }),
			queue.enqueue({ type: 'x', idempotencyKey: 'race' }),
		])
		expect(a.id).toBe(b.id)
		expect(store.jobs).toHaveLength(1)
	})

	it('gives the handler the key, so a retry can be made a no-op', async () => {
		const store = createMemoryJobStore()
		const queue = new JobQueue({ store })
		const seen: (string | null)[] = []
		queue.register('x', (_p, ctx) => {
			seen.push(ctx.idempotencyKey)
			if (seen.length === 1) throw new Error('transient')
		})
		await queue.enqueue({ type: 'x', idempotencyKey: 'k' })
		await queue.tick()
		// The retry is scheduled behind a backoff; make it due.
		await store.update(store.jobs[0]?.id ?? '', { availableAt: new Date(0) })
		await queue.tick()
		expect(seen).toEqual(['k', 'k'])
		expect(store.jobs[0]?.status).toBe('succeeded')
	})
})

describe('failure handling', () => {
	it('retries with backoff, then dead-letters', async () => {
		const store = createMemoryJobStore()
		const queue = new JobQueue({ store })
		queue.register('x', () => {
			throw new Error('always')
		})
		await queue.enqueue({ type: 'x', maxAttempts: 2 })
		await queue.tick()
		expect(store.jobs[0]?.status).toBe('pending')
		expect(store.jobs[0]?.availableAt.getTime()).toBeGreaterThan(Date.now())

		await store.update(store.jobs[0]?.id ?? '', { availableAt: new Date(0) })
		await queue.tick()
		expect(store.jobs[0]?.status).toBe('failed')
		expect(store.jobs[0]?.deadLetteredAt).not.toBeNull()
		expect(await queue.deadLetter()).toHaveLength(1)
	})

	it('does not spend a retry budget on a permanent failure', async () => {
		const store = createMemoryJobStore()
		const queue = new JobQueue({ store })
		queue.register('x', () => {
			throw new PermanentJobError('nobody filled the slot')
		})
		await queue.enqueue({ type: 'x', maxAttempts: 5 })
		await queue.tick()
		expect(store.jobs[0]?.status).toBe('failed')
		expect(store.jobs[0]?.attempts).toBe(1)
	})

	it('dead-letters a job with no handler immediately and says which type', async () => {
		const store = createMemoryJobStore()
		const queue = new JobQueue({ store })
		await queue.enqueue({ type: 'nope' })
		await queue.tick()
		expect(store.jobs[0]?.error).toMatch(/No handler registered.*"nope"/)
		expect(store.jobs[0]?.deadLetteredAt).not.toBeNull()
	})

	it('retry grants exactly one more attempt, not an unbounded loop', async () => {
		const store = createMemoryJobStore()
		const queue = new JobQueue({ store })
		let calls = 0
		queue.register('x', () => {
			calls++
			throw new Error('still broken')
		})
		await queue.enqueue({ type: 'x', maxAttempts: 1 })
		await queue.tick()
		expect(store.jobs[0]?.status).toBe('failed')

		await queue.retry(store.jobs[0]?.id ?? '')
		await queue.tick()
		expect(calls).toBe(2)
		// Back in the dead-letter queue rather than looping.
		expect(store.jobs[0]?.status).toBe('failed')
		expect(await queue.deadLetter()).toHaveLength(1)
	})
})

describe('Scheduler — declared recurrence becomes jobs', () => {
	it('enqueues nothing on the first tick — a new schedule does not backfill', async () => {
		// Declaring a daily job on a spec written a year ago must not fire 365
		// times the moment somebody installs it.
		const { scheduler, store } = setup([schedule()])
		await scheduler.tick(new Date('2027-01-01T00:00:00Z'))
		expect(store.jobs).toHaveLength(0)
	})

	it('enqueues one job per occurrence, carrying the schedule’s identity', async () => {
		const { scheduler, store } = setup([schedule()])
		await scheduler.tick(new Date('2026-03-01T00:00:00Z'))
		await scheduler.tick(new Date('2026-03-01T02:00:00Z'))
		expect(store.jobs).toHaveLength(2)
		for (const job of store.jobs) {
			expect(job.type).toBe(SCHEDULED_JOB_TYPE)
			expect(job.scheduleKey).toBe('digest.daily')
			expect(job.runAs).toEqual({ kind: 'service', role: 'notifier' })
			expect(job.idempotencyKey).toBe(
				occurrenceKey('digest.daily', job.scheduledFor as Date),
			)
		}
	})

	it('re-ticking the same window enqueues nothing — restart safety', async () => {
		const { scheduler, store } = setup([schedule()])
		await scheduler.tick(new Date('2026-03-01T00:00:00Z'))
		await scheduler.tick(new Date('2026-03-01T03:00:00Z'))
		const count = store.jobs.length
		await scheduler.tick(new Date('2026-03-01T03:00:00Z'))
		await scheduler.tick(new Date('2026-03-01T03:00:00Z'))
		expect(store.jobs).toHaveLength(count)
	})

	it('a paused schedule fires nothing', async () => {
		const { scheduler, store } = setup([schedule({ paused: true })])
		await scheduler.tick(new Date('2026-03-01T00:00:00Z'))
		await scheduler.tick(new Date('2026-03-05T00:00:00Z'))
		expect(store.jobs).toHaveLength(0)
	})

	it('bounds catch-up after an outage and REPORTS the gap', async () => {
		const { scheduler, store } = setup([schedule()], 3)
		await scheduler.tick(new Date('2026-03-01T00:00:00Z'))
		// Twelve hours of a one-hour schedule missed; only three catch up.
		const ticks = await scheduler.tick(new Date('2026-03-01T12:00:00Z'))
		expect(store.jobs).toHaveLength(3)
		expect(ticks[0]?.skipped).toBe(9)
		// …and the ones kept are the RECENT ones, not the stale end.
		const latest = store.jobs
			.map((j) => (j.scheduledFor as Date).toISOString())
			.sort()
		expect(latest.at(-1)).toBe('2026-03-01T12:00:00.000Z')
	})
})

describe('the handler slot', () => {
	const registerAndRun = async (
		handlers: Record<string, (ctx: ScheduleHandlerContext) => void>,
	) => {
		const { queue, scheduler, store } = setup([schedule()])
		registerScheduleHandlers(queue, handlers)
		await scheduler.tick(new Date('2026-03-01T00:00:00Z'))
		await scheduler.tick(new Date('2026-03-01T01:00:00Z'))
		await queue.tick()
		return store
	}

	it('calls the slot with the occurrence it was due for, not the wall clock', async () => {
		let seen: ScheduleHandlerContext | undefined
		await registerAndRun({
			'digest.daily': (ctx) => {
				seen = ctx
			},
		})
		expect(seen?.scheduledFor.toISOString()).toBe('2026-03-01T01:00:00.000Z')
		expect(seen?.runAs).toEqual({ kind: 'service', role: 'notifier' })
		expect(seen?.idempotencyKey).toBe(
			'schedule:digest.daily:2026-03-01T01:00:00.000Z',
		)
		expect(seen?.attempt).toBe(1)
	})

	it('an unfilled slot dead-letters at once and names the file to create', async () => {
		const store = await registerAndRun({})
		const job = store.jobs[0]
		expect(job?.status).toBe('failed')
		expect(job?.attempts).toBe(1)
		expect(job?.error).toMatch(/jobs\/digest-daily\.handler\.ts/)
	})

	// Issue #236: a schedule declared purely to drive a declared source sync has
	// no file for anybody to fill in, so demanding one would make the honest
	// declaration the broken one.
	it('an unfilled slot is fine when the platform claimed the occurrence', async () => {
		const { queue, scheduler, store } = setup([schedule()])
		const claimed: string[] = []
		registerScheduleHandlers(
			queue,
			{},
			{
				onOccurrence: async (occurrence) => {
					claimed.push(occurrence.scheduledFor.toISOString())
					return 2
				},
			},
		)
		await scheduler.tick(new Date('2026-03-01T00:00:00Z'))
		await scheduler.tick(new Date('2026-03-01T01:00:00Z'))
		await queue.tick()
		expect(claimed).toEqual(['2026-03-01T01:00:00.000Z'])
		expect(store.jobs[0]?.status).toBe('succeeded')
	})

	it('claiming nothing still dead-letters — a count, not a hook’s presence', async () => {
		const { queue, scheduler, store } = setup([schedule()])
		registerScheduleHandlers(queue, {}, { onOccurrence: async () => 0 })
		await scheduler.tick(new Date('2026-03-01T00:00:00Z'))
		await scheduler.tick(new Date('2026-03-01T01:00:00Z'))
		await queue.tick()
		expect(store.jobs[0]?.status).toBe('failed')
		expect(store.jobs[0]?.error).toMatch(/jobs\/digest-daily\.handler\.ts/)
	})
})
