/**
 * The resolved-reference context (Plan v5 task 32). A loader batch-resolves a
 * page of foreign keys into `{ table: { id: displayValue } }` (core's
 * `resolveReferences`) and hands it to `<ResourceList>`/`<Show>` as the
 * `references` prop; those wrap their children in `<ReferenceProvider>` so every
 * nested `<ReferenceField>` can look up its display value synchronously — no
 * per-cell fetch, no N+1.
 *
 * Structurally a `ReferenceMap` from `@maxstack/core` satisfies this, so the map
 * crosses the loader boundary unchanged.
 */

import { createContext, type ReactNode, useContext } from 'react'

/** `table → (referenced id → display string)`. */
export type ReferenceResolution = Record<string, Record<string, string>>

const ReferenceContext = createContext<ReferenceResolution>({})

export interface ReferenceProviderProps {
	value: ReferenceResolution
	children: ReactNode
}

/** Provide resolved references to descendant `<ReferenceField>`s. Merges over
 * any parent provider (an inner `<ReferenceManyField>` can add its own). */
export function ReferenceProvider({ value, children }: ReferenceProviderProps) {
	const parent = useContext(ReferenceContext)
	const merged = parent === value ? value : { ...parent, ...value }
	return (
		<ReferenceContext.Provider value={merged}>
			{children}
		</ReferenceContext.Provider>
	)
}

/** The resolved display value for a `table`/`id`, or `undefined` if unresolved
 * (the field then falls back to showing the raw id). */
export function useReferenceValue(
	table: string | undefined,
	id: string | undefined,
): string | undefined {
	const resolution = useContext(ReferenceContext)
	if (!table || id === undefined) return undefined
	return resolution[table]?.[id]
}
