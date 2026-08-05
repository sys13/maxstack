/**
 * Declared document generation — "this row, laid out like this, is
 * what an invoice looks like" as spec-as-data.
 *
 * One corpus ask fixes the shape: invoicer's *"render a branded, print-ready PDF
 * of an invoice"*. It is worth being precise about why that was off-surface,
 * because "just render a page and hit print" is the objection this primitive has
 * to answer. A generated admin page is a *list* surface: it is bound to a route
 * and a viewer, it paginates by scrolling, it has no page size, and printing it
 * gives you a screenshot of an app. An invoice is one row, on paper, with a
 * fixed width, in an envelope or an email attachment. Nothing in the page
 * vocabulary describes that, so every product that needed one ejected.
 *
 * ## The five properties, in the order they constrain the design
 *
 * 1. **A document is one row and no viewer.** {@link DocumentTemplateSpec} binds
 *    to an entity, not a page, and rendering it always starts from a single
 *    primary key. That is what makes the access story trivial rather than novel:
 *    rendering is a `read` of that row, through the same gate `opGet` passes,
 *    and every related row a section pulls in passes its *own* gate. There is no
 *    document-shaped permission concept, because a document that could show you
 *    a row you may not read would be a leak wearing a letterhead.
 * 2. **It must not become a second UI system.** This is the gate epic #163's
 *    child issue states outright, and the answer is subtraction: the section
 *    vocabulary below is closed, has six members, and every one of them is a
 *    *paper* primitive rather than a component. There is no nesting, no width,
 *    no color, no layout language — a section is a heading, a paragraph, a
 *    labelled block of the row's own fields, a table of related rows, a rule, or
 *    a slot. What it does reuse is stated in {@link DocumentTableSection} and
 *    {@link DocumentFieldsSection}: relation traversal is `over`/`via`, spelled
 *    exactly as `RollupSpec` spells it, and a total is a *rollup*, so this layer
 *    ships no aggregation of its own.
 * 3. **Theming is the app's theme.** A template declares no color, no font and
 * no spacing. Rendering resolves `theme` and both backends read
 *    it, so "make the invoice match the product" is a `theme.set` that was
 *    already there. A parallel document-theme vocabulary would be the second
 *    styling system the gate forbids, one indirection away.
 * 4. **The same declaration renders to paper and to bytes.** A template is
 *    compiled to a layout — text runs, labelled pairs, table rows, rules — and
 *    two backends serialize that layout: print-ready HTML and PDF. They cannot
 *    disagree about *content*, only about pixels, because neither one reads the
 *    template. This is also why PDF costs nothing at the deploy boundary: the
 *    PDF backend writes the file directly, so there is no headless browser in
 *    the runtime image. See `@maxstack/core`'s `sprout/documents/`.
 * 5. **Same row plus same template ⇒ the same bytes.** There is deliberately no
 *    `{today}` placeholder and no "generated at" section. A document whose
 *    output changes every time you ask for it cannot be diffed, cached, or
 *    compared against the copy a customer says they received. An issue date is a
 *    `date` *field* on the row, which is where it belongs anyway — the invoice
 *    was issued on a day, and that day is a fact about the invoice, not about
 *    the render.
 *
 * ## What is deliberately not here
 *
 * **A layout language.** No columns beyond a one-or-two-column pair block, no
 * absolute positioning, no page-break control. Every one of those is the first
 * step of the second UI system, and the escape hatch for a heavily-designed
 * document is {@link DocumentSlotSection} — bespoke layout as a slot fill rather
 * than an eject of the whole surface, which is the ladder rung the issue asks
 * for.
 *
 * **Uploaded logos.** A branded document wants a logo, and a logo is a `file`
 * field belonging to some settings row. Reaching arbitrary rows
 * from a template would mean a second data-access path with its own gate, which
 * is property 1 undone. A logo therefore arrives through a slot, and the
 * follow-up is scoped as its own ask rather than smuggled in here.
 */

