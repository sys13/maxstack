/**
 * `<TimelineView>` — the `timeline` block: the page's rows as bars
 * across a declared start/end date range, with optional dependency arrows.
 *
 * The corpus ask is taskly's "a Gantt timeline with dependency arrows between
 * tasks". The arrows are the interesting half, and the line drawn here is
 * deliberate and narrow: **an edge is presentation of a declared relation.** The
 * view draws the arrow a self-referencing field already implies. It does not
 * reschedule dependents when a bar moves, detect cycles, or compute a critical
 * path — that is a scheduling engine, it belongs to the data layer if anywhere,
 * and quietly growing one inside a chart component is how a view primitive turns
 * into a product nobody chose to build.
 *
 * Like `<CalendarView>`, this component owns no write path: `onMove` reports a
 * new start day and the caller performs an ordinary validated record update.
 * Bars are focusable and movable by arrow key, so the timeline is never
 * drag-only.
 */

import { type KeyboardEvent, type ReactNode, useMemo, useState } from 'react'
import { cn } from '../lib/cn.ts'
import {
	addDays,
	type DayKey,
	dayKeyOf,
	daysBetween,
	formatDayLabel,
} from './calendar-days.ts'
import { pickPrimary } from './pick-fields.ts'
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

export interface TimelineViewProps {
	resource: IntrospectedResource
	rows: Row[]
	/** The column a bar starts at (spec: `timeline.startField`). */
	startField: string
	/** The column a bar ends at (spec: `timeline.endField`). */
	endField: string
	/** Column rendered as the bar label; defaults to the title heuristic. */
	titleField?: string
	/**
	 * A column holding the primary key of the row this row follows (spec:
	 * `timeline.dependsOn`) — drawn as an arrow, and nothing more.
	 */
	dependsOnField?: string
	/** IANA zone the days are bucketed in — declared in the spec, never inferred. */
	timezone: string
	/**
	 * The axis to draw, when the caller has one.
	 *
	 * Absent, the axis spans the data — which is what this always did, and what
	 * makes the component usable on its own with a fixed row set. Present, the
	 * axis is exactly this window and bars are **clipped** to it.
	 *
	 * The caller supplies it because the caller is the one that queried: a route
	 * that windows its query and then draws an axis derived from whatever came
	 * back gets an axis that rescales every time a row moves, and a "later" link
	 * that leads somewhere the chart does not agree exists. A bar clipped at an
	 * edge is marked as continuing, so a span reaching out of the window reads as
	 * a span reaching out of the window rather than as one that ends there.
	 */
	window?: { from: string; to: string }
	rowHref?: (row: Row) => string
	linkComponent?: LinkLike
	/** Shown when no row carries a start date. */
	emptyState?: ReactNode
	/**
	 * Present ⇒ bars are movable, by drag or by keyboard. Receives the row and the
	 * bar's new **start** day; the caller shifts the range and performs the
	 * (validated) update.
	 */
	onMove?: (row: Row, day: DayKey) => void
	/** Primary keys created by the demo seeder — marked as sample data. */
	demoIds?: readonly string[]
	className?: string
}

interface Bar {
	id: string
	row: Row
	title: string
	start: DayKey
	end: DayKey
	dependsOn: string | null
}

const ROW_HEIGHT = 32

