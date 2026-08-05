import { beforeEach, describe, expect, it } from 'vitest'
import {
	heuristicPropose,
	loadReviewQueue,
	submitTriage,
} from './review-queue.server'

const scope = globalThis as typeof globalThis & {
	__maxstackFeedback?: unknown[]
	__maxstackIssueDecisions?: unknown[]
}

describe('heuristicPropose', () => {
	it('proposes a cheap spec edit for an expressible field ask, off-surface for a bug', () => {
		const at = '2026-07-11T00:00:00.000Z'
		const [expressible] = heuristicPropose([
			{
				id: 'a',
				at,
				source: 'end-user',
				target: { kind: 'field', id: 'title', parentId: 'task' },
				kind: 'request',
				body: 'x',
				specVersion: 'g',
			},
		])
		expect(expressible?.kind).toBe('spec-op')

		const [offSurface] = heuristicPropose([
			{
				id: 'b',
				at,
				source: 'end-user',
				target: { kind: 'field', id: 'title', parentId: 'task' },
				kind: 'bug', // a bug is never cheaply expressible
				body: 'x',
				specVersion: 'g',
			},
		])
		expect(offSurface?.kind).toBe('off-surface')
	})
})

describe('loadReviewQueue (demo source → cluster → rank → triage)', () => {
	beforeEach(() => {
		scope.__maxstackFeedback = []
		scope.__maxstackIssueDecisions = []
	})

	it('ranks the demo backlog and inverts under the platform view', async () => {
		const product = await loadReviewQueue('product')
		const platform = await loadReviewQueue('platform')
		expect(product.items.length).toBeGreaterThan(0)
		// The demo has an expressible field ask (cheap) and off-surface asks.
		// Product leads with the best demand/cost; platform leads with highest cost.
		expect(product.items[0]?.headline?.factors.costWeight).toBeLessThanOrEqual(
			platform.items[0]?.headline?.factors.costWeight ?? 0,
		)
		expect(platform.items[0]?.headline?.factors.costWeight).toBe(8) // off-surface tops the moat backlog
	})

	it('a persisted triage decision survives a reload (keyed by stable issueKey)', async () => {
		const before = await loadReviewQueue('product')
		const top = before.items[0]
		expect(top?.state).toBe('suggested')

		// Accept the top issue, then reload — it should come back accepted.
		const form = new FormData()
		form.set('intent', 'triage')
		form.set('decision', 'accept')
		form.append('issueKey', top?.key ?? '')
		await submitTriage(form)

		const after = await loadReviewQueue('product')
		const same = after.items.find((i) => i.key === top?.key)
		expect(same?.state).toBe('accepted')

		// Undo (clear) returns it to suggested.
		const undo = new FormData()
		undo.set('intent', 'triage')
		undo.set('decision', 'clear')
		undo.append('issueKey', top?.key ?? '')
		await submitTriage(undo)
		const reset = await loadReviewQueue('product')
		expect(reset.items.find((i) => i.key === top?.key)?.state).toBe('suggested')
	})
})
