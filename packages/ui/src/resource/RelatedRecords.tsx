/**
 * `<RelatedRecords>` — the inverse-reference panel a detail page shows under
 * the record: every entity that points *at* this row, as sections of rows
 *.
 *
 * The declaration already exists — an FK is `data.setFieldReference`, and read
 * backwards it says "the renewals of this customer". What was missing was the
 * render, so every app hand-wrote the nested load it could have derived. This
 * component takes the derived groups (core's `inverseReferences` walked by the
 * loader) and draws them; nothing here is per-app, and a relation added to the
 * spec five minutes ago appears with no wiring.
 *
 * Presentation only, like the rest of the resource library: the loader fetches
 * each group's rows and count. A group with no rows still renders — its heading
 * carries the honest `0`, because a section that vanishes when empty is
 * indistinguishable from a relation that was never declared. With *no* groups
 * at all the panel renders nothing: there is no relation to be silent about.
 */

import type { ReactNode } from 'react'
import { humanizeLabel } from '../fields/field-semantics.ts'
import type { ReferenceResolution } from '../fields/reference-context.tsx'
import { cn } from '../lib/cn.ts'
import { ReferenceManyCount } from './ReferenceManyCount.tsx'
import { ReferenceManyField } from './ReferenceManyField.tsx'
import type { IntrospectedResource, Row } from './resource-types.ts'

/** One inverse relation, resolved: the child resource, the rows of it that
 * point at this record, and how many there are in total. */
export interface RelatedGroup {
	/** The child resource's table name (`comment`). */
	resource: string
	/** Its human label, singular (`Comment`) — the noun the count is read with. */
	label: string
	/** The FK column on the child pointing back at this record. */
	fk: string
	/** The child's introspection, for the inferred columns. */
	introspection: IntrospectedResource
	/** The rows the loader read — capped, so possibly fewer than `count`. */
	rows: Row[]
	/** Total rows pointing here. Defaults to `rows.length` when unknown. */
	count?: number
	/** Batch-resolved FK display values for these rows. */
	references?: ReferenceResolution
}

export interface RelatedRecordsProps {
	groups: readonly RelatedGroup[]
	/** Panel heading; omit for none. */
	title?: ReactNode
	/** Columns each group's list renders (default 4) — a related list is a
	 * glance at the children, not the child's own page. */
	maxColumns?: number
	/**
	 * Per-row link target (the child's detail page). Omit → rows don't link.
	 *
	 * May return `undefined` for a child entity with no reachable page, which
	 * drops the link column for that section rather than rendering a link to
	 * nowhere. Decided per group from its first row, since every row of a group
	 * lives on the same page.
	 */
	rowHref?: (group: RelatedGroup, row: Row) => string | undefined
	/** Where the group's count links — the child list filtered to this record.
	 * Omit → the count renders as plain text. */
	listHref?: (group: RelatedGroup) => string | undefined
	linkComponent?: (props: {
		to: string
		children: ReactNode
		className?: string
	}) => ReactNode
	className?: string
}

/**
 * The columns a related list shows: visible, non-primary-key, and never the FK
 * that points back here (it holds the same value on every row, so it is the one
 * column guaranteed to say nothing), capped.
 */
export function relatedColumns(
	group: RelatedGroup,
	maxColumns: number,
): IntrospectedResource {
	const columns = group.introspection.columns
		.filter(
			(c) =>
				c.name !== group.introspection.primaryKey &&
				c.name !== group.fk &&
				c.meta?.hidden !== true,
		)
		.slice(0, maxColumns)
	return { ...group.introspection, columns }
}

/** A group's key — resource alone is not unique when two FKs on the same child
 * point here (`assigneeId` and `reporterId` both → user). */
const groupKey = (g: RelatedGroup): string => `${g.resource}.${g.fk}`

export function RelatedRecords({
	groups,
	title,
	maxColumns = 4,
	rowHref,
	listHref,
	linkComponent,
	className,
}: RelatedRecordsProps): ReactNode {
	if (groups.length === 0) return null

	// Two FKs from the same child are two different relations — "tasks I am
	// assigned" and "tasks I filed" — so the heading has to say which, or the
	// panel shows the same noun twice with different rows under it.
	const ambiguous = new Set(
		groups
			.map((g) => g.resource)
			.filter((name, i, all) => all.indexOf(name) !== i),
	)

	return (
		<section className={cn('space-y-6', className)}>
			{title ? (
				<h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
			) : null}
			{groups.map((group) => {
				const count = group.count ?? group.rows.length
				const to = listHref?.(group)
				const first = group.rows[0]
				const linkable =
					rowHref !== undefined &&
					first !== undefined &&
					(rowHref(group, first) ?? '') !== ''
				const heading = (
					<span className="flex items-baseline gap-2">
						<span>
							{group.label}
							{ambiguous.has(group.resource)
								? ` · ${humanizeLabel(group.fk)}`
								: ''}
						</span>
						<ReferenceManyCount
							count={count}
							label={group.label.toLowerCase()}
							className="font-normal"
							{...(to && linkComponent ? { to, linkComponent } : {})}
						/>
					</span>
				)
				return (
					<ReferenceManyField
						key={groupKey(group)}
						label={heading}
						reference={group.fk}
						resource={relatedColumns(group, maxColumns)}
						rows={group.rows}
						references={group.references}
						empty={`No ${group.label.toLowerCase()} records yet.`}
						{...(linkable && rowHref
							? { rowHref: (row: Row) => rowHref(group, row) ?? '' }
							: {})}
					/>
				)
			})}
		</section>
	)
}
