import { deleteHandler, getHandler, updateHandler } from '@maxstack/core'
import { withRequestObservability } from '~/observability.server'
import { checkApiKeyScope, getContext, requireWriteAuth } from '~/sprout.server'
import type { Route } from './+types/api.resource.$id'

/** `GET /api/:resource/:id` — read one. Wrapped in `withRequestObservability`
 * (task 61) — see `api.resource.tsx` for why. */
export async function loader({ request, params }: Route.LoaderArgs) {
	const ctx = await getContext(request)
	return withRequestObservability(request, ctx.user, async () => {
		const denied = checkApiKeyScope(ctx, params.resource, request.method)
		if (denied) return denied
		const { status, body } = await getHandler(ctx, params.resource, params.id)
		return Response.json(body, { status })
	})
}

/** `PUT|PATCH /api/:resource/:id` — update · `DELETE` — delete. */
export async function action({ request, params }: Route.ActionArgs) {
	const ctx = await getContext(request)
	return withRequestObservability(request, ctx.user, async () => {
		const unauthenticated = await requireWriteAuth(ctx, request.method)
		if (unauthenticated) return unauthenticated
		const denied = checkApiKeyScope(ctx, params.resource, request.method)
		if (denied) return denied
		if (request.method === 'DELETE') {
			const { status, body } = await deleteHandler(
				ctx,
				params.resource,
				params.id,
			)
			return Response.json(body, { status })
		}
		if (request.method === 'PUT' || request.method === 'PATCH') {
			const data = (await request.json()) as Record<string, unknown>
			const { status, body } = await updateHandler(
				ctx,
				params.resource,
				params.id,
				data,
			)
			return Response.json(body, { status })
		}
		return Response.json({ error: 'Unsupported method' }, { status: 405 })
	})
}
