/**
 * Declared recurrence as spec-as-data — the declaration *and* the
 * pure next-fire rule, so "this runs monthly" is a reviewable row in the spec
 * rather than a `setInterval` buried in application code.
 *
 * Four properties shape the design, in the order they constrain it:
 *
 * 1. **Generation may never read a schedule's run history.** A schedule changes
 *    what the running app *does over time*; it never changes what the generator
 *    *writes*. The declaration is spec data; every occurrence, claim and retry
 *    lives in the `job` table. So the determinism invariant (§L4A) holds by
 *    construction: nothing in the ownership generators can reach a job row.
 * 2. **A schedule runs as *someone*, and that someone is declared.** {@link
 *    ScheduleRunAs} is required with no default. Scheduled work is the classic
 *    place implicit-admin creeps in — a job that quietly runs with more
 *    authority than any human caller is an authorization bypass with a cron
 *    expression in front of it. There is deliberately no `runAs: 'admin'`
 *    shorthand: you name a service role (whose entitlements and RBAC are
 *    resolved exactly like a human's) or you name a user.
 * 3. **The next fire is a pure function of (declaration, instant).** {@link
 *    nextOccurrence} does no IO, holds no state, and never reads a clock it was
 *    not given. A scheduler that cannot be asked "what would you have done at
 *    3am on the 31st of February" is a scheduler whose DST and month-end
 *    behavior is discovered in production.
 * 4. **Every awkward calendar case has a written answer**, below, and a test.
 *    "Monthly on the 31st" and "daily at 02:30 on the morning the clocks move"
 *    are not edge cases — they are 12 and 2 occurrences a year.
 *
 * ## The calendar rules
 *
 * | Case | Answer |
 * |---|---|
 * | Monthly on the 31st, in a 30-day month | Fires on the **last day** of that month. Never skipped, never rolled into the next month. |
 * | Monthly on the 29th–31st, February | Same clamp: the 28th (29th in a leap year). |
 * | A local time that does not exist (spring forward) | Fires at the **next instant that does exist** — 02:30 becomes 03:30. Never skipped. |
 * | A local time that happens twice (fall back) | Fires **once**, at the first occurrence (the pre-transition offset). |
 * | `interval` recurrence and DST | Unaffected. An interval is elapsed absolute time, anchored on the declaration date, so "every 6 hours" is always 6 hours. |
 *
 * The wall-clock kinds (`daily`/`weekly`/`monthly`) are evaluated in the
 * schedule's declared {@link ScheduleSpec.timezone}, not the server's. A server
 * that moves region must not move everybody's monthly invoice run.
 */

import type { EntityId, ISODate, ScheduleId } from './ids.ts'
import { getAcceptedOrAll, type Provenanced } from './provenance.ts'
import type { SpecSystem } from './spec-system.ts'

/**
 * How often a schedule fires.
 *
 * A discriminated union rather than a cron string on purpose. A cron expression
 * is a five-field mini-language whose semantics no reviewer can read off the
 * page (`0 0 31 * *` silently skips four months a year), and it cannot express
 * the timezone or the month-end rule at all — which is exactly where scheduling
 * bugs live. Every field here is named, validated, and rendered back in prose.
 */
export type ScheduleRecurrence =
	| {
			/**
			 * Every `everyMinutes` minutes of elapsed time, anchored on the
			 * declaration date (00:00 UTC of `declaredAt`). Absolute, so it neither
			 * skips nor doubles across a DST transition.
			 */
			kind: 'interval'
			everyMinutes: number
	  }
	| {
			/** Every day at `atTime`, local to the schedule's timezone. */
			kind: 'daily'
			atTime: string
	  }
	| {
			/** Every week on `onWeekday` (0 = Sunday) at `atTime`, local time. */
			kind: 'weekly'
			onWeekday: number
			atTime: string
	  }
	| {
			/**
			 * Every month on `onDayOfMonth` at `atTime`, local time. A day past the
			 * end of a short month clamps to that month's last day — see the table
			 * in the module note.
			 */
			kind: 'monthly'
			onDayOfMonth: number
			atTime: string
	  }

