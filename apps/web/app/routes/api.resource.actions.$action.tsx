/**
 * `POST /api/:resource/actions/:action` — run a declared list action.
 *
 * A POST to a **named operation**, not a `PATCH` over a collection, and the
 * distinction is the design rather than a URL preference: the write comes from
 * the spec, never from the body. A collection `PATCH` would take it from the
 * caller, which is the client-side bulk update this layer exists not to be —
 * nothing in the spec for a reviewer to read, and nothing bounding what one call
 * could set.
 *
 * The body is `{ ids, choice?, batchId? }` and nothing else. There is
 * deliberately no `filter` spelling: "everything matching the current filter"
 * resolves the set server-side *after* whoever aimed it read a count.
 *
 * A write, so it takes the same auth and API-key scope checks as `PUT`/`DELETE`
 * on a row. The action's own cap, role and write set are enforced below this, in
 * `opRunAction` — per #186, a check written here is one `/mcp` and the admin
 * loaders would skip.
 *
 * The static `actions` segment sits ahead of the `:resource/:id` catch in
 * `routes.ts` for `count`/`search`'s reason: without it, `/api/task/actions` is
 * routed as a read of a row whose id is the word "actions".
 */

import { runActionHandler } from '@maxstack/core'
import { withRequestObservability } from '~/observability.server'
import { checkApiKeyScope, getContext, requireWriteAuth } from '~/sprout.server'
import type { Route } from './+types/api.resource.actions.$action'

export async function loader({ params }: Route.LoaderArgs) {
	return methodNotAllowed('GET', params.resource, params.action)
}

function methodNotAllowed(method: string, resource: string, action: string) {
	return Response.json(
		{
			error: `${method} not allowed on /api/${resource}/actions/${action} — POST to run it`,
		},
		{ status: 405 },
	)
}

export async function action({ request, params }: Route.ActionArgs) {
	if (request.method !== 'POST')
		return methodNotAllowed(request.method, params.resource, params.action)

	const ctx = await getContext(request)
	return withRequestObservability(request, ctx.user, async () => {
		const unauthenticated = await requireWriteAuth(ctx, request.method)
		if (unauthenticated) return unauthenticated
		const denied = checkApiKeyScope(ctx, params.resource, request.method)
		if (denied) return denied

		let payload: unknown
		try {
			payload = await request.json()
		} catch {
			return Response.json(
				{ error: 'Body must be JSON: { ids: string[], choice?, batchId? }' },
				{ status: 400 },
			)
		}
		const body = (payload ?? {}) as Record<string, unknown>
		// Refused rather than coerced to `[]`. An empty selection is already a
		// refusal in `opRunAction`, but a *malformed* one is a different mistake —
		// a caller that sent `{"id": "..."}` should be told what shape to send, not
		// told that nothing was selected.
		if (!Array.isArray(body.ids))
			return Response.json(
				{ error: '`ids` must be an array of row ids' },
				{ status: 400 },
			)

		const {
			status,
			body: result,
			headers,
		} = await runActionHandler(ctx, params.resource, params.action, {
			ids: body.ids.map(String),
			...(typeof body.choice === 'string' ? { choice: body.choice } : {}),
			// Caller-supplied when given, so a client can find its own run in the
			// audit log; minted here otherwise, because the batch entry is
			// worthless without something correlating it to its per-row entries.
			batchId:
				typeof body.batchId === 'string' && body.batchId
					? body.batchId
					: crypto.randomUUID(),
		})
		return Response.json(result, { status, headers })
	})
}
