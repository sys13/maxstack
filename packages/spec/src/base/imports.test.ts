/**
 * Declared importers at the spec layer: the five ops, the
 * validator, and the selectors.
 *
 * Organized around the refusals, because that is where the whole risk of this
 * primitive lives. Everything this validator lets through eventually writes rows
 * through `opCreate`/`opUpdate`, and the two failure modes it exists to prevent
 * are both **silent when they happen**: an upsert key that cannot identify a row
 * overwrites the wrong rows and reports a successful import, and a mapping with
 * two columns aimed at one field loses a value with no error anywhere.
 */

import { describe, expect, it } from 'vitest'
import { tasklyPRD } from '../fixtures/index.ts'
import {
	activeImporters,
	describeImporter,
	findImporter,
	type ImporterSpec,
	importerModuleName,
	importersFor,
	listImporters,
	MAX_IMPORT_COLUMNS,
	MAX_IMPORT_KEY_LENGTH,
	MAX_IMPORT_ROWS,
} from './imports.ts'
import { manual, suggested } from './provenance.ts'
import {
	type ApplyMeta,
	applyOp,
	diffOp,
	SPEC_OP_NAMES,
	type SpecOp,
	validateOp,
} from './spec-ops.ts'
import { collectSpecSystemErrors } from './spec-system.schema.ts'
import { newSpecSystem, type SpecSystem } from './spec-system.ts'

const meta = (n: number): ApplyMeta => ({
	actor: { surface: 'harness' },
	id: `op-${n}`,
	origin: 'human',
	appliedAt: '2026-07-28',
})

/** A spec with a card entity carrying one of every field type worth refusing. */
function withCard(): SpecSystem {
	return applyOp(
		newSpecSystem(tasklyPRD),
		{
			op: 'data.addEntity',
			args: {
				entity: {
					id: 'e-card',
					name: 'Card',
					description: 'A flashcard.',
					fields: [
						{ id: 'fld-guid', name: 'guid', type: 'string', required: true },
						{ id: 'fld-front', name: 'front', type: 'string', required: true },
						{ id: 'fld-back', name: 'back', type: 'string', required: false },
						{ id: 'fld-ease', name: 'ease', type: 'number', required: false },
						{
							id: 'fld-suspended',
							name: 'suspended',
							type: 'boolean',
							required: false,
						},
						{ id: 'fld-due', name: 'due', type: 'date', required: false },
						{ id: 'fld-extra', name: 'extra', type: 'json', required: false },
						{
							id: 'fld-kind',
							name: 'kind',
							type: 'enum',
							required: false,
							options: [{ label: 'Basic', value: 'basic' }],
						},
						{
							id: 'fld-media',
							name: 'media',
							type: 'file',
							required: false,
							file: { accept: ['image/png'], maxSizeBytes: 1024 },
						},
					],
				},
			},
		} as SpecOp,
		meta(1),
	)
}

/** A valid CSV importer over the card entity, upserting on its guid. */
function importer(over: Partial<ImporterSpec> = {}): ImporterSpec {
	return {
		id: 'imp-cards',
		key: 'cards-csv',
		description: 'Import cards from a CSV our old tool exports.',
		entityId: 'e-card',
		format: 'csv',
		columns: [
			{ column: 'GUID', fieldId: 'fld-guid' },
			{ column: 'Front', fieldId: 'fld-front' },
			{ column: 'Back', fieldId: 'fld-back' },
		],
		upsertFieldId: 'fld-guid',
		maxRows: 5000,
		paused: false,
		declaredAt: '2026-07-28',
		provenance: manual(),
		...over,
	} as ImporterSpec
}

const declare = (spec: ImporterSpec): SpecOp => ({
	op: 'imports.declare',
	args: { importer: spec },
})

/** Declare an importer on a fresh card spec and return the resulting system. */
function declared(over: Partial<ImporterSpec> = {}): SpecSystem {
	return applyOp(withCard(), declare(importer(over)), meta(2))
}

