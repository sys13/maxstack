/**
 * `JobQueue` — the durable background-job runtime behind the `jobs` bundle
 *.
 *
 * `enqueue()` writes a row via the injected `JobStore` (in-memory or
 * drizzle-backed, the same store-agnostic shape `MeterService`'s `UsageStore`
 * and `audit`'s `AuditSink` use); a poll-based worker loop (`start`/`tick`)
 * claims due rows and runs the registered handler for their `type`, with
 * exponential-backoff retry up to `maxAttempts` before dead-lettering.
 *
 * ## Delivery is at-least-once, and this file says so on purpose
 *
 * Exactly-once is a lie in a job system. Between "the handler did the work" and
 * "the store recorded that it did" there is a window, and a process that dies
 * inside it leaves a row that looks exactly like one whose handler never ran.
 * The runtime cannot tell those apart, so it retries — which means a handler
 * can and will see the same work twice.
 *
 * What the platform owes you in exchange is a **stable idempotency key**, and
 * that is what {@link EnqueueInput.idempotencyKey} is. It is enforced by a
 * unique index, not by an application check, so:
 *
 *  - two processes racing to enqueue the same occurrence produce **one** row;
 *  - the loser reads the winner's row back rather than erroring;
 *  - a handler that keys its writes on `ctx.idempotencyKey` turns a repeat into
 *    a no-op.
 *
 * A billing bundle that double-sends because we were vague about this is a very
 * expensive bug, so the semantics are in the handler's type, in the generated
 * handler stub, and in the bundle's own docs — three places nobody can miss.
 */

import type { ScheduleRunAs } from '@maxstack/spec'

export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed'

export interface JobRecord {
	id: string
	type: string
	payload: unknown
	status: JobStatus
	attempts: number
	maxAttempts: number
	result: unknown
	error: string | null
	/** The at-most-one-job claim; `null` for fire-and-forget work. */
	idempotencyKey: string | null
	/** Whose authority this run carries; `null` for internal plumbing. */
	runAs: ScheduleRunAs | null
	/** The declared schedule this run is an occurrence of, if any. */
	scheduleKey: string | null
	/** Which occurrence — the fire instant, not the run instant. */
	scheduledFor: Date | null
	/** Set when the retry budget ran out; `null` while there is still hope. */
	deadLetteredAt: Date | null
	availableAt: Date
	createdAt: Date
	updatedAt: Date
}

export interface EnqueueInput {
	type: string
	payload?: unknown
	maxAttempts?: number
	/**
	 * A stable key for *this piece of work*. A second enqueue with the same key
	 * returns the first row instead of creating a second one — enforced by a
	 * unique index, so it holds across processes and across restarts.
	 */
	idempotencyKey?: string
	/** Whose authority the run carries. Required for scheduled work. */
	runAs?: ScheduleRunAs
	scheduleKey?: string
	scheduledFor?: Date
	/** Delay the first attempt until this instant (default: now). */
	availableAt?: Date
}

/**
 * The storage abstraction a `JobQueue` is constructed with — swap in
 * `createDrizzleJobStore` for a persisted queue, `createMemoryJobStore` for
 * tests/dev, same as `UsageStore`/`AuditSink`.
 */
export interface JobStore {
	/**
	 * Insert a job. Rejects with a {@link DuplicateIdempotencyKeyError} (or any
	 * unique-violation the backend raises — {@link isUniqueViolation} normalizes
	 * it) when the row's `idempotencyKey` is already taken. The queue catches
	 * that and reads the winner back, so the race resolves in the database.
	 */
	insert(job: JobRecord): Promise<void>
	/** The job holding `key`, or `null`. */
	findByIdempotencyKey(key: string): Promise<JobRecord | null>
	/** Atomically-enough (single-process) claim the oldest `'pending'` row
	 * whose `availableAt <= now`, flipping it to `'running'` and returning it
	 * — or `null` if nothing is due. */
	claimNext(now: Date): Promise<JobRecord | null>
	update(id: string, patch: Partial<JobRecord>): Promise<void>
	list(opts?: {
		limit?: number
		type?: string
		scheduleKey?: string
		deadLetteredOnly?: boolean
	}): Promise<JobRecord[]>
	/** The latest occurrence already enqueued for `scheduleKey`, or `null`. */
	lastScheduledFor(scheduleKey: string): Promise<Date | null>
}

