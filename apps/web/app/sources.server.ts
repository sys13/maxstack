/**
 * The execution path a declared source runs on.
 *
 * Issue #173 built every half of a source except the one that makes it happen:
 * the fetch, the mapping, the refiner slot, the retry budget, the health read
 * and the jobs-page row all existed, and `registerSourceHandlers` was called
 * nowhere — so a declared source was a row on a page that never ran. This module
 * is the missing runner, and it is deliberately thin. It owns three joins and
 * nothing else:
 *
 *  1. **An identity.** A source has no authority of its own, so every run
 *     borrows one — see {@link userForRunAs}.
 *  2. **A write path.** The intent a run produces is applied through `opCreate`
 *     and `opUpdate`, which is the identical path a form posts to.
 *  3. **A trigger.** A schedule occurrence enqueues the syncs it declares; a
 *     committed create/update enqueues the enrichments it declares; the jobs
 *     page enqueues a manual run.
 *
 * ## Why the writes go through the ops and not the store
 *
 * Stated once here because it is the property everything else in the file is
 * arranged around. `@maxstack/features/sources` returns {@link SourceWrite}
 * *intent* and cannot write a row; this applies that intent with `opCreate` /
 * `opUpdate`, so a value a third party supplied passes the column's zod schema,
 * the entity's declared per-value limits, the tenant stamp, the soft-delete
 * scope, the `customValidation` hook and the audit trail — because it goes
 * through the code a person typing into the form goes through. The alternative
 * (a `store.update` here) would be a second write path with its own copy of all
 * of those, and the copy is the one that gets skipped.
 *
 * ## What a run may do is bounded by who triggered it
 *
 * There is no service account with ambient power in this file. A schedule-driven
 * sync runs as the schedule's declared `runAs`; an enrichment runs as the
 * identity whose write triggered it; a manual run runs as the operator who
 * pressed the button. So a source can never reach a row the trigger could not,
 * and "a source gets no privileges of its own" is a property of the code rather
 * than a sentence in a comment.
 *
 * ## An identity includes the tenant it acts in
 *
 * A borrowed identity used to be a role and nothing else, which meant a run
 * reached no tenant-scoped row at all: an active org is normally resolved from
 * the org-switcher cookie, and background work has no request. Each
 * of the three triggers now answers it the way that trigger can — an enrichment
 * **inherits** the org the triggering write happened in, a manual run inherits
 * the operator's current one, and a schedule-driven sync has nobody to inherit
 * from and so must **declare** one (`runAs.orgId`) — or declare that it runs in
 * *every* org (`runAs.eachOrg`), which fans one occurrence out into one bounded
 * run per tenant so a per-customer nightly pull is one declaration rather than one
 * schedule per customer. A user's org is re-verified
 * against membership at run time, never trusted off the job row. The combination
 * that still cannot work — a tenant-scoped entity and no org anywhere — is
 * refused with {@link tenantBlockReason}'s sentence, and the jobs page shows
 * that same sentence beside the declaration rather than waiting for a nightly
 * dead letter to say it.
 */

import {
	type OpContext,
	opCreate,
	opList,
	opUpdate,
	type SproutUser,
} from '@maxstack/core'
import type { JobQueue, ScheduleOccurrence } from '@maxstack/features/jobs'
import {
	enqueueEnrichment,
	enqueueSync,
	type SourceWrite,
} from '@maxstack/features/sources'
import type {
	EntityId,
	EntitySpec,
	ScheduleRunAs,
	SourceSpec,
	SpecSystem,
} from '@maxstack/spec'
import {
	activeSources,
	enrichSourcesFor,
	fanOutRunAs,
	findSource,
	MAX_FANOUT_ORGS,
	syncSourcesForSchedule,
} from '@maxstack/spec'
import {
	activeOrgFor,
	contextForUser,
	getJobQueue,
	getPlatform,
	orgsForRunAs,
	storedRoleOf,
} from './sprout.server'

/** `e-reading-item` → `reading-item` — `spec-sprout.ts`'s derivation, which is
 * what makes an entity id and a Sprout resource name the same fact. */
const resourceName = (entityId: string) => entityId.replace(/^e-/, '')

