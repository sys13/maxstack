import { createHandler, getManyHandler, listHandler } from '@maxstack/core'
import { parseListQuery } from '~/list-query.server'
import { withRequestObservability } from '~/observability.server'
import { checkApiKeyScope, getContext, requireWriteAuth } from '~/sprout.server'
import type { Route } from './+types/api.resource'

/**
 * `GET /api/:resource` — list, or batch-get with `?ids=a,b,c` (the primitive
 * `<ReferenceField>` uses to resolve a page of FKs). List also accepts
 * `?search=` + `?searchField=` (repeatable) for the FK autocomplete,
 * `?filter.<col>=` equality filters, and `?filter.<col>.gte=`/`.lte=` inclusive
 * range bounds (numeric/date columns).
 *
 * Task 61: the whole handler runs inside `withRequestObservability`, which
 * rate-limits the caller (429 when over budget), logs one structured JSON
 * line per request, and reports thrown errors — this is the app's widest,
 * most script-reachable surface, so it's the primary "abusive traffic"
 * target.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
	const ctx = await getContext(request)
	return withRequestObservability(request, ctx.user, async () => {
		const denied = checkApiKeyScope(ctx, params.resource, request.method)
		if (denied) return denied
		const url = new URL(request.url)

		const idsParam = url.searchParams.get('ids')
		if (idsParam !== null) {
			const ids = idsParam.split(',').filter(Boolean)
			const { status, body, headers } = await getManyHandler(
				ctx,
				params.resource,
				ids,
			)
			return Response.json(body, { status, headers })
		}

		const { status, body, headers } = await listHandler(
			ctx,
			params.resource,
			parseListQuery(url),
		)
		return Response.json(body, { status, headers })
	})
}

/** `POST /api/:resource` — create. */
export async function action({ request, params }: Route.ActionArgs) {
	if (request.method !== 'POST') {
		// The collection route only creates (POST). Row mutations live on the
		// per-row path route `/api/:resource/:id`; a `?id=` query param never
		// reaches them, so a bare "POST only" is misleading. Point
		// DELETE/PUT/PATCH at the path form instead.
		const { method } = request
		const isRowMutation =
			method === 'DELETE' || method === 'PUT' || method === 'PATCH'
		const error = isRowMutation
			? `${method} is not supported on /api/${params.resource}; use /api/${params.resource}/<id> (a ?id= query param is ignored)`
			: `${method} not allowed on /api/${params.resource} — POST to create`
		return Response.json({ error }, { status: 405 })
	}
	const ctx = await getContext(request)
	return withRequestObservability(request, ctx.user, async () => {
		const unauthenticated = await requireWriteAuth(ctx, request.method)
		if (unauthenticated) return unauthenticated
		const denied = checkApiKeyScope(ctx, params.resource, request.method)
		if (denied) return denied
		const data = (await request.json()) as Record<string, unknown>
		const { status, body, headers } = await createHandler(
			ctx,
			params.resource,
			data,
		)
		return Response.json(body, { status, headers })
	})
}
