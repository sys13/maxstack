/**
 * Server-side glue for the runnable project app (task 21).
 *
 * `project-routes.ts` is the pure composition; this decides *when* to reload the
 * spec and bridges a URL slug to a live Sprout resource. The generic project
 * route modules (`routes/project.*.tsx`) call these so the same on-disk spec
 * that the workbench reviews also drives the app's navigable pages — the spec is
 * the single source of truth for both the review surface and the running app.
 */

import { manifestRowCount } from '@maxstack/features/demo-mode'
import { resolveTheme, type SpecSystem, type ThemeSpec } from '@maxstack/spec'
import { data } from 'react-router'
import { resolveViewerFlags } from './flags.server'
import {
	getRoutes,
	matchProjectPath,
	type ProjectMatch,
	type ProjectRoute,
	resolveRoute,
} from './project-routes'
import { demoSeedManifest, getPlatform, getSprout } from './sprout.server'

/**
 * Project mode is on whenever the server is pointed at a project on disk. The
 * home route uses this to decide between the project landing page and the
 * demo's `/admin` redirect. Mirrors `resolveDataDir`'s primary signal.
 */
export function isProjectMode(): boolean {
	return !!process.env.MAXSTACK_DATA_DIR?.trim()
}

/**
 * The viewer a flag is evaluated against. Everything here comes
 * from the server's own identity resolution — never from a header or a query
 * param the client controls, since a flag frequently gates an unreleased
 * surface and "add a header to see it" is not a rollout.
 *
 * `request` is a required argument on every function that composes routes,
 * rather than an optional one, on the same reasoning as `canPerformAction`'s
 * required resource name: an optional viewer is a viewer someone
 * forgets to pass.
 */
async function flagsFor(
	request: Request,
	spec: SpecSystem,
): Promise<Record<string, boolean>> {
	return resolveViewerFlags(request, spec)
}

/** Every navigable page of the running app, freshly grounded from the spec. */
export async function loadProjectRoutes(
	request: Request,
): Promise<ProjectRoute[]> {
	const spec = await getPlatform().spec.load()
	return getRoutes(spec, await flagsFor(request, spec))
}

/**
 * The chrome every project route frames itself with: the product title, the
 * resolved theme (zinc default until a `theme.set` lands), and
 * how many rows are tracked as demo data. One spec load for the
 * set, since every project loader needs it.
 */
export async function projectChrome(): Promise<{
	title: string
	theme: ThemeSpec
	demoRows: number
}> {
	const spec = await getPlatform().spec.load()
	return {
		title: spec.product.meta.title,
		theme: resolveTheme(spec),
		// The sample-data notice lives in the frame so it appears on every project
		// surface — including the card and feed list variants, which have no
		// per-row chrome to carry the `demo` chip.
		demoRows: manifestRowCount(await demoSeedManifest()),
	}
}

/** Just enough of the app to frame a page that failed: the nav, the name, the theme. */
export interface ProjectShell {
	title: string
	theme: ThemeSpec
	pages: Pick<ProjectRoute, 'slug' | 'name'>[]
}

/**
 * The chrome the *root error boundary* frames a failure with (#339).
 *
 * Loaded by the root loader rather than by the failing route, and that is the
 * whole point: a boundary cannot await anything, and the data it needs cannot
 * come from the loader that just died. The root loader is the only one
 * guaranteed to have run — a child route's error leaves root's data intact — so
 * an error page can still show the nav, the app's own name and its declared
 * theme. If the *root* loader is what failed there is no shell, and the boundary
 * falls back to the chrome-less fallback, which is the honest answer.
 *
 * `null` outside project mode: `/admin` and `/workbench` are platform chrome
 * with no spec-declared nav to render, and demo mode has no project at all.
 */
export async function projectShell(
	request: Request,
): Promise<ProjectShell | null> {
	if (!isProjectMode()) return null
	const spec = await getPlatform().spec.load()
	const flags = await flagsFor(request, spec)
	return {
		title: spec.product.meta.title,
		theme: resolveTheme(spec),
		pages: getRoutes(spec, flags).map(({ slug, name }) => ({ slug, name })),
	}
}

