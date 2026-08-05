/**
 * `<FeedList>` — the `feed` block variant: a single-column stack
 * of title / description / date entries, the reading-list presentation. The
 * description column is inferred (first markdown/richtext, else a prose-named
 * text column, else the first non-title text column — see `pick-fields.ts`)
 * and clamped; the timestamp is the first date column.
 *
 * Entries also carry a **meta row** of at-a-glance columns (status, rating,
 * counts). Issue #142: a reviews feed that renders title/author/date and hides
 * the stars is missing the content of the app, and "also show two more fields"
 * should never cost a hand-written component. Pass `secondaryFields` (what
 * `page.setBlockFields` grounds to) to say exactly which; otherwise they are
 * inferred. Zero-config, all overridable.
 */

import { type ComponentType, type ReactNode, useMemo } from 'react'
import { Field } from '../fields/fields.tsx'
import {
	ReferenceProvider,
	type ReferenceResolution,
} from '../fields/reference-context.tsx'
import { cn } from '../lib/cn.ts'
import type { RowSlotProps } from '../slots/block-slots.ts'
import { addTheFirst, EmptyState } from './EmptyState.tsx'
import {
	pickDate,
	pickDescription,
	pickPrimary,
	pickSecondary,
} from './pick-fields.ts'
import {
	type ColumnOverrides,
	type IntrospectedResource,
	normalizeOverride,
	type Row,
} from './resource-types.ts'

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

export interface FeedListProps {
	resource: IntrospectedResource
	rows: Row[]
	references?: ReferenceResolution
	columns?: ColumnOverrides
	/** Explicit title column (defaults to the first text-like visible column). */
	primaryField?: string
	/** Explicit description column (defaults to the first prose-ish column). */
	descriptionField?: string
	/** Explicit timestamp column (defaults to the first date column). */
	dateField?: string
	/**
	 * Explicit meta-row columns, in order — the spec's `page.setBlockFields`
	 * selection grounds to this, so every named field is guaranteed to render.
	 * Names already used as the title/description/date are skipped (they are
	 * shown in their own slot, not twice). Defaults to the inferred
	 * enum/number/rating/boolean columns, capped at `secondaryLimit`.
	 */
	secondaryFields?: string[]
	/** How many *inferred* meta columns to show (default 3). Ignored when
	 * `secondaryFields` is given — an explicit selection is never truncated. */
	secondaryLimit?: number
	rowHref?: (row: Row) => string
	linkComponent?: LinkLike
	loading?: boolean
	skeletonRows?: number
	/** Shown when there are no rows and not loading. */
	emptyState?: ReactNode
	/**
	 * Bespoke entry body — the block-level `<resource>__row` slot.
	 * The feed keeps its stack, dividers, ordering, empty state and entry links;
	 * only the entry's contents are the user's. A component rather than a render
	 * function so a slot can hold state.
	 */
	renderRow?: ComponentType<RowSlotProps>
	/** Primary keys created by the demo seeder — surfaced to `renderRow` as
	 * `isDemo` so a bespoke entry can still mark sample data. */
	demoIds?: readonly string[]
	className?: string
}

export function FeedList({
	resource,
	rows,
	references,
	columns = {},
	primaryField,
	descriptionField,
	dateField,
	secondaryFields,
	secondaryLimit = 3,
	rowHref,
	linkComponent,
	loading = false,
	skeletonRows = 5,
	emptyState,
	renderRow: RenderRow,
	demoIds,
	className,
}: FeedListProps) {
	const Link = linkComponent ?? DefaultLink
	const pk = resource.primaryKey

	const visibleCols = useMemo(() => {
		return resource.columns.filter((column) => {
			const override = normalizeOverride(columns[column.name])
			const isPk = column.name === pk
			const hidden = override.hidden ?? (column.meta?.hidden === true || isPk)
			return !hidden
		})
	}, [resource, columns, pk])

	const demoSet = useMemo(() => new Set(demoIds ?? []), [demoIds])

	const visibleNames = visibleCols.map((c) => c.name)
	const primary = pickPrimary(resource, visibleNames, primaryField)
	const description = pickDescription(
		resource,
		visibleNames,
		primary,
		descriptionField,
	)
	const date = pickDate(resource, visibleNames, dateField)
	const used = [primary, description, date]
	const secondary = secondaryFields
		? secondaryFields.filter(
				(n) => visibleNames.includes(n) && !used.includes(n),
			)
		: pickSecondary(resource, visibleNames, used, secondaryLimit)
	const colOf = (name: string | undefined) =>
		name === undefined ? undefined : visibleCols.find((c) => c.name === name)

	if (!loading && rows.length === 0) {
		return (
			<div className={className}>
				{emptyState ?? (
					<EmptyState
						title="No records yet"
						description={addTheFirst(resource)}
					/>
				)}
			</div>
		)
	}

	if (loading) {
		return (
			<ul
				className={cn('flex flex-col divide-y divide-border', className)}
				aria-hidden
			>
				{Array.from({ length: skeletonRows }).map((_, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: skeleton rows are positional and static
					<li key={i} className="py-4" data-testid="skeleton-entry">
						<span className="block h-5 w-48 animate-pulse rounded bg-muted" />
						<span className="mt-2 block h-4 w-72 animate-pulse rounded bg-muted" />
					</li>
				))}
			</ul>
		)
	}

	const renderCol = (name: string | undefined, row: Row): ReactNode => {
		const col = colOf(name)
		if (!name || !col) return null
		const ov = normalizeOverride(columns[name])
		return ov.render ? (
			ov.render({ value: row[name], row, column: col })
		) : (
			<Field value={row[name]} column={col} />
		)
	}

	return (
		<ReferenceProvider value={references ?? {}}>
			<ul className={cn('flex flex-col divide-y divide-border', className)}>
				{rows.map((row) => {
					const id = String(row[pk])
					const entry = RenderRow ? (
						<RenderRow
							resource={resource}
							columns={visibleCols}
							row={row}
							href={rowHref ? rowHref(row) : ''}
							isDemo={demoSet.has(id)}
						/>
					) : (
						<article className="flex flex-col gap-1 py-4">
							<h3 className="font-medium leading-snug">
								{renderCol(primary, row)}
							</h3>
							{secondary.length > 0 ? (
								<dl
									className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm"
									data-testid="entry-meta"
								>
									{secondary.map((name) => {
										const col = colOf(name)
										if (!col) return null
										const ov = normalizeOverride(columns[name])
										return (
											<div key={name} className="flex items-baseline gap-1.5">
												<dt className="text-xs uppercase tracking-wide text-muted-foreground">
													{ov.label ?? col.meta?.label ?? name}
												</dt>
												<dd className="text-foreground">
													{renderCol(name, row)}
												</dd>
											</div>
										)
									})}
								</dl>
							) : null}
							{description ? (
								<div className="line-clamp-2 text-sm text-muted-foreground">
									{renderCol(description, row)}
								</div>
							) : null}
							{date ? (
								<div className="text-xs text-muted-foreground">
									{renderCol(date, row)}
								</div>
							) : null}
						</article>
					)
					return (
						<li key={id}>
							{rowHref ? (
								<Link
									to={rowHref(row)}
									className="block transition-colors hover:bg-accent/40"
								>
									{entry}
								</Link>
							) : (
								entry
							)}
						</li>
					)
				})}
			</ul>
		</ReferenceProvider>
	)
}
