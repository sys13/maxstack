/**
 * Moving a card on a board.
 *
 * Three things are proven here, and they are the issue's gating criteria as they
 * land on the write side:
 *
 * 1. **The reorder is additive and conflict-tolerant** — a move writes one row's
 *    rank key, and two moves into the same gap resolve to a tie rather than to a
 *    corrupted column. No renumbering pass exists to be interrupted.
 * 2. **The WIP limit is enforced where the write happens** — the values a drag
 *    produces go through the same `updateHandler`/`opUpdate` a form save uses,
 *    against the real spec-derived backend, and a move into a full column comes
 *    back 422. The same test drives the limit straight over REST, with no board
 *    involved at all.
 * 3. **A drag can only write what the board arranges by** — a destination the
 *    spec never declared produces no values, so the board's write path cannot be
 *    used to put an arbitrary string in the grouping column.
 */

import {
	createHandler,
	createSpecDb,
	ResourceRegistry,
	registerSpecEntities,
	type SpecEntityShape,
	updateHandler,
} from '@maxstack/core'
import { compareRanked } from '@maxstack/ui'
import { describe, expect, it } from 'vitest'
import { boardMoveValues } from './board-move'
import type { PageBoardView } from './project-routes'

const board = (extra: Partial<PageBoardView> = {}): PageBoardView => ({
	kind: 'board',
	groupField: 'status',
	rankField: 'boardRank',
	move: true,
	options: [
		{ label: 'To do', value: 'todo' },
		{ label: 'Doing', value: 'doing' },
		{ label: 'Done', value: 'done' },
	],
	...extra,
})

const rows = [
	{ id: 'a', title: 'First', status: 'todo', boardRank: '1' },
	{ id: 'b', title: 'Second', status: 'todo', boardRank: '3' },
	{ id: 'c', title: 'Third', status: 'doing', boardRank: '5' },
]

const move = (
	id: string,
	drop: { value: string; index: number },
	view = board(),
	all = rows,
) => {
	const row = all.find((r) => r.id === id) as Record<string, unknown>
	return boardMoveValues(view, row, drop, all, 'id')
}

describe('boardMoveValues', () => {
	it('writes the grouping column when a card changes column', () => {
		const values = move('a', { value: 'doing', index: 0 })
		expect(values?.status).toBe('doing')
		// And a rank that puts it above the card already there.
		expect(values?.boardRank).toBeDefined()
		expect(String(values?.boardRank) < '5').toBe(true)
	})

	it('writes only the rank when a card is reordered inside its column', () => {
		const values = move('a', { value: 'todo', index: 1 })
		expect(values).not.toHaveProperty('status')
		expect(String(values?.boardRank) > '3').toBe(true)
	})

	it('writes nothing at all when the card is dropped where it already is', () => {
		// Every no-op write is an audit entry recording that nothing happened.
		expect(move('a', { value: 'todo', index: 0 })).toBeNull()
		expect(move('c', { value: 'doing', index: 0 })).toBeNull()
	})

	it('refuses a move the spec never allowed, or a column it never declared', () => {
		expect(
			move('a', { value: 'doing', index: 0 }, board({ move: false })),
		).toBeNull()
		// The board's UI only ever offers three columns; the write path only ever
		// accepts those three.
		expect(move('a', { value: 'archived', index: 0 })).toBeNull()
	})

	it('moves columns without a rank field, writing one column and no order', () => {
		const values = move(
			'a',
			{ value: 'doing', index: 0 },
			board({ rankField: undefined }),
		)
		expect(values).toEqual({ status: 'doing' })
	})

	it('produces a key that reproduces the drop position after a round trip', () => {
		// The property that matters: the order the store returns has to be the
		// order the card was dropped into.
		const values = move('c', { value: 'todo', index: 1 })
		const after = [
			{ rank: '1', id: 'a' },
			{ rank: '3', id: 'b' },
			{ rank: String(values?.boardRank), id: 'c' },
		].sort(compareRanked)
		expect(after.map((r) => r.id)).toEqual(['a', 'c', 'b'])
	})

	it('resolves two concurrent drops into the same gap as a tie, not a tear', () => {
		// Both clients see the same board and compute the same key — neither has to
		// renumber the column, so there is no half-applied state to observe. The
		// order they settle into is decided by primary key and is the same for
		// everybody looking.
		const first = move('c', { value: 'todo', index: 1 })
		const second = boardMoveValues(
			board(),
			{ id: 'd', title: 'Fourth', status: 'done', boardRank: '9' },
			{ value: 'todo', index: 1 },
			[...rows, { id: 'd', title: 'Fourth', status: 'done', boardRank: '9' }],
			'id',
		)
		expect(second?.boardRank).toBe(first?.boardRank)
		const settled = [
			{ rank: '1', id: 'a' },
			{ rank: '3', id: 'b' },
			{ rank: String(first?.boardRank), id: 'c' },
			{ rank: String(second?.boardRank), id: 'd' },
		].sort(compareRanked)
		expect(settled.map((r) => r.id)).toEqual(['a', 'c', 'd', 'b'])
	})
})

