/**
 * The trash can's loader and action.
 *
 * Separate from the component for the reason every one of these is: these
 * surfaces stopped being route modules when `/admin`'s dynamic children were
 * replaced by one splat, and a plain module keeps the imports a route module
 * would have stripped — so a loader beside a component ships `~/sprout.server`
 * to the browser.
 */

import { opList, opRestore } from '@maxstack/core'
import { data } from 'react-router'
import type { AdminResourceArgs } from '~/admin.server'
import { getContext, getSprout } from '~/sprout.server'

export async function loader({ request, params }: AdminResourceArgs) {
	const { registry } = await getSprout()
	const entry = registry.get(params.resource)
	if (!entry) throw data({ error: 'Unknown resource' }, { status: 404 })
	// A resource without `softDelete` has no trash — but it isn't a missing
	// page either, and a 404 here read as "the admin is broken" rather than
	// "this resource deletes for real". Say which one it is.
	if (!entry.config.softDelete) {
		return {
			resource: params.resource,
			label: entry.label,
			softDelete: false as const,
			titleField: entry.config.titleField,
			rows: [] as Record<string, unknown>[],
		}
	}

	const ctx = await getContext(request)
	const rows = await opList(ctx, params.resource, {
		includeDeleted: true,
		limit: 200,
	})
	const deleted = rows.filter((r) => r.deletedAt != null)

	return {
		resource: params.resource,
		label: entry.label,
		softDelete: true as const,
		titleField: entry.config.titleField,
		rows: deleted,
	}
}

export async function action({ request, params }: AdminResourceArgs) {
	const ctx = await getContext(request)
	const form = await request.formData()
	const id = String(form.get('id') ?? '')
	try {
		await opRestore(ctx, params.resource, id)
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Restore failed.'
		return data({ error: message }, { status: 400 })
	}
	return null
}