describe('imports.declare', () => {
	it('lands a valid importer and stamps declaredAt from the op', () => {
		const system = applyOp(
			withCard(),
			declare(
				importer({
					declaredAt: undefined as unknown as ImporterSpec['declaredAt'],
				}),
			),
			meta(2),
		)
		const [landed] = listImporters(system)
		expect(landed?.key).toBe('cards-csv')
		expect(landed?.declaredAt).toBe('2026-07-28')
		expect(collectSpecSystemErrors(system)).toEqual([])
	})

	it('allows several importers on one entity — two files, one table', () => {
		// Deliberately unlike a search index, where one entity has one answer to
		// "what does searching this mean". A CSV export and an Anki deck are two
		// different files about one table.
		const system = applyOp(
			declared(),
			declare(
				importer({
					id: 'imp-anki',
					key: 'anki-apkg',
					format: 'custom',
					parserSlot: 'anki.apkg',
				}),
			),
			meta(3),
		)
		expect(importersFor(system, 'e-card')).toHaveLength(2)
		expect(collectSpecSystemErrors(system)).toEqual([])
	})

	it('refuses a duplicate key — it is a URL, an audit label and a module path', () => {
		const errors = validateOp(declared(), declare(importer({ id: 'imp-two' })))
		expect(errors.join('\n')).toContain('already exists')
	})

	it('refuses a key longer than the bound', () => {
		const errors = validateOp(
			withCard(),
			declare(importer({ key: 'a'.repeat(MAX_IMPORT_KEY_LENGTH + 1) })),
		)
		expect(errors.join('\n')).toContain(String(MAX_IMPORT_KEY_LENGTH))
	})

	it('refuses an unknown entity', () => {
		const errors = validateOp(
			withCard(),
			declare(importer({ entityId: 'e-nope' })),
		)
		expect(errors.join('\n')).toContain('unknown entity')
	})
})

describe('the upsert key — the lever that decides whether this destroys data', () => {
	it('refuses a boolean key: it collapses the whole table onto two rows', () => {
		// The issue's gating bullet made mechanical. This is the "just overwrite
		// everything" path, reachable by picking the wrong field from a dropdown,
		// so the vocabulary refuses to be able to say it rather than warning.
		const errors = validateOp(
			withCard(),
			declare(
				importer({
					columns: [
						{ column: 'GUID', fieldId: 'fld-guid' },
						{ column: 'Suspended', fieldId: 'fld-suspended' },
					],
					upsertFieldId: 'fld-suspended',
				}),
			),
		)
		expect(errors.join('\n')).toContain('collapses the whole table')
	})

	it('refuses a date key and a json key for their own reasons', () => {
		const dateErrors = validateOp(
			withCard(),
			declare(
				importer({
					columns: [{ column: 'Due', fieldId: 'fld-due' }],
					upsertFieldId: 'fld-due',
				}),
			),
		)
		expect(dateErrors.join('\n')).toContain('is a date')
		const jsonErrors = validateOp(
			withCard(),
			declare(
				importer({
					columns: [{ column: 'Extra', fieldId: 'fld-extra' }],
					upsertFieldId: 'fld-extra',
				}),
			),
		)
		expect(jsonErrors.join('\n')).toContain('is a json')
	})

	it('accepts string, number and enum keys', () => {
		for (const [column, fieldId] of [
			['GUID', 'fld-guid'],
			['Ease', 'fld-ease'],
			['Kind', 'fld-kind'],
		] as const) {
			const errors = validateOp(
				withCard(),
				declare(
					importer({
						columns: [{ column, fieldId }],
						upsertFieldId: fieldId,
					}),
				),
			)
			expect(errors).toEqual([])
		}
	})

	it('refuses a key the file does not supply — an unmatched key means duplicates', () => {
		const errors = validateOp(
			withCard(),
			declare(
				importer({
					columns: [{ column: 'Front', fieldId: 'fld-front' }],
					upsertFieldId: 'fld-guid',
				}),
			),
		)
		expect(errors.join('\n')).toContain('not among the mapped columns')
	})

	it('refuses an omitted key — nullable is not the same as optional', () => {
		const errors = validateOp(
			withCard(),
			declare(
				importer({
					upsertFieldId: undefined as unknown as ImporterSpec['upsertFieldId'],
				}),
			),
		)
		expect(errors.join('\n')).toContain('upsertFieldId is required')
	})

	it('accepts an explicit null — insert-only is a decision, and a stated one', () => {
		const system = declared({ upsertFieldId: null })
		expect(listImporters(system)[0]?.upsertFieldId).toBeNull()
		expect(
			describeImporter(listImporters(system)[0] as ImporterSpec),
		).toContain('insert-only')
	})
})

