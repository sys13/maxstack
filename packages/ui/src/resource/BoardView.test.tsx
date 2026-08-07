/**
 * `<BoardView>` — the board block.
 *
 * The properties asserted here are the issue's gating criteria as they appear on
 * the client: the columns are the *declared* options (not the values that happen
 * to be in the table), a move is always reachable from the keyboard, the WIP
 * limit is shown as text rather than as a colour, and the component never writes
 * — it reports where a card landed and the caller performs the validated update.
 */

import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BoardView } from './BoardView.tsx'
import type { IntrospectedResource, Row } from './resource-types.ts'

const resource: IntrospectedResource = {
	name: 'issue',
	primaryKey: 'id',
	columns: [
		{ name: 'id', type: 'uuid', meta: {} },
		{ name: 'title', type: 'string', meta: { label: 'Title' } },
		{
			name: 'status',
			type: 'enum',
			enumValues: ['todo', 'doing', 'done'],
			meta: {
				options: [
					{ label: 'To do', value: 'todo' },
					{ label: 'Doing', value: 'doing' },
					{ label: 'Done', value: 'done' },
				],
				valueLimits: { doing: 2 },
			},
		},
		{
			name: 'priority',
			type: 'enum',
			enumValues: ['low', 'high'],
			meta: {
				options: [
					{ label: 'Low', value: 'low' },
					{ label: 'High', value: 'high' },
				],
			},
		},
		{
			name: 'boardRank',
			type: 'string',
			meta: { rankKey: true, hidden: true },
		},
	],
}

const rows: Row[] = [
	{
		id: '1',
		title: 'Fix the crash',
		status: 'todo',
		priority: 'high',
		boardRank: '3',
	},
	{
		id: '2',
		title: 'Write the docs',
		status: 'todo',
		priority: 'low',
		boardRank: '1',
	},
	{
		id: '3',
		title: 'Ship the board',
		status: 'doing',
		priority: 'high',
		boardRank: '5',
	},
]

function board(props: Partial<React.ComponentProps<typeof BoardView>> = {}) {
	return render(
		<BoardView
			resource={resource}
			rows={rows}
			groupField="status"
			rankField="boardRank"
			{...props}
		/>,
	)
}

const column = (container: HTMLElement, value: string) =>
	container.querySelector(`[data-board-column="${value}"]`) as HTMLElement

const cardTitles = (container: HTMLElement, value: string) =>
	[...column(container, value).querySelectorAll('[data-card]')].map(
		(li) => li.querySelector('.font-medium')?.textContent,
	)

/** An HTML5 drag payload — the same `text/plain` id the component sets. */
const dataTransfer = (id: string) => ({
	getData: () => id,
	setData: vi.fn(),
	effectAllowed: '',
})

