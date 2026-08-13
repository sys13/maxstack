/**
 * What a new row added from a list actually submits (#444).
 *
 * The completeness rule — every required field must be collected — lives in the
 * spec layer, at the op, and is tested there: it is a property of a declaration
 * and there is no click that makes a bad one work. What this file pins is the
 * other half, the part that runs per submission:
 *
 *  - a draft can only ever name fields the block declared and the column still
 *    supports, so the new row can never become a way to write a column the
 *    viewer's own form would not have let them write;
 *  - an untouched box is an **absence**, not a `null`. This is the one behaviour
 *    that differs from a cell edit, and getting it backwards would quietly
 *    defeat every defaulted column in the schema — a row created from the list
 *    would differ from the same row created from the form, in fields nobody
 *    typed into.
 */

import type { SproutColumn } from '@maxstack/core'
import { describe, expect, it } from 'vitest'
import { inlineCreatableFields, inlineCreateValues } from './inline-create'

const column = (
	over: Partial<SproutColumn> & { name: string },
): SproutColumn => ({
	type: 'string',
	nullable: true,
	hasDefault: false,
	isPrimaryKey: false,
	meta: {},
	...over,
})

const columns: SproutColumn[] = [
	column({ name: 'id', type: 'uuid', isPrimaryKey: true, nullable: false }),
	column({ name: 'title', nullable: false }),
	column({ name: 'points', type: 'number' }),
	column({ name: 'done', type: 'boolean', hasDefault: true }),
	column({ name: 'notes', meta: { multiline: true } }),
	column({
		name: 'authorId',
		meta: { reference: { table: 'author', column: 'id' } },
	}),
	column({ name: 'boardRank', meta: { rankKey: true } }),
]

const declared = ['title', 'points', 'done']

describe('inlineCreatableFields', () => {
	it('keeps the declared fields a row form can collect', () => {
		expect(inlineCreatableFields(columns, declared)).toEqual([
			'title',
			'points',
			'done',
		])
	})

	it('drops a declared field the column no longer supports', () => {
		// The stale-declaration case, and the same stricter-of-two rule the
		// editable cells follow: the spec block is the reviewable line, the column
		// is the current fact, and drift can only ever take the safe direction.
		expect(
			inlineCreatableFields(columns, [
				'title',
				'authorId',
				'boardRank',
				'notes',
				'gone',
			]),
		).toEqual(['title'])
	})
})

describe('inlineCreateValues', () => {
	it('submits only the boxes that were filled', () => {
		expect(
			inlineCreateValues(columns, declared, { title: 'Ship it', points: 3 }),
		).toEqual({ title: 'Ship it', points: 3 })
	})

	it('omits an untouched box rather than sending null for it', () => {
		// `done` is a defaulted column. Sending `null` would override the default
		// with an explicit emptiness nobody asked for; omitting the key lets the
		// database do what it does for a row created from the New form.
		const values = inlineCreateValues(columns, declared, { title: 'Ship it' })
		expect(values).toEqual({ title: 'Ship it' })
		expect(values).not.toHaveProperty('done')
	})

	it('treats an emptied text box as an absence too', () => {
		// It is what an untouched box holds and what a box typed into and cleared
		// holds, and about a row that does not exist yet those are the same
		// statement.
		expect(
			inlineCreateValues(columns, declared, { title: 'Ship it', points: '' }),
		).toEqual({ title: 'Ship it' })
	})

	it('keeps a falsy value that is a value', () => {
		// `0` and `false` are things a person can mean; only `undefined`, `null`
		// and `''` are things they can fail to say. A truthiness check here would
		// make an unchecked box and a zero unsubmittable.
		expect(
			inlineCreateValues(columns, declared, {
				title: 'Zero',
				points: 0,
				done: false,
			}),
		).toEqual({ title: 'Zero', points: 0, done: false })
	})

	it('drops a draft key the block never declared', () => {
		// A new-row form cannot name a field. Even handed one, this refuses to
		// carry it — the list writes what it offers and nothing else.
		expect(
			inlineCreateValues(columns, declared, {
				title: 'Ship it',
				authorId: 'a1',
				boardRank: 'zzz',
			}),
		).toEqual({ title: 'Ship it' })
	})

	it('returns null when nothing was typed, rather than an empty create', () => {
		// An empty object would post a create that writes an empty record and an
		// audit entry to go with it.
		expect(inlineCreateValues(columns, declared, {})).toBeNull()
		expect(inlineCreateValues(columns, declared, { title: '' })).toBeNull()
	})

	it('returns null when the block declares nothing collectable', () => {
		expect(inlineCreateValues(columns, [], { title: 'Ship it' })).toBeNull()
		expect(
			inlineCreateValues(columns, ['authorId'], { authorId: 'a1' }),
		).toBeNull()
	})
})
