/**
 * Sources on the job queue — where "failure is normal" is actually
 * implemented, and where the health an app shows comes from.
 *
 * ## Why enrichment is queued and never inline
 *
 * The obvious implementation of "enrich on create" is to fetch inside the
 * create. It is also the one that makes a third party's outage into your own:
 * every book someone adds waits on somebody else's server, and when that server
 * stops answering, adding a book stops working. Queuing it decouples the two —
 * the create returns immediately with the row the person typed, and the
 * enrichment lands when it lands.
 *
 * ## Why the run history is the job table and not a `source_status` table
 *
 * The same argument issue #181 makes about schedules. A second table has to be
 * kept in step with the first, and "did the 09:00 sync run" then has two
 * answers that can disagree. Here every run is a job row already — with
 * attempts, the error, the dead-letter stamp and the timestamps — so
 * {@link sourceHealth} is a read over rows that exist rather than a projection
 * somebody has to remember to write.
 *
 * The retry budget the spec declares becomes the queue's: `maxAttempts` and a
 * doubling `backoffMs`. So a source that is down waits durably across a restart
 * instead of holding a worker for `maxAttempts × timeoutMs`.
 */

import type {
	EntitySpec,
	ScheduleRunAs,
	SourceSpec,
	SpecSystem,
} from '@maxstack/spec'
import { activeSources, listSources } from '@maxstack/spec'
import type { AuditEntry } from '../audit/audit-log.ts'
import type { JobQueue, JobRecord } from '../jobs/service.ts'
import { PermanentJobError } from '../jobs/service.ts'
import type { SourceRunDeps, SourceRunResult, SourceWrite } from './service.ts'
import { runEnrichment, runSync } from './service.ts'

/** The job type every source run is enqueued under. */
export const SOURCE_JOB_TYPE = 'source.run'

/**
 * Whether a committed write should trigger the enrichments its entity declares
 * — the loop guard, as a function of the write rather than of a convention
 *.
 *
 * A declared `enrich` source with an `update` trigger enqueues a run for every
 * committed update to its entity, and the run's own `opUpdate` **is** a
 * committed update to that entity. Without a guard it enriches its own output
 * forever, hammering a third party and burning the retry budget on a loop nobody
 * declared.
 *
 * The guard used to read `origin !== 'system'`, which was a true bound only for
 * as long as a source run was the one thing in the host process writing as
 * `system`. That is a property of a one-word convention: a future background
 * writer adopting the same origin for its own perfectly good reasons would
 * silently stop triggering enrichments, and the symptom — "our enrichment
 * stopped running" — points at nothing. `sourceKey` is stamped by the ops off
 * the identity a run borrows, so this asks the question the guard actually
 * means: *did a source's own run write this?*
 *
 * `resourceId` is required for the unrelated reason that an enrichment runs for
 * a row, and an entry that names no row names nothing to enrich.
 */
export function writeTriggersEnrichment<
	T extends Pick<AuditEntry, 'sourceKey' | 'resourceId'>,
>(entry: T): entry is T & { resourceId: string } {
	return !entry.sourceKey && Boolean(entry.resourceId)
}

/** The payload a source job carries. */
export interface SourceJobPayload {
	sourceKey: string
	/** The row being enriched; absent for a sync. */
	rowId?: string
}

/**
 * The idempotency key for one unit of source work.
 *
 * An enrichment is keyed on the row *and the trigger occurrence*, so two edits
 * to the same book in a minute enrich it twice (they may have fixed the ISBN),
 * while a retried job does not. A sync is keyed on the occurrence the schedule
 * produced, which is already unique per fire.
 */
export function sourceJobKey(
	sourceKey: string,
	occurrence: string,
	rowId?: string,
): string {
	return rowId
		? `source:${sourceKey}:${rowId}:${occurrence}`
		: `source:${sourceKey}:${occurrence}`
}

/**
 * What the caller does with the writes a run produced. This is the seam that
 * keeps this module from writing rows: the host supplies the same validated
 * write path a form posts to, and a source gets no privileges of its own.
 *
 * `runAs` is the authority the run *borrowed*, and it is a parameter rather
 * than something this module holds because a source has no `runAs` of its own
 * to hold. A schedule-driven sync borrows the schedule's; an enrichment borrows
 * the identity of whoever's write triggered it; a manual run borrows the
 * operator who pressed the button. That is the same statement as "a source gets
 * no privileges of its own", made structural: there is no path through this
 * module that reaches {@link SourceWriteApplier} without naming an identity
 * somebody else already had.
 */
export type SourceWriteApplier = (
	writes: readonly SourceWrite[],
	source: SourceSpec,
	runAs: ScheduleRunAs,
	/** The entity the run resolved — passed rather than re-looked-up, so the
	 * applier cannot translate the values against a different one. */
	entity: EntitySpec,
) => Promise<void>

