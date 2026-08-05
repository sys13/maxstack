/**
 * `<CardGrid>` — the `cards` block variant: a responsive grid of
 * record cards over the same introspection + field library the table uses.
 * Zero-config: the title/secondary columns are inferred (`pick-fields.ts`),
 * everything overridable. This is what a spec page renders when a
 * `page.setBlockVariant {variant:"cards"}` op lands — a designed-looking list
 * with no slot or eject.
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
import { pickPrimary } from './pick-fields.ts'
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

export interface CardGridProps {
	resource: IntrospectedResource
	rows: Row[]
	references?: ReferenceResolution
	columns?: ColumnOverrides
	/** Explicit title column (defaults to the first text-like visible column). */
	primaryField?: string
	/** How many secondary fields to show per card (default 3). Ignored when
	 * `secondaryFields` is given — an explicit selection is never truncated. */
	secondaryLimit?: number
	/**
	 * Explicit secondary columns, in order — what the spec's
	 * `page.setBlockFields` selection grounds to, so every named
	 * field renders instead of the first three visible ones. The title column is
	 * skipped (it has its own slot).
	 */
	secondaryFields?: string[]
	rowHref?: (row: Row) => string
	/**
	 * Label for the per-card edit affordance (default "Edit"), matching
	 * `<ResourceList rowActionLabel>`. The whole card is already the link, so
	 * this renders as styled text rather than a nested anchor — an `<a>` inside
	 * an `<a>` is invalid and the browser unnests it. Pass `null` to drop it
	 * (a bespoke `renderRow` owns its own affordances and never sees this).
	 */
	rowActionLabel?: string | null
	linkComponent?: LinkLike
	loading?: boolean
	skeletonCards?: number
	/** Shown when there are no rows and not loading. */
	emptyState?: ReactNode
	/**
	 * Bespoke card body — the block-level `<resource>__row` slot.
	 * The grid keeps its layout, ordering, empty state and row links; only the
	 * card's contents are the user's. A component rather than a render function
	 * so a slot can hold state (a flip animation, a keyboard grader).
	 */
	renderRow?: ComponentType<RowSlotProps>
	/** Primary keys created by the demo seeder — surfaced to `renderRow` as
	 * `isDemo` so a bespoke card can still mark sample data. */
	demoIds?: readonly string[]
	className?: string
}

export function CardGrid({
	resource,
	rows,
	references,
	columns = {},
	primaryField,
	secondaryLimit = 3,
	secondaryFields,
	rowHref,
	rowActionLabel = 'Edit',
	linkComponent,
	loading = false,
	skeletonCards = 6,
	emptyState,
	renderRow: RenderRow,
	demoIds,
	className,
}: CardGridProps) {
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
	const primaryCol = visibleCols.find((c) => c.name === primary)
	const secondary = secondaryFields
		? secondaryFields
				.filter((n) => n !== primary)
				.map((n) => visibleCols.find((c) => c.name === n))
				.filter((c) => c !== undefined)
		: visibleCols.filter((c) => c.name !== primary).slice(0, secondaryLimit)

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

	const gridClass = cn('grid gap-4 sm:grid-cols-2 lg:grid-cols-3', className)

	if (loading) {
		return (
			<ul className={gridClass} aria-hidden>
				{Array.from({ length: skeletonCards }).map((_, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: skeleton cards are positional and static
					<li key={i} data-testid="skeleton-card">
						<div className="rounded-lg border border-border bg-card p-4">
							<span className="block h-5 w-32 animate-pulse rounded bg-muted" />
							<span className="mt-3 block h-4 w-24 animate-pulse rounded bg-muted" />
						</div>
					</li>
				))}
			</ul>
		)
	}

	return (
		<ReferenceProvider value={references ?? {}}>
			<ul className={gridClass}>
				{rows.map((row) => {
					const id = String(row[pk])
					if (RenderRow) {
						// The card body is the user's; the grid cell and its link are not.
						const bespoke = (
							<RenderRow
								resource={resource}
								columns={visibleCols}
								row={row}
								href={rowHref ? rowHref(row) : ''}
								isDemo={demoSet.has(id)}
							/>
						)
						return (
							<li key={id}>
								{rowHref ? (
									<Link to={rowHref(row)} className="block h-full">
										{bespoke}
									</Link>
								) : (
									bespoke
								)}
							</li>
						)
					}
					const override = primary ? normalizeOverride(columns[primary]) : {}
					const titleNode =
						primaryCol &&
						(override.render ? (
							override.render({
								value: row[primary as string],
								row,
								column: primaryCol,
							})
						) : (
							<Field value={row[primary as string]} column={primaryCol} />
						))
					const card = (
						<div className="flex h-full flex-col gap-2 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-sm transition-colors hover:border-ring/40 hover:bg-accent/40">
							<div className="font-medium leading-snug">{titleNode}</div>
							{secondary.length > 0 ? (
								<dl className="mt-auto flex flex-col gap-1 text-sm text-muted-foreground">
									{secondary.map((c) => {
										const ov = normalizeOverride(columns[c.name])
										return (
											<div key={c.name} className="flex items-baseline gap-2">
												<dt className="shrink-0 text-xs uppercase tracking-wide">
													{ov.label ?? c.meta?.label ?? c.name}
												</dt>
												<dd className="truncate text-foreground">
													{ov.render ? (
														ov.render({ value: row[c.name], row, column: c })
													) : (
														<Field value={row[c.name]} column={c} />
													)}
												</dd>
											</div>
										)
									})}
								</dl>
							) : null}
							{/* The table variant carries a per-row "Edit" link; without one
							    here, switching a block to `cards` — a cosmetic op — silently
							    took away the only visible route to editing a record
. The card is already the link, so this is the
							    affordance, not a second target. */}
							{rowHref && rowActionLabel ? (
								<span
									className={cn(
										'pt-1 text-sm font-medium text-primary',
										// The secondary list already claims the spare space; with
										// no list the label has to claim it or it floats up under
										// the title.
										secondary.length === 0 && 'mt-auto',
									)}
								>
									{rowActionLabel}
								</span>
							) : null}
						</div>
					)
					return (
						<li key={id}>
							{rowHref ? (
								<Link to={rowHref(row)} className="block h-full">
									{card}
								</Link>
							) : (
								card
							)}
						</li>
					)
				})}
			</ul>
		</ReferenceProvider>
	)
}
