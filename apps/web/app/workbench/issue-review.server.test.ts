import { suggested } from '@maxstack/spec'
import type { Issue } from '@maxstack/spec-derive/clustering'
import { issueState } from '@maxstack/spec-derive/clustering'
import { beforeEach, describe, expect, it } from 'vitest'
import {
	applyDecisions,
	type DecisionRecord,
	foldDecisions,
	loadDecisions,
	recordDecision,
} from './issue-review.server'

const scope = globalThis as typeof globalThis & {
	__maxstackIssueDecisions?: unknown[]
}

function issue(id: string, coord: string): Issue {
	return {
		id,
		question: 'q',
		title: id,
		rationale: 'r',
		targets: [{ kind: 'page', id: coord }],
		feedbackIds: ['f'],
		provenance: suggested(),
		severity: 'bug',
		confidence: 1,
		candidates: [],
	}
}
// issueKey of the above = `page:<coord>`.

function rec(
	issueKey: string,
	decision: DecisionRecord['decision'],
): DecisionRecord {
	return { issueKey, decision, at: '2026-07-11T00:00:00.000Z' }
}

describe('foldDecisions (latest-wins, clear resets)', () => {
	it('keeps the latest decision per key and drops cleared keys', () => {
		const map = foldDecisions([
			rec('page:a', 'accept'),
			rec('page:b', 'reject'),
			rec('page:a', 'reject'), // supersedes the earlier accept
			rec('page:b', 'clear'), // Undo → back to undecided
		])
		expect(map.get('page:a')).toBe('reject')
		expect(map.has('page:b')).toBe(false)
	})
})

describe('applyDecisions (transition provenance by stable key)', () => {
	it('accepts/rejects matched issues and leaves undecided ones suggested', () => {
		const decisions = foldDecisions([
			rec('page:x', 'accept'),
			rec('page:y', 'reject'),
		])
		const [x, y, z] = applyDecisions(
			[issue('i1', 'x'), issue('i2', 'y'), issue('i3', 'z')],
			decisions,
		)
		expect(x && issueState(x)).toBe('accepted')
		expect(y && issueState(y)).toBe('rejected')
		expect(z && issueState(z)).toBe('suggested')
	})
})

describe('recordDecision + loadDecisions (in-memory host)', () => {
	beforeEach(() => {
		scope.__maxstackIssueDecisions = []
	})

	it('persists decisions and folds them latest-wins on read', async () => {
		await recordDecision('page:a', 'accept')
		await recordDecision('page:a', 'reject')
		await recordDecision('page:b', 'accept')
		await recordDecision('page:b', 'clear')
		const map = await loadDecisions()
		expect(map.get('page:a')).toBe('reject')
		expect(map.has('page:b')).toBe(false)
	})
})
