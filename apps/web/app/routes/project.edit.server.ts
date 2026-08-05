/**
 * The edit form's loader and action.
 *
 * Separate from the component because these surfaces stopped being route
 * modules: the router mounts one splat that resolves what a path means and
 * delegates here. A route module gets `loader`/`action` stripped from the client
 * bundle; a plain module does not, so leaving them beside the component would
 * drag `~/sprout.server` and friends into the browser.
 */

import { deleteHandler, getHandler, updateHandler } from '@maxstack/core'
import { isAiConfigured } from '@maxstack/spec-derive'
import { data, redirect } from 'react-router'
import { liveSlotFor } from '~/live.server'
import { pagePath } from '~/page-path'
import {
	type ProjectRecordArgs,
	projectChrome,
	resolveProjectResource,
} from '~/project.server'
import {
	getContext,
	referenceFieldOptions,
	relatedRecords,
	resolveRowFiles,
} from '~/sprout.server'

export async function loader({ request, params }: ProjectRecordArgs) {
	const resolved = await resolveProjectResource(params.page, request)
	const ctx = await getContext(request)
	const res = await getHandler(ctx, resolved.resource, params.id)
	if (res.status !== 200) throw data(res.body, { status: res.status })
	return {
		page: resolved.page,
		nav: resolved.nav,
		...(await projectChrome()),
		id: params.id,
		row: res.body as Record<string, unknown>,
		introspection: resolved.introspection,
		// Whether the describe-to-prefill panel can work at all.
		aiConfigured: isAiConfigured(),
		// FK picker choices, same as the admin form — a name picker instead of a
		// raw-UUID text box.
		referenceOptions: await referenceFieldOptions(ctx, resolved.introspection),
		// Signed, viewer-bound preview URLs for this record's file columns
		// — the column holds a key, which only the server can sign.
		files: resolveRowFiles(
			resolved.introspection,
			[res.body as Record<string, unknown>],
			ctx.user?.id ?? null,
		),
		// A bespoke *presence* surface for this record. This is the
		// page a `presence` channel's declared bound actually names — "who is
		// viewing this record" is a question about one row, so the record page is
		// the only surface that can answer it. A resource with no such declaration
		// carries `undefined` here and renders nothing extra, which is what keeps
		// the feature opt-in rather than a tax every record page pays.
		liveSlot: resolved.page.resource
			? await liveSlotFor(resolved.page.resource, 'presence')
			: undefined,
		primaryKey: resolved.primaryKey,
		// The records that point *at* this one, derived from the
		// declared FKs. This is the half of a relation the generated app never
		// showed: the spec knew every entity that references this row and through
		// which field, and a detail page still had to be hand-written to read them.
		related: await relatedRecords(ctx, resolved.resource, params.id),
	}
}

export async function action({ request, params }: ProjectRecordArgs) {
	const { page } = await resolveProjectResource(params.page, request)
	const ctx = await getContext(request)
	const resource = page.resource as string

	if (request.headers.get('content-type')?.includes('application/json')) {
		const input = (await request.json()) as Record<string, unknown>
		const res = await updateHandler(ctx, resource, params.id, input)
		if (res.status >= 400) return data(res.body, { status: res.status })
		return redirect(pagePath(page.slug))
	}

	const form = await request.formData()
	if (form.get('intent') === 'delete') {
		const res = await deleteHandler(ctx, resource, params.id)
		if (res.status >= 400) return data(res.body, { status: res.status })
		return redirect(pagePath(page.slug))
	}
	return data({ error: 'Unsupported action' }, { status: 400 })
}
