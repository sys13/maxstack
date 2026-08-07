/**
 * `<BoardView>` — the `board` block: the page's rows as cards in
 * columns, grouped by a declared enum field, moved between columns by dragging
 * or by keyboard.
 *
 * The two corpus asks behind this — bugtrail's "Kanban board with
 * drag-between-columns and per-column WIP limits" and crmlite's "drag deals
 * between pipeline stages" — read like a bespoke feature and are three things
 * the spec already says: an enum's declared options are the columns, a rank key
 * is the order inside one, and a drop is an update of the enum.
 *
 * ## What this component does *not* decide
 *
 * - **The write.** `onMove` hands the caller a row, a target column value, and
 *   the index it was dropped at. The caller turns that into an ordinary
 *   validated record update. The board has no write path of its own, so a drag
 *   cannot become a hole in the permission model.
 * - **The WIP limit.** The number drawn on a column header comes from the same
 *   column metadata the *server* enforces (`meta.valueLimits`). This component
 *   refuses a drop into a full column as an affordance — to say why before the
 *   round trip — and that refusal is decoration: the server refuses it too, for
 *   a REST client that never loaded this page at all.
 * - **What a move means.** A card entering "Done" is a value change and nothing
 *   more. Notifications, timers and downstream records are not board business.
 *
 * ## Moving a card without a mouse
 *
 * Drag-and-drop is an affordance, never the only one. Every card is a focus
 * stop, and with `onMove` wired the arrow keys move the focused card: left/right
 * to the adjacent column (landing at the same depth), up/down within its own
 * column. Each move is announced in a live region, because the visual result
 * happens somewhere other than where the focus is.
 */

import { type KeyboardEvent, type ReactNode, useMemo, useState } from 'react'
import { Field } from '../fields/fields.tsx'
import { cn } from '../lib/cn.ts'
import { pickPrimary } from './pick-fields.ts'
import { compareRanked } from './rank.ts'
import type { IntrospectedResource, Row } from './resource-types.ts'

type LinkLike = (props: {
	to: string
	children: ReactNode
	className?: string
}) => ReactNode

const DefaultLink: LinkLike = ({ to, children, className }) => (
	<a href={to} className={className}>
		{children}
	</a>
)

/** Where a card was dropped: which column, and its position within it. */
export interface BoardDrop {
	/** The `groupField` value of the destination column. */
	value: string
	/**
	 * The index the card lands at among the destination's *other* cards — 0 is the
	 * top, `siblings.length` the bottom. The caller turns this into a rank key.
	 */
	index: number
}

export interface BoardViewProps {
	resource: IntrospectedResource
	rows: Row[]
	/** The enum column whose value places a card in a column (spec: `board.groupField`). */
	groupField: string
	/** The rank column ordering cards within a column (spec: `board.rankField`). */
	rankField?: string
	/** Column rendered as the card title; defaults to the title heuristic. */
	titleField?: string
	/** Extra columns rendered on the card under its title. */
	cardFields?: string[]
	rowHref?: (row: Row) => string
	linkComponent?: LinkLike
	/** Shown when the board has no rows at all. */
	emptyState?: ReactNode
	/**
	 * Present ⇒ cards are movable, by drag or by keyboard. Receives the row and
	 * where it landed; the caller performs the (validated) update.
	 */
	onMove?: (row: Row, drop: BoardDrop) => void
	/** Primary keys created by the demo seeder — marked as sample data. */
	demoIds?: readonly string[]
	className?: string
}

/** One board column: a declared option, its cards, and its declared cap. */
interface BoardColumn {
	value: string
	label: string
	limit?: number
	cards: BoardCard[]
}

interface BoardCard {
	id: string
	row: Row
	title: string
}

