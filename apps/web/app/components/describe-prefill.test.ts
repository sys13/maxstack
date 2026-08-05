/**
 * Merge-vs-replace, the one piece of the describe panel with a decision in it
 *.
 *
 * The failure this guards is quiet and destructive: describing a status change
 * on an edit form and silently blanking every field the sentence didn't happen
 * to mention. The extraction is a *patch*, and which of the record's current
 * values survive it is the whole question.
 */

import { describe, expect, it } from 'vitest'
import { mergeFields } from './describe-prefill'

const row = { id: 'r-1', title: 'Ship it', status: 'todo', notes: 'be careful' }

describe('mergeFields', () => {
	it('merge keeps what the text never mentioned', () => {
		expect(mergeFields(row, { status: 'doing' }, 'merge')).toEqual({
			...row,
			status: 'doing',
		})
	})

	it('replace clears what the text never mentioned, except the pinned keys', () => {
		expect(mergeFields(row, { status: 'doing' }, 'replace', ['id'])).toEqual({
			id: 'r-1',
			status: 'doing',
		})
	})

	it('lets the extraction win in both modes — that is the point of running it', () => {
		for (const mode of ['merge', 'replace'] as const) {
			expect(
				mergeFields(row, { title: 'Ship it twice' }, mode, ['id']).title,
			).toBe('Ship it twice')
		}
	})

	it('keeps an extracted falsy value instead of falling back to the old one', () => {
		// `{...base, ...extracted}` is only correct because the parser omits keys
		// it could not fill rather than sending null — an extracted `false` or `0`
		// is a real answer and must not be treated as "not mentioned".
		const existing = { done: true, count: 7 }
		expect(mergeFields(existing, { done: false, count: 0 }, 'merge')).toEqual({
			done: false,
			count: 0,
		})
	})

	it('does not invent a pinned key the record never had', () => {
		expect(mergeFields({ a: 1 }, { b: 2 }, 'replace', ['id', 'a'])).toEqual({
			a: 1,
			b: 2,
		})
	})

	it('leaves the caller’s objects alone', () => {
		const existing = { ...row }
		mergeFields(existing, { status: 'done' }, 'merge')
		expect(existing).toEqual(row)
	})
})
