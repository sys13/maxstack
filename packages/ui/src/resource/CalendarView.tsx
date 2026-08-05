/**
 * `<CalendarView>` — the `calendar` block: the page's rows arranged
 * by a declared date column, as a month grid, a week grid, or a density heatmap.
 *
 * The three corpus asks behind this ("a calendar heatmap of habit completions",
 * "a drag-and-drop weekly meal planner", and the timeline's Gantt) were three
 * bespoke features that are one arrangement — the same rows, placed by a date —
 * so they are one primitive rather than three ejects.
 *
 * ## What this component does *not* decide
 *
 * - **The timezone.** It is a required prop, resolved from the spec, and every
 *   bucketing decision goes through `dayKeyOf(value, timezone)`. Nothing here
 *   reads the browser's zone.
 * - **The write.** `onMove` hands the caller a row and a target day key. The
 *   caller turns that into an ordinary validated record update — the view has no
 *   write path of its own, which is exactly why a drag cannot become a hole in
 *   the permission model.
 * - **Derivations.** A heatmap draws how many rows fall on a day. Streak rules,
 *   grace days and "what counts as a miss" are data-layer questions and are
 *   deliberately absent.
 *
 * ## Moving an entry without a mouse
 *
 * Drag-and-drop is an *affordance*, never the only one. Every entry is a focus
 * stop, and with `onMove` wired the arrow keys move the focused entry: left/right
 * by a day, up/down by a week (by a day in the week grid, where a row *is* the
 * week). Each move is announced in a live region, because the visual result of a
 * keyboard move is elsewhere on screen.
 */

import { type KeyboardEvent, type ReactNode, useMemo, useState } from 'react'
import { cn } from '../lib/cn.ts'
import {
	addDays,
	type DayKey,
	dayKeyOf,
	entryDays,
	formatDayLabel,
	heatmapGrid,
	monthGrid,
	monthStart,
	weekGrid,
} from './calendar-days.ts'
import { pickPrimary } from './pick-fields.ts'
import type { IntrospectedResource, Row } from './resource-types.ts'

export type CalendarDisplay = 'month' | 'week' | 'heatmap'

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

export interface CalendarViewProps {
	resource: IntrospectedResource
	rows: Row[]
	/** The column each row is placed by (spec: `calendar.dateField`). */
	dateField: string
	/** Optional column ending a multi-day entry (spec: `calendar.endField`). */
	endField?: string
	/** Column rendered as the entry label; defaults to the title heuristic. */
	titleField?: string
	display: CalendarDisplay
	/** IANA zone the days are bucketed in — declared in the spec, never inferred. */
	timezone: string
	/**
	 * The day the grid is drawn around, as a day key in `timezone`. Required
	 * rather than defaulting to "today", so the grid a server renders and the one
	 * a client hydrates are the same grid.
	 */
	anchor: DayKey
	rowHref?: (row: Row) => string
	linkComponent?: LinkLike
	/** Shown when no row in the window has a date. */
	emptyState?: ReactNode
	/**
	 * Present ⇒ entries are movable, by drag or by keyboard. Receives the row and
	 * the target day key; the caller performs the (validated) update.
	 */
	onMove?: (row: Row, day: DayKey) => void
	/** Primary keys created by the demo seeder — marked as sample data. */
	demoIds?: readonly string[]
	className?: string
}

