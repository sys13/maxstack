/**
 * Everything under `/admin`, behind one splat route.
 *
 * ## Why one route and not four
 *
 * This is issue #251 one level out. That fix made a two-segment spec page
 * reachable by mounting the project surface as a single splat that resolves the
 * path against the spec — and noted that a splat still ranks below every static
 * route, which is true and was the case it did not cover: `/admin` is not one
 * route, it is a **namespace**, and its four dynamic children (`:resource`,
 * `:resource/new`, `:resource/trash`, `:resource/:id`) outrank a splat and
 * swallow every path below it.
 *
 * So a blog spec declaring a page at `/admin/posts` — recorded faithfully by
 * `maxstack gen`, linked from the project nav — was routed as the generic CRUD
 * for a resource named `posts`. The registry has `post`, the lookup missed, and
 * the page 404'd while `/admin/post` happily served the platform's own table.
 * `/admin/posts/new` collided with `:resource/:id` the same way, so creating a
 * record was broken too.
 *
 * The children cannot simply be widened, because `/admin/posts` (a declared
 * page) and `/admin/post/42` (a record) are the same shape. Only the spec knows
 * which is which, so — exactly as in #251 — the split happens here, after the
 * spec is loaded.
 *
 * ## The order the two questions are asked in
 *
 * The spec first. **A declared page beats an interpretation of one**: if a spec
 * says a page lives at `/admin/posts`, that is what `/admin/posts` means, and
 * guessing past that declaration is how a declared route becomes unreachable —
 * the defect being fixed. Only when no page owns the path is it read as the
 * generic admin's `resource[/new|/trash|/:id]`.
 *
 * In practice the two barely overlap: a resource is the singular entity name and
 * a page route is whatever its author wrote. Where they do collide, the spec is
 * the app and the generic admin is the platform's view of it.
 *
 * ## Why a declared page does not render in the admin's chrome
 *
 * The delegation escapes `admin.tsx` rather than nesting inside it: this splat
 * is a sibling of the `/admin` layout route, not a child of it.
 *
 * A page at `/admin/posts` is a *project* page that happens to have `/admin` in
 * its URL. It already carries its own frame — the product title, the spec's
 * theme, and a nav over the project's own pages — and rendering that inside the
 * platform's admin sidebar would put two navigations over the same data on one
 * screen, pointing at two different sets of URLs (`/admin/posts` and
 * `/admin/post`), with the app's own title inside a frame that says "maxstack
 * admin". It would also make a spec page's rendering depend on the admin
 * layout's loader — a registry walk and a `resolveUser` — which the page does
 * not use and should not fail with.
 *
 * The cost of escaping is that the generic surfaces are wrapped in `AdminChrome`
 * here instead of inheriting it from a parent. That is one `<AdminChrome>` in
 * this file, and it keeps the two surfaces honest about which one they are.
 *
 * ## Consequences worth knowing about
 *
 * The four admin modules are no longer route modules. They keep their own code
 * and their own loaders, but a route module gets `loader`/`action` stripped from
 * the client bundle and a plain module does not, so each loader moved to a
 * `.server.ts` sibling — otherwise `~/sprout.server` and friends ship to the
 * browser. Their `params` are now what this module resolved rather than what a
 * pattern bound, so they carry hand-written types (`AdminResourceArgs`,
 * `AdminRecordArgs`).
 */

import { data } from 'react-router'
import { adminChromeData } from '~/admin.server'
import { AdminChrome } from '~/admin-chrome'
import { adminProjectMatchApplies, matchAdminPath } from '~/admin-routes'
import { tryMatchProjectRequest } from '~/project.server'
import type { Route } from './+types/admin.$'
import ResourceListPage from './admin.resource'
import EditRecord from './admin.resource.$id'
import {
	action as recordAction,
	loader as recordLoader,
} from './admin.resource.$id.server'
import NewRecord from './admin.resource.new'
import {
	action as newAction,
	loader as newLoader,
} from './admin.resource.new.server'
import { action as parseAction } from './admin.resource.parse.server'
import { loader as listLoader } from './admin.resource.server'
import TrashPage from './admin.resource.trash'
import {
	action as trashAction,
	loader as trashLoader,
} from './admin.resource.trash.server'
import ProjectSurface from './project.surface'
import {
	projectSurfaceAction,
	projectSurfaceLoader,
} from './project.surface.server'

