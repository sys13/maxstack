/**
 * `query_spec {section:"api"}` — the generated API's contract.
 *
 * The session this closes needed to know what `PATCH /api/book/:id` accepts,
 * had no way to ask, and ran a probe matrix of curl calls against a live server
 * instead. These pin the two properties that make publishing a contract worth
 * anything: it describes the ROUTES a client talks to, and it is derived from
 * the same validator the request path runs, so it cannot describe a different
 * API than the one being served.
 */

import { apiContract } from '@maxstack/core'
import {
	type FieldSpec,
	manual,
	newSpecSystem,
	type SpecSystem,
} from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import { describe, expect, it } from 'vitest'
import { groundedEntityShapes } from './grounding.ts'

const field = (
	over: Partial<FieldSpec> & Pick<FieldSpec, 'id' | 'name' | 'type'>,
): FieldSpec =>
	({ required: false, provenance: manual(), ...over }) as FieldSpec

function bookSpec(): SpecSystem {
	const spec = newSpecSystem(tasklyPRD)
	spec.data.entities.push({
		id: 'e-book',
		name: 'Book',
		fields: [
			field({ id: 'fld-title', name: 'title', type: 'string', required: true }),
			field({
				id: 'fld-status',
				name: 'status',
				type: 'enum',
				options: [
					{ label: 'Reading', value: 'reading' },
					{ label: 'Finished', value: 'finished' },
				],
			}),
			field({ id: 'fld-started', name: 'startedOn', type: 'date' }),
			field({ id: 'fld-finished', name: 'finishedOn', type: 'date' }),
		],
		provenance: manual(),
	})
	return spec
}

const book = () =>
	apiContract(groundedEntityShapes(bookSpec())).find(
		(r) => r.resource === 'book',
	)

describe('the API contract', () => {
	it('names the routes a client actually talks to', () => {
		// `section: "data"` describes the spec. A client talks to these.
		expect(book()?.routes).toMatchObject({
			list: 'GET /api/book',
			create: 'POST /api/book',
			update: 'PATCH /api/book/:id',
			delete: 'DELETE /api/book/:id',
		})
	})

	it('marks required fields required on create and optional on update', () => {
		const contract = book()
		if (!contract) throw new Error('book contract missing')
		const create = contract.create as { required?: string[] }
		const update = contract.update as { required?: string[] }
		expect(create.required).toContain('title')
		expect(update.required ?? []).toEqual([])
	})

	it('states, as a contract, that a nullable field takes null on update', () => {
		// The point of publishing this: #257 would have been visible here as a
		// contract statement rather than arriving as a runtime surprise.
		expect(book()?.fields.finishedOn?.update).toMatch(/null to clear it/)
		expect(book()?.fields.finishedOn?.create).toMatch(/wall-clock date-time/)
	})

	describe('a spec `date` — a timestamp WITHOUT time zone', () => {
		const dateSchema = (mode: 'create' | 'update'): string =>
			JSON.stringify(book()?.[mode] ?? null)

		it('says what happens to a zoned value instead of silently moving it', () => {
			// The contradiction #316 filed: `data.addField`'s arg schema warns that
			// re-zoning a wall clock moves it by the offset, while the contract
			// generated from that same field advertised `format: "date-time"` with an
			// offset-accepting pattern and said nothing. Now the contract states the
			// rule the request path actually applies.
			for (const mode of ['create', 'update'] as const) {
				expect(dateSchema(mode)).toMatch(/WITHOUT time zone/)
				expect(dateSchema(mode)).toMatch(/DISCARDED/)
			}
		})

		it('does not claim RFC 3339 `date-time`, which REQUIRES an offset', () => {
			// The column is a timestamp WITHOUT time zone. `format: "date-time"`
			// told a strict client that the one shape it may not send is the wall
			// clock this column actually stores.
			expect(dateSchema('create')).not.toMatch(/"format":"date-time"/)
			// And the zone tail is a statement now, not zod's empty alternation.
			expect(dateSchema('create')).not.toMatch(/\(\?:Z\|\)/)
		})

		it('no longer collapses to "any value" through an empty `{}` branch', () => {
			// `z.date()` rendered as `{}`, and an `anyOf` containing `{}` accepts
			// anything — the published union constrained nothing at all.
			const create = book()?.create as {
				properties?: Record<string, { anyOf?: unknown[] }>
			}
			const branches = JSON.stringify(
				create?.properties?.finishedOn?.anyOf ?? [],
			)
			expect(branches).not.toMatch(/\{\}/)
		})

		it('costs one copy of the date pattern, not one per field', () => {
			// Two date fields on one entity used to inline the same ~500-character
			// regex twice per mode, into a payload already flagged as large.
			const create = book()?.create as { $defs?: Record<string, unknown> }
			expect(Object.keys(create?.$defs ?? {}).length).toBeGreaterThan(0)
			const occurrences = dateSchema('create').split('T(?:').length - 1
			expect(occurrences).toBe(1)
		})
	})

	it('spells enum members as a client would send them', () => {
		expect(book()?.fields.status?.create).toMatch(/"reading" \| "finished"/)
	})

	it('never exposes the primary key as a writable field', () => {
		expect(Object.keys(book()?.fields ?? {})).not.toContain('id')
	})
})
