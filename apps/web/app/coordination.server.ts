/**
 * The process's coordinator, and the one place that decides whether this
 * deployment is coordinating with anybody (absorbing #227's first
 * half).
 *
 * Two bounds shipped as stated bounds and turned out to be one bound: live
 * fan-out held its subscriber table in one process's memory, and the rate
 * limiter held its buckets in one process's memory. Both mean "this process
 * believes it is the only one", both are wrong the moment a second container
 * starts, and both are fixed by the same shared store — so there is one seam in
 * `@maxstack/core` and this module opens exactly one of it.
 *
 * ## What selects which
 *
 * The store backend, and nothing else. No feature flag, no `LIVE_BROKER_URL`,
 * no third mode:
 *
 *  - **Postgres** — the shared coordinator. Every instance already holds a
 *    connection to it, so this adds no service to deploy and no credential to
 *    rotate.
 *  - **pglite** — the in-process one, and that is the correct implementation
 *    rather than a fallback. pglite is embedded and single-writer; issue #123
 *    puts an `O_EXCL` lock on the data dir so a second process *cannot* open it.
 *    There is no second instance to coordinate with, by construction.
 *
 * A flag would let a Postgres deployment run un-coordinated by accident, which
 * is precisely the state #227 and #228 were filed about — one that works in
 * every single-instance test and is wrong in production. The backend already
 * answers the question, so it is the only thing asked.
 *
 * ## It says so at boot
 *
 * Once per process, on the first use, this logs which shape it got and what
 * that means for a declared budget. "The declaration says a number and the
 * deployment delivers a multiple of it, **silently**" was the reportable half of
 * #227; the multiplication is defensible when an operator chose it, and the
 * silence never was.
 */

import type { Coordinator } from '@maxstack/core'
import {
	createInProcessCoordinator,
	createPostgresCoordinator,
} from '@maxstack/core'
import { getSprout } from './sprout.server'

const scope = globalThis as typeof globalThis & {
	__maxstackCoordinator?: Promise<Coordinator>
}

/**
 * The process-lifetime coordinator.
 *
 * A singleton on `globalThis` rather than a module constant, on `getAuditSink`'s
 * reasoning: dev HMR reloads the module and would otherwise open a second
 * `LISTEN` connection per edit, leaving the old one holding a connection nobody
 * can reach.
 */
export function getCoordinator(): Promise<Coordinator> {
	scope.__maxstackCoordinator ??= (async () => {
		const { backend } = await getSprout()
		// `listen` is absent on pglite by design — see `StoreBackend.listen`. The
		// capability is asked for rather than the backend kind, so a future backend
		// that can do it gets the shared path without editing this line.
		if (backend.kind !== 'postgres' || !backend.listen) {
			console.info(
				'[coordination] single-instance mode: live fan-out and rate-limit ' +
					'buckets are held in this process. A declared rateLimitPerHour is ' +
					'enforced per instance, and a live subscriber only sees writes this ' +
					'instance handled. Correct for the default deploy (one container over ' +
					'pglite) and wrong for any multi-instance one — point DATABASE_URL at ' +
					'Postgres to coordinate.',
			)
			return createInProcessCoordinator()
		}
		const coordinator = await createPostgresCoordinator(backend)
		console.info(
			'[coordination] shared mode over Postgres: rate-limit budgets are ' +
				'enforced across every instance, and a live subscriber sees writes any ' +
				'instance handled. Announcements are not replayed, so a subscriber whose ' +
				'instance loses its LISTEN connection is stale until it polls.',
		)
		return coordinator
	})()
	return scope.__maxstackCoordinator
}
