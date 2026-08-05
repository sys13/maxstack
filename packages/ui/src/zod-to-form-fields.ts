/**
 * Zod-schema → form-field config. The reimplementation of the specbase
 * original's `zod-to-form-fields.tsx`, fixing every gap the reference spec calls
 * out (the reference design"Known gaps"):
 *
 *   - **Optional / nullable** fields are kept (the original had no branch, so
 *     they silently vanished and every field was hardcoded `required: true`).
 *   - **Nested objects** produce a real child tree (`type: 'object'`, `fields`)
 *     instead of flat dotted keys the renderer then failed to look up.
 *   - **General arrays / array-of-object repeaters** produce an `element`
 *     template (`type: 'array'`); only `array(enum)` collapses to multi-select.
 *   - **Unions** produce a `branches` list (`type: 'union'`).
 *   - **email / url / date / file** are auto-detected from the schema, not only
 *     reachable via `uiOptions.inputType`.
 *
 * Zod-4 idioms: type is read from the public `.def.type` tag and wrappers are
 * peeled with `.unwrap()` — no `_def.innerType` internal access (the reference
 * spec's flagged fragility point). String subtype is read from `.def.format`
 * via substring match so the exact format spelling (e.g. `datetime` vs
 * `iso_datetime`) does not matter.
 *
 * Validation constraints (min/max/pattern) are intentionally NOT extracted
 * here: DynamicForm applies Conform's `getZodConstraint` to the whole schema
 * for progressive-enhancement constraints, which the original never wired up.
 */

import type { ZodType } from 'zod'
import {
	humanizeLabel,
	nameHint,
	specialtyHint,
} from './fields/field-semantics.ts'

export type FieldWidget =
	| 'text'
	| 'email'
	| 'url'
	| 'number'
	| 'checkbox'
	| 'select'
	| 'multi-select'
	| 'date'
	| 'file'
	| 'object'
	| 'array'
	| 'union'
	// Rich / specialty widgets (task 39), auto-detected from schema + name.
	| 'password'
	| 'color'
	| 'richtext'
	| 'json'
	| 'duration'
	| 'rating'
	| 'slider'
	| 'geo'

export interface FormFieldConfig {
	/** Conform field name — dotted for nested (`address.street`). */
	path: string
	/** `.describe()` text, else the leaf key. */
	label: string
	type: FieldWidget
	/** Enum / multi-select option values. */
	options?: string[]
	/** True when the schema is `ZodOptional` (field may be absent). */
	optional: boolean
	/** True when the schema is `ZodNullable`. */
	nullable: boolean
	/** Derived: not optional, not nullable, and no default — a genuinely required field. */
	required: boolean
	defaultValue: any
	/** Child fields for `type: 'object'`. */
	fields?: FormFieldConfig[]
	/** Element template for `type: 'array'` (repeater). Path uses `[]` as the index placeholder. */
	element?: FormFieldConfig
	/** Branches for `type: 'union'`. */
	branches?: { label: string; fields: FormFieldConfig[] }[]
}

// --- Zod-4 introspection helpers -------------------------------------------

interface ZodDef {
	type?: string
	format?: string
	[key: string]: any
}

/** The public def tag object (`.def`), tolerant of the `_zod.def` fallback. */
function defOf(schema: unknown): ZodDef {
	const s = schema as { def?: ZodDef; _zod?: { def?: ZodDef } }
	return s.def ?? s._zod?.def ?? {}
}

function tagOf(schema: unknown): string {
	return defOf(schema).type ?? ''
}

/** Unwrap a single wrapper layer if present, else null. */
function unwrapOnce(schema: unknown): ZodType | null {
	const s = schema as { unwrap?: () => ZodType }
	if (typeof s.unwrap === 'function') return s.unwrap()
	const inner = defOf(schema).innerType as ZodType | undefined
	return inner ?? null
}

const WRAPPERS = new Set([
	'optional',
	'nullable',
	'default',
	'prefault',
	'readonly',
	'nonoptional',
	'catch',
])

interface Peeled {
	inner: ZodType
	optional: boolean
	nullable: boolean
	hasDefault: boolean
	defaultValue: any
	/** Description found on any layer (outer wins). */
	description?: string
}

/** Peel optional/nullable/default/readonly/… layers, collecting their flags. */
function peel(schema: ZodType): Peeled {
	let current: ZodType = schema
	let optional = false
	let nullable = false
	let hasDefault = false
	let defaultValue: any
	let description: string | undefined = (current as { description?: string })
		.description

	// Guard against pathological cycles.
	for (let depth = 0; depth < 20; depth++) {
		const tag = tagOf(current)
		// A pipe (`z.preprocess(...)` / `.pipe(...)`) presents as its *output*
		// schema — the input side is coercion, not shape.
		if (tag === 'pipe') {
			const out = defOf(current).out as ZodType | undefined
			if (!out) break
			current = out
			description =
				description ?? (current as { description?: string }).description
			continue
		}
		if (!WRAPPERS.has(tag)) break
		if (tag === 'optional') optional = true
		if (tag === 'nullable') nullable = true
		if (tag === 'default' || tag === 'prefault') {
			hasDefault = true
			const raw = defOf(current).defaultValue
			defaultValue = typeof raw === 'function' ? raw() : raw
		}
		const next = unwrapOnce(current)
		if (!next) break
		current = next
		description =
			description ?? (current as { description?: string }).description
	}

	// Fallback: resolve a default by parsing undefined (covers exotic wrappers).
	if (hasDefault && defaultValue === undefined) {
		try {
			defaultValue = (schema as { parse: (v: unknown) => unknown }).parse(
				undefined,
			)
		} catch {
			/* leave undefined */
		}
	}

	return {
		inner: current,
		optional,
		nullable,
		hasDefault,
		defaultValue,
		description,
	}
}

