/**
 * `Scheduler` — the bridge from a **declared** schedule to the
 * durable job runtime.
 *
 * It owns exactly one decision: *which occurrences are due, and have they been
 * claimed yet.* Everything else is deliberately somebody else's job —
 * `@maxstack/spec`'s `nextOccurrence` computes the calendar (pure, testable,
 * DST-defined), `JobQueue` owns retries and dead-lettering, and the user's
 * handler slot owns what the work actually is.
 *
 * ## Why one job per occurrence, keyed
 *
 * Each occurrence becomes exactly one job whose idempotency key is
 * `schedule:<key>:<occurrence ISO>`. That single design choice buys three
 * properties that are otherwise separate features:
 *
 *  - **Restart safety.** A process that dies mid-tick re-enqueues the same
 *    occurrences on the way back up, and the unique index turns the repeats
 *    into no-ops.
 *  - **Multi-process safety.** Two workers ticking simultaneously produce one
 *    job per occurrence, not two. The database arbitrates; no leader election,
 *    no lock table.
 *  - **A run history that is just the job table.** "Did the 31 March run
 *    happen?" is a lookup on `(schedule_key, scheduled_for)`, not a join
 *    against a second table that can disagree with the first.
 *
 * ## Catch-up is bounded, and the bound is visible
 *
 * A process down for a day, on a one-minute schedule, must not enqueue 1440
 * jobs when it returns. `catchUpLimit` keeps the most recent occurrences and
 * drops the stale ones; {@link ScheduleTick.skipped} reports how many were
 * dropped, so the gap shows up in the run history rather than being absorbed in
 * silence. A missed run you can see is an operational fact; a missed run you
 * cannot is a data-integrity mystery.
 */

import {
	activeSchedules,
	nextOccurrence,
	occurrencesBetween,
	type ScheduleRunAs,
	type ScheduleSpec,
	type SpecSystem,
} from '@maxstack/spec'
import {
	type JobQueue,
	type JobRecord,
	PermanentJobError,
	type ScheduleHandler,
} from './service.ts'

/** The job type every scheduled run is enqueued under. */
export const SCHEDULED_JOB_TYPE = 'schedule.run'

/** The payload a scheduled job carries — everything the slot needs. */
export interface ScheduledJobPayload {
	scheduleKey: string
	scheduledForIso: string
}

/** The idempotency key for one occurrence. Stable, and readable in a log. */
export function occurrenceKey(scheduleKey: string, at: Date): string {
	return `schedule:${scheduleKey}:${at.toISOString()}`
}

/** What one schedule did on one tick. */
export interface ScheduleTick {
	scheduleKey: string
	/** Occurrences enqueued (or matched to an existing claim) this tick. */
	enqueued: JobRecord[]
	/** Occurrences dropped because the catch-up bound was reached. */
	skipped: number
}

export interface SchedulerOptions {
	queue: JobQueue
	/**
	 * How the scheduler reads the declarations. A function rather than a value
	 * because the spec is live: a schedule paused ten seconds ago must stop
	 * firing without a restart.
	 */
	schedules: () => ScheduleSpec[] | Promise<ScheduleSpec[]>
	/** Most occurrences one schedule may catch up in a single tick. */
	catchUpLimit?: number
}

export class Scheduler {
	private readonly queue: JobQueue
	private readonly read: SchedulerOptions['schedules']
	private readonly catchUpLimit: number
	/**
	 * In-process watermark per schedule: the instant of the last tick.
	 *
	 * The durable watermark is the job table (`lastScheduledFor`), which is what
	 * makes catch-up survive a restart. This map covers the one case the table
	 * cannot: a schedule that has *never* fired has no rows to read, so without
	 * it every tick would start over from `now` and a schedule whose first
	 * occurrence falls between two ticks would never fire at all. A schedule with
	 * no history also has nothing to lose if the process dies, which is why an
	 * in-memory value is sufficient here and a second table is not.
	 */
	private readonly watermark = new Map<string, Date>()
	private timer: ReturnType<typeof setInterval> | null = null

	constructor(opts: SchedulerOptions) {
		this.queue = opts.queue
		this.read = opts.schedules
		this.catchUpLimit = opts.catchUpLimit ?? 10
	}

	/**
	 * Enqueue every occurrence that has fallen due by `now`.
	 *
	 * `now` is a parameter, never `new Date()` inside the loop: a scheduler you
	 * cannot ask "what would you have done at 03:00 on the 31st" is a scheduler
	 * whose behavior is only observable in production.
	 */
	async tick(now: Date = new Date()): Promise<ScheduleTick[]> {
		const schedules = await this.read()
		const ticks: ScheduleTick[] = []
		for (const schedule of schedules) {
			if (schedule.paused) continue
			const since = await this.since(schedule, now)
			const occurrences = occurrencesBetween(
				schedule,
				since,
				now,
				this.catchUpLimit,
			)
			// How many we would have run without the bound — reported, not hidden.
			const total = countOccurrences(schedule, since, now, this.catchUpLimit)
			const enqueued: JobRecord[] = []
			for (const at of occurrences) {
				enqueued.push(
					await this.queue.enqueue({
						type: SCHEDULED_JOB_TYPE,
						payload: {
							scheduleKey: schedule.key,
							scheduledForIso: at.toISOString(),
						} satisfies ScheduledJobPayload,
						idempotencyKey: occurrenceKey(schedule.key, at),
						runAs: schedule.runAs,
						scheduleKey: schedule.key,
						scheduledFor: at,
					}),
				)
			}
			this.watermark.set(schedule.key, now)
			ticks.push({
				scheduleKey: schedule.key,
				enqueued,
				skipped: Math.max(0, total - occurrences.length),
			})
		}
		return ticks
	}

