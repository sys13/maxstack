/**
 * Issue #181's gating clause: "time-zone and DST behavior for recurrence
 * declared and tested — 'monthly on the 31st' must have a defined answer."
 *
 * Every case in the table in `schedules.ts`'s module note has a test here, and
 * the tests assert the *documented* answer rather than whatever the arithmetic
 * happens to produce — a scheduling rule nobody wrote down is a scheduling rule
 * that changes the next time somebody refactors the date math.
 */

import { describe, expect, it } from 'vitest'
import { manual } from './provenance.ts'
import {
	activeSchedules,
	daysInMonth,
	describeRecurrence,
	describeRunAs,
	fanOutRunAs,
	findSchedule,
	isValidTimezone,
	MAX_FANOUT_ORGS,
	nextOccurrence,
	occurrencesBetween,
	type ScheduleRecurrence,
	type ScheduleSpec,
	wallClockIn,
} from './schedules.ts'

const schedule = (
	recurrence: ScheduleRecurrence,
	overrides: Partial<ScheduleSpec> = {},
): ScheduleSpec => ({
	id: 'sch-test',
	key: 'test',
	description: 'a test schedule',
	timezone: 'UTC',
	recurrence,
	runAs: { kind: 'service', role: 'scheduler' },
	declaredAt: '2026-01-01',
	provenance: manual(),
	...overrides,
})

const iso = (d: Date | null): string | null => d?.toISOString() ?? null

describe('nextOccurrence — interval', () => {
	it('counts elapsed absolute time from the declaration date', () => {
		const s = schedule(
			{ kind: 'interval', everyMinutes: 60 },
			{ declaredAt: '2026-03-01' },
		)
		expect(iso(nextOccurrence(s, new Date('2026-03-01T00:00:00Z')))).toBe(
			'2026-03-01T01:00:00.000Z',
		)
		expect(iso(nextOccurrence(s, new Date('2026-03-01T00:30:00Z')))).toBe(
			'2026-03-01T01:00:00.000Z',
		)
	})

	it('is strictly after — an occurrence landing exactly on `after` is behind us', () => {
		// Otherwise a scheduler that ticks at the fire instant re-fires the same
		// occurrence forever, which is a duplicate-delivery bug, not a rounding one.
		const s = schedule(
			{ kind: 'interval', everyMinutes: 15 },
			{ declaredAt: '2026-03-01' },
		)
		expect(iso(nextOccurrence(s, new Date('2026-03-01T00:15:00Z')))).toBe(
			'2026-03-01T00:30:00.000Z',
		)
	})

	it('is unaffected by a DST transition — an interval is elapsed time', () => {
		// US spring forward is 2026-03-08 02:00 local (07:00Z). A 6h interval must
		// stay 6h across it: neither doubled nor skipped.
		const s = schedule(
			{ kind: 'interval', everyMinutes: 360 },
			{ declaredAt: '2026-03-08', timezone: 'America/New_York' },
		)
		const first = nextOccurrence(s, new Date('2026-03-08T00:00:00Z'))
		const second = nextOccurrence(s, first as Date)
		expect((second as Date).getTime() - (first as Date).getTime()).toBe(
			6 * 60 * 60 * 1000,
		)
	})
})