import type {
	DerivedId,
	DocumentTemplateId,
	EntityId,
	FieldId,
	ISODate,
} from './ids.ts'
import { getAcceptedOrAll, type Provenanced } from './provenance.ts'
import type { SpecSystem } from './spec-system.ts'

// ===========================================================================
// The declaration
// ===========================================================================

/**
 * The physical paper the document is laid out for.
 *
 * Two values, and the reason there are exactly two is that this is the one
 * property of a document that is genuinely about the world rather than about
 * taste: A4 and US Letter are what printers hold, and a document laid out for
 * the wrong one loses a strip off the bottom or grows a blank one. It is on the
 * template rather than on a global setting because an invoicer with clients on
 * two continents sends both.
 */
export type DocumentPageSize = 'a4' | 'letter'

/** Runtime guard for {@link DocumentPageSize} — ops arrive as JSON. */
export const DOCUMENT_PAGE_SIZES = [
	'a4',
	'letter',
] as const satisfies readonly DocumentPageSize[]

/**
 * The two render targets, and the only two.
 *
 * `html` is print-ready HTML — an `@page`-sized document with the theme's tokens
 * inlined, correct in a browser's print dialog and cheap to serve. `pdf` is the
 * file people attach to email and archive. They are produced from one compiled
 * layout, so a caller choosing between them chooses a container, never a
 * different document.
 */
export type DocumentFormat = 'html' | 'pdf'

/** Runtime guard for {@link DocumentFormat}. */
export const DOCUMENT_FORMATS = [
	'html',
	'pdf',
] as const satisfies readonly DocumentFormat[]

/** The section kinds a template may compose. Closed, and small on purpose. */
export type DocumentSectionKind = (typeof DOCUMENT_SECTION_KINDS)[number]

export const DOCUMENT_SECTION_KINDS = [
	'heading',
	'text',
	'fields',
	'table',
	'rule',
	'slot',
] as const

/**
 * A heading — the document's own structure, not the app's navigation.
 *
 * `text` may carry `{fieldName}` placeholders resolved against the row, which is
 * how "Invoice {number}" becomes a title that identifies the document rather
 * than its type. Placeholders are validated against the entity's field names at
 * op time, so a renamed field fails the op instead of printing `{number}` on
 * something a customer receives.
 */
export interface DocumentHeadingSection {
	kind: 'heading'
	/** `1` for the document title, `2` for a section head. There is no `3`. */
	level: 1 | 2
	text: string
}

/** A paragraph of static prose — terms, a remittance note, a thank-you. Placeholders allowed. */
export interface DocumentTextSection {
	kind: 'text'
	text: string
}

/**
 * A labelled block of the row's own values — the "Bill to" block, the dates, the
 * total.
 *
 * The fields are named by **id**, and derived values (a computed field or a
 * rollup) are named the same way. That last part is the whole reason
 * this layer ships no arithmetic: an invoice total is a `sum` rollup over the
 * line items, which is a declaration that already exists, is already tested, and
 * is already the number the *app* shows. A document that computed its own total
 * would be a second answer to "what does this invoice come to", and the two
 * would eventually disagree in front of a customer.
 *
 * Labels come from the field's own name, so a renamed field renames its label —
 * the same rule the generated forms follow, and the reason a document does not
 * carry a parallel set of captions to keep in step.
 */
export interface DocumentFieldsSection {
	kind: 'fields'
	/** Field or derived-value ids on the template's entity. Order is the print order. */
	fieldIds: (FieldId | DerivedId)[]
	/** Pairs down one column or two. Two is the default shape of an address block. */
	columns: 1 | 2
	/** Optional block caption ("Bill to"). Placeholders allowed. */
	caption?: string
}

