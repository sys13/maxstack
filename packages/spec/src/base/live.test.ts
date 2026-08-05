/**
 * The live layer — every refusal, named after the thing it
 * prevents rather than after the rule it enforces.
 *
 * Two properties are being pinned here, and they fail in different directions,
 * which is why the file is organized around them rather than around the op
 * names:
 *
 *  - **Exposure.** A push is a read. Everything `portals.test.ts` asserts about
 *    a projection applies here, with the sharper edge that a push happens on
 *    every write rather than on a request somebody made.
 *  - **Load.** A declaration decides what the app does to itself while people
 *    are watching. The ceilings are required, the unfiltered case is capped much
 *    lower, and the diff summary states the *product* of the two, because
 *    neither factor alone is the number that hurts.
 *
 * And one property that is neither: **scope discipline**. Presence is
 * row-scoped and carries nothing but identities, and both of those refusals
 * exist so the primitive cannot grow into the co-editing layer this issue puts
 * out of scope by recorded decision.
 */

import { describe, expect, it } from 'vitest'
import { tasklyPRD } from '../fixtures/index.ts'
import type { EntityId, FieldId, LiveId } from './ids.ts'
import {
	activeLiveSubscriptions,
	describeLiveSubscription,
	findLiveSubscription,
	findLiveSubscriptionByKey,
	listLiveSubscriptions,
	liveLoadReport,
	MAX_LIVE_MESSAGE_RATE,
	MAX_LIVE_SUBSCRIBERS,
	MAX_PRESENCE_TTL_SECONDS,
	MAX_PRESENT,
	MAX_UNBOUNDED_SUBSCRIBERS,
	summarizeLiveLoad,
} from './live.ts'
import { manual, suggested } from './provenance.ts'
import {
	type ApplyMeta,
	applyOp,
	diffOp,
	type LiveSubscriptionSpecInput,
	type SpecOp,
	validateOp,
} from './spec-ops.ts'
import { newSpecSystem, type SpecSystem } from './spec-system.ts'

const meta = (n: number): ApplyMeta => ({
	actor: { surface: 'harness' },
	id: `op-lv-${n}`,
	origin: 'human',
	appliedAt: '2026-07-29',
})

/** A board-shaped app: tasks with a project reference, a status, and an avatar. */
function baseSystem(): SpecSystem {
	const spec = newSpecSystem(tasklyPRD)
	spec.data.entities = [
		{
			id: 'e-task',
			name: 'Task',
			fields: [
				{
					id: 'fld-title',
					name: 'title',
					type: 'string',
					required: true,
					provenance: manual(),
				},
				{
					id: 'fld-status',
					name: 'status',
					type: 'enum',
					required: true,
					provenance: manual(),
				},
				{
					id: 'fld-project',
					name: 'project',
					type: 'string',
					required: false,
					provenance: manual(),
				},
				{
					id: 'fld-due',
					name: 'dueDate',
					type: 'date',
					required: false,
					provenance: manual(),
				},
				{
					id: 'fld-avatar',
					name: 'avatar',
					type: 'file',
					required: false,
					provenance: manual(),
				},
			],
			provenance: manual(),
		},
		{
			id: 'e-note',
			name: 'Note',
			fields: [
				{
					id: 'fld-note-body',
					name: 'body',
					type: 'string',
					required: true,
					provenance: manual(),
				},
			],
			provenance: manual(),
		},
	]
	return spec
}

/** A well-formed `query` declaration; spread over it to break exactly one rule. */
function querySub(
	over: Partial<LiveSubscriptionSpecInput> = {},
): LiveSubscriptionSpecInput {
	return {
		id: 'lv-board' as LiveId,
		key: 'board',
		description: 'Push task changes to whoever has the board open.',
		entityId: 'e-task' as EntityId,
		kind: 'query',
		fields: ['fld-title', 'fld-status'] as FieldId[],
		scope: { kind: 'filtered', fieldId: 'fld-project' as FieldId },
		maxSubscribers: 200,
		maxMessagesPerMinute: 120,
		slot: true,
		paused: false,
		provenance: manual(),
		...over,
	}
}

/** A well-formed `presence` declaration. */
function presenceSub(
	over: Partial<LiveSubscriptionSpecInput> = {},
): LiveSubscriptionSpecInput {
	return {
		id: 'lv-viewers' as LiveId,
		key: 'viewers',
		description: 'Who is looking at this task right now.',
		entityId: 'e-task' as EntityId,
		kind: 'presence',
		fields: [],
		scope: { kind: 'row' },
		maxSubscribers: 200,
		maxMessagesPerMinute: 60,
		presenceTtlSeconds: 30,
		maxPresent: 20,
		slot: false,
		paused: false,
		provenance: manual(),
		...over,
	}
}