describe('nextOccurrence — daily, in the declared timezone', () => {
	it('fires at the declared wall-clock time, not the server’s', () => {
		const s = schedule(
			{ kind: 'daily', atTime: '09:00' },
			{ timezone: 'America/New_York' },
		)
		// 09:00 EST = 14:00Z in January.
		expect(iso(nextOccurrence(s, new Date('2026-01-15T00:00:00Z')))).toBe(
			'2026-01-15T14:00:00.000Z',
		)
		// …and 09:00 EDT = 13:00Z in July. Same declaration, different instant:
		// that is the entire point of storing a zone rather than an offset.
		expect(iso(nextOccurrence(s, new Date('2026-07-15T00:00:00Z')))).toBe(
			'2026-07-15T13:00:00.000Z',
		)
	})

	it('rolls to tomorrow once today’s time has passed', () => {
		const s = schedule({ kind: 'daily', atTime: '02:00' })
		expect(iso(nextOccurrence(s, new Date('2026-05-05T02:00:01Z')))).toBe(
			'2026-05-06T02:00:00.000Z',
		)
	})

	it('a local time that does not exist (spring forward) fires at the next instant that does', () => {
		// America/New_York, 2026-03-08: 02:00 EST jumps to 03:00 EDT, so 02:30
		// never happens. The documented answer is "next existing instant" —
		// 03:30 EDT = 07:30Z — and NOT "skip the day".
		const s = schedule(
			{ kind: 'daily', atTime: '02:30' },
			{ timezone: 'America/New_York' },
		)
		const at = nextOccurrence(s, new Date('2026-03-08T05:00:00Z'))
		expect(iso(at)).toBe('2026-03-08T07:30:00.000Z')
		expect(wallClockIn('America/New_York', at as Date)).toMatchObject({
			hour: 3,
			minute: 30,
		})
	})

	it('a local time that happens twice (fall back) fires once, at the first occurrence', () => {
		// America/New_York, 2026-11-01: 02:00 EDT falls back to 01:00 EST, so
		// 01:30 happens twice — 05:30Z (EDT) and 06:30Z (EST). A digest that goes
		// out twice is worse than one that goes out an hour early, so the rule is
		// "the first one".
		const s = schedule(
			{ kind: 'daily', atTime: '01:30' },
			{ timezone: 'America/New_York' },
		)
		const at = nextOccurrence(s, new Date('2026-11-01T00:00:00Z'))
		expect(iso(at)).toBe('2026-11-01T05:30:00.000Z')
		// And exactly one occurrence lands in the doubled hour.
		const inWindow = occurrencesBetween(
			s,
			new Date('2026-11-01T04:00:00Z'),
			new Date('2026-11-01T08:00:00Z'),
		)
		expect(inWindow.map(iso)).toEqual(['2026-11-01T05:30:00.000Z'])
	})
})

describe('nextOccurrence — weekly', () => {
	it('lands on the declared weekday', () => {
		const s = schedule({ kind: 'weekly', onWeekday: 1, atTime: '08:00' })
		// 2026-05-06 is a Wednesday; the next Monday is 2026-05-11.
		const at = nextOccurrence(s, new Date('2026-05-06T00:00:00Z'))
		expect(iso(at)).toBe('2026-05-11T08:00:00.000Z')
		expect((at as Date).getUTCDay()).toBe(1)
	})

	it('does not fire twice in the same week', () => {
		const s = schedule({ kind: 'weekly', onWeekday: 1, atTime: '08:00' })
		const week = occurrencesBetween(
			s,
			new Date('2026-05-10T00:00:00Z'),
			new Date('2026-05-17T00:00:00Z'),
		)
		expect(week.map(iso)).toEqual(['2026-05-11T08:00:00.000Z'])
	})
})

describe('nextOccurrence — monthly, and the day-31 question', () => {
	it('fires on the last day of a month too short for the declared day', () => {
		// THE documented answer: clamp to month end. Never skip (the naive cron
		// behavior, which silently loses four runs a year) and never roll into the
		// next month (which moves an invoice run into the wrong period).
		const s = schedule({ kind: 'monthly', onDayOfMonth: 31, atTime: '00:00' })
		expect(iso(nextOccurrence(s, new Date('2026-04-01T00:00:01Z')))).toBe(
			'2026-04-30T00:00:00.000Z',
		)
		expect(iso(nextOccurrence(s, new Date('2026-02-01T00:00:01Z')))).toBe(
			'2026-02-28T00:00:00.000Z',
		)
	})

	it('clamps to 29 February in a leap year', () => {
		const s = schedule({ kind: 'monthly', onDayOfMonth: 30, atTime: '00:00' })
		expect(iso(nextOccurrence(s, new Date('2028-02-01T00:00:01Z')))).toBe(
			'2028-02-29T00:00:00.000Z',
		)
	})

	it('fires exactly twelve times a year on the 31st — the run is never lost', () => {
		const s = schedule({ kind: 'monthly', onDayOfMonth: 31, atTime: '00:00' })
		const year = occurrencesBetween(
			s,
			new Date('2026-01-01T00:00:00Z'),
			new Date('2026-12-31T23:59:59Z'),
			50,
		)
		expect(year).toHaveLength(12)
		expect(year.map((d) => d.getUTCMonth())).toEqual([
			0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
		])
	})

	it('crosses the year boundary', () => {
		const s = schedule({ kind: 'monthly', onDayOfMonth: 1, atTime: '00:00' })
		expect(iso(nextOccurrence(s, new Date('2026-12-15T00:00:00Z')))).toBe(
			'2027-01-01T00:00:00.000Z',
		)
	})
})

