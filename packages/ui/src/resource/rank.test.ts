/**
 * @vitest-environment node
 *
 * No DOM in this file. The package default is `jsdom`, which costs
 * ~400ms of environment construction per file — the dominant term in this suite's
 * CPU, and the contention that starved a synchronous render past its timeout on a
 * 2-core runner. A test that never renders should not pay for a document.
 */
import { describe, expect, it } from 'vitest'
import { compareRanked, isRankKey, rankBetween, rankForDrop } from './rank.ts'

/** The database default's shape (`RANK_DEFAULT_SQL`) — 17 padded digits + '1'. */
const dbKey = (micros: number) => `${String(micros).padStart(17, '0')}1`

describe('isRankKey', () => {
	it('accepts digit strings that do not end in zero', () => {
		expect(isRankKey('5')).toBe(true)
		expect(isRankKey('000000001753000000001')).toBe(true)
	})

	it('rejects the shapes that would make midpoints ambiguous', () => {
		// A trailing zero is a second spelling of a shorter key.
		expect(isRankKey('30')).toBe(false)
		expect(isRankKey('')).toBe(false)
		expect(isRankKey('a5')).toBe(false)
		expect(isRankKey(null)).toBe(false)
		expect(isRankKey(5)).toBe(false)
	})

	it('accepts every key the database default can produce', () => {
		// Including the times whose microsecond count ends in zeros — the reason
		// the default appends a '1'.
		for (const micros of [1, 1_753_000_000_000_000, 1_753_000_000_000_100])
			expect(isRankKey(dbKey(micros))).toBe(true)
	})
})

describe('rankBetween', () => {
	it('places a first key when there is nothing either side', () => {
		expect(rankBetween(null, null)).toBe('5')
	})

	it('produces a key strictly between its bounds', () => {
		const key = rankBetween('3', '4')
		expect(key > '3').toBe(true)
		expect(key < '4').toBe(true)
	})

	it('fits between the database default keys, which share a long prefix', () => {
		const a = dbKey(1_753_000_000_000_000)
		const b = dbKey(1_753_000_000_000_001)
		const key = rankBetween(a, b)
		expect(key > a).toBe(true)
		expect(key < b).toBe(true)
		expect(isRankKey(key)).toBe(true)
	})

	it('places a key before every database-stamped row', () => {
		const first = dbKey(1_753_000_000_000_000)
		const key = rankBetween(null, first)
		expect(key < first).toBe(true)
		expect(isRankKey(key)).toBe(true)
	})

	it('places a key after every database-stamped row', () => {
		const last = dbKey(1_753_000_000_000_000)
		const key = rankBetween(last, null)
		expect(key > last).toBe(true)
	})

	it('never runs out of room in the same gap', () => {
		// The property the whole design rests on: reordering repeatedly into one
		// gap must keep working, because the alternative is a renumbering pass —
		// and a renumbering pass is the thing concurrent moves corrupt.
		let low = '1'
		let high = '2'
		for (let i = 0; i < 200; i++) {
			const key = rankBetween(low, high)
			expect(key > low).toBe(true)
			expect(key < high).toBe(true)
			expect(isRankKey(key)).toBe(true)
			// Alternate which side we squeeze from, so both branches are exercised.
			if (i % 2 === 0) low = key
			else high = key
		}
	})

	it('always emits a key that can itself be split again', () => {
		let previous: string | null = null
		for (let i = 0; i < 50; i++) {
			const key = rankBetween(previous, null)
			expect(isRankKey(key)).toBe(true)
			previous = key
		}
	})

	it('refuses bounds that are out of order or malformed', () => {
		expect(() => rankBetween('4', '3')).toThrow(/out of order/)
		expect(() => rankBetween('3', '3')).toThrow(/out of order/)
		expect(() => rankBetween('30', null)).toThrow(/not a rank key/)
		expect(() => rankBetween(null, 'x')).toThrow(/not a rank key/)
	})
})

describe('compareRanked', () => {
	const sorted = (rows: { rank: string | null; id: string }[]) =>
		[...rows].sort(compareRanked).map((r) => r.id)

	it('orders by key', () => {
		expect(
			sorted([
				{ rank: '5', id: 'b' },
				{ rank: '3', id: 'a' },
			]),
		).toEqual(['a', 'b'])
	})

	it('breaks a tie by id, so a concurrent drop is ambiguous rather than unstable', () => {
		// Two people dropping into the same gap compute the same key. The order
		// they end up in must not depend on the order the store returned them.
		const rows = [
			{ rank: '35', id: 'z' },
			{ rank: '35', id: 'a' },
		]
		expect(sorted(rows)).toEqual(['a', 'z'])
		expect(sorted([...rows].reverse())).toEqual(['a', 'z'])
	})

	it('sorts a key-less row last rather than throwing', () => {
		expect(
			sorted([
				{ rank: null, id: 'a' },
				{ rank: '9', id: 'b' },
			]),
		).toEqual(['b', 'a'])
	})
})

describe('rankForDrop', () => {
	const siblings = [
		{ rank: '1', id: 'a' },
		{ rank: '3', id: 'b' },
		{ rank: '5', id: 'c' },
	]

	it('places a drop at the top above every card', () => {
		expect(rankForDrop(siblings, 0) < '1').toBe(true)
	})

	it('places a drop at the bottom below every card', () => {
		expect(rankForDrop(siblings, siblings.length) > '5').toBe(true)
	})

	it('places a drop in the middle between its neighbours', () => {
		const key = rankForDrop(siblings, 2)
		expect(key > '3').toBe(true)
		expect(key < '5').toBe(true)
	})

	it('clamps an index past either end', () => {
		expect(rankForDrop(siblings, -3) < '1').toBe(true)
		expect(rankForDrop(siblings, 99) > '5').toBe(true)
	})

	it('places the first card in an empty column', () => {
		expect(isRankKey(rankForDrop([], 0))).toBe(true)
	})

	it('drops past a tied run instead of failing on a gap with no room', () => {
		// Two cards already share a key. There is no key between a key and itself,
		// so a naive "between my neighbours" would throw on a perfectly ordinary
		// drop; this lands after the run and lets the id tie-break settle it.
		const tied = [
			{ rank: '3', id: 'a' },
			{ rank: '3', id: 'b' },
			{ rank: '7', id: 'c' },
		]
		const key = rankForDrop(tied, 1)
		expect(key > '3').toBe(true)
		expect(key < '7').toBe(true)
	})

	it('passes over neighbours that carry no key', () => {
		const mixed = [
			{ rank: '2', id: 'a' },
			{ rank: null, id: 'b' },
			{ rank: '8', id: 'c' },
		]
		const key = rankForDrop(mixed, 2)
		expect(key > '2').toBe(true)
		expect(key < '8').toBe(true)
	})

	it('keeps the column ordered after a round trip through the sort', () => {
		// A drop's key must reproduce the position it was dropped into once the
		// rows come back from the store and are re-sorted.
		const rows = [...siblings]
		const moved = { rank: rankForDrop(rows, 1), id: 'new' }
		expect([...rows, moved].sort(compareRanked).map((r) => r.id)).toEqual([
			'a',
			'new',
			'b',
			'c',
		])
	})
})