/** One placed row: the entry, plus the days it occupies. */
interface PlacedEntry {
	id: string
	row: Row
	title: string
	start: DayKey
	days: DayKey[]
}

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function CalendarView({
	resource,
	rows,
	dateField,
	endField,
	titleField,
	display,
	timezone,
	anchor,
	rowHref,
	linkComponent,
	emptyState,
	onMove,
	demoIds,
	className,
}: CalendarViewProps) {
	const Link = linkComponent ?? DefaultLink
	const pk = resource.primaryKey
	const [announcement, setAnnouncement] = useState('')
	const demo = useMemo(() => new Set(demoIds ?? []), [demoIds])

	const labelField = useMemo(() => {
		const visible = resource.columns
			.filter((c) => c.name !== pk && c.meta?.hidden !== true)
			.map((c) => c.name)
		return pickPrimary(resource, visible, titleField)
	}, [resource, pk, titleField])

	const entries = useMemo<PlacedEntry[]>(() => {
		return rows.flatMap((row) => {
			const start = dayKeyOf(row[dateField], timezone)
			if (!start) return []
			const end = endField ? dayKeyOf(row[endField], timezone) : null
			const label = labelField ? row[labelField] : undefined
			return [
				{
					id: String(row[pk]),
					row,
					title: label == null || label === '' ? `(untitled)` : String(label),
					start,
					days: entryDays(start, end),
				},
			]
		})
	}, [rows, dateField, endField, labelField, pk, timezone])

	const days = useMemo(() => {
		if (display === 'week') return weekGrid(anchor)
		if (display === 'heatmap') return heatmapGrid(anchor)
		return monthGrid(anchor)
	}, [display, anchor])

	const byDay = useMemo(() => {
		const map = new Map<DayKey, PlacedEntry[]>()
		for (const entry of entries)
			for (const day of entry.days) {
				const bucket = map.get(day)
				if (bucket) bucket.push(entry)
				else map.set(day, [entry])
			}
		return map
	}, [entries])

	// A page with no dated rows at all is an empty state; a *window* with none is
	// an empty week, which is a legitimate answer and still draws its grid.
	if (entries.length === 0 && emptyState) return <>{emptyState}</>

	function move(entry: PlacedEntry, day: DayKey) {
		if (!onMove) return
		onMove(entry.row, day)
		setAnnouncement(`Moved ${entry.title} to ${formatDayLabel(day)}`)
	}

	/**
	 * Arrow keys move the focused entry: a day sideways, a week vertically in the
	 * month grid (where a row is a week) and a day vertically in the week grid
	 * (where a row is a day). The event is only swallowed when a move is actually
	 * possible, so a read-only calendar keeps native scrolling.
	 */
	function onEntryKeyDown(event: KeyboardEvent, entry: PlacedEntry) {
		if (!onMove) return
		const step =
			event.key === 'ArrowLeft'
				? -1
				: event.key === 'ArrowRight'
					? 1
					: event.key === 'ArrowUp'
						? display === 'week'
							? -1
							: -7
						: event.key === 'ArrowDown'
							? display === 'week'
								? 1
								: 7
							: 0
		if (step === 0) return
		event.preventDefault()
		move(entry, addDays(entry.start, step))
	}

	if (display === 'heatmap') {
		return <HeatmapGrid days={days} byDay={byDay} className={className} />
	}

	// Whole weeks, so the grid is a real table: a month view *is* tabular data
	// (seven day columns, one row per week), and marking it up as one gives a
	// screen reader row/column navigation for free — as well as making the drop
	// targets cells rather than anonymous divs.
	const weeks: DayKey[][] = []
	for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7))
	return (
		<section
			className={cn('rounded-lg border border-border', className)}
			data-calendar-display={display}
			data-timezone={timezone}
		>
			{onMove ? (
				<p className="border-border border-b px-3 py-2 text-muted-foreground text-xs">
					Drag an entry to another day, or focus one and use the arrow keys.
					Dates are shown in {timezone}.
				</p>
			) : null}
			<table
				className="w-full table-fixed border-collapse"
				aria-label={`${display === 'week' ? 'Week' : 'Month'} calendar of ${resource.name}`}
			>
				<thead className="bg-muted/40 text-muted-foreground text-xs">
					<tr>
						{WEEKDAY_LABELS.map((label) => (
							<th key={label} scope="col" className="px-2 py-1 font-medium">
								{label}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{weeks.map((week) => (
						<tr key={week[0]}>
							{week.map((day) => {
								const outside =
									display === 'month' &&
									day.slice(0, 7) !== monthStart(anchor).slice(0, 7)
								const dayEntries = byDay.get(day) ?? []
								return (
									<td
										key={day}
										data-day={day}
										aria-label={formatDayLabel(day, {
											weekday: 'long',
											day: 'numeric',
											month: 'long',
											year: 'numeric',
										})}
										className={cn(
											'h-24 border border-border p-1 align-top',
											outside && 'bg-muted/30 text-muted-foreground',
										)}
										onDragOver={onMove ? (e) => e.preventDefault() : undefined}
										onDrop={
											onMove
												? (event) => {
														event.preventDefault()
														const id = event.dataTransfer.getData('text/plain')
														const entry = entries.find((e) => e.id === id)
														if (entry && entry.start !== day) move(entry, day)
													}
												: undefined
										}
									>
										<div className="px-1 text-muted-foreground text-xs">
											{Number(day.slice(8))}
										</div>
										<ul className="m-0 list-none space-y-1 p-0">
											{dayEntries.map((entry) => (
												<CalendarEntry
													key={`${entry.id}-${day}`}
													entry={entry}
													day={day}
													movable={Boolean(onMove)}
													isDemo={demo.has(entry.id)}
													href={rowHref?.(entry.row)}
													Link={Link}
													onKeyDown={(event) => onEntryKeyDown(event, entry)}
												/>
											))}
										</ul>
									</td>
								)
							})}
						</tr>
					))}
				</tbody>
			</table>
			<p aria-live="polite" className="sr-only">
				{announcement}
			</p>
		</section>
	)
}

/**
 * One entry chip. It is a link when the row has a detail route, because opening
 * a record is what a click on it means everywhere else in the app; the move
 * affordances ride on top rather than replacing it.
 */
function CalendarEntry({
	entry,
	day,
	movable,
	isDemo,
	href,
	Link,
	onKeyDown,
}: {
	entry: PlacedEntry
	day: DayKey
	movable: boolean
	isDemo: boolean
	href?: string
	Link: LinkLike
	onKeyDown: (event: KeyboardEvent) => void
}) {
	const continued = entry.days.length > 1 && entry.days[0] !== day
	const label = `${entry.title}${continued ? ' (continued)' : ''}`
	const chip = cn(
		'block truncate rounded bg-primary/10 px-1.5 py-0.5 text-left text-xs no-underline',
		movable && 'cursor-grab',
	)
	const shared = {
		draggable: movable || undefined,
		onDragStart: movable
			? (event: React.DragEvent) => {
					event.dataTransfer.setData('text/plain', entry.id)
					event.dataTransfer.effectAllowed = 'move'
				}
			: undefined,
		onKeyDown: movable ? onKeyDown : undefined,
		'aria-keyshortcuts': movable
			? 'ArrowLeft ArrowRight ArrowUp ArrowDown'
			: undefined,
		'data-entry': entry.id,
		title: isDemo ? `${entry.title} — sample data` : entry.title,
	}
	// The `<li>` carries the drag and key handlers: it is the entry, and a list
	// item is a legitimate host for them, where a bare span is not. Focus lands on
	// the link inside (or on the chip itself when the row has no detail route) and
	// the keydown bubbles up to here.
	return href ? (
		<li {...shared}>
			<Link to={href} className={chip}>
				{label}
			</Link>
		</li>
	) : (
		<li {...shared} tabIndex={movable ? 0 : undefined} className={chip}>
			{label}
		</li>
	)
}

/**
 * The density grid: one square per day, shaded by how many rows fall on it.
 *
 * Deliberately not interactive. A heatmap cell is a *count*, not an entry —
 * there is no single row a drop would rewrite — and the op refuses
 * `reschedule` here for the same reason. Counts are exposed as text on each
 * cell's title/aria-label rather than colour alone, so the graph is readable
 * without discriminating shades.
 */
function HeatmapGrid({
	days,
	byDay,
	className,
}: {
	days: DayKey[]
	byDay: Map<DayKey, PlacedEntry[]>
	className?: string
}) {
	const counts = days.map((day) => byDay.get(day)?.length ?? 0)
	const max = Math.max(1, ...counts)
	const weeks: DayKey[][] = []
	for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7))
	return (
		<section
			className={cn('overflow-x-auto', className)}
			aria-label="Activity heatmap"
		>
			<div className="flex gap-1">
				{weeks.map((week) => (
					<div key={week[0]} className="flex flex-col gap-1">
						{week.map((day) => {
							const count = byDay.get(day)?.length ?? 0
							// Four steps plus empty: enough to read a trend, few enough that
							// adjacent levels stay distinguishable.
							const level = count === 0 ? 0 : Math.ceil((count / max) * 4)
							return (
								<div
									// A square encodes a number as an area of colour, so it is a
									// graphic — and its label states the count in words, because a
									// graph nobody can read the shades of is not a graph.
									role="img"
									key={day}
									data-day={day}
									data-count={count}
									title={`${formatDayLabel(day)}: ${count}`}
									aria-label={`${formatDayLabel(day)}: ${count}`}
									className="size-3 rounded-sm bg-primary"
									style={{ opacity: level === 0 ? 0.08 : 0.15 + level * 0.2 }}
								/>
							)
						})}
					</div>
				))}
			</div>
		</section>
	)
}
