/**
 * The structural resource shape `<ResourceList>` / `<Show>` read. `@maxstack/
 * core`'s `SproutResource` satisfies this, so a loader hands its introspection
 * straight through — but the UI package stays free of a core dependency.
 */

import type { IntrospectedColumn } from '../fields/field-semantics.ts'

export interface IntrospectedResource {
	/**
	 * The resource *identifier*, e.g. `reading-item` — matched against
	 * `references.table`, used as a preference-store key namespace. Not copy:
	 * see {@link label}.
	 */
	name: string
	/**
	 * The human name for one of these, e.g. `Reading item`.
	 *
	 * Optional because {@link name} is what every structural consumer needs and
	 * every caller already has; a caller that knows the entity's declared display
	 * name passes it here so user-facing copy ("Add the first …") can say the
	 * thing rather than an identifier — or the page's name, which is a different
	 * noun entirely (two pages can back one entity).
	 */
	label?: string
	primaryKey: string
	columns: IntrospectedColumn[]
}

export type Row = Record<string, unknown>

/** Per-action allow flags for the current session — the presentation dual of
 * core's `resourceCapabilities`. A loader computes these server-side and hands
 * them to `<ResourceList>` / `<Show>` (and the owning route) so the UI stops
 * offering affordances the server would reject. Absent → treat everything as
 * allowed (unrestricted, the pre-permission default). */
export interface ResourceCapabilities {
	read: boolean
	create: boolean
	update: boolean
	delete: boolean
}

/** A cell/field renderer override — the eject seam. Given the value, its row,
 * and the column, return the cell content. Supplied via a `columns` prop or a
 * user-owned slot. */
export type CellRenderer = (ctx: {
	value: unknown
	row: Row
	column: IntrospectedColumn
}) => import('react').ReactNode

export interface ColumnOverride {
	/** Header label override. */
	label?: string
	/** Cell renderer override — replaces the inferred `<Field>`. */
	render?: CellRenderer
	/** Force-hide (`true`) or force-show (`false`) regardless of inference. */
	hidden?: boolean
}

/** Per-column overrides keyed by column name; a bare function is shorthand for `{ render }`. */
export type ColumnOverrides = Record<string, CellRenderer | ColumnOverride>

export function normalizeOverride(
	o: CellRenderer | ColumnOverride | undefined,
): ColumnOverride {
	if (!o) return {}
	return typeof o === 'function' ? { render: o } : o
}
