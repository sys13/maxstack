/**
 * The app root (task 21). In demo mode there is no project, so `/` sends the
 * visitor to the generic `/admin`. In project mode (`MAXSTACK_DATA_DIR`) `/` is
 * the running app's own root — either a page the spec declares there, or the
 * landing page below.
 *
 * ## Why this route asks the spec first
 *
 * This is issues #251 and #252 at the root, and it is the last place the pattern
 * had not reached. A page declares its own URL, and `/` is a legitimate thing to
 * declare — for most apps it is the *natural* thing to declare, since the app's
 * main surface is the app. But `/` is not matched by the project splat at the
 * bottom of `routes.ts`: an index route outranks a splat, and this is that index
 * route. So a page declared at `/` used to be composed into the nav, linked to,
 * and then served this landing page instead — no error, no 404, just the wrong
 * screen. Silent, exactly like `/app/decks` and `/admin/posts`.
 *
 * The precedence is the one both of those settled on: **a declared page beats
 * the platform's interpretation of the path.** If the spec says a page lives at
 * `/`, that is what `/` means, and this route delegates to the same
 * `project.surface.*` dispatch the two splats use — so a root page behaves
 * identically to a page declared anywhere else, rather than depending on which
 * route happened to serve it.
 *
 * The landing page is what `/` means when *no* page claims it: the spec's pages
 * as a click-through index, so an app with several equal top-level surfaces
 * still has a front door.
 *
 * First-run onboarding (task 63 / issue #60): while the project is fresh (every
 * resource still at zero rows), the landing page leads with a short wizard —
 * load sample data to explore, or start entering real data. No separate
 * "setup complete" flag: the wizard is driven off `isFreshProject()`, so it
 * disappears on its own the moment either path produces a row. A project whose
 * root *is* a declared page gets the same wizard from that page's own empty
 * state, which is the surface the visitor is actually looking at.
 */

import { Form, Link, redirect } from 'react-router'
import { pagePath } from '~/page-path'
import {
	isProjectMode,
	loadProjectRoutes,
	projectChrome,
	tryMatchProjectRequest,
} from '~/project.server'
import { ProjectFrame } from '~/project-nav'
import { NOINDEX_META, pageMeta } from '~/seo'
import { getPlatform, hasDemoData, isFreshProject } from '~/sprout.server'
import type { Route } from './+types/home'
import ProjectSurface from './project.surface'
import {
	projectSurfaceAction,
	projectSurfaceLoader,
} from './project.surface.server'

/**
 * The root as the spec sees it: the empty path, which `matchProjectPath`
 * resolves against a page declaring `/` (`slugOf('/')` is `''`).
 */
const ROOT_PATH = ''

export async function loader({ request }: Route.LoaderArgs) {
	if (!isProjectMode()) throw redirect('/admin')
	const claim = await tryMatchProjectRequest(ROOT_PATH, request)
	if (claim)
		return {
			kind: 'project' as const,
			surface: await projectSurfaceLoader(claim, request),
		}
	const spec = await getPlatform().spec.load()
	return {
		kind: 'landing' as const,
		...(await projectChrome()),
		site: spec.site,
		tagline: spec.product.context.tldr,
		pages: await loadProjectRoutes(request),
		fresh: await isFreshProject(),
		demoAvailable: await hasDemoData(),
	}
}

/**
 * `/` is the app's front door and the one route whose indexability is a
 * judgement rather than a derivation.
 *
 * It is indexable **only when a site is declared** — which is exactly the signal
 * that somebody decided this app has a public identity. Without one this
 * inherits root's `noindex` through `pageMeta`'s no-site branch, so a project
 * running on a laptop or an internal deployment is not advertising its root.
 *
 * When `/` is served by a *declared page* rather than the landing page, the
 * spec's page is the surface and the platform has no title to claim for it, so
 * this stays on the site-level defaults rather than inventing one.
 */
export function meta({ loaderData }: Route.MetaArgs) {
	if (!loaderData || loaderData.kind === 'project') return NOINDEX_META
	return pageMeta(
		{
			// The site name titles the home page: `composeTitle` collapses
			// "name · name" to a single "name" rather than repeating it.
			title: loaderData.site?.name,
			// The product's own one-liner, never a fabricated sentence. If it is
			// missing or too short the gate says so on this route by name.
			description: loaderData.site?.description ?? loaderData.tagline,
			path: '/',
		},
		loaderData.site,
	)
}

/**
 * A write against the root page — the list surface itself has none, but a page
 * declared at `/` still needs this to exist, because React Router posts a form
 * to the route that rendered it. Without it a `<Form method="post">` on the root
 * page 405s at the router before the dispatch below could answer.
 */
export async function action({ request }: Route.ActionArgs) {
	if (!isProjectMode()) throw redirect('/admin')
	const claim = await tryMatchProjectRequest(ROOT_PATH, request)
	if (!claim) throw redirect('/')
	return projectSurfaceAction(claim, request)
}

export default function Home({ loaderData }: Route.ComponentProps) {
	if (loaderData.kind === 'project')
		return <ProjectSurface surface={loaderData.surface} />
	const { title, theme, demoRows, tagline, pages, fresh, demoAvailable } =
		loaderData
	return (
		<ProjectFrame pages={pages} title={title} theme={theme} demoRows={demoRows}>
			<section>
				<h1 className="text-3xl font-semibold">{title}</h1>
				{tagline ? (
					<p className="mt-2 max-w-2xl text-muted-foreground">{tagline}</p>
				) : null}
				{fresh ? (
					<div className="mt-6 rounded-lg border border-dashed border-border px-6 py-8 text-center">
						<p className="font-medium">Welcome — this project is empty.</p>
						<p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
							{demoAvailable
								? 'Load sample data to see the app in action, or start adding your own records.'
								: 'Start adding your own records, or add pages in the workbench.'}
						</p>
						<div className="mt-4 flex flex-wrap items-center justify-center gap-2">
							<Link
								to="/onboarding"
								className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground no-underline shadow transition-colors hover:bg-primary/90"
							>
								Set up your workspace
							</Link>
							{demoAvailable ? (
								<Form method="post" action="/onboarding/seed">
									<input type="hidden" name="redirectTo" value="/" />
									<button
										type="submit"
										className="inline-flex h-9 items-center rounded-md border border-border px-4 text-sm font-medium transition-colors hover:bg-accent"
									>
										Load demo data
									</button>
								</Form>
							) : null}
							{pages[0] ? (
								<Link
									to={pagePath(pages[0].slug)}
									className="inline-flex h-9 items-center rounded-md border border-border px-4 text-sm font-medium no-underline transition-colors hover:bg-accent"
								>
									Start adding your own
								</Link>
							) : null}
						</div>
					</div>
				) : null}
				{pages.length === 0 ? (
					<p className="mt-8 text-muted-foreground">
						No pages yet — add one in the workbench, then it appears here.
					</p>
				) : (
					<ul className="mt-8 grid gap-3 sm:grid-cols-2">
						{pages.map((p) => (
							<li key={p.slug}>
								<Link
									to={pagePath(p.slug)}
									className="block rounded-lg border border-border p-4 no-underline transition-colors hover:bg-accent"
								>
									<span className="font-medium">{p.name}</span>
									<span className="mt-1 block text-sm text-muted-foreground">
										/{p.slug}
										{p.resource ? ` · ${p.resource}` : ''}
									</span>
								</Link>
							</li>
						))}
					</ul>
				)}
			</section>
		</ProjectFrame>
	)
}