/**
 * Whose authority a run carries. Required, with no default — see property 2 in
 * the module note.
 *
 * ## Why an org is declared here and nowhere else
 *
 * A role is not a whole identity in a multi-tenant app: a tenant-scoped resource
 * is reachable only by someone acting *in an org*, and an active org is normally
 * resolved per request from the org switcher plus a membership check. Background
 * work has no request, so a run that borrows this identity would carry no org —
 * and every write into a tenant-scoped entity would be refused, every run,
 * forever.
 *
 * `orgId` is the declaration that closes that. It is optional because most
 * scheduled work is not tenant-scoped, and it is *here* rather than on the
 * schedule (or on the source) because it is part of the answer to "as whom" —
 * the same field a reviewer already reads to decide whether a run may do what it
 * does. A run into a tenant-scoped entity with no org declared and none
 * inherited is refused with that sentence, rather than with `Permission denied`.
 *
 * ## One org, or every org (the fan-out)
 *
 * `orgId` answers "which tenant" with one name, which is the honest answer for a
 * nightly pull that belongs to one customer and does not scale to the app that
 * needs the same pull for all of them: one schedule per tenant is a declaration
 * somebody has to remember to add on signup and remove on churn.
 *
 * `eachOrg` is the other answer. It says *run this once per org* — the runner
 * enumerates the orgs the identity may act in (every org for a service role; the
 * orgs they are a member of for a user, verified) and enqueues one run per org,
 * each carrying that org and nothing else different. So the fanned-out run is
 * exactly the declared run with one tenant filled in, and every bound the single
 * run has still applies per run.
 *
 * It is bounded, because it is the one field here whose cost grows with the
 * customer list — and it grows against somebody else's rate limit, which is not
 * this app's to spend. {@link MAX_FANOUT_ORGS} is the ceiling and `maxOrgs`
 * lowers it; a fan-out wider than the bound runs the bound's worth and reports
 * how many it left out rather than quietly running some.
 */
export type ScheduleRunAs =
	| {
			/**
			 * A named service role. Resolved through the same RBAC/entitlement path a
			 * human session is, so a scheduled run can never see more than a member
			 * with that role could.
			 */
			kind: 'service'
			role: string
			/** The org the run acts in. Taken at face value for a service identity —
			 * there is no membership to check, and the declaration is the review. */
			orgId?: string
			/** Run once per org instead of once in a declared org — every org in the
			 * project, since a service role has no membership to narrow it. Mutually
			 * exclusive with `orgId`; see the fan-out note above. */
			eachOrg?: boolean
			/** Lower the fan-out's bound below {@link MAX_FANOUT_ORGS}. */
			maxOrgs?: number
	  }
	| {
			/** A specific user's authority — their role, their org, their plan. */
			kind: 'user'
			userId: string
			/**
			 * The org the run acts in. **Re-verified against membership at run time**,
			 * never trusted from here — for `storedRoleOf`'s reason: removing somebody
			 * from an org has to stop the runs their membership authorized, and an org
			 * frozen onto a declaration (or onto a queued job row) is a permission
			 * decision made at the wrong moment.
			 */
			orgId?: string
			/** Run once per org this user is a **member of**, resolved at run time from
			 * the membership rows — so the fan-out narrows the moment somebody leaves an
			 * org, for the reason `orgId` is re-verified rather than trusted. */
			eachOrg?: boolean
			/** Lower the fan-out's bound below {@link MAX_FANOUT_ORGS}. */
			maxOrgs?: number
	  }

