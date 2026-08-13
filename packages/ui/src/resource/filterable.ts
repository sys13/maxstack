/**
 * The list-filter derivation — the tier-2 inference module for filtering, the
 * dual of `fields/field-semantics.ts` for display (Plan v5 task 34). Given an
 * introspected resource it decides, with zero spec vocabulary, which columns a
 * `<FilterForm>` should surface and how:
 *
 *   - **search** scans the text columns (`searchableFields`), feeding Sprout's
 *     `?search=` + repeatable `?searchField=`;
 *   - **facets** are the columns worth a structured control: enums (an equality
 *     dropdown, options from the column itself), references (a dropdown of the
 *     referenced records — injected by the caller, since they require a fetch),
 *     booleans (yes/no), and `number`/`date` columns (a `>=`/`<=` range pair,
 *     `?filter.<col>.gte=`/`.lte=`).
 *
 * The already-declared-but-unused `ColumnMetadata.filterable` is the override
 * seam: `filterable === false` excludes a column from both search and facets;
 * `filterable === true` force-includes an otherwise-non-facetable column as a
 * free-text equality input. Absent, the type-based defaults above apply — so an
 * app gets sensible filters for free, exactly like it gets sensible field
 * widgets for free, without adding presentation keys to the central spec.
 */

import {
	humanizeLabel,
	type IntrospectedColumn,
} from '../fields/field-semantics.ts'
import type { IntrospectedResource } from './resource-types.ts'

/** One column's inclusive `>=`/`<=` bounds — the controlled value of a range
 * facet. Bounds are strings (raw `<input>` values); an empty/absent bound is an
 * open end. Maps onto `GetListParams.range` / Sprout's `filter.<col>.gte|lte`. */
export interface RangeValue {
	gte?: string
	lte?: string
}

/** The controlled value of a `<FilterForm>`: a free-text search, per-column
 * equality selections, and per-column numeric/date ranges. Maps 1:1 onto
 * `GetListParams` (`search` + `filter` + `range`). */
export interface FilterValues {
	search?: string
	/** `columnName → selected value` (equality). Absent key = no constraint. */
	filter: Record<string, string>
	/** `columnName → { gte, lte }` (inclusive range). Absent key = no constraint. */
	range?: Record<string, RangeValue>
}

/** A filters value with nothing selected. */
export const EMPTY_FILTERS: FilterValues = { filter: {} }

export type FacetKind = 'enum' | 'reference' | 'boolean' | 'range' | 'text'

export interface FacetOption {
	label: string
	value: string
}

/** One derived facet — a column rendered as an equality dropdown. */
export interface Facet {
	column: IntrospectedColumn
	/** The column name (the `filter.<name>` key). */
	name: string
	label: string
	kind: FacetKind
	/** Selectable values. Empty for `text` facets (a free input) and for a
	 * `reference` facet whose options the caller hasn't supplied yet. */
	options: FacetOption[]
}

const isReference = (c: IntrospectedColumn): boolean => c.references != null

const isEnum = (c: IntrospectedColumn): boolean =>
	c.type === 'enum' ||
	(c.enumValues?.length ?? 0) > 0 ||
	(c.meta?.options?.length ?? 0) > 0

/** True for the string-ish columns a text search should scan. */
const isTextColumn = (c: IntrospectedColumn): boolean =>
	c.type === 'string' || c.type === 'text'

/** True for the ordered scalar columns a range facet (`>=`/`<=`) applies to. */
const isRangeColumn = (c: IntrospectedColumn): boolean =>
	c.type === 'number' || c.type === 'date'

/** Columns the caller opted out of (`filterable === false`) are invisible to
 * both search and facets. */
const optedOut = (c: IntrospectedColumn): boolean =>
	c.meta?.filterable === false || c.meta?.hidden === true

/**
 * The text columns a `<FilterForm>`'s search box scans — handed to the data
 * provider as `searchFields` so the route and the form agree on the target set
 * (the same "shared derivation" discipline as `field-semantics`). A reference
 * column is excluded (its text lives in another table); `filterable === false`
 * excludes a column explicitly.
 */
