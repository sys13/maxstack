/**
 * Owned-code wiring for the jobs page (`routes/jobs.tsx`) — the `jobs` bundle
 *.
 *
 * The queue itself (`getJobQueue`) is a process-lifetime singleton defined in
 * `sprout.server.ts` (alongside its sibling `webhookServiceForAudit`, for the
 * same reason — the event-bus audit sink enqueues onto it, so it has to live
 * where `getAuditSink` does to avoid a circular import). This module gives the
 * page a typed read of the declared schedules, their run history, and the
 * dead-letter queue, plus the two actions the page offers.
 */

import type { ResourceRegistry } from '@maxstack/core'
import type { JobRecord } from '@maxstack/features/jobs'
import { allSourceHealth, type SourceHealth } from '@maxstack/features/sources'
import {
	describeAuth,
	describeRecurrence,
	describeRunAs,
	describeSource,
	listSchedules,
	listSources,
	nextOccurrence,
	type ScheduleSpec,
	type SourceSpec,
} from '@maxstack/spec'
import { runSourceNow, tenantBlockReason } from './sources.server'
import {
	getJobQueue,
	getPlatform,
	getSprout,
	resolveUser,
} from './sprout.server'

/** One declared schedule as the page renders it. */
export interface ScheduleRow {
	key: string
	description: string
	/** Prose, not a cron string — a reviewer can check it against the intent. */
	recurrence: string
	runAs: string
	paused: boolean
	/** `null` for a paused schedule: "stopped" and "not due yet" are different. */
	nextRunIso: string | null
	/** The most recent runs of this schedule, newest first. */
	history: JobRecord[]
}

/**
 * One declared external source as the page renders it.
 *
 * The whole reason this row exists: a source that is down must degrade to a
 * *visible* stale state rather than to a broken page. `summary` is a sentence
 * written in the language of the data ("showing the data from the last
 * successful run"), because `ECONNRESET` is not what somebody looking at a
 * stale cover image needs to read.
 *
 * `auth` renders the credential's NAME. There is no value to render — the spec
 * does not hold one.
 */
export interface SourceRow {
	key: string
	description: string
	/** `enrich from https://… (on create, on demand)`. */
	shape: string
	/** e.g. `bearer token from secret MAILBOX_TOKEN`. */
	auth: string
	health: SourceHealth
	/**
	 * Whether this page may offer a "run now" button: a `sync` source
	 * that declared a `manual` trigger and is not paused.
	 *
	 * A button that exists because a source exists would be a trigger nobody
	 * declared — the run has to be one the spec already sanctions, or the page
	 * would be granting a capability the declaration withheld.
	 */
	runnable: boolean
	/**
	 * Why this source cannot land a row as declared, or `null`.
	 *
	 * The one combination that does not work is a tenant-scoped entity plus a run
	 * that carries no organization, and the failure is otherwise only visible as
	 * a refused write in a dead letter some hours later. Stating it here makes it
	 * a property of the *declaration*, readable the moment somebody declares the
	 * source, next to the thing they would have to change.
	 */
	blocked: string | null
}

export interface JobsView {
	userId: string
	schedules: ScheduleRow[]
	/** Declared external sources and how each is doing. */
	sources: SourceRow[]
	jobs: JobRecord[]
	/** Jobs that exhausted their retries — the queue's failures, made visible. */
	deadLettered: JobRecord[]
	/** Resource names an export job can target — the live registry. */
	resources: string[]
}

/**
 * The declaration-time half of issue #237: what a reader is told *before* a
 * nightly dead letter tells them.
 *
 * Only the case that is knowable from the declaration is claimed. A
 * schedule-driven sync into a tenant-scoped entity has nobody to inherit an org
 * from, so if no schedule driving it declares one, every run of it will be
 * refused — that is a fact about the declaration and is stated. An enrichment
 * inherits the org of the write that triggers it and a manual run inherits the
 * operator's, so neither can be called broken from here; whether a *particular*
 * trigger carried an org is a fact about that write, and the run says so.
 *
 * A schedule that declares `eachOrg` supplies an org per run, so it is not
 * blocked. *Whether the fan-out finds any org* is a fact about the tenant rows
 * at fire time rather than about the declaration, and the run says that one —
 * loudly, because a fan-out over nothing looks like a schedule with no work to
 * do.
 */