describe('paused schedules', () => {
	it('never fire, and say so with null rather than a far-future date', () => {
		const s = schedule({ kind: 'interval', everyMinutes: 5 }, { paused: true })
		expect(nextOccurrence(s, new Date('2026-05-05T00:00:00Z'))).toBeNull()
		expect(
			occurrencesBetween(
				s,
				new Date('2026-05-05T00:00:00Z'),
				new Date('2026-05-06T00:00:00Z'),
			),
		).toEqual([])
	})

	it('are excluded from activeSchedules', () => {
		const spec = {
			schedules: {
				schedules: [
					schedule({ kind: 'daily', atTime: '01:00' }),
					schedule(
						{ kind: 'daily', atTime: '02:00' },
						{ id: 'sch-off', key: 'off', paused: true },
					),
				],
			},
		}
		expect(activeSchedules(spec).map((s) => s.key)).toEqual(['test'])
		expect(findSchedule(spec, 'off')?.paused).toBe(true)
	})
})

describe('catch-up', () => {
	it('returns every missed occurrence, oldest first', () => {
		const s = schedule(
			{ kind: 'interval', everyMinutes: 60 },
			{ declaredAt: '2026-03-01' },
		)
		const missed = occurrencesBetween(
			s,
			new Date('2026-03-01T00:00:00Z'),
			new Date('2026-03-01T03:00:00Z'),
		)
		expect(missed.map(iso)).toEqual([
			'2026-03-01T01:00:00.000Z',
			'2026-03-01T02:00:00.000Z',
			'2026-03-01T03:00:00.000Z',
		])
	})

	it('drops the stale end, not the fresh one, when the outage exceeds the bound', () => {
		// A process down for a day on a one-minute schedule must not enqueue 1440
		// runs the moment it comes back. The bound keeps the MOST RECENT `limit`;
		// the gap is then visible in the run history rather than absorbed silently.
		const s = schedule(
			{ kind: 'interval', everyMinutes: 1 },
			{ declaredAt: '2026-03-01' },
		)
		const caught = occurrencesBetween(
			s,
			new Date('2026-03-01T00:00:00Z'),
			new Date('2026-03-01T01:00:00Z'),
			5,
		)
		expect(caught).toHaveLength(5)
		expect(iso(caught[caught.length - 1] ?? null)).toBe(
			'2026-03-01T01:00:00.000Z',
		)
	})
})

describe('helpers', () => {
	it('knows a real timezone from a made-up one', () => {
		expect(isValidTimezone('America/New_York')).toBe(true)
		expect(isValidTimezone('UTC')).toBe(true)
		expect(isValidTimezone('Mars/Olympus_Mons')).toBe(false)
	})

	it('counts days in a month, including February in a leap year', () => {
		expect(daysInMonth(2026, 2)).toBe(28)
		expect(daysInMonth(2028, 2)).toBe(29)
		expect(daysInMonth(2026, 4)).toBe(30)
		expect(daysInMonth(2026, 12)).toBe(31)
	})

	it('renders prose a reviewer can check against the declaration', () => {
		expect(
			describeRecurrence(
				{ kind: 'monthly', onDayOfMonth: 31, atTime: '09:00' },
				'America/New_York',
			),
		).toBe('monthly on day 31 (clamped to month end) at 09:00 America/New_York')
		expect(
			describeRecurrence(
				{ kind: 'weekly', onWeekday: 1, atTime: '08:00' },
				'UTC',
			),
		).toBe('weekly on Monday at 08:00 UTC')
		expect(
			describeRecurrence({ kind: 'interval', everyMinutes: 15 }, 'UTC'),
		).toBe('every 15 min')
		expect(describeRunAs({ kind: 'service', role: 'billing' })).toBe(
			'service role "billing"',
		)
		expect(describeRunAs({ kind: 'user', userId: 'u1' })).toBe('user "u1"')
	})
})

