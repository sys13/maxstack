/**
 * `/api/auth/*` — better-auth's own HTTP surface (sign-in, sign-up, sign-out,
 * session, provider callbacks). We just forward the request to the instance's
 * fetch handler; better-auth reads/writes the session cookie and the auth tables.
 */

import { getAuth } from '~/sprout.server'
import type { Route } from './+types/api.auth.$'

export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
	const auth = await getAuth()
	return auth.handler(request)
}

export async function action({ request }: Route.ActionArgs): Promise<Response> {
	const auth = await getAuth()
	return auth.handler(request)
}
