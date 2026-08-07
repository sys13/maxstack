/**
 * `<ListControls>` — the control bar a list surface gets *by default*: search,
 * the derived filter facets, and CSV export.
 *
 * ## Why this exists rather than more JSX in a route
 *
 * Every part of it already shipped (`<FilterForm>`, `filterable.ts`, `csv.ts`)
 * and was mounted only on `/admin` and the workbench — the two surfaces a
 * generated app's users never see. Issue #342: the generated Books page's
 * entire control surface was two nav links, "+ New" and "Edit". Composing the
 * bar once, here, is what lets the generic project page and an *ejected* page
 * mount the identical thing: the route renders this and hands the element down
 * as `OwnedRouteProps.toolbar`, so taking ownership of a page does not silently
 * cost you its search box.
 *
 * ## Controlled, and router-free
 *
 * `value`/`onChange` in the same `FilterValues` shape `filter-params.ts`
 * encodes to the URL, so the caller owns the state and a filtered list stays
 * shareable. This package never imports a router.
 *
 * ## Export is what is on screen
 *
 * The button serializes the `rows` it was handed — the page the loader already
 * fetched, under the same filters, and therefore under the same read policy,
 * tenant scope and portal bound `opList` enforced to produce them. It is
 * deliberately not a "download everything" endpoint: that would be a second
 * read path with its own limit to get wrong, and a bulk read is exactly where
 * getting it wrong matters most. What you see is what you export.
 */

import { useMemo } from 'react'
import type { ReferenceResolution } from '../fields/reference-context.tsx'
import { cn } from '../lib/cn.ts'
import { downloadCsv, resourceToCsv } from './csv.ts'
import { FilterForm } from './FilterForm.tsx'
import {
	activeFilterCount,
	deriveFacets,
	type FacetOption,
	type FilterValues,
	searchableFields,
} from './filterable.ts'
import type { IntrospectedResource, Row } from './resource-types.ts'

export interface ListControlsProps {
	/**
	 * The resource *as this page shows it* — the visible columns, not the whole
	 * table. Search fields, facets and the exported columns are all derived from
	 * it, so a page cannot offer a control over a column it does not render.
	 */
	resource: IntrospectedResource
	/** The rows on screen — what "Export CSV" writes. */
	rows: Row[]
	value: FilterValues
	onChange: (next: FilterValues) => void
	/** Resolved FK titles, so an exported reference column reads as its title. */
	references?: ReferenceResolution
	/** Choice lists for reference facets, resolved server-side. */
	referenceOptions?: Record<string, FacetOption[]>
	/** File-name stem for the export (defaults to the resource name). */
	exportName?: string
	className?: string
}

const BAR_BUTTON =
	'inline-flex h-9 items-center rounded-md border border-border bg-background px-3 text-sm font-medium shadow-sm hover:bg-muted disabled:pointer-events-none disabled:opacity-50'

export function ListControls({
	resource,
	rows,
	value,
	onChange,
	references,
	referenceOptions,
	exportName,
	className,
}: ListControlsProps) {
	// Whether there is anything to control. A resource with no text column and no
	// facetable column would render an empty `<search>` element and a stray
	// button — a control bar that controls nothing is worse than none, so the
	// export button carries the bar alone in that case.
	const hasFilters = useMemo(
		() =>
			searchableFields(resource).length > 0 ||
			deriveFacets(resource, referenceOptions ?? {}).length > 0,
		[resource, referenceOptions],
	)
	const name = exportName ?? resource.name

	return (
		<div className={cn('mb-4 flex flex-wrap items-end gap-3', className)}>
			{hasFilters ? (
				<FilterForm
					resource={resource}
					value={value}
					onChange={onChange}
					referenceOptions={referenceOptions}
					className="flex-1"
				/>
			) : null}
			<button
				type="button"
				className={cn(BAR_BUTTON, hasFilters ? '' : 'ml-auto')}
				// Nothing to write, and a CSV of headers alone reads as a broken
				// export rather than an empty list.
				disabled={rows.length === 0}
				onClick={() =>
					downloadCsv(
						// A filtered export says so in its file name: two downloads of
						// `books.csv` holding different row sets is how a spreadsheet ends
						// up being the wrong one.
						activeFilterCount(value) > 0
							? `${name}-filtered.csv`
							: `${name}.csv`,
						resourceToCsv(resource, rows, { references }),
					)
				}
			>
				Export CSV
			</button>
		</div>
	)
}