/** A declared schedule. */
export interface ScheduleSpec extends Provenanced {
	id: ScheduleId
	/**
	 * The stable key the handler slot is registered under and every job row
	 * carries. Separate from {@link id} for the same reason a flag's key is:
	 * it is the string that appears in code, in the run history, and in every
	 * human conversation about the job.
	 */
	key: string
	/** What the schedule does, in one line. Rendered in admin and the workbench. */
	description: string
	/** IANA timezone the wall-clock kinds are interpreted in (e.g. `America/New_York`). */
	timezone: string
	recurrence: ScheduleRecurrence
	runAs: ScheduleRunAs
	/**
	 * The entity the scheduled work operates over, when there is one. Optional
	 * because plenty of scheduled work is app-wide (nightly cleanup), but
	 * declared when it is not: it is what makes "the monthly invoice run" a
	 * reviewable statement about *invoices* rather than an opaque key.
	 */
	entityId?: EntityId
	/**
	 * A paused schedule keeps its declaration and its history and stops firing.
	 * Pausing is not removal: the usual reason to stop a job is that something is
	 * wrong downstream, and deleting the declaration to stop it also deletes the
	 * thing you need in order to turn it back on.
	 */
	paused?: boolean
	/**
	 * The day the schedule was declared (`YYYY-MM-DD`), stamped by `applyOp` from
	 * the op's `appliedAt`. It is also the anchor an `interval` recurrence counts
	 * from, so it is load-bearing rather than decorative — and a hand-authored
	 * anchor is an anchor that drifts the moment someone copies an op file.
	 */
	declaredAt: ISODate
}

export interface SchedulesSpec {
	schedules: ScheduleSpec[]
}

/** A schedule key: the same shape as a flag key, for the same reasons. */
export const SCHEDULE_KEY_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/

/** `HH:MM`, 24-hour. */
export const SCHEDULE_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** The recurrence discriminators, for validators and generated docs. */
export const SCHEDULE_RECURRENCE_KINDS = [
	'interval',
	'daily',
	'weekly',
	'monthly',
] as const

/** The `runAs` discriminators. */
export const SCHEDULE_RUN_AS_KINDS = ['service', 'user'] as const

/**
 * The most runs one occurrence of an `eachOrg` schedule may fan out to.
 *
 * A bound rather than a preference, and a low one on purpose: a fan-out spends a
 * request per tenant against a third party's rate limit on every fire, so the
 * failure mode of getting this wrong is somebody else's outage plus a dead-letter
 * queue full of 429s. 200 is roughly where a per-tenant nightly pull stops being
 * a background job and starts being a data pipeline that wants its own pacing,
 * batching and windowing — the answer to that is not a bigger number here.
 *
 * A wider fan-out is truncated, not refused, and the truncation is reported: a
 * schedule that silently runs 200 of 5000 tenants reads as working.
 */
export const MAX_FANOUT_ORGS = 200

/**
 * One `runAs` per org, for an `eachOrg` declaration.
 *
 * Pure, and separate from the enumeration for the reason `nextOccurrence` is
 * separate from the scheduler: *which* orgs exist is an IO question the host
 * answers, and *what the runs then are* is a rule that should be answerable
 * without a database — including "what would this have done with 5000 tenants".
 *
 * `orgIds` is taken in the caller's order and truncated from the end, so the same
 * org list produces the same runs on every fire rather than a rotating subset.
 * `eachOrg` and `maxOrgs` are stripped from the runs themselves: a fanned-out run
 * acts in exactly one org, and an identity that still claimed `eachOrg` would be
 * a claim the run cannot honor. So every run this returns carries an org, which is
 * what its type says.
 *
 * A `runAs` that declares no fan-out fans out to **nothing**: it is already one
 * run and the caller enqueues it as itself. Handing it back as a "run" here would
 * be handing back the one case that may carry no org at all.
 */
export function fanOutRunAs(
	runAs: ScheduleRunAs,
	orgIds: readonly string[],
): { runs: (ScheduleRunAs & { orgId: string })[]; skipped: number } {
	if (!runAs.eachOrg) return { runs: [], skipped: 0 }
	const bound = Math.min(runAs.maxOrgs ?? MAX_FANOUT_ORGS, MAX_FANOUT_ORGS)
	const { eachOrg: _eachOrg, maxOrgs: _maxOrgs, ...base } = runAs
	const runs = orgIds
		.slice(0, Math.max(0, bound))
		.map((orgId) => ({ ...base, orgId }) as ScheduleRunAs & { orgId: string })
	return { runs, skipped: Math.max(0, orgIds.length - runs.length) }
}

