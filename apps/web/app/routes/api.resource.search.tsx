/**
 * `GET /api/:resource/search?q=…` — ranked full-text search.
 *
 * Static `search` segment, so it ranks above the `:resource/:id` catch, exactly
 * as `count` does — without that, `/api/task/search` falls through as
 * `opGet('search')` and 404s on a row id nobody asked for.
 *
 * The route is deliberately thin. Every rule that matters — the `read`
 * authorization, the api-key scope, the forced tenant and soft-delete scopes,
 * the query-length bound — lives in `opSearch`, one layer below, because the
 * admin loader and the MCP `search_<table>` tool reach that layer without
 * passing through here. Issue #186's finding was that a route-level gate is a
 * gate two of the three callers skip; this route inherits the fix rather than
 * re-creating the problem.
 */

import { searchHandler } from '@maxstack/core'
import { parseFilterQuery } from '~/list-query.server'
import { withRequestObservability } from '~/observability.server'
import { checkApiKeyScope, getContext } from '~/sprout.server'
import type { Route } from './+types/api.resource.search'

/** Page size, clamped. Mirrors the list route's posture: a caller may ask for
 * fewer, never for more than the server is willing to rank in one request. */
const MAX_LIMIT = 100

function intParam(value: string | null, fallback: number, max: number): number {
	const n = Number(value)
	if (!Number.isFinite(n) || n < 0) return fallback
	return Math.min(Math.trunc(n), max)
}

export async function loader({ request, params }: Route.LoaderArgs) {
	const ctx = await getContext(request)
	return withRequestObservability(request, ctx.user, async () => {
		const denied = checkApiKeyScope(ctx, params.resource, request.method)
		if (denied) return denied
		const url = new URL(request.url)
		// The list route's `?filter.<col>=` / `?filter.<col>.gte=` dialect applies
		// unchanged, so a facet a caller already knows how to set keeps working
		// alongside `?q=`. Its `search` key is ignored here — `q` is the query.
		const listQuery = parseFilterQuery(url)
		const { status, body, headers } = await searchHandler(
			ctx,
			params.resource,
			url.searchParams.get('q') ?? '',
			{
				filter: listQuery.filter,
				range: listQuery.range,
				limit: intParam(url.searchParams.get('limit'), 50, MAX_LIMIT),
				offset: intParam(
					url.searchParams.get('offset'),
					0,
					Number.MAX_SAFE_INTEGER,
				),
			},
		)
		return Response.json(body, { status, headers })
	})
}
