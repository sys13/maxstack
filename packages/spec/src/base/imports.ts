/**
 * Declared importers — "this file, mapped onto these columns, with
 * this key deciding what an existing row means" as spec-as-data.
 *
 * One corpus ask fixes the shape: cardstack's *"import decks from an Anki
 * `.apkg` archive"*. It is worth naming the two halves of that ask separately,
 * because they get different answers and conflating them is how this primitive
 * would go wrong. The generic half — read a tabular file, map its columns onto
 * an entity's fields, validate every row, show what would change, then write —
 * is the same in every product that has ever shipped an importer, and it is
 * declarable. The bespoke half — parsing a zipped SQLite archive with a media
 * folder in it — is genuinely code, and pretending a declaration could express
 * it would be the framework-as-cage failure the whole L2 program is arranged to
 * avoid. So the bespoke half stops at *parsing*, in a user-owned slot, and the
 * records it yields re-enter the identical mapping/validation/write pipeline a
 * CSV takes.
 *
 * ## The four properties, in the order they constrain the design
 *
 * 1. **Import is the easiest way to destroy a user's data**, and the mandatory
 *    dry-run is therefore *structural* rather than a policy. The runtime's
 *    `opApplyImport` takes an `ImportPlan` and nothing else, and only
 *    `planImport` can produce one — so a write cannot happen without a plan
 *    somebody could have read first. A rule saying "always dry-run" is a rule
 *    with an exception in it by next quarter; a signature that cannot express
 *    the shortcut has none.
 * 2. **The upsert key is required, nullable, and its own op.**
 *    {@link ImporterSpec.upsertFieldId} is the single lever that decides whether
 *    running this importer can overwrite rows somebody already has. `null` means
 *    insert-only. It is never defaulted, because a defaulted upsert key is the
 *    "just overwrite everything" path the issue forbids, arrived at by whoever
 *    wrote the code generator rather than by whoever owns the table. And
 *    `imports.setUpsertKey` is a separate op so a reviewer can answer "can this
 *    destroy data?" from the op *name*, without reading the args of a
 *    general-purpose edit.
 * 3. **There is no delete path at all.** No `deleteMissing`, no "replace the
 *    table", no truncate. A destructive import behind a friendly wizard is worse
 *    than no importer, and the shape of that feature is always the same: a
 *    checkbox that reads as tidy-up and means "delete every row this file does
 *    not mention", ticked by somebody who exported a filtered view. Reconciling
 *    a local table against a remote truth is a real capability — it is a *sync*
 *,
 *    not a file upload.
 * 4. **A row is only importable if a form would accept it.** The runtime
 *    validates every row with the exact `validateData` the forms use and writes
 *    through `opCreate`/`opUpdate`, so an import cannot be the way invalid data
 *    gets past the rules, and tenancy stamping, soft-delete scoping, per-value
 * caps, the audit attribution and the custom
 *    validation hook are all inherited rather than re-implemented.
 *
 * ## What is deliberately not here
 *
 * **A transform language.** A column maps to a field and the *field's declared
 * type* is what the cell is parsed as — the same bargain `SourceMapping` strikes,
 * for the same reason: a second type declaration is a second thing to drift from
 * the column's. Splitting a full name into two columns, or looking a code up
 * against another table, is what the parser slot is for.
 *
 * **A saved mapping wizard.** The mapping is in the spec, which is committed and
 * diffed. A mapping a user drew in a modal and the server remembered is a
 * declaration with no review, no history and no diff.
 *
 * **Scheduled or URL-sourced imports.** An importer reads bytes somebody handed
 * it. Pulling a file from a third party on a timer is `sources` plus `schedules`,
 * both of which already exist and both of which have the failure handling that
 * a repeated remote read needs and a one-shot upload does not.
 */

import type { EntityId, FieldId, ImporterId, ISODate } from './ids.ts'
import { getAcceptedOrAll, type Provenanced } from './provenance.ts'
import type { SpecSystem } from './spec-system.ts'