/**
 * A table of related rows — the line items, the payments, the deliveries.
 *
 * **`over`/`via` are spelled exactly as `RollupSpec` spells them**, and mean
 * exactly the same thing: `over` is the entity on the many side, `via` is the
 * foreign key on it pointing back at this row. That is not a coincidence to be
 * tidied up later — it is the reuse this primitive is required to demonstrate.
 * A template names a relation the same way a rollup does, so the total in a
 * {@link DocumentFieldsSection} and the lines in this one are provably the same
 * set of rows.
 *
 * Rendering fetches those rows through the child entity's *own* read gate. A
 * table of rows the viewer may not list comes back empty rather than printed,
 * which is the only behaviour that keeps property 1 true when a document spans
 * two tables.
 */
export interface DocumentTableSection {
	kind: 'table'
	/** The entity on the many side. */
	over: EntityId
	/** The foreign key on {@link over} pointing back at the template's entity. */
	via: FieldId
	/** Columns, in print order. Fields or derived values on {@link over}. */
	fieldIds: (FieldId | DerivedId)[]
	/** Optional caption above the table. Placeholders allowed (resolved against the parent row). */
	caption?: string
	/**
	 * How the rows are ordered, by a field of {@link over}. Optional, and when it
	 * is absent the rows come back in primary-key order — *not* in whatever order
	 * the table happens to be in. A document with an unstable row order is not
	 * byte-identical on a re-render, which is the determinism property the whole
	 * design is arranged around.
	 */
	orderBy?: FieldId
	/** `asc` when absent. */
	direction?: 'asc' | 'desc'
}

/** A horizontal rule. The one piece of pure decoration, because paper needs it. */
export interface DocumentRuleSection {
	kind: 'rule'
}

/**
 * The escape hatch: bespoke layout for one region of the document.
 *
 * This is the rung the issue names — "a heavily-designed document is slot-fill
 * rather than an eject of the whole surface". The slot's fill returns layout
 * blocks, not HTML and not PDF operators, so a filled slot still renders to both
 * targets and still cannot reach a row the caller may not read: the data it is
 * handed is the data the gate already returned.
 */
export interface DocumentSlotSection {
	kind: 'slot'
	/** The registry name the owned module is filled under. */
	name: string
}

export type DocumentSection =
	| DocumentHeadingSection
	| DocumentTextSection
	| DocumentFieldsSection
	| DocumentTableSection
	| DocumentRuleSection
	| DocumentSlotSection

/**
 * Where a rendered document goes.
 *
 * All three targets are off by default — `{ download: false }` is a template
 * that renders nowhere, which is a useful state while one is being authored and
 * a required one while it is being retired (see `documents.remove`). Each target
 * beyond `download` composes an installed bundle, and that composition is the
 * point rather than a convenience: storage and email were built as bundles, and
 * a primitive that reaches both without either one growing a document-shaped
 * special case is the evidence that the bundle contract holds.
 */
export interface DocumentDelivery {
	/** Serve it over HTTP at the document route, in either format. */
	download: boolean
	/**
	 * Write it to the `storage` bundle under a path built from the row.
	 *
	 * The path is a placeholder template (`invoices/{number}.pdf`) so the object
	 * key is derived from the data rather than from a counter — re-storing the
	 * same invoice overwrites the same key instead of accumulating copies, which
	 * is the behaviour an archive needs and the one an auto-generated key cannot
	 * give.
	 */
	store?: DocumentStoreDelivery
	/** Attach it to a transactional email through the `email` bundle. */
	email?: DocumentEmailDelivery
}

export interface DocumentStoreDelivery {
	/** Object key template, e.g. `invoices/{number}.pdf`. Placeholders resolved against the row. */
	path: string
	format: DocumentFormat
}

export interface DocumentEmailDelivery {
	/** The registered email template the document is attached to. */
	template: string
	/** Subject line. Placeholders allowed. */
	subject: string
	/** Which recipient address to send to. See {@link DocumentRecipient}. */
	to: DocumentRecipient
	format: DocumentFormat
}

