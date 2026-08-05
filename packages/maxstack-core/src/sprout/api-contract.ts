/**
 * The **generated API's** contract, per resource.
 *
 * An agent writing owned code needed to know what `PATCH /api/book/:id`
 * accepts. There was no way to ask, so it ran a probe matrix of curl calls
 * against a live server — and still guessed wrong about intent.
 *
 * The precedent is already in the product and only half-built: `query_spec
 * {section:"ops"}` returns a JSON Schema per spec-op, explicitly so that nobody
 * has to guess an arg shape. Entities deserve the same, and one level lower:
 * `section: "data"` describes the *spec*, which is not what a client talks to.
 * A client talks to routes, with a per-mode accepted shape, nullability that
 * differs between create and update, and enum members spelled as they are sent.
 *
 * **Derived, not restated.** The schemas come from `generateValidationSchema` —
 * the very function the request path validates with — by way of the same
 * spec → table → resource fold the runtime uses. A hand-written description of
 * the same contract would be a second definition to keep in step, and the first
 * thing it would have hidden is #257: an update mode that dropped nullability
 * would have been visible here as a contract statement instead of arriving as a
 * runtime surprise.
 */

import { z } from 'zod'
import { type SpecEntityShape, tableFromSpecEntity } from './from-spec.ts'
import { introspectTable } from './introspection.ts'
import {
	describeColumn,
	generateValidationSchema,
	WALL_CLOCK_DATE_TIME_JSON_SCHEMA,
} from './validation.ts'

export interface ApiResourceContract {
	/** The path segment: `/api/<resource>`. */
	resource: string
	description?: string
	routes: {
		list: string
		get: string
		create: string
		update: string
		delete: string
		count: string
		search: string
	}
	/** JSON Schema for a `POST` body. */
	create: unknown
	/**
	 * JSON Schema for a `PATCH` body. Every field optional; a nullable field
	 * still accepts `null`, which is how it is cleared.
	 */
	update: unknown
	/** Per-field prose: what it accepts, in each mode. */
	fields: Record<string, { create: string; update: string }>
}

/**
 * Say what a spec `date` really is, wherever one appears in the rendered schema
 *.
 *
 * The rest of this module is derived and nothing else, deliberately. This is
 * the one thing that cannot be: the rule lives in the column's *preprocess*,
 * which runs before the validator zod renders, so no rendering of that
 * validator can state it. Left underived, the contract published the opposite —
 * `format: "date-time"` (RFC 3339: an offset is REQUIRED) and a pattern whose
 * tail accepted `Z` or `±HH:MM` — for a column that is a timestamp WITHOUT time
 * zone, and that a zoned value moves by the offset.
 */
function stateWallClockDates(node: unknown): void {
	if (Array.isArray(node)) {
		for (const child of node) stateWallClockDates(child)
		return
	}
	if (node === null || typeof node !== 'object') return
	const schema = node as Record<string, unknown>
	// Only a `date` column produces `date-time` here — every other column type
	// renders a string with no format, a scalar, or "any".
	if (schema.format === 'date-time') {
		delete schema.format
		Object.assign(schema, WALL_CLOCK_DATE_TIME_JSON_SCHEMA)
		return
	}
	for (const child of Object.values(schema)) stateWallClockDates(child)
}

/** A JSON Schema for one validation mode, tolerant of the preprocessed types. */
function schemaFor(
	entity: SpecEntityShape,
	mode: 'create' | 'update',
): unknown {
	const resource = introspectTable(tableFromSpecEntity(entity))
	try {
		const rendered = z.toJSONSchema(generateValidationSchema(resource, mode), {
			io: 'input',
			// A `json` column carries a `z.custom`, which has no exact JSON Schema;
			// rendering it as "any" beside the prose in `fields` is far better than
			// refusing to answer the question at all. (A `date` column used to land
			// here too, via a `z.date()` branch that rendered as the everything-
			// accepting `{}` — see #316; it is now a union of two string forms.)
			unrepresentable: 'any',
			// Every date column shares one schema instance, so this hoists the date
			// pattern into `$defs` and references it: an entity with two date fields
			// costs one copy of a ~500-character regex per mode, not two.
			reused: 'ref',
		})
		stateWallClockDates(rendered)
		return rendered
	} catch {
		return null
	}
}

/** The REST contract of one spec entity. */
export function entityApiContract(
	entity: SpecEntityShape,
): ApiResourceContract {
	const name = entity.name
	const resource = introspectTable(tableFromSpecEntity(entity))
	const fields: ApiResourceContract['fields'] = {}
	for (const column of resource.columns) {
		if (column.isPrimaryKey) continue
		fields[column.name] = {
			create: describeColumn(column, 'create').accepts,
			update: describeColumn(column, 'update').accepts,
		}
	}
	return {
		resource: name,
		description: entity.description,
		routes: {
			list: `GET /api/${name}`,
			get: `GET /api/${name}/:id`,
			create: `POST /api/${name}`,
			update: `PATCH /api/${name}/:id`,
			delete: `DELETE /api/${name}/:id`,
			count: `GET /api/${name}/count`,
			search: `GET /api/${name}/search?q=`,
		},
		create: schemaFor(entity, 'create'),
		update: schemaFor(entity, 'update'),
		fields,
	}
}

/** Every spec entity's REST contract. */
export function apiContract(
	entities: readonly SpecEntityShape[],
): ApiResourceContract[] {
	return entities.map(entityApiContract)
}