// ===========================================================================
// The declaration
// ===========================================================================

/**
 * What the uploaded bytes are.
 *
 * The three built-ins are the three shapes a tabular export actually arrives in,
 * and each is parsed incrementally over chunks — see `sprout/import-parse.ts` —
 * so a large file costs memory proportional to one row, not to the file.
 *
 * `custom` is the honest fourth: the platform does not know how to read a
 * `.apkg`, an `.xlsx` or a vendor's proprietary dump, and the difference between
 * saying so and pretending otherwise is the difference between a slot and a cage.
 * A `custom` importer names {@link ImporterSpec.parserSlot} and the user owns
 * that one module; everything downstream of it is identical to a CSV's.
 */
export type ImportFormat = 'csv' | 'ndjson' | 'json' | 'custom'

/** Runtime guard for {@link ImportFormat} — ops arrive as JSON. */
export const IMPORT_FORMATS = [
	'csv',
	'ndjson',
	'json',
	'custom',
] as const satisfies readonly ImportFormat[]

/**
 * One column of the file landing on one field of the entity.
 *
 * `column` is the header name for `csv` and the object key for `ndjson`/`json`
 * and for whatever a custom parser yields — one concept rather than two, because
 * every parser here produces the same thing: a record keyed by strings.
 */
export interface ImportColumn {
	/** The header/key in the file. Matched exactly, after trimming. */
	column: string
	/** The entity field it lands on. Its declared type is how the cell is parsed. */
	fieldId: FieldId
}

/**
 * A declared importer.
 *
 * **Several importers per entity are allowed**, and that is a considered
 * difference from a search index rather than an oversight. An entity has exactly
 * one answer to "what does searching this mean", so a second index would be a
 * second answer with nothing to say which one a search box gets. But "import a
 * CSV our old tool exported" and "import an Anki deck" are two genuinely
 * different files about one table, with different columns, different formats and
 * different upsert keys — the same cardinality a document template has, and for
 * the same reason: the declaration describes an *input*, and a table can have
 * more than one.
 */
export interface ImporterSpec extends Provenanced {
	id: ImporterId
	/**
	 * The stable key the importer carries in its URL, in every audit entry it
	 * writes, and — for a `custom` importer — in the name of the parser module the
	 * user owns. Separate from {@link id} for the reason a source's key is: it is
	 * the string a person types and a support ticket quotes.
	 */
	key: string
	/** What this importer is for, in one line. Rendered in admin and the workbench. */
	description: string
	/** The entity the rows land in. */
	entityId: EntityId
	format: ImportFormat
	/**
	 * The user-owned parser module (`imports/<key>.parse.ts`). **Required iff
	 * `format === 'custom'`, and refused otherwise** — a parser slot on a CSV
	 * importer would be a second, silent way to reinterpret a file the platform
	 * already knows how to read, and the two would disagree the first time
	 * somebody changed one.
	 */
	parserSlot?: string
	/**
	 * File columns → entity fields. At least one, at most
	 * {@link MAX_IMPORT_COLUMNS}, no column twice and no field twice.
	 *
	 * Both duplicate rules matter and they fail differently. Two rows for one
	 * `column` is a file column with two destinations, which is a transform the
	 * mapping cannot express. Two rows for one `fieldId` is *two file columns
	 * writing one field*, where the winner is whichever the runtime happens to
	 * apply last — a silent data loss that depends on declaration order.
	 */
	columns: ImportColumn[]
	/**
	 * The field whose value decides whether a row already exists.
	 *
	 * **Required and nullable, never defaulted.** `null` is insert-only: every row
	 * in the file becomes a new row, and nothing that already exists is touched.
	 * A non-null value means the importer may *overwrite* — which is the single
	 * most consequential fact about it, so the spec makes stating it unavoidable
	 * rather than making the destructive option the one you get by not thinking
	 * about it.
	 *
	 * Constrained to {@link upsertKeyFieldTypes}: a key has to identify a row.
	 * A `boolean` key would collapse the entire table onto two rows on the first
	 * run — that *is* "just overwrite everything", spelled as a field id — and it
	 * is refused structurally rather than warned about. See
	 * {@link upsertKeyFieldTypes} for why `date`, `json` and `file` are out too.
	 *
	 * It must also appear in {@link columns}: you cannot match on a value the file
	 * does not supply.
	 */
	upsertFieldId: FieldId | null
	/**
	 * The most rows one run may take in. **Required**, bounded by
	 * {@link MAX_IMPORT_ROWS}.
	 *
	 * Exceeding it **fails the whole run** rather than truncating. A silently
	 * truncated import looks exactly like a successful one — same green banner,
	 * same "imported N rows" — and the missing rows are discovered weeks later by
	 * somebody who assumes they were never in the file.
	 */
	maxRows: number
	/**
	 * Whether the importer accepts uploads at all.
	 *
	 * **Required, never defaulted**, on the same posture `SearchIndexSpec.indexed`
	 * and `SourceSpec.paused` take: "is this write path open" is a decision about
	 * somebody's production data. A paused importer keeps its declaration, its
	 * mapping and its parser file and simply refuses to run — which is what makes
	 * `imports.pause` the operation somebody reaches for when a partner's export
	 * changed shape, instead of `imports.remove`.
	 */
	paused: boolean
	/** The day the importer was declared, stamped by `applyOp` from `appliedAt`. */
	declaredAt: ISODate
}