function blockedReason(
	source: SourceSpec,
	schedules: readonly ScheduleSpec[],
	registry: ResourceRegistry,
): string | null {
	if (source.mode !== 'sync') return null
	const driving = source.triggers.filter((t) => t.kind === 'schedule')
	if (driving.length === 0) return null
	const drivingRunAs = driving.map(
		(t) =>
			schedules.find(
				(s) => s.key === (t as { scheduleKey: string }).scheduleKey,
			)?.runAs,
	)
	if (drivingRunAs.some((runAs) => runAs?.eachOrg)) return null
	const declaredOrg = drivingRunAs
		.map((runAs) => runAs?.orgId)
		.find((orgId) => typeof orgId === 'string' && orgId !== '')
	return tenantBlockReason(
		registry,
		source.entityId.replace(/^e-/, ''),
		declaredOrg,
	)
}

export async function resolveJobs(request: Request): Promise<JobsView | null> {
	const user = await resolveUser(request)
	if (!user) return null
	const { registry } = await getSprout()
	const queue = await getJobQueue()
	const spec = await getPlatform().spec.load()
	const now = new Date()

	const declared: ScheduleSpec[] = listSchedules(spec)
	const schedules: ScheduleRow[] = []
	for (const schedule of declared) {
		const next = nextOccurrence(schedule, now)
		schedules.push({
			key: schedule.key,
			description: schedule.description,
			recurrence: describeRecurrence(schedule.recurrence, schedule.timezone),
			runAs: describeRunAs(schedule.runAs),
			paused: schedule.paused === true,
			nextRunIso: next?.toISOString() ?? null,
			history: await queue.list({ scheduleKey: schedule.key, limit: 10 }),
		})
	}

	// Health is derived from the job table rather than from a `source_status`
	// table, so "did the 09:00 sync run" has one answer rather than two that can
	// disagree — the same argument the schedule history above rests on.
	const health = await allSourceHealth(queue, spec, now)
	const sources: SourceRow[] = listSources(spec).map((declared, i) => ({
		key: declared.key,
		description: declared.description,
		shape: describeSource(declared),
		auth: describeAuth(declared.auth),
		health: health[i] as SourceHealth,
		runnable:
			declared.mode === 'sync' &&
			declared.paused !== true &&
			declared.triggers.some((t) => t.kind === 'manual'),
		blocked: blockedReason(declared, listSchedules(spec), registry),
	}))

	return {
		userId: user.id,
		schedules,
		sources,
		jobs: await queue.list({ limit: 50 }),
		deadLettered: await queue.deadLetter({ limit: 20 }),
		resources: registry.all().map((r) => r.resource.name),
	}
}

/** Enqueue a bulk CSV export of `resource` — run off the request path so a
 * large export doesn't block the enqueuing request. */
export async function enqueueExport(resource: string): Promise<JobRecord> {
	const queue = await getJobQueue()
	return queue.enqueue({ type: 'export.csv', payload: { resource } })
}

/**
 * Give one dead-lettered job another attempt.
 *
 * Exactly one: `JobQueue.retry` moves `maxAttempts` to `attempts + 1` rather
 * than resetting it, so a genuinely broken job cannot be looped back into the
 * queue forever by an impatient operator.
 */
export async function retryJob(id: string): Promise<void> {
	const queue = await getJobQueue()
	await queue.retry(id)
}

/**
 * The on-demand run the page's "run now" button posts to.
 *
 * The operator's own identity is what the run borrows — resolved here from the
 * request rather than passed in, so there is no shape of this call that runs as
 * anybody else. The refusals come back as reasons rather than as an exception:
 * "this source declares no manual trigger" is a fact about the declaration and
 * belongs on the page, not in a 500.
 */
export async function triggerSourceRun(
	request: Request,
	sourceKey: string,
): Promise<{ ok: boolean; reason?: string }> {
	const user = await resolveUser(request)
	if (!user) return { ok: false, reason: 'not signed in' }
	return runSourceNow(sourceKey, user, `manual:${crypto.randomUUID()}`)
}
