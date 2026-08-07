/**
 * `<AggregateView>` — an `aggregate` block's grouped measure (#299).
 *
 * The first block that draws a **number per group** rather than a row per row.
 * Every dashboard tile in a business app is this shape — tickets by status,
 * revenue by segment, signups per month — and until now every one of them was
 * owned code, because nothing in the block vocabulary could say `GROUP BY`.
 *
 * ## It takes resolved buckets, and that is a security property
 *
 * This component never fetches. The aggregate is computed server-side by
 * `opAggregate`, under a list's permission check, tenant scope and soft-delete
 * scope, and arrives here as data. The client-side widgets in `dashboard/` are
 * the *wrong* consumers for a spec-declared aggregate for exactly this reason:
 * a hook that queries would be a second read path with a second access story,
 * and a count that leaks across a tenant boundary is a security bug whether it
 * is drawn as a bar or as a table.
 *
 * ## Form
 *
 * One series over a handful of named groups, so bars with values labelled
 * directly — the same form, colour and reasoning as `<RollupSeries>`, which
 * this delegates to rather than re-deriving. `display: 'table'` is the same
 * data with the bucket's **row count** beside the measure, which is the column
 * an `avg` needs to be readable: an average of 9.8 over two rows and over two
 * thousand are different claims, and a bar cannot tell them apart.
 *
 * An empty result says so in words. A grouped read that matched nothing is a
 * legitimate empty, and #170's honest-failure rule is that a derived surface
 * must never render as a blank card that reads like a bug.
 */

import { cn } from '../lib/cn.ts'
import { RollupSeries } from './RollupSeries.tsx'

/** One resolved bucket — structurally `AggregateBucket` from the core store. */
export interface AggregateViewBucket {
	/** The dimension's value; `null` is the "no value" bucket, not an error. */
	key: string | null
	value: number | null
	/** Rows in the bucket — the denominator an average needs. */
	count: number
}

/** A dimension's declared value list, when it has one. */
export interface AggregateViewOption {
	value: string
	label?: string
}

export interface AggregateViewProps {
	buckets: readonly AggregateViewBucket[]
	/** The dimension's field name — names the axis. */
	groupField: string
	/** The aggregate function, so the caption can say what the number is. */
	fn: 'count' | 'countDistinct' | 'sum' | 'avg' | 'min' | 'max'
	/** The measured field name, for every `fn` but `count`. */
	measureField?: string
	/** Set when the dimension is a date: the period each bucket spans. */
	bucket?: 'day' | 'week' | 'month' | 'quarter' | 'year'
	/** The dimension's declared options, used to label the keys. */
	options?: readonly AggregateViewOption[] | null
	display?: 'bar' | 'table'
	className?: string
}

/** `openedAt` → `Opened at`; `status` → `Status`. */
function humanize(name: string): string {
	const spaced = name
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/[_-]/g, ' ')
	return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase()
}

/** What the number in each bucket *is*, in words — the chart's whole caption. */
export function aggregateLabel(
	fn: AggregateViewProps['fn'],
	measureField: string | undefined,
): string {
	if (fn === 'count') return 'Records'
	const measure = humanize(measureField ?? '')
	if (fn === 'countDistinct') return `Distinct ${measure.toLowerCase()}`
	const verb = { sum: 'Total', avg: 'Average', min: 'Lowest', max: 'Highest' }[
		fn
	]
	return `${verb} ${measure.toLowerCase()}`
}

/**
 * How wide a period is, in months — used to pick the date format.
 *
 * A `day` bucket wants a date, a `month` bucket wants "Mar 2026", and a `year`
 * bucket wants a year. Rendering all three as a full timestamp is what makes a
 * time series unreadable, and rendering all three as a year makes it wrong.
 */
const PERIOD_FORMAT: Record<
	NonNullable<AggregateViewProps['bucket']>,
	Intl.DateTimeFormatOptions
