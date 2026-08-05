import { describe, expect, it } from 'vitest'
import {
	parseEvents,
	recentEvents,
	serializeEvents,
	summarizeEvents,
	type WorkbenchEvent,
} from './events.ts'

const events: WorkbenchEvent[] = [
	{ kind: 'view', at: '2026-07-09T00:00:00.000Z' },
	{ kind: 'focus', at: '2026-07-09T00:00:01.000Z', targetId: 'e-project' },
	{ kind: 'accept', at: '2026-07-09T00:00:02.000Z', targetId: 'tr-team' },
	{ kind: 'accept', at: '2026-07-09T00:00:03.000Z', targetId: 'fld-name' },
	{
		kind: 'resolve',
		at: '2026-07-09T00:00:04.000Z',
		targetId: 'd-x',
		detail: 'projects',
	},
]

describe('serialize/parse (JSONL, append-only)', () => {
	it('round-trips a log through JSONL', () => {
		expect(parseEvents(serializeEvents(events))).toEqual(events)
	})

	it('serializes one event per line with a trailing newline (appends concatenate)', () => {
		const text = serializeEvents(events)
		expect(text.endsWith('\n')).toBe(true)
		expect(text.trimEnd().split('\n')).toHaveLength(5)
	})

	it('skips blank lines on parse', () => {
		expect(parseEvents('\n\n')).toEqual([])
	})
})

describe('summarizeEvents', () => {
	it('counts by kind with every kind present', () => {
		expect(summarizeEvents(events)).toEqual({
			total: 5,
			byKind: { view: 1, focus: 1, accept: 2, reject: 0, resolve: 1 },
		})
	})

	it('is zeroed for an empty log', () => {
		expect(summarizeEvents([])).toEqual({
			total: 0,
			byKind: { view: 0, focus: 0, accept: 0, reject: 0, resolve: 0 },
		})
	})
})

describe('recentEvents', () => {
	it('returns the newest events first', () => {
		expect(recentEvents(events, 2).map((e) => e.kind)).toEqual([
			'resolve',
			'accept',
		])
	})
})
