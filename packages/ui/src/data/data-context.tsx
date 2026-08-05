/**
 * Wiring context for the data layer (Plan v5 task 33). `<DataProvider>` puts a
 * `DataProvider` (the REST client) and a `QueryClient` (the cache) in context;
 * every hook reads them from here. One provider near the app root and the whole
 * hook family — `useList`/`useOne`/`useCreate|Update|Delete` — lights up.
 */

import { createContext, type ReactNode, useContext, useMemo } from 'react'
import type { DataProvider as DataProviderContract } from './data-provider.ts'
import { QueryClient } from './query-client.ts'

interface DataContextValue {
	dataProvider: DataProviderContract
	queryClient: QueryClient
}

const DataContext = createContext<DataContextValue | null>(null)

export interface DataProviderProps {
	dataProvider: DataProviderContract
	/** Share a `QueryClient` across trees (e.g. tests); one is created if omitted. */
	queryClient?: QueryClient
	children: ReactNode
}

export function DataProvider({
	dataProvider,
	queryClient,
	children,
}: DataProviderProps) {
	const outer = useContext(DataContext)
	const value = useMemo<DataContextValue>(() => {
		// A nested provider that mints its own cache is the failure mode of #259,
		// and it is silent: both caches work, they just disagree. A create in the
		// inner tree does not invalidate the outer tree's lists, two slots on one
		// page can show different values for the same row, and the symptom surfaces
		// far from the cause. Passing `queryClient` explicitly is the supported way
		// to nest (tests do it), so only the implicit case is called out.
		if (outer && !queryClient && typeof console !== 'undefined') {
			console.warn(
				'<DataProvider> mounted inside another <DataProvider> without a shared ' +
					'`queryClient`, so this subtree now has its OWN cache: writes here will ' +
					'not invalidate lists outside it, and the same row can render two ' +
					'different values. Since issue #259 the app root already provides one — ' +
					'delete this provider and the hooks will inherit it. To nest ' +
					'deliberately, pass the ancestor `queryClient` explicitly.',
			)
		}
		return { dataProvider, queryClient: queryClient ?? new QueryClient() }
	}, [dataProvider, queryClient, outer])
	return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}

function useDataContext(): DataContextValue {
	const ctx = useContext(DataContext)
	// Names the fix rather than the rule. The generic "must be used
	// within a <DataProvider>" sent slot authors to mount their own, which is the
	// one repair that introduces a second cache — so the message says where the
	// provider is supposed to be and what NOT to do about it.
	if (!ctx)
		throw new Error(
			'useDataProvider/useQueryClient found no <DataProvider>. The app root ' +
				'mounts one for every route (apps/web/app/providers.tsx), so this ' +
				'component is rendering outside the app tree — in an isolated test render, ' +
				'or in a portal/root of its own. Wrap the test in <DataProvider>. Do NOT ' +
				'add a second <DataProvider> inside the app to fix this: it would give ' +
				'this subtree its own cache, and writes in it would silently stop ' +
				'invalidating lists elsewhere.',
		)
	return ctx
}

export function useDataProvider(): DataProviderContract {
	return useDataContext().dataProvider
}

export function useQueryClient(): QueryClient {
	return useDataContext().queryClient
}