describe('the column mapping', () => {
	it('refuses a file column: only the upload path can mint a storage key', () => {
		const errors = validateOp(
			withCard(),
			declare(
				importer({
					columns: [
						{ column: 'GUID', fieldId: 'fld-guid' },
						{ column: 'Media', fieldId: 'fld-media' },
					],
				}),
			),
		)
		expect(errors.join('\n')).toContain('storage key')
	})

	it('imports every other type, including json and date', () => {
		const errors = validateOp(
			withCard(),
			declare(
				importer({
					columns: [
						{ column: 'GUID', fieldId: 'fld-guid' },
						{ column: 'Ease', fieldId: 'fld-ease' },
						{ column: 'Suspended', fieldId: 'fld-suspended' },
						{ column: 'Due', fieldId: 'fld-due' },
						{ column: 'Extra', fieldId: 'fld-extra' },
						{ column: 'Kind', fieldId: 'fld-kind' },
					],
				}),
			),
		)
		expect(errors).toEqual([])
	})

	it('refuses two columns aimed at one field — the winner would depend on order', () => {
		const errors = validateOp(
			withCard(),
			declare(
				importer({
					columns: [
						{ column: 'GUID', fieldId: 'fld-guid' },
						{ column: 'Front', fieldId: 'fld-front' },
						{ column: 'Question', fieldId: 'fld-front' },
					],
				}),
			),
		)
		expect(errors.join('\n')).toContain('destination of two columns')
	})

	it('refuses one column aimed at two fields', () => {
		const errors = validateOp(
			withCard(),
			declare(
				importer({
					columns: [
						{ column: 'GUID', fieldId: 'fld-guid' },
						{ column: 'GUID', fieldId: 'fld-front' },
					],
				}),
			),
		)
		expect(errors.join('\n')).toContain('mapped twice')
	})

	it('refuses a field belonging to another entity, not merely a missing one', () => {
		// The check is against the OWNER entity: a foreign field id resolves, and
		// would map this file's column onto somebody else's table.
		const twoEntities = applyOp(
			withCard(),
			{
				op: 'data.addEntity',
				args: {
					entity: {
						id: 'e-deck',
						name: 'Deck',
						fields: [
							{
								id: 'fld-deck-name',
								name: 'name',
								type: 'string',
								required: true,
							},
						],
					},
				},
			} as SpecOp,
			meta(9),
		)
		const errors = validateOp(
			twoEntities,
			declare(
				importer({
					columns: [
						{ column: 'GUID', fieldId: 'fld-guid' },
						{ column: 'Deck', fieldId: 'fld-deck-name' },
					],
				}),
			),
		)
		expect(errors.join('\n')).toContain('is not a field of entity "e-card"')
	})

	it('refuses an empty mapping and one past the bound', () => {
		expect(
			validateOp(withCard(), declare(importer({ columns: [] }))).join('\n'),
		).toContain('at least one column')
		const many = Array.from({ length: MAX_IMPORT_COLUMNS + 1 }, (_, i) => ({
			column: `c${i}`,
			fieldId: 'fld-front' as const,
		}))
		expect(
			validateOp(withCard(), declare(importer({ columns: many }))).join('\n'),
		).toContain(String(MAX_IMPORT_COLUMNS))
	})
})

describe('the parser slot', () => {
	it('requires one on format custom', () => {
		const errors = validateOp(
			withCard(),
			declare(importer({ format: 'custom' })),
		)
		expect(errors.join('\n')).toContain('requires a parserSlot')
	})

	it('refuses one on a format that already has a reader', () => {
		const errors = validateOp(
			withCard(),
			declare(importer({ format: 'csv', parserSlot: 'anki.apkg' })),
		)
		expect(errors.join('\n')).toContain('only legal on format "custom"')
	})

	it('flattens a dotted key into one module segment', () => {
		expect(importerModuleName('anki.apkg')).toBe('anki-apkg')
		expect(importerModuleName('cards-csv')).toBe('cards-csv')
	})
})

describe('the row ceiling', () => {
	it('requires an integer inside the hard cap', () => {
		expect(
			validateOp(withCard(), declare(importer({ maxRows: 0 }))).join('\n'),
		).toContain('maxRows')
		expect(
			validateOp(
				withCard(),
				declare(importer({ maxRows: MAX_IMPORT_ROWS + 1 })),
			).join('\n'),
		).toContain('maxRows')
		expect(
			validateOp(withCard(), declare(importer({ maxRows: 10.5 }))).join('\n'),
		).toContain('maxRows')
	})
})

describe('imports.setMapping', () => {
	it('replaces the mapping wholesale', () => {
		const next = applyOp(
			declared(),
			{
				op: 'imports.setMapping',
				args: {
					importerId: 'imp-cards',
					columns: [
						{ column: 'GUID', fieldId: 'fld-guid' },
						{ column: 'Question', fieldId: 'fld-front' },
					],
				},
			},
			meta(3),
		)
		expect(listImporters(next)[0]?.columns.map((c) => c.column)).toEqual([
			'GUID',
			'Question',
		])
	})

	it('re-validates the WHOLE declaration — a mapping that drops the key is refused', () => {
		// Checking the mapping in isolation would accept this, and the importer
		// would silently become insert-only: every run appends duplicates.
		const errors = validateOp(declared(), {
			op: 'imports.setMapping',
			args: {
				importerId: 'imp-cards',
				columns: [{ column: 'Front', fieldId: 'fld-front' }],
			},
		})
		expect(errors.join('\n')).toContain('not among the mapped columns')
	})

	it('refuses an unknown importer', () => {
		expect(
			validateOp(declared(), {
				op: 'imports.setMapping',
				args: { importerId: 'imp-nope', columns: [] },
			}).join('\n'),
		).toContain('unknown importer')
	})
})

