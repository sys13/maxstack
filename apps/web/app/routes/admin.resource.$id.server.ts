/**
 * The generic admin record page's loader and action.
 *
 * Separate from the component for the reason every one of these is: these
 * surfaces stopped being route modules when `/admin`'s dynamic children were
 * replaced by one splat, and a plain module keeps the imports a route module
 * would have stripped — so a loader beside a component ships `~/sprout.server`
 * to the browser.
 */

import { deleteHandler, getHandler, updateHandler } from '@maxstack/core'
import { isAiConfigured } from '@maxstack/spec-derive'
import { data, redirect } from 'react-router'
import type { AdminRecordArgs } from '~/admin.server'
import {
	getAuditSink,
	getContext,
	getSprout,
	referenceFieldOptions,
	relatedRecords,
	resolveCapabilities,
	resolveRowFiles,
	resolveRowReferences,
} from '~/sprout.server'

export async function loader({ request, params }: AdminRecordArgs) {
	const { registry } = await getSprout()
	const entry = registry.get(params.resource)
	if (!entry) throw data({ error: 'Unknown resource' }, { status: 404 })

	const ctx = await getContext(request)
	const res = await getHandler(ctx, params.resource, params.id)
	if (res.status !== 200) throw data(res.body, { status: res.status })
	const row = res.body as Record<string, unknown>
	return {
		resource: params.resource,
		label: entry.label,
		id: params.id,
		// Derived values rode out of `getHandler` with the row.
		row,
		// The introspected resource (plain data) — the client builds the form
		// schema from it, so spec-grounded project entities get forms too, not
		// just the demo tables.
		introspection: entry.resource,
		// Whether the describe-to-prefill panel can work at all.
		aiConfigured: isAiConfigured(),
		// Resolve this record's FKs to titles for <Show>, and list each referenced
		// table into picker options for the form's FK autocomplete (task 32).
		references: await resolveRowReferences(ctx, entry.resource, [row]),
		// Signed, viewer-bound URLs for this record's file columns.
		// The column holds a storage key; only the server can turn it into a
		// fetchable link, and only for the person who just passed the read check.
		files: resolveRowFiles(entry.resource, [row], ctx.user?.id ?? null),
		referenceOptions: await referenceFieldOptions(ctx, entry.resource),
		// Every entity that points *at* this record, with the first page of its
		// rows and the honest total. Derived from the declared FKs,
		// so a relation reaches the page the moment it is declared; it used to be
		// a bare count, which is the surface an app then hand-writes a loader to
		// replace.
		related: await relatedRecords(ctx, params.resource, params.id),
		// What this session may do here — gates the edit form + delete (task 35).
		can: await resolveCapabilities(ctx, params.resource),
		/**
		 * The declared document templates this record can be downloaded as
		 *.
		 *
		 * Templates were reachable only by typing `/documents/<key>/<id>.pdf` with
		 * a row id in it, which made a working, access-controlled, print-ready
		 * feature indistinguishable from one that had not been built. Every other
		 * op produces a surface you can navigate to; this one now does too.
		 *
		 * A lookup, not a query — the resource's templates are on
		 * `ResourceConfig.documents`. `download` is the declaration's own flag, so
		 * a template retired with `documents.setDelivery` disappears from here and
		 * from the URL together rather than only from the exposure report.
		 *
		 * **No second read check.** Reaching this line means `getHandler` above
		 * already returned this row through `opGet`, which is the identical gate
		 * the document route runs — so a `canPerformAction` call here would be a
		 * second copy of an answer already in hand, and the kind of copy that goes
		 * stale. The link is only ever rendered beside a row the viewer just read.
		 */
		documents: (entry.config.documents ?? [])
			.filter((template) => template.download)
			.map((template) => ({
				key: template.key,
				description: template.description,
			})),
		// This record's activity feed, most-recent first — over the audit sink the
		// ops write to (task 35). Serializable, handed straight to <History>.
		history: await getAuditSink().query({
			resource: params.resource,
			resourceId: params.id,
		}),
	}
}

export async function action({ request, params }: AdminRecordArgs) {
	const ctx = await getContext(request)

	// JSON body → update; form post with intent=delete → delete.
	if (request.headers.get('content-type')?.includes('application/json')) {
		const input = (await request.json()) as Record<string, unknown>
		const res = await updateHandler(ctx, params.resource, params.id, input)
		if (res.status >= 400) return data(res.body, { status: res.status })
		return redirect(`/admin/${params.resource}`)
	}

	const form = await request.formData()
	if (form.get('intent') === 'delete') {
		const res = await deleteHandler(ctx, params.resource, params.id)
		if (res.status >= 400) return data(res.body, { status: res.status })
		return redirect(`/admin/${params.resource}`)
	}
	return data({ error: 'Unsupported action' }, { status: 400 })
}