/** What a handler is called with. */
export interface JobHandlerContext {
	job: JobRecord
	/** 1-based: the first run is attempt 1, the first retry is attempt 2. */
	attempt: number
	/**
	 * The stable key for this work, when the enqueuer supplied one.
	 *
	 * **This is the tool for at-least-once.** Key your writes on it and a repeat
	 * becomes a no-op; ignore it and a retry becomes a duplicate.
	 */
	idempotencyKey: string | null
	/** The identity to do the work under — never assume admin. */
	runAs: ScheduleRunAs | null
	scheduleKey: string | null
	scheduledFor: Date | null
}

export type JobHandler<TPayload = unknown, TResult = unknown> = (
	payload: TPayload,
	ctx: JobHandlerContext,
) => Promise<TResult> | TResult

/**
 * The context a **schedule handler slot** receives — the typed extension point
 * a declared schedule calls. Narrower than {@link
 * JobHandlerContext} because everything on it is guaranteed present: a
 * scheduled run always knows its key, its occurrence, and who it runs as.
 *
 * This is the type the generated `jobs/<key>.handler.ts` stub imports, so the
 * delivery contract arrives with the file rather than in a doc.
 */
export interface ScheduleHandlerContext {
	scheduleKey: string
	/** The occurrence this run is for — *not* `new Date()`. A catch-up run after
	 * an outage fires with the instant it was due, so a handler that buckets by
	 * period buckets correctly. */
	scheduledFor: Date
	/** Stable per occurrence. See {@link JobHandlerContext.idempotencyKey}. */
	idempotencyKey: string
	runAs: ScheduleRunAs
	attempt: number
}

export type ScheduleHandler = (
	ctx: ScheduleHandlerContext,
) => Promise<void> | void

/**
 * A failure that will not get better on its own — a missing handler, a missing
 * identity, a malformed payload. Thrown by a handler, it skips the retry budget
 * and dead-letters at once.
 *
 * Backoff exists to ride out a flaky downstream. Spending three exponentially
 * delayed attempts on a decision nobody has made yet does not improve the odds;
 * it only delays the message by half a minute and buries the real cause under
 * two identical retries.
 */
export class PermanentJobError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'PermanentJobError'
	}
}

/** Raised by a store when an `idempotencyKey` is already taken. */
export class DuplicateIdempotencyKeyError extends Error {
	readonly key: string

	constructor(key: string) {
		super(`A job already holds idempotency key "${key}"`)
		this.name = 'DuplicateIdempotencyKeyError'
		this.key = key
	}
}

/**
 * Whether an error is a unique-constraint violation. Postgres reports `23505`;
 * the in-memory store throws {@link DuplicateIdempotencyKeyError}. Both mean the
 * same thing to the caller — somebody else won the claim — so the queue treats
 * them identically instead of letting the backend leak into the control flow.
 */
export function isUniqueViolation(err: unknown): boolean {
	if (err instanceof DuplicateIdempotencyKeyError) return true
	const code = (err as { code?: unknown } | null)?.code
	if (code === '23505') return true
	const message = err instanceof Error ? err.message : String(err)
	return /unique|duplicate key/i.test(message)
}

let counter = 0
const nextId = (prefix: string) =>
	`${prefix}-${Date.now().toString(36)}-${++counter}`

/** Exponential backoff for retry `n` (1-indexed): 1s, 2s, 4s, 8s, capped at 30s. */
export function backoffMs(attempt: number): number {
	return Math.min(30_000, 500 * 2 ** attempt)
}

export class JobQueue {
	private readonly store: JobStore
	private readonly handlers = new Map<string, JobHandler>()
	private timer: ReturnType<typeof setInterval> | null = null

	constructor(opts: { store: JobStore }) {
		this.store = opts.store
	}

