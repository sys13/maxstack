/**
 * Runtime introspection of a Drizzle pg table into a `SproutResource`.
 * See the reference design.
 *
 * Verified against drizzle-orm 0.45: inline foreign keys live on the table
 * under `Symbol.for('drizzle:PgInlineForeignKeys')`; each entry's `.reference()`
 * yields `{ columns, foreignTable, foreignColumns }`. This is the only
 * drizzle-internal symbol relied on — isolated here so a drizzle bump only
 * needs re-verifying this one file.
 */

import { is } from 'drizzle-orm'
import {
	getTableConfig,
	PgBigInt53,
	PgBigSerial53,
	PgBoolean,
	PgInteger,
	PgJsonb,
	PgNumeric,
	PgReal,
	PgSerial,
	type PgTable,
	PgTimestamp,
	PgTimestampString,
	PgUUID,
} from 'drizzle-orm/pg-core'
import { getColumnMeta } from './schema-builder.ts'
import type {
	SproutColumn,
	SproutColumnType,
	SproutRelation,
	SproutResource,
} from './types.ts'

const INLINE_FK_SYMBOL = Symbol.for('drizzle:PgInlineForeignKeys')

interface InlineForeignKey {
	reference(): {
		columns: { name: string }[]
		foreignTable: PgTable
		foreignColumns: { name: string }[]
	}
}

type FkMap = Record<string, { table: string; column: string }>

function extractInlineForeignKeys(table: PgTable): FkMap {
	const fks = (table as unknown as Record<symbol, InlineForeignKey[]>)[
		INLINE_FK_SYMBOL
	]
	const map: FkMap = {}
	if (!Array.isArray(fks)) return map
	for (const fk of fks) {
		const ref = fk.reference()
		// Only the first column pair is modeled; composite FKs collapse (matches
		// the specbase original).
		const src = ref.columns[0]
		const foreign = ref.foreignColumns[0]
		if (!src || !foreign) continue
		map[src.name] = {
			table: getTableConfig(ref.foreignTable).name,
			column: foreign.name,
		}
	}
	return map
}

function inferColumnType(column: unknown, hasEnum: boolean): SproutColumnType {
	if (hasEnum) return 'enum'
	if (is(column, PgUUID)) return 'uuid'
	if (is(column, PgTimestamp) || is(column, PgTimestampString)) return 'date'
	if (is(column, PgBoolean)) return 'boolean'
	if (is(column, PgJsonb)) return 'json'
	if (
		is(column, PgInteger) ||
		is(column, PgSerial) ||
		is(column, PgReal) ||
		is(column, PgNumeric) ||
		is(column, PgBigInt53) ||
		is(column, PgBigSerial53)
	) {
		// NOTE: numeric/decimal collapses to `number` — precision is not modeled
		// here.
		return 'number'
	}
	return 'string'
}

/** Suggest a belongs-to accessor name from a FK column: `author_id` → `author`,
 * `authorId` → `author`. Falls back to the referenced table name. */
function relationName(columnName: string, foreignTable: string): string {
	const stripped = columnName.replace(/_?[iI]d$/, '')
	return stripped.length > 0 ? stripped : foreignTable
}

export function introspectTable(table: PgTable): SproutResource {
	const config = getTableConfig(table)
	const fkMap = extractInlineForeignKeys(table)

	// Primary key: inline (column.primary) or composite (tableConfig.primaryKeys).
	let primaryKey = 'id'
	const compositePk = config.primaryKeys[0]?.columns[0]?.name
	if (compositePk) primaryKey = compositePk

	const columns: SproutColumn[] = config.columns.map((column) => {
		const c = column as unknown as {
			name: string
			notNull: boolean
			hasDefault: boolean
			primary?: boolean
			enumValues?: string[]
		}
		if (c.primary === true) primaryKey = c.name
		const meta = getColumnMeta(column) ?? {}
		// Enum values: drizzle-native first, else the metadata carried by the
		// spec→Sprout bridge (a spec enum lands as `text()` + `meta.options`, see
		// from-spec.ts) — so a spec enum introspects as a real enum and the Zod
		// generator emits `z.enum`, not a permissive `z.string()`.
		const references = fkMap[c.name] ?? meta.reference
		const metaEnumValues =
			references || meta.arrayReference
				? undefined // an FK holds ids; any option list on it is picker chrome
				: Array.isArray(meta.enumValues)
					? meta.enumValues.map(String)
					: meta.options?.map((o) => o.value)
		const enumValues =
			Array.isArray(c.enumValues) && c.enumValues.length > 0
				? c.enumValues
				: metaEnumValues && metaEnumValues.length > 0
					? metaEnumValues
					: undefined
		return {
			name: c.name,
			type: inferColumnType(column, enumValues !== undefined),
			nullable: !c.notNull,
			hasDefault: c.hasDefault,
			isPrimaryKey: c.primary === true || c.name === primaryKey,
			enumValues,
			references,
			meta,
		}
	})

	// Build the relation graph from the **columns**, not from the FK map
	//. `fkMap` only knows about real drizzle foreign keys, which is
	// how the demo and owned-code schemas declare a reference — but a spec
	// entity's reference arrives as column metadata and was folded into
	// `column.references` a few lines above. Reading only `fkMap` therefore left
	// `relations` empty for every spec-driven project, i.e. every maxstack
	// project, while the same information sat on the column unread.
	//
	// Deriving both from `columns` is what keeps them from disagreeing again:
	// there is now exactly one place a reference is resolved.
	const relations: SproutRelation[] = []
	for (const column of columns) {
		// A single-valued reference wins over an array one: `references` is the
		// resolved `fkMap[name] ?? meta.reference`, and a column that holds one id
		// is not also holding a list of them.
		const single = column.references
		const many = column.meta.arrayReference
		const target = single ?? many
		if (!target) continue
		relations.push({
			name: relationName(column.name, target.table),
			type: single ? 'many-to-one' : 'many-to-many',
			column: column.name,
			// Narrow to the graph's own shape — `displayField` / `idType` are
			// presentation and DDL concerns that belong on the column, not on an
			// edge someone is traversing.
			references: { table: target.table, column: target.column },
		})
	}

	return { name: config.name, primaryKey, columns, relations }
}