/** The entity ids a resource name can have come from, for the write trigger. */
const entityIdOf = (resource: string) => `e-${resource}`

/**
 * The identity a run borrows, resolved to a real user.
 *
 * `{ kind: 'user' }` reads the role **now** rather than trusting the enqueued
 * payload, on `storedRoleOf`'s argument: demoting somebody has to demote the
 * jobs their earlier writes queued, and a role copied onto a job row at enqueue
 * time is a permission decision frozen at the wrong moment. Its declared org is
 * re-checked against membership the same way and for the same reason
 * (`activeOrgFor`).
 *
 * `{ kind: 'service' }` gets exactly the role the schedule declared and an
 * identity that names it (`service:nightly`) — so the audit trail says which
 * declaration performed a write, not "system". Its org is taken as declared:
 * there is no membership row to check a service role against, and the
 * declaration is the review. There is no fallback branch that invents an admin:
 * an identity this cannot resolve is a run that does not happen, because the job
 * already refused to start without a `runAs`.
 *
 * `sourceKey` is stamped on the identity rather than passed alongside it, so
 * every write a run makes carries "this came from source X" through the ops and
 * onto the audit entry — which is what the enrichment loop guard reads instead
 * of guessing from `origin`.
 */
export async function userForRunAs(
	runAs: ScheduleRunAs,
	sourceKey?: string,
): Promise<SproutUser> {
	const marker = sourceKey ? { sourceKey } : {}
	if (runAs.kind === 'service')
		return {
			id: `service:${runAs.role}`,
			role: runAs.role,
			origin: 'system',
			orgId: runAs.orgId ?? null,
			...marker,
		}
	return {
		id: runAs.userId,
		role: await storedRoleOf(runAs.userId),
		origin: 'system',
		orgId: (await activeOrgFor(runAs.userId, runAs.orgId)) ?? null,
		...marker,
	}
}

/** An op context for a run, carrying the borrowed identity and nothing more. */
async function contextForRun(
	runAs: ScheduleRunAs,
	sourceKey?: string,
): Promise<OpContext> {
	return contextForUser(await userForRunAs(runAs, sourceKey))
}

/**
 * Why this source cannot land a row under this identity, or `null` when it can
 *.
 *
 * The one combination that does not work: a **tenant-scoped** entity plus an
 * identity with no active org. The failure direction is the safe one — the ops
 * refuse the write rather than guessing a tenant — but `Permission denied:
 * create on contact`, once a night, in a dead letter, is not a sentence anybody
 * can act on. This produces the one that is, and it is the same sentence the
 * jobs page shows *at declaration time*, so the usual way to meet this is by
 * reading it beside the source you just declared rather than by finding a
 * nightly failure a week later.
 */
export function tenantBlockReason(
	registry: OpContext['registry'],
	resource: string,
	orgId: string | null | undefined,
): string | null {
	const tenantField = registry.get(resource)?.config.tenantField
	if (!tenantField) return null
	if (typeof orgId === 'string' && orgId !== '') return null
	return (
		`"${resource}" is tenant-scoped (rows carry "${tenantField}") and this run carries no organization, ` +
		'so every write would be refused. Declare the org the run acts in on the ' +
		'`runAs` that drives it (`runAs.orgId`) — an enrichment inherits the org of ' +
		'the write that triggered it, and a schedule-driven sync has none to inherit'
	)
}

/** Field id → column name for one entity. The one translation the feature layer
 * deliberately does not do: it speaks field ids, and the ops speak columns. */
function columnsOf(entity: EntitySpec): Map<string, string> {
	return new Map(entity.fields.map((f) => [f.id, f.name]))
}

/** Rewrite a run's values from field ids to column names, dropping any field the
 * entity no longer has — a spec edit between the mapping and the run is
 * ordinary, and a 500 in a background job is not how it should read. */
function toColumns(
	entity: EntitySpec,
	values: Record<string, unknown>,
): Record<string, unknown> {
	const byId = columnsOf(entity)
	const out: Record<string, unknown> = {}
	for (const [fieldId, value] of Object.entries(values)) {
		const column = byId.get(fieldId)
		if (column) out[column] = value
	}
	return out
}