export function searchableFields(resource: IntrospectedResource): string[] {
	return resource.columns
		.filter(
			(c) =>
				!optedOut(c) &&
				c.name !== resource.primaryKey &&
				!isReference(c) &&
				isTextColumn(c) &&
				!isEnum(c),
		)
		.map((c) => c.name)
}

/**
 * The kinds of column an `ORDER BY` cannot say anything useful about.
 *
 * Sorting is defined for anything the database can compare, which is nearly
 * every column — but a JSON blob, a stored file key and an array of foreign
 * keys all sort by an encoding the reader never sees, so a header that offered
 * it would be a control whose result looks random. A password column is
 * excluded for the reason it is never rendered at all.
 */
const UNORDERED_TYPES = new Set(['json'])

/**
 * Whether a column's header sorts the list — the sort dual of
 * {@link deriveFacets}, and the same three-state rule: `meta.sortable === false`
 * opts out, `=== true` forces in, and absent means the type-based default
 * below.
 *
 * The default is **on**, which is the change issue #342 is about. `sortable`
 * was a declared-but-never-written metadata key, so `sortable === true` was
 * never true for any column of any resource, so no list in the product had a
 * sortable header — the capability was implemented in `<ResourceList>` and
 * unreachable. Defaults that are off are discovered by reading the schema
 * reference; defaults that are on are discovered by using the app.
 */
export function isSortableColumn(column: IntrospectedColumn): boolean {
	if (column.meta?.sortable !== undefined) return column.meta.sortable
	if (column.meta?.hidden === true) return false
	// A stored file is a storage key and an array reference is a list of ids:
	// both are `string`/`json` columns whose text is an encoding, not a value.
	if (column.meta?.isFile === true || column.meta?.arrayReference) return false
	return !UNORDERED_TYPES.has(column.type)
}

/**
 * The columns of a resource whose headers sort it. A route uses this to decide
 * whether a `?sort=` param off the URL names something it will honour — an
 * ordering by a column the page does not show is a comparison oracle over a
 * value the viewer was never handed (the same reasoning `assertPortalReadShape`
 * applies in core), so the answer has to be derived from the *visible* columns
 * rather than trusted from the query string.
 */
export function sortableFields(resource: IntrospectedResource): string[] {
	return resource.columns
		.filter((c) => c.name !== resource.primaryKey && isSortableColumn(c))
		.map((c) => c.name)
}

/**
 * Whether a `?filter.<col>=` naming this column may make the page **render**
 * it — the one widening of "a page controls exactly the columns it renders"
 * that does not weaken it.
 *
 * The rule a list page enforces is that a filter on a column the viewer was
 * never shown is a comparison oracle over its values. The tempting fix for a
 * related-records "view all" link (`?filter.<fk>=<parent id>`) is to allow the
 * FK through the narrowing anyway; that is exactly the hole. The fix that is
 * not a hole inverts it: **the filter target becomes a rendered column.** The
 * caller then learns the value by reading it off every row, which is a
 * disclosure the page was already willing to make, and the oracle buys them
 * nothing over the plain unfiltered list. The invariant is preserved *by
 * construction* rather than by exception — there is still no way to filter by
 * a column the page will not show you.
 *
 * The promotion is confined to **declared relations** (`references`), because
 * that is the only widening any surface needs: an inverse-reference panel
 * addresses its children through the FK the spec already declares, and the
 * relation graph is derived, not client-supplied. A column the schema opted out
 * of filtering (`filterable === false`) or out of rendering (`hidden`) is not
 * promoted — those are the two declarations that say "not this one", and a
 * promotion that overrode them would make `hidden` mean nothing at all.
 */
export function isRelationFilterColumn(column: IntrospectedColumn): boolean {
	return isReference(column) && !optedOut(column)
}

/**
 * Which filter spellings a column's control offers — the declared
 * `meta.filterOperators` (#414) when there is one, and the type's own default
 * when there is not.
 *
 * The default is stated here rather than left implicit in {@link deriveFacets}'
 * branches so that the *form* and the *narrowing* read one answer: a control
 * that renders a range pair while the narrowing drops range bounds is a filter
 * that visibly does nothing, which is the worst of the three possible bugs.
 */
export function filterOperatorsOf(column: IntrospectedColumn): string[] {
	const declared = column.meta?.filterOperators
	if (declared?.length) return declared
	return isRangeColumn(column) && !isEnum(column) ? ['range'] : ['eq']
}