/**
 * The shortest interval a schedule may declare. One minute is already faster
 * than a poll-based worker can honor precisely; anything below it invites a
 * declaration whose real behavior is "as often as the loop runs".
 */
export const MIN_INTERVAL_MINUTES = 1

/**
 * The longest interval. Past a week, an interval is being used to express a
 * calendar rule ("monthly-ish") that `monthly` expresses exactly — and the
 * `interval` drifts against the calendar while `monthly` does not.
 */
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60

/** Whether `tz` is a timezone this runtime knows. */
export function isValidTimezone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: tz })
		return true
	} catch {
		return false
	}
}

// ===========================================================================
// Timezone arithmetic — Intl only, no dependency, no stored offset table
// ===========================================================================

interface WallClock {
	year: number
	month: number // 1-12
	day: number // 1-31
	hour: number
	minute: number
}

const partsCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(tz: string): Intl.DateTimeFormat {
	let fmt = partsCache.get(tz)
	if (!fmt) {
		fmt = new Intl.DateTimeFormat('en-US', {
			timeZone: tz,
			hour12: false,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		})
		partsCache.set(tz, fmt)
	}
	return fmt
}

/** The wall-clock reading in `tz` at instant `at`. */
export function wallClockIn(
	tz: string,
	at: Date,
): WallClock & { second: number } {
	const parts = formatterFor(tz).formatToParts(at)
	const get = (type: Intl.DateTimeFormatPartTypes): number => {
		const value = parts.find((p) => p.type === type)?.value ?? '0'
		return Number(value)
	}
	// `hour12: false` renders midnight as 24 in some ICU versions.
	const hour = get('hour') % 24
	return {
		year: get('year'),
		month: get('month'),
		day: get('day'),
		hour,
		minute: get('minute'),
		second: get('second'),
	}
}

/** `tz`'s UTC offset in milliseconds at instant `at` (local − UTC). */
function offsetMsAt(tz: string, at: Date): number {
	const wall = wallClockIn(tz, at)
	const asUtc = Date.UTC(
		wall.year,
		wall.month - 1,
		wall.day,
		wall.hour,
		wall.minute,
		wall.second,
	)
	// `asUtc` has no millisecond component, so compare against `at` truncated to
	// the second. Every real zone offset is a whole number of minutes; the
	// milliseconds would otherwise show up as offset noise.
	return asUtc - (at.getTime() - at.getMilliseconds())
}

/**
 * The instant at which `wall` reads on the clock in `tz`.
 *
 * Two-pass, because the offset we need depends on the instant we are solving
 * for. That is not a rounding detail: it is precisely what makes the two DST
 * cases behave as the table in the module note says.
 *
 *  - **Gap (spring forward).** 02:30 does not exist. The first pass guesses with
 *    the pre-transition offset and lands at 03:30 local; the second pass
 *    re-reads the offset there and keeps it. The occurrence moves forward to the
 *    next instant that exists rather than vanishing.
 *  - **Overlap (fall back).** 01:30 happens twice. The first pass uses the
 *    pre-transition (summer) offset, so the earlier of the two is chosen and the
 *    second pass agrees with it. Exactly one occurrence, deterministically the
 *    first — a digest that goes out twice is worse than one that goes out an
 *    hour early.
 */
export function zonedWallClockToInstant(tz: string, wall: WallClock): Date {
	const naive = Date.UTC(
		wall.year,
		wall.month - 1,
		wall.day,
		wall.hour,
		wall.minute,
	)
	const shifted = new Date(naive - offsetMsAt(tz, new Date(naive)))
	const refined = new Date(naive - offsetMsAt(tz, shifted))
	const reading = wallClockIn(tz, refined)
	const matches =
		reading.year === wall.year &&
		reading.month === wall.month &&
		reading.day === wall.day &&
		reading.hour === wall.hour &&
		reading.minute === wall.minute
	// `refined` reads back as the requested wall clock in every case except the
	// gap, where the requested time does not exist at all and the refinement
	// lands an hour *before* it (02:30 → 01:30 EST). `shifted` is the
	// pre-transition guess, which in the gap is the requested time carried across
	// the jump (02:30 → 03:30 EDT) — the "next instant that does exist".
	return matches ? refined : shifted
}