/**
 * Apply one run's intent through the app's own validated write path.
 *
 * An `upsert` is resolved by *reading first* through `opList` — under the
 * borrowed identity, so a match the trigger could not see is not a match — and
 * then updating or creating. The read is what makes a sync safe to repeat: the
 * second run matches the rows the first one made rather than making them again.
 *
 * **Per write, never all-or-nothing.** One write failing validation is a fact
 * about one remote record, and rolling back the records that landed would mean
 * deleting rows this function just created — `opApplyImport`'s reasoning, for
 * the same reason. The failures are thrown as one summary so the job row carries
 * them and the run reads as failed on the jobs page.
 */
export async function applySourceWrites(
	writes: readonly SourceWrite[],
	source: SourceSpec,
	runAs: ScheduleRunAs,
	entity: EntitySpec,
): Promise<void> {
	return applyWritesWith(
		await contextForRun(runAs, source.key),
		writes,
		source,
		entity,
	)
}

/**
 * The applier itself, over a context somebody else built.
 *
 * Split from {@link applySourceWrites} so the translation and the write path can
 * be driven by a test against a real registry without a process-lifetime store
 * singleton — the gap issues #235 and #236 both came out of was machinery that
 * was green everywhere except in the one caller nobody exercised.
 */
export async function applyWritesWith(
	ctx: OpContext,
	writes: readonly SourceWrite[],
	source: SourceSpec,
	entity: EntitySpec,
): Promise<void> {
	const resource = resourceName(source.entityId)
	// One refusal for the whole run rather than the same refusal N times: a
	// tenant-scoped entity with no org on the identity fails every write
	// identically, and the useful output is the reason, once.
	const blocked = tenantBlockReason(ctx.registry, resource, ctx.user?.orgId)
	if (blocked) throw new Error(`"${source.key}" cannot write: ${blocked}`)
	const byId = columnsOf(entity)
	const failures: string[] = []
	for (const write of writes) {
		try {
			if (write.kind === 'update') {
				await opUpdate(
					ctx,
					resource,
					write.rowId,
					toColumns(entity, write.values),
				)
				continue
			}
			const matchColumn = byId.get(write.matchField)
			if (!matchColumn) {
				failures.push(
					`"${write.matchField}" is no longer a field on ${source.entityId}`,
				)
				continue
			}
			const existing = await opList(ctx, resource, {
				filter: { [matchColumn]: write.matchValue },
				limit: 1,
			})
			const values = toColumns(entity, write.values)
			const match = existing[0]
			if (match) {
				const primaryKey = ctx.registry.get(resource)?.resource.primaryKey
				await opUpdate(ctx, resource, String(match[primaryKey ?? 'id']), values)
			} else {
				await opCreate(ctx, resource, values)
			}
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error))
		}
	}
	if (failures.length > 0)
		throw new Error(
			`${failures.length} of ${writes.length} writes from "${source.key}" were refused: ${failures.join('; ')}`,
		)
}

/** Read the row an enrichment was triggered for, under the borrowed identity. */
export async function readSourceRow(
	source: SourceSpec,
	rowId: string,
	runAs: ScheduleRunAs,
): Promise<(Record<string, unknown> & { id: string }) | null> {
	const ctx = await contextForRun(runAs, source.key)
	const resource = resourceName(source.entityId)
	const primaryKey = ctx.registry.get(resource)?.resource.primaryKey ?? 'id'
	const rows = await opList(ctx, resource, {
		filter: { [primaryKey]: rowId },
		limit: 1,
	})
	const row = rows[0]
	// `runEnrichment` reads the input column off `row` by name and identifies the
	// row by `id`, so the primary key is normalized here rather than in the
	// feature, which has no registry to ask what it is called.
	return row ? { ...row, id: String(row[primaryKey]) } : null
}

/** The live spec, read on every call for `Scheduler`'s reason: a source paused
 * ten seconds ago has to stop running without a restart. */
async function spec(): Promise<SpecSystem> {
	return getPlatform().spec.load()
}

/** The entity a source writes to, or `undefined` when the spec no longer has it. */
export async function sourceEntity(
	entityId: string,
): Promise<EntitySpec | undefined> {
	return (await spec()).data.entities.find((e) => e.id === entityId)
}

/** The declarations the runner reads — active (accepted, unpaused) only. */
export async function declaredSources(): Promise<SourceSpec[]> {
	return activeSources(await spec())
}