describe('BoardView', () => {
	it('draws one column per declared option, in the declared order', () => {
		const { container } = board()
		expect(
			[...container.querySelectorAll('[data-board-column]')].map((el) =>
				el.getAttribute('data-board-column'),
			),
		).toEqual(['todo', 'doing', 'done'])
		// Including the one with no cards: a column that disappears when it empties
		// is a board that loses "Done" on the day the team ships everything.
		expect(cardTitles(container, 'done')).toEqual([])
	})

	it('orders cards within a column by the rank key, not by arrival', () => {
		const { container } = board()
		expect(cardTitles(container, 'todo')).toEqual([
			'Write the docs',
			'Fix the crash',
		])
	})

	it('keeps the loader’s order when no rank column is declared', () => {
		const { container } = board({ rankField: undefined })
		expect(cardTitles(container, 'todo')).toEqual([
			'Fix the crash',
			'Write the docs',
		])
	})

	it('states the WIP limit as text, so it is not colour alone', () => {
		const { container } = board()
		const header = column(container, 'doing').querySelector(
			'header',
		) as HTMLElement
		expect(header.textContent).toContain('1 / 2')
		// And in words, for a reader that never sees the border turn red.
		expect(header.textContent).toContain('1 of 2 cards, limit 2')
	})

	it('marks a column full once it reaches its limit', () => {
		const full = [
			...rows,
			{ id: '4', title: 'Second', status: 'doing', boardRank: '7' },
		]
		const { container } = board({ rows: full })
		expect(column(container, 'doing').getAttribute('data-full')).toBe('true')
		expect(column(container, 'todo').getAttribute('data-full')).toBeNull()
	})

	it('never writes — a keyboard move reports the destination to the caller', () => {
		const onMove = vi.fn()
		const { container } = board({ onMove })
		const card = column(container, 'todo').querySelector(
			'[data-card="2"]',
		) as HTMLElement
		fireEvent.keyDown(card, { key: 'ArrowRight' })
		expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }), {
			value: 'doing',
			index: 0,
		})
	})

	it('moves within a column with the vertical arrows', () => {
		const onMove = vi.fn()
		const { container } = board({ onMove })
		// "Write the docs" is at index 0 of To do; ArrowDown puts it at 1.
		const card = column(container, 'todo').querySelector(
			'[data-card="2"]',
		) as HTMLElement
		fireEvent.keyDown(card, { key: 'ArrowDown' })
		expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }), {
			value: 'todo',
			index: 1,
		})
	})

	it('does not move past either end of the board', () => {
		const onMove = vi.fn()
		const { container } = board({ onMove })
		const card = column(container, 'todo').querySelector(
			'[data-card="2"]',
		) as HTMLElement
		fireEvent.keyDown(card, { key: 'ArrowLeft' })
		fireEvent.keyDown(card, { key: 'ArrowUp' })
		expect(onMove).not.toHaveBeenCalled()
	})

	it('refuses a move into a full column and says why in the live region', () => {
		const onMove = vi.fn()
		const full = [
			...rows,
			{ id: '4', title: 'Second', status: 'doing', boardRank: '7' },
		]
		const { container } = board({ rows: full, onMove })
		const card = column(container, 'todo').querySelector(
			'[data-card="2"]',
		) as HTMLElement
		fireEvent.keyDown(card, { key: 'ArrowRight' })
		expect(onMove).not.toHaveBeenCalled()
		expect(container.textContent).toContain('Doing is full')
	})

	it('still reorders inside a full column — a limit caps arrivals, not edits', () => {
		const onMove = vi.fn()
		const full = [
			...rows,
			{ id: '4', title: 'Second', status: 'doing', boardRank: '7' },
		]
		const { container } = board({ rows: full, onMove })
		const card = column(container, 'doing').querySelector(
			'[data-card="3"]',
		) as HTMLElement
		fireEvent.keyDown(card, { key: 'ArrowDown' })
		expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ id: '3' }), {
			value: 'doing',
			index: 1,
		})
	})

	it('drops onto a card to land above it', () => {
		const onMove = vi.fn()
		const { container } = board({ onMove })
		const target = column(container, 'doing').querySelector(
			'[data-card="3"]',
		) as HTMLElement
		fireEvent.drop(target, { dataTransfer: dataTransfer('2') })
		expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }), {
			value: 'doing',
			index: 0,
		})
	})

	it('drops onto empty space in a column to land at the end', () => {
		const onMove = vi.fn()
		const { container } = board({ onMove })
		const list = within(column(container, 'done')).getByLabelText('Done cards')
		fireEvent.drop(list, { dataTransfer: dataTransfer('1') })
		expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }), {
			value: 'done',
			index: 0,
		})
	})

	it('accounts for the dragged card when it is dropped lower in its own column', () => {
		// Dropping card 0 onto the position of card 1 means "after it" once the card
		// is lifted out; without the adjustment the move would be a no-op.
		const onMove = vi.fn()
		const { container } = board({ onMove })
		const target = column(container, 'todo').querySelector(
			'[data-card="1"]',
		) as HTMLElement
		fireEvent.drop(target, { dataTransfer: dataTransfer('2') })
		expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }), {
			value: 'todo',
			index: 0,
		})
	})

	it('offers no move affordance at all when the board is read-only', () => {
		const { container } = board()
		const card = column(container, 'todo').querySelector(
			'[data-card="2"]',
		) as HTMLElement
		expect(card.getAttribute('draggable')).toBeNull()
		expect(card.getAttribute('aria-keyshortcuts')).toBeNull()
		expect(container.textContent).not.toContain('arrow keys')
	})

	it('renders declared card fields, and the group column is never the title', () => {
		board({ cardFields: ['priority'] })
		const card = screen.getByText('Fix the crash').closest('li') as HTMLElement
		expect(within(card).getByText('High')).toBeInTheDocument()
	})

	// Issue #340: four columns made the *document* scroll sideways, not the
	// board. The scroller was already the right element and already the right
	// width — the leak was that overflow does not clip an absolutely positioned
	// descendant whose containing block is outside it, and every column header
	// holds an `sr-only` span, which is `position: absolute`. Those 1px spans sat
	// at the off-screen columns' coordinates and widened the page.
	//
	// jsdom has no layout engine, so `scrollWidth` here is always 0 and a
	// measurement assertion would be theatre. What is real and checkable in the
	// DOM is the structural pair the fix rests on: the scroller carries
	// `overflow-x-auto`, and it is positioned, so it is the containing block for
	// the absolutely positioned descendants it contains. The measured numbers
	// live in the issue; this keeps someone from deleting one half of the pair.
	it('scrolls the board inside a positioned container, so the page cannot', () => {
		const { container } = board()
		const scroller = container.querySelector(
			'[data-board-group]',
		) as HTMLElement
		expect(scroller.className).toContain('overflow-x-auto')
		expect(scroller.className).toContain('relative')
		// The reason `relative` is not cosmetic: these live inside the scroller and
		// are absolutely positioned, so an unpositioned scroller would not clip
		// them.
		expect(
			column(container, 'done').querySelectorAll('.sr-only').length,
		).toBeGreaterThan(0)
	})

	it('shows the empty state only when the board has no rows at all', () => {
		const { container } = board({ rows: [], emptyState: <p>Nothing yet</p> })
		expect(container.textContent).toContain('Nothing yet')
		expect(container.querySelector('[data-board-column]')).toBeNull()
	})
})
