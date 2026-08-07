import {
	Links,
	Meta,
	Outlet,
	Scripts,
	ScrollRestoration,
	useLocation,
	useRouteLoaderData,
} from 'react-router'
import type { Route } from './+types/root'
import { CookieConsentBanner } from './components/cookie-consent-banner'
import { ErrorPage, presentError } from './error-page'
import { projectShell } from './project.server'
import { AppProviders } from './providers'
import { showCookieBanner } from './sprout.server'
import './app.css'

/**
 * The root loader answers two questions, both of which have to be answered
 * *above* every route.
 *
 * 1. Does this app have a cookie disclosure to make at all? A personal
 *    single-user app with no sign-in configured was nagging for consent it had
 *    no reason to collect. The answer is server-side because it depends on the
 *    project's installed bundles and config, neither of which the client can see.
 * 2. What chrome should an *error* page wear (#339)? An error boundary cannot
 *    await anything and must not depend on the loader that just failed, so the
 *    nav/title/theme it draws have to already be in hand when the failure
 *    happens. Root's data survives a child route's error; the failing route's
 *    does not.
 *
 * Both are independently caught. Either one hiccuping is a reason to render less,
 * never a reason to take down every route in the app — and for the shell that
 * matters twice over, since the page it is missing from is already an error page.
 */
export async function loader({ request }: Route.LoaderArgs) {
	const [cookieBanner, shell] = await Promise.all([
		showCookieBanner().catch(() => false),
		projectShell(request).catch(() => null),
	])
	return { cookieBanner, shell }
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

/**
 * The only error surface every generated app has (#339).
 *
 * It reads root's loader data through `useRouteLoaderData` rather than through
 * `Route.ComponentProps`, because an error boundary is rendered *without* props:
 * the hook returns the data when a child route failed and `undefined` when root
 * itself did, which is precisely the signal `ErrorPage` needs to decide between
 * the themed page and the chrome-less fallback. Nothing here can throw on a
 * missing shell.
 *
 * `import.meta.env.DEV` is Vite's build-time constant, so the development-only
 * detail is not merely hidden in production — it is not in the bundle.
 */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
	const rootData = useRouteLoaderData<typeof loader>('root')
	const location = useLocation()
	return (
		<ErrorPage
			presented={presentError(error, {
				dev: import.meta.env.DEV,
				path: location.pathname,
			})}
			shell={rootData?.shell}
		/>
	)
}
