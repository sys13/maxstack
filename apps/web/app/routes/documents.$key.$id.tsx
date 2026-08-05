/**
 * `GET /documents/:key/:id.html|.pdf` — download a declared document.
 *
 * The route is deliberately thin, and thinner than it looks. Every rule that
 * matters — the `read` authorization on the row, the api-key scope, the tenant
 * and soft-delete scopes, and the *separate* read check on each related resource
 * a table section pulls from — lives in `opRenderDocument`, which is built out
 * of `opGet` and `opList` rather than beside them. Issue #186's finding was that
 * a route-level gate is a gate the other callers skip; this route inherits the
 * fix rather than re-creating the problem, and a background job storing the same
 * invoice passes the identical checks because it calls the identical function.
 *
 * The format is the URL's **extension**, not a query parameter. `invoice.pdf` is
 * what a person expects to be able to paste into an email and what a browser
 * expects to be able to save; `?format=pdf` produces a download named after the
 * route segment, which is how you end up with a folder full of files called
 * `4b2c…`.
 */

import { opRenderDocument, PermissionError } from '@maxstack/core'
import { documents } from '@maxstack/features'
import type { DocumentFormat } from '@maxstack/spec'
import { getDocumentFont } from '~/document-font.server'
import { withRequestObservability } from '~/observability.server'
import { checkApiKeyScope, getContext } from '~/sprout.server'
import type { Route } from './+types/documents.$key.$id'

/** `4b2c….pdf` → `['4b2c…', 'pdf']`. An unknown or absent extension is a 404. */
function splitFormat(
	segment: string,
): { id: string; format: DocumentFormat } | null {
	const dot = segment.lastIndexOf('.')
	if (dot <= 0) return null
	const ext = segment.slice(dot + 1).toLowerCase()
	if (ext !== 'html' && ext !== 'pdf') return null
	return { id: segment.slice(0, dot), format: ext }
}

export async function loader({ request, params }: Route.LoaderArgs) {
	const ctx = await getContext(request)
	const font = await getDocumentFont()
	return withRequestObservability(request, ctx.user, async () => {
		const target = splitFormat(params.id)
		if (!target)
			return Response.json({ error: 'Ask for .html or .pdf' }, { status: 404 })

		const found = ctx.registry.findDocument(params.key)
		if (!found)
			return Response.json({ error: 'Unknown document' }, { status: 404 })
		// The api-key scope is checked against the resource the template renders,
		// not against a "documents" pseudo-resource: a key scoped to read invoices
		// can render an invoice, and one that is not, cannot. Inventing a scope for
		// the rendering would let a key read a row through a URL its scope never
		// mentioned.
		const denied = checkApiKeyScope(ctx, found.entry.resource.name, 'GET')
		if (denied) return denied

		try {
			const { layout, plan } = await opRenderDocument(
				ctx,
				params.key,
				target.id,
			)
			const rendered = documents.renderDocument(layout, plan, target.format, {
				// The font this deployment bound, if any. Absent — the
				// default — is the base-14 path, which prints `?` for anything outside
				// Latin-1. Resolved here rather than inside the renderer so that
				// `renderDocument` stays a pure function of its arguments.
				...(font ? { font } : {}),
			})
			return new Response(rendered.bytes as unknown as BodyInit, {
				headers: {
					'Content-Type': rendered.contentType,
					// `inline` rather than `attachment`: a PDF opens in the browser's
					// viewer, which is what somebody following a link to their invoice
					// wants, and the filename still applies when they save it.
					'Content-Disposition': `inline; filename="${rendered.filename}"`,
					// A document is a rendering of live rows, so it is never cacheable
					// by a shared cache: the row can change, and the read gate has to
					// run for every viewer rather than once for the first one.
					'Cache-Control': 'private, no-store',
				},
			})
		} catch (error) {
			// A denial is a denial, never an empty document. Rendering a blank
			// invoice for somebody who may not see it would be the failure mode this
			// whole layer is arranged to avoid.
			if (error instanceof PermissionError)
				return Response.json({ error: 'Forbidden' }, { status: 403 })
			return Response.json({ error: 'Not found' }, { status: 404 })
		}
	})
}