export interface ImportsSpec {
	importers: ImporterSpec[]
}

// ===========================================================================
// Shapes and bounds
// ===========================================================================

/** An importer key: the same shape as a flag's or an index's, for the same reasons. */
export const IMPORT_KEY_RE = /^[a-z][a-z0-9-]*$/

/**
 * How long an importer key may be.
 *
 * The key is a URL segment, a module name and an audit-metadata value. 48 is the
 * same bound a search index key carries, chosen there because Postgres truncates
 * identifiers; here the reason is plainer but no weaker — a key long enough to
 * wrap in a log line is a key that gets copied wrongly into a support ticket.
 */
export const MAX_IMPORT_KEY_LENGTH = 48

/**
 * The parser module a `custom` importer names. Dots are allowed (a key like
 * `anki.apkg` reads naturally) and are flattened to `-` in the filename by
 * {@link importerModuleName}, so the module path stays a single flat segment.
 */
export const IMPORT_PARSER_SLOT_RE = /^[a-z][a-z0-9.-]*$/

/**
 * How many columns one importer may map.
 *
 * Past this the file is not an import of an entity, it is a spreadsheet somebody
 * wants a database for — and the honest answer to that is more entities, not a
 * wider mapping. It is also the practical bound on the review surface: a dry-run
 * report is read by a person, and a 200-column table is not read at all.
 */
export const MAX_IMPORT_COLUMNS = 48

/**
 * The hard ceiling on {@link ImporterSpec.maxRows}.
 *
 * A plan is held in memory so it can be shown, checked and confirmed as a whole
 * — that is the price of the dry-run being mandatory — so the row count has an
 * absolute cap and not just a declared one. 50,000 rows of planned values is a
 * few tens of megabytes and is comfortably a *file somebody uploaded*; past that
 * the honest tool is a backfill script with a database connection, and saying so
 * is better than an importer that dies halfway with a heap error.
 */
export const MAX_IMPORT_ROWS = 50_000

/**
 * The field types a column may land on, and there is exactly one exclusion.
 *
 * `file` is refused outright. A file column holds a **storage key that only the
 * upload path can mint**; a value in a CSV is at best a key nobody minted, which
 * resolves to nothing, and at worst somebody else's key. `sources` refuses a
 * remote URL into a file column on precisely this argument, and an import is the
 * same mistake with a local file in front of it. Ingesting the bytes a file
 * *names* is a real capability and it is not this one.
 *
 * Everything else is importable — including `json`, whose cell is parsed as JSON
 * and refused per-row if it is not, and `date`, whose cell goes through the same
 * schema a form's date input does.
 */
