/**
 * React wiring for the preference store (Plan v5 task 42). `<PreferenceProvider>`
 * puts a `PreferenceStore` in context; `useStore(key, fallback)` binds a
 * component to one key via `useSyncExternalStore` and returns a
 * `[value, setValue]` pair with `useState`-like ergonomics — the UI-state dual
 * of task 33's `useList`. One provider near the root and every column-config,
 * saved-query, and theme control persists with no extra plumbing.
 */

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useSyncExternalStore,
} from 'react'
import { PreferenceStore } from './store.ts'

const PreferenceContext = createContext<PreferenceStore | null>(null)

export interface PreferenceProviderProps {
	/** Share a store across trees (tests, or a pre-seeded store); one is created
	 * with the default (localStorage) backend if omitted. */
	store?: PreferenceStore
	children: ReactNode
}

export function PreferenceProvider({
	store,
	children,
}: PreferenceProviderProps) {
	const value = useMemo(() => store ?? new PreferenceStore(), [store])
	return (
		<PreferenceContext.Provider value={value}>
			{children}
		</PreferenceContext.Provider>
	)
}

/** Read the store directly (for imperative access — e.g. reading a preference
 * outside render). Returns a standalone store when no provider is mounted, so a
 * component that opts into preferences never crashes for lack of wiring — it
 * just gets an unshared, memory-or-localStorage store. */
export function usePreferenceStore(): PreferenceStore {
	const ctx = useContext(PreferenceContext)
	// A module-level fallback so hooks work provider-free (unshared but functional).
	return ctx ?? fallbackStore()
}

let _fallback: PreferenceStore | null = null
function fallbackStore(): PreferenceStore {
	if (!_fallback) _fallback = new PreferenceStore()
	return _fallback
}

/**
 * Bind to a single preference key. Returns `[value, setValue]` where `setValue`
 * accepts a value or an updater (like `useState`). The value is reactive: any
 * other `useStore` on the same key re-renders when this one writes.
 *
 * **Hydration.** `getServerSnapshot` must return what the *server*
 * rendered — and React calls it on the **client** during hydration too. Passing
 * the localStorage-reading `getSnapshot` (as this hook originally did) therefore
 * guaranteed a mismatch for every visitor whose persisted value differed from
 * `fallback`: the server rendered the fallback (memory backend, no localStorage)
 * while hydration rendered the persisted value. Depending on tree position React
 * then warned, re-rendered, or stranded the SSR DOM with dead handlers — issue
 * #137's zombie cookie banner.
 *
 * Returning `fallback` fixes the whole class at the source: server and hydration
 * agree, then `useSyncExternalStore`'s own post-hydration check sees the store
 * snapshot differ and re-renders with the persisted value. Consumers get one
 * cheap extra render, not a mismatch, and need no per-component `mounted` gate.
 *
 * That extra render is a visible *flip* (fallback → persisted) for UI that
 * branches on the value. When even the flip is unacceptable — a banner that must
 * not flash for someone who already dismissed it — use {@link useHydratedStore}
 * and render nothing until `hydrated`.
 */
export function useStore<T>(
	key: string,
	fallback: T,
): readonly [T, (value: T | ((prev: T) => T)) => void] {
	const store = usePreferenceStore()
	const subscribe = useCallback(
		(cb: () => void) => store.subscribe(key, cb),
		[store, key],
	)
	const getSnapshot = useCallback(
		() => store.get<T>(key, fallback),
		[store, key, fallback],
	)
	// NOT `getSnapshot` — see the hydration note above.
	const getServerSnapshot = useCallback(() => fallback, [fallback])
	const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
	const setValue = useCallback(
		(next: T | ((prev: T) => T)) => store.set<T>(key, next, fallback),
		[store, key, fallback],
	)
	return [value, setValue] as const
}

const NOOP_SUBSCRIBE = (): (() => void) => () => {}
const TRUE = (): boolean => true
const FALSE = (): boolean => false

/**
 * `true` once the client has hydrated, `false` on the server and during the
 * hydration render — the sanctioned way to gate UI that must not render at all
 * until client-persisted state has been consulted.
 *
 * Implemented with `useSyncExternalStore` rather than `useState` + `useEffect`
 * so React treats it as a hydration-safe external value, and so the flip lands
 * in the same pass as {@link useStore}'s.
 */
export function useHydrated(): boolean {
	return useSyncExternalStore(NOOP_SUBSCRIBE, TRUE, FALSE)
}

/**
 * {@link useStore} plus a `hydrated` flag: `[value, setValue, hydrated]`.
 *
 * `value` is `fallback` until the client has hydrated, so a component can
 * render nothing (or a skeleton) instead of flashing the fallback and flipping.
 * Reach for this only when the flip is user-visible and unacceptable — plain
 * `useStore` is already hydration-safe.
 */
export function useHydratedStore<T>(
	key: string,
	fallback: T,
): readonly [T, (value: T | ((prev: T) => T)) => void, boolean] {
	const [value, setValue] = useStore(key, fallback)
	const hydrated = useHydrated()
	return [hydrated ? value : fallback, setValue, hydrated] as const
}

/**
 * Render `children` only after hydration — the component form of
 * {@link useHydrated}, for preference-dependent subtrees that would otherwise
 * need a hand-rolled `mounted` gate.
 */
export function ClientOnly({
	children,
	fallback = null,
}: {
	children: ReactNode
	/** Rendered on the server and during hydration. Must match on both. */
	fallback?: ReactNode
}) {
	return <>{useHydrated() ? children : fallback}</>
}