describe('imports.setUpsertKey', () => {
	it('turns an upserting importer insert-only, and says so in the diff', () => {
		const next = applyOp(
			declared(),
			{
				op: 'imports.setUpsertKey',
				args: { importerId: 'imp-cards', upsertFieldId: null },
			},
			meta(3),
		)
		expect(listImporters(next)[0]?.upsertFieldId).toBeNull()
		// The diff summary states the CONSEQUENCE, because it is the line somebody
		// skims to decide whether the change can destroy data.
		const summary = diffOp({
			op: 'imports.setUpsertKey',
			args: { importerId: 'imp-cards', upsertFieldId: null },
		}).summary
		expect(summary).toContain('INSERT-ONLY')
		expect(
			diffOp({
				op: 'imports.setUpsertKey',
				args: { importerId: 'imp-cards', upsertFieldId: 'fld-guid' },
			}).summary,
		).toContain('OVERWRITE')
	})

	it('re-validates with the new key spliced in', () => {
		const errors = validateOp(declared(), {
			op: 'imports.setUpsertKey',
			args: { importerId: 'imp-cards', upsertFieldId: 'fld-ease' },
		})
		// `ease` is a legal upsert TYPE but is not in the mapping.
		expect(errors.join('\n')).toContain('not among the mapped columns')
	})

	it('refuses an undecided key', () => {
		expect(
			validateOp(declared(), {
				op: 'imports.setUpsertKey',
				args: {
					importerId: 'imp-cards',
					upsertFieldId: undefined as unknown as null,
				},
			}).join('\n'),
		).toContain('not deciding is the one thing it may not be')
	})

	it('is its own op — "can this destroy data?" is answerable from the NAME', () => {
		// The design argument, pinned. Folding this into a general-purpose edit op
		// would put the answer inside an argument, where a reviewer skimming a diff
		// of op names would not see it.
		expect(SPEC_OP_NAMES.filter((n) => n.startsWith('imports.'))).toEqual([
			'imports.declare',
			'imports.setMapping',
			'imports.setUpsertKey',
			'imports.pause',
			'imports.remove',
		])
	})
})

describe('imports.pause and imports.remove', () => {
	it('pauses and resumes without losing the declaration', () => {
		const paused = applyOp(
			declared(),
			{ op: 'imports.pause', args: { importerId: 'imp-cards', paused: true } },
			meta(3),
		)
		expect(listImporters(paused)).toHaveLength(1)
		expect(activeImporters(paused)).toHaveLength(0)
		const resumed = applyOp(
			paused,
			{ op: 'imports.pause', args: { importerId: 'imp-cards', paused: false } },
			meta(4),
		)
		expect(activeImporters(resumed)).toHaveLength(1)
	})

	it('refuses to remove an active importer — pausing is the retire step', () => {
		const errors = validateOp(declared(), {
			op: 'imports.remove',
			args: { importerId: 'imp-cards' },
		})
		expect(errors.join('\n')).toContain('pause it with imports.pause')
	})

	it('removes a paused one', () => {
		const paused = applyOp(
			declared(),
			{ op: 'imports.pause', args: { importerId: 'imp-cards', paused: true } },
			meta(3),
		)
		const removed = applyOp(
			paused,
			{ op: 'imports.remove', args: { importerId: 'imp-cards' } },
			meta(4),
		)
		expect(listImporters(removed)).toEqual([])
	})
})

describe('selectors', () => {
	it('reads nothing from a spec that never declared an importer', () => {
		const empty = newSpecSystem(tasklyPRD)
		expect(listImporters(empty)).toEqual([])
		expect(activeImporters(empty)).toEqual([])
		expect(findImporter(empty, 'cards-csv')).toBeUndefined()
	})

	it('grounds accepted-else-all, then drops the paused ones', () => {
		// `activeSources`' rule exactly. Once *any* row is accepted, an
		// undecided one is not active: an importer an agent proposed and nobody
		// reviewed does not start accepting uploads, which is the point of having a
		// review queue in front of a vocabulary that can now write rows from a file.
		const system = applyOp(
			declared(),
			declare(importer({ id: 'imp-anki', key: 'anki-csv' })),
			meta(5),
		)
		const [, second] = listImporters(system)
		;(second as ImporterSpec).provenance = suggested()
		expect(activeImporters(system).map((i) => i.id)).toEqual(['imp-cards'])
		expect(listImporters(system)).toHaveLength(2)
	})

	it('describes an importer with its write posture first', () => {
		const one = listImporters(declared())[0] as ImporterSpec
		expect(describeImporter(one)).toContain('upsert on fld-guid')
		expect(findImporter(declared(), 'cards-csv')?.id).toBe('imp-cards')
	})
})