/** Days in `month` (1-12) of `year`. */
export function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function parseTime(atTime: string): { hour: number; minute: number } {
	const match = SCHEDULE_TIME_RE.exec(atTime)
	if (!match) return { hour: 0, minute: 0 }
	return { hour: Number(match[1]), minute: Number(match[2]) }
}

// ===========================================================================
// The next-fire rule
// ===========================================================================

/**
 * The first occurrence of `schedule` strictly after `after`, or `null` when the
 * schedule cannot fire (it is paused).
 *
 * Pure and total: same inputs, same answer, forever. A paused schedule returns
 * `null` rather than a far-future date, so "paused" and "not due yet" are
 * different answers rather than the same one with different arithmetic.
 */
export function nextOccurrence(
	schedule: ScheduleSpec,
	after: Date,
): Date | null {
	if (schedule.paused) return null
	const { recurrence, timezone } = schedule

	if (recurrence.kind === 'interval') {
		const stepMs = recurrence.everyMinutes * 60_000
		const anchor = Date.parse(`${schedule.declaredAt}T00:00:00Z`)
		if (Number.isNaN(anchor)) return null
		const elapsed = after.getTime() - anchor
		// `floor + 1` rather than `ceil`, so an occurrence landing exactly on
		// `after` is behind us — "strictly after" has to stay strict or a
		// scheduler that ticks at the fire instant fires the same one forever.
		const steps = Math.floor(elapsed / stepMs) + 1
		return new Date(anchor + Math.max(1, steps) * stepMs)
	}

	const { hour, minute } = parseTime(recurrence.atTime)
	const from = wallClockIn(timezone, after)

	/** The instant `daysAhead` days after `from`'s local date, at the declared time. */
	const candidateOn = (year: number, month: number, day: number): Date =>
		zonedWallClockToInstant(timezone, { year, month, day, hour, minute })

	if (recurrence.kind === 'daily') {
		// At most two probes: today's occurrence, else tomorrow's. Tomorrow is
		// computed in UTC-day space and re-read through the zone, so a local date
		// rollover across the transition is still one calendar day.
		for (let offset = 0; offset <= 2; offset++) {
			const base = new Date(
				Date.UTC(from.year, from.month - 1, from.day + offset),
			)
			const at = candidateOn(
				base.getUTCFullYear(),
				base.getUTCMonth() + 1,
				base.getUTCDate(),
			)
			if (at.getTime() > after.getTime()) return at
		}
		return null
	}

	if (recurrence.kind === 'weekly') {
		for (let offset = 0; offset <= 8; offset++) {
			const base = new Date(
				Date.UTC(from.year, from.month - 1, from.day + offset),
			)
			if (base.getUTCDay() !== recurrence.onWeekday) continue
			const at = candidateOn(
				base.getUTCFullYear(),
				base.getUTCMonth() + 1,
				base.getUTCDate(),
			)
			if (at.getTime() > after.getTime()) return at
		}
		return null
	}

	// monthly — walk forward month by month, clamping the requested day to the
	// month's length. Two probes is enough (this month, next month) but three
	// costs nothing and removes the need to reason about the boundary.
	for (let offset = 0; offset <= 3; offset++) {
		const monthIndex = from.month - 1 + offset
		const year = from.year + Math.floor(monthIndex / 12)
		const month = ((monthIndex % 12) + 12) % 12 // 0-11
		const day = Math.min(recurrence.onDayOfMonth, daysInMonth(year, month + 1))
		const at = candidateOn(year, month + 1, day)
		if (at.getTime() > after.getTime()) return at
	}
	return null
}

