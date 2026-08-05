/**
 * The generic admin create form's loader and action.
 *
 * Separate from the component for the reason every one of these is: these
 * surfaces stopped being route modules when `/admin`'s dynamic children were
 * replaced by one splat, and a plain module keeps the imports a route module
 * would have stripped — so a loader beside a component ships `~/sprout.server`
 * to the browser.
 */

import { createHandler } from '@maxstack/core'
import { isAiConfigured } from '@maxstack/spec-derive'
import { data, redirect } from 'react-router'
import type { AdminResourceArgs } from '~/admin.server'
import { getContext, getSprout, referenceFieldOptions } from '~/sprout.server'

export async function loader({ request, params }: AdminResourceArgs) {
	const { registry } = await getSprout()
	const entry = registry.get(params.resource)
	if (!entry) throw data({ error: 'Unknown resource' }, { status: 404 })
	// Ship the introspected resource (plain data) so the form schema is built
	// client-side from whatever the registry actually holds — demo tables and
	// spec-grounded project entities alike, never a hard-coded table list.
	return {
		resource: params.resource,
		label: entry.label,
		introspection: entry.resource,
		// Whether the describe-to-prefill panel can work at all.
		aiConfigured: isAiConfigured(),
		// Picker choices for each FK column, so the create form gets the same
		// reference autocomplete the edit form has.
		referenceOptions: await referenceFieldOptions(
			await getContext(request),
			entry.resource,
		),
	}
}

export async function action({ request, params }: AdminResourceArgs) {
	const ctx = await getContext(request)
	const input = (await request.json()) as Record<string, unknown>
	const res = await createHandler(ctx, params.resource, input)
	if (res.status >= 400) return data(res.body, { status: res.status })
	return redirect(`/admin/${params.resource}`)
}
