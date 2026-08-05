/**
 * Sprout core types. See docs/reference-specs/sprout.md.
 *
 * `ColumnMetadata` is the full declared surface from the specbase reference.
 * Unlike the original — which introspected only ~10 keys and silently dropped
 * the rest — the reimplementation carries the whole object through
 * introspection and honors the validation-relevant keys in the Zod generator
 * (see validation.ts). That is a deliberate improvement recorded in
 * the reference design.
 */

export type SproutColumnType =
	| 'string'
	| 'number'
	| 'boolean'
	| 'date'
	| 'uuid'
	| 'enum'
	| 'json'

export interface SproutColumnReference {
	table: string
	column: string
	displayField?: string
	/**
	 * SQL type of the referenced id — `text` for bundle infra tables (better-auth
	 * user ids are text), omitted/`uuid` for spec-entity ids. Drives
	 * the type of the FK column the spec bridge materializes.
	 */
	idType?: 'text' | 'uuid'
}

/** One declared image variant, mirrored from the spec's `FileDerivativeSpec`
 * (structurally — core does not import `@maxstack/spec`). */
export interface FileDerivativeMeta {
	name: string
	width: number
	height?: number
	fit?: 'cover' | 'contain'
}

export interface ColumnMetadata {
	label?: string
	description?: string
	placeholder?: string
	hidden?: boolean
	readOnly?: boolean
	markdown?: boolean
	helpText?: string
	helperText?: string
	tooltip?: string
	// file
	isFile?: boolean
	fileAccept?: string
	fileMaxSize?: number
	/**
	 * Declared image derivatives — the variants the upload path
	 * materialized alongside the original, addressable as `<key>@<name>`. Carried
	 * on the column so a read surface can render a thumbnail without knowing
	 * which entity it is looking at.
	 */
	fileDerivatives?: FileDerivativeMeta[]
	/**
	 * The resource this file column belongs to. Carried so the upload widget can
	 * name the field it is uploading *for*, which is what lets the server look up
	 * the declared allowlist and cap and enforce those rather than one app-wide
	 * default. The client's copy is a hint; the server re-reads the declaration.
	 */
	fileResource?: string
	// numeric
	min?: number
	max?: number
	step?: number
	// string
	minLength?: number
	maxLength?: number
	pattern?: RegExp
	// options
	options?: { label: string; value: string }[]
	enumValues?: string[]
	/**
	 * Per-value row caps on an enum column — `{ doing: 3 }` is a
	 * Kanban WIP limit of three. Enforced in `opCreate`/`opUpdate`, which is what
	 * makes it a rule rather than a hint: REST, MCP, the admin form and a board
	 * drag all go through those two functions, and none of them can opt out.
	 *
	 * It lives on the *column* so the enforcement point and the display point read
	 * the same declaration — a board drawing "2 / 3" and a server refusing the
	 * third write cannot drift apart.
	 */
	valueLimits?: Record<string, number>
	/**
	 * This column is a manual-ordering key: an opaque string the
	 * platform writes and a person reorders by dragging. Carried so the ordering
	 * surfaces (and the create path, which stamps one) can recognise it without
	 * being told which column it is.
	 */
	rankKey?: boolean
	/**
	 * This column is encrypted at rest. The stored value is an
	 * AES-256-GCM envelope; the plaintext exists only inside a request that was
	 * allowed to see it. Carried on the column so the seal-on-write and
	 * open-on-read happen at the one depth every caller reaches (`operations.ts`)
	 * rather than in whichever surface remembered.
	 */
	encrypted?: boolean
	/**
	 * How this column is rendered to a caller who may not see its value —
	 * `redact`, `last4` or a keyed `hash`, plus the roles that read it
	 * unmasked. Distinct from {@link hidden}, which removes the column entirely:
	 * "this record has a tax id on file" is often exactly what a support user
	 * needs to know while the value is what they must not see.
	 */
	mask?: { style: 'redact' | 'last4' | 'hash'; unmaskRoles?: string[] }
	// formatting
	format?: string
	prefix?: string
	suffix?: string
	rows?: number
	// behavioral
	required?: boolean
	sortable?: boolean
	filterable?: boolean
	// relational
	reference?: SproutColumnReference
	/**
	 * The "many" side of a reference (Plan v5 task 38): this column holds an
	 * *array* of foreign keys — `post.tags` = `["<tagId>", …]` referencing `tag`.
	 * The sanctioned minimal spec touch — a reference is data, not presentation
	 * (same justification as {@link reference}). Resolved the same way a single FK
	 * is (`resolveReferences` flattens the array into the batched `getMany`), and
	 * rendered as chips by `<ReferenceArrayField>` / edited by
	 * `<ReferenceArrayInput>`. The column type is `json` (it stores an array).
	 */
	arrayReference?: SproutColumnReference
	defaultValue?: unknown
	// escape hatch (matches the original's index signature)
	[key: string]: unknown
}

export interface SproutColumn {
	name: string
	type: SproutColumnType
	nullable: boolean
	hasDefault: boolean
	isPrimaryKey: boolean
	enumValues?: string[]
	references?: SproutColumnReference
	/** The surviving metadata (empty object when none was attached). */
	meta: ColumnMetadata
}

/**
 * An outbound relation from this resource. The specbase original left
 * `relations` permanently `[]`; we build the graph from the resource's own
 * columns (improvement per the reference design.4).
 *
 * Every way a column can point at another table produces an entry here
 *:
 *
 *   - a real drizzle inline foreign key (the demo/owned-code schemas), and
 *   - a `meta.reference` / `meta.arrayReference` carried by the spec→Sprout
 *     bridge, which is how **every** maxstack project's references arrive.
 *
 * That second case is the whole point. Building the graph from drizzle FKs
 * alone left `relations` empty for every spec-driven project while
 * `column.references` was populated, so a consumer reading the graph saw a
 * project with no relationships and was correct in form but wrong in fact.
 */
export interface SproutRelation {
	/** Suggested accessor name, e.g. `author` for `author_id`. */
	name: string
	/**
	 * `many-to-one` — the column holds one id.
	 * `many-to-many` — the column holds an *array* of ids (`meta.arrayReference`,
	 * task 38). Distinguished rather than flattened because a consumer that
	 * dereferences the column has to know whether it is reading a value or a
	 * list; a walker that assumed the former would silently read the first id.
	 */
	type: 'many-to-one' | 'many-to-many'
	/** Local FK column name. */
	column: string
	references: { table: string; column: string }
}

export interface SproutResource {
	/** The DB table name — the registry key. */
	name: string
	primaryKey: string
	columns: SproutColumn[]
	relations: SproutRelation[]
}
