import { describe, expect, it } from 'vitest'
import {
	type Feedback,
	parseFeedbackLog,
	recentFeedback,
	serializeFeedbackLog,
	summarizeFeedback,
	targetKey,
} from './feedback.ts'
import type { ReviewTarget } from './spec-ops.ts'

function fb(over: Partial<Feedback> & Pick<Feedback, 'id'>): Feedback {
	return {
		at: '2026-07-11T00:00:00.000Z',
		source: 'end-user',
		target: { kind: 'field', id: 'title', parentId: 'task' },
		kind: 'confusion',
		body: 'what does this mean?',
		specVersion: 'gen-1',
		...over,
	}
}

describe('serialize / parse (JSONL, append-only)', () => {
	it('round-trips a log through JSONL and appends concatenate cleanly', () => {
		const log = [fb({ id: 'f1' }), fb({ id: 'f2', kind: 'bug' })]
		const text = serializeFeedbackLog(log)
		expect(text.endsWith('\n')).toBe(true)
		expect(parseFeedbackLog(text)).toEqual(log)
		// An append is just string concatenation.
		const more = serializeFeedbackLog([fb({ id: 'f3' })])
		expect(parseFeedbackLog(text + more).map((f) => f.id)).toEqual([
			'f1',
			'f2',
			'f3',
		])
	})

	it('skips blank lines on parse', () => {
		const text = `${serializeFeedbackLog([fb({ id: 'f1' })])}\n  \n`
		expect(parseFeedbackLog(text).map((f) => f.id)).toEqual(['f1'])
	})
})

describe('targetKey', () => {
	it('disambiguates nested rows by parentId and collapses same-coordinate hits', () => {
		const a: ReviewTarget = { kind: 'field', id: 'title', parentId: 'task' }
		const b: ReviewTarget = { kind: 'field', id: 'title', parentId: 'project' }
		expect(targetKey(a)).not.toBe(targetKey(b))
		expect(targetKey({ kind: 'page', id: 'home' })).toBe('page:home')
	})
})

describe('summarizeFeedback', () => {
	it('tallies by kind and source and ranks targets by reach (demand proxy)', () => {
		const t1: ReviewTarget = { kind: 'field', id: 'title', parentId: 'task' }
		const t2: ReviewTarget = { kind: 'page', id: 'home' }
		const summary = summarizeFeedback([
			fb({ id: 'a', target: t1, kind: 'bug', source: 'end-user' }),
			fb({ id: 'b', target: t1, kind: 'confusion', source: 'telemetry' }),
			fb({ id: 'c', target: t1, kind: 'bug', source: 'end-user' }),
			fb({ id: 'd', target: t2, kind: 'request', source: 'maintainer' }),
		])
		expect(summary.total).toBe(4)
		expect(summary.byKind).toEqual({
			bug: 2,
			confusion: 1,
			request: 1,
			praise: 0,
		})
		expect(summary.bySource).toEqual({
			'end-user': 2,
			telemetry: 1,
			maintainer: 1,
		})
		// t1 (3 hits) outranks t2 (1 hit) — highest reach first.
		expect(summary.byTarget.map((t) => [targetKey(t.target), t.count])).toEqual(
			[
				[targetKey(t1), 3],
				[targetKey(t2), 1],
			],
		)
	})

	it('is deterministic for equal-reach targets (tie-broken by key)', () => {
		const p1: ReviewTarget = { kind: 'page', id: 'a' }
		const p2: ReviewTarget = { kind: 'page', id: 'b' }
		const s = summarizeFeedback([
			fb({ id: '2', target: p2 }),
			fb({ id: '1', target: p1 }),
		])
		expect(s.byTarget.map((t) => t.target.id)).toEqual(['a', 'b'])
	})
})

describe('recentFeedback', () => {
	it('returns the newest n, newest first', () => {
		const log = [fb({ id: 'f1' }), fb({ id: 'f2' }), fb({ id: 'f3' })]
		expect(recentFeedback(log, 2).map((f) => f.id)).toEqual(['f3', 'f2'])
	})
})
