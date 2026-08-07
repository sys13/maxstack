/**
 * Editing one cell of a list, in place.
 *
 * The sibling of `board-move.test.ts`, and it proves the same four things, which
 * are the issue's gating criteria as they land on the write side:
 *
 * 1. **The edit persists through the form's write path** — the values a cell
 *    produces go through the same `updateHandler`/`opUpdate` a form save uses,
 *    against the real spec-derived backend. There is no inline-edit endpoint to
 *    test separately, which is the point.
 * 2. **A read-only field is not editable** — declared or not. The block's
 *    declaration and the column's own metadata are two gates, and the stricter
 *    one wins, so a stale declaration can only ever produce *fewer* editable
 *    cells.
 * 3. **An unauthorized viewer cannot write through it** — enforced in the
 *    permission layer, so the refusal holds for a caller who never rendered the
 *    list. The affordance being hidden is a separate, weaker fact.
 * 4. **A nullable field round-trips** — clearing a cell writes `null`, the store
 *    reads `null` back, and the value that came out goes back in. This is the
 *    shape a form body cannot express, and update-mode validation dropping
 * `.nullable()` is the defect it exists to catch.
 */

import {
	createSpecDb,
	getHandler,
	ResourceRegistry,
	registerSpecEntities,
	type SpecEntityShape,
	type SproutColumn,
	updateHandler,
} from '@maxstack/core'
import { describe, expect, it } from 'vitest'
import {
	inlineEditableFields,
	inlineEditValues,
	isInlineEditableColumn,
} from './inline-edit'

/** A column as introspection hands it over; only the keys the rule reads. */
const column = (
	name: string,
	extra: Partial<SproutColumn> = {},
): SproutColumn => ({
	name,
	type: 'string',
	nullable: true,
	hasDefault: false,
	isPrimaryKey: false,
	meta: {},
	...extra,
})

const columns: SproutColumn[] = [
	column('id', { type: 'uuid', isPrimaryKey: true }),
	column('title'),
	column('subtitle'),
	column('notes'),
	column('points', { type: 'number' }),
	column('done', { type: 'boolean' }),
	column('status', {
		type: 'enum',
		enumValues: ['todo', 'done'],
		meta: { options: [{ label: 'To do', value: 'todo' }] },
	}),
	column('dueOn', { type: 'date' }),
	// The four a cell cannot represent.
	column('authorId', { meta: { reference: { table: 'user', column: 'id' } } }),
	column('cover', { meta: { isFile: true } }),
	column('payload', { type: 'json' }),
	column('boardRank', {
		meta: { rankKey: true, readOnly: true, hidden: true },
	}),
	column('createdBy', { meta: { readOnly: true } }),
]

const row = {
	id: 'r1',
	title: 'First',
	subtitle: 'a subtitle',
	notes: 'a note',
	points: 3,
	done: false,
	status: 'todo',
}

describe('isInlineEditableColumn', () => {
	it('accepts the simple types a cell editor exists for', () => {
		for (const name of ['title', 'points', 'done', 'status', 'dueOn'])
			expect(
				isInlineEditableColumn(columns.find((c) => c.name === name) as never),
			).toBe(true)
	})

	it('refuses everything a cell editor would corrupt', () => {
		// The primary key, a reference, a file key, a json blob, a rank key and
		// anything declared read-only. Each is refused because no cell editor can
		// represent it — not because the list is being conservative.
		for (const name of [
			'id',
			'authorId',
			'cover',
			'payload',
			'boardRank',
			'createdBy',
		])
			expect(
				isInlineEditableColumn(columns.find((c) => c.name === name) as never),
			).toBe(false)
	})

	it('refuses prose, however the column says it is prose', () => {
		// A single-line `<input>` cannot hold a line break — the HTML value
		// sanitization algorithm strips them — so a cell editor over a description
		// field is a way to flatten it by accident. Whether a column is prose is
		// the *form's* question, so the answer is taken from the same detector the
		// form uses: by declaration (`multiline`, `format`, `markdown`) and by the
		// name heuristic that makes a field called `notes` a textarea.
		expect(isInlineEditableColumn(column('notes'))).toBe(false)
		expect(isInlineEditableColumn(column('description'))).toBe(false)
		expect(
			isInlineEditableColumn(column('blurb', { meta: { multiline: true } })),
		).toBe(false)
		expect(
			isInlineEditableColumn(column('blurb', { meta: { markdown: true } })),
		).toBe(false)
		expect(
			isInlineEditableColumn(column('blurb', { meta: { format: 'richtext' } })),
		).toBe(false)
		// And the escape hatch holds in this direction too: a field named `notes`
		// that says it is one line *is* one line, and edits in a cell.
		expect(
			isInlineEditableColumn(column('notes', { meta: { multiline: false } })),
		).toBe(true)
	})

	it('refuses a password', () => {
		// The read cell masks it. An editor would print the secret into the table.
		expect(
			isInlineEditableColumn(
				column('secret', { meta: { format: 'password' } }),
			),
		).toBe(false)
	})
})

