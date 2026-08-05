/**
 * `POST /api/webhooks/:receiver` — the inbound webhook endpoint.
 *
 * This is the most dangerous route in the app: an unauthenticated POST from the
 * public internet that becomes a database write. Everything about it is
 * therefore delegated to `ReceiverRegistry`, which cannot be configured to skip
 * verification, and this file does exactly three things:
 *
 *  1. read the raw body **once**, as text, before anything parses it (the bytes
 *     that were signed are the bytes that must be verified — re-serializing
 *     parsed JSON changes them);
 *  2. hand it to the registry;
 *  3. return the registry's response verbatim, without adding a body, a header,
 *     or a distinguishing status. Every rejection looks identical from outside.
 *
 * The mapped writes are deliberately *not* applied here. `handle` returns
 * intent; applying it goes through the same validated write path a form
 * submission uses. A receiver that wrote rows directly would be a REST API with
 * no authentication in front of it.
 */

import { getReceivers } from '~/webhooks.server'
import type { Route } from './+types/api.webhooks.$receiver'

export async function action({ params, request }: Route.ActionArgs) {
	if (request.method !== 'POST') return new Response(null, { status: 405 })
	const receiver = params.receiver ?? ''
	// Raw text, not `request.json()`: the signature covers these exact bytes.
	const body = await request.text()
	const { response } = await getReceivers().handle(receiver, {
		body,
		headers: request.headers,
	})
	return response
}

/** A GET tells an unauthenticated caller nothing about which receivers exist. */
export function loader() {
	return new Response(null, { status: 405 })
}
