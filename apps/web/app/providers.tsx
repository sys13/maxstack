/**
 * The app-wide data + notification context.
 *
 * # The bug this fixes
 *
 * `DataProvider` was mounted in exactly one place — `admin-chrome.tsx`, the frame
 * around the *generated* admin. Project pages, the ones a user declares with
 * `page.addPage` and the ones that carry slots, render outside that frame. So the
 * framework's primary data API (`useList`/`useCreate`/`useUpdate`/`useDelete`) was
 * usable only inside the surface the framework generates for itself, and threw in
 * the surface the user extends.
 *
 * The available workaround made it worse. From inside a slot the only way forward
 * was to construct a second provider, and `DataProvider` does
 * `queryClient ?? new QueryClient()` — so that slot got its own **cache**:
 *
 *   - a create or update inside the slot did not invalidate the host app's lists,
 *     or the other way round;
 *   - two slots on one page cached the same resource independently and could show
 *     different values for the same row;
 *   - nothing said so. The symptom (stale rows elsewhere) surfaces far from the
 *     cause, and there is no error to search for.
 *
 * That is the framework's number-one extension point colliding with its number-one
 * data API, with a remedy that trades a crash for a correctness bug.
 *
 * # Why the root
 *
 * One provider per document, above `<Outlet/>`, so *every* route inherits it:
 * the generated admin, spec-declared project pages, the workbench, and any slot
 * inside any of them. The cache is then a property of the page a person is
 * looking at, which is the only scope at which "my edit updated that list" is
 * even expressible.
 *
 * `admin-chrome` no longer creates one. It could have kept its own and been
 * correct in isolation, and that is the shape that produced this bug: two
 * providers that are each individually reasonable and jointly a split cache.
 *
 * Nothing here is client-only — the providers render context and no DOM, so the
 * server and the client agree, which is the property #138 is about. The REST
 * provider is memoised for the app's lifetime rather than rebuilt per navigation,
 * because a new provider identity would remount every subscription under it.
 */

import {
	createRestDataProvider,
	DataProvider,
	NotificationProvider,
	Notifications,
} from '@maxstack/ui'
import { type ReactNode, useMemo } from 'react'

export function AppProviders({ children }: { children: ReactNode }) {
	const dataProvider = useMemo(() => createRestDataProvider(), [])
	return (
		<NotificationProvider>
			<DataProvider dataProvider={dataProvider}>
				{children}
				{/* The toast outlet, at the root for the same reason as the cache: a
				    mutation in a slot on a project page has somewhere to report to.
				    Notifications are optional by design — `useNotify` is a no-op with
				    no provider — so this is additive for every existing surface. */}
				<Notifications />
			</DataProvider>
		</NotificationProvider>
	)
}
