/** Conform field-tree utilities, value/label helpers, and section resolution
 * shared by `<DynamicForm>` and its recursive field renderer. */

import type { FieldMetadata, FormMetadata } from '@conform-to/react'
import type { IntrospectedColumn } from '../fields/field-semantics.ts'
import type { SelectOption } from '../ui/form-fields.tsx'
import type { FormFieldConfig } from '../zod-to-form-fields.ts'
import type {
	FieldLayout,
	FieldUiOptions,
	FormSection,
	GridSpan,
} from './types.ts'

export type AnyField = FieldMetadata<any>
export type AnyForm = FormMetadata<Record<string, unknown>>

/** `getFieldset()`/`getFieldList()`/`key` exist only on object/array field
 * metadata; access them behind a cast since our fields are dynamically typed. */
export const getFieldsetOf = (m: AnyField): Record<string, AnyField> =>
	(
		m as unknown as { getFieldset: () => Record<string, AnyField> }
	).getFieldset()
export const getFieldListOf = (m: AnyField): AnyField[] =>
	(m as unknown as { getFieldList: () => AnyField[] }).getFieldList()
export const keyOf = (m: AnyField): string | undefined =>
	(m as unknown as { key?: string }).key

export const leafKey = (path: string): string =>
	path.includes('.') ? (path.split('.').pop() ?? path) : path

export function collectTopLevelDefaults(
	fields: FormFieldConfig[],
): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const f of fields) {
		if (f.defaultValue !== undefined) out[f.path] = f.defaultValue
	}
	return out
}

/** Every (path, config) pair in the tree — nested objects, array elements, and
 * union branches included. */
export function walkFieldConfigs(
	fields: FormFieldConfig[],
	visit: (config: FormFieldConfig) => void,
): void {
	for (const f of fields) {
		visit(f)
		if (f.fields) walkFieldConfigs(f.fields, visit)
		if (f.element) walkFieldConfigs([f.element], visit)
		for (const branch of f.branches ?? [])
			walkFieldConfigs(branch.fields, visit)
	}
}

/** Coerce a prefill into the `yyyy-MM-dd` an `<input type="date">` requires. An
 * already-legal date passes through; an ISO datetime is truncated to its date;
 * anything else parseable is normalized via `Date`; an unparseable/empty value
 * yields `''`. Without this, a datetime prefill renders blank and a submit of the
 * blank field wipes the stored date. */
export function toDateInputValue(value: unknown): string {
	if (value == null || value === '') return ''
	const raw = value instanceof Date ? value.toISOString() : String(value)
	const iso = /^(\d{4}-\d{2}-\d{2})(?:[T\s]|$)/.exec(raw)
	if (iso?.[1]) return iso[1]
	const d = new Date(raw)
	return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

// Tailwind generates only the classes it finds written out in source. A class
// built at runtime (`md:grid-cols-${n}`) never reaches the stylesheet, so the
// grid layout silently rendered as one stacked column in every consuming app.
// Every class the grid can use is therefore spelled out in these maps.
const GRID_COLUMNS = {
	1: 'md:grid-cols-1',
	2: 'md:grid-cols-2',
	3: 'md:grid-cols-3',
	4: 'md:grid-cols-4',
	5: 'md:grid-cols-5',
	6: 'md:grid-cols-6',
} as const

const GRID_SPANS: Record<GridSpan, string> = {
	1: 'md:col-span-1',
	2: 'md:col-span-2',
	3: 'md:col-span-3',
	4: 'md:col-span-4',
	5: 'md:col-span-5',
	6: 'md:col-span-6',
	full: 'col-span-full',
}

/** The fields container for `layout="grid"`, one column on small screens. */
export function gridContainerClass(columns: number): string {
	const n = Math.min(
		Math.max(Math.round(columns), 1),
		6,
	) as keyof typeof GRID_COLUMNS
	return `grid grid-cols-1 gap-4 ${GRID_COLUMNS[n]}`
}

/** A field cell's span in the grid (`uiOptions.colSpan`); `''` when unset. */
export function gridSpanClass(span: GridSpan | undefined): string {
	return span === undefined ? '' : GRID_SPANS[span]
}

export function fieldContainerClass(layout: FieldLayout): string {
	switch (layout) {
		case 'horizontal':
			return 'flex items-center gap-4'
		case 'inline':
			return 'flex items-end gap-2'
		default:
			return 'space-y-2'
	}
}

/** The schema's option values, labeled through the column's `meta.options`
 * (spec enum labels) when present — the user reads "Want next", the form
 * submits `want-next`. */
export function labeledOptions(
	config: FormFieldConfig,
	column: IntrospectedColumn | undefined,
): SelectOption[] {
	const values = config.options ?? []
	const metaOptions = column?.meta?.options
	if (!metaOptions?.length) return values
	const labelByValue = new Map(metaOptions.map((o) => [o.value, o.label]))
	return values.map((v) => ({ value: v, label: labelByValue.get(v) ?? v }))
}

/** Does an error keyed at `errorKey` belong to the field at `fieldPath`? Matches
 * the field itself and any nested (`.`) or array-element (`[`) descendant. */
export function fieldOwnsError(fieldPath: string, errorKey: string): boolean {
	return (
		errorKey === fieldPath ||
		errorKey.startsWith(`${fieldPath}.`) ||
		errorKey.startsWith(`${fieldPath}[`)
	)
}

export interface ResolvedSection {
	title?: string
	description?: string
	fields: FormFieldConfig[]
}

/** Map user-declared sections onto the introspected field configs. Fields not
 * named by any section are appended to the last one so nothing is dropped. */
export function resolveSections(
	sections: FormSection[] | undefined,
	formFields: FormFieldConfig[],
): ResolvedSection[] {
	if (!sections || sections.length === 0) return [{ fields: formFields }]
	const byPath = new Map(formFields.map((f) => [f.path, f]))
	const used = new Set<string>()
	const resolved: ResolvedSection[] = sections.map((section) => {
		const fields: FormFieldConfig[] = []
		for (const path of section.fields) {
			const config = byPath.get(path)
			if (config) {
				fields.push(config)
				used.add(path)
			}
		}
		return { title: section.title, description: section.description, fields }
	})
	const leftover = formFields.filter((f) => !used.has(f.path))
	const last = resolved[resolved.length - 1]
	if (leftover.length && last) last.fields.push(...leftover)
	return resolved
}

/** Shared per-render context threaded through the recursive field renderer. */
export interface RenderCtx {
	form: AnyForm
	uiOptions: Record<string, FieldUiOptions | undefined>
	hidden: Set<string>
	disabled: Set<string>
	serverErrorFor: (path: string) => string[] | undefined
	/** Introspected columns keyed by name, for metadata-driven widget upgrades. */
	columns: Map<string, IntrospectedColumn>
	/** The raw `defaultValues` prop (the row on edit) — Conform's `initialValue`
	 * stringifies leaves, so containers (json columns) re-serialize from here. */
	initialValues?: Record<string, unknown>
	/**
	 * Turn a stored file key into a previewable URL. Supplied by the
	 * server-rendered page, which is the only place that can mint a viewer-bound
	 * signed URL; omitted on a purely client-side render, where a file field then
	 * shows its filename chip with no thumbnail rather than a broken image.
	 */
	filePreviewUrl?: (key: string) => string
}
