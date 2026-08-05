/**
 * Typed dependency-injection bindings — reimplemented core of mxscratchpad's
 * `DI.md` pattern. The original is a React-specific recipe: a library declares
 * what it needs (`LibraryBindings`), the app provides plain values/functions
 * through a context produced by the app's own hooks, and consuming components
 * read them via `useBindings()` — with a "Missing binding" error when the
 * provider is absent.
 *
 * The salvaged *decision* is framework-agnostic: describe requirements as a
 * typed contract, inject concrete values at the composition root, and fail loud
 * on a missing required binding. This core is that contract without React, so
 * it lives in L5 with no UI dependency; the React `<Provider>`/`useBindings`
 * wiring is captured in the reference spec (`docs/reference-specs/di.md`) for
 * the app/UI layer to implement.
 */

/** Thrown when a required binding was never provided at the composition root. */
export class MissingBindingError extends Error {
	readonly code = 'MISSING_BINDING' as const
	constructor(key: string) {
		super(
			`Missing binding "${key}". Did you forget to provide it at the composition root?`,
		)
		this.name = 'MissingBindingError'
	}
}

export interface BindingContainer<T extends object> {
	/** Read a binding, or `undefined` if unset. */
	get<K extends keyof T>(key: K): T[K] | undefined
	/** Read a binding, throwing `MissingBindingError` if unset. */
	require<K extends keyof T>(key: K): T[K]
	/** Whether a binding is set. */
	has<K extends keyof T>(key: K): boolean
	/** Return a new container with `overrides` layered on top (immutable). */
	with(overrides: Partial<T>): BindingContainer<T>
}

/**
 * Create a bindings container from a set of concrete values. Missing keys are
 * allowed at construction; `require()` enforces presence at the point of use
 * (matching the original's lazy "Missing binding" guard).
 */
export function createBindings<T extends object>(
	values: Partial<T> = {},
): BindingContainer<T> {
	const store = { ...values }
	return {
		get(key) {
			return store[key]
		},
		require(key) {
			const value = store[key]
			if (value === undefined) throw new MissingBindingError(String(key))
			return value as T[typeof key]
		},
		has(key) {
			return store[key] !== undefined
		},
		with(overrides) {
			return createBindings<T>({ ...store, ...overrides })
		},
	}
}