/**
 * The **declared** operator sets, keyed by column — what a narrowing enforces.
 *
 * Deliberately not {@link filterOperatorsOf} for every column. The derived
 * default is what a *control* should render; enforcing it as well would newly
 * drop `?filter.cost=5` on an undeclared number column, which every list has
 * honoured since #342. A narrowing may only refuse what somebody declared, so
 * an undeclared column is absent from this map and passes through exactly as
 * before.
 */
export function declaredFilterOperators(
	columns: readonly IntrospectedColumn[],
): Record<string, string[]> {
	const out: Record<string, string[]> = {}
	for (const column of columns) {
		const declared = column.meta?.filterOperators
		if (declared?.length) out[column.name] = declared
	}
	return out
}

const BOOLEAN_OPTIONS: FacetOption[] = [
	{ label: 'Yes', value: 'true' },
	{ label: 'No', value: 'false' },
]

/** Static options for an enum facet, from `meta.options` (labelled) or the bare
 * introspected `enumValues`. */
function enumOptions(column: IntrospectedColumn): FacetOption[] {
	const opts = column.meta?.options
	if (opts?.length) return opts.map((o) => ({ label: o.label, value: o.value }))
	return (column.enumValues ?? []).map((v) => ({ label: v, value: v }))
}

/**
 * Derive the facets for a resource. `referenceOptions` supplies the choice list
 * for FK columns (keyed by column name) — the referenced records, which the
 * caller resolves server-side (e.g. via `referenceFieldOptions`). A reference
 * column with no supplied options is still emitted, just with an empty list, so
 * the form can show it as (temporarily) disabled rather than dropping it.
 */
export function deriveFacets(
	resource: IntrospectedResource,
	referenceOptions: Record<string, FacetOption[]> = {},
): Facet[] {
	const out: Facet[] = []
	for (const column of resource.columns) {
		if (optedOut(column) || column.name === resource.primaryKey) continue
		const label = column.meta?.label ?? humanizeLabel(column.name)
		const operators = filterOperatorsOf(column)
		// A declared operator set narrows the control the type would have given
		// (#414). The case it exists for: a number or date whose useful filter is
		// an exact value — a year, an invoice number — rather than the `>=`/`<=`
		// pair every ordered column derives. `range` is refused on any other type
		// by the op validator, so the only narrowing that reaches here is this one.
		if (
			!operators.includes('range') &&
			isRangeColumn(column) &&
			!isEnum(column)
		) {
			out.push({ column, name: column.name, label, kind: 'text', options: [] })
			continue
		}
		if (isReference(column)) {
			out.push({
				column,
				name: column.name,
				label,
				kind: 'reference',
				options: referenceOptions[column.name] ?? [],
			})
		} else if (isEnum(column)) {
			out.push({
				column,
				name: column.name,
				label,
				kind: 'enum',
				options: enumOptions(column),
			})
		} else if (column.type === 'boolean') {
			out.push({
				column,
				name: column.name,
				label,
				kind: 'boolean',
				options: BOOLEAN_OPTIONS,
			})
		} else if (isRangeColumn(column)) {
			// A numeric/date column gets a `>=`/`<=` range pair for free — the dual
			// of an enum's dropdown. `options` stays empty; the two bounds are inputs.
			out.push({ column, name: column.name, label, kind: 'range', options: [] })
		} else if (column.meta?.filterable === true) {
			// Explicit opt-in on a column with no natural option set → free input.
			out.push({ column, name: column.name, label, kind: 'text', options: [] })
		}
	}
	return out
}

/** How many constraints are active — drives the "Clear" affordance. Each range
 * bound counts once, so a `costMonthly` with both a min and a max reads as two. */
export function activeFilterCount(values: FilterValues): number {
	const search = values.search?.trim() ? 1 : 0
	const facets = Object.values(values.filter).filter(
		(v) => v != null && v !== '',
	).length
	const ranges = Object.values(values.range ?? {}).reduce(
		(n, r) => n + (r.gte?.trim() ? 1 : 0) + (r.lte?.trim() ? 1 : 0),
		0,
	)
	return search + facets + ranges
}
