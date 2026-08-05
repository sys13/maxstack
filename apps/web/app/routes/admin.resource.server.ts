/**
 * The generic admin list's loader.
 *
 * Separate from the component because these four surfaces stopped being route
 * modules: `/admin` is a namespace whose dynamic children outranked the project
 * splat and swallowed every spec page declared under it, so the router now
 * mounts one splat that resolves what a path means and delegates here. A route
 * module gets its `loader` export stripped from the client bundle; a plain
 * module does not, so a loader left beside a component would drag
 * `~/sprout.server` and friends into the browser — which is a build error, and
 * would have been a data leak if it were not.
 */

import { listHandler, opSearch } from '@maxstack/core'
import { filtersFromSearchParams, searchableFields } from '@maxstack/ui'
import { data } from 'react-router'
import type { AdminResourceArgs } from '~/admin.server'
import {
	getContext,
	getSprout,
	referenceFieldOptions,
	resolveCapabilities,
	resolveRowFiles,
	resolveRowReferences,
} from '~/sprout.server'

export async function loader({ request, params }: AdminResourceArgs) {
	const { registry } = await getSprout()
	const entry = registry.get(params.resource)
	if (!entry) throw data({ error: 'Unknown resource' }, { status: 404 })

	const ctx = await getContext(request)
	// Filters come straight off the URL (shareable/bookmarkable) — decoded with
	// the same codec the client encodes with, so the two never drift. `search`
	// scans the introspected text columns; `filter.<col>` is equality;
	// `filter.<col>.gte|lte` are numeric/date range bounds.
	const url = new URL(request.url)
	const filters = filtersFromSearchParams(url.searchParams)
	const searchFields = searchableFields(entry.resource)
	// A declared search index upgrades this exact search box in
	// place: same URL, same `?search=`, same table underneath. What changes is
	// that the rows come back ranked, stemmed and word-aware instead of in table
	// order from an unanchored ILIKE. Only when the resource declares one *and*
	// there is something to search for — a blank query must still list, because
	// an empty search box means "show me everything", which is the one thing a
	// search endpoint deliberately does not do.
	const ranked =
		entry.config.search && filters.search?.trim()
			? await opSearch(ctx, params.resource, filters.search, {
					limit: 100,
					// The facets stay live while a search term is set. Dropping them
					// here would show rows the user had just filtered out, which reads
					// as the filters being broken rather than as search overriding them.
					filter:
						Object.keys(filters.filter).length > 0 ? filters.filter : undefined,
					range:
						filters.range && Object.keys(filters.range).length > 0
							? filters.range
							: undefined,
				})
			: null
	const res = ranked
		? { status: 200, body: ranked.map((hit) => hit.row) }
		: await listHandler(ctx, params.resource, {
				limit: 100,
				search: filters.search,
				searchFields: searchFields.length > 0 ? searchFields : undefined,
				filter:
					Object.keys(filters.filter).length > 0 ? filters.filter : undefined,
				range:
					filters.range && Object.keys(filters.range).length > 0
						? filters.range
						: undefined,
			})
	if (res.status !== 200) {
		throw data(res.body, { status: res.status })
	}
	// Derived values already rode out of `listHandler` — the op
	// context carries the resolver, so every read path gets them identically.
	const rows = res.body as Record<string, unknown>[]
	return {
		resource: params.resource,
		label: entry.label,
		// The introspected resource (plain data) — the client builds the table
		// columns *and* the filter facets from it. No hand-written filter code.
		introspection: entry.resource,
		titleField: entry.config.titleField,
		rows,
		filters,
		// Resolve FK columns to their referenced titles, batched (no N+1).
		references: await resolveRowReferences(ctx, entry.resource, rows),
		// Signed URLs for this page's file columns, so a list can render a
		// declared thumbnail without a per-row round trip.
		files: resolveRowFiles(entry.resource, rows, ctx.user?.id ?? null),
		// The option sets for reference facets (the referenced records) — the one
		// thing a facet can't derive from the schema alone.
		referenceOptions: await referenceFieldOptions(ctx, entry.resource),
		// What this session may do — the UI strips affordances it would be denied
		// (task 35). Same rules the server enforces, resolved once here.
		can: await resolveCapabilities(ctx, params.resource),
		// Issue #59: a `softDelete: true` resource gets a "Trash" link to its
		// small restore-affordance page (`admin.resource.trash.tsx`).
		softDelete: entry.config.softDelete === true,
	}
}
