/**
 * The read-side dual of `zod-to-form-fields.ts`: given an introspected Sprout
 * column (`{ name, type, meta }`), decide which *semantic* display component
 * renders it. This is the single detector both the form (write) and the field
 * library (read) consult so a column that edits as an email input also displays
 * as a mailto link — form and display agree by construction (Plan v5 task 31).
 *
 * Detection order, most-specific first: explicit metadata (`isFile`,
 * `markdown`, `reference`, enum `options`) → the introspected column `type` →
 * a name heuristic for string columns (`avatarUrl` → image, `homepage` → url).
 * The name heuristic is the piece shared with the form: `nameHintWidget` is
 * consumed by `zodToFormField`'s string fallback so a `z.string()` field named
 * `email` still renders an email widget even without a `.email()` refinement.
 *
 * This package stays decoupled from `@maxstack/core`: the column shape is a
 * local structural type (`IntrospectedColumn`) that `SproutColumn` satisfies.
 */

/** The metadata subset the field library reads (structurally a `ColumnMetadata`). */
export interface FieldMetaLike {
	label?: string
	description?: string
	hidden?: boolean
	readOnly?: boolean
	markdown?: boolean
	isFile?: boolean
	fileAccept?: string
	fileMaxSize?: number
	/** The resource this file column belongs to — sent with an
	 * upload so the server can find and enforce the field's own declaration. */
	fileResource?: string
	format?: string
	/**
	 * This string column holds prose — edit it in a textarea.
	 * Explicit either way: `true` forces one on a name the heuristic misses,
	 * `false` keeps a field named `notes` on a single line.
	 */
	multiline?: boolean
	prefix?: string
	suffix?: string
	options?: { label: string; value: string }[]
	/**
	 * Per-value row caps on an enum column — the declared WIP limit a
	 * board draws on its column headers. Structurally `ColumnMetadata.valueLimits`
	 * from `@maxstack/core`, which is also where it is *enforced*: the number
	 * shown here and the rule the server applies are one declaration.
	 */
	valueLimits?: Record<string, number>
	/** This column is a manual-ordering key, not a value to show. */
	rankKey?: boolean
	sortable?: boolean
	filterable?: boolean
	/**
	 * Which filter spellings this column's control offers — `['eq']`,
	 * `['range']`, or both (#414). Structurally `ColumnMetadata.filterOperators`
	 * from `@maxstack/core`. Absent means the derivation in `filterable.ts`
	 * decides from the column's type, which is every column the spec has not
	 * spoken about.
	 */
	filterOperators?: string[]
	/** The "many" side of a reference (task 38): this column holds an array of
	 * foreign keys. Structurally a `SproutColumnReference`. */
	arrayReference?: FieldReferenceLike
	/** Numeric bounds — drive the slider / rating / duration ranges (task 39). */
	min?: number
	max?: number
	step?: number
	[key: string]: unknown
}

/** A reference target (structurally a `SproutColumnReference`). */
export interface FieldReferenceLike {
	table: string
	column: string
	displayField?: string
}

/**
 * The read-side view of a Sprout column. `SproutColumn` from `@maxstack/core`
 * satisfies this structurally, so a loader can hand its introspection straight
 * to `<ResourceList>` / `<Show>` without a mapping layer.
 */
export interface IntrospectedColumn {
	name: string
	/** `SproutColumnType` — kept as a wide `string` to avoid a core dependency. */
	type: string
	nullable?: boolean
	enumValues?: string[]
	references?: FieldReferenceLike
	meta?: FieldMetaLike
}

/**
 * The semantic display kinds. `reference` is emitted for FK columns but the
 * base `<Field>` renders it as text (the referenced record's display field is
 * task 32); everything else has a dedicated component. The `color`/`rating`/
 * `duration`/`geo`/`richtext`/`password` kinds are the read duals of the rich
 * input widgets added in task 39.
 */
export type FieldKind =
	| 'date'
	| 'email'
	| 'url'
	| 'boolean'
	| 'enum'
	| 'number'
	| 'markdown'
	| 'richtext'
	| 'image'
	| 'file'
	| 'json'
	| 'color'
	| 'rating'
	| 'duration'
	| 'geo'
	| 'password'
	| 'reference'
	| 'reference-array'
	| 'text'

/**
 * The rich / specialty input widgets task 39 adds on top of the base form
 * widgets. `detectInputWidget` returns one of these (or `null`) so DynamicForm
 * can *upgrade* a plain schema-derived control into a rich editor when the
 * column's metadata (or name) asks for it — the form dual of `detectFieldKind`.
 */
export type SpecialtyWidget =
	| 'textarea'
	| 'password'
	| 'color'
	| 'richtext'
	| 'markdown'
	| 'json'
	| 'duration'
	| 'rating'
	| 'slider'
	| 'geo'
	| 'image'
	| 'file'

