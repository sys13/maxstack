/**
 * The edit form's loader and action.
 *
 * Separate from the component because these surfaces stopped being route
 * modules: the router mounts one splat that resolves what a path means and
 * delegates here. A route module gets `loader`/`action` stripped from the client
 * bundle; a plain module does not, so leaving them beside the component would
 * drag `~/sprout.server` and friends into the browser.
 */

import {
	acceptedBodies,
	allowedMethods,
	deleteHandler,
	getHandler,
	pageContract,
	pageRecordPath,
	updateHandler,
} from '@maxstack/core'
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
	// The one statement of what this URL accepts (#376). Every refusal below is
	// composed from it rather than written beside it, so the sentence a caller
	// reads here and the one `query_spec {section:"pages"}` publishes cannot
	// diverge — the whole point of publishing a contract.
	const contract = pageContract(page)
	const path = pageRecordPath(page.route)
	const accepts = acceptedBodies(contract, `POST ${path}`)

	// React Router routes EVERY non-GET method to `action`, so `DELETE
	// <route>/<id>` — the guess a caller makes straight after reading the REST
	// contract — used to fall through to `request.formData()` and throw a
	// TypeError on a body-less request. A 500 reads as "I found a bug in the
	// platform", which is why the session that filed #376 stopped there instead
	// of correcting itself in one round trip.
	if (request.method !== 'POST')
		return data(
			{ error: `${request.method} is not served here. ${accepts}` },
			{ status: 405, headers: { Allow: allowedMethods(contract, path) } },
		)

	if (request.headers.get('content-type')?.includes('application/json')) {
		// A body that will not parse is the caller's, not ours.
		const parsed = await request.json().catch(() => null)
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
			return data(
				{ error: `Body is not a JSON object. ${accepts}` },
				{ status: 400 },
			)
		const input = parsed as Record<string, unknown>
		// The other guess #376 reports. In this branch every key is a *field
		// name*, so treating `intent` as a delete marker would make one field
		// name silently destructive — an entity may legitimately declare a field
		// called `intent`, and a routine update would then delete the row. The
		// ambiguity is refused rather than resolved: the caller is one round trip
		// from either real shape, and an entity that really does store the string
		// `delete` in an `intent` field can write it through
		// `PATCH /api/<resource>/:id`, which has no form half to be ambiguous
		// with. (Left alone this reached `updateHandler`, where zod stripped the
		// unknown key and the empty update became a driver error — a 5xx for a
		// caller error.)
		if (input.intent === 'delete')
			return data(
				{
					error: `\`intent\` is a form field here, not a JSON one. ${accepts}`,
				},
				{ status: 400 },
			)
		const res = await updateHandler(ctx, resource, params.id, input)
		if (res.status >= 400) return data(res.body, { status: res.status })
		return redirect(pagePath(page.slug))
	}

	const form = await request.formData().catch(() => null)
	if (!form)
		return data({ error: `Body is not a form. ${accepts}` }, { status: 400 })
	if (form.get('intent') === 'delete') {
		const res = await deleteHandler(ctx, resource, params.id)
		if (res.status >= 400) return data(res.body, { status: res.status })
		return redirect(pagePath(page.slug))
	}
	return data({ error: `Unsupported action. ${accepts}` }, { status: 400 })
}