/**
 * The fan-out rule. Pure on purpose, for `nextOccurrence`'s reason:
 * "what would this have done with 5000 tenants" has to be answerable without
 * 5000 tenants, because the alternative is discovering the bound in a deployment
 * that has them.
 */
describe('fanOutRunAs', () => {
	const service = { kind: 'service', role: 'importer' } as const

	it('turns one occurrence into one run per org, each carrying its own', () => {
		const { runs, skipped } = fanOutRunAs({ ...service, eachOrg: true }, [
			'org-a',
			'org-b',
			'org-c',
		])
		expect(runs.map((r) => r.orgId)).toEqual(['org-a', 'org-b', 'org-c'])
		// The borrowed identity is otherwise untouched: a fanned-out run may do
		// exactly what the declaration said, in one tenant.
		expect(runs[0]).toEqual({
			kind: 'service',
			role: 'importer',
			orgId: 'org-a',
		})
		expect(skipped).toBe(0)
	})

	it('strips eachOrg and maxOrgs from the runs it produces', () => {
		const { runs } = fanOutRunAs(
			{ kind: 'user', userId: 'u1', eachOrg: true, maxOrgs: 2 },
			['org-a'],
		)
		// A run that still claimed `eachOrg` would be claiming something it cannot
		// honor — it acts in exactly one org, and the enrichment/tenant path reads
		// `orgId` off it.
		expect(runs[0]).toEqual({ kind: 'user', userId: 'u1', orgId: 'org-a' })
		expect('eachOrg' in (runs[0] ?? {})).toBe(false)
		expect('maxOrgs' in (runs[0] ?? {})).toBe(false)
	})

	it('truncates from the end at the declared bound and reports the remainder', () => {
		const orgs = Array.from({ length: 10 }, (_, i) => `org-${i}`)
		const { runs, skipped } = fanOutRunAs(
			{ ...service, eachOrg: true, maxOrgs: 4 },
			orgs,
		)
		// Stable: the same list produces the same four runs on every fire rather
		// than a rotating subset, so a truncated fan-out is diagnosable.
		expect(runs.map((r) => r.orgId)).toEqual([
			'org-0',
			'org-1',
			'org-2',
			'org-3',
		])
		expect(skipped).toBe(6)
	})

	it('never fans out past the ceiling, whatever maxOrgs says', () => {
		const orgs = Array.from({ length: MAX_FANOUT_ORGS + 50 }, (_, i) => `o${i}`)
		// `maxOrgs` above the ceiling is refused by the validator; a spec that
		// arrived by decoding a hand-edited directory still cannot spend more.
		const { runs, skipped } = fanOutRunAs(
			{ ...service, eachOrg: true, maxOrgs: 100_000 },
			orgs,
		)
		expect(runs).toHaveLength(MAX_FANOUT_ORGS)
		expect(skipped).toBe(50)
	})

	it('fans a declaration with no eachOrg out to nothing — it is already one run', () => {
		expect(fanOutRunAs({ ...service, orgId: 'org-a' }, ['org-b'])).toEqual({
			runs: [],
			skipped: 0,
		})
	})

	it('says the fan-out and its bound in prose, because they are different promises', () => {
		expect(describeRunAs({ ...service, eachOrg: true })).toBe(
			`service role "importer" once in every org (up to ${MAX_FANOUT_ORGS})`,
		)
		expect(
			describeRunAs({ kind: 'user', userId: 'u1', eachOrg: true, maxOrgs: 5 }),
		).toBe('user "u1" once in every org they belong to (up to 5)')
		expect(describeRunAs({ ...service, orgId: 'org-acme' })).toBe(
			'service role "importer" in org "org-acme"',
		)
	})
})
