/**
 * `<FilterForm>` — a list's filter bar, inferred from introspection (Plan v5
 * task 34). It renders a text search over the resource's string columns and one
 * control per derived facet — a dropdown (enum / reference / boolean) or a
 * min/max pair (`number` / `date` range) — with a "Clear" that appears once
 * anything is active. It is *controlled* — `value` in, `onChange`
 * out — so a route owns the state and syncs it to the URL (`filter-params.ts`),
 * keeping a filtered list shareable and this component router-free.
 *
 * Zero hand-written filter code: `deriveFacets` decides what to show from the
 * same metadata the field library reads. Reference facets need their option
 * list resolved server-side (the referenced records); pass it as
 * `referenceOptions` — everything else comes from the schema.
 */

import { useMemo } from 'react'
import { cn } from '../lib/cn.ts'
import { Input, Label } from '../ui/primitives.tsx'
import {
	activeFilterCount,
	deriveFacets,
	type Facet,
	type FacetOption,
	type FilterValues,
	type RangeValue,
	searchableFields,
} from './filterable.ts'
import type { IntrospectedResource } from './resource-types.ts'

export interface FilterFormProps {
	resource: IntrospectedResource
	value: FilterValues
	onChange: (next: FilterValues) => void
	/** Choice lists for reference (FK) facets, keyed by column name — resolved
	 * server-side since they require a fetch. */
	referenceOptions?: Record<string, FacetOption[]>
	/** Placeholder for the search box; defaults to naming the searched columns. */
	searchPlaceholder?: string
	className?: string
}

const CONTROL_CLASS =
	'h-9 rounded-md border border-border bg-background px-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring'

export function FilterForm({
	resource,
	value,
	onChange,
	referenceOptions = {},
	searchPlaceholder,
	className,
}: FilterFormProps) {
	const facets = useMemo(
		() => deriveFacets(resource, referenceOptions),
		[resource, referenceOptions],
	)
	const searchable = useMemo(() => searchableFields(resource), [resource])
	const active = activeFilterCount(value)

	function setSearch(search: string) {
		onChange({ ...value, search: search || undefined })
	}
	function setFacet(name: string, selected: string) {
		const filter = { ...value.filter }
		if (selected === '') delete filter[name]
		else filter[name] = selected
		onChange({ ...value, filter })
	}
	function setRange(name: string, bound: 'gte' | 'lte', next: string) {
		const range = { ...(value.range ?? {}) }
		const current: RangeValue = { ...range[name] }
		if (next === '') delete current[bound]
		else current[bound] = next
		if (current.gte == null && current.lte == null) delete range[name]
		else range[name] = current
		onChange({ ...value, range })
	}
	function clear() {
		onChange({ filter: {} })
	}

	const placeholder =
		searchPlaceholder ??
		(searchable.length > 0 ? `Search ${searchable.join(', ')}…` : 'Search…')

	return (
		<search className={cn('flex flex-wrap items-end gap-3', className)}>
			{searchable.length > 0 ? (
				<div className="flex flex-col gap-1">
					<Label
						htmlFor="filter-search"
						className="text-xs text-muted-foreground"
					>
						Search
					</Label>
					<Input
						id="filter-search"
						type="search"
						value={value.search ?? ''}
						placeholder={placeholder}
						onChange={(e) => setSearch(e.target.value)}
						className="h-9 w-56"
					/>
				</div>
			) : null}

			{facets.map((facet) =>
				facet.kind === 'range' ? (
					<RangeControl
						key={facet.name}
						facet={facet}
						value={value.range?.[facet.name] ?? {}}
						onChange={(bound, v) => setRange(facet.name, bound, v)}
					/>
				) : (
					<FacetControl
						key={facet.name}
						facet={facet}
						value={value.filter[facet.name] ?? ''}
						onChange={(v) => setFacet(facet.name, v)}
					/>
				),
			)}

			{active > 0 ? (
				<button
					type="button"
					onClick={clear}
					className="h-9 self-end rounded-md px-2 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
				>
					Clear{active > 1 ? ` (${active})` : ''}
				</button>
			) : null}
		</search>
	)
}

function FacetControl({
	facet,
	value,
	onChange,
}: {
	facet: Facet
	value: string
	onChange: (value: string) => void
}) {
	const controlId = `filter-${facet.name}`
	return (
		<div className="flex flex-col gap-1">
			<Label htmlFor={controlId} className="text-xs text-muted-foreground">
				{facet.label}
			</Label>
			{facet.kind === 'text' ? (
				<Input
					id={controlId}
					value={value}
					onChange={(e) => onChange(e.target.value)}
					className="h-9 w-40"
				/>
			) : (
				<select
					id={controlId}
					value={value}
					onChange={(e) => onChange(e.target.value)}
					disabled={facet.options.length === 0}
					className={cn(CONTROL_CLASS, 'w-40')}
				>
					<option value="">All</option>
					{facet.options.map((o) => (
						<option key={o.value} value={o.value}>
							{o.label}
						</option>
					))}
				</select>
			)}
		</div>
	)
}

/** A numeric/date facet: a min/max pair sharing one label. The `<input>` type
 * follows the column — `date` for a date column, `number` otherwise — so the
 * browser offers a picker/stepper and the emitted value is what the store
 * compares against (`>=`/`<=`). */
function RangeControl({
	facet,
	value,
	onChange,
}: {
	facet: Facet
	value: RangeValue
	onChange: (bound: 'gte' | 'lte', value: string) => void
}) {
	const inputType = facet.column.type === 'date' ? 'date' : 'number'
	const minId = `filter-${facet.name}-gte`
	const maxId = `filter-${facet.name}-lte`
	return (
		<div className="flex flex-col gap-1">
			<Label htmlFor={minId} className="text-xs text-muted-foreground">
				{facet.label}
			</Label>
			<div className="flex items-center gap-1">
				<Input
					id={minId}
					type={inputType}
					aria-label={`${facet.label} minimum`}
					placeholder="Min"
					value={value.gte ?? ''}
					onChange={(e) => onChange('gte', e.target.value)}
					className="h-9 w-28"
				/>
				<span className="text-muted-foreground">–</span>
				<Input
					id={maxId}
					type={inputType}
					aria-label={`${facet.label} maximum`}
					placeholder="Max"
					value={value.lte ?? ''}
					onChange={(e) => onChange('lte', e.target.value)}
					className="h-9 w-28"
				/>
			</div>
		</div>
	)
}
