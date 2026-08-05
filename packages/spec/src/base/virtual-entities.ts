/**
 * Well-known virtual entities — bundle-provided tables the spec layer may
 * reference without declaring them as entities.
 *
 * The auth bundle's identity tables are infra DDL, not spec entities, yet
 * "belongs to a user" is the most common relationship a consumer app has. A
 * virtual entity gives such a table a spec-layer id (`e-user`) that a field's
 * `reference` may name: reference validation accepts it, and the grounding
 * layer maps it onto the bundle's real table (FK column type, reference
 * resolution via `displayField`, the form-side FK picker).
 *
 * Whether the bundle is actually installed is a runtime concern, not a spec
 * concern — the spec stays self-contained and portable. Grounding (which knows
 * `maxstack.json`) only wires the reference up when the bundle is present. A
 * spec entity that declares the same id shadows the virtual one everywhere.
 */

import type { EntityId } from './ids.ts'

export interface VirtualEntity {
	/** The spec-layer id a field's `reference` names. */
	id: EntityId
	/** Human name, for messages. */
	name: string
	/** The runtime table the reference grounds to. */
	table: string
	/** The referenced column (the table's primary key). */
	column: string
	/** The referenced id's SQL type — bundle infra tables (better-auth) use
	 * `text` ids, unlike the `uuid` ids of spec entities. */
	idType: 'text' | 'uuid'
	/** The column reference resolution displays as the record's title. */
	displayField: string
	/** The bundle whose DDL materializes the table (`maxstack add <bundle>`). */
	bundle: string
}

/** The auth bundle's user — `reference: 'e-user'` is "belongs to a user". */
export const USER_ENTITY_ID = 'e-user' as const satisfies EntityId

export const VIRTUAL_ENTITIES: readonly VirtualEntity[] = [
	{
		id: USER_ENTITY_ID,
		name: 'User',
		table: 'user',
		column: 'id',
		idType: 'text',
		displayField: 'name',
		bundle: 'auth',
	},
]

/** Look up a virtual entity by its spec-layer id. */
export function virtualEntity(id: string): VirtualEntity | undefined {
	return VIRTUAL_ENTITIES.find((v) => v.id === id)
}
