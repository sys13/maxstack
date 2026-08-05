/**
 * Server-side glue for the generic admin.
 *
 * The admin used to be one layout route with four dynamic children, so all of
 * this lived in `routes/admin.tsx` and the children got their types from
 * typegen. Those children were what swallowed spec pages declared under `/admin`
 * — a dynamic segment outranks the project splat — so they were replaced by one
 * splat that resolves the path itself. The surfaces below it are no longer route
 * modules, which is why their arguments are written out here instead of
 * generated, and why the chrome's loader is a function two route modules call
 * rather than a `loader` export one of them owns.
 */

import { getPlatform, getSprout, resolveUser } from './sprout.server'

/**
 * The admin sidebar's contents: every registered resource grouped as the
 * registry groups them, plus the read-only spec views.
 */
export async function adminChromeData(request: Request): Promise<{
	groups: {
		group: string
		resources: { name: string; label: string; icon: string | null }[]
	}[]
	specNav: { product: string; pages: number; pricing: number }
	role: string
}> {
	const { registry } = await getSprout()
	const grouped = registry.allGrouped()
	const groups = Object.entries(grouped).map(([group, entries]) => ({
		group,
		resources: entries.map((e) => ({
			name: e.resource.name,
			label: e.label,
			icon: e.config.icon ?? null,
		})),
	}))
	// The spec holds far more than the data entities the registry surfaces —
	// the product brief (PRD), the page/UX layer, and the pricing tiers all
	// live in the same `SpecSystem` but have no CRUD resource. Surface them as
	// read-only "Spec" views so the admin can browse the whole spec, not just
	// the tables derived from it.
	const spec = await getPlatform().spec.load()
	const specNav = {
		product: spec.product?.meta?.title ?? 'Product',
		pages: spec.pages?.pages?.length ?? 0,
		pricing: spec.pricing?.tiers?.length ?? 0,
	}
	const user = await resolveUser(request)
	return { groups, specNav, role: user?.role ?? 'anonymous' }
}

/** What the chrome renders — the shape both splat and layout hand it. */
export type AdminChromeData = Awaited<ReturnType<typeof adminChromeData>>

/**
 * The arguments every generic admin surface's loader and action take.
 *
 * Hand-written rather than React Router's generated `Route.LoaderArgs`, for the
 * reason `ProjectRouteArgs` is: these stopped being route modules in issue #252,
 * so there is no per-module route id for typegen to hang types off. `params` is
 * what the splat resolved, not what a path pattern happened to bind.
 */
export interface AdminResourceArgs {
	request: Request
	params: { resource: string }
}

/**
 * The same, for the surfaces scoped to one record. `id` is required rather than
 * optional because the splat only dispatches here when it resolved one.
 */
export interface AdminRecordArgs extends AdminResourceArgs {
	params: { resource: string; id: string }
}