	/** Register the handler that runs for every job of `type`. Re-registering
	 * a type replaces its handler (last write wins) — handy for HMR. */
	register<TPayload = unknown, TResult = unknown>(
		type: string,
		handler: JobHandler<TPayload, TResult>,
	): void {
		this.handlers.set(type, handler as JobHandler)
	}

	/** Whether a handler is registered for `type`. */
	handles(type: string): boolean {
		return this.handlers.has(type)
	}

	/**
	 * Enqueue a job, or return the existing one holding the same
	 * `idempotencyKey`.
	 *
	 * The check is a *fallback* for the common case; correctness comes from the
	 * unique index. Two processes that both read "no row" and both insert will
	 * still produce one row, because the second insert loses and re-reads.
	 */
	async enqueue(input: EnqueueInput): Promise<JobRecord> {
		const key = input.idempotencyKey ?? null
		if (key) {
			const existing = await this.store.findByIdempotencyKey(key)
			if (existing) return existing
		}
		const now = new Date()
		const record: JobRecord = {
			id: nextId('job'),
			type: input.type,
			payload: input.payload ?? null,
			status: 'pending',
			attempts: 0,
			maxAttempts: input.maxAttempts ?? 3,
			result: null,
			error: null,
			idempotencyKey: key,
			runAs: input.runAs ?? null,
			scheduleKey: input.scheduleKey ?? null,
			scheduledFor: input.scheduledFor ?? null,
			deadLetteredAt: null,
			availableAt: input.availableAt ?? now,
			createdAt: now,
			updatedAt: now,
		}
		try {
			await this.store.insert(record)
		} catch (err) {
			if (key && isUniqueViolation(err)) {
				const winner = await this.store.findByIdempotencyKey(key)
				if (winner) return winner
			}
			throw err
		}
		return record
	}

	/** Claim + run one due job, if any. Returns `true` iff a job was claimed
	 * (whether it then succeeded or failed) — `false` means the queue is idle. */
	async tick(): Promise<boolean> {
		const claimed = await this.store.claimNext(new Date())
		if (!claimed) return false

		const handler = this.handlers.get(claimed.type)
		if (!handler) {
			// A job with no handler is not a transient failure, so it does not get a
			// retry budget: it dead-letters immediately and loudly. The usual cause
			// is a declared schedule whose handler slot was never filled, and burning
			// three attempts before saying so just delays the message.
			await this.store.update(claimed.id, {
				status: 'failed',
				error: `No handler registered for job type "${claimed.type}"`,
				deadLetteredAt: new Date(),
				updatedAt: new Date(),
			})
			return true
		}

		const attempt = claimed.attempts + 1
		try {
			const result = await handler(claimed.payload, {
				job: claimed,
				attempt,
				idempotencyKey: claimed.idempotencyKey,
				runAs: claimed.runAs,
				scheduleKey: claimed.scheduleKey,
				scheduledFor: claimed.scheduledFor,
			})
			await this.store.update(claimed.id, {
				status: 'succeeded',
				attempts: attempt,
				result: result ?? null,
				error: null,
				updatedAt: new Date(),
			})
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			const permanent = err instanceof PermanentJobError
			if (!permanent && attempt < claimed.maxAttempts) {
				await this.store.update(claimed.id, {
					status: 'pending',
					attempts: attempt,
					error: message,
					availableAt: new Date(Date.now() + backoffMs(attempt)),
					updatedAt: new Date(),
				})
			} else {
				await this.store.update(claimed.id, {
					status: 'failed',
					attempts: attempt,
					error: message,
					deadLetteredAt: new Date(),
					updatedAt: new Date(),
				})
			}
		}
		return true
	}