/**
 * The arguments every project surface's loader and action take.
 *
 * Hand-written rather than React Router's generated `Route.LoaderArgs`, because
 * these four modules stopped being route modules in issue #251 — the router
 * mounts one splat that decides what a path means and delegates here, so there
 * is no per-module route id for typegen to hang types off. `params` is what the
 * splat resolved, not what a path pattern happened to bind.
 */
export interface ProjectRouteArgs {
	request: Request
	params: { page: string }
}

/**
 * The same, for the surfaces scoped to one record.
 *
 * `id` is required rather than optional because the splat only dispatches here
 * when it resolved one — an optional id would push a `params.id!` or a
 * `?? ''` into every store call, i.e. turn "this route always has a record"
 * from something the type says into something each call site re-asserts.
 */
export interface ProjectRecordArgs extends ProjectRouteArgs {
	params: { page: string; id: string }
}

/**
 * Match a whole request path to a page and an intent, or 404.
 *
 * The flag-aware, spec-loading half of {@link matchProjectPath}: a page gated
 * behind a flag that is off for this viewer is not matched at all, exactly as
 * `resolveProjectPage` treats it — a link nobody can see and everybody can type
 * is not a hidden page.
 */
export async function matchProjectRequest(
	path: string,
	request: Request,
): Promise<ProjectMatch> {
	const match = await tryMatchProjectRequest(path, request)
	if (!match) throw data({ error: `Unknown page "${path}"` }, { status: 404 })
	return match
}

/**
 * The same match, as a question rather than an assertion.
 *
 * The project splat throws on a miss because nothing else can serve the path.
 * Under `/admin` there *is* something else — the generic registry CRUD — and the
 * spec is only asked first, so a miss there has to be an answer the caller can
 * act on rather than a 404 thrown past it.
 */
export async function tryMatchProjectRequest(
	path: string,
	request: Request,
): Promise<ProjectMatch | undefined> {
	const spec = await getPlatform().spec.load()
	const flags = await flagsFor(request, spec)
	return matchProjectPath(spec, path, flags)
}

export interface ResolvedProjectPage {
	/** The matched page. */
	page: ProjectRoute
	/** The full navigable set, for the shared top nav. */
	nav: ProjectRoute[]
}

/**
 * Resolve a URL slug to its page + the nav set, throwing a 404 `Response` if no
 * accepted page owns the slug — the shape a route loader re-throws directly.
 */
export async function resolveProjectPage(
	slug: string,
	request: Request,
): Promise<ResolvedProjectPage> {
	const spec = await getPlatform().spec.load()
	const flags = await flagsFor(request, spec)
	const page = resolveRoute(spec, slug, flags)
	if (!page) throw data({ error: `Unknown page "${slug}"` }, { status: 404 })
	return { page, nav: getRoutes(spec, flags) }
}

/**
 * Resolve a page *and* confirm its backing resource is grounded in the Sprout
 * registry (an accepted entity with an on-disk table). Throws 404 otherwise, so
 * a page whose entity isn't live yet fails cleanly instead of 500-ing.
 */
export async function resolveProjectResource(
	slug: string,
	request: Request,
): Promise<
	ResolvedProjectPage & {
		resource: string
		primaryKey: string
		introspection: import('@maxstack/core').SproutResource
	}
> {
	const resolved = await resolveProjectPage(slug, request)
	const { resource } = resolved.page
	if (!resource)
		throw data(
			{ error: `Page "${slug}" has no backing entity` },
			{ status: 404 },
		)
	const { registry } = await getSprout()
	const entry = registry.get(resource)
	if (!entry)
		throw data(
			{ error: `Resource "${resource}" is not grounded yet` },
			{ status: 404 },
		)
	return {
		...resolved,
		resource,
		primaryKey: entry.resource.primaryKey,
		introspection: entry.resource,
	}
}