export interface RegisterSourcesOptions extends SourceRunDeps {
	queue: JobQueue
	/** How the declarations are read. A function because the spec is live. */
	sources: () => SourceSpec[] | Promise<SourceSpec[]>
	/** The entity a source writes to, by id. May be async: the host reads it off
	 * a spec it loads, and loading is what keeps a paused/edited declaration from
	 * needing a restart. */
	entity: (
		entityId: string,
	) => EntitySpec | undefined | Promise<EntitySpec | undefined>
	/** Applies the intent through the app's own validated write path. */
	apply: SourceWriteApplier
	/**
	 * Reads the row an enrichment was triggered for — under the borrowed
	 * authority, never a privileged one. A row the triggering identity cannot
	 * read is a row this run does not get to fetch about.
	 */
	readRow?: (
		source: SourceSpec,
		rowId: string,
		runAs: ScheduleRunAs,
	) => Promise<(Record<string, unknown> & { id: string }) | null>
}

/**
 * Register the source handler on a queue.
 *
 * A run that fails *retryably* throws, so the queue applies the declared
 * backoff and eventually dead-letters — which is the visible end state an
 * operator needs. A run that fails un-retryably (a 404, a refused URL, a secret
 * the deployment never set) records the outcome and returns: burning three
 * attempts on a request that cannot succeed only delays the moment somebody
 * reads the reason.
 *
 * A job that reached the worker with no `runAs` is refused **before the fetch**,
 * on `registerScheduleHandlers`' rule and for its reason: there is no ambient
 * authority to fall back on, and the honest failure is a dead letter naming the
 * missing decision rather than a third-party request made as nobody.
 */
export function registerSourceHandlers(opts: RegisterSourcesOptions): void {
	const { queue, apply } = opts
	queue.register<SourceJobPayload>(SOURCE_JOB_TYPE, async (payload, jobCtx) => {
		const runAs = jobCtx.runAs
		if (!runAs)
			throw new PermanentJobError(
				`Source "${payload.sourceKey}" reached the worker with no runAs — ` +
					'refusing to run it with ambient authority',
			)
		const declared = await opts.sources()
		const source = declared.find((s) => s.key === payload.sourceKey)
		if (!source)
			// Not a PermanentJobError: a source can legitimately be removed while a
			// job for it is still in flight, and dead-lettering that is noise.
			return { skipped: 'no such source' }
		const entity = await opts.entity(source.entityId)
		if (!entity) return { skipped: 'no such entity' }

		let result: SourceRunResult
		if (source.mode === 'sync') {
			result = await runSync(source, entity, opts)
		} else {
			const rowId = payload.rowId
			if (!rowId) return { skipped: 'enrichment with no row' }
			const row = await opts.readRow?.(source, rowId, runAs)
			// The row may have been deleted between the trigger and the run. That is
			// ordinary, not an error.
			if (!row) return { skipped: 'row is gone' }
			result = await runEnrichment(source, entity, row, opts)
		}

		if (result.writes.length > 0)
			await apply(result.writes, source, runAs, entity)
		if (result.error?.retryable) throw new Error(result.error.message)
		return summarize(result)
	})
}

/** The compact record of a run, stored on the job row as its result. */
export function summarize(result: SourceRunResult): Record<string, unknown> {
	return {
		ok: result.ok,
		writes: result.writes.length,
		refusals: result.refusals,
		truncated: result.truncated,
		skippedWithoutId: result.skippedWithoutId,
		...(result.error ? { error: result.error } : {}),
	}
}

/**
 * Enqueue an enrichment for one row, under the authority that triggered it.
 *
 * `runAs` is required rather than defaulted, and there is deliberately no
 * "service" default to fall into: the worker refuses a job that arrives without
 * one, so a caller that could omit it would be a caller that could enqueue a
 * dead letter.
 */
export async function enqueueEnrichment(
	queue: JobQueue,
	source: SourceSpec,
	rowId: string,
	occurrence: string,
	runAs: ScheduleRunAs,
): Promise<JobRecord> {
	return queue.enqueue({
		type: SOURCE_JOB_TYPE,
		payload: { sourceKey: source.key, rowId } satisfies SourceJobPayload,
		idempotencyKey: sourceJobKey(source.key, occurrence, rowId),
		maxAttempts: source.limits.maxAttempts,
		runAs,
	})
}

/** Enqueue a sync run, under the authority that triggered it. */
export async function enqueueSync(
	queue: JobQueue,
	source: SourceSpec,
	occurrence: string,
	runAs: ScheduleRunAs,
): Promise<JobRecord> {
	return queue.enqueue({
		type: SOURCE_JOB_TYPE,
		payload: { sourceKey: source.key } satisfies SourceJobPayload,
		idempotencyKey: sourceJobKey(source.key, occurrence),
		maxAttempts: source.limits.maxAttempts,
		runAs,
	})
}

