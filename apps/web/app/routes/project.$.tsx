/**
 * The whole project surface, behind one splat route.
 *
 * ## Why one route and not four
 *
 * A spec page declares its own URL, and that URL can be more than one segment
 * long — `/app/decks` is as legitimate a declaration as `/decks`, and every page
 * in every benchmark uses two. The project surface used to be mounted as four
 * patterns (`:page`, `:page/new`, `:page/parse`, `:page/:id`), each of which can
 * bind exactly **one** segment to the page. `/app/decks` therefore matched
 * `:page/:id` as page `app` and record `decks`, and 404'd on a page named `app`
 * that nobody had declared. `maxstack gen` recorded the route faithfully and the
 * nav linked to it; the app just never served it.
 *
 * The four patterns cannot simply be widened, because `/app/decks` and
 * `/decks/42` are the same shape. Only the spec knows which one is a two-segment
 * page and which is a record on a one-segment page, so the decision has to be
 * made after the spec is loaded rather than by the router — which means one
 * route, matched last, that resolves the path itself (`matchProjectPath`).
 *
 * ## Why the four modules still exist
 *
 * They are still four different pages with four different loaders; only the
 * *addressing* was ever the problem. This module decides what a path means and
 * hands off (`project.surface.*`), so list/new/edit/parse keep their own code
 * and their own tests, and the diff that fixed the addressing did not touch what
 * any of them render.
 *
 * They are no longer route modules, though, so they take a hand-written
 * `ProjectRouteArgs` instead of React Router's generated per-route types, and
 * the `params` they receive are what this module resolved rather than what a
 * path pattern happened to bind.
 *
 * ## Ranking
 *
 * A splat is the lowest-priority match in React Router, so every static route
 * above it — `/admin`, `/workbench`, `/mcp`, `/api/*`, `/health`, `/login` —
 * still wins, exactly as they won over `:page` before. This is strictly safer
 * than the dynamic segments it replaces: `:page/:id` outranked nothing and could
 * swallow a two-segment static path that arrived later.
 *
 * That ranking is also the reason this is not the only route that resolves a
 * spec page. `/admin` is not one static route but a namespace, and its own
 * dynamic children outranked this splat and swallowed every path below it — so a
 * page declared at `/admin/posts` 404'd. `routes/admin.$.tsx`
 * resolves that namespace the same way, asking the spec first and delegating to
 * the same `project.surface.*` pair.
 */

import { matchProjectRequest } from '~/project.server'
import type { Route } from './+types/project.$'
import ProjectSurface from './project.surface'
import {
	projectSurfaceAction,
	projectSurfaceLoader,
} from './project.surface.server'

/** `params['*']` is the whole matched path, e.g. `app/decks/42`. */
const pathOf = (params: { '*'?: string }): string => params['*'] ?? ''

export async function loader({ request, params }: Route.LoaderArgs) {
	return projectSurfaceLoader(
		await matchProjectRequest(pathOf(params), request),
		request,
	)
}

export async function action({ request, params }: Route.ActionArgs) {
	return projectSurfaceAction(
		await matchProjectRequest(pathOf(params), request),
		request,
	)
}

export default function ProjectRoute({ loaderData }: Route.ComponentProps) {
	return <ProjectSurface surface={loaderData} />
}
