/**
 * What the app shows when a route fails (#339).
 *
 * Three things had to be separated here, and the old boundary separated none of
 * them.
 *
 * **A 404 is not an incident.** Since #335 an undeclared path genuinely 404s,
 * which means the most common error page in a generated app is somebody
 * mistyping a URL. That deserves the app's own chrome — its nav, its name, its
 * declared theme — and a way back, not a black page in monospace that reads as a
 * crash.
 *
 * **A 500 is an incident, and the useful thing to show is not the message.** The
 * message is the driver's: the failed statement, its columns, its bound
 * parameters (#336). What a user can actually use is a correlation id they can
 * quote, which `withErrorId` mints and prints beside the detail on stderr. So
 * the id is the payload of the 500 page and the message never leaves the server
 * — outside dev, where a developer looking at their own machine is better served
 * by the stack than by an id.
 *
 * **Some failures have no chrome to render into.** If the root loader itself
 * died there is no nav and no theme to draw, and a boundary that reached for
 * them would crash rendering the crash. That case keeps the old inline-styled
 * fallback, which is exactly what it was always good at: it needs no stylesheet,
 * no loader data and no router state.
 *
 * `presentError` is pure and separately tested, because the rule it encodes —
 * *which* text is safe to render — is the part that must not drift.
 */

import { buttonVariants } from '@maxstack/ui'
import { isRouteErrorResponse, Link, useRevalidator } from 'react-router'
import { pagePath } from './page-path'
import type { ProjectShell } from './project.server'
import { ProjectFrame } from './project-nav'

/** What the boundary is allowed to say, already stripped of anything unsafe. */
export interface ErrorPresentation {
	kind: 'not-found' | 'route' | 'crash'
	/** HTTP status when the failure was a thrown response, else `null`. */
	status: number | null
	heading: string
	/** One sentence, always safe to render. */
	body: string
	/** The `err_…` correlation id `withErrorId` printed to stderr, when there is one. */
	errorId: string | null
	/**
	 * The real message/stack — populated **only** in development. Rendering this
	 * in production is the leak #336 closed on the JSON side; the boundary is the
	 * other side of the same hole.
	 */
	detail: string | null
}

const GENERIC_BODY =
	'The app hit an unexpected error loading this page. Nothing you did caused it.'

/**
 * Classify a thrown value into what may be shown.
 *
 * The split mirrors `fail()` in `@maxstack/core`: a 4xx is something *we*
 * constructed and addressed to the person reading it, so its message goes
 * through; anything 5xx or unrecognized came from somewhere that never meant to
 * be read by a user, so it becomes a fixed sentence plus an id.
 */
export function presentError(
	error: unknown,
	options: { dev: boolean; path?: string },
): ErrorPresentation {
	const detailOf = (value: unknown): string | null => {
		if (!options.dev) return null
		if (value instanceof Error) return value.stack ?? value.message
		return value === undefined ? null : safeJson(value)
	}

	if (isRouteErrorResponse(error)) {
		const body = error.data as unknown
		const errorId = readString(body, 'errorId')
		if (error.status === 404) {
			return {
				kind: 'not-found',
				status: 404,
				heading: 'Page not found',
				body: options.path
					? `There is no page at ${options.path}.`
					: 'There is no page at that address.',
				errorId: null,
				detail: detailOf(body),
			}
		}
		if (error.status < 500) {
			return {
				kind: 'route',
				status: error.status,
				heading: error.statusText || 'That request was refused',
				// Our own 4xx copy ("Method not allowed", "Unknown page …") — written
				// for the caller, so it goes through verbatim.
				body: readString(body, 'error') ?? 'That request could not be served.',
				errorId,
				detail: detailOf(body),
			}
		}
		return {
			kind: 'route',
			status: error.status,
			heading: 'Something went wrong',
			body: GENERIC_BODY,
			errorId,
			detail: detailOf(body),
		}
	}

	return {
		kind: 'crash',
		status: null,
		heading: 'Something went wrong',
		body: GENERIC_BODY,
		errorId: null,
		detail: detailOf(error),
	}
}

/** A string field of a thrown response body, or `null` if it isn't one. */
function readString(body: unknown, key: string): string | null {
	if (typeof body !== 'object' || body === null) return null
	const value = (body as Record<string, unknown>)[key]
	return typeof value === 'string' && value.length > 0 ? value : null
}