/**
 * Whose address a delivered document is sent to.
 *
 * One optional hop, and one only. `{ fieldId }` names a `string` field on the
 * template's own entity; `{ via, fieldId }` names a reference field on this
 * entity and a `string` field on the entity it points at — which is the invoice
 * case, because the address belongs to the client and duplicating it onto the
 * invoice to satisfy a template would be the spec telling the data model what
 * shape to be.
 *
 * It stops at one hop because two hops is a query, and a query is a path an
 * outbound email would traverse without anybody having written down which rows
 * it crosses. The referenced row is fetched through its own read gate like every
 * other row a document touches.
 */
export interface DocumentRecipient {
	/** A reference field on the template's entity. Omit to read from the row itself. */
	via?: FieldId
	/** A `string` field holding the address — on the referenced entity when `via` is set. */
	fieldId: FieldId
}

/**
 * A declared document template.
 *
 * **Several per entity, unlike a search index.** The one-per-entity rule that
 * search needs comes from there being one answer to "what does searching this
 * mean" and one physical index to pay for; neither applies here. An invoice has
 * an invoice, a receipt and a statement, they are three documents about the same
 * row, and the vocabulary would be lying if it made you pick one.
 */
export interface DocumentTemplateSpec extends Provenanced {
	id: DocumentTemplateId
	/**
	 * The stable key the template carries in its URL, in stored object paths and
	 * in logs. Separate from {@link id} for the reason a search index's key is: it
	 * is the string a person types, and ids are the spec's business.
	 */
	key: string
	/** What this document is, in one line. Rendered in admin and the workbench. */
	description: string
	/** The entity whose rows this template renders. One row per document. */
	entityId: EntityId
	pageSize: DocumentPageSize
	/** At least one, at most {@link MAX_DOCUMENT_SECTIONS}. */
	sections: DocumentSection[]
	delivery: DocumentDelivery
	/** The day the template was declared, stamped by `applyOp` from `appliedAt`. */
	declaredAt: ISODate
}

export interface DocumentsSpec {
	templates: DocumentTemplateSpec[]
}

// ===========================================================================
// Shapes and bounds
// ===========================================================================

/** A template key: the same shape as a flag's and a search index's, for the same reasons. */
export const DOCUMENT_KEY_RE = /^[a-z][a-z0-9-]*$/

/**
 * How long a template key may be.
 *
 * Unlike a search index's key this never becomes a database identifier, so the
 * 63-byte truncation argument does not apply. It becomes a **URL segment and an
 * object-key prefix**, and the bound is here so that a key cannot be long enough
 * to push a stored path past the 1024-byte limit S3-compatible stores enforce —
 * a delivery that fails only for the rows with long values in the path is the
 * worst shape of failure this layer could have.
 */
export const MAX_DOCUMENT_KEY_LENGTH = 48

/**
 * How many sections one template may hold.
 *
 * A bound rather than a limit anyone will reach: thirty-two paper sections is
 * already a contract rather than an invoice. It exists because sections are
 * rendered in one pass with no streaming, and an unbounded list is an unbounded
 * response built in memory for a caller who supplied one row id.
 */
export const MAX_DOCUMENT_SECTIONS = 32

/** How many pairs one `fields` section may print, and how many columns one table may have. */
export const MAX_DOCUMENT_SECTION_FIELDS = 24
export const MAX_DOCUMENT_TABLE_COLUMNS = 8

/**
 * How many related rows one `table` section prints.
 *
 * Documents are paper. Five hundred line items is forty pages, and the honest
 * failure for a row with more than that is a truncated table with a stated
 * count, not a request that runs until something times out. The renderer prints
 * the overflow as a line rather than silently dropping rows — a document that
 * quietly omits billable lines is the single worst bug this feature could ship.
 */
export const MAX_DOCUMENT_TABLE_ROWS = 500

