/**
 * `FlagService` — evaluation with telemetry, and the stale-flag
 * report that telemetry exists for.
 *
 * The declaration and the evaluation rule live in `@maxstack/spec`
 * (`FlagSpec` / `evaluateFlag`), because they are spec data and the workbench
 * has to read them without a database. This module adds the two things that
 * need one:
 *
 *   - **Usage telemetry**, coalesced. Evaluations accumulate in memory and are
 *     flushed at most once per {@link FlagServiceOptions.flushIntervalMs}, so
 *     recording use costs one write per flag per interval rather than one per
 *     request.
 *   - **Staleness**, which is the failure mode of every flag system: not that a
 *     flag is wrong, but that nobody ever deletes it. A flag that gates nothing,
 *     or that has finished rolling out, or that nothing has evaluated in weeks,
 *     is reported by name with the reason — and `flags.remove` is a first-class
 *     op, so acting on the report is one change, not a code search.
 *
 * Authorization is here rather than at a route, for the reason issue #186
 * established the hard way: routes are not the only way into a service. Any
 * caller that would change who a flag is on for goes through
 * {@link assertCanManageFlags}, which is fail-closed on an absent identity.
 */

import {
	evaluateFlag,
	type FlagContext,
	type FlagSpec,
	flagGates,
	listFlags,
	type SpecSystem,
} from '@maxstack/spec'
import { eq, sql } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/pglite'
import { flagEvaluation } from './schema.ts'

type Db = ReturnType<typeof drizzle>

/** The identity a flag-management action is performed by. */
export interface FlagActor {
	id: string
	role?: string | null
}

/**
 * Roles that may change a flag's targeting. Owner and admin only: targeting is
 * who-sees-what, so widening it is a release decision, not a preference.
 */
export const FLAG_MANAGER_ROLES = ['owner', 'admin'] as const

export class FlagPermissionError extends Error {
	constructor(action: string) {
		super(`Permission denied: ${action} requires an owner or admin`)
		this.name = 'FlagPermissionError'
	}
}

/** Whether `actor` may change flag declarations or targeting. */
export function canManageFlags(actor: FlagActor | null | undefined): boolean {
	const role = actor?.role
	return (
		!!actor &&
		!!role &&
		(FLAG_MANAGER_ROLES as readonly string[]).includes(role)
	)
}

/**
 * Fail-closed gate for every flag-management action. An absent identity is a
 * denial, not a bypass — the anonymous case is the one that matters, since a
 * flag frequently gates an unreleased surface.
 */
export function assertCanManageFlags(
	actor: FlagActor | null | undefined,
	action = 'changing flag targeting',
): void {
	if (!canManageFlags(actor)) throw new FlagPermissionError(action)
}

export interface FlagUsage {
	key: string
	lastEvaluatedAt: Date
	lastResult: boolean
	evaluations: number
}

export interface FlagServiceOptions {
	db: Db
	/** How often accumulated counters are written. Default 60s. */
	flushIntervalMs?: number
	/** Injectable clock — the report and the flush cadence both read it. */
	now?: () => Date
}

/** Why a flag showed up in the stale report. A flag can collect several. */
export type StaleFlagReason =
	/** Declared, but no page or block gates on it. */
	| 'gates-nothing'
	/** Nothing has ever evaluated it — dead on arrival, or already removed from code. */
	| 'never-evaluated'
	/** Evaluated once, but not recently. */
	| 'not-evaluated-recently'
	/** Rolled out to 100%: the rollout is over, so the flag is now just a branch. */
	| 'rollout-complete'

export interface StaleFlagRow {
	key: string
	description: string
	/** Days since the flag was declared. */
	ageDays: number
	/** How many surfaces it gates right now. */
	gates: number
	lastEvaluatedAt: Date | null
	evaluations: number
	reasons: StaleFlagReason[]
}

export interface StaleFlagOptions {
	/**
	 * A flag younger than this is never reported, whatever its telemetry says —
	 * a flag declared this morning has not had time to be used. Default 14 days.
	 */
	graceDays?: number
	/**
	 * How long without an evaluation counts as stale. Default 30 days.
	 */
	unusedDays?: number
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Whole days between two instants, floored at 0. */
function daysBetween(from: Date, to: Date): number {
	return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS))
}

export class FlagService {
	private readonly db: Db
	private readonly flushIntervalMs: number
	private readonly now: () => Date
	/** Accumulated, unflushed evaluations: key → count + latest result. */
	private readonly pending = new Map<
		string,
		{ count: number; lastResult: boolean; at: Date }
	>()
	private lastFlushAt: number

	constructor(opts: FlagServiceOptions) {
		this.db = opts.db
		this.flushIntervalMs = opts.flushIntervalMs ?? 60_000
		this.now = opts.now ?? (() => new Date())
		this.lastFlushAt = this.now().getTime()
	}