const declare = (sub: LiveSubscriptionSpecInput): SpecOp => ({
	op: 'live.declare',
	args: { subscription: sub },
})

/** Every error `live.declare` reports for this declaration on a fresh system. */
function errorsFor(
	sub: LiveSubscriptionSpecInput,
	system: SpecSystem = baseSystem(),
): string[] {
	return validateOp(system, declare(sub))
}

/** A system with the standard query channel already declared. */
function withBoard(): SpecSystem {
	return applyOp(baseSystem(), declare(querySub()), meta(1))
}

describe('a live declaration is bounded by construction', () => {
	it('accepts a filtered query channel with both ceilings stated', () => {
		expect(errorsFor(querySub())).toEqual([])
	})

	it('refuses a channel with no bound at all — that is a broadcast of the table', () => {
		const errors = errorsFor(
			querySub({
				scope: undefined as unknown as LiveSubscriptionSpecInput['scope'],
			}),
		)
		expect(errors.join('\n')).toMatch(/scope must be/)
		expect(errors.join('\n')).toMatch(/broadcast of the whole table/)
	})

	it('refuses an unfiltered channel that expects more than a team-sized audience', () => {
		// The `all` scope is legal — a small internal ops dashboard is the honest
		// case — but the subscriber cap is where an author says which one they
		// meant. Past the cap the declaration describes a customer base, and the
		// cost of an unfiltered channel is writes × subscribers with no term that
		// shrinks.
		expect(
			errorsFor(
				querySub({
					scope: { kind: 'all' },
					maxSubscribers: MAX_UNBOUNDED_SUBSCRIBERS,
				}),
			),
		).toEqual([])
		const errors = errorsFor(
			querySub({
				scope: { kind: 'all' },
				maxSubscribers: MAX_UNBOUNDED_SUBSCRIBERS + 1,
			}),
		)
		expect(errors.join('\n')).toMatch(/scope "all" may declare at most 100/)
		expect(errors.join('\n')).toMatch(/size of a TEAM/)
	})

	it('refuses a bound on a column an equality cannot be read off', () => {
		// A date bound matches a microsecond; the failure is silent at runtime,
		// which is why it is refused at declare time.
		expect(
			errorsFor(
				querySub({
					scope: { kind: 'filtered', fieldId: 'fld-due' as FieldId },
				}),
			).join('\n'),
		).toMatch(/is a date — a bound has to be an equality/)
	})

	it('refuses a bound naming a field of a different entity', () => {
		// It RESOLVES, which is the whole problem: the id is real, just not here.
		expect(
			errorsFor(
				querySub({
					scope: { kind: 'filtered', fieldId: 'fld-note-body' as FieldId },
				}),
			).join('\n'),
		).toMatch(/is not a field of entity "e-task"/)
	})
})

