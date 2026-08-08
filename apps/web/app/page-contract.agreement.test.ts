/**
 * Agreement: every URL the page contract publishes is a URL this app serves.
 *
 * `packages/maxstack-core/src/sprout/page-contract.ts` repeats one rule the app
 * owns — how a page's route and a trailing segment join into a URL — because
 * `apps/web/app/page-path.ts` is deliberately dependency-free (client
 * components import it, and a value import of the core graph there is how #251
 * shipped ts-morph to the browser), so core cannot share it and `@maxstack/mcp`
 * cannot import the app.
 *
 * A duplicated rule is only acceptable when something fails on divergence. That
 * is this file, in the same shape as `blast-radius.agreement.test.ts`: the
 * duplicate is deliberate, and it is pinned rather than trusted.
 *
 * Why it has to be pinned rather than reasoned about: a published contract is a
 * set of URLs an agent will drive *instead of* probing. `POST /decks/:id` is
 * worse than no answer at all — worse because it is *specific* — if the app
 * actually serves that record under some other path. The failure would be
 * silent, plausible, and would land as the caller concluding the platform is
 * broken, which is the whole of #376.
 *
 * Two rules are checked, because the contract makes two claims: the paths are
 * the ones `pagePath` builds, and the router resolves each of them back to the
 * surface the contract says it is.
 */

import { pageContract, pageCreatePath, pageRecordPath } from '@maxstack/core'
import {
	manual,
	newSpecSystem,
	type PageSpec,
	type SpecSystem,
} from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import { describe, expect, it } from 'vitest'
import { pagePath } from './page-path'
import { getRoutes, matchProjectPath } from './project-routes'

const page = (route: string): PageSpec => ({
	id: `pg-${route}`,
	name: 'Decks',
	route,
	entityId: 'e-deck',
	provenance: manual(),
	blocks: [{ id: 'blk-table', type: 'table', provenance: manual() }],
})

/** The routes a spec declaring exactly these page routes composes to. */
function specWith(routes: string[]): SpecSystem {
	const spec = newSpecSystem(tasklyPRD)
	return { ...spec, pages: { pages: routes.map(page) } }
}

// A one-segment page, a two-segment page, and the root — the three shapes
// `matchProjectPath` splits differently.
const ROUTES = ['/decks', '/app/decks', '/']

describe('the published page contract agrees with the app', () => {
	it('builds the same paths `pagePath` does', () => {
		for (const route of getRoutes(specWith(ROUTES))) {
			expect(pageCreatePath(route.route), route.route).toBe(
				pagePath(route.slug, 'new'),
			)
			expect(pageRecordPath(route.route), route.route).toBe(
				pagePath(route.slug, ':id'),
			)
		}
	})

	it('publishes no URL the router resolves to something else', () => {
		const spec = specWith(ROUTES)
		for (const route of getRoutes(spec)) {
			const contract = pageContract(route)
			for (const endpoint of contract.endpoints) {
				const path = endpoint.request.slice(endpoint.request.indexOf(' ') + 1)
				// A record id is a real segment on the wire; `:id` is the contract's
				// way of writing one, so it is substituted before matching.
				const concrete = path.replace(
					/:id$/,
					'11111111-2222-3333-4444-555555555555',
				)
				const match = matchProjectPath(spec, concrete)
				expect(match?.page.route, concrete).toBe(route.route)
				expect(match?.kind, concrete).toBe(
					concrete.endsWith('/new')
						? 'new'
						: concrete.endsWith('/parse')
							? 'parse'
							: concrete === path
								? 'list'
								: 'edit',
				)
			}
		}
	})
})
