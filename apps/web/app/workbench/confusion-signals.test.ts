import { describe, expect, it } from 'vitest'
import {
	decisionsForTarget,
	detectRapidReversal,
	isFocusThrash,
} from './confusion-signals'
import type { WorkbenchEvent } from './telemetry'

function ev(
	kind: WorkbenchEvent['kind'],
	at: string,
	targetId = 'title',
): WorkbenchEvent {
	return { kind, at, targetId }
}

describe('decisionsForTarget', () => {
	it('keeps only accept/reject events for the given target, in order', () => {
		const events: WorkbenchEvent[] = [
			ev('focus', '2026-07-11T00:00:00.000Z'),
			ev('accept', '2026-07-11T00:00:01.000Z'),
			ev('reject', '2026-07-11T00:00:02.000Z', 'other'),
			ev('reject', '2026-07-11T00:00:03.000Z'),
		]
		expect(decisionsForTarget(events, 'title').map((e) => e.kind)).toEqual([
			'accept',
			'reject',
		])
	})
})

describe('detectRapidReversal (rapid re-reject)', () => {
	it('stays quiet for a single decision', () => {
		expect(
			detectRapidReversal([ev('accept', '2026-07-11T00:00:00.000Z')]),
		).toBeNull()
	})

	it('stays quiet for one correction (below the 2-flip threshold)', () => {
		const decisions = [
			ev('accept', '2026-07-11T00:00:00.000Z'),
			ev('reject', '2026-07-11T00:00:05.000Z'),
		]
		expect(detectRapidReversal(decisions)).toBeNull()
	})

	it('fires once the same target flips ≥ 2 times within the window', () => {
		const decisions = [
			ev('accept', '2026-07-11T00:00:00.000Z'),
			ev('reject', '2026-07-11T00:00:05.000Z'),
			ev('accept', '2026-07-11T00:00:10.000Z'),
		]
		const result = detectRapidReversal(decisions)
		expect(result).not.toBeNull()
		expect(result?.flips).toBe(2)
		expect(result?.lastAt).toBe('2026-07-11T00:00:10.000Z')
	})

	it('does not count flips further apart than the window', () => {
		const decisions = [
			ev('accept', '2026-07-11T00:00:00.000Z'),
			ev('reject', '2026-07-11T01:00:00.000Z'), // 1h later, outside default 60s window
			ev('accept', '2026-07-11T01:00:05.000Z'),
		]
		expect(detectRapidReversal(decisions)).toBeNull()
	})

	it('does not count a repeat of the same decision as a flip', () => {
		const decisions = [
			ev('reject', '2026-07-11T00:00:00.000Z'),
			ev('reject', '2026-07-11T00:00:01.000Z'),
			ev('reject', '2026-07-11T00:00:02.000Z'),
		]
		expect(detectRapidReversal(decisions)).toBeNull()
	})

	it('respects a custom threshold/window', () => {
		const decisions = [
			ev('accept', '2026-07-11T00:00:00.000Z'),
			ev('reject', '2026-07-11T00:00:01.000Z'),
		]
		expect(
			detectRapidReversal(decisions, { threshold: 1, windowMs: 5_000 }),
		).toEqual({ flips: 1, lastAt: '2026-07-11T00:00:01.000Z' })
	})
})

describe('isFocusThrash (client-side focus/blur churn)', () => {
	const now = 100_000

	it('stays quiet below the cycle threshold', () => {
		expect(isFocusThrash([now - 1000, now - 2000], now)).toBe(false)
	})

	it('fires once the cluster reaches the threshold inside the window', () => {
		expect(isFocusThrash([now - 25_000, now - 15_000, now - 1_000], now)).toBe(
			true,
		)
	})

	it('ignores cycles that fell outside the window', () => {
		expect(isFocusThrash([now - 60_000, now - 50_000, now - 1_000], now)).toBe(
			false,
		)
	})

	it('respects a custom window/threshold', () => {
		expect(
			isFocusThrash([now - 4_000, now - 2_000], now, {
				windowMs: 5_000,
				threshold: 2,
			}),
		).toBe(true)
	})

	it('ignores future timestamps', () => {
		expect(isFocusThrash([now + 1_000, now + 2_000, now + 3_000], now)).toBe(
			false,
		)
	})
})
