/**
 * Persisted column configuration (Plan v5 task 40) — show/hide + reorder a
 * `<ResourceList>`'s columns, saved to the task-42 preference store so the choice
 * survives a reload. Pure state logic (no React beyond the one hook), keyed by
 * resource name, and derived entirely from introspection: the *available* columns
 * come from the resource, so adding a column to the schema surfaces it
 * automatically without invalidating a saved config.
 */

import { useCallback, useMemo } from 'react'
import { useStore } from '../prefs/prefs-context.tsx'
import type { IntrospectedResource } from './resource-types.ts'

/** The persisted shape: which column names are hidden, and an optional explicit
 * order. Storing *hidden* (not visible) means a newly-added schema column defaults
 * to shown — the config never has to be migrated when the schema grows. */
export interface ColumnConfig {
	hidden: string[]
	/** Explicit ordering of column names; names absent from `order` keep their
	 * schema order after the ordered ones. Empty → pure schema order. */
	order: string[]
}

export const EMPTY_COLUMN_CONFIG: ColumnConfig = { hidden: [], order: [] }

/** The list of column names a resource offers, in schema order, minus the ones a
 * resource marks structurally hidden (those are never user-configurable). */
export function configurableColumns(resource: IntrospectedResource): string[] {
	return resource.columns
		.filter((c) => c.meta?.hidden !== true)
		.map((c) => c.name)
}

/** Apply a config to the resource's columns: drop `hidden`, then sort by `order`
 * (ordered names first in their given order, the rest trailing in schema order).
 * Returns the visible column names to render, left-to-right. */
export function applyColumnConfig(
	resource: IntrospectedResource,
	config: ColumnConfig,
): string[] {
	const available = configurableColumns(resource)
	const hidden = new Set(config.hidden)
	const visible = available.filter((name) => !hidden.has(name))
	if (config.order.length === 0) return visible
	const rank = new Map(config.order.map((name, i) => [name, i]))
	return [...visible].sort((a, b) => {
		const ra = rank.get(a) ?? Number.POSITIVE_INFINITY
		const rb = rank.get(b) ?? Number.POSITIVE_INFINITY
		if (ra !== rb) return ra - rb
		return available.indexOf(a) - available.indexOf(b)
	})
}

export interface UseColumnPrefsResult {
	/** The visible column names, in display order. */
	visible: string[]
	/** Every configurable column name (schema order) — the checklist source. */
	all: string[]
	/** The raw persisted config. */
	config: ColumnConfig
	isVisible: (name: string) => boolean
	toggle: (name: string) => void
	/** Set an explicit column order (e.g. after a drag-reorder). */
	setOrder: (order: string[]) => void
	/** Move a column one slot left/right in the current visible order. */
	move: (name: string, dir: -1 | 1) => void
	reset: () => void
}

/**
 * Bind a resource's column configuration to the preference store. The key is
 * namespaced by resource so each list remembers its own layout. A wide table's
 * hidden columns and their order persist across reloads — the task-40 exit
 * criterion.
 */
export function useColumnPrefs(
	resource: IntrospectedResource,
	options: { storeKey?: string } = {},
): UseColumnPrefsResult {
	const key = options.storeKey ?? `columns.${resource.name}`
	const [config, setConfig] = useStore<ColumnConfig>(key, EMPTY_COLUMN_CONFIG)

	const all = useMemo(() => configurableColumns(resource), [resource])
	const visible = useMemo(
		() => applyColumnConfig(resource, config),
		[resource, config],
	)
	const hiddenSet = useMemo(() => new Set(config.hidden), [config.hidden])

	const isVisible = useCallback(
		(name: string) => !hiddenSet.has(name),
		[hiddenSet],
	)

	const toggle = useCallback(
		(name: string) => {
			setConfig((prev) => {
				const hidden = new Set(prev.hidden)
				if (hidden.has(name)) hidden.delete(name)
				else hidden.add(name)
				return { ...prev, hidden: [...hidden] }
			})
		},
		[setConfig],
	)

	const setOrder = useCallback(
		(order: string[]) => setConfig((prev) => ({ ...prev, order })),
		[setConfig],
	)

	const move = useCallback(
		(name: string, dir: -1 | 1) => {
			const order = applyColumnConfig(resource, config)
			const i = order.indexOf(name)
			const j = i + dir
			const a = order[i]
			const b = order[j]
			if (
				i < 0 ||
				j < 0 ||
				j >= order.length ||
				a === undefined ||
				b === undefined
			)
				return
			const next = [...order]
			next[i] = b
			next[j] = a
			setOrder(next)
		},
		[resource, config, setOrder],
	)

	const reset = useCallback(() => setConfig(EMPTY_COLUMN_CONFIG), [setConfig])

	return { visible, all, config, isVisible, toggle, setOrder, move, reset }
}