/**
 * The occurrence one org's run of a fanned-out sync is keyed on.
 *
 * The org has to be *in* the key: `sourceJobKey` is the queue's idempotency key,
 * so 200 runs of one source at one instant that all claimed
 * `source:crm.pull:<instant>` would be one run and 199 duplicate-drops. Reading
 * as `<instant>#org-acme` also means the jobs page shows which tenant a run was
 * for without a second column to plumb through.
 */
const occurrenceForOrg = (at: string, orgId: string) => `${at}#${orgId}`

/**
 * Enqueue the syncs a schedule occurrence drives, and report how many runs.
 *
 * The count is what lets `registerScheduleHandlers` tell "this occurrence was
 * the platform's work" from "this occurrence has no handler and somebody needs
 * to write one" — so a schedule declared purely to drive a sync does not
 * dead-letter demanding a handler file with nothing to put in it. It counts
 * *runs* rather than sources, because a fanned-out sync is many runs and the
 * number an operator wants to see is how much work one fire produced.
 *
 * The occurrence is the idempotency key, so a re-delivered schedule job enqueues
 * the same sync rather than a second one.
 *
 * ## The fan-out
 *
 * A `runAs` that declares `eachOrg` produces one run per org rather than one run:
 * the orgs are enumerated *now* (`orgsForRunAs` — every org for a service role,
 * the verified memberships for a user) and `fanOutRunAs` turns them into one
 * `runAs` each. That is the multi-tenant answer the alternative — one schedule per
 * tenant, added on signup and removed on churn — cannot keep honest.
 *
 * Two things are deliberately loud rather than silent, because both look exactly
 * like a working schedule from the outside:
 *
 *  - **A fan-out with nothing to fan out to.** A project with no `organization`
 *    resource, or a user who is a member of nothing, enqueues zero runs. Silence
 *    there would read as "ran, nothing to do".
 *  - **A fan-out wider than its bound.** The bound's worth runs and the rest are
 *    named as skipped, rather than the first 200 of 5000 tenants passing as
 *    coverage.
 */
export async function enqueueScheduledSyncs(
	occurrence: ScheduleOccurrence,
): Promise<number> {
	const sources = syncSourcesForSchedule(await spec(), occurrence.scheduleKey)
	if (sources.length === 0) return 0
	return enqueueSyncsWith(
		await getJobQueue(),
		sources,
		occurrence,
		orgsForRunAs,
	)
}

/**
 * The enqueue itself, over a queue and an org enumerator somebody else supplied.
 *
 * Split from {@link enqueueScheduledSyncs} for {@link applyWritesWith}'s reason,
 * and this time the thing being made testable is a *bound*: what one occurrence
 * of a per-tenant sync costs, and what it does when there are more tenants than
 * the bound allows, are questions whose answers should not first be observed in a
 * deployment with 5000 of them.
 */
export async function enqueueSyncsWith(
	queue: JobQueue,
	sources: readonly SourceSpec[],
	occurrence: ScheduleOccurrence,
	orgs: (
		runAs: ScheduleRunAs,
	) => Promise<{ orgIds: string[]; truncated: boolean }>,
): Promise<number> {
	const at = occurrence.scheduledFor.toISOString()

	if (!occurrence.runAs.eachOrg) {
		for (const source of sources)
			await enqueueSync(queue, source, at, occurrence.runAs)
		return sources.length
	}

	const { orgIds, truncated } = await orgs(occurrence.runAs)
	const { runs, skipped } = fanOutRunAs(occurrence.runAs, orgIds)
	if (runs.length === 0) {
		console.warn(
			`Schedule "${occurrence.scheduleKey}" fans out per org (runAs.eachOrg) and ` +
				`resolved no org to run in, so ${sources.length} declared sync(s) did not run. ` +
				(occurrence.runAs.kind === 'service'
					? 'A service role fans out over every organization row; this project has none (or no organization resource).'
					: `User "${occurrence.runAs.userId}" is a member of no organization.`),
		)
		return 0
	}
	if (skipped > 0 || truncated) {
		const bound =
			occurrence.runAs.maxOrgs && occurrence.runAs.maxOrgs < MAX_FANOUT_ORGS
				? `${occurrence.runAs.maxOrgs} (runAs.maxOrgs, under the ${MAX_FANOUT_ORGS} ceiling)`
				: `${MAX_FANOUT_ORGS}`
		// `truncated` means the enumeration itself stopped at the ceiling, so the
		// orgs it did not read are not in `skipped` — "and more" rather than a
		// count that would understate the gap.
		const missed = truncated
			? `${skipped} more and more beyond that`
			: `${skipped} more`
		console.warn(
			`Schedule "${occurrence.scheduleKey}" fanned out to ${runs.length} org(s) and skipped ` +
				`${missed} — the fan-out bound is ${bound} runs per occurrence. Work that has to ` +
				'cover more tenants than that wants its own pacing rather than a wider fan-out.',
		)
	}

	let enqueued = 0
	for (const source of sources)
		for (const runAs of runs) {
			// A per-org occurrence, so the runs of one source at one instant are one
			// row each rather than one row and N−1 idempotent no-ops.
			await enqueueSync(queue, source, occurrenceForOrg(at, runAs.orgId), runAs)
			enqueued++
		}
	return enqueued
}

