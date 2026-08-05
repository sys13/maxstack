import {
	isRouteErrorResponse,
	Links,
	Meta,
	Outlet,
	Scripts,
	ScrollRestoration,
} from 'react-router'
import type { Route } from './+types/root'
import { CookieConsentBanner } from './components/cookie-consent-banner'
import { AppProviders } from './providers'
import { showCookieBanner } from './sprout.server'
import './app.css'

/**
 * The root loader exists for one question: does this app have a cookie
 * disclosure to make at all? A personal single-user app with no
 * sign-in configured was nagging for consent it had no reason to collect. The
 * answer is server-side because it depends on the project's installed bundles
 * and config, neither of which the client can see.
 */
export async function loader() {
	try {
		return { cookieBanner: await showCookieBanner() }
	} catch {
		// Never let a config/store hiccup take down every route in the app; the
		// banner is the least important thing on the page.
		return { cookieBanner: false }
	}
}

export function Layout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<head>
				<meta charSet="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<Meta />
				<Links />
			</head>
			<body>
				{children}
				<ScrollRestoration />
				<Scripts />
			</body>
		</html>
	)
}

export default function App({ loaderData }: Route.ComponentProps) {
	return (
		// The data + notification context, above every route. It used
		// to live in the admin frame, so a slot on a spec-declared project page —
		// the framework's main extension point — could not use the framework's main
		// data API without building a second provider, and a second provider means a
		// second cache. See `providers.tsx`.
		<AppProviders>
			<Outlet />
			{/* Cookie consent: rendered at the root so it's on every
			    page, dismissal persisted client-side (see the component doc).
			    Only when the app actually has something to disclose. */}
			{loaderData?.cookieBanner ? <CookieConsentBanner /> : null}
		</AppProviders>
	)
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
	const message = isRouteErrorResponse(error)
		? `${error.status} ${error.statusText}`
		: error instanceof Error
			? error.message
			: 'Unknown error'
	return (
		<main style={{ padding: '2rem', fontFamily: 'monospace' }}>
			<h1>Something went wrong</h1>
			<pre>{message}</pre>
		</main>
	)
}
