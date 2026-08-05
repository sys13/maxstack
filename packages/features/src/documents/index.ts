/**
 * Document delivery — where a rendered document goes.
 *
 * The renderer lives in `@maxstack/core` and knows nothing about storage or
 * email. This module is the composition, and composing is the point: the issue
 * asks for document generation as *"a good early proof that bundles compose"*,
 * so the test of this file is what it did **not** have to change.
 *
 * It did not have to change the storage bundle. A rendered document is bytes and
 * a content type, which is exactly what `StorageProvider.put` already takes.
 *
 * It changed the email bundle by exactly one field: `OutgoingEmail.attachments`.
 * That is a general email capability — a receipt, a report, a CSV export all
 * want it — and nothing in the email bundle learned what a document is. Had the
 * shape of this feature required `email` to grow a `renderDocument` call or
 * `storage` to grow a `documentKey` helper, that would have been the evidence
 * pointing the other way, and worth reporting as such.
 *
 * ## The access rule travels with the bytes
 *
 * The issue's RBAC criterion covers *"a stored or emailed copy"*, and this
 * module is where that could have been lost. It is not, and the reason is
 * structural: nothing here fetches a row. {@link deliverDocument} takes a
 * layout, and the only thing that produces a layout is `opRenderDocument`, which
 * is built out of `opGet` and `opList`. A background job storing an invoice
 * therefore passes the same gate as a person clicking Download — because it has
 * no other way to get the invoice.
 */

import {
	type BoundFont,
	type DocumentFormat,
	type DocumentLayout,
	type DocumentPageSize,
	type DocumentPlan,
	type DocumentRow,
	documentHtml,
	documentPdf,
	resolveDocumentPath,
	resolveDocumentText,
} from '@maxstack/core'
import type { Mailer, SentMessage } from '../email/mailer.ts'
import { renderEmail } from '../email/mailer.ts'
import type { EmailRegistry } from '../email/registry.ts'
import type { StorageProvider, StoredObject } from '../storage/provider.ts'

/** A rendered document: the bytes, what they are, and what to call the file. */
export interface RenderedDocument {
	bytes: Uint8Array
	contentType: string
	/** A download filename, derived from the template key and the row. */
	filename: string
	format: DocumentFormat
}

export const DOCUMENT_CONTENT_TYPES: Record<DocumentFormat, string> = {
	// `charset=utf-8` on the HTML because it is served and mailed as-is; the PDF
	// is bytes and carries its encoding internally.
	html: 'text/html; charset=utf-8',
	pdf: 'application/pdf',
}

/**
 * Serialize a compiled layout into one of the two formats.
 *
 * The single place the format is chosen. Both branches read the *same* layout,
 * which is what makes "the PDF we filed and the HTML you saw" provably the same
 * document rather than a claim.
 */
export function renderDocument(
	layout: DocumentLayout,
	plan: DocumentPlan,
	format: DocumentFormat,
	opts: {
		/**
		 * The font this deployment bound, if any. PDF only — the HTML
		 * target has never had a character-set limit, because a browser has every
		 * font the reader has.
		 *
		 * Threaded through rather than read from the environment here so that this
		 * module stays a pure function of its arguments: a renderer that reached
		 * for a global would make "the PDF we filed and the HTML you saw are the
		 * same document" depend on when it ran.
		 */
		font?: BoundFont
	} = {},
): RenderedDocument {
	const bytes =
		format === 'pdf'
			? documentPdf(layout, plan.style, plan.pageSize as DocumentPageSize, {
					...(opts.font ? { font: opts.font } : {}),
				})
			: new TextEncoder().encode(
					documentHtml(layout, plan.style, plan.pageSize as DocumentPageSize),
				)
	return {
		bytes,
		contentType: DOCUMENT_CONTENT_TYPES[format],
		filename: documentFilename(layout, plan, format),
		format,
	}
}

/**
 * The filename a download is offered under: `<title>.<ext>`, slugged.
 *
 * The stem is the **document's own title** — its first level-1 heading, already
 * resolved, which for an invoice reads "Invoice INV-1042". That is the string
 * the reader is looking at, so it is the one they expect the saved file to
 * carry, and taking it from the layout rather than guessing at a field means the
 * filename cannot disagree with the page.
 *
 * Slugged through the same resolver a stored object key uses, so it cannot be
 * talked into a directory separator by a row value, and it falls back to the
 * template key rather than to an empty name.
 */
export function documentFilename(
	layout: DocumentLayout,
	plan: DocumentPlan,
	format: DocumentFormat,
): string {
	const stem = resolveDocumentPath(
		'{title}',
		{ title: layout.title },
		{ title: { column: 'title', label: 'title', type: 'string' } },
	)
	return `${stem === 'untitled' ? plan.key : stem}.${format}`
}

/**
 * Write a rendered document to the storage bundle.
 *
 * The key comes from the template's declared path with the row's values
 * substituted, which is what makes re-storing an invoice overwrite its own
 * object rather than accumulate copies — an archive that grows a new key per
 * render is one nobody can look an invoice up in.
 */
export async function storeDocument(input: {
	provider: StorageProvider
	plan: DocumentPlan
	row: DocumentRow
	/** The declared path template, e.g. `invoices/{number}.pdf`. */
	path: string
	rendered: RenderedDocument
}): Promise<StoredObject> {
	const key = resolveDocumentPath(input.path, input.row, input.plan.values)
	return input.provider.put(
		key,
		input.rendered.bytes,
		input.rendered.contentType,
	)
}

/**
 * Send a rendered document as an attachment on a registered email template.
 *
 * The body is an ordinary registered template rendered with ordinary props; the
 * document rides along as an attachment. That separation is deliberate — a
 * covering note is prose somebody wants to edit, and burying it inside the
 * document layout would make "change the wording of the email" a change to the
 * invoice.
 */
export async function emailDocument(input: {
	mailer: Mailer
	registry: EmailRegistry
	/** The registered body template. */
	template: string
	/** Subject line, with `{placeholder}`s resolved against the row. */
	subject: string
	to: string
	plan: DocumentPlan
	row: DocumentRow
	rendered: RenderedDocument
	/** Extra props for the body template, beyond the row itself. */
	props?: Record<string, unknown>
}): Promise<SentMessage> {
	const rendered = renderEmail(input.registry, input.template, {
		...input.props,
		row: input.row,
		document: {
			filename: input.rendered.filename,
			format: input.rendered.format,
		},
	})
	return input.mailer.send({
		to: input.to,
		// The declared subject wins over the template's own: a document email's
		// subject usually has to carry the invoice number, which the generic
		// template has no way to know.
		subject: resolveDocumentText(input.subject, input.row, input.plan.values),
		html: rendered.html,
		attachments: [
			{
				filename: input.rendered.filename,
				contentType: input.rendered.contentType,
				bytes: input.rendered.bytes,
			},
		],
	})
}

/**
 * The recipient address for a delivery, following at most one reference hop.
 *
 * The hop is resolved by the *caller* handing in the referenced row, not by this
 * module fetching it: the referenced row is somebody else's row, and reading it
 * is a `read` that has to pass that resource's gate. Passing it in is what keeps
 * that true.
 */
export function documentRecipient(
	row: DocumentRow,
	column: string,
): string | null {
	const value = row[column]
	return typeof value === 'string' && value.includes('@') ? value : null
}