> = {
	day: { year: 'numeric', month: 'short', day: 'numeric' },
	week: { year: 'numeric', month: 'short', day: 'numeric' },
	month: { year: 'numeric', month: 'short' },
	quarter: { year: 'numeric', month: 'short' },
	year: { year: 'numeric' },
}

/**
 * Render one bucket's key.
 *
 * Three cases, in the order they have to be tried: a date bucket is an ISO
 * instant and reads as its period; a declared option carries a label; and a
 * boolean column arrives as the strings Postgres produced, which are `true` and
 * `false` and mean nothing to a reader.
 *
 * `null` is a **real bucket** — the rows where the dimension has no value — and
 * it says so rather than rendering blank, because an unlabelled bar is
 * indistinguishable from a rendering bug.
 */
export function aggregateKeyLabel(
	key: string | null,
	bucket: AggregateViewProps['bucket'],
	options: readonly AggregateViewOption[] | null | undefined,
): string {
	if (key === null) return 'Not set'
	if (bucket) {
		const at = new Date(key)
		if (!Number.isNaN(at.getTime()))
			// UTC, because the key is a `date_trunc` boundary: rendering it in the
			// viewer's zone shifts a month bucket into the previous month for
			// everybody west of UTC, which relabels every bar in the chart.
			return at.toLocaleDateString(undefined, {
				...PERIOD_FORMAT[bucket],
				timeZone: 'UTC',
			})
		return key
	}
	const option = options?.find((o) => o.value === key)
	if (option) return option.label ?? option.value
	if (key === 'true') return 'Yes'
	if (key === 'false') return 'No'
	return key
}

const formatNumber = (value: number | null): string =>
	value === null
		? '—'
		: // A whole number stays whole; an average keeps one decimal, which is as
			// much precision as a bar chart can honestly claim.
			Number.isInteger(value)
			? value.toLocaleString()
			: value.toLocaleString(undefined, { maximumFractionDigits: 1 })

export function AggregateView({
	buckets,
	groupField,
	fn,
	measureField,
	bucket,
	options,
	display = 'bar',
	className,
}: AggregateViewProps) {
	const measureLabel = aggregateLabel(fn, measureField)
	const caption = `${measureLabel} by ${humanize(groupField).toLowerCase()}`
	const formatKey = (key: string | null) =>
		aggregateKeyLabel(key, bucket, options)

	if (buckets.length === 0)
		return (
			<div className={cn('text-muted-foreground text-sm', className)}>
				<span className="mr-1.5 font-medium text-foreground">{caption}:</span>
				No records to summarise yet.
			</div>
		)

	if (display === 'table')
		return (
			<table
				className={cn(
					'w-full border-separate border-spacing-0 text-sm',
					className,
				)}
			>
				<caption className="mb-1 text-left font-medium text-foreground">
					{caption}
				</caption>
				<thead>
					<tr className="text-muted-foreground">
						<th scope="col" className="py-1 pr-2 text-left font-normal">
							{humanize(groupField)}
						</th>
						<th scope="col" className="py-1 pr-2 text-right font-normal">
							{measureLabel}
						</th>
						<th scope="col" className="py-1 text-right font-normal">
							Records
						</th>
					</tr>
				</thead>
				<tbody>
					{buckets.map((b) => (
						// A GROUP BY yields distinct keys, so the key alone identifies the
						// row — and the null bucket gets a key no value can collide with.
						<tr key={b.key ?? '∅'}>
							<th
								scope="row"
								className="max-w-[14rem] truncate py-0.5 pr-2 text-left font-normal"
							>
								{formatKey(b.key)}
							</th>
							<td className="py-0.5 pr-2 text-right font-medium tabular-nums">
								{formatNumber(b.value)}
							</td>
							<td className="py-0.5 text-right text-muted-foreground tabular-nums">
								{b.count.toLocaleString()}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		)

	return (
		<RollupSeries
			className={className}
			series={buckets.map((b) => ({ key: b.key, value: b.value }))}
			label={caption}
			formatKey={formatKey}
			formatValue={formatNumber}
		/>
	)
}
