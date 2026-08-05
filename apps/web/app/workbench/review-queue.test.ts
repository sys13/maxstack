import { suggested } from '@maxstack/spec'
import type { ExampleChange } from '@maxstack/spec-derive'
import { acceptIssue, type Issue } from '@maxstack/spec-derive/clustering'
import { describe, expect, it } from 'vitest'
import { buildReviewQueue } from './review-queue'

function specOp(id: string): ExampleChange {
	return {
		id,
		description: id,
		kind: 'spec-op',
		via: 'apply-op',
		op: {} as never,
	}
}
function offSurface(id: string): ExampleChange {
	return {
		id,
		description: id,
		kind: 'off-surface',
		resource: 'x',
		resolution: 'eject',
	}
}

/** A gated issue with the given candidate + folded-feedback count. */
function issue(
	id: string,
	candidate: ExampleChange | null,
	feedbackCount: number,
): Issue {
	return {
		id,
		question: `q-${id}`,
		title: `Issue ${id}`,
		rationale: 'r',
		targets: [{ kind: 'field', id: `${id}-target`, parentId: 'e' }],
		feedbackIds: Array.from({ length: feedbackCount }, (_, i) => `${id}-f${i}`),
		provenance: suggested(),
		severity: 'bug',
		confidence: 1,
		candidates: candidate ? [candidate] : [],
	}
}

describe('buildReviewQueue — product lens', () => {
	it('ranks by demand-over-cost: a cheap high-demand issue leads', () => {
		// Same demand (reach 5); cheap spec-op should out-score the off-surface one.
		const model = buildReviewQueue(
			[
				issue('exp', offSurface('c-exp'), 5),
				issue('cheap', specOp('c-cheap'), 5),
			],
			'product',
		)
		expect(model.items.map((i) => i.issueId)).toEqual(['cheap', 'exp'])
		expect(model.items[0]?.headline?.score).toBeGreaterThan(
			model.items[1]?.headline?.score ?? 0,
		)
	})

	it('sinks candidate-less issues to the bottom', () => {
		const model = buildReviewQueue(
			[issue('none', null, 9), issue('has', specOp('c'), 1)],
			'product',
		)
		expect(model.items.map((i) => i.issueId)).toEqual(['has', 'none'])
		expect(model.items[1]?.headline).toBeNull()
	})
})

describe('buildReviewQueue — platform lens (same list, inverted)', () => {
	it('floats the most expensive-to-express asks to the top (the moat backlog)', () => {
		const issues = [
			issue('cheap', specOp('c-cheap'), 5),
			issue('exp', offSurface('c-exp'), 5),
		]
		// Product leads with cheap; platform leads with expensive — same issues.
		expect(
			buildReviewQueue(issues, 'product').items.map((i) => i.issueId),
		).toEqual(['cheap', 'exp'])
		expect(
			buildReviewQueue(issues, 'platform').items.map((i) => i.issueId),
		).toEqual(['exp', 'cheap'])
	})
})

describe('buildReviewQueue — stats', () => {
	it('counts states and flags the moat gap (off-surface headlines)', () => {
		const model = buildReviewQueue([
			acceptIssue(issue('a', offSurface('c1'), 2)),
			issue('b', specOp('c2'), 1),
			issue('c', offSurface('c3'), 1),
		])
		expect(model.stats.total).toBe(3)
		expect(model.stats.byState.accepted).toBe(1)
		expect(model.stats.byState.suggested).toBe(2)
		expect(model.stats.moatGap).toBe(2) // 'a' and 'c' resolve only off-surface
	})

	it('does not mutate the input array order', () => {
		const issues = [issue('z', specOp('c'), 1), issue('a', specOp('c'), 9)]
		const before = issues.map((i) => i.id)
		buildReviewQueue(issues, 'product')
		expect(issues.map((i) => i.id)).toEqual(before)
	})
})
