/**
 * `POST /api/:resource/:id/restore` — the undo for `DELETE` on a
 * `softDelete: true` resource, and the REST twin of the Trash
 * screen's restore button.
 *
 * A write, so it takes the same auth and API-key scope checks as `PUT`/`DELETE`
 * on the row itself. On a resource that never declared soft delete the row is
 * genuinely gone, and the handler says so as a 422 rather than a 500.
 */

import { restoreHandler } from '@maxstack/core'
import { withRequestObservability } from '~/observability.server'
import { checkApiKeyScope, getContext, requireWriteAuth } from '~/sprout.server'
import type { Route } from './+types/api.resource.$id.restore'

/** Restore is a mutation, so a bare GET is a 405 — and must say so as JSON.
 * Without a loader React Router answers with its own framework error page,
 * stack trace and all, which is a worse thing to hand an API client. */
export async function loader({ params }: Route.LoaderArgs) {
	return methodNotAllowed('GET', params.resource, params.id)
}

function methodNotAllowed(method: string, resource: string, id: string) {
	return Response.json(
		{
			error: `${method} not allowed on /api/${resource}/${id}/restore — POST to restore`,
		},
		{ status: 405 },
	)
}

export async function action({ request, params }: Route.ActionArgs) {
	if (request.method !== 'POST') {
		return methodNotAllowed(request.method, params.resource, params.id)
	}
	const ctx = await getContext(request)
	return withRequestObservability(request, ctx.user, async () => {
		const unauthenticated = await requireWriteAuth(ctx, request.method)
		if (unauthenticated) return unauthenticated
		const denied = checkApiKeyScope(ctx, params.resource, request.method)
		if (denied) return denied
		const { status, body, headers } = await restoreHandler(
			ctx,
			params.resource,
			params.id,
		)
		return Response.json(body, { status, headers })
	})
}