describe('inlineEditableFields', () => {
	it('narrows the declaration to what the columns can actually edit', () => {
		expect(
			inlineEditableFields(columns, ['title', 'points', 'status']),
		).toEqual(['title', 'points', 'status'])
	})

	it('drops a declared field that is read-only, a reference, or gone', () => {
		// The stale-declaration case: `page.setBlockEditable` validated these once,
		// and the entity has changed underneath it. The declaration loses.
		expect(
			inlineEditableFields(columns, [
				'title',
				'createdBy',
				'authorId',
				'payload',
				'notes',
				'vanished',
			]),
		).toEqual(['title'])
	})

	it('is empty for a list that declared nothing', () => {
		expect(inlineEditableFields(columns, [])).toEqual([])
	})
})

describe('inlineEditValues', () => {
	const values = (
		name: string,
		value: unknown,
		declared = ['title', 'subtitle'],
	) => inlineEditValues(columns, declared, row, name, value)

	it('writes exactly the one declared field it was given', () => {
		expect(values('title', 'Second')).toEqual({ title: 'Second' })
	})

	it('refuses a field the block never declared', () => {
		// The gate that makes the cell path unable to widen itself: a crafted call
		// naming a column the list does not offer produces no values at all.
		expect(values('points', 99)).toBeNull()
		expect(values('status', 'done')).toBeNull()
	})

	it('refuses a declared field the column will not allow', () => {
		// Declared *and* refused — the second gate, reached only when someone put a
		// name in the spec that the entity has since made uneditable.
		expect(values('createdBy', 'me', ['createdBy'])).toBeNull()
		expect(values('authorId', 'u-2', ['authorId'])).toBeNull()
	})

	it('writes nothing when the value did not change', () => {
		// Every no-op write is an audit entry recording that nothing happened.
		expect(values('title', 'First')).toBeNull()
		expect(values('subtitle', 'a subtitle')).toBeNull()
	})

	it('treats null, empty string, zero and false as values, not as absences', () => {
		// The truthiness trap: each of these is a legitimate save, and only
		// `undefined` means "the editor produced nothing".
		expect(values('subtitle', null)).toEqual({ subtitle: null })
		expect(values('subtitle', '')).toEqual({ subtitle: '' })
		expect(values('points', 0, ['points'])).toEqual({ points: 0 })
		expect(values('done', false, ['done'])).toBeNull() // unchanged
		expect(values('done', true, ['done'])).toEqual({ done: true })
		expect(values('title', undefined)).toBeNull()
	})
})

/**
 * A project-shaped resource, materialized through the same
 * `registerSpecEntities` + `createSpecDb` the running app grounds a project
 * with — so the rule a cell edit meets here is the rule a REST client meets
 * there, not a stub that agrees with it today.
 */
const shape: SpecEntityShape = {
	name: 'note',
	fields: [
		{ name: 'title', type: 'string', required: true },
		// Optional, so the DB column is nullable — the round-trip this file exists
		// to pin.
		{ name: 'subtitle', type: 'string', required: false },
		{ name: 'pages', type: 'number', required: false },
	],
}

async function project(user: { id: string; role?: string } | null = null) {
	const registry = new ResourceRegistry()
	registerSpecEntities(registry, [shape])
	const { store } = await createSpecDb(registry, [shape])
	return { registry, store, user }
}