describe('the move runs the form’s write path, limit and all', () => {
	/**
	 * A project-shaped resource, materialized through the same
	 * `registerSpecEntities` + `createSpecDb` the running app grounds a project
	 * with — so the rule a drag meets here is the rule a REST client meets there,
	 * not a stub that agrees with it today.
	 */
	const shape: SpecEntityShape = {
		name: 'issue',
		fields: [
			{ name: 'title', type: 'string', required: true },
			{
				name: 'status',
				type: 'enum',
				required: false,
				options: [
					{ label: 'To do', value: 'todo' },
					{ label: 'Doing', value: 'doing' },
					{ label: 'Done', value: 'done' },
				],
				limits: { doing: 1 },
			},
			{ name: 'boardRank', type: 'string', required: false, rank: true },
		],
	}

	async function tracker() {
		const registry = new ResourceRegistry()
		registerSpecEntities(registry, [shape])
		const { store } = await createSpecDb(registry, [shape])
		return { registry, store, user: null }
	}

	it('lands a drag-shaped payload through updateHandler', async () => {
		const ctx = await tracker()
		const one = await ctx.store.create('issue', {
			title: 'One',
			status: 'todo',
		})
		const view = board()
		const values = boardMoveValues(
			view,
			one,
			{ value: 'doing', index: 0 },
			[one],
			'id',
		)
		const res = await updateHandler(
			ctx,
			'issue',
			String(one.id),
			values as Record<string, string>,
		)
		expect(res.status).toBe(200)
		const body = res.body as Record<string, unknown>
		expect(body.status).toBe('doing')
		// The move touched the two board columns and nothing else.
		expect(body.title).toBe('One')
	})

	it('422s a drag into a full column — and so does a REST call that never saw the board', async () => {
		const ctx = await tracker()
		const held = await ctx.store.create('issue', {
			title: 'Held',
			status: 'doing',
		})
		const spare = await ctx.store.create('issue', {
			title: 'Spare',
			status: 'todo',
		})
		const values = boardMoveValues(
			board(),
			spare,
			{ value: 'doing', index: 0 },
			[held, spare],
			'id',
		)
		const dragged = await updateHandler(
			ctx,
			'issue',
			String(spare.id),
			values as Record<string, string>,
		)
		expect(dragged.status).toBe(422)
		expect(dragged.body).toHaveProperty('fieldErrors')

		// The part the board cannot help with: an agent posting the same change
		// straight at the API meets the identical refusal.
		const posted = await createHandler(ctx, 'issue', {
			title: 'Straight to the API',
			status: 'doing',
		})
		expect(posted.status).toBe(422)
		expect((posted.body as { error: string }).error).toContain('is full')
	})
})