	/**
	 * The instant to start looking from.
	 *
	 * A schedule the runtime has never fired starts at `now` — **not** at its
	 * declaration date. Backfilling from `declaredAt` would mean declaring a
	 * daily job on a spec written a year ago fires 365 times the moment somebody
	 * installs it, which is how a scheduling feature becomes an incident.
	 */
	private async since(schedule: ScheduleSpec, now: Date): Promise<Date> {
		const durable = await this.lastScheduledFor(schedule.key)
		const inProcess = this.watermark.get(schedule.key)
		if (durable && inProcess)
			return durable.getTime() > inProcess.getTime() ? durable : inProcess
		return durable ?? inProcess ?? now
	}

	private async lastScheduledFor(key: string): Promise<Date | null> {
		const rows = await this.queue.list({ scheduleKey: key, limit: 1 })
		return rows[0]?.scheduledFor ?? null
	}

	/** Start ticking every `intervalMs`. Returns an idempotent `stop()`. */
	start(intervalMs = 30_000): () => void {
		if (this.timer) return () => this.stop()
		this.timer = setInterval(() => {
			void this.tick()
		}, intervalMs)
		return () => this.stop()
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
	}
}

/** How many occurrences fall in `(since, now]`, up to `cap * 4`. */
function countOccurrences(
	schedule: ScheduleSpec,
	since: Date,
	now: Date,
	cap: number,
): number {
	let count = 0
	let cursor = since
	// Bounded: this only exists to report the size of a gap, and "more than
	// four times the catch-up bound" is already the answer the operator needs.
	for (let i = 0; i < cap * 4; i++) {
		const next = nextOccurrence(schedule, cursor)
		if (!next || next.getTime() > now.getTime()) break
		count++
		cursor = next
	}
	return count
}

/** One occurrence, as the platform's own occurrence-driven work sees it. */
export interface ScheduleOccurrence {
	scheduleKey: string
	scheduledFor: Date
	idempotencyKey: string
	runAs: ScheduleRunAs
}

export interface ScheduleHandlerOptions {
	/**
	 * Work the *platform* drives off an occurrence, before the user's slot runs.
	 *
	 * Today that is exactly one thing: the declared source syncs a schedule
	 * triggers (`{ kind: 'schedule' }` in issue #173's `SourceTrigger`). Those
	 * are not the maintainer's code to write — the declaration is the whole
	 * implementation — so a schedule that exists only to drive a sync must not
	 * demand a handler file nobody has any content for.
	 *
	 * It returns **how many units of work it enqueued**, and that number is what
	 * decides whether an unfilled slot is an error. A schedule the platform
	 * handled is handled; a schedule nothing claimed is still a missing decision
	 * and still dead-letters naming the file to create. Reporting a count rather
	 * than a boolean keeps that judgement here instead of in every caller.
	 */
	onOccurrence?: (occurrence: ScheduleOccurrence) => Promise<number>
}

/**
 * Wire a queue to run declared schedules through the generated handler
 * registry (`jobs/schedules.generated.ts`).
 *
 * A schedule with no filled slot fails **loudly and immediately** rather than
 * burning its retry budget first: an unfilled slot is a missing decision, not a
 * flaky downstream, and three exponentially-backed-off attempts only delay the
 * message by half a minute. The one exception is a schedule whose occurrence the
 * platform itself claimed — see {@link ScheduleHandlerOptions.onOccurrence}.
 */
export function registerScheduleHandlers(
	queue: JobQueue,
	handlers: Record<string, ScheduleHandler>,
	opts: ScheduleHandlerOptions = {},
): void {
	queue.register<ScheduledJobPayload>(
		SCHEDULED_JOB_TYPE,
		async (payload, ctx) => {
			const handler = handlers[payload.scheduleKey]
			// Before the missing-handler check, because whether a missing handler is
			// an error depends on the answer: a schedule declared purely to drive a
			// source sync has no file for anybody to fill in.
			if (!ctx.runAs) {
				throw new PermanentJobError(
					`Schedule "${payload.scheduleKey}" reached the worker with no runAs — ` +
						'refusing to run it with ambient authority',
				)
			}
			const occurrence: ScheduleOccurrence = {
				scheduleKey: payload.scheduleKey,
				scheduledFor: new Date(payload.scheduledForIso),
				idempotencyKey: ctx.idempotencyKey ?? '',
				runAs: ctx.runAs,
			}
			const claimed = (await opts.onOccurrence?.(occurrence)) ?? 0
			if (!handler) {
				if (claimed > 0) return { enqueued: claimed }
				throw new PermanentJobError(
					`Schedule "${payload.scheduleKey}" has no handler — fill its slot in ` +
						`jobs/${payload.scheduleKey.replace(/[^a-z0-9]+/gi, '-')}.handler.ts`,
				)
			}
			await handler({ ...occurrence, attempt: ctx.attempt })
		},
	)
}

/** The active (accepted, unpaused) schedules of a spec — the scheduler's input. */
export function schedulesOf(
	spec: Pick<SpecSystem, 'schedules'>,
): ScheduleSpec[] {
	return activeSchedules(spec)
}
