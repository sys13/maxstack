/**
 * `<ReferenceManyField>` — the reverse of an FK: a parent record's children
 * rendered as an inline `<ResourceList>` (Plan v5 task 32). On a story detail
 * page it shows that story's comments; on a user page, their posts.
 *
 * Presentation only — the loader fetches the children (`store.list(child, {
 * filter: { [reference]: parentId } })`, the equality filter task 32 added) and
 * hands them in as `rows`. The FK column that points back at the parent is
 * hidden by default (it's the same value on every child row, so it's noise).
 */

import type { ReactNode } from 'react'
import { ResourceList, type ResourceListProps } from './ResourceList.tsx'

export interface ReferenceManyFieldProps extends ResourceListProps {
	/** Section heading (e.g. "Comments"). */
	label?: ReactNode
	/** The child column that references the parent; hidden by default. */
	reference?: string
	/** Shown when the record has no children. */
	empty?: ReactNode
}

export function ReferenceManyField({
	label,
	reference,
	empty,
	columns = {},
	emptyState,
	...listProps
}: ReferenceManyFieldProps) {
	// Hide the back-reference column unless the caller overrode it — every row
	// carries the same parent id, so it adds nothing to an inline list.
	const mergedColumns =
		reference && columns[reference] === undefined
			? { ...columns, [reference]: { hidden: true } }
			: columns

	return (
		<section className="space-y-2">
			{label ? (
				<h3 className="text-sm font-medium text-muted-foreground">{label}</h3>
			) : null}
			<ResourceList
				{...listProps}
				columns={mergedColumns}
				emptyState={emptyState ?? empty}
			/>
		</section>
	)
}
