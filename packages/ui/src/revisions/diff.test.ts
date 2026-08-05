/**
 * @vitest-environment node
 *
 * No DOM in this file. The package default is `jsdom`, which costs
 * ~400ms of environment construction per file — the dominant term in this suite's
 * CPU, and the contention that starved a synchronous render past its timeout on a
 * 2-core runner. A test that never renders should not pay for a document.
 */
import { describe, expect, it } from 'vitest'
import { buildRevisions, diffRecords, type Snapshot } from './diff.ts'

describe('diffRecords', () => {
	it('reports changed, added, and removed fields, sorted', () => {
		const diff = diffRecords(
			{ title: 'A', points: 1, gone: true },
			{ title: 'B', points: 1, added: 'x' },
		)
		expect(diff).toEqual([
			{ field: 'added', kind: 'added', before: undefined, after: 'x' },
			{ field: 'gone', kind: 'removed', before: true, after: undefined },
			{ field: 'title', kind: 'changed', before: 'A', after: 'B' },
		])
	})

	it('treats deep-equal objects/arrays as unchanged', () => {
		const diff = diffRecords(
			{ tags: ['a', 'b'], meta: { x: 1, y: 2 } },
			{ tags: ['a', 'b'], meta: { y: 2, x: 1 } },
		)
		expect(diff).toEqual([])
	})

	it('ignores named fields', () => {
		const diff = diffRecords(
			{ id: '1', title: 'A' },
			{ id: '2', title: 'A' },
			{ ignore: ['id'] },
		)
		expect(diff).toEqual([])
	})
})

describe('buildRevisions', () => {
	const snaps: Snapshot[] = [
		{ id: 'r1', createdAt: '2026-01-01', snapshot: { id: '1', title: 'A' } },
		{ id: 'r2', createdAt: '2026-01-02', snapshot: { id: '1', title: 'B' } },
		{ id: 'r3', createdAt: '2026-01-03', snapshot: { id: '1', title: 'C' } },
	]

	it('diffs each revision against the prior (asc)', () => {
		const revs = buildRevisions(snaps, { ignore: ['id'], order: 'asc' })
		expect(revs.map((r) => r.id)).toEqual(['r1', 'r2', 'r3'])
		expect(revs[0]?.isFirst).toBe(true)
		expect(revs[0]?.diff).toEqual([])
		expect(revs[1]?.diff).toEqual([
			{ field: 'title', kind: 'changed', before: 'A', after: 'B' },
		])
	})

	it('keeps desc order in output while diffing the right predecessor', () => {
		const desc = [...snaps].reverse()
		const revs = buildRevisions(desc, { ignore: ['id'], order: 'desc' })
		expect(revs.map((r) => r.id)).toEqual(['r3', 'r2', 'r1'])
		// r3's diff is vs r2 (B → C); r1 is the first, no diff.
		expect(revs[0]?.diff).toEqual([
			{ field: 'title', kind: 'changed', before: 'B', after: 'C' },
		])
		expect(revs[2]?.isFirst).toBe(true)
	})
})