/** email → 'email', url → 'url', any date/time format → 'date', else null. */
function stringWidgetFromFormat(def: ZodDef): FieldWidget | null {
	const format = (def.format ?? '').toLowerCase()
	if (!format) {
		// Some Zod-4 string formats live in `checks` rather than `def.format`.
		const checks = Array.isArray(def.checks) ? def.checks : []
		for (const c of checks) {
			const f = String(defOf(c).format ?? '').toLowerCase()
			const w = classifyFormat(f)
			if (w) return w
		}
		return null
	}
	return classifyFormat(format)
}

function classifyFormat(format: string): FieldWidget | null {
	if (!format) return null
	if (format.includes('email')) return 'email'
	if (format.includes('url')) return 'url'
	if (format.includes('date') || format.includes('time')) return 'date'
	return null
}

function enumOptions(schema: any): string[] {
	if (Array.isArray(schema.options)) return schema.options.map(String)
	const values = defOf(schema).entries ?? defOf(schema).values
	if (values && typeof values === 'object')
		return Object.values(values).map(String)
	return []
}

/** A record/map — the object half of a JSON-container union. */
function isRecordLike(schema: ZodType): boolean {
	const tag = tagOf(peel(schema).inner)
	return tag === 'record' || tag === 'map'
}

/** An untyped JSON container: a record/map, an array of unknown/any, or an
 * opaque `z.custom` (the array-validating branch `generateValidationSchema`
 * emits for a `json` column — see issue #36). */
function isJsonContainer(schema: ZodType): boolean {
	if (isRecordLike(schema)) return true
	const inner = peel(schema).inner
	const tag = tagOf(inner)
	if (tag === 'custom') return true
	if (tag !== 'array') return false
	const element = ((inner as any).element ?? defOf(inner).element) as ZodType
	const elementTag = tagOf(peel(element).inner)
	return elementTag === 'unknown' || elementTag === 'any'
}

function labelFor(path: string, description?: string): string {
	if (description) return description
	const leaf = path.includes('.') ? (path.split('.').pop() ?? path) : path
	return humanizeLabel(leaf)
}

/**
 * Introspect one schema at `path` into a field config (recursing objects,
 * arrays, and unions). Returns `null` for nodes with no sensible widget
 * (e.g. `ZodNever`), which callers skip.
 */
