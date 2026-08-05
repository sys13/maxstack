/**
 * `withMeta` — attach display/validation metadata to a Drizzle column while
 * preserving its exact type (so `$inferSelect`/`$inferInsert` stay precise and
 * `.notNull()/.references()/.default()` still chain).
 *
 * See the reference design. The dual write is a hard invariant:
 * Drizzle copies a builder's `config` object when `pgTable()` builds the final
 * column, and — verified against drizzle-orm 0.45 — only that config copy
 * survives (`column.__meta` is dropped, `column.config.__meta` remains). Writing
 * both sites means `getColumnMeta` works whether it is handed a builder or a
 * built column.
 */

import type { ColumnMetadata } from './types.ts'

const META_KEY = '__meta'

/**
 * Attach metadata to a column (builder or built), returning the SAME reference
 * with its type unchanged.
 */
export function withMeta<T>(column: T, meta: ColumnMetadata): T {
	const c = column as unknown as {
		[META_KEY]?: ColumnMetadata
		config?: { [META_KEY]?: ColumnMetadata }
	}
	c[META_KEY] = meta
	if (c.config) c.config[META_KEY] = meta
	return column
}

/** Read metadata off a column (builder or built), preferring the surviving
 * config copy. Returns `undefined` when none was attached. */
export function getColumnMeta(column: unknown): ColumnMetadata | undefined {
	const c = column as {
		[META_KEY]?: ColumnMetadata
		config?: { [META_KEY]?: ColumnMetadata }
	}
	return c?.config?.[META_KEY] ?? c?.[META_KEY]
}
