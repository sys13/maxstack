/**
 * The `types` generator — knowledge turned into compile errors.
 *
 * The dogfood session hand-wrote a `Book` type, a `Status` union, and a
 * `fromDraft` payload shaper. All three are derivable, and each hand-written
 * copy is a place to be wrong: the union drifts the moment somebody adds an enum
 * member with a spec op, and the shaper is where the empty-string-versus-null
 * bug gets written from scratch in every app.
 */

import {
	type FieldSpec,
	manual,
	newSpecSystem,
	type SpecSystem,
} from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import { describe, expect, it } from 'vitest'
import { typesGenerator } from './generators.ts'

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
			field({ id: 'fld-rating', name: 'rating', type: 'number' }),
		],
		provenance: manual(),
	})
	return spec
}

const emit = (spec: SpecSystem): string =>
	(typesGenerator.run(spec, {}) as { artifacts: { content: string }[] })
		.artifacts[0]?.content ?? ''

describe('typesGenerator', () => {
	it('pins the enum union to the spec instead of leaving it hand-written', () => {
		const out = emit(bookSpec())
		expect(out).toContain('export type BookStatus =')
		expect(out).toContain("| 'reading'")
		expect(out).toContain("| 'finished'")
	})

	it('types a nullable field as nullable and a required one as not', () => {
		const out = emit(bookSpec())
		expect(out).toMatch(/\btitle: string\n/)
		expect(out).toMatch(/\brating: number \| null/)
	})

	it('emits a PATCH type where every field is optional', () => {
		expect(emit(bookSpec())).toMatch(
			/export interface BookPatch \{\n\ttitle\?: string/,
		)
	})

	it('emits a toPatch that maps "" to null only where null is accepted', () => {
		// This is the function the #257 bug lives in when apps write it by hand.
		const out = emit(bookSpec())
		expect(out).toContain('export function toBookPatch(')
		expect(out).toContain(
			"BOOK_NULLABLE = new Set<string>(['status', 'rating'])",
		)
	})

	it('pins the resource name so app code holds no magic string', () => {
		const out = emit(bookSpec())
		expect(out).toContain("'book': 'book',")
		expect(out).toContain('export type ResourceName =')
		expect(out).toContain("'book': Book")
	})

	it('never types the primary key as writable', () => {
		expect(emit(bookSpec())).not.toMatch(
			/export interface BookPatch \{[^}]*\bid\?/,
		)
	})

	it('emits a compiling module for a spec with no entities', () => {
		const out = emit(newSpecSystem(tasklyPRD))
		expect(out).toContain('export {}')
	})

	it('marks the file generated so nobody hand-edits it', () => {
		expect(emit(bookSpec())).toMatch(/^\/\/ GENERATED/)
	})
})