export function zodToFormField(
	schema: ZodType,
	path: string,
): FormFieldConfig | null {
	const { inner, optional, nullable, hasDefault, defaultValue, description } =
		peel(schema)
	const tag = tagOf(inner)
	const label = labelFor(path, description)
	const base = {
		path,
		label,
		optional,
		nullable,
		required: !optional && !nullable && !hasDefault,
	}

	switch (tag) {
		case 'object': {
			const shape = (inner as any).shape ?? defOf(inner).shape ?? {}
			const fields: FormFieldConfig[] = []
			for (const key of Object.keys(shape)) {
				const childPath = path ? `${path}.${key}` : key
				const child = zodToFormField(shape[key] as ZodType, childPath)
				if (child) fields.push(child)
			}
			return {
				...base,
				type: 'object',
				defaultValue: defaultValue ?? {},
				fields,
			}
		}

		case 'array': {
			const element = ((inner as any).element ??
				defOf(inner).element) as ZodType
			// array(enum) → a single multi-select control (spec: the one array case
			// the original handled).
			if (tagOf(peel(element).inner) === 'enum') {
				return {
					...base,
					type: 'multi-select',
					options: enumOptions(peel(element).inner),
					defaultValue: Array.isArray(defaultValue) ? defaultValue : [],
				}
			}
			// General array → a repeater over the element template.
			const elementConfig = zodToFormField(element, `${path}[]`)
			return {
				...base,
				type: 'array',
				defaultValue: Array.isArray(defaultValue) ? defaultValue : [],
				element: elementConfig ?? undefined,
			}
		}

		case 'union': {
			const options = (defOf(inner).options ?? []) as ZodType[]
			// A union of untyped JSON containers with a record/map branch (the
			// shape `generateValidationSchema` emits for a `json` column) is one
			// JSON textarea, not a branch picker.
			if (options.some(isRecordLike) && options.every(isJsonContainer)) {
				return {
					...base,
					type: 'json',
					defaultValue: defaultValue ?? undefined,
				}
			}
			// A union that merely accepts several *encodings of one scalar value*
			// (e.g. a date accepted as ISO datetime | ISO date | Date, the shape
			// `generateValidationSchema` emits for a date column) is not a real sum
			// type — it must render as that single widget, not a branch picker.
			// Collapse when every branch resolves to the same format-agnostic scalar
			// widget. `select`/`multi-select` are excluded: same widget, different
			// option sets, so collapsing would silently drop options.
			const COLLAPSIBLE_WIDGETS = new Set<FieldWidget>([
				'text',
				'email',
				'url',
				'date',
				'number',
				'checkbox',
			])
			const optionConfigs = options.map((opt) => zodToFormField(opt, path))
			const widgets = new Set(
				optionConfigs
					.filter((c): c is FormFieldConfig => c != null)
					.map((c) => c.type),
			)
			const soleWidget = widgets.size === 1 ? [...widgets][0] : undefined
			if (soleWidget && COLLAPSIBLE_WIDGETS.has(soleWidget)) {
				const collapsed = optionConfigs.find(Boolean) as FormFieldConfig
				return {
					...base,
					type: collapsed.type,
					defaultValue: defaultValue ?? '',
				}
			}
			const branches = options.map((opt, i) => {
				const config = zodToFormField(opt, path)
				const fields =
					config?.type === 'object' && config.fields
						? config.fields
						: config
							? [config]
							: []
				// Prefer a distinct `.describe()` label; fall back to a positional one
				// (object branches share the union's path, so `config.label` collides).
				const label =
					config?.label && config.label !== labelFor(path)
						? config.label
						: `Option ${i + 1}`
				return { label, fields }
			})
			return { ...base, type: 'union', defaultValue, branches }
		}

		case 'enum':
			return {
				...base,
				type: 'select',
				options: enumOptions(inner),
				defaultValue: defaultValue ?? enumOptions(inner)[0] ?? '',
			}

		case 'boolean':
			return { ...base, type: 'checkbox', defaultValue: defaultValue ?? false }

		case 'number':
		case 'int':
		case 'bigint': {
			// A number's name can ask for a richer control (stars / duration).
			const leaf = path.includes('.') ? (path.split('.').pop() ?? path) : path
			const s = specialtyHint(leaf)
			const widget: FieldWidget =
				s === 'rating' ? 'rating' : s === 'duration' ? 'duration' : 'number'
			return { ...base, type: widget, defaultValue: defaultValue ?? '' }
		}

		// A record / map (`z.record`, the shape `generateValidationSchema` emits for
		// a `json` column) edits as a JSON textarea — previously these fell through
		// to `null` and the field silently vanished from the form.
		case 'record':
		case 'map':
			return { ...base, type: 'json', defaultValue: defaultValue ?? undefined }

		case 'date':
			return { ...base, type: 'date', defaultValue: defaultValue ?? '' }

		case 'file':
			return { ...base, type: 'file', defaultValue: undefined }

		case 'literal':
			return {
				...base,
				type: 'text',
				defaultValue: defaultValue ?? defOf(inner).values?.[0] ?? '',
			}

		case 'string': {
			// Prefer the schema's own format (`.email()`, `.url()`, …); fall back to
			// the shared name heuristic so a plain `z.string()` named `email` still
			// gets an email widget — the same detector `<Field>` uses on the read
			// side, so form and display agree. (`image` has no form widget of its
			// own; an image is edited as its URL.)
			const leaf = path.includes('.') ? (path.split('.').pop() ?? path) : path
			const hint = nameHint(leaf)
			// String-appropriate specialties (password / color / rich-text / geo);
			// `rating`/`duration` are numeric so they never apply to a string.
			const specialty = specialtyHint(leaf)
			const stringSpecialty =
				specialty === 'password' ||
				specialty === 'color' ||
				specialty === 'richtext' ||
				specialty === 'geo'
					? specialty
					: null
			const widget: FieldWidget =
				stringWidgetFromFormat(defOf(inner)) ??
				stringSpecialty ??
				(hint === 'image' ? 'url' : hint) ??
				'text'
			return { ...base, type: widget, defaultValue: defaultValue ?? '' }
		}

		default:
			// Unknown / non-renderable leaf — skip.
			return null
	}
}

/**
 * Introspect a `z.object(...)` schema into the flat list of top-level field
 * configs DynamicForm renders. Nested structure lives inside each config
 * (`fields` / `element` / `branches`) rather than being flattened to dotted
 * keys the way the broken original did.
 */
export function zodToFormFields(schema: ZodType): FormFieldConfig[] {
	const { inner } = peel(schema)
	if (tagOf(inner) !== 'object') {
		const single = zodToFormField(schema, '')
		return single ? [single] : []
	}
	const shape = (inner as any).shape ?? defOf(inner).shape ?? {}
	const fields: FormFieldConfig[] = []
	for (const key of Object.keys(shape)) {
		const child = zodToFormField(shape[key] as ZodType, key)
		if (child) fields.push(child)
	}
	return fields
}
