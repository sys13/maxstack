/**
 * `<SimpleList>` (Plan v5 task 40) — the card/mobile list variant, the
 * responsive fallback for `<ResourceList>`'s table. Same introspection + field
 * library, but each record renders as a stacked card (primary line + a few
 * secondary fields) rather than a table row. Which columns are primary/secondary
 * is inferred: the first visible text-ish column is the title, the next few are
 * shown as labeled lines. All overridable, but zero-config by default.
 */

import { type ReactNode, useMemo } from 'react'
import { Field } from '../fields/fields.tsx'
import {
	ReferenceProvider,
	type ReferenceResolution,
} from '../fields/reference-context.tsx'
import { cn } from '../lib/cn.ts'
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

export interface SimpleListProps {
	resource: IntrospectedResource
	rows: Row[]
	references?: ReferenceResolution
	columns?: ColumnOverrides
	/** Explicit title column (defaults to the first text-like visible column). */
	primaryField?: string
	/** How many secondary fields to show under the title (default 3). */
	secondaryLimit?: number
	rowHref?: (row: Row) => string
	linkComponent?: LinkLike
	emptyState?: ReactNode
	className?: string
}

export function SimpleList({
	resource,
	rows,
	references,
	columns = {},
	primaryField,
	secondaryLimit = 3,
	rowHref,
	linkComponent,
	emptyState,
	className,
}: SimpleListProps) {
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

	const visibleNames = visibleCols.map((c) => c.name)
	const primary = pickPrimary(resource, visibleNames, primaryField)
	const secondary = visibleCols
		.filter((c) => c.name !== primary)
		.slice(0, secondaryLimit)

	if (rows.length === 0) {
		return (
			<div className={className}>
				{emptyState ?? <p className="text-muted-foreground">No records yet.</p>}
			</div>
		)
	}

	const primaryCol = visibleCols.find((c) => c.name === primary)

	return (
		<ReferenceProvider value={references ?? {}}>
			<ul className={cn('flex flex-col gap-2', className)}>
				{rows.map((row) => {
					const id = String(row[pk])
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
						<div className="rounded-lg border border-border p-3 hover:bg-muted/30">
							<div className="font-medium">{titleNode}</div>
							{secondary.length > 0 ? (
								<dl className="mt-1 flex flex-col gap-0.5 text-sm text-muted-foreground">
									{secondary.map((c) => {
										const ov = normalizeOverride(columns[c.name])
										return (
											<div key={c.name} className="flex gap-2">
												<dt className="min-w-24 shrink-0 text-xs uppercase tracking-wide">
													{ov.label ?? c.meta?.label ?? c.name}
												</dt>
												<dd className="text-foreground">
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
						</div>
					)
					return (
						<li key={id}>
							{rowHref ? (
								<Link to={rowHref(row)} className="block">
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