/**
 * How a source is doing, as a user-facing state rather than a stack trace.
 *
 * `stale` is deliberately its own state and not a flavour of `failing`: the
 * distinction people actually need is "this data is older than it should be"
 * versus "this integration is broken", and collapsing them produces either a
 * red banner nobody believes or a green one that lies.
 */
export type SourceHealthState =
	| 'never-run'
	| 'ok'
	| 'stale'
	| 'failing'
	| 'paused'

export interface SourceHealth {
	sourceKey: string
	state: SourceHealthState
	lastRunAt: Date | null
	lastSuccessAt: Date | null
	/** The most recent failure's message, when the last run failed. */
	message: string | null
	/** Consecutive failed runs at the head of the history. */
	consecutiveFailures: number
	/** One line, ready to render. */
	summary: string
}

/**
 * How long a source may go without a successful run before it reads as stale.
 * Deliberately generous: a source whose schedule is hourly should not flap to
 * `stale` because one run was late.
 */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000

/**
 * Derive a source's health from the job rows it has already produced.
 *
 * `now` is a parameter for the reason the scheduler's is: a health view you
 * cannot ask "what would this have said yesterday" is one whose behavior is
 * only observable in production.
 */
export async function sourceHealth(
	queue: JobQueue,
	source: SourceSpec,
	now: Date = new Date(),
	limit = 20,
): Promise<SourceHealth> {
	const rows = (await queue.list({ type: SOURCE_JOB_TYPE, limit })).filter(
		(job) => (job.payload as SourceJobPayload | null)?.sourceKey === source.key,
	)
	const runs = [...rows].sort(
		(a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
	)
	const succeeded = (job: JobRecord) =>
		job.status === 'succeeded' &&
		(job.result as { ok?: boolean } | null)?.ok !== false

	const lastRun = runs.find((job) => job.status !== 'pending') ?? null
	const lastSuccess = runs.find(succeeded) ?? null
	let consecutiveFailures = 0
	for (const job of runs) {
		if (job.status === 'pending' || job.status === 'running') continue
		if (succeeded(job)) break
		consecutiveFailures++
	}

	const message =
		lastRun && !succeeded(lastRun)
			? (lastRun.error ??
				(lastRun.result as { error?: { message?: string } } | null)?.error
					?.message ??
				'the last run did not succeed')
			: null

	const state: SourceHealthState = source.paused
		? 'paused'
		: !lastRun
			? 'never-run'
			: consecutiveFailures > 0
				? 'failing'
				: lastSuccess &&
						now.getTime() - lastSuccess.updatedAt.getTime() > STALE_AFTER_MS
					? 'stale'
					: 'ok'

	return {
		sourceKey: source.key,
		state,
		lastRunAt: lastRun?.updatedAt ?? null,
		lastSuccessAt: lastSuccess?.updatedAt ?? null,
		message,
		consecutiveFailures,
		summary: describeHealth(
			source,
			state,
			lastSuccess?.updatedAt ?? null,
			message,
		),
	}
}

/**
 * The sentence a page shows. Written in the language of the data rather than of
 * the runtime — "last updated 3 hours ago" is what somebody looking at a stale
 * cover image needs, and `ECONNRESET` is not.
 */
export function describeHealth(
	source: SourceSpec,
	state: SourceHealthState,
	lastSuccessAt: Date | null,
	message: string | null,
): string {
	const since = lastSuccessAt
		? `last updated ${lastSuccessAt.toISOString()}`
		: 'never updated'
	switch (state) {
		case 'paused':
			return `${source.key} is paused — showing the data from before it stopped (${since}).`
		case 'never-run':
			return `${source.key} has not run yet.`
		case 'ok':
			return `${source.key} is up to date (${since}).`
		case 'stale':
			return `${source.key} has not succeeded in over a day — showing older data (${since}).`
		case 'failing':
			return `${source.key} is failing${message ? `: ${message}` : ''} — showing the data from the last successful run (${since}).`
	}
}

/** Health for every declared source in a spec, paused ones included. */
export async function allSourceHealth(
	queue: JobQueue,
	spec: Pick<SpecSystem, 'sources'>,
	now: Date = new Date(),
): Promise<SourceHealth[]> {
	const out: SourceHealth[] = []
	for (const source of listSources(spec))
		out.push(await sourceHealth(queue, source, now))
	return out
}

/** The sources a runtime actually fetches — re-exported so a host wiring up the
 * queue needs one import. */
export { activeSources }