	/** Start the poll loop: `tick()` every `intervalMs`, draining one due job
	 * per tick. Returns a `stop()` — idempotent, safe to call from an
	 * HMR-guarded singleton getter. */
	start(intervalMs = 500): () => void {
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

	async list(opts?: {
		limit?: number
		type?: string
		scheduleKey?: string
	}): Promise<JobRecord[]> {
		return this.store.list(opts)
	}

	/**
	 * The dead-letter view: jobs that exhausted their retries and are now a
	 * human's problem. A queue without this is a queue whose failures are
	 * invisible until someone asks why the invoices stopped.
	 */
	async deadLetter(opts?: { limit?: number }): Promise<JobRecord[]> {
		return this.store.list({ ...opts, deadLetteredOnly: true })
	}

	/**
	 * Give a dead-lettered job exactly one more attempt.
	 *
	 * `maxAttempts` moves to `attempts + 1` rather than resetting to zero, so a
	 * job that is genuinely broken cannot be looped back into the queue forever
	 * by an impatient operator — each retry is a deliberate, single, recorded
	 * decision. The attempt history is preserved, which is what the run history
	 * is for.
	 */
	async retry(id: string): Promise<void> {
		const [row] = await this.store
			.list({ limit: 1_000 })
			.then((rows) => rows.filter((r) => r.id === id))
		if (!row) throw new Error(`Unknown job "${id}"`)
		await this.store.update(id, {
			status: 'pending',
			maxAttempts: row.attempts + 1,
			deadLetteredAt: null,
			availableAt: new Date(),
			updatedAt: new Date(),
		})
	}
}

/**
 * Register a recurring job of `type` on `queue`, enqueued every `intervalMs`.
 *
 * The **undeclared** scheduling primitive — a plain `setInterval` with no
 * declaration, no timezone, no run history and no identity. Kept because a few
 * pieces of internal plumbing (the retention purge, the digest sweep) genuinely
 * are app-wide chores rather than product behavior, but new product scheduling
 * belongs in `schedules.declare` + {@link Scheduler}, which is reviewable,
 * timezone-correct, and runs as somebody.
 */
export function scheduleInterval(
	queue: JobQueue,
	opts: { type: string; payload?: unknown; intervalMs: number },
): () => void {
	const timer = setInterval(() => {
		void queue.enqueue({ type: opts.type, payload: opts.payload })
	}, opts.intervalMs)
	return () => clearInterval(timer)
}

/** In-memory `JobStore` — tests/dev, mirrors `createMemoryAuditSink`'s shape
 * (the array is exposed for assertions). */
export function createMemoryJobStore(): JobStore & { jobs: JobRecord[] } {
	const jobs: JobRecord[] = []
	return {
		jobs,
		async insert(job) {
			if (
				job.idempotencyKey !== null &&
				jobs.some((j) => j.idempotencyKey === job.idempotencyKey)
			) {
				// Same failure mode the unique index produces, so the queue's race
				// handling is exercised by the in-memory tests rather than only in
				// production.
				throw new DuplicateIdempotencyKeyError(job.idempotencyKey)
			}
			jobs.push(job)
		},
		async findByIdempotencyKey(key) {
			return jobs.find((j) => j.idempotencyKey === key) ?? null
		},
		async claimNext(now) {
			const due = jobs
				.filter((j) => j.status === 'pending' && j.availableAt <= now)
				.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
			const next = due[0]
			if (!next) return null
			next.status = 'running'
			next.updatedAt = new Date()
			return { ...next }
		},
		async update(id, patch) {
			const row = jobs.find((j) => j.id === id)
			if (row) Object.assign(row, patch)
		},
		async list(opts) {
			let filtered = jobs
			if (opts?.type) filtered = filtered.filter((j) => j.type === opts.type)
			if (opts?.scheduleKey)
				filtered = filtered.filter((j) => j.scheduleKey === opts.scheduleKey)
			if (opts?.deadLetteredOnly)
				filtered = filtered.filter((j) => j.deadLetteredAt !== null)
			const sorted = [...filtered].sort(
				(a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
			)
			return opts?.limit ? sorted.slice(0, opts.limit) : sorted
		},
		async lastScheduledFor(scheduleKey) {
			const times = jobs
				.filter((j) => j.scheduleKey === scheduleKey && j.scheduledFor)
				.map((j) => (j.scheduledFor as Date).getTime())
			return times.length ? new Date(Math.max(...times)) : null
		},
	}
}
