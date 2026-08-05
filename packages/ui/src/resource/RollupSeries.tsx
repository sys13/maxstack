/**
 * `<RollupSeries>` — renders a grouped rollup's series.
 *
 * A rollup is either a scalar (one number per row — a plain `<Field>` renders
 * that fine) or a **series**: a shopping list summed per ingredient, usage
 * metered per month, an estimated 1RM peak per week. This component is the second
 * case, and it is the piece that stops a grouped rollup rendering as `[object
 * Object]` in a table cell.
 *
 * ## Form
 *
 * One series, comparing magnitude across a handful of named groups, so: **bars,
 * one sequential hue, values labelled directly.** Deliberately *not* a line
 * chart even for a time bucket — the series is short (a declared `limit`, usually
 * ≤ 24 points) and often sparse, and a line between two months implies
 * continuity the data does not have.
 *
 * A single series needs no legend: the caller's label names it. Values are
 * labelled on every bar rather than on an axis, because with ≤ 24 short rows the
 * numbers *are* the content — the bars only rank them.
 *
 * ## Colour
 *
 * One hue, `#2a78d6` light / `#3987e5` dark, both validated against their surface
 * (lightness band, chroma floor, ≥ 3:1 contrast). Text never wears the series
 * colour: keys and values stay in text tokens, and the bar alone carries the
 * encoding.
 *
 * `emptyLabel` matters more than it looks. A rollup with no matching child rows
 * is a *legitimate* empty, and #170's honest-failure rule says a derived surface
 * must never render as a blank card that reads like a bug — so an empty series
 * says so in words.
 */

import { cn } from '../lib/cn.ts'

/** One bucket of a rollup series — the shape `groupRollupRows` produces. */
export interface RollupSeriesBucket {
	key: string | null
	value: number | null
}

export interface RollupSeriesProps {
	series: readonly RollupSeriesBucket[]
	/** Names the series (a single series carries no legend, so this is identity). */
	label?: string
	/**
	 * Format a bucket's value for display. Defaults to a locale number; pass a
	 * currency/unit formatter when the rollup's column has one.
	 */
	formatValue?: (value: number | null) => string
	/**
	 * Format a bucket's key. A bucketed rollup's key is an ISO timestamp, so the
	 * caller decides whether that reads as a month, a week, or a date.
	 */
	formatKey?: (key: string | null) => string
	/** Shown instead of the bars when the series is empty. */
	emptyLabel?: string
	className?: string
}

const defaultFormatValue = (value: number | null): string =>
	value === null ? '—' : value.toLocaleString()

const defaultFormatKey = (key: string | null): string => key ?? '—'

export function RollupSeries({
	series,
	label,
	formatValue = defaultFormatValue,
	formatKey = defaultFormatKey,
	emptyLabel = 'No data yet',
	className,
}: RollupSeriesProps) {
	// The bar scale spans 0 → max, so bar length reads as magnitude rather than as
	// a difference from an arbitrary floor. Negative values (a rollup over a
	// signed column) scale off the same max so their bars stay proportionate.
	const values = series.map((b) => Math.abs(b.value ?? 0))
	const max = values.length > 0 ? Math.max(...values) : 0

	if (series.length === 0) {
		return (
			<div className={cn('text-muted-foreground text-sm', className)}>
				{label ? (
					<span className="mr-1.5 font-medium text-foreground">{label}:</span>
				) : null}
				{emptyLabel}
			</div>
		)
	}

	return (
		<div className={cn('flex flex-col gap-1', className)}>
			{label ? (
				<div className="font-medium text-foreground text-sm">{label}</div>
			) : null}
			{/* A table, not a list of divs: a series IS tabular data, so the DOM says
			    so and a screen reader reads key/value pairs instead of bar widths. */}
			<table className="w-full border-separate border-spacing-0 text-sm">
				<caption className="sr-only">
					{label ?? 'Rollup series'} — {series.length} group
					{series.length === 1 ? '' : 's'}
				</caption>
				<tbody>
					{series.map((bucket) => {
						const magnitude = Math.abs(bucket.value ?? 0)
						// A null value has no bar at all — it is "no value", not zero.
						const pct =
							bucket.value === null || max === 0 ? 0 : (magnitude / max) * 100
						return (
							// A GROUP BY yields distinct keys within one owner's series, so
							// the key alone identifies the row — no index needed.
							<tr key={bucket.key ?? '\u2205'}>
								<th
									scope="row"
									className="max-w-[10rem] truncate py-0.5 pr-2 text-left font-normal text-muted-foreground"
									title={formatKey(bucket.key)}
								>
									{formatKey(bucket.key)}
								</th>
								<td className="w-full py-0.5">
									{/* Track recedes toward the surface; the bar carries the
									    encoding. Capped height keeps the mark thin, and the
									    data-end is rounded while the baseline stays square. */}
									<div className="h-2 w-full rounded-sm bg-muted">
										<div
											className="h-2 rounded-r-sm bg-[#2a78d6] dark:bg-[#3987e5]"
											style={{ width: `${pct}%` }}
										/>
									</div>
								</td>
								<td className="py-0.5 pl-2 text-right font-medium text-foreground tabular-nums">
									{formatValue(bucket.value)}
								</td>
							</tr>
						)
					})}
				</tbody>
			</table>
		</div>
	)
}

/**
 * Is this value a rollup series rather than a scalar? Used by the generic field
 * renderer, which sees `unknown` and has to decide how to render it.
 */
export function isRollupSeries(value: unknown): value is RollupSeriesBucket[] {
	return (
		Array.isArray(value) &&
		value.every(
			(b) =>
				typeof b === 'object' &&
				b !== null &&
				'key' in b &&
				'value' in b &&
				(typeof (b as RollupSeriesBucket).value === 'number' ||
					(b as RollupSeriesBucket).value === null),
		)
	)
}