export function TimelineView({
	resource,
	rows,
	startField,
	endField,
	titleField,
	dependsOnField,
	timezone,
	window,
	rowHref,
	linkComponent,
	emptyState,
	onMove,
	demoIds,
	className,
}: TimelineViewProps) {
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

	const bars = useMemo<Bar[]>(() => {
		return rows
			.flatMap((row) => {
				const start = dayKeyOf(row[startField], timezone)
				if (!start) return []
				// A row with no end is a milestone, drawn as a single day rather than
				// dropped: a bar that vanishes because one column is null is the
				// failure people blame on the data being "gone".
				const end = dayKeyOf(row[endField], timezone) ?? start
				const label = labelField ? row[labelField] : undefined
				const dep = dependsOnField ? row[dependsOnField] : null
				return [
					{
						id: String(row[pk]),
						row,
						title: label == null || label === '' ? '(untitled)' : String(label),
						start,
						end: daysBetween(start, end) < 0 ? start : end,
						dependsOn: dep == null || dep === '' ? null : String(dep),
					},
				]
			})
			.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
	}, [rows, startField, endField, dependsOnField, labelField, pk, timezone])

	if (bars.length === 0 && emptyState) return <>{emptyState}</>

	// The declared axis wins outright. Without one it spans the data, padded by a
	// day at each end so a bar starting on the first day is still visibly a bar.
	const first =
		(window?.from as DayKey | undefined) ??
		addDays(
			bars.reduce(
				(min, b) => (b.start < min ? b.start : min),
				bars[0]?.start ?? '',
			),
			-1,
		)
	const last =
		(window?.to as DayKey | undefined) ??
		addDays(
			bars.reduce((max, b) => (b.end > max ? b.end : max), bars[0]?.end ?? ''),
			1,
		)
	const span = Math.max(1, daysBetween(first, last) + 1)
	const index = new Map(bars.map((bar, i) => [bar.id, i] as const))
	// Clipped to the axis, so a bar that starts before the window is drawn from
	// the left edge rather than at a negative offset — which is what a bar
	// reaching out of view actually looks like, and what an unclipped one does
	// not (it renders off-screen and reads as missing).
	const clipStart = (bar: Bar): DayKey =>
		bar.start < first ? first : bar.start
	const clipEnd = (bar: Bar): DayKey => (bar.end > last ? last : bar.end)
	const pct = (day: DayKey) => (daysBetween(first, day) / span) * 100
	const width = (bar: Bar) =>
		Math.max(0, ((daysBetween(clipStart(bar), clipEnd(bar)) + 1) / span) * 100)

	function move(bar: Bar, day: DayKey) {
		if (!onMove) return
		onMove(bar.row, day)
		setAnnouncement(`Moved ${bar.title} to start ${formatDayLabel(day)}`)
	}

	function onBarKeyDown(event: KeyboardEvent, bar: Bar) {
		if (!onMove) return
		const step =
			event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
		if (step === 0) return
		event.preventDefault()
		move(bar, addDays(bar.start, step))
	}

	return (
		<section
			// `relative` for the same reason as `BoardView` (issue #340): this
			// scroller hosts absolutely positioned descendants — the bars and their
			// `sr-only` labels — and an unpositioned scroll container does not clip
			// them, so any that landed past the viewport would widen the document
			// instead of scrolling inside the chart. The bars are already contained
			// by the `relative` axis `<ul>` below, so nothing here moves; this closes
			// the same hole one level up rather than waiting for a descendant that
			// isn't.
			className={cn(
				'relative overflow-x-auto rounded-lg border border-border',
				className,
			)}
			aria-label={`Timeline of ${resource.name}`}
			data-timezone={timezone}
		>
			<p className="border-border border-b px-3 py-2 text-muted-foreground text-xs">
				{formatDayLabel(first)} – {formatDayLabel(last)} ({timezone})
				{onMove
					? ' · drag a bar, or focus one and use the left/right arrow keys'
					: null}
			</p>
			{/* A list of bars, marked up as one: each bar is an entry, and a list
			    item is a legitimate host for the drag/key handlers the chart needs.
			    The drop target is the axis itself, so its handlers sit on the list;
			    every move it accepts is also available from the keyboard on the bars
			    inside it, which are the focus stops. */}
			<ul
				className="relative m-0 list-none p-0"
				style={{ height: bars.length * ROW_HEIGHT }}
				onDragOver={onMove ? (event) => event.preventDefault() : undefined}
				onDrop={
					onMove
						? (event) => {
								event.preventDefault()
								const bar = bars.find(
									(b) => b.id === event.dataTransfer.getData('text/plain'),
								)
								if (!bar) return
								// Where the pointer landed on the axis, in days. The bar keeps
								// its duration; only its start moves, which is what "drag a
								// Gantt bar" means everywhere it already exists.
								const rect = event.currentTarget.getBoundingClientRect()
								const offset = rect.width
									? (event.clientX - rect.left) / rect.width
									: 0
								const day = addDays(first, Math.round(offset * span))
								if (day !== bar.start) move(bar, day)
							}
						: undefined
				}
			>
				{/* Dependency edges, drawn in the same coordinate space as the bars:
				    x as a percentage of the axis, y as the bar's row. Presentation of a
				    declared relation — an edge to a row that isn't on screen is simply
				    not drawn, rather than pointing at nothing. */}
				{dependsOnField ? (
					<svg
						className="pointer-events-none absolute inset-0 h-full w-full text-muted-foreground"
						aria-hidden="true"
					>
						<title>Dependency edges</title>
						{bars.map((bar) => {
							const from = bar.dependsOn ? index.get(bar.dependsOn) : undefined
							if (from === undefined) return null
							const predecessor = bars[from]
							if (!predecessor) return null
							const y1 = from * ROW_HEIGHT + ROW_HEIGHT / 2
							const y2 = (index.get(bar.id) ?? 0) * ROW_HEIGHT + ROW_HEIGHT / 2
							return (
								<line
									key={`${predecessor.id}->${bar.id}`}
									x1={`${pct(addDays(predecessor.end, 1))}%`}
									y1={y1}
									x2={`${pct(bar.start)}%`}
									y2={y2}
									stroke="currentColor"
									strokeWidth={1}
									strokeDasharray="3 2"
									data-edge={`${predecessor.id}->${bar.id}`}
								/>
							)
						})}
					</svg>
				) : null}
				{bars.map((bar) => {
					const dependency = bar.dependsOn
						? bars.find((b) => b.id === bar.dependsOn)
						: undefined
					// The label always states the bar's OWN dates, never the clipped
					// ones: a screen reader hearing the edge of the window instead of
					// the row's real end would be told something untrue about the data.
					const clipped =
						bar.start < first || bar.end > last
							? ', continues outside this period'
							: ''
					const label = `${bar.title}: ${formatDayLabel(bar.start)} – ${formatDayLabel(bar.end)}${clipped}${
						dependency ? `, follows ${dependency.title}` : ''
					}${demo.has(bar.id) ? ' (sample data)' : ''}`
					const content = (
						<span className="truncate px-2 text-primary-foreground text-xs">
							{bar.title}
						</span>
					)
					return (
						<li
							key={bar.id}
							data-bar={bar.id}
							draggable={onMove ? true : undefined}
							onDragStart={
								onMove
									? (event) => {
											event.dataTransfer.setData('text/plain', bar.id)
											event.dataTransfer.effectAllowed = 'move'
										}
									: undefined
							}
							onKeyDown={
								onMove ? (event) => onBarKeyDown(event, bar) : undefined
							}
							aria-keyshortcuts={onMove ? 'ArrowLeft ArrowRight' : undefined}
							tabIndex={onMove && !rowHref ? 0 : undefined}
							className={cn(
								'absolute flex items-center overflow-hidden rounded bg-primary',
								onMove && 'cursor-grab',
							)}
							style={{
								top: (index.get(bar.id) ?? 0) * ROW_HEIGHT + 4,
								left: `${pct(clipStart(bar))}%`,
								width: `${width(bar)}%`,
								height: ROW_HEIGHT - 8,
							}}
						>
							{rowHref ? (
								<Link
									to={rowHref(bar.row)}
									className="flex h-full w-full items-center no-underline"
								>
									{content}
								</Link>
							) : (
								content
							)}
							<span className="sr-only">{label}</span>
						</li>
					)
				})}
			</ul>
			<p aria-live="polite" className="sr-only">
				{announcement}
			</p>
		</section>
	)
}