const IMAGE_WORDS = new Set([
	'image',
	'img',
	'avatar',
	'photo',
	'thumbnail',
	'thumb',
	'picture',
	'logo',
	'banner',
	'cover',
	'icon',
])
const URL_WORDS = new Set(['url', 'uri', 'link', 'href', 'website', 'homepage'])
const PASSWORD_WORDS = new Set(['password', 'passwd', 'pwd'])
const COLOR_WORDS = new Set(['color', 'colour'])
const RICHTEXT_WORDS = new Set(['richtext', 'wysiwyg', 'html'])
const DURATION_WORDS = new Set(['duration'])
const RATING_WORDS = new Set(['rating', 'stars'])
const GEO_WORDS = new Set(['geo', 'coordinates', 'coords', 'latlng', 'latlong'])
/**
 * String columns that hold prose rather than a phrase. The six
 * canonical spec types deliberately have no seventh `text` member, so a tasting
 * note, a bio and an address all arrive as `string` and used to edit in a
 * single-line `<input>`. These names are the ones where a textarea is right
 * often enough to be the better default; `meta.multiline` overrides either way
 * for the cases a name cannot carry.
 */
const MULTILINE_WORDS = new Set([
	'notes',
	'note',
	'description',
	'summary',
	'body',
	'bio',
	'about',
	'comment',
	'comments',
	'address',
	'message',
	'content',
	'excerpt',
	'details',
	'instructions',
	'abstract',
])

/** Split a column name into lowercased word tokens, handling `snake_case`,
 * `kebab-case`, and `camelCase` (`avatarUrl` → `['avatar', 'url']`). */
function tokenize(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.split(/[^a-zA-Z0-9]+/)
		.map((t) => t.toLowerCase())
		.filter(Boolean)
}

/**
 * Raw column/field name → display label: `first_name` / `firstName` →
 * "First Name". The single shared fallback for every place a label can be
 * rendered without an explicit override (`<ResourceList>` headers, `<Show>`
 * labels, `<DynamicForm>` field labels) — see issue #1: those call sites used
 * to fall back straight to the raw (often snake_case) column name, which read
 * as all-lowercase.
 */
export function humanizeLabel(name: string): string {
	return name
		.replace(/[_-]+/g, ' ')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.split(' ')
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ')
}

/**
 * Semantic hint from a column/field *name* alone, for string columns whose type
 * carries no signal. Returned kind is always one representable as a form widget
 * (`email` | `url` | `image`) — this is the function `zodToFormField` shares.
 *
 * Image beats url: `avatarUrl` is a URL, but what it points at is an image, so
 * it should render as one.
 */
export function nameHint(name: string): 'email' | 'url' | 'image' | null {
	const tokens = tokenize(name)
	if (tokens.some((t) => t.includes('email'))) return 'email'
	if (tokens.some((t) => IMAGE_WORDS.has(t))) return 'image'
	if (tokens.some((t) => URL_WORDS.has(t))) return 'url'
	return null
}

/**
 * Specialty widget hint from a column/field *name* alone — the long-tail
 * semantic widgets task 39 auto-detects (`apiPassword` → password, `brandColor`
 * → color, `latlng` → geo, …). Kept separate from `nameHint` (which only
 * returns widgets that are *also* meaningful for the base `<Input>` fallback) so
 * the existing email/url/image inference is unchanged. Shared by the form
 * (`zodToFormField`) and the display detector so both agree.
 */
export function specialtyHint(
	name: string,
): 'password' | 'color' | 'richtext' | 'duration' | 'rating' | 'geo' | null {
	const tokens = tokenize(name)
	if (tokens.some((t) => PASSWORD_WORDS.has(t))) return 'password'
	if (tokens.some((t) => COLOR_WORDS.has(t))) return 'color'
	if (tokens.some((t) => RICHTEXT_WORDS.has(t))) return 'richtext'
	if (tokens.some((t) => GEO_WORDS.has(t))) return 'geo'
	if (tokens.some((t) => RATING_WORDS.has(t))) return 'rating'
	if (tokens.some((t) => DURATION_WORDS.has(t))) return 'duration'
	return null
}

/**
 * Whether a string column's *name* says it holds prose. Separate
 * from {@link specialtyHint} because it has no display dual — a paragraph still
 * reads as text; only the *input* changes.
 */
export function multilineHint(name: string): boolean {
	return tokenize(name).some((t) => MULTILINE_WORDS.has(t))
}

/**
 * Decide the semantic display kind for an introspected column. Pure and
 * synchronous — the whole point is that display and form derive from the same
 * inference, so both call into this module.
 */
/** The `meta.format` strings that name a specialty widget outright (rather than a
 * number/date presentation like `currency`/`percent`/`datetime`). */
function formatKind(format: string): FieldKind | null {
	switch (format) {
		case 'color':
			return 'color'
		case 'password':
			return 'password'
		case 'richtext':
		case 'html':
		case 'wysiwyg':
			return 'richtext'
		case 'markdown':
			return 'markdown'
		case 'json':
			return 'json'
		case 'duration':
			return 'duration'
		case 'rating':
			return 'rating'
		case 'geo':
		case 'coordinates':
			return 'geo'
		default:
			return null
	}
}

