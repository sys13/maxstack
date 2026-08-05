/**
 * `GET /health` — liveness + readiness. Pings the store backend (`SELECT 1`,
 * which works on both pglite and Postgres via `StoreBackend.exec`) and reports
 * `200` when reachable, `503` otherwise — the shape a load balancer or
 * orchestrator (k8s liveness/readiness, Fly, …) expects.
 *
 * **It tells an unauthenticated caller nothing about internal topology**
 *. Before that change this route returned `err.message` on
 * failure, which is where a database connection string, an internal hostname or
 * a driver's view of the network lives — handed to anyone who can reach the load
 * balancer, precisely when something is broken and the message is most
 * interesting. The failure body is now a bare status; the detail goes to the
 * error reporter, where the operator can see it and a stranger cannot.
 *
 * `durationMs` stays because it is the number that makes a health check useful
 * for spotting a degrading database, and it reveals nothing about topology.
 *
 * A plain resource route (no UI), static so it ranks above the `:page`
 * catch-all in `routes.ts`.
 */

import { createDefaultErrorReporter } from '@maxstack/features/observability'
import { getSprout } from '~/sprout.server'

export async function loader() {
	const startedAt = Date.now()
	try {
		const { backend } = await getSprout()
		await backend.exec('SELECT 1;')
		return Response.json(
			{
				status: 'ok',
				db: true,
				durationMs: Date.now() - startedAt,
				timestamp: new Date().toISOString(),
			},
			{ status: 200 },
		)
	} catch (err) {
		// Reported (redacted) where an operator will see it…
		createDefaultErrorReporter().capture(err, { route: '/health' })
		return Response.json(
			{
				// …and deliberately absent from the response.
				status: 'error',
				db: false,
				durationMs: Date.now() - startedAt,
				timestamp: new Date().toISOString(),
			},
			{ status: 503 },
		)
	}
}