/**
 * Enqueue the enrichments a committed write triggers.
 *
 * Called from the audit sink — after the commit, never inside the op — for
 * `publishLiveChange`'s reason and one more: an enrichment that ran inline would
 * make a third party's outage into a failed create, which is precisely the
 * failure `@maxstack/features/sources` queues in order to avoid. Best-effort at
 * the call site for the same reason.
 *
 * The occurrence is the *write*, not a clock tick: two edits to the same row a
 * minute apart enrich it twice (the second may have fixed the ISBN), and a
 * retried delivery of the same write does not.
 */
export async function enqueueWriteEnrichments(input: {
	resource: string
	action: string
	rowId: string
	userId: string
	/** The org the triggering write happened in, when it had one —
	 * inherited so an enrichment can reach the tenant-scoped row it was triggered
	 * for. Re-verified against membership when the run resolves the identity. */
	orgId?: string
	occurrence: string
}): Promise<number> {
	if (input.action !== 'create' && input.action !== 'update') return 0
	// No identity, no run. An anonymous write has no authority to lend, and the
	// alternative — falling back to a service role nobody declared — would be the
	// ambient authority the whole design refuses.
	const userId = input.userId
	if (!userId || userId === 'anonymous') return 0
	const sources = enrichSourcesFor(
		await spec(),
		entityIdOf(input.resource) as EntityId,
		input.action,
	)
	if (sources.length === 0) return 0
	const queue = await getJobQueue()
	for (const source of sources)
		await enqueueEnrichment(queue, source, input.rowId, input.occurrence, {
			kind: 'user',
			userId,
			...(input.orgId ? { orgId: input.orgId } : {}),
		})
	return sources.length
}

/**
 * The on-demand run the jobs page offers (`manual` trigger).
 *
 * It borrows the operator's own identity, which is what makes the button safe to
 * expose beside the run history: pressing it can do nothing the person pressing
 * it could not do through the UI, and the audit trail names them rather than the
 * app. A source that did not declare a `manual` trigger has no button —
 * refusing here rather than at the route keeps that a fact about the
 * declaration.
 */
export async function runSourceNow(
	sourceKey: string,
	user: SproutUser,
	occurrence: string,
): Promise<{ ok: boolean; reason?: string }> {
	const declared = findSource(await spec(), sourceKey)
	if (!declared || declared.paused) return { ok: false, reason: 'not running' }
	if (!declared.triggers.some((t) => t.kind === 'manual'))
		return { ok: false, reason: 'no manual trigger declared' }
	if (declared.mode !== 'sync')
		return { ok: false, reason: 'an enrichment runs for a row, not on demand' }
	const queue = await getJobQueue()
	await enqueueSync(queue, declared, occurrence, {
		kind: 'user',
		userId: user.id,
		// The operator's *current* active org, resolved from their request — so a
		// manual run of a tenant-scoped sync lands in the org they were looking at,
		// and can reach nothing they could not reach on the page they pressed it on.
		...(user.orgId ? { orgId: user.orgId } : {}),
	})
	return { ok: true }
}
