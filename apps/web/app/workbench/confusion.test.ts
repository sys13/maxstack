import type { ReviewTarget } from '@maxstack/spec'
import { describe, expect, it } from 'vitest'
import { synthesizeConfusion } from './confusion'
import type { WorkbenchEvent } from './telemetry'

const target: ReviewTarget = { kind: 'field', id: 'title', parentId: 'task' }
const resolveTarget = (id: string): ReviewTarget | undefined =>
	id === 'title' ? target : undefined

function ev(
	kind: WorkbenchEvent['kind'],
	targetId?: string,
	at = '2026-07-11T00:00:00.000Z',
): WorkbenchEvent {
	return { kind, at, targetId }
}

const opts = { resolveTarget, specVersion: 'gen-1' }

describe('synthesizeConfusion', () => {
	it('emits confusion when friction ≥ threshold with no resolution', () => {
		const feedback = synthesizeConfusion(
			[ev('focus', 'title'), ev('reject', 'title'), ev('focus', 'title')],
			opts,
		)
		expect(feedback).toHaveLength(1)
		expect(feedback[0]?.kind).toBe('confusion')
		expect(feedback[0]?.source).toBe('telemetry')
		expect(feedback[0]?.target).toEqual(target)
		expect(feedback[0]?.severity).toBe('med')
	})

	it('a resolution cancels the confusion signal (they found their footing)', () => {
		const feedback = synthesizeConfusion(
			[
				ev('focus', 'title'),
				ev('reject', 'title'),
				ev('focus', 'title'),
				ev('accept', 'title'),
			],
			opts,
		)
		expect(feedback).toHaveLength(0)
	})

	it('stays quiet below the threshold', () => {
		const feedback = synthesizeConfusion(
			[ev('focus', 'title'), ev('reject', 'title')],
			opts,
		)
		expect(feedback).toHaveLength(0)
	})

	it('scales severity with churn (≥ 2× threshold → high)', () => {
		const churn = Array.from({ length: 6 }, () => ev('focus', 'title'))
		const feedback = synthesizeConfusion(churn, opts)
		expect(feedback[0]?.severity).toBe('high')
	})

	it('stamps `at` from the last friction event and ignores view/no-target events', () => {
		const feedback = synthesizeConfusion(
			[
				ev('view'), // no target — ignored
				ev('focus', 'title', '2026-07-11T01:00:00.000Z'),
				ev('focus', 'title', '2026-07-11T02:00:00.000Z'),
				ev('reject', 'title', '2026-07-11T03:00:00.000Z'),
			],
			opts,
		)
		expect(feedback[0]?.at).toBe('2026-07-11T03:00:00.000Z')
	})

	it('skips a node whose coordinate cannot be resolved (never fabricates one)', () => {
		const feedback = synthesizeConfusion(
			[ev('focus', 'ghost'), ev('reject', 'ghost'), ev('focus', 'ghost')],
			opts,
		)
		expect(feedback).toHaveLength(0)
	})
})
