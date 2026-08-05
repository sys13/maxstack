/**
 * `POST /admin/:resource/parse` with `{ text }` → `{ fields }` — the generic
 * admin's face of the same AI field extraction the project pages use
 *.
 *
 * A separate action rather than a reused project route because the two resolve
 * a resource differently: a project page is looked up by *page slug* through the
 * spec, and this is looked up by *registry name*. The extraction itself is one
 * shared implementation (`entity-parse.server`), so the admin and the project
 * surfaces cannot drift in what they can read out of a description.
 *
 * Action-only: there is nothing to render at this path, and it exists under
 * `/admin/:resource/` rather than as a sibling so it inherits the same auth gate
 * as the create and edit actions it feeds.
 */

import { data } from 'react-router'
import type { AdminResourceArgs } from '~/admin.server'
import { parseEntityFields } from '~/entity-parse.server'
import { getContext, getSprout, referenceFieldOptions } from '~/sprout.server'

export async function action({ request, params }: AdminResourceArgs) {
	const { registry } = await getSprout()
	const entry = registry.get(params.resource)
	if (!entry) throw data({ error: 'Unknown resource' }, { status: 404 })
	const ctx = await getContext(request) // same auth gate as create/edit
	const body = (await request.json().catch(() => ({}))) as { text?: unknown }
	const text = typeof body.text === 'string' ? body.text.trim() : ''
	if (!text) return data({ error: 'text is required' }, { status: 400 })

	const result = await parseEntityFields({
		resource: params.resource,
		pageName: entry.label,
		introspection: entry.resource,
		text,
		// The same rows the form's comboboxes load, read through this request's
		// context so a reference the caller may not read yields no options.
		referenceOptions: await referenceFieldOptions(ctx, entry.resource),
	})
	if ('error' in result) {
		return data(result, { status: result.error === 'unparseable' ? 502 : 503 })
	}
	return result
}