/** `params['*']` is the path below `/admin`, e.g. `posts/new` or `post/42`. */
const restOf = (params: { '*'?: string }): string => params['*'] ?? ''

/**
 * The path as the spec sees it — a page declares `/admin/posts`, so the whole
 * pathname is what has to be matched, not the part below the prefix.
 */
const fullPath = (rest: string): string => `admin/${rest}`

/**
 * A spec page's claim on this path, or `undefined` if none applies.
 *
 * Asked before the generic admin, and asked of the *whole* path — see the
 * precedence note above.
 */
async function projectClaim(rest: string, request: Request) {
	const match = await tryMatchProjectRequest(fullPath(rest), request)
	return match && adminProjectMatchApplies(match) ? match : undefined
}

export async function loader({ request, params }: Route.LoaderArgs) {
	const rest = restOf(params)
	const claim = await projectClaim(rest, request)
	if (claim)
		return {
			kind: 'project' as const,
			surface: await projectSurfaceLoader(claim, request),
		}

	const match = matchAdminPath(rest)
	if (!match)
		throw data({ error: `Unknown admin path "${rest}"` }, { status: 404 })
	const args = { request, params: { resource: match.resource } }
	const chrome = await adminChromeData(request)
	switch (match.kind) {
		case 'list':
			return {
				kind: 'admin' as const,
				chrome,
				surface: { kind: 'list' as const, data: await listLoader(args) },
			}
		case 'new':
			return {
				kind: 'admin' as const,
				chrome,
				surface: { kind: 'new' as const, data: await newLoader(args) },
			}
		case 'trash':
			return {
				kind: 'admin' as const,
				chrome,
				surface: { kind: 'trash' as const, data: await trashLoader(args) },
			}
		case 'parse':
			// An action endpoint, not a surface — there is nothing here to render.
			throw data({ error: 'Method not allowed' }, { status: 405 })
		case 'edit':
			return {
				kind: 'admin' as const,
				chrome,
				surface: {
					kind: 'edit' as const,
					data: await recordLoader({
						request,
						params: { resource: match.resource, id: match.id },
					}),
				},
			}
	}
}

export async function action({ request, params }: Route.ActionArgs) {
	const rest = restOf(params)
	const claim = await projectClaim(rest, request)
	if (claim) return projectSurfaceAction(claim, request)

	const match = matchAdminPath(rest)
	if (!match)
		throw data({ error: `Unknown admin path "${rest}"` }, { status: 404 })
	const args = { request, params: { resource: match.resource } }
	switch (match.kind) {
		case 'new':
			return newAction(args)
		case 'trash':
			return trashAction(args)
		case 'parse':
			return parseAction(args)
		case 'edit':
			return recordAction({
				request,
				params: { resource: match.resource, id: match.id },
			})
		case 'list':
			// The list has no action of its own; writes go to `new` and `:id`.
			throw data({ error: 'Method not allowed' }, { status: 405 })
	}
}

export default function AdminSurface({ loaderData }: Route.ComponentProps) {
	if (loaderData.kind === 'project')
		return <ProjectSurface surface={loaderData.surface} />
	const { chrome, surface } = loaderData
	return (
		<AdminChrome {...chrome}>
			{surface.kind === 'list' ? (
				<ResourceListPage loaderData={surface.data} />
			) : surface.kind === 'new' ? (
				<NewRecord loaderData={surface.data} />
			) : surface.kind === 'trash' ? (
				<TrashPage loaderData={surface.data} />
			) : (
				<EditRecord loaderData={surface.data} />
			)}
		</AdminChrome>
	)
}
