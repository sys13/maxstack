import type { ThemeSpec } from '@maxstack/spec'
import { themeToCss } from '@maxstack/ui'
import { Form, NavLink } from 'react-router'
import { pagePath } from './page-path'
import type { ProjectRoute } from './project-routes'

/**
 * The running app's top nav — one link per navigable page, plus the always-on
 * `/admin` and `/workbench` surfaces. Rendered by every project route so the
 * generated pages read as one click-through app, not isolated screens.
 */
export function ProjectNav({
	pages,
	title,
}: {
	pages: Pick<ProjectRoute, 'slug' | 'name'>[]
	title?: string
}) {
	return (
		<header className="border-b border-border bg-muted/40">
			<nav className="mx-auto flex max-w-4xl flex-wrap items-center gap-1 px-6 py-3">
				<NavLink to="/" className="mr-3 font-semibold no-underline">
					{title ?? 'maxstack'}
				</NavLink>
				{pages.map((p) => (
					<NavLink
						key={p.slug}
						to={pagePath(p.slug)}
						className={({ isActive }) =>
							`rounded-md px-3 py-1.5 text-sm no-underline hover:bg-accent ${
								isActive ? 'bg-accent font-medium' : 'text-muted-foreground'
							}`
						}
					>
						{p.name}
					</NavLink>
				))}
				<span className="ml-auto flex gap-1">
					<NavLink
						to="/admin"
						className="rounded-md px-3 py-1.5 text-sm text-muted-foreground no-underline hover:bg-accent"
					>
						⚙ Admin
					</NavLink>
					<NavLink
						to="/workbench"
						className="rounded-md px-3 py-1.5 text-sm text-muted-foreground no-underline hover:bg-accent"
					>
						🛠 Workbench
					</NavLink>
					{/* Static link: ProjectNav is presentational and fed no
					    session state, so we always point at `/login` rather than thread
					    auth through every ProjectFrame caller. The login loader bounces
					    an already-signed-in visitor back home. */}
					<NavLink
						to="/login"
						className="rounded-md px-3 py-1.5 text-sm text-muted-foreground no-underline hover:bg-accent"
					>
						Sign in
					</NavLink>
				</span>
			</nav>
		</header>
	)
}

/**
 * The demo-data notice. A visitor whose very first screen was
 * populated by `maxstack start` has to be told, in the app, that those rows are
 * samples — and given the one control that removes them. Without this the
 * fastest path to a populated app is also the fastest path to mistaking demo
 * data for real data.
 *
 * A `<Form>`, not a link: clearing is a write, and it posts to the same
 * `/onboarding/clear` action `maxstack demo --clear` uses, so the button and
 * the command cannot drift.
 */
function DemoDataNotice({ rows }: { rows: number }) {
	return (
		<div className="border-b border-warning/30 bg-warning/10">
			<div className="mx-auto flex max-w-4xl flex-wrap items-center gap-x-3 gap-y-1 px-6 py-2 text-sm">
				<span className="font-medium text-warning">Sample data</span>
				<span className="text-warning/80">
					{rows} row{rows === 1 ? '' : 's'} here were loaded as a demo — they
					are not your data.
				</span>
				<Form
					method="post"
					action="/onboarding/clear"
					className="ml-auto inline"
				>
					<button
						type="submit"
						className="cursor-pointer rounded-md border border-warning/50 px-2 py-1 text-xs font-medium text-warning hover:bg-warning/20"
					>
						Remove demo data
					</button>
				</Form>
			</div>
		</div>
	)
}

/**
 * Consistent page frame: the top nav over a centered content column.
 *
 * When a `theme` is passed (the spec's resolved theme), the frame
 * becomes the `.mx-theme` scope: a server-rendered `<style>` block overrides
 * the app.css token variables for everything inside — the generated app is
 * themed with zero flash, while `/admin` and `/workbench` (outside the frame)
 * keep platform chrome. `themeToCss` input is fully validated spec data
 * (enums + hex regex), never free text, so the inline style is injection-safe.
 */
export function ProjectFrame({
	pages,
	title,
	theme,
	demoRows = 0,
	children,
}: {
	pages: Pick<ProjectRoute, 'slug' | 'name'>[]
	title?: string
	theme?: ThemeSpec
	/** Rows tracked as demo data; > 0 shows the sample-data notice. */
	demoRows?: number
	children: React.ReactNode
}) {
	return (
		<div
			// bg/text classes matter when themed: `body`'s colors come from the
			// :root variables, so the wrapper must paint its own overridden ones.
			className={
				theme
					? 'mx-theme min-h-screen bg-background text-foreground'
					: 'min-h-screen'
			}
			data-density={theme?.density}
		>
			{theme ? (
				// biome-ignore lint/security/noDangerouslySetInnerHtml: CSS built from validated enum/hex spec values only
				<style dangerouslySetInnerHTML={{ __html: themeToCss(theme) }} />
			) : null}
			<ProjectNav pages={pages} title={title} />
			{demoRows > 0 ? <DemoDataNotice rows={demoRows} /> : null}
			<main className="mx-auto max-w-4xl px-6 py-8">{children}</main>
		</div>
	)
}
