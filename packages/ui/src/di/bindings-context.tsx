/**
 * React DI wiring — the app/UI half of the DI decision the framework-agnostic
 * core (`@maxstack/features/di`) deferred to this layer. The core
 * is `createBindings<T>(values) → { get, require, has, with }`; this wraps *that
 * container* in a React context so components read injected values via
 * `useBindings()`, with a clear error when no provider is present.
 *
 * Kept self-contained (no `@maxstack/features` import) so the L2 UI package does
 * not depend on the L5 features package — the provider accepts any structurally
 * compatible {@link BindingsLike} container, which a `createBindings()` result
 * satisfies exactly. Per-key "missing required binding" enforcement stays in the
 * container's own `require` (throwing the core's `MissingBindingError`); this
 * layer only guards the "used outside a provider" case.
 */

import { createContext, createElement, type ReactNode, useContext } from 'react'

/**
 * The container shape the provider carries — structurally the core's
 * `BindingContainer<T>` (minus the immutable `with`, unneeded by consumers).
 */
export interface BindingsLike<T extends object> {
	get<K extends keyof T>(key: K): T[K] | undefined
	require<K extends keyof T>(key: K): T[K]
	has<K extends keyof T>(key: K): boolean
}

export interface BindingsProviderProps<T extends object> {
	value: BindingsLike<T>
	children: ReactNode
}

/**
 * Build a typed bindings context: a `<BindingsProvider>` that supplies a
 * container at the composition root and a `useBindings()` hook that reads it.
 * The hook throws if called with no provider above it (the "did you forget to
 * wrap the tree" mistake), mirroring the core's fail-loud posture.
 */
export function createBindingsContext<T extends object>(): {
	BindingsProvider: (props: BindingsProviderProps<T>) => ReactNode
	useBindings: () => BindingsLike<T>
} {
	const Ctx = createContext<BindingsLike<T> | null>(null)

	function BindingsProvider({
		value,
		children,
	}: BindingsProviderProps<T>): ReactNode {
		return createElement(Ctx.Provider, { value }, children)
	}

	function useBindings(): BindingsLike<T> {
		const bindings = useContext(Ctx)
		if (bindings === null) {
			throw new Error(
				'useBindings() must be used within a <BindingsProvider>. Provide the ' +
					'bindings container at the composition root.',
			)
		}
		return bindings
	}

	return { BindingsProvider, useBindings }
}
