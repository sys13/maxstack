import { describe, expect, it } from 'vitest'
import {
	computePriority,
	type PriorityCandidate,
	SEVERITY_WEIGHTS,
	scoreCandidate,
} from './priority.ts'
import type { ExampleChange } from './types.ts'
import { CHANGE_WEIGHTS } from './weights.ts'

/** A minimal `spec-op:apply-op` change (costWeight 1) — the cheapest kind.
 *  `changeWeight` only reads `kind`/`via`, so the op body is irrelevant here. */
function specOpChange(id: string): ExampleChange {
	return {
		id,
		description: id,
		kind: 'spec-op',
		via: 'apply-op',
		op: {} as never,
	}
}

/** A minimal `off-surface` change (costWeight 8) — the most expensive kind. */
function offSurfaceChange(id: string): ExampleChange {
	return {
		id,
		description: id,
		kind: 'off-surface',
		resource: 'x',
		resolution: 'eject',
	}
}

function candidate(
	over: Partial<PriorityCandidate> & Pick<PriorityCandidate, 'id' | 'change'>,
): PriorityCandidate {
	return { reach: 1, severity: 'request', confidence: 1, ...over }
}

describe('scoreCandidate (the demand × cost fusion)', () => {
	it('computes score = (reach × severity × confidence) / costWeight and exposes the factors', () => {
		const r = scoreCandidate(
			candidate({
				id: 'c1',
				change: offSurfaceChange('ch'),
				reach: 10,
				severity: 'bug',
				confidence: 0.5,
			}),
		)
		// 10 × 3 (bug) × 0.5 / 8 (off-surface) = 1.875
		expect(r.score).toBeCloseTo(1.875)
		expect(r.factors).toEqual({
			reach: 10,
			severity: SEVERITY_WEIGHTS.bug,
			confidence: 0.5,
			costWeight: CHANGE_WEIGHTS['off-surface'],
		})
	})

	it('orders severity bug > confusion > request, and praise contributes nothing', () => {
		expect(SEVERITY_WEIGHTS.bug).toBeGreaterThan(SEVERITY_WEIGHTS.confusion)
		expect(SEVERITY_WEIGHTS.confusion).toBeGreaterThan(SEVERITY_WEIGHTS.request)
		const praise = scoreCandidate(
			candidate({ id: 'p', change: specOpChange('ch'), severity: 'praise' }),
		)
		expect(praise.score).toBe(0)
	})

	it('clamps dirty inputs: negative/NaN reach → 0, confidence into 0..1', () => {
		expect(
			scoreCandidate(
				candidate({ id: 'n', change: specOpChange('c'), reach: -5 }),
			).factors.reach,
		).toBe(0)
		expect(
			scoreCandidate(
				candidate({ id: 'c', change: specOpChange('c'), confidence: 2 }),
			).factors.confidence,
		).toBe(1)
		expect(
			scoreCandidate(
				candidate({
					id: 'c',
					change: specOpChange('c'),
					confidence: Number.NaN,
				}),
			).factors.confidence,
		).toBe(0)
	})
})

describe('computePriority (the ranked queue)', () => {
	it('an equal-demand ask that resolves off-surface sinks below one expressible as a spec op', () => {
		// Identical demand; the ONLY difference is how expensively each resolves.
		// This is the epic's core claim: the moat weights double as the queue order.
		const ranked = computePriority([
			candidate({
				id: 'cheap',
				change: specOpChange('ch-cheap'),
				reach: 5,
				severity: 'bug',
			}),
			candidate({
				id: 'expensive',
				change: offSurfaceChange('ch-exp'),
				reach: 5,
				severity: 'bug',
			}),
		])
		expect(ranked.map((r) => r.id)).toEqual(['cheap', 'expensive'])
		// …by exactly the ratio of their cost weights (8× cheaper ⇒ 8× the score).
		const scoreOf = (id: string) => ranked.find((r) => r.id === id)?.score ?? 0
		expect(scoreOf('cheap') / scoreOf('expensive')).toBeCloseTo(
			CHANGE_WEIGHTS['off-surface'] / CHANGE_WEIGHTS['spec-op:apply-op'],
		)
	})

	it('breaks score ties by reach then id — a total, deterministic order', () => {
		// Two candidates engineered to the same score (reach×sev = 6 both), then a
		// third that ties the first on score AND reach, forcing the id tie-break.
		const ranked = computePriority([
			candidate({
				id: 'b',
				change: specOpChange('c'),
				reach: 2,
				severity: 'bug',
			}), // 2×3 = 6
			candidate({
				id: 'a',
				change: specOpChange('c'),
				reach: 3,
				severity: 'confusion',
			}), // 3×2 = 6, higher reach
			candidate({
				id: 'a2',
				change: specOpChange('c'),
				reach: 2,
				severity: 'bug',
			}), // ties 'b' on score+reach → id order
		])
		expect(ranked.map((r) => r.id)).toEqual(['a', 'a2', 'b'])
	})

	it('does not mutate its input', () => {
		const input = [
			candidate({ id: 'z', change: specOpChange('c'), reach: 1 }),
			candidate({ id: 'a', change: specOpChange('c'), reach: 9 }),
		]
		const before = input.map((c) => c.id)
		computePriority(input)
		expect(input.map((c) => c.id)).toEqual(before)
	})
})