describe('both ceilings are decisions, never defaults', () => {
	it('refuses a channel that does not say how many connections it may hold', () => {
		const errors = errorsFor(
			querySub({ maxSubscribers: undefined as unknown as number }),
		)
		expect(errors.join('\n')).toMatch(/maxSubscribers must be an integer/)
		expect(errors.join('\n')).toMatch(/decision about somebody's deployment/)
	})

	it('refuses a channel that does not say how fast it may push', () => {
		const errors = errorsFor(
			querySub({ maxMessagesPerMinute: undefined as unknown as number }),
		)
		expect(errors.join('\n')).toMatch(/maxMessagesPerMinute must be an integer/)
		// The posture, not just the bound: shed, never buffer.
		expect(errors.join('\n')).toMatch(/SHED with a reason rather than buffered/)
	})

	it('refuses ceilings past what one process serves', () => {
		expect(
			errorsFor(querySub({ maxSubscribers: MAX_LIVE_SUBSCRIBERS + 1 })).join(
				'\n',
			),
		).toMatch(/maxSubscribers must be an integer 1–10000/)
		expect(
			errorsFor(
				querySub({ maxMessagesPerMinute: MAX_LIVE_MESSAGE_RATE + 1 }),
			).join('\n'),
		).toMatch(/maxMessagesPerMinute must be an integer 1–600/)
	})
})

describe('a push is a read, so the payload is opt-in', () => {
	it('refuses a query channel that names no fields — there is no "push everything"', () => {
		const errors = errorsFor(querySub({ fields: [] }))
		expect(errors.join('\n')).toMatch(/must name at least one field/)
		expect(errors.join('\n')).toMatch(/no "push everything" spelling/)
	})

	it('refuses pushing a file column — a storage key on a push is a storage key on the wire', () => {
		const errors = errorsFor(
			querySub({ fields: ['fld-title', 'fld-avatar'] as FieldId[] }),
		)
		expect(errors.join('\n')).toMatch(/may not be pushed/)
		expect(errors.join('\n')).toMatch(/object path rather than a value/)
	})

	it("refuses a field of another entity — it resolves, and would push somebody else's column", () => {
		expect(
			errorsFor(querySub({ fields: ['fld-note-body'] as FieldId[] })).join(
				'\n',
			),
		).toMatch(/is not a field of entity "e-task"/)
	})

	it('refuses a duplicated field', () => {
		expect(
			errorsFor(
				querySub({ fields: ['fld-title', 'fld-title'] as FieldId[] }),
			).join('\n'),
		).toMatch(/names "fld-title" twice/)
	})
})

describe('presence cannot grow into a cursor protocol', () => {
	it('accepts a row-scoped, field-less presence channel', () => {
		expect(errorsFor(presenceSub())).toEqual([])
	})

	it('refuses a presence channel wider than one row — that is a live user directory', () => {
		const errors = errorsFor(presenceSub({ scope: { kind: 'all' } }))
		expect(errors.join('\n')).toMatch(/requires scope \{kind:"row"\}/)
		expect(errors.join('\n')).toMatch(/live directory of everyone in the app/)
	})

	it('refuses a presence channel that carries row data — a payload is where a cursor grows', () => {
		const errors = errorsFor(
			presenceSub({ fields: ['fld-title'] as FieldId[] }),
		)
		expect(errors.join('\n')).toMatch(/must declare no fields/)
		expect(errors.join('\n')).toMatch(/where a cursor protocol grows/)
	})

	it('refuses a presence entry that never expires — a crashed tab sends no goodbye', () => {
		expect(
			errorsFor(
				presenceSub({ presenceTtlSeconds: undefined as unknown as number }),
			).join('\n'),
		).toMatch(/presenceTtlSeconds must be an integer/)
		expect(
			errorsFor(
				presenceSub({ presenceTtlSeconds: MAX_PRESENCE_TTL_SECONDS + 1 }),
			).join('\n'),
		).toMatch(/presenceTtlSeconds must be an integer 1–300/)
	})

	it('refuses an uncapped presence list — a hundred identities is a directory export', () => {
		expect(
			errorsFor(
				presenceSub({ maxPresent: undefined as unknown as number }),
			).join('\n'),
		).toMatch(/maxPresent must be an integer/)
		expect(
			errorsFor(presenceSub({ maxPresent: MAX_PRESENT + 1 })).join('\n'),
		).toMatch(/maxPresent must be an integer 1–100/)
	})

	it('refuses presence settings on a query channel and vice versa', () => {
		expect(errorsFor(querySub({ presenceTtlSeconds: 30 })).join('\n')).toMatch(
			/presenceTtlSeconds is only legal on kind "presence"/,
		)
		expect(errorsFor(querySub({ maxPresent: 5 })).join('\n')).toMatch(
			/maxPresent is only legal on kind "presence"/,
		)
	})

	it('has no third kind — a caller-composed payload has no row to authorize against', () => {
		const errors = errorsFor(
			querySub({
				kind: 'event' as unknown as LiveSubscriptionSpecInput['kind'],
			}),
		)
		expect(errors.join('\n')).toMatch(/is not one of query, presence/)
		expect(errors.join('\n')).toMatch(/no row to check/)
	})
})

describe('one channel of each kind per entity', () => {
	it('accepts a query and a presence channel on the same entity', () => {
		const s = applyOp(withBoard(), declare(presenceSub()), meta(2))
		expect(listLiveSubscriptions(s)).toHaveLength(2)
		expect(findLiveSubscription(s, 'e-task' as EntityId, 'query')?.key).toBe(
			'board',
		)
		expect(findLiveSubscription(s, 'e-task' as EntityId, 'presence')?.key).toBe(
			'viewers',
		)
	})

	it('refuses a second query channel — every write would pay for both, forever', () => {
		const errors = errorsFor(
			querySub({ id: 'lv-board2' as LiveId, key: 'board2' }),
			withBoard(),
		)
		expect(errors.join('\n')).toMatch(/already declares a "query" channel/)
		expect(errors.join('\n')).toMatch(/double that cost forever/)
	})

	it('refuses a duplicated key — a key is a URL segment and a metric label', () => {
		expect(
			errorsFor(querySub({ id: 'lv-other' as LiveId }), withBoard()).join('\n'),
		).toMatch(/live key "board" already exists/)
	})

	it('refuses a duplicated id', () => {
		expect(
			errorsFor(querySub({ key: 'other' }), withBoard()).join('\n'),
		).toMatch(/lv-board/)
	})
})

describe('the edit ops', () => {
	it('live.setFields re-validates against the KIND, not just the ids', () => {
		// Spliced into the whole declaration rather than checked alone: a field
		// list that is fine for a query channel is illegal for a presence one, and
		// validating ids in isolation would accept a payload only legal elsewhere.
		const s = applyOp(withBoard(), declare(presenceSub()), meta(2))
		expect(
			validateOp(s, {
				op: 'live.setFields',
				args: {
					subscriptionId: 'lv-viewers' as LiveId,
					fields: ['fld-title'] as FieldId[],
				},
			}).join('\n'),
		).toMatch(/must declare no fields/)
	})

	it('live.setFields refuses a file column on the way in, not only at declare time', () => {
		expect(
			validateOp(withBoard(), {
				op: 'live.setFields',
				args: {
					subscriptionId: 'lv-board' as LiveId,
					fields: ['fld-avatar'] as FieldId[],
				},
			}).join('\n'),
		).toMatch(/may not be pushed/)
	})

	it('live.setFields replaces wholesale, last-wins', () => {
		const s = applyOp(
			withBoard(),
			{
				op: 'live.setFields',
				args: {
					subscriptionId: 'lv-board' as LiveId,
					fields: ['fld-status'] as FieldId[],
				},
			},
			meta(2),
		)
		expect(listLiveSubscriptions(s)[0]?.fields).toEqual(['fld-status'])
	})

	it('live.setLimits re-checks the unfiltered cap against the declared SCOPE', () => {
		// The legal subscriber ceiling depends on the bound, which is not in this
		// op's arguments — so it has to be re-validated against the declaration.
		const s = applyOp(
			baseSystem(),
			declare(querySub({ scope: { kind: 'all' }, maxSubscribers: 50 })),
			meta(1),
		)
		expect(
			validateOp(s, {
				op: 'live.setLimits',
				args: {
					subscriptionId: 'lv-board' as LiveId,
					maxSubscribers: 5000,
					maxMessagesPerMinute: 60,
				},
			}).join('\n'),
		).toMatch(/scope "all" may declare at most 100/)
	})

	it('live.setLimits assigns both ceilings together', () => {
		const s = applyOp(
			withBoard(),
			{
				op: 'live.setLimits',
				args: {
					subscriptionId: 'lv-board' as LiveId,
					maxSubscribers: 10,
					maxMessagesPerMinute: 6,
				},
			},
			meta(2),
		)
		const sub = listLiveSubscriptions(s)[0]
		expect(sub?.maxSubscribers).toBe(10)
		expect(sub?.maxMessagesPerMinute).toBe(6)
	})

	it('live.pause keeps the declaration, and is what makes shedding an option', () => {
		const s = applyOp(
			withBoard(),
			{
				op: 'live.pause',
				args: { subscriptionId: 'lv-board' as LiveId, paused: true },
			},
			meta(2),
		)
		expect(listLiveSubscriptions(s)).toHaveLength(1)
		expect(listLiveSubscriptions(s)[0]?.fields).toEqual([
			'fld-title',
			'fld-status',
		])
		expect(activeLiveSubscriptions(s)).toHaveLength(0)
	})

	it('live.remove is refused while the channel still accepts connections', () => {
		expect(
			validateOp(withBoard(), {
				op: 'live.remove',
				args: { subscriptionId: 'lv-board' as LiveId },
			}).join('\n'),
		).toMatch(/still accepting connections/)
	})

	it('live.remove lands once it is paused', () => {
		const paused = applyOp(
			withBoard(),
			{
				op: 'live.pause',
				args: { subscriptionId: 'lv-board' as LiveId, paused: true },
			},
			meta(2),
		)
		expect(
			validateOp(paused, {
				op: 'live.remove',
				args: { subscriptionId: 'lv-board' as LiveId },
			}),
		).toEqual([])
		const removed = applyOp(
			paused,
			{ op: 'live.remove', args: { subscriptionId: 'lv-board' as LiveId } },
			meta(3),
		)
		expect(listLiveSubscriptions(removed)).toEqual([])
	})

	it('every edit op refuses an unknown subscription rather than silently doing nothing', () => {
		const s = withBoard()
		const unknown = 'lv-nope' as LiveId
		for (const op of [
			{ op: 'live.setFields', args: { subscriptionId: unknown, fields: [] } },
			{
				op: 'live.setLimits',
				args: {
					subscriptionId: unknown,
					maxSubscribers: 1,
					maxMessagesPerMinute: 1,
				},
			},
			{ op: 'live.pause', args: { subscriptionId: unknown, paused: true } },
			{ op: 'live.remove', args: { subscriptionId: unknown } },
		] as SpecOp[]) {
			expect(validateOp(s, op).join('\n')).toMatch(/unknown live subscription/)
		}
	})
})

describe('the diff is what somebody reads before this holds connections open', () => {
	it('names the bound and both ceilings on a declare', () => {
		const diff = diffOp(declare(querySub()))
		expect(diff.layer).toBe('live')
		expect(diff.summary).toMatch(/QUERY channel "board"/)
		expect(diff.summary).toMatch(/rows matching fld-project/)
		expect(diff.summary).toMatch(/≤200 subscribers at ≤120\/min/)
	})

	it('states the PRODUCT of the two ceilings on a setLimits, not the factors', () => {
		// Neither factor alone is the number that hurts; what the process has to
		// serialize and send is their product, and a reviewer who has to multiply
		// is a reviewer who will not.
		const diff = diffOp({
			op: 'live.setLimits',
			args: {
				subscriptionId: 'lv-board' as LiveId,
				maxSubscribers: 200,
				maxMessagesPerMinute: 120,
			},
		})
		expect(diff.summary).toMatch(/up to 24000 messages\/minute/)
	})

	it('says a pause degrades to polling rather than breaking the surface', () => {
		expect(
			diffOp({
				op: 'live.pause',
				args: { subscriptionId: 'lv-board' as LiveId, paused: true },
			}).summary,
		).toMatch(/fall back to polling/)
	})
})

describe('the readers', () => {
	it('activeLiveSubscriptions is accepted-else-all minus paused', () => {
		// Deliberately NOT activePortals' accepted-only rule: a live channel reaches
		// nobody a read op would not already reach (every message is authorized per
		// message), so the worst case of the fallback is a surface that updates by
		// itself for people who could already see it.
		const s = applyOp(
			baseSystem(),
			declare(querySub({ provenance: suggested() })),
			meta(1),
		)
		expect(activeLiveSubscriptions(s)).toHaveLength(1)
		const accepted = applyOp(s, declare(presenceSub()), meta(2))
		// Once ANY channel is accepted, the unaccepted suggestion stops counting.
		expect(activeLiveSubscriptions(accepted).map((l) => l.key)).toEqual([
			'viewers',
		])
	})

	it('findLiveSubscriptionByKey and describeLiveSubscription answer the two support questions', () => {
		const s = withBoard()
		const sub = findLiveSubscriptionByKey(s, 'board')
		if (!sub) throw new Error('expected the board channel')
		expect(describeLiveSubscription(sub)).toMatch(
			/query over e-task — rows matching fld-project, 2 field\(s\)/,
		)
		expect(describeLiveSubscription({ ...sub, paused: true })).toMatch(
			/paused$/,
		)
	})

	it('the load report multiplies, and says the fan-out bound in words', () => {
		const s = applyOp(withBoard(), declare(presenceSub()), meta(2))
		const report = liveLoadReport(s)
		expect(report.map((r) => r.key)).toEqual(['board', 'viewers'])
		expect(report[0]?.peakMessagesPerMinute).toBe(200 * 120)
		expect(report[0]?.bound).toBe('filtered:fld-project')
		const summary = summarizeLiveLoad(report)
		expect(summary).toMatch(/36,000 messages\/minute/)
		// The reach of that peak, in the artifact a reviewer actually reads. It
		// used to say the fan-out was per container; since issue #228 the number
		// is per deployment, and the sentence somebody sizes a deployment from
		// has to say which.
		expect(summary).toMatch(/Fan-out is shared across instances/)
	})

	it('says "no live channels" in words rather than printing an empty table', () => {
		// An empty load report and a missing one look identical and mean opposite
		// things.
		expect(summarizeLiveLoad(liveLoadReport(baseSystem()))).toMatch(
			/No live channels declared/,
		)
	})
})