describe('the cell edit runs the form’s write path', () => {
	it('persists an inline edit through updateHandler', async () => {
		const ctx = await project()
		const one = await ctx.store.create('note', {
			title: 'One',
			subtitle: 'first',
		})
		const cols = ctx.registry.get('note')?.resource.columns as SproutColumn[]

		const values = inlineEditValues(cols, ['title'], one, 'title', 'One edited')
		expect(values).toEqual({ title: 'One edited' })

		const res = await updateHandler(
			ctx,
			'note',
			String(one.id),
			values as Record<string, unknown>,
		)
		expect(res.status).toBe(200)
		// It persisted, and it touched one column: the read-back is the proof, not
		// the handler's echo.
		const after = await getHandler(ctx, 'note', String(one.id))
		const stored = after.body as Record<string, unknown>
		expect(stored.title).toBe('One edited')
		expect(stored.subtitle).toBe('first')
	})

	it('round-trips a nullable field: cleared to null, read back as null, and back in', async () => {
		// The #257 shape. A cell emptied by the editor saves `null`; the API emits
		// `null` on the way out; and — the half that used to break — the value it
		// emitted is accepted on the way back in, because update-mode validation
		// keeps `.nullable()` rather than dropping it.
		const ctx = await project()
		const one = await ctx.store.create('note', {
			title: 'Two',
			subtitle: 'to be cleared',
			pages: 12,
		})
		const cols = ctx.registry.get('note')?.resource.columns as SproutColumn[]

		const cleared = inlineEditValues(cols, ['subtitle'], one, 'subtitle', null)
		expect(cleared).toEqual({ subtitle: null })
		const wrote = await updateHandler(
			ctx,
			'note',
			String(one.id),
			cleared as Record<string, unknown>,
		)
		expect(wrote.status).toBe(200)

		const read = await getHandler(ctx, 'note', String(one.id))
		const emitted = read.body as Record<string, unknown>
		expect(emitted.subtitle).toBeNull()

		// Now send the emitted row straight back — the exact bytes the API just
		// produced, nulls and all. An API that refuses its own output is the defect.
		const back = await updateHandler(ctx, 'note', String(one.id), {
			subtitle: emitted.subtitle,
			pages: emitted.pages,
			title: emitted.title,
		})
		expect(back.status).toBe(200)
		expect((back.body as Record<string, unknown>).subtitle).toBeNull()

		// And a null number clears too — the type that most often has `.nullable()`
		// stripped, because a number field reads as "required-ish" to a generator.
		const clearedNumber = inlineEditValues(cols, ['pages'], one, 'pages', null)
		expect(clearedNumber).toEqual({ pages: null })
		const numeric = await updateHandler(
			ctx,
			'note',
			String(one.id),
			clearedNumber as Record<string, unknown>,
		)
		expect(numeric.status).toBe(200)
		expect(
			(
				(await getHandler(ctx, 'note', String(one.id))).body as Record<
					string,
					unknown
				>
			).pages,
		).toBeNull()
	})

	it('refuses an unauthorized writer, in the permission layer', async () => {
		// The route is not the gate — `opUpdate` is. So the refusal is set up the
		// way the running app sets it up (a declared `update` rule on the resource)
		// and then met by a caller who never rendered a list at all.
		const ctx = await project({ id: 'u-1', role: 'member' })
		const entry = ctx.registry.get('note')
		if (entry) entry.config.access = { update: 'admin' }

		const one = await ctx.store.create('note', { title: 'Three' })
		const cols = entry?.resource.columns as SproutColumn[]
		const values = inlineEditValues(cols, ['title'], one, 'title', 'Hijacked')
		expect(values).toEqual({ title: 'Hijacked' })

		const res = await updateHandler(
			ctx,
			'note',
			String(one.id),
			values as Record<string, unknown>,
		)
		expect(res.status).toBe(403)
		// And nothing was written.
		const after = await getHandler(ctx, 'note', String(one.id))
		expect((after.body as Record<string, unknown>).title).toBe('Three')

		// The same edit from an admin lands — the rule is the rule, not a blanket
		// refusal that would make the first assertion vacuous.
		const asAdmin = { ...ctx, user: { id: 'u-admin', role: 'admin' } }
		const allowed = await updateHandler(asAdmin, 'note', String(one.id), {
			title: 'Hijacked',
		})
		expect(allowed.status).toBe(200)
	})
})
