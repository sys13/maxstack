/**
 * Dashboard widgets (Plan v5 task 49) — thin presentation over the task-47
 * aggregate hooks. `<CountWidget>` shows a resource's record count (optionally
 * filtered), `<AggregateWidget>` a sum/avg/min/max over a column, and
 * `<RecentActivity>` the newest records via `useList`. Each is a self-contained
 * card that fetches its own data, so a dashboard is a handful of these dropped in
 * a grid — no hand-wired loaders. They degrade gracefully: a provider without
 * aggregate support renders a muted "unavailable" instead of crashing.
 */

import type { ReactNode } from 'react'
import { useAggregate, useCount } from '../data/custom.ts'
import type { GetListParams } from '../data/data-provider.ts'
import { useList } from '../data/hooks.ts'
import type { AggregateOp } from '../data/memory-provider.ts'
import { cn } from '../lib/cn.ts'
import type { Row } from '../resource/resource-types.ts'

const CARD =
	'rounded-lg border border-border p-4 flex flex-col gap-1 bg-card text-card-foreground'
const LABEL =
	'text-xs font-medium uppercase tracking-wide text-muted-foreground'
const VALUE = 'text-2xl font-semibold tabular-nums'

/** A metric card shell — used by the stat widgets and reusable for a custom one. */
export function StatCard({
	label,
	value,
	hint,
	loading,
	className,
}: {
	label: string
	value: ReactNode
	hint?: ReactNode
	loading?: boolean
	className?: string
}) {
	return (
		<div className={cn(CARD, className)}>
			<span className={LABEL}>{label}</span>
			<span className={VALUE}>
				{loading ? (
					<span
						className="inline-block h-7 w-16 animate-pulse rounded bg-muted"
						data-testid="stat-skeleton"
					/>
				) : (
					value
				)}
			</span>
			{hint ? (
				<span className="text-sm text-muted-foreground">{hint}</span>
			) : null}
		</div>
	)
}

export interface CountWidgetProps {
	resource: string
	label?: string
	filter?: GetListParams
	hint?: ReactNode
	className?: string
}

export function CountWidget({
	resource,
	label,
	filter,
	hint,
	className,
}: CountWidgetProps) {
	const { data, isLoading, error } = useCount(resource, filter)
	return (
		<StatCard
			label={label ?? `${resource} count`}
			loading={isLoading && !error}
			value={
				error ? (
					<span className="text-base font-normal text-muted-foreground">
						unavailable
					</span>
				) : (
					(data ?? 0).toLocaleString()
				)
			}
			hint={hint}
			className={className}
		/>
	)
}

export interface AggregateWidgetProps {
	resource: string
	op: AggregateOp
	field: string
	label?: string
	filter?: GetListParams
	/** Format the numeric result (e.g. currency). Defaults to a localized number. */
	format?: (value: number) => string
	hint?: ReactNode
	className?: string
}

export function AggregateWidget({
	resource,
	op,
	field,
	label,
	filter,
	format,
	hint,
	className,
}: AggregateWidgetProps) {
	const { data, isLoading, error } = useAggregate(resource, op, field, filter)
	const fmt = format ?? ((n: number) => n.toLocaleString())
	return (
		<StatCard
			label={label ?? `${op} of ${field}`}
			loading={isLoading && !error}
			value={
				error ? (
					<span className="text-base font-normal text-muted-foreground">
						unavailable
					</span>
				) : (
					fmt(data ?? 0)
				)
			}
			hint={hint}
			className={className}
		/>
	)
}

export interface RecentActivityProps {
	resource: string
	/** Timestamp column to sort by (default `createdAt`). */
	dateField?: string
	/** How many rows to show (default 5). */
	limit?: number
	/** Render one row's primary line (default: its `dateField` + id). */
	renderItem?: (row: Row) => ReactNode
	label?: string
	className?: string
}

export function RecentActivity({
	resource,
	dateField = 'createdAt',
	limit = 5,
	renderItem,
	label,
	className,
}: RecentActivityProps) {
	const { data, isLoading } = useList<Row>(resource, {
		sort: { field: dateField, order: 'desc' },
		pagination: { page: 1, perPage: limit },
	})
	const rows = data ?? []
	return (
		<div className={cn(CARD, className)}>
			<span className={LABEL}>{label ?? `Recent ${resource}`}</span>
			{isLoading ? (
				<span
					className="mt-1 inline-block h-16 w-full animate-pulse rounded bg-muted"
					data-testid="recent-skeleton"
				/>
			) : rows.length === 0 ? (
				<span className="text-sm text-muted-foreground">No activity yet.</span>
			) : (
				<ul className="mt-1 flex flex-col gap-1 text-sm">
					{rows.map((row, i) => (
						<li
							// biome-ignore lint/suspicious/noArrayIndexKey: rows lack a guaranteed stable key here; order is the identity
							key={i}
							className="flex justify-between gap-2 border-border/50 border-b pb-1 last:border-0"
						>
							{renderItem ? (
								renderItem(row)
							) : (
								<>
									<span className="truncate">{String(row.id ?? '')}</span>
									<span className="shrink-0 text-muted-foreground">
										{String(row[dateField] ?? '')}
									</span>
								</>
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	)
}