export function detectFieldKind(column: IntrospectedColumn): FieldKind {
	const meta = column.meta ?? {}
	const type = column.type

	// 1. Explicit metadata wins.
	if (meta.isFile === true) {
		const accept = meta.fileAccept ?? ''
		if (accept.includes('image') || nameHint(column.name) === 'image') {
			return 'image'
		}
		return 'file'
	}
	if (meta.markdown === true) return 'markdown'
	// An array of FKs (`tags`) wins over its underlying `json` type.
	if (meta.arrayReference) return 'reference-array'
	if (column.references) return 'reference'

	// 2. An explicit `format` naming a specialty widget (color/rating/geo/…).
	const fromFormat = formatKind((meta.format ?? '').toLowerCase())
	if (fromFormat) return fromFormat

	// 3. Enum: an `enum` type, introspected enum values, or metadata options.
	if (
		type === 'enum' ||
		(column.enumValues?.length ?? 0) > 0 ||
		(meta.options?.length ?? 0) > 0
	) {
		return 'enum'
	}

	// 4. Scalar types map directly.
	if (type === 'boolean') return 'boolean'
	if (type === 'date') return 'date'
	if (type === 'number') {
		// An explicit `format` beats the name, in both directions (#345). The
		// specialty formats (`rating`, `duration`) are already resolved at step 2,
		// so any format still standing here is a plain-number presentation —
		// including `'number'` itself, which exists for exactly this: it is the
		// escape hatch that keeps a column called `rating` a number input. Without
		// it the name decided the widget unopposably, and an author who did not
		// want stars had no sentence to say so.
		if (meta.format) return 'number'
		// A number's *name* can still ask for a richer read (`rating` → stars,
		// `durationSeconds` → 3m 20s); otherwise a plain formatted number.
		const s = specialtyHint(column.name)
		if (s === 'rating') return 'rating'
		if (s === 'duration') return 'duration'
		return 'number'
	}
	if (type === 'json') return 'json'

	// 5. String columns: name heuristics (email/url/image, then specialties).
	const hint = nameHint(column.name)
	if (hint === 'email') return 'email'
	if (hint === 'url') return 'url'
	if (hint === 'image') return 'image'
	const s = specialtyHint(column.name)
	if (s === 'password') return 'password'
	if (s === 'color') return 'color'
	if (s === 'richtext') return 'richtext'
	if (s === 'geo') return 'geo'

	return 'text'
}

/**
 * The form dual of `detectFieldKind`: which *rich / specialty* editor a column
 * asks for, or `null` when a plain schema-derived control is right. DynamicForm
 * consults this only to *upgrade* an inferred widget — the base structural
 * widgets (object / array / union / multi-select / select / checkbox) still come
 * from the Zod schema, which carries information a column can't (nested shape,
 * enum-array vs. single). Detection order mirrors `detectFieldKind` so a column
 * that displays as markdown also edits as a markdown editor.
 */
export function detectInputWidget(
	column: IntrospectedColumn,
): SpecialtyWidget | null {
	const meta = column.meta ?? {}
	const fmt = (meta.format ?? '').toLowerCase()

	if (meta.isFile === true) {
		const accept = meta.fileAccept ?? ''
		return accept.includes('image') || nameHint(column.name) === 'image'
			? 'image'
			: 'file'
	}
	if (meta.markdown === true || fmt === 'markdown') return 'markdown'
	if (fmt === 'richtext' || fmt === 'html' || fmt === 'wysiwyg')
		return 'richtext'
	if (fmt === 'color') return 'color'
	if (fmt === 'password') return 'password'
	if (fmt === 'json' || column.type === 'json') return 'json'
	if (fmt === 'duration') return 'duration'
	if (fmt === 'rating') return 'rating'
	if (fmt === 'slider' || fmt === 'range') return 'slider'
	if (fmt === 'geo' || fmt === 'coordinates') return 'geo'
	// An explicit declaration wins over the name, in both directions: `false`
	// keeps a field named `notes` on a single line.
	if (meta.multiline === true || fmt === 'multiline' || fmt === 'textarea')
		return 'textarea'

	// A reference / enum column is never a specialty widget even if its name
	// happens to token-match (e.g. an enum literally named `color`).
	if (column.references) return null
	if (
		column.type === 'enum' ||
		(column.enumValues?.length ?? 0) > 0 ||
		(meta.options?.length ?? 0) > 0
	) {
		return null
	}

	// The same escape hatch on the write side (#345): a number column whose format
	// is stated has had every specialty format resolved above, so what is left is
	// a plain number editor — and the name must not be allowed to overrule the
	// declaration, or `format: 'number'` would fix the display and leave the form
	// still editing with stars.
	if (column.type === 'number' && fmt) return null

	const specialty = specialtyHint(column.name)
	if (specialty) return specialty
	// Prose-shaped string columns edit as a textarea: `string` is
	// the only canonical type a tasting note, a bio or an address can be, and a
	// single-line input is unpleasant for all three.
	if (
		column.type === 'string' &&
		meta.multiline !== false &&
		multilineHint(column.name)
	) {
		return 'textarea'
	}
	return null
}