/**
 * The field types a document may print, and the reason is one line per
 * exclusion:
 *
 * - `string`, `number`, `boolean`, `date`, `enum` — yes. All of them have an
 *   unambiguous printed form, and the renderer shares one formatter with the
 *   HTML and PDF backends so the two cannot disagree about it.
 * - `json` — no. Its printed form is punctuation, and a document is read by
 *   somebody who is not a programmer.
 * - `file` — no. The column holds an opaque storage key, so printing it prints
 *   the key. Embedding the *bytes* (a logo, a signature image) is a real
 *   capability and it is deliberately not this one — see the module comment.
 */
export const printableFieldTypes: readonly string[] = [
	'string',
	'number',
	'boolean',
	'date',
	'enum',
]

/** `{fieldName}` — the one placeholder syntax, shared with the sources layer. */
export const DOCUMENT_PLACEHOLDER_RE = /\{([^{}]+)\}/g

/** Every `{name}` in a template string, in order, deduplicated. */
export function documentPlaceholders(text: string): string[] {
	const names = new Set<string>()
	for (const match of text.matchAll(DOCUMENT_PLACEHOLDER_RE))
		if (match[1] !== undefined) names.add(match[1].trim())
	return [...names]
}

/** Whether any delivery target is enabled — what `documents.remove` requires to be false. */
export function hasActiveDelivery(delivery: DocumentDelivery): boolean {
	return Boolean(delivery.download || delivery.store || delivery.email)
}

// ===========================================================================
// Reading the layer
// ===========================================================================

/** Every declared template, or `[]` for a spec that has never declared one. */
export function listDocumentTemplates(
	spec: Pick<SpecSystem, 'documents'>,
): DocumentTemplateSpec[] {
	return spec.documents?.templates ?? []
}

/**
 * The templates a runtime actually renders: grounded by the same
 * accepted-else-all rule every other layer uses. A template an agent proposed
 * and nobody accepted does not start answering a public URL.
 */
export function activeDocumentTemplates(
	spec: Pick<SpecSystem, 'documents'>,
): DocumentTemplateSpec[] {
	return getAcceptedOrAll(listDocumentTemplates(spec))
}

/** The declared templates for an entity, in declaration order. */
export function documentTemplatesFor(
	spec: Pick<SpecSystem, 'documents'>,
	entityId: EntityId,
): DocumentTemplateSpec[] {
	return activeDocumentTemplates(spec).filter((t) => t.entityId === entityId)
}

/** The template with a given key, if it is declared and accepted. */
export function findDocumentTemplate(
	spec: Pick<SpecSystem, 'documents'>,
	key: string,
): DocumentTemplateSpec | undefined {
	return activeDocumentTemplates(spec).find((t) => t.key === key)
}

/**
 * One line of prose for a delivery declaration — the `documents.setDelivery`
 * diff summary, and the half of a template's description that a reviewer
 * checking "did this change what our customers receive" is actually reading.
 */
export function describeDelivery(delivery: DocumentDelivery): string {
	const targets = [
		delivery?.download ? 'download' : undefined,
		delivery?.store ? `store (${delivery.store.path})` : undefined,
		delivery?.email ? `email (${delivery.email.template})` : undefined,
	].filter(Boolean)
	return targets.length
		? targets.join(' + ')
		: 'nothing — the template is retired'
}

/** One line of prose for a template — the diff summary and the admin caption. */
export function describeDocumentTemplate(
	template: DocumentTemplateSpec,
): string {
	const counts = new Map<DocumentSectionKind, number>()
	for (const section of template.sections ?? [])
		counts.set(section.kind, (counts.get(section.kind) ?? 0) + 1)
	const shape =
		[...counts]
			.map(([kind, n]) => `${n} ${kind}`)
			.sort()
			.join(', ') || 'no sections'
	return `${template.pageSize} over ${template.entityId} — ${shape}; ${describeDelivery(template.delivery)}`
}