export const importableFieldTypes: readonly string[] = [
	'string',
	'number',
	'boolean',
	'date',
	'enum',
	'json',
]

/**
 * The field types an upsert key may have, and every exclusion is a way rows get
 * destroyed rather than a matter of taste:
 *
 * - `string`, `number`, `enum` — yes. Each can carry an identity: a SKU, an
 *   external id, a slug. An `enum` is a *narrow* identity and matching on one is
 *   usually a mistake, but it is a legible mistake in a diff and there are real
 *   single-row-per-status tables; refusing it would be this module deciding a
 *   domain question.
 * - `boolean` — no, and this is the important one. A boolean key partitions the
 *   whole table into two buckets, so the first run overwrites every row in the
 *   table with the last matching row of the file. That is literally "just
 *   overwrite everything", reachable by picking the wrong field from a dropdown,
 *   and the issue's gating bullet forbids it — so it is refused at validate time
 *   rather than warned about at run time.
 * - `date` — no. A timestamp is a *when*, not a *which*. Matching on one is
 *   either a no-op (nothing has the same microsecond) or a catastrophe (every row
 *   sharing a day collapses), and which of the two you get depends on the
 *   precision the exporting tool happened to use.
 * - `json` — no. Equality on a JSON document is equality on its serialization, so
 *   two identical documents with keys in a different order are two different
 *   rows, and the same document reserialized is a third.
 * - `file` — no, and doubly: it is not importable at all (above), and a storage
 *   key is an identity of a blob rather than of a row.
 */
export const upsertKeyFieldTypes: readonly string[] = [
	'string',
	'number',
	'enum',
]

/** An importer key as a filesystem-safe module name (`anki.apkg` → `anki-apkg`). */
export function importerModuleName(key: string): string {
	return key.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')
}

// ===========================================================================
// Reading the layer
// ===========================================================================

/** Every declared importer, or `[]` for a spec that has never declared one. */
export function listImporters(
	spec: Pick<SpecSystem, 'imports'>,
): ImporterSpec[] {
	return spec.imports?.importers ?? []
}

/**
 * The importers a runtime will actually run: grounded by the same
 * accepted-else-all rule every other layer uses, minus the paused ones —
 * `activeSources`' rule exactly.
 *
 * An importer an agent proposed and nobody accepted does not start accepting
 * uploads, which is the entire point of having a review queue in front of a
 * vocabulary that can now write rows from a file.
 */
export function activeImporters(
	spec: Pick<SpecSystem, 'imports'>,
): ImporterSpec[] {
	return getAcceptedOrAll(listImporters(spec)).filter((i) => !i.paused)
}

/** The declared importer with this key, if any. Keys are unique spec-wide. */
export function findImporter(
	spec: Pick<SpecSystem, 'imports'>,
	key: string,
): ImporterSpec | undefined {
	return listImporters(spec).find((i) => i.key === key)
}

/** Every declared importer that writes into one entity. */
export function importersFor(
	spec: Pick<SpecSystem, 'imports'>,
	entityId: EntityId,
): ImporterSpec[] {
	return listImporters(spec).filter((i) => i.entityId === entityId)
}

/**
 * One line of prose for an importer — the diff summary, the admin caption and
 * the stub header.
 *
 * It always names the write posture, because that is the fact a reader of a diff
 * most needs and least expects to have to look up.
 */
export function describeImporter(importer: ImporterSpec): string {
	const write =
		importer.upsertFieldId === null
			? 'insert-only'
			: `upsert on ${importer.upsertFieldId}`
	const parser =
		importer.format === 'custom'
			? ` via ${importer.parserSlot ?? 'a parser slot'}`
			: ''
	const paused = importer.paused ? ', paused' : ''
	return `${importer.format}${parser} → ${importer.entityId}, ${write}, max ${importer.maxRows} rows${paused}`
}
