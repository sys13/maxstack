import type { ReviewTarget } from '@maxstack/spec'
import { beforeEach, describe, expect, it } from 'vitest'
import {
	allFeedback,
	captureFeedback,
	type FeedbackInput,
	feedbackView,
} from './feedback.server'

const scope = globalThis as typeof globalThis & {
	__maxstackFeedback?: unknown[]
}

const target: ReviewTarget = { kind: 'field', id: 'title', parentId: 'task' }

function input(over: Partial<FeedbackInput> = {}): FeedbackInput {
	return {
		source: 'end-user',
		target,
		kind: 'confusion',
		body: 'what does this do?',
		specVersion: 'gen-1',
		...over,
	}
}

describe('feedback.server (in-memory host under vitest)', () => {
	beforeEach(() => {
		scope.__maxstackFeedback = []
	})

	it('captures feedback, stamping a unique id and timestamp, and reads it back', async () => {
		const a = await captureFeedback(input())
		const b = await captureFeedback(input({ kind: 'bug' }))
		expect(a.id).not.toBe(b.id)
		expect(a.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
		const all = await allFeedback()
		expect(all.map((f) => f.id)).toEqual([a.id, b.id])
	})

	it('feedbackView folds capture into a summary + newest-first feed', async () => {
		await captureFeedback(input({ kind: 'bug' }))
		await captureFeedback(input({ kind: 'bug' }))
		await captureFeedback(input({ kind: 'praise', source: 'maintainer' }))
		const view = await feedbackView()
		expect(view.summary.total).toBe(3)
		expect(view.summary.byKind.bug).toBe(2)
		expect(view.summary.bySource.maintainer).toBe(1)
		// One target coordinate, so all reach lands in a single bucket.
		expect(view.summary.byTarget).toHaveLength(1)
		expect(view.summary.byTarget[0]?.count).toBe(3)
		// Newest first.
		expect(view.recent[0]?.kind).toBe('praise')
	})
})
