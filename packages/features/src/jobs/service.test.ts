import type { drizzle } from 'drizzle-orm/pglite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePglite } from '../testing/pglite-fixture.ts'
import { createDrizzleJobStore } from './drizzle-store.ts'
import { JOBS_DDL } from './schema.ts'
import {
	backoffMs,
	createMemoryJobStore,
	JobQueue,
	scheduleInterval,
} from './service.ts'

describe('JobQueue (memory store)', () => {
	it('enqueue → tick runs the registered handler and marks succeeded', async () => {
		const queue = new JobQueue({ store: createMemoryJobStore() })
		const seen: unknown[] = []
		queue.register('greet', (payload) => {
			seen.push(payload)
			return { ok: true }
		})
		const job = await queue.enqueue({ type: 'greet', payload: { name: 'Ada' } })
		expect(job.status).toBe('pending')

		const claimed = await queue.tick()
		expect(claimed).toBe(true)
		expect(seen).toEqual([{ name: 'Ada' }])

		const [row] = await queue.list()
		expect(row?.status).toBe('succeeded')
		expect(row?.result).toEqual({ ok: true })
	})

	it('tick() returns false when nothing is due', async () => {
		const queue = new JobQueue({ store: createMemoryJobStore() })
		expect(await queue.tick()).toBe(false)
	})

	it('a job with no registered handler dead-letters immediately', async () => {
		const queue = new JobQueue({ store: createMemoryJobStore() })
		await queue.enqueue({ type: 'unknown-type' })
		await queue.tick()
		const [row] = await queue.list()
		expect(row?.status).toBe('failed')
		expect(row?.error).toMatch(/no handler/i)
	})

	it('retries a failing handler with backoff, then dead-letters after maxAttempts', async () => {
		const queue = new JobQueue({ store: createMemoryJobStore() })
		let calls = 0
		queue.register('flaky', () => {
			calls++
			throw new Error('boom')
		})
		await queue.enqueue({ type: 'flaky', maxAttempts: 2 })

		await queue.tick()
		let [row] = await queue.list()
		expect(row?.status).toBe('pending')
		expect(row?.attempts).toBe(1)
		expect(row?.error).toBe('boom')
		expect(row?.availableAt.getTime()).toBeGreaterThan(Date.now() - 1)

		// Not due yet (backoff hasn't elapsed) — a tick right now claims nothing.
		expect(await queue.tick()).toBe(false)
		expect(calls).toBe(1)

		// Force the retry to be due, then let it exhaust its budget.
		const store = queue as unknown as {
			store: ReturnType<typeof createMemoryJobStore>
		}
		const pending = store.store.jobs[0]
		if (!pending) throw new Error('expected a pending job row')
		pending.availableAt = new Date(0)
		await queue.tick()
		;[row] = await queue.list()
		expect(row?.status).toBe('failed')
		expect(row?.attempts).toBe(2)
		expect(calls).toBe(2)
	})

	it('backoffMs grows exponentially and caps at 30s', () => {
		expect(backoffMs(1)).toBe(1000)
		expect(backoffMs(2)).toBe(2000)
		expect(backoffMs(3)).toBe(4000)
		expect(backoffMs(10)).toBe(30_000)
	})

	it('start/stop runs tick on an interval and is idempotent', async () => {
		vi.useFakeTimers()
		const queue = new JobQueue({ store: createMemoryJobStore() })
		let ran = 0
		queue.register('tick-type', () => {
			ran++
		})
		await queue.enqueue({ type: 'tick-type' })
		const stop = queue.start(10)
		const stopAgain = queue.start(10) // second start() before stop() is a no-op
		await vi.advanceTimersByTimeAsync(10)
		expect(ran).toBe(1)
		stop()
		stopAgain()
		vi.useRealTimers()
	})

	it('scheduleInterval enqueues a job of `type` on every tick', async () => {
		vi.useFakeTimers()
		const queue = new JobQueue({ store: createMemoryJobStore() })
		const stop = scheduleInterval(queue, {
			type: 'heartbeat',
			intervalMs: 100,
		})
		await vi.advanceTimersByTimeAsync(250)
		stop()
		const rows = await queue.list({ type: 'heartbeat' })
		expect(rows.length).toBeGreaterThanOrEqual(2)
		vi.useRealTimers()
	})
})

describe('JobQueue (drizzle store)', () => {
	// Scoped to this block: the memory-store cases above need no database, and
	// registering the fixture here keeps them from paying for one.
	const pg = usePglite(JOBS_DDL)
	let db: ReturnType<typeof drizzle>

	beforeEach(() => {
		db = pg.db
	})

	it('persists jobs and runs the handler via the drizzle-backed store', async () => {
		const queue = new JobQueue({ store: createDrizzleJobStore(db) })
		queue.register('export', () => ({ csv: 'a,b\n1,2' }))
		await queue.enqueue({ type: 'export', payload: { resource: 'widget' } })

		await queue.tick()
		const [row] = await queue.list()
		expect(row?.status).toBe('succeeded')
		expect(row?.result).toEqual({ csv: 'a,b\n1,2' })
	})
})