export function BoardView({
	resource,
	rows,
	groupField,
	rankField,
	titleField,
	cardFields,
	rowHref,
	linkComponent,
	emptyState,
	onMove,
	demoIds,
	className,
}: BoardViewProps) {
	const Link = linkComponent ?? DefaultLink
	const pk = resource.primaryKey
	const [announcement, setAnnouncement] = useState('')
	const demo = useMemo(() => new Set(demoIds ?? []), [demoIds])

	const groupColumn = resource.columns.find((c) => c.name === groupField)

	const labelField = useMemo(() => {
		const visible = resource.columns
			.filter(
				(c) =>
					c.name !== pk && c.meta?.hidden !== true && c.name !== groupField,
			)
			.map((c) => c.name)
		return pickPrimary(resource, visible, titleField)
	}, [resource, pk, titleField, groupField])

	const extras = useMemo(
		() =>
			(cardFields ?? [])
				.map((name) => resource.columns.find((c) => c.name === name))
				.filter((c) => c !== undefined),
		[cardFields, resource],
	)

	const columns = useMemo<BoardColumn[]>(() => {
		// The declared options ARE the columns, in the order declared. A board whose
		// columns were "the values present in the table" would gain a column the
		// first time somebody typo'd one, and lose "Done" on the day it emptied.
		const options =
			groupColumn?.meta?.options ??
			(groupColumn?.enumValues ?? []).map((v) => ({ label: v, value: v }))
		const limits = groupColumn?.meta?.valueLimits
		// With no rank column there is no manual order to respect, so the rows keep
		// the order the loader read them in — re-sorting them by id would replace a
		// meaningful order (the page's own) with an arbitrary one.
		const sorted = rankField
			? [...rows].sort((a, b) =>
					compareRanked(
						{ rank: rankKeyOf(a, rankField), id: String(a[pk]) },
						{ rank: rankKeyOf(b, rankField), id: String(b[pk]) },
					),
				)
			: rows
		return options.map((option) => ({
			value: option.value,
			label: option.label,
			limit: limits?.[option.value],
			cards: sorted
				.filter((row) => String(row[groupField] ?? '') === option.value)
				.map((row) => {
					const label = labelField ? row[labelField] : undefined
					return {
						id: String(row[pk]),
						row,
						title: label == null || label === '' ? '(untitled)' : String(label),
					}
				}),
		}))
	}, [rows, groupColumn, groupField, rankField, labelField, pk])

	if (rows.length === 0 && emptyState) return <>{emptyState}</>

	/** Move `card` to `value` at `index` among that column's other cards. */
	function move(card: BoardCard, column: BoardColumn, index: number) {
		if (!onMove) return
		// The affordance half of the WIP limit. A card already *in* the column is
		// only being reordered, so a full column never blocks its own cards — the
		// same rule the server applies when it compares against the stored value.
		const incoming = String(card.row[groupField] ?? '') !== column.value
		if (
			incoming &&
			column.limit !== undefined &&
			column.cards.length >= column.limit
		) {
			setAnnouncement(
				`${column.label} is full — it allows ${column.limit} and already holds ${column.cards.length}.`,
			)
			return
		}
		onMove(card.row, { value: column.value, index })
		setAnnouncement(
			`Moved ${card.title} to ${column.label}, position ${index + 1}`,
		)
	}

	/**
	 * Arrow keys move the focused card: left/right to the adjacent column at the
	 * same depth, up/down one place within its own column. The event is only
	 * swallowed when a move is actually possible, so a read-only board keeps
	 * native scrolling.
	 */
	function onCardKeyDown(
		event: KeyboardEvent,
		card: BoardCard,
		columnIndex: number,
		cardIndex: number,
	) {
		if (!onMove) return
		const { key } = event
		if (key === 'ArrowLeft' || key === 'ArrowRight') {
			const target = columns[columnIndex + (key === 'ArrowLeft' ? -1 : 1)]
			if (!target) return
			event.preventDefault()
			move(card, target, Math.min(cardIndex, target.cards.length))
			return
		}
		if (key === 'ArrowUp' || key === 'ArrowDown') {
			const column = columns[columnIndex]
			if (!column) return
			const to = cardIndex + (key === 'ArrowUp' ? -1 : 1)
			if (to < 0 || to >= column.cards.length) return
			event.preventDefault()
			move(card, column, to)
		}
	}

	const findCard = (id: string): [BoardCard, BoardColumn] | undefined => {
		for (const column of columns) {
			const card = column.cards.find((c) => c.id === id)
			if (card) return [card, column]
		}
		return undefined
	}

	/** A drop landing in `column` at `index`, from an HTML5 drag payload. */
	function onDropAt(id: string, column: BoardColumn, index: number) {
		const found = findCard(id)
		if (!found) return
		const [card, from] = found
		// Within one column the dragged card is still in `cards`, so an index past
		// its own position would land one place short once it is removed.
		const adjusted =
			from.value === column.value &&
			column.cards.findIndex((c) => c.id === id) < index
				? index - 1
				: index
		move(card, column, adjusted)
	}

	return (
		<section
			// `relative` is load-bearing, not decoration (issue #340). The board is
			// wider than its box on purpose — four `w-64` columns exceed the content
			// column on a laptop — and `overflow-x-auto` scrolls it, correctly. But
			// overflow only clips descendants whose containing block is this element
			// or something inside it. The per-column `sr-only` spans are
			// `position: absolute`, so on an unpositioned scroller their containing
			// block was the *initial* one: they sat at the off-screen columns'
			// coordinates, unclipped, and widened the **document** — a body-level
			// horizontal scrollbar caused by a 1px invisible span. Positioning the
			// scroller makes it their containing block, so they scroll with the board
			// like everything else in it.
			className={cn('relative overflow-x-auto', className)}
			data-board-group={groupField}
		>
			{onMove ? (
				<p className="mb-2 text-muted-foreground text-xs">
					Drag a card to another column, or focus one and use the arrow keys.
				</p>
			) : null}
			<div className="flex items-start gap-3">
				{columns.map((column, columnIndex) => {
					const full =
						column.limit !== undefined && column.cards.length >= column.limit
					return (
						<div
							key={column.value}
							data-board-column={column.value}
							data-full={full || undefined}
							className={cn(
								'w-64 shrink-0 rounded-lg border border-border bg-muted/20',
								full && 'border-destructive/60',
							)}
						>
							<header className="flex items-baseline justify-between gap-2 border-border border-b px-3 py-2">
								<h2 className="font-medium text-sm">{column.label}</h2>
								{/* A full column is *stated*, not just tinted: the count is
								    visible text, and the sentence a screen reader gets says
								    "full" in words. A limit conveyed by a red border only is a
								    limit half the people looking at the board cannot see. */}
								<span
									className={cn(
										'text-muted-foreground text-xs tabular-nums',
										full && 'font-medium text-destructive',
									)}
								>
									<span aria-hidden="true">
										{column.limit === undefined
											? column.cards.length
											: `${column.cards.length} / ${column.limit}`}
									</span>
									<span className="sr-only">
										{column.limit === undefined
											? `${column.cards.length} cards`
											: `${column.cards.length} of ${column.limit} cards, limit ${column.limit}${full ? ', full' : ''}`}
									</span>
								</span>
							</header>
							<ul
								className="m-0 min-h-16 list-none space-y-2 p-2"
								aria-label={`${column.label} cards`}
								onDragOver={onMove ? (e) => e.preventDefault() : undefined}
								onDrop={
									onMove
										? (event) => {
												event.preventDefault()
												onDropAt(
													event.dataTransfer.getData('text/plain'),
													column,
													column.cards.length,
												)
											}
										: undefined
								}
							>
								{column.cards.map((card, cardIndex) => (
									<li
										key={card.id}
										data-card={card.id}
										draggable={onMove ? true : undefined}
										onDragStart={
											onMove
												? (event) => {
														event.dataTransfer.setData('text/plain', card.id)
														event.dataTransfer.effectAllowed = 'move'
													}
												: undefined
										}
										onDrop={
											onMove
												? (event) => {
														// A drop *on* a card lands above it, which is how
														// every board people have used behaves.
														event.preventDefault()
														event.stopPropagation()
														onDropAt(
															event.dataTransfer.getData('text/plain'),
															column,
															cardIndex,
														)
													}
												: undefined
										}
										onKeyDown={
											onMove
												? (event) =>
														onCardKeyDown(event, card, columnIndex, cardIndex)
												: undefined
										}
										aria-keyshortcuts={
											onMove
												? 'ArrowLeft ArrowRight ArrowUp ArrowDown'
												: undefined
										}
										tabIndex={onMove && !rowHref ? 0 : undefined}
										className={cn(
											'rounded-md border border-border bg-background p-2 text-sm shadow-sm',
											onMove && 'cursor-grab',
										)}
									>
										{rowHref ? (
											<Link
												to={rowHref(card.row)}
												className="block font-medium no-underline"
											>
												{card.title}
											</Link>
										) : (
											<span className="block font-medium">{card.title}</span>
										)}
										{demo.has(card.id) ? (
											<span className="mt-1 inline-block rounded bg-muted px-1 text-[10px] text-muted-foreground">
												sample
											</span>
										) : null}
										{extras.length > 0 ? (
											<dl className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
												{extras.map((c) => (
													<div key={c.name} className="flex items-center gap-1">
														<dt className="sr-only">{c.name}</dt>
														<dd className="m-0">
															<Field value={card.row[c.name]} column={c} />
														</dd>
													</div>
												))}
											</dl>
										) : null}
									</li>
								))}
							</ul>
						</div>
					)
				})}
			</div>
			<p aria-live="polite" className="sr-only">
				{announcement}
			</p>
		</section>
	)
}

/** A row's rank key, when the board declares one. */
function rankKeyOf(row: Row, rankField?: string): string | null {
	if (!rankField) return null
	const value = row[rankField]
	return typeof value === 'string' ? value : null
}