	/**
	 * Evaluate every declared flag for one viewer, recording the use.
	 *
	 * The answer is computed entirely in memory from the spec — the database is
	 * never on the read path, so a page render costs no query no matter how many
	 * flags exist. The returned map is what a loader hands to `getRoutes` and to
	 * the client.
	 */
	async evaluate(
		spec: Pick<SpecSystem, 'flags'>,
		ctx: FlagContext = {},
	): Promise<Record<string, boolean>> {
		const at = this.now()
		const values: Record<string, boolean> = {}
		for (const flag of listFlags(spec)) {
			const value = evaluateFlag(flag, ctx)
			values[flag.key] = value
			const entry = this.pending.get(flag.key)
			if (entry) {
				entry.count += 1
				entry.lastResult = value
				entry.at = at
			} else {
				this.pending.set(flag.key, { count: 1, lastResult: value, at })
			}
		}
		if (at.getTime() - this.lastFlushAt >= this.flushIntervalMs)
			await this.flush()
		return values
	}

	/**
	 * Write the accumulated counters. Called automatically once per interval by
	 * {@link evaluate}; call it directly on shutdown, or in a test that wants to
	 * observe the telemetry without waiting.
	 *
	 * Counters are incremented in SQL (`evaluations + n`) rather than read-then-
	 * written, so two processes flushing the same flag both count.
	 */
	async flush(): Promise<void> {
		this.lastFlushAt = this.now().getTime()
		if (this.pending.size === 0) return
		const batch = [...this.pending.entries()]
		this.pending.clear()
		for (const [key, entry] of batch) {
			await this.db
				.insert(flagEvaluation)
				.values({
					key,
					lastEvaluatedAt: entry.at,
					lastResult: entry.lastResult,
					evaluations: entry.count,
				})
				.onConflictDoUpdate({
					target: flagEvaluation.key,
					set: {
						lastEvaluatedAt: entry.at,
						lastResult: entry.lastResult,
						evaluations: sql`${flagEvaluation.evaluations} + ${entry.count}`,
					},
				})
		}
	}

	/** Recorded usage for one flag, or `null` if it has never been flushed. */
	async usageOf(key: string): Promise<FlagUsage | null> {
		const [row] = await this.db
			.select()
			.from(flagEvaluation)
			.where(eq(flagEvaluation.key, key))
		return row ?? null
	}

	/** Recorded usage for every flag the telemetry table knows about. */
	async usage(): Promise<FlagUsage[]> {
		return this.db.select().from(flagEvaluation)
	}

	/**
	 * Every declared flag with its age, what it gates, and when it was last
	 * evaluated — the enumeration requirement. `stale` is the subset with at
	 * least one reason, which is what a report renders.
	 */
	async report(
		spec: Pick<SpecSystem, 'flags' | 'pages'>,
		opts: StaleFlagOptions = {},
	): Promise<{ all: StaleFlagRow[]; stale: StaleFlagRow[] }> {
		// Pending counters are part of the truth: a flag evaluated a thousand times
		// in the last thirty seconds is not unused just because the flush is due.
		await this.flush()
		const usage = new Map((await this.usage()).map((u) => [u.key, u]))
		const now = this.now()
		const graceDays = opts.graceDays ?? 14
		const unusedDays = opts.unusedDays ?? 30

		const all = listFlags(spec).map((flag) =>
			this.rowFor(flag, spec, usage.get(flag.key) ?? null, {
				now,
				graceDays,
				unusedDays,
			}),
		)
		return { all, stale: all.filter((r) => r.reasons.length > 0) }
	}

	private rowFor(
		flag: FlagSpec,
		spec: Pick<SpecSystem, 'pages'>,
		usage: FlagUsage | null,
		ctx: { now: Date; graceDays: number; unusedDays: number },
	): StaleFlagRow {
		const declaredAt = new Date(flag.declaredAt)
		const ageDays = Number.isNaN(declaredAt.getTime())
			? 0
			: daysBetween(declaredAt, ctx.now)
		const gates = flagGates(spec, flag.key).length
		const reasons: StaleFlagReason[] = []

		// Everything below is suppressed inside the grace window: a flag declared
		// this morning gates nothing and has been evaluated never, and reporting
		// that would train people to ignore the report.
		if (ageDays >= ctx.graceDays) {
			if (gates === 0) reasons.push('gates-nothing')
			if (!usage) reasons.push('never-evaluated')
			else if (daysBetween(usage.lastEvaluatedAt, ctx.now) >= ctx.unusedDays)
				reasons.push('not-evaluated-recently')
			// A finished rollout is the most common dead flag of all: it is on for
			// everyone, so the branch it guards is now unconditional.
			if (flag.targeting?.rolloutPercent === 100)
				reasons.push('rollout-complete')
		}

		return {
			key: flag.key,
			description: flag.description,
			ageDays,
			gates,
			lastEvaluatedAt: usage?.lastEvaluatedAt ?? null,
			evaluations: usage?.evaluations ?? 0,
			reasons,
		}
	}
}