/**
 * Every occurrence in `(after, until]`, oldest first — what a scheduler asks for
 * when it wakes up after being down.
 *
 * `limit` bounds the catch-up. A process that was off for a week must not
 * enqueue ten thousand minutes of a one-minute schedule the moment it comes
 * back; it runs the most recent `limit` and the gap is visible in the run
 * history rather than absorbed silently. The bound is *oldest-first truncation*
 * — we drop the stale end, not the fresh one.
 */
export function occurrencesBetween(
	schedule: ScheduleSpec,
	after: Date,
	until: Date,
	limit = 50,
): Date[] {
	const out: Date[] = []
	let cursor = after
	// The scan itself is bounded independently of `limit` — the window has to be
	// walked to its end to know which occurrences are the recent ones, and a
	// runaway is a bug rather than a policy, so it gets its own hard stop.
	for (let i = 0; i < MAX_OCCURRENCE_SCAN; i++) {
		const next = nextOccurrence(schedule, cursor)
		if (!next || next.getTime() > until.getTime()) break
		out.push(next)
		if (out.length > limit) out.shift()
		cursor = next
	}
	return out
}

/**
 * The hard stop on {@link occurrencesBetween}'s walk. A minute-interval schedule
 * over a two-week window is ~20k occurrences, which is the realistic worst case
 * for a catch-up after a long outage; past that the caller has asked a question
 * about a window nobody should be catching up over.
 */
export const MAX_OCCURRENCE_SCAN = 25_000

/** Every declared schedule, or `[]` for a spec that has never declared one. */
export function listSchedules(
	spec: Pick<SpecSystem, 'schedules'>,
): ScheduleSpec[] {
	return spec.schedules?.schedules ?? []
}

/** The declared schedule with this key, if any. */
export function findSchedule(
	spec: Pick<SpecSystem, 'schedules'>,
	key: string,
): ScheduleSpec | undefined {
	return listSchedules(spec).find((s) => s.key === key)
}

/**
 * The schedules a runtime actually fires: grounded by the same accepted-else-all
 * rule the data and page layers use. A schedule an agent proposed and nobody
 * accepted does not start sending mail — which is the whole point of having a
 * review queue in front of a vocabulary that can now schedule work.
 */
export function activeSchedules(
	spec: Pick<SpecSystem, 'schedules'>,
): ScheduleSpec[] {
	return getAcceptedOrAll(listSchedules(spec)).filter((s) => !s.paused)
}

/** One line of prose for a recurrence — rendered in admin, docs, and diffs. */
export function describeRecurrence(
	recurrence: ScheduleRecurrence,
	timezone: string,
): string {
	switch (recurrence.kind) {
		case 'interval':
			return `every ${recurrence.everyMinutes} min`
		case 'daily':
			return `daily at ${recurrence.atTime} ${timezone}`
		case 'weekly': {
			const days = [
				'Sunday',
				'Monday',
				'Tuesday',
				'Wednesday',
				'Thursday',
				'Friday',
				'Saturday',
			]
			return `weekly on ${days[recurrence.onWeekday] ?? recurrence.onWeekday} at ${recurrence.atTime} ${timezone}`
		}
		case 'monthly':
			return `monthly on day ${recurrence.onDayOfMonth} (clamped to month end) at ${recurrence.atTime} ${timezone}`
	}
}

/** One line of prose for a `runAs` — rendered wherever a run is shown. The org
 * is part of the sentence when one is declared, because "as whom" and "in which
 * tenant" are one question wherever tenant-scoped data is involved — and a
 * fan-out says so *with its bound*, because "once per org" and "once per org, up
 * to 200 of them" are different promises. */
export function describeRunAs(runAs: ScheduleRunAs): string {
	const who =
		runAs.kind === 'service'
			? `service role "${runAs.role}"`
			: `user "${runAs.userId}"`
	if (runAs.eachOrg) {
		const bound = Math.min(runAs.maxOrgs ?? MAX_FANOUT_ORGS, MAX_FANOUT_ORGS)
		const scope =
			runAs.kind === 'service' ? 'every org' : 'every org they belong to'
		return `${who} once in ${scope} (up to ${bound})`
	}
	return runAs.orgId ? `${who} in org "${runAs.orgId}"` : who
}
