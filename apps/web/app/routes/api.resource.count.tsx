/**
 * `GET /api/:resource/count` — how many rows match, without fetching them.
 *
 * The list route's `?search=` / `?filter.<col>=` / `?filter.<col>.gte=` dialect
 * applies unchanged (`parseFilterQuery`); paging does not, because the count is
 * what paging is computed *from*. Static `count` segment, so it ranks above the
 * `:resource/:id` catch — `/api/task/count` reaches this and not `opGet('count')`.
 */

import { countHandler } from '@maxstack/core'
import { parseFilterQuery } from '~/list-query.server'
import { withRequestObservability } from '~/observability.server'
import { checkApiKeyScope, getContext } from '~/sprout.server'
import type { Route } from './+types/api.resource.count'

export async function loader({ request, params }: Route.LoaderArgs) {
	const ctx = await getContext(request)
	return withRequestObservability(request, ctx.user, async () => {
		const denied = checkApiKeyScope(ctx, params.resource, request.method)
		if (denied) return denied
		const { status, body } = await countHandler(
			ctx,
			params.resource,
			parseFilterQuery(new URL(request.url)),
		)
		return Response.json(body, { status })
	})
}
