/**
 * Implicit confusion feedback wiring: the threshold gates on
 * `flagReversalIfThrashing` (rapid re-reject) and `submitConfusionSignal`
 * (client-posted focus-thrash) — below threshold emits nothing, at/above
 * emits exactly one `Feedback` row into the same log #9/#10 use, and a
 * second crossing doesn't duplicate it.
 *
 * Runs against the in-memory telemetry/feedback hosts (no `MAXSTACK_DATA_DIR`
 * under vitest — see `data-dir.server.ts`), so no platform/spec stub needed.
 */
import type { ReviewTarget } from '@maxstack/spec'
import { beforeEach, describe, expect, it } from 'vitest'
import { allFeedback } from './feedback.server'
import { recordEvent } from './telemetry.server'
import {
	flagReversalIfThrashing,
	submitConfusionSignal,
} from './workbench.server'

const scope = globalThis as typeof globalThis & {
	__maxstackFeedback?: unknown[]
	__maxstackWorkbenchEvents?: unknown[]
}

const target: ReviewTarget = { kind: 'field', id: 'title', parentId: 'task' }

beforeEach(() => {
	scope.__maxstackFeedback = []
	scope.__maxstackWorkbenchEvents = []
})

function confusionSignalForm(over: Record<string, string> = {}): FormData {
	const form = new FormData()
	form.set('kind', 'field')
	form.set('id', 'title')
	form.set('cycles', '3')
	for (const [k, v] of Object.entries(over)) form.set(k, v)
	return form
}

describe('flagReversalIfThrashing (rapid re-reject)', () => {
	it('emits nothing below the reversal threshold', async () => {
		await recordEvent('accept', { targetId: 'title' })
		await flagReversalIfThrashing(target)
		expect(await allFeedback()).toHaveLength(0)
	})

	it('emits one implicit confusion Feedback once the target flips ≥ 2 times', async () => {
		await recordEvent('accept', { targetId: 'title' })
		await recordEvent('reject', { targetId: 'title' })
		await flagReversalIfThrashing(target) // 1 flip so far — quiet
		await recordEvent('accept', { targetId: 'title' })
		await flagReversalIfThrashing(target) // 2nd flip — crosses

		const feed = await allFeedback()
		expect(feed).toHaveLength(1)
		expect(feed[0]).toMatchObject({
			source: 'telemetry',
			kind: 'confusion',
			target,
		})
	})

	it('does not duplicate the row on a later re-check of the same target', async () => {
		await recordEvent('accept', { targetId: 'title' })
		await recordEvent('reject', { targetId: 'title' })
		await recordEvent('accept', { targetId: 'title' })
		await flagReversalIfThrashing(target)
		await recordEvent('reject', { targetId: 'title' })
		await flagReversalIfThrashing(target) // still thrashing, already flagged

		expect(await allFeedback()).toHaveLength(1)
	})
})

describe('submitConfusionSignal (client focus-thrash)', () => {
	it('drops a post below the server-side cycle floor, even if the client claims otherwise', async () => {
		await submitConfusionSignal(confusionSignalForm({ cycles: '2' }))
		expect(await allFeedback()).toHaveLength(0)
	})

	it('appends one implicit confusion Feedback once the cycle count crosses the floor', async () => {
		await submitConfusionSignal(confusionSignalForm({ cycles: '3' }))
		const feed = await allFeedback()
		expect(feed).toHaveLength(1)
		expect(feed[0]).toMatchObject({
			source: 'telemetry',
			kind: 'confusion',
			target: { kind: 'field', id: 'title' },
		})
	})

	it('does not duplicate on a repeat post for the same target', async () => {
		await submitConfusionSignal(confusionSignalForm())
		await submitConfusionSignal(confusionSignalForm({ cycles: '5' }))
		expect(await allFeedback()).toHaveLength(1)
	})

	it('ignores a malformed post (missing id, bad kind)', async () => {
		await submitConfusionSignal(confusionSignalForm({ id: '' }))
		await submitConfusionSignal(confusionSignalForm({ kind: 'bogus' }))
		expect(await allFeedback()).toHaveLength(0)
	})
})