/** Dev-only, and a cyclic value must not become a second error inside the boundary. */
function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2)
	} catch {
		return String(value)
	}
}

/**
 * The error page in the app's own chrome, or bare when there is none.
 *
 * `shell` comes from the *root* loader (see `projectShell`), never from the
 * route that failed — a boundary that depended on the loader that just died
 * would fail to render the failure.
 */
export function ErrorPage({
	presented,
	shell,
}: {
	presented: ErrorPresentation
	shell: ProjectShell | null | undefined
}) {
	if (!shell) return <BareErrorPage presented={presented} />
	const first = shell.pages[0]
	return (
		<ProjectFrame pages={shell.pages} title={shell.title} theme={shell.theme}>
			<ErrorPanel presented={presented} firstPage={first} />
		</ProjectFrame>
	)
}

function ErrorPanel({
	presented,
	firstPage,
}: {
	presented: ErrorPresentation
	firstPage: { slug: string; name: string } | undefined
}) {
	const revalidator = useRevalidator()
	return (
		<div className="mx-auto max-w-xl py-10 text-center">
			{presented.status ? (
				<p className="text-sm font-medium text-muted-foreground">
					{presented.status}
				</p>
			) : null}
			<h1 className="mt-1 text-2xl font-semibold tracking-tight">
				{presented.heading}
			</h1>
			<p className="mt-2 text-sm text-muted-foreground">{presented.body}</p>

			{presented.errorId ? (
				<p className="mt-4 text-sm text-muted-foreground">
					Quote this if you report it:{' '}
					<code className="rounded-md border border-border bg-muted px-2 py-1 font-mono text-xs text-foreground">
						{presented.errorId}
					</code>
				</p>
			) : null}

			<div className="mt-6 flex flex-wrap items-center justify-center gap-2">
				<Link to="/" className={buttonVariants({ variant: 'primary' })}>
					Go home
				</Link>
				{/* The first declared page, so an app whose home is not its main
				    surface still offers somewhere real to land. Skipped when it *is*
				    home, rather than shipping two buttons to the same URL. */}
				{firstPage && pagePath(firstPage.slug) !== '/' ? (
					<Link
						to={pagePath(firstPage.slug)}
						className={buttonVariants({ variant: 'outline' })}
					>
						{firstPage.name}
					</Link>
				) : null}
				{/* Retrying a 404 just 404s again; it is only offered where the app,
				    not the address, is what failed. */}
				{presented.kind !== 'not-found' ? (
					<button
						type="button"
						onClick={() => revalidator.revalidate()}
						disabled={revalidator.state === 'loading'}
						className={buttonVariants({ variant: 'outline' })}
					>
						{revalidator.state === 'loading' ? 'Retrying…' : 'Try again'}
					</button>
				) : null}
			</div>

			<DevDetail detail={presented.detail} />
		</div>
	)
}

/** The development-only stack. Never rendered in a production build. */
function DevDetail({ detail }: { detail: string | null }) {
	if (!detail) return null
	return (
		<details className="mt-8 text-left">
			<summary className="cursor-pointer text-sm text-muted-foreground">
				Details (development only)
			</summary>
			<pre className="mt-2 overflow-x-auto rounded-md border border-border bg-muted p-4 text-xs">
				{detail}
			</pre>
		</details>
	)
}

/**
 * The no-chrome fallback: inline styles, no router data, no stylesheet.
 *
 * Deliberately still ugly. It renders when the root loader failed or the app is
 * not in project mode, i.e. exactly when assuming the app is healthy enough to
 * theme a page would be wrong.
 */
function BareErrorPage({ presented }: { presented: ErrorPresentation }) {
	return (
		<main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
			<h1 style={{ fontSize: '1.25rem', margin: 0 }}>
				{presented.status ? `${presented.status} — ` : ''}
				{presented.heading}
			</h1>
			<p style={{ marginTop: '0.5rem' }}>{presented.body}</p>
			{presented.errorId ? (
				<p style={{ marginTop: '0.5rem', fontFamily: 'monospace' }}>
					{presented.errorId}
				</p>
			) : null}
			<p style={{ marginTop: '1rem' }}>
				<a href="/">Go home</a>
			</p>
			{presented.detail ? (
				<pre
					style={{ marginTop: '1rem', overflowX: 'auto', fontSize: '0.75rem' }}
				>
					{presented.detail}
				</pre>
			) : null}
		</main>
	)
}
