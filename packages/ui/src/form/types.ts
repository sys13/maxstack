/** Public form-layer types + ui-options helpers shared by `<DynamicForm>`. */

import type { IntrospectedColumn } from '../fields/field-semantics.ts'
import type { AutocompleteOption } from '../ui/form-fields.tsx'
import type { FieldWidget } from '../zod-to-form-fields.ts'
import {
	type ReferenceSearchPlan,
	referenceSearchPlan,
} from './reference-search.ts'

export type FormLayout = 'vertical' | 'horizontal' | 'grid'
export type FieldLayout = 'vertical' | 'horizontal' | 'inline'
/** How multi-section forms present their groups. */
export type SectionVariant = 'panels' | 'tabs' | 'accordion'

/** Widget override keys usable per field via `uiOptions`. */
export type InputTypeOverride =
	| FieldWidget
	| 'textarea'
	| 'radiogroup'
	| 'password'
	| 'reference'
	// The multi-value FK picker for an array-reference column (task 38). Auto-
	// selected when the column carries `meta.arrayReference`; `referenceOptions`
	// supplies the choices, exactly like `reference`.
	| 'reference-array'
	// Rich / specialty widgets whose default detection is metadata-driven, but
	// which a caller may also force per field (task 39).
	| 'markdown'
	| 'image'

export interface FieldUiOptions {
	label?: string
	placeholder?: string
	helpText?: string
	className?: string
	layout?: FieldLayout
	inputType?: InputTypeOverride
	/**
	 * Options for a `reference` (FK) picker — `{ label, value }` where `value`
	 * is the referenced record's id. The loader builds these from the target
	 * resource; supplying them turns a field into an `<AutocompleteInput>`.
	 */
	referenceOptions?: AutocompleteOption[]
	/**
	 * What the picker needs to search the referenced resource as the user types,
	 * instead of filtering the one page {@link referenceOptions} carries (#442).
	 * Derived from the column, not supplied by a loader — see
	 * {@link referenceUiOptions}.
	 */
	referenceSearch?: ReferenceSearchPlan
	/** Create-inline handler for the FK picker (mints + selects a new option). */
	onCreateReference?: (
		label: string,
	) => Promise<AutocompleteOption> | AutocompleteOption
}

/**
 * Build the `uiOptions` map that gives every FK column its picker choices —
 * the one ingredient a form can't infer (the referenced records; a loader lists
 * them via `referenceFieldOptions`). Marks a column `reference-array` when its
 * metadata says it holds many. Shared by the admin and the generic project
 * routes so both surfaces resolve references identically.
 *
 * The search plan (#442) is **derived here from the columns**, not passed in by
 * a loader. Everything it needs — the referenced table, its id column, its
 * display field — already travels with the introspection every one of these
 * routes hands the form, so deriving it means the eight loaders that build
 * `referenceOptions` need no change and, more to the point, cannot be the place
 * a surface silently misses out on it. That is the failure mode #443 records:
 * `onCreateReference` is a real capability that no loader ever passes.
 */
export function referenceUiOptions(
	columns: readonly IntrospectedColumn[],
	referenceOptions: Record<string, AutocompleteOption[]>,
): Record<string, FieldUiOptions> {
	const byName = new Map(columns.map((c) => [c.name, c]))
	const arrayRefFields = new Set(
		columns.filter((c) => c.meta?.arrayReference).map((c) => c.name),
	)
	const out: Record<string, FieldUiOptions> = {}
	for (const [field, options] of Object.entries(referenceOptions)) {
		const column = byName.get(field)
		out[field] = {
			inputType: arrayRefFields.has(field) ? 'reference-array' : 'reference',
			referenceOptions: options,
			referenceSearch: column ? referenceSearchPlan(column) : undefined,
		}
	}
	return out
}

/** A named group of top-level fields. `fields` lists field paths (the object
 * keys); order within the section follows this list. In wizard mode each section
 * is one step. */
export interface FormSection {
	title: string
	description?: string
	fields: string[]
}
