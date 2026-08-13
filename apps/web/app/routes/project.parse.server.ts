/**
 * `POST /:page/parse` with `{ text }` → `{ fields }` — the HTTP face of
 * `entity-parse.server`'s AI field extraction. `ai-unavailable` maps to 503
 * and an unparseable model reply to 502; the new-record form treats both as
 * "fill the form by hand".
 */

import { data } from 'react-router'
import { parseEntityFields } from '~/entity-parse.server'
import { type ProjectRouteArgs, resolveProjectResource } from '~/project.server'
import { getContext, referenceFieldOptions } from '~/sprout.server'

export async function action({ request, params }: ProjectRouteArgs) {
	const resolved = await resolveProjectResource(params.page, request)
	const ctx = await getContext(request) // same auth gate as the page's CRUD actions
	const body = (await request.json().catch(() => ({}))) as { text?: unknown }
	const text = typeof body.text === 'string' ? body.text.trim() : ''
	if (!text) return data({ error: 'text is required' }, { status: 400 })

	const result = await parseEntityFields({
		resource: resolved.resource,
		pageName: resolved.page.name,
		introspection: resolved.introspection,
		text,
		// The same rows the form's comboboxes load, so "assigned to Dana" can
		// resolve to Dana's id. Read through the request's own
		// context, so a reference the caller may not read yields no options
		// rather than leaking labels past the permission layer.
		// `.options` — see the note in the admin's parse route.
		referenceOptions: (await referenceFieldOptions(ctx, resolved.introspection))
			.options,
	})
	if ('error' in result) {
		return data(result, { status: result.error === 'unparseable' ? 502 : 503 })
	}
	return result
}
