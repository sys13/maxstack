import { describe, expect, it } from 'vitest'
import { tasklyPRD } from '../fixtures/index.ts'
import type { LedgerEntry } from './decision-ledger.ts'
import { accept, manual, suggested } from './provenance.ts'
import { activeSources, looksLikeSecret } from './sources.ts'
import { decodeSpecSystem, encodeSpecSystem } from './spec-codec.ts'
import {
	type ApplyMeta,
	applyOp,
	diffOp,
	SPEC_OP_NAMES,
	SPEC_OP_VOCABULARY,
	type SpecOp,
	validateOp,
	validateOpDryRun,
} from './spec-ops.ts'
import { validateSpecSystem } from './spec-system.schema.ts'
import { newSpecSystem, resolveTheme, type SpecSystem } from './spec-system.ts'

const base = (): SpecSystem => newSpecSystem(tasklyPRD)
const meta = (n: number): ApplyMeta => ({
	actor: { surface: 'harness' },
	id: `op-${n}`,
	origin: 'ai',
	appliedAt: '2026-07-09',
})

const entity: SpecOp = {
	op: 'data.addEntity',
	args: {
		entity: {
			id: 'e-invoice',
			name: 'Invoice',
			fields: [
				{
					id: 'fld-total',
					name: 'total',
					type: 'number',
					required: true,
					provenance: suggested(),
				},
			],
			provenance: suggested(),
		},
	},
}

describe('the vocabulary', () => {
	it('is the first 10 ops + the set-ops + theme.set + site.set + the derived-value ops + the flag ops + the schedule ops + data.setFieldReference + data.setFieldOpenReference + data.setFieldDisplay + the date-view ops + the board ops + the external-source ops + the search ops + the document ops + the importer ops + the portal ops + the live ops + the view ops + provenance.review, one metadata entry each', () => {
		expect(SPEC_OP_NAMES).toHaveLength(68)
		expect(Object.keys(SPEC_OP_VOCABULARY).sort()).toEqual(
			[...SPEC_OP_NAMES].sort(),
		)
		// spans all fifteen layers, plus the system-level review op
		expect(
			new Set(Object.values(SPEC_OP_VOCABULARY).map((m) => m.layer)),
		).toEqual(
			new Set([
				'product',
				'data',
				'page',
				'pricing',
				'theme',
				'flags',
				'schedules',
				'sources',
				'search',
				'documents',
				'imports',
				'portals',
				'live',
				'view',
				'site',
				'system',
			]),
		)
	})

	it('carries a per-op args JSON Schema — the vocabulary is self-describing', () => {
		for (const meta of Object.values(SPEC_OP_VOCABULARY)) {
			expect(meta.args.type).toBe('object')
			// every op has at least one named argument…
			expect(Object.keys(meta.args.properties).length).toBeGreaterThan(0)
			// …and every required key is actually described in properties
			for (const key of meta.args.required ?? []) {
				expect(meta.args.properties).toHaveProperty(key)
			}
		}
	})

	it('describes data.addField’s field shape down to the seven canonical types', () => {
		const field = SPEC_OP_VOCABULARY['data.addField'].args.properties.field
		expect(field?.required).toEqual(['id', 'name', 'type', 'required'])
		expect(field?.properties?.type?.enum).toEqual([
			'string',
			'number',
			'boolean',
			'date',
			'enum',
			'json',
			'file',
		])
	})
})

describe('applyOp is validated, immutable, and logged', () => {
	it('never mutates the input system', () => {
		const s0 = base()
		const s1 = applyOp(s0, entity, meta(1))
		expect(s0.data.entities).toHaveLength(0)
		expect(s1.data.entities).toHaveLength(1)
		expect(s1.opLog).toHaveLength(1)
		expect(s1.opLog[0]?.diff.targetId).toBe('e-invoice')
	})

	it('throws (never lands a broken spec) on an invalid op', () => {
		const s0 = applyOp(base(), entity, meta(1))
		// duplicate entity id
		expect(() => applyOp(s0, entity, meta(2))).toThrow(/already exists/)
	})
})

describe('data layer ops + cross-references', () => {
	it('addField requires the parent entity to exist', () => {
		const field: SpecOp = {
			op: 'data.addField',
			args: {
				entityId: 'e-missing',
				field: {
					id: 'fld-x',
					name: 'x',
					type: 'string',
					required: false,
					provenance: suggested(),
				},
			},
		}
		expect(validateOp(base(), field)).toContain(
			'data.addField: unknown entity "e-missing"',
		)
	})

	it('addField lands under the right entity', () => {
		let s = applyOp(base(), entity, meta(1))
		s = applyOp(
			s,
			{
				op: 'data.addField',
				args: {
					entityId: 'e-invoice',
					field: {
						id: 'fld-due',
						name: 'dueDate',
						type: 'date',
						required: false,
						provenance: manual(),
					},
				},
			},
			meta(2),
		)
		expect(s.data.entities[0]?.fields.map((f) => f.id)).toEqual([
			'fld-total',
			'fld-due',
		])
	})

	it('a field reference must resolve to a known entity (task 32)', () => {
		const s = applyOp(base(), entity, meta(1)) // has e-invoice
		const badRef: SpecOp = {
			op: 'data.addField',
			args: {
				entityId: 'e-invoice',
				field: {
					id: 'fld-owner',
					name: 'ownerId',
					type: 'string',
					required: false,
					reference: 'e-ghost',
					provenance: suggested(),
				},
			},
		}
		expect(validateOp(s, badRef)).toContain(
			'data.addField: field "fld-owner" -> unknown reference entity "e-ghost"',
		)

		const goodRef: SpecOp = {
			...badRef,
			args: {
				...badRef.args,
				field: { ...badRef.args.field, reference: 'e-invoice' },
			},
		}
		expect(validateOp(s, goodRef)).toEqual([])
	})

	it('a reference may name the well-known virtual user entity', () => {
		const s = applyOp(base(), entity, meta(1)) // has e-invoice, no e-user
		const userRef: SpecOp = {
			op: 'data.addField',
			args: {
				entityId: 'e-invoice',
				field: {
					id: 'fld-owner',
					name: 'ownerId',
					type: 'string',
					required: false,
					reference: 'e-user',
					provenance: suggested(),
				},
			},
		}
		expect(validateOp(s, userRef)).toEqual([])
	})

	it('rejects an unknown field type instead of crashing the derived route', () => {
		// The compile-time FieldType union can't guard a JSON payload an agent
		// posts through MCP apply_spec_change. `type: "text"` is the CLI sugar
		// that the terminal DSL aliases to `string`, but raw ops carry it
		// verbatim — before this guard it landed in the spec and crashed every
		// /admin* route at render with no rollback. Both validators must fail it,
		// and applyOp must refuse to land it.
		const s = applyOp(base(), entity, meta(1)) // has e-invoice
		const badType: SpecOp = {
			op: 'data.addField',
			args: {
				entityId: 'e-invoice',
				field: {
					id: 'fld-note',
					name: 'note',
					// deliberately invalid: "text" is CLI sugar, not a canonical FieldType
					type: 'text' as never,
					required: false,
					provenance: suggested(),
				},
			},
		}
		const msg =
			'data.addField: field "fld-note" -> unknown type "text" (expected one of string, number, boolean, date, enum, json, file)'
		expect(validateOp(s, badType)).toContain(msg)
		expect(validateOpDryRun(s, badType, 'ai')).toContain(msg)
		expect(() => applyOp(s, badType, meta(2))).toThrow(/unknown type "text"/)

		// the same guard on data.addEntity, over each field
		const badEntity: SpecOp = {
			op: 'data.addEntity',
			args: {
				entity: {
					id: 'e-post',
					name: 'Post',
					fields: [
						{
							id: 'fld-body',
							name: 'body',
							type: 'text' as never,
							required: true,
							provenance: suggested(),
						},
					],
					provenance: suggested(),
				},
			},
		}
		expect(validateOp(base(), badEntity)).toContain(
			'data.addEntity: field "fld-body" -> unknown type "text" (expected one of string, number, boolean, date, enum, json, file)',
		)

		// the canonical spelling is accepted
		const goodType: SpecOp = {
			...badType,
			args: {
				...badType.args,
				field: { ...badType.args.field, type: 'string' },
			},
		}
		expect(validateOp(s, goodType)).toEqual([])
	})

	it('addEntity allows a field to self-reference the entity being added', () => {
		const selfRef: SpecOp = {
			op: 'data.addEntity',
			args: {
				entity: {
					id: 'e-node',
					name: 'Node',
					fields: [
						{
							id: 'fld-parent',
							name: 'parentId',
							type: 'string',
							required: false,
							reference: 'e-node',
							provenance: suggested(),
						},
					],
					provenance: suggested(),
				},
			},
		}
		expect(validateOp(base(), selfRef)).toEqual([])
	})

	it('addEntity works with no hand-written provenance, exactly as the docs show', () => {
		const noProvenance: SpecOp = {
			op: 'data.addEntity',
			args: {
				entity: {
					id: 'e-invoice-2',
					name: 'Invoice',
					fields: [
						{
							id: 'fld-total-2',
							name: 'total',
							type: 'number',
							required: true,
						},
					],
				},
			},
		}
		expect(validateOp(base(), noProvenance)).toEqual([])
		const humanLanded = applyOp(base(), noProvenance, {
			actor: { surface: 'harness' },
			id: 'op-h',
			origin: 'human',
			appliedAt: '2026-07-12',
		})
		// The CLI (human) origin stamps `manual()` — accepted, regen-protected —
		// so the caller never has to hand-write the boilerplate.
		const humanEntity = humanLanded.data.entities.find(
			(e) => e.id === 'e-invoice-2',
		)
		expect(humanEntity?.provenance).toEqual(manual())
		expect(humanEntity?.fields[0]?.provenance).toEqual(manual())
		expect(() => validateSpecSystem(humanLanded)).not.toThrow()

		const aiLanded = applyOp(base(), noProvenance, meta(1))
		// The MCP (ai) origin stamps an *accepted* suggestion — applying an op is
		// the accept half of suggest→accept, so the row is live immediately while
		// isSuggested keeps the AI origin visible. Undecided
		// review-queue rows pass an explicit suggested() instead.
		const aiEntity = aiLanded.data.entities.find((e) => e.id === 'e-invoice-2')
		expect(aiEntity?.provenance).toEqual(accept(suggested()))
		expect(aiEntity?.fields[0]?.provenance).toEqual(accept(suggested()))
		expect(() => validateSpecSystem(aiLanded)).not.toThrow()
	})

	it('an explicit provenance on the op is respected, not overwritten', () => {
		const explicit: SpecOp = {
			op: 'data.addField',
			args: {
				entityId: 'e-invoice',
				field: {
					id: 'fld-note',
					name: 'note',
					type: 'string',
					required: false,
					provenance: manual({ priority: 'high' }),
				},
			},
		}
		const seeded = applyOp(base(), entity, meta(0))
		const landed = applyOp(seeded, explicit, meta(1))
		const field = landed.data.entities
			.find((e) => e.id === 'e-invoice')
			?.fields.find((f) => f.id === 'fld-note')
		expect(field?.provenance).toEqual(manual({ priority: 'high' }))
	})
})

describe('page layer ops', () => {
	it('addBlock requires the page; addPage may reference a real entity', () => {
		let s = applyOp(base(), entity, meta(1))
		s = applyOp(
			s,
			{
				op: 'page.addPage',
				args: {
					page: {
						id: 'pg-invoices',
						name: 'Invoices',
						route: '/invoices',
						entityId: 'e-invoice',
						blocks: [],
						provenance: suggested(),
					},
				},
			},
			meta(2),
		)
		const badBlock: SpecOp = {
			op: 'page.addBlock',
			args: {
				pageId: 'pg-nope',
				block: { id: 'blk-1', type: 'table', provenance: suggested() },
			},
		}
		expect(validateOp(s, badBlock)).toContain(
			'page.addBlock: unknown page "pg-nope"',
		)
		s = applyOp(
			s,
			{
				op: 'page.addBlock',
				args: {
					pageId: 'pg-invoices',
					block: { id: 'blk-table', type: 'table', provenance: suggested() },
				},
			},
			meta(3),
		)
		expect(s.pages.pages[0]?.blocks).toHaveLength(1)
	})

	it('setBlockOrder ranks a table block by a real entity field, logged as a `set`', () => {
		// entity(fld-total: number) → page → table block, then rank by it.
		let s = applyOp(base(), entity, meta(1))
		s = applyOp(
			s,
			{
				op: 'page.addPage',
				args: {
					page: {
						id: 'pg-invoices',
						name: 'Invoices',
						route: '/invoices',
						entityId: 'e-invoice',
						blocks: [
							{ id: 'blk-table', type: 'table', provenance: suggested() },
						],
						provenance: suggested(),
					},
				},
			},
			meta(2),
		)
		const setOrder: SpecOp = {
			op: 'page.setBlockOrder',
			args: {
				pageId: 'pg-invoices',
				blockId: 'blk-table',
				order: { field: 'total', direction: 'desc' },
			},
		}
		s = applyOp(s, setOrder, meta(3))
		expect(s.pages.pages[0]?.blocks[0]?.order).toEqual({
			field: 'total',
			direction: 'desc',
		})
		const last = s.opLog.at(-1)
		expect(last?.diff.change).toBe('set')
		expect(last?.diff.summary).toContain('total desc')
	})

	it('setBlockOrder rejects an unknown field, a non-table block, and a missing block', () => {
		let s = applyOp(base(), entity, meta(1))
		s = applyOp(
			s,
			{
				op: 'page.addPage',
				args: {
					page: {
						id: 'pg-invoices',
						name: 'Invoices',
						route: '/invoices',
						entityId: 'e-invoice',
						blocks: [
							{ id: 'blk-table', type: 'table', provenance: suggested() },
							{ id: 'blk-hero', type: 'hero', provenance: suggested() },
						],
						provenance: suggested(),
					},
				},
			},
			meta(2),
		)
		const order = (blockId: `blk-${string}`, field: string): SpecOp => ({
			op: 'page.setBlockOrder',
			args: { pageId: 'pg-invoices', blockId, order: { field } },
		})
		expect(validateOp(s, order('blk-table', 'nope'))).toContain(
			'page.setBlockOrder: order.field "nope" is not a field of "e-invoice"',
		)
		expect(validateOp(s, order('blk-hero', 'total'))[0]).toMatch(
			/not an orderable table/,
		)
		expect(validateOp(s, order('blk-missing', 'total'))).toContain(
			'page.setBlockOrder: no block "blk-missing" in "pg-invoices"',
		)
	})

	it('setBlockVariant sets a table block’s presentation, logged as a `set`', () => {
		let s = applyOp(base(), entity, meta(1))
		s = applyOp(
			s,
			{
				op: 'page.addPage',
				args: {
					page: {
						id: 'pg-invoices',
						name: 'Invoices',
						route: '/invoices',
						entityId: 'e-invoice',
						blocks: [
							{ id: 'blk-table', type: 'table', provenance: suggested() },
							{ id: 'blk-hero', type: 'hero', provenance: suggested() },
						],
						provenance: suggested(),
					},
				},
			},
			meta(2),
		)
		s = applyOp(
			s,
			{
				op: 'page.setBlockVariant',
				args: { pageId: 'pg-invoices', blockId: 'blk-table', variant: 'cards' },
			},
			meta(3),
		)
		expect(s.pages.pages[0]?.blocks[0]?.variant).toBe('cards')
		const last = s.opLog.at(-1)
		expect(last?.diff.change).toBe('set')
		expect(last?.diff.layer).toBe('page')
		expect(last?.diff.summary).toContain('cards')
		expect(validateSpecSystem(s)).toBe(s)

		// rejections: non-table block, unknown block, unknown variant
		const variant = (blockId: `blk-${string}`, v: string): SpecOp => ({
			op: 'page.setBlockVariant',
			args: {
				pageId: 'pg-invoices',
				blockId,
				variant: v as 'cards',
			},
		})
		expect(validateOp(s, variant('blk-hero', 'cards'))[0]).toMatch(
			/not a list\/table block/,
		)
		expect(validateOp(s, variant('blk-missing', 'cards'))).toContain(
			'page.setBlockVariant: no block "blk-missing" in "pg-invoices"',
		)
		expect(validateOp(s, variant('blk-table', 'gallery'))[0]).toMatch(
			/unknown variant "gallery"/,
		)
	})

	it('setBlockFields selects the rendered columns in order, logged as a `set`', () => {
		let s = applyOp(base(), entity, meta(1))
		s = applyOp(
			s,
			{
				op: 'data.addField',
				args: {
					entityId: 'e-invoice',
					field: {
						id: 'fld-note',
						name: 'note',
						type: 'string',
						required: false,
						provenance: suggested(),
					},
				},
			},
			meta(2),
		)
		s = applyOp(
			s,
			{
				op: 'page.addPage',
				args: {
					page: {
						id: 'pg-invoices',
						name: 'Invoices',
						route: '/invoices',
						entityId: 'e-invoice',
						blocks: [
							{ id: 'blk-table', type: 'table', provenance: suggested() },
							{ id: 'blk-hero', type: 'hero', provenance: suggested() },
						],
						provenance: suggested(),
					},
				},
			},
			meta(3),
		)
		s = applyOp(
			s,
			{
				op: 'page.setBlockFields',
				args: {
					pageId: 'pg-invoices',
					blockId: 'blk-table',
					fields: ['note', 'total'],
				},
			},
			meta(4),
		)
		expect(s.pages.pages[0]?.blocks[0]?.fields).toEqual(['note', 'total'])
		const last = s.opLog.at(-1)
		expect(last?.diff.change).toBe('set')
		expect(last?.diff.layer).toBe('page')
		expect(last?.diff.summary).toContain('note, total')
		expect(validateSpecSystem(s)).toBe(s)

		// last-wins, like the other set-ops
		s = applyOp(
			s,
			{
				op: 'page.setBlockFields',
				args: {
					pageId: 'pg-invoices',
					blockId: 'blk-table',
					fields: ['total'],
				},
			},
			meta(5),
		)
		expect(s.pages.pages[0]?.blocks[0]?.fields).toEqual(['total'])

		// rejections: unknown field, non-table block, missing block, empty, dupes
		const pick = (blockId: `blk-${string}`, fields: string[]): SpecOp => ({
			op: 'page.setBlockFields',
			args: { pageId: 'pg-invoices', blockId, fields },
		})
		expect(validateOp(s, pick('blk-table', ['nope']))).toContain(
			'page.setBlockFields: field "nope" is not a field of "e-invoice"',
		)
		expect(validateOp(s, pick('blk-hero', ['total']))[0]).toMatch(
			/not a list\/table block/,
		)
		expect(validateOp(s, pick('blk-missing', ['total']))).toContain(
			'page.setBlockFields: no block "blk-missing" in "pg-invoices"',
		)
		expect(validateOp(s, pick('blk-table', []))[0]).toMatch(/non-empty array/)
		expect(validateOp(s, pick('blk-table', ['total', 'total']))[0]).toMatch(
			/duplicate field "total"/,
		)
	})

	it('setBlockFields survives an op-log round trip (a `set` op keeps its payload)', () => {
		let s = applyOp(base(), entity, meta(1))
		s = applyOp(
			s,
			{
				op: 'page.addPage',
				args: {
					page: {
						id: 'pg-invoices',
						name: 'Invoices',
						route: '/invoices',
						entityId: 'e-invoice',
						blocks: [
							{ id: 'blk-table', type: 'table', provenance: suggested() },
						],
						provenance: suggested(),
					},
				},
			},
			meta(2),
		)
		const fields = ['total']
		s = applyOp(
			s,
			{
				op: 'page.setBlockFields',
				args: { pageId: 'pg-invoices', blockId: 'blk-table', fields },
			},
			meta(3),
		)
		// The op's array is copied into state, never aliased.
		fields.push('mutated')
		expect(s.pages.pages[0]?.blocks[0]?.fields).toEqual(['total'])
	})
})

/**
 * Shared by the two blocks below — `page.setBlockEditable` and
 * `page.setBlockCreatable` apply the same field rule, so they are tested
 * against the same entity. A second fixture would be the place the two
 * silently diverge.
 */
/** An entity with one field of every shape the rule has an opinion about. */
const CARD_ENTITY: SpecOp = {
	op: 'data.addEntity',
	args: {
		entity: {
			id: 'e-card',
			name: 'Card',
			fields: [
				{
					id: 'fld-title',
					name: 'title',
					type: 'string',
					required: true,
					provenance: suggested(),
				},
				{
					id: 'fld-status',
					name: 'status',
					type: 'enum',
					required: false,
					options: [
						{ label: 'To do', value: 'todo' },
						{ label: 'Done', value: 'done' },
					],
					provenance: suggested(),
				},
				{
					id: 'fld-rank',
					name: 'boardRank',
					type: 'string',
					required: false,
					rank: true,
					provenance: suggested(),
				},
				{
					id: 'fld-payload',
					name: 'payload',
					type: 'json',
					required: false,
					provenance: suggested(),
				},
			],
			provenance: suggested(),
		},
	},
}

const CARDS_PAGE: SpecOp = {
	op: 'page.addPage',
	args: {
		page: {
			id: 'pg-cards',
			name: 'Cards',
			route: '/cards',
			entityId: 'e-card',
			blocks: [
				{ id: 'blk-table', type: 'table', provenance: suggested() },
				{ id: 'blk-hero', type: 'hero', provenance: suggested() },
			],
			provenance: suggested(),
		},
	},
}

describe('inline editing — page.setBlockEditable', () => {
	const seeded = () =>
		applyOp(applyOp(base(), CARD_ENTITY, meta(1)), CARDS_PAGE, meta(2))

	const editable = (blockId: `blk-${string}`, names: string[]): SpecOp => ({
		op: 'page.setBlockEditable',
		args: { pageId: 'pg-cards', blockId, editable: names },
	})

	it('declares which cells edit in place, logged as a `set`', () => {
		let s = seeded()
		s = applyOp(s, editable('blk-table', ['title', 'status']), meta(3))
		expect(s.pages.pages[0]?.blocks[0]?.editable).toEqual(['title', 'status'])
		const last = s.opLog.at(-1)
		expect(last?.diff.change).toBe('set')
		expect(last?.diff.layer).toBe('page')
		expect(last?.diff.summary).toContain('title, status')
		expect(validateSpecSystem(s)).toBe(s)
	})

	it('is last-wins, and `[]` takes the capability back', () => {
		// A capability that can only ever be widened is one nobody can withdraw
		// after a review says it was a mistake.
		let s = applyOp(
			seeded(),
			editable('blk-table', ['title', 'status']),
			meta(3),
		)
		s = applyOp(s, editable('blk-table', ['title']), meta(4))
		expect(s.pages.pages[0]?.blocks[0]?.editable).toEqual(['title'])
		expect(validateOp(s, editable('blk-table', []))).toEqual([])
		s = applyOp(s, editable('blk-table', []), meta(5))
		expect(s.pages.pages[0]?.blocks[0]?.editable).toEqual([])
		expect(s.opLog.at(-1)?.diff.summary).toMatch(/Stop editing any cell/)
	})

	it('refuses a field no cell editor can represent', () => {
		// Each of these would render an editor that silently corrupts the value on
		// the first blur, so the refusal is at op time where a reviewer sees it.
		const s = seeded()
		expect(validateOp(s, editable('blk-table', ['boardRank']))[0]).toMatch(
			/is a rank key/,
		)
		expect(validateOp(s, editable('blk-table', ['payload']))[0]).toMatch(
			/is json/,
		)
	})

	it('refuses a reference, an unknown field, a non-table block and a duplicate', () => {
		let s = seeded()
		s = applyOp(
			s,
			{
				op: 'data.addField',
				args: {
					entityId: 'e-card',
					field: {
						id: 'fld-author',
						name: 'author',
						type: 'string',
						required: false,
						reference: 'e-card',
						provenance: suggested(),
					},
				},
			},
			meta(3),
		)
		expect(validateOp(s, editable('blk-table', ['author']))[0]).toMatch(
			/is a reference/,
		)
		expect(validateOp(s, editable('blk-table', ['nope']))).toContain(
			'page.setBlockEditable: field "nope" is not a field of "e-card"',
		)
		expect(validateOp(s, editable('blk-hero', ['title']))[0]).toMatch(
			/not a list\/table block/,
		)
		expect(validateOp(s, editable('blk-missing', ['title']))).toContain(
			'page.setBlockEditable: no block "blk-missing" in "pg-cards"',
		)
		expect(validateOp(s, editable('blk-table', ['title', 'title']))[0]).toMatch(
			/duplicate field "title"/,
		)
	})

	it('refuses the same declaration inline, at the page that declared it', () => {
		// The inline form must not be the way to dodge the set-op's validation.
		const s = applyOp(base(), CARD_ENTITY, meta(1))
		const inline = (names: string[]): SpecOp => ({
			op: 'page.addPage',
			args: {
				page: {
					id: 'pg-inline',
					name: 'Inline',
					route: '/inline',
					entityId: 'e-card',
					blocks: [
						{
							id: 'blk-table',
							type: 'table',
							editable: names,
							provenance: suggested(),
						},
					],
					provenance: suggested(),
				},
			},
		})
		expect(validateOp(s, inline(['title']))).toEqual([])
		expect(validateOp(s, inline(['payload']))[0]).toMatch(/is json/)
		expect(validateOp(s, inline(['nope']))[0]).toMatch(/is not a field/)
		expect(validateOp(s, inline(['title', 'title']))[0]).toMatch(
			/duplicate editable field/,
		)
	})

	it('copies the array into state rather than aliasing the op', () => {
		const names = ['title']
		const s = applyOp(seeded(), editable('blk-table', names), meta(3))
		names.push('mutated')
		expect(s.pages.pages[0]?.blocks[0]?.editable).toEqual(['title'])
	})
})

/**
 * #444 — adding a row from the list, the one part of stage C that did not exist.
 *
 * The sibling of the block above, sharing its `e-card` fixture on purpose: the
 * *field* rule is the same rule, and a test suite that restated it would be the
 * place the two silently diverge. What is tested here is the difference —
 * completeness. `title` is the fixture's one required field, which makes every
 * one of these cases about whether the declaration could ever produce a record
 * the server accepts.
 */
describe('adding a row from the list — page.setBlockCreatable', () => {
	const seeded = () =>
		applyOp(applyOp(base(), CARD_ENTITY, meta(1)), CARDS_PAGE, meta(2))

	const creatable = (blockId: `blk-${string}`, names: string[]): SpecOp => ({
		op: 'page.setBlockCreatable',
		args: { pageId: 'pg-cards', blockId, creatable: names },
	})

	it('declares which fields a new row collects, logged as a `set`', () => {
		let s = seeded()
		s = applyOp(s, creatable('blk-table', ['title', 'status']), meta(3))
		expect(s.pages.pages[0]?.blocks[0]?.creatable).toEqual(['title', 'status'])
		const last = s.opLog.at(-1)
		expect(last?.diff.change).toBe('set')
		expect(last?.diff.layer).toBe('page')
		expect(last?.diff.summary).toContain('title, status')
		expect(validateSpecSystem(s)).toBe(s)
	})

	it('refuses a declaration that omits a required field, by name', () => {
		// The rule with no analogue in `editable`, and the reason this op exists
		// separately: a new row must satisfy every constraint at once, so a
		// `creatable` without `title` describes an affordance whose every use is a
		// 422 — with no input that makes it work. Refused where a reviewer sees it,
		// not discovered by somebody clicking Add on a generated page.
		const s = seeded()
		const errors = validateOp(s, creatable('blk-table', ['status']))
		expect(errors[0]).toMatch(/field "title" is required by "e-card"/)
		expect(errors[0]).toMatch(/name it in creatable/)
	})

	it('accepts the same declaration once the required field is named', () => {
		expect(validateOp(seeded(), creatable('blk-table', ['title']))).toEqual([])
	})

	it('says an entity cannot be added to from a list at all, in one sentence', () => {
		// A required field that is also uncollectable is not two problems. The two
		// rules together mean there is no `creatable` for this entity, and saying
		// that is more use than a pair of instructions that contradict each other.
		let s = seeded()
		s = applyOp(
			s,
			{
				op: 'data.addField',
				args: {
					entityId: 'e-card',
					field: {
						id: 'fld-owner',
						name: 'owner',
						type: 'string',
						required: true,
						reference: 'e-card',
						provenance: suggested(),
					},
				},
			},
			meta(3),
		)
		const errors = validateOp(s, creatable('blk-table', ['title']))
		expect(errors[0]).toMatch(/field "owner" is required and is a reference/)
		expect(errors[0]).toMatch(/cannot be added to "e-card" from a list at all/)
	})

	it('refuses a field no row form can collect', () => {
		const s = seeded()
		expect(
			validateOp(s, creatable('blk-table', ['title', 'payload']))[0],
		).toMatch(/is json/)
		expect(
			validateOp(s, creatable('blk-table', ['title', 'boardRank']))[0],
		).toMatch(/is a rank key/)
	})

	it('refuses an unknown field, a non-table block, a missing block and a duplicate', () => {
		const s = seeded()
		expect(validateOp(s, creatable('blk-table', ['title', 'nope']))).toContain(
			'page.setBlockCreatable: field "nope" is not a field of "e-card"',
		)
		expect(validateOp(s, creatable('blk-hero', ['title']))[0]).toMatch(
			/not a list\/table block/,
		)
		expect(validateOp(s, creatable('blk-missing', ['title']))).toContain(
			'page.setBlockCreatable: no block "blk-missing" in "pg-cards"',
		)
		expect(
			validateOp(s, creatable('blk-table', ['title', 'title']))[0],
		).toMatch(/duplicate field "title"/)
	})

	it('is last-wins, and `[]` takes the capability back', () => {
		let s = applyOp(seeded(), creatable('blk-table', ['title']), meta(3))
		s = applyOp(s, creatable('blk-table', ['title', 'status']), meta(4))
		expect(s.pages.pages[0]?.blocks[0]?.creatable).toEqual(['title', 'status'])
		// `[]` is the clear, and it needs no completeness check to be meaningful —
		// a list nobody can add to omits every required field by definition.
		expect(validateOp(s, creatable('blk-table', []))).toEqual([])
		s = applyOp(s, creatable('blk-table', []), meta(5))
		expect(s.pages.pages[0]?.blocks[0]?.creatable).toEqual([])
		expect(s.opLog.at(-1)?.diff.summary).toMatch(/Stop adding rows/)
	})

	it('refuses the same declaration inline, at the page that declared it', () => {
		// Including the completeness rule: the inline form must not be the way to
		// declare an affordance the set-op would have refused.
		const s = applyOp(base(), CARD_ENTITY, meta(1))
		const inline = (names: string[]): SpecOp => ({
			op: 'page.addPage',
			args: {
				page: {
					id: 'pg-inline-create',
					name: 'Inline',
					route: '/inline-create',
					entityId: 'e-card',
					blocks: [
						{
							id: 'blk-table',
							type: 'table',
							creatable: names,
							provenance: suggested(),
						},
					],
					provenance: suggested(),
				},
			},
		})
		expect(validateOp(s, inline(['title']))).toEqual([])
		expect(validateOp(s, inline(['status']))[0]).toMatch(
			/creatable "title" is required by "e-card"/,
		)
		expect(validateOp(s, inline(['title', 'payload']))[0]).toMatch(/is json/)
		expect(validateOp(s, inline(['title', 'title']))[0]).toMatch(
			/duplicate creatable field/,
		)
	})

	it('copies the array into state rather than aliasing the op', () => {
		const names = ['title']
		const s = applyOp(seeded(), creatable('blk-table', names), meta(3))
		names.push('mutated')
		expect(s.pages.pages[0]?.blocks[0]?.creatable).toEqual(['title'])
	})
})

describe('date-arranged views — page.addCalendar / page.addTimeline', () => {
	/** An entity with the columns a calendar and a timeline both need. */
	const scheduled: SpecOp = {
		op: 'data.addEntity',
		args: {
			entity: {
				id: 'e-task',
				name: 'Task',
				fields: [
					{
						id: 'fld-title',
						name: 'title',
						type: 'string',
						required: true,
						provenance: suggested(),
					},
					{
						id: 'fld-start',
						name: 'startDate',
						type: 'date',
						required: false,
						provenance: suggested(),
					},
					{
						id: 'fld-due',
						name: 'dueDate',
						type: 'date',
						required: false,
						provenance: suggested(),
					},
					{
						id: 'fld-owner',
						name: 'owner',
						type: 'string',
						required: false,
						provenance: suggested(),
					},
					{
						id: 'fld-blocked-by',
						name: 'blockedBy',
						type: 'string',
						required: false,
						reference: 'e-task',
						provenance: suggested(),
					},
				],
				provenance: suggested(),
			},
		},
	}

	const page: SpecOp = {
		op: 'page.addPage',
		args: {
			page: {
				id: 'pg-tasks',
				name: 'Tasks',
				route: '/tasks',
				entityId: 'e-task',
				blocks: [{ id: 'blk-table', type: 'table', provenance: suggested() }],
				provenance: suggested(),
			},
		},
	}

	/** A page with no backing entity — nothing to arrange by a date. */
	const orphanPage: SpecOp = {
		op: 'page.addPage',
		args: {
			page: {
				id: 'pg-about',
				name: 'About',
				route: '/about',
				blocks: [],
				provenance: suggested(),
			},
		},
	}

	const grounded = (): SpecSystem => {
		let s = applyOp(base(), scheduled, meta(1))
		s = applyOp(s, page, meta(2))
		return applyOp(s, orphanPage, meta(3))
	}

	const calendar = (
		calendarArgs: Partial<
			Extract<SpecOp, { op: 'page.addCalendar' }>['args']['calendar']
		> = {},
		blockId: `blk-${string}` = 'blk-cal',
		pageId: `pg-${string}` = 'pg-tasks',
	): SpecOp => ({
		op: 'page.addCalendar',
		args: {
			pageId,
			blockId,
			calendar: {
				dateField: 'dueDate',
				display: 'month',
				timezone: 'America/New_York',
				...calendarArgs,
			},
		},
	})

	const timeline = (
		timelineArgs: Partial<
			Extract<SpecOp, { op: 'page.addTimeline' }>['args']['timeline']
		> = {},
		blockId: `blk-${string}` = 'blk-gantt',
	): SpecOp => ({
		op: 'page.addTimeline',
		args: {
			pageId: 'pg-tasks',
			blockId,
			timeline: {
				startField: 'startDate',
				endField: 'dueDate',
				timezone: 'America/New_York',
				...timelineArgs,
			},
		},
	})

	it('adds a calendar block carrying its date field, display and timezone', () => {
		const s = applyOp(
			grounded(),
			calendar({ display: 'week', titleField: 'title', reschedule: true }),
			meta(4),
		)
		const block = s.pages.pages[0]?.blocks[1]
		expect(block?.type).toBe('calendar')
		expect(block?.calendar).toEqual({
			dateField: 'dueDate',
			display: 'week',
			timezone: 'America/New_York',
			titleField: 'title',
			reschedule: true,
		})
		expect(validateSpecSystem(s)).toBe(s)
		const last = s.opLog.at(-1)
		expect(last?.diff.change).toBe('add')
		expect(last?.diff.parentId).toBe('pg-tasks')
		expect(last?.diff.summary).toContain('America/New_York')
	})

	it('adds a timeline block with dependency edges from a self-reference', () => {
		const s = applyOp(
			grounded(),
			timeline({ dependsOn: 'blockedBy', titleField: 'title' }),
			meta(4),
		)
		expect(s.pages.pages[0]?.blocks[1]?.timeline).toEqual({
			startField: 'startDate',
			endField: 'dueDate',
			timezone: 'America/New_York',
			dependsOn: 'blockedBy',
			titleField: 'title',
		})
		expect(validateSpecSystem(s)).toBe(s)
		expect(s.opLog.at(-1)?.diff.summary).toContain('edges via blockedBy')
	})

	it('refuses a view whose columns are not dates — the render-time failure, moved to op time', () => {
		const s = grounded()
		expect(validateOp(s, calendar({ dateField: 'owner' }))[0]).toMatch(
			/dateField "owner" is type "string", not "date"/,
		)
		expect(validateOp(s, calendar({ dateField: 'nope' }))).toContain(
			'page.addCalendar: dateField "nope" is not a field of "e-task"',
		)
		expect(validateOp(s, timeline({ endField: 'title' }))[0]).toMatch(
			/endField "title" is type "string", not "date"/,
		)
		expect(validateOp(s, calendar({ titleField: 'nope' }))).toContain(
			'page.addCalendar: titleField "nope" is not a field of "e-task"',
		)
	})

	it('refuses an undeclared timezone rather than silently reading dates in UTC', () => {
		expect(
			validateOp(grounded(), calendar({ timezone: 'Mars/Olympus_Mons' }))[0],
		).toMatch(/unknown timezone "Mars\/Olympus_Mons"/)
	})

	it('refuses a rescheduable heatmap — a density cell is not an entry to move', () => {
		expect(
			validateOp(
				grounded(),
				calendar({ display: 'heatmap', reschedule: true }),
			)[0],
		).toMatch(/cannot be rescheduled/)
		// The same heatmap without the write is fine.
		expect(validateOp(grounded(), calendar({ display: 'heatmap' }))).toEqual([])
	})

	it('refuses a dependency edge that is not a self-reference', () => {
		const s = grounded()
		expect(validateOp(s, timeline({ dependsOn: 'owner' }))[0]).toMatch(
			/not a reference field/,
		)
		expect(validateOp(s, timeline({ dependsOn: 'nope' }))).toContain(
			'page.addTimeline: dependsOn "nope" is not a field of "e-task"',
		)
	})

	it('refuses a degenerate range, an unknown display, a duplicate block, and a page with no entity', () => {
		const s = grounded()
		expect(validateOp(s, calendar({ endField: 'dueDate' }))[0]).toMatch(
			/same field as dateField/,
		)
		expect(validateOp(s, timeline({ endField: 'startDate' }))[0]).toMatch(
			/a bar needs two ends/,
		)
		expect(
			validateOp(s, calendar({ display: 'agenda' as 'month' }))[0],
		).toMatch(/unknown display "agenda"/)
		expect(validateOp(s, calendar({}, 'blk-table'))).toContain(
			'page.addCalendar: duplicate block id "blk-table"',
		)
		expect(validateOp(s, calendar({}, 'blk-cal', 'pg-about'))).toContain(
			'page.addCalendar: page "pg-about" has no backing entity whose rows could be arranged',
		)
		expect(validateOp(s, calendar({}, 'blk-cal', 'pg-nope'))).toContain(
			'page.addCalendar: unknown page "pg-nope"',
		)
	})

	// Issue #314 — the same backing-entity check the view ops run has to run on
	// `page.addPage`'s own inline blocks, or the refusal lands on the next op and
	// the agent is told to fix args that were correct.
	it('refuses an inline block that names fields on a page with no entity', () => {
		const s = grounded()
		const inline = (block: Record<string, unknown>): SpecOp => ({
			op: 'page.addPage',
			args: {
				page: {
					id: 'pg-shelf',
					name: 'Shelf',
					route: '/shelf',
					blocks: [{ id: 'blk-shelf', ...block }],
					provenance: suggested(),
				},
			} as never,
		})
		const errors = validateOp(
			s,
			inline({
				type: 'table',
				order: { field: 'finishedOn', direction: 'desc' },
			}),
		)
		expect(errors.join(' ')).toMatch(/"finishedOn"/)
		expect(errors.join(' ')).toMatch(/declares no "entityId"/)
		// Same for a field list, and for a presentation key on a block type the
		// runtime would silently ignore.
		expect(validateOp(s, inline({ type: 'table', fields: ['nope'] }))).toEqual([
			expect.stringContaining('declares no "entityId"'),
		])
		expect(
			validateOp(s, inline({ type: 'hero', order: { field: 'x' } })).join(' '),
		).toMatch(/not an orderable list\/table block/)
	})

	it('checks an inline block’s field names against the page’s own entity', () => {
		const s = grounded()
		const withEntity = (block: Record<string, unknown>): SpecOp => ({
			op: 'page.addPage',
			args: {
				page: {
					id: 'pg-two',
					name: 'Two',
					route: '/two',
					entityId: 'e-task',
					blocks: [{ id: 'blk-two', ...block }],
					provenance: suggested(),
				},
			} as never,
		})
		expect(
			validateOp(s, withEntity({ type: 'table', order: { field: 'nope' } })),
		).toEqual([expect.stringContaining('"nope" is not a field of "e-task"')])
		// A correct one still lands.
		expect(
			validateOp(
				s,
				withEntity({
					type: 'table',
					variant: 'cards',
					order: { field: 'dueDate', direction: 'desc' },
					fields: ['dueDate', 'owner'],
				}),
			),
		).toEqual([])
	})

	it('round-trips a view block through the spec directory codec', () => {
		const s = applyOp(
			applyOp(grounded(), calendar({ reschedule: true }), meta(4)),
			timeline({ dependsOn: 'blockedBy' }),
			meta(5),
		)
		const blocks = decodeSpecSystem(encodeSpecSystem(s)).pages.pages[0]?.blocks
		expect(blocks?.[1]?.calendar).toEqual(s.pages.pages[0]?.blocks[1]?.calendar)
		expect(blocks?.[2]?.timeline).toEqual(s.pages.pages[0]?.blocks[2]?.timeline)
	})
})

describe('board views — page.addBoard + data.setFieldLimits', () => {
	/**
	 * The entity a board needs: an enum with declared options (its columns), a
	 * rank key (the order inside one), and a plain string field to prove the type
	 * checks are real.
	 */
	const tracker: SpecOp = {
		op: 'data.addEntity',
		args: {
			entity: {
				id: 'e-issue',
				name: 'Issue',
				fields: [
					{
						id: 'fld-title',
						name: 'title',
						type: 'string',
						required: true,
						provenance: suggested(),
					},
					{
						id: 'fld-status',
						name: 'status',
						type: 'enum',
						required: true,
						options: ['todo', 'doing', 'done'],
						provenance: suggested(),
					},
					{
						id: 'fld-loose',
						name: 'looseStatus',
						type: 'enum',
						required: false,
						provenance: suggested(),
					},
					{
						id: 'fld-rank',
						name: 'boardRank',
						type: 'string',
						required: false,
						rank: true,
						provenance: suggested(),
					},
					{
						id: 'fld-owner',
						name: 'owner',
						type: 'string',
						required: false,
						provenance: suggested(),
					},
				],
				provenance: suggested(),
			},
		},
	}

	const page: SpecOp = {
		op: 'page.addPage',
		args: {
			page: {
				id: 'pg-issues',
				name: 'Issues',
				route: '/issues',
				entityId: 'e-issue',
				blocks: [{ id: 'blk-table', type: 'table', provenance: suggested() }],
				provenance: suggested(),
			},
		},
	}

	const grounded = (): SpecSystem =>
		applyOp(applyOp(base(), tracker, meta(1)), page, meta(2))

	const board = (
		boardArgs: Partial<
			Extract<SpecOp, { op: 'page.addBoard' }>['args']['board']
		> = {},
		blockId: `blk-${string}` = 'blk-board',
		pageId: `pg-${string}` = 'pg-issues',
	): SpecOp => ({
		op: 'page.addBoard',
		args: {
			pageId,
			blockId,
			board: { groupField: 'status', ...boardArgs },
		},
	})

	const limits = (
		values: Record<string, number>,
		fieldId: `fld-${string}` = 'fld-status',
	): SpecOp => ({
		op: 'data.setFieldLimits',
		args: { entityId: 'e-issue', fieldId, limits: values },
	})

	it('adds a board block carrying its grouping column, rank key and card fields', () => {
		const s = applyOp(
			grounded(),
			board({
				rankField: 'boardRank',
				titleField: 'title',
				cardFields: ['owner'],
				move: true,
			}),
			meta(3),
		)
		const block = s.pages.pages[0]?.blocks[1]
		expect(block?.type).toBe('board')
		expect(block?.board).toEqual({
			groupField: 'status',
			rankField: 'boardRank',
			titleField: 'title',
			cardFields: ['owner'],
			move: true,
		})
		expect(validateSpecSystem(s)).toBe(s)
		const last = s.opLog.at(-1)
		expect(last?.diff.change).toBe('add')
		expect(last?.diff.parentId).toBe('pg-issues')
		expect(last?.diff.summary).toContain('grouped by status')
		expect(last?.diff.summary).toContain('ranked by boardRank')
	})

	it('refuses a grouping column that is not an enum with declared options', () => {
		const s = grounded()
		expect(validateOp(s, board({ groupField: 'owner' }))[0]).toMatch(
			/groupField "owner" is type "string", not "enum"/,
		)
		expect(validateOp(s, board({ groupField: 'nope' }))).toContain(
			'page.addBoard: groupField "nope" is not a field of "e-issue"',
		)
		// An enum with no options grounds to a permissive text column, so its
		// "columns" would be whatever values happen to be in the table today.
		expect(validateOp(s, board({ groupField: 'looseStatus' }))[0]).toMatch(
			/has no declared options, so the board has no columns/,
		)
	})

	it('refuses a rank column that anyone could type into', () => {
		const s = grounded()
		expect(validateOp(s, board({ rankField: 'owner' }))[0]).toMatch(
			/is not declared rank:true/,
		)
		expect(validateOp(s, board({ rankField: 'nope' }))).toContain(
			'page.addBoard: rankField "nope" is not a field of "e-issue"',
		)
	})

	it('refuses card fields that do not exist, repeat, or are the rank key itself', () => {
		const s = grounded()
		expect(validateOp(s, board({ cardFields: ['nope'] }))).toContain(
			'page.addBoard: cardFields entry "nope" is not a field of "e-issue"',
		)
		expect(validateOp(s, board({ cardFields: ['owner', 'owner'] }))[0]).toMatch(
			/duplicate cardFields entry "owner"/,
		)
		expect(
			validateOp(
				s,
				board({ rankField: 'boardRank', cardFields: ['boardRank'] }),
			)[0],
		).toMatch(/a rank key is an opaque sort key/)
	})

	it('refuses a duplicate block id and a page with nothing to group', () => {
		const s = grounded()
		expect(validateOp(s, board({}, 'blk-table'))).toContain(
			'page.addBoard: duplicate block id "blk-table"',
		)
		expect(validateOp(s, board({}, 'blk-board', 'pg-nope'))).toContain(
			'page.addBoard: unknown page "pg-nope"',
		)
	})

	it('refuses a rank flag on anything that is not a plain optional string', () => {
		const bad = (
			field: Partial<{
				id: string
				name: string
				type: string
				required: boolean
			}>,
		): SpecOp =>
			({
				op: 'data.addField',
				args: {
					entityId: 'e-issue',
					field: {
						id: 'fld-x',
						name: 'x',
						type: 'string',
						required: false,
						rank: true,
						provenance: suggested(),
						...field,
					},
				},
			}) as SpecOp
		const s = grounded()
		expect(validateOp(s, bad({ type: 'number' }))[0]).toMatch(
			/only a "string" field may be a rank key/,
		)
		expect(validateOp(s, bad({ required: true }))[0]).toMatch(
			/a rank key cannot be required/,
		)
		expect(validateOp(s, bad({}))).toEqual([])
	})

	// -------------------------------------------------------------------------
	// WIP limits. The point of declaring them on the FIELD is that they bind
	// every writer; these assertions cover the declaration, and
	// `operations.test.ts` covers the enforcement (including over REST).
	// -------------------------------------------------------------------------

	it('sets per-value caps on the grouping column, last-wins', () => {
		const s1 = applyOp(grounded(), limits({ doing: 3 }), meta(3))
		const field = s1.data.entities[0]?.fields[1]
		expect(field?.limits).toEqual({ doing: 3 })
		expect(validateSpecSystem(s1)).toBe(s1)
		expect(s1.opLog.at(-1)?.diff).toMatchObject({
			change: 'set',
			targetId: 'fld-status',
			parentId: 'e-issue',
		})
		expect(s1.opLog.at(-1)?.diff.summary).toContain('3 doing')

		// Raising a limit is the edit a team actually makes, so it is one op and
		// it replaces rather than merges.
		const s2 = applyOp(s1, limits({ doing: 4 }), meta(4))
		expect(s2.data.entities[0]?.fields[1]?.limits).toEqual({ doing: 4 })
	})

	it('clears every cap with an empty map, leaving no trace of a half-limit', () => {
		const s = applyOp(
			applyOp(grounded(), limits({ doing: 3 }), meta(3)),
			limits({}),
			meta(4),
		)
		expect(s.data.entities[0]?.fields[1]).not.toHaveProperty('limits')
		expect(s.opLog.at(-1)?.diff.summary).toContain('Clear value limits')
	})

	it('refuses a cap on a value the column cannot hold, or a nonsense cap', () => {
		const s = grounded()
		expect(validateOp(s, limits({ blocked: 3 }))[0]).toMatch(
			/limit on "blocked", which is not one of the declared options/,
		)
		expect(validateOp(s, limits({ doing: 0 }))[0]).toMatch(
			/must be a positive integer/,
		)
		expect(validateOp(s, limits({ doing: 1.5 }))[0]).toMatch(
			/must be a positive integer/,
		)
		expect(validateOp(s, limits({ doing: 10_001 }))[0]).toMatch(
			/above the 10000 ceiling/,
		)
		expect(validateOp(s, limits({ doing: 3 }, 'fld-owner'))[0]).toMatch(
			/only an "enum" field may declare value limits/,
		)
		expect(validateOp(s, limits({ doing: 3 }, 'fld-loose'))[0]).toMatch(
			/has no declared options, so there are no values to cap/,
		)
		expect(validateOp(s, limits({ doing: 3 }, 'fld-nope'))).toContain(
			'data.setFieldLimits: unknown field "fld-nope" on e-issue',
		)
	})

	it('round-trips a board block and its limits through the spec directory codec', () => {
		const s = applyOp(
			applyOp(
				grounded(),
				board({ rankField: 'boardRank', cardFields: ['owner'], move: true }),
				meta(3),
			),
			limits({ doing: 2 }),
			meta(4),
		)
		const decoded = decodeSpecSystem(encodeSpecSystem(s))
		expect(decoded.pages.pages[0]?.blocks[1]?.board).toEqual(
			s.pages.pages[0]?.blocks[1]?.board,
		)
		expect(decoded.data.entities[0]?.fields[1]?.limits).toEqual({ doing: 2 })
		expect(decoded.data.entities[0]?.fields[3]?.rank).toBe(true)
	})
})

describe('aggregate views — page.addAggregate (#299)', () => {
	/**
	 * The entity a dashboard tile needs: a dimension with options, a boolean and
	 * a date to prove the other two group types, a number to measure, and a
	 * string + json to prove the refusals are real.
	 */
	const tracker: SpecOp = {
		op: 'data.addEntity',
		args: {
			entity: {
				id: 'e-deal',
				name: 'Deal',
				fields: [
					{
						id: 'fld-name',
						name: 'name',
						type: 'string',
						required: true,
						provenance: suggested(),
					},
					{
						id: 'fld-stage',
						name: 'stage',
						type: 'enum',
						required: true,
						options: ['lead', 'won'],
						provenance: suggested(),
					},
					{
						id: 'fld-won',
						name: 'isWon',
						type: 'boolean',
						required: false,
						provenance: suggested(),
					},
					{
						id: 'fld-closed',
						name: 'closedOn',
						type: 'date',
						required: false,
						provenance: suggested(),
					},
					{
						id: 'fld-amount',
						name: 'amount',
						type: 'number',
						required: false,
						provenance: suggested(),
					},
					{
						id: 'fld-notes',
						name: 'notes',
						type: 'json',
						required: false,
						provenance: suggested(),
					},
				],
				provenance: suggested(),
			},
		},
	}

	const page: SpecOp = {
		op: 'page.addPage',
		args: {
			page: {
				id: 'pg-deals',
				name: 'Deals',
				route: '/deals',
				entityId: 'e-deal',
				blocks: [{ id: 'blk-table', type: 'table', provenance: suggested() }],
				provenance: suggested(),
			},
		},
	}

	const grounded = (): SpecSystem =>
		applyOp(applyOp(base(), tracker, meta(1)), page, meta(2))

	const agg = (
		args: Partial<
			Extract<SpecOp, { op: 'page.addAggregate' }>['args']['aggregate']
		> = {},
		blockId: `blk-${string}` = 'blk-agg',
		pageId: `pg-${string}` = 'pg-deals',
	): SpecOp => ({
		op: 'page.addAggregate',
		args: {
			pageId,
			blockId,
			aggregate: { groupField: 'stage', fn: 'count', ...args },
		},
	})

	it('adds an aggregate block carrying its dimension, measure and filter', () => {
		const s = applyOp(
			grounded(),
			agg({
				fn: 'sum',
				measureField: 'amount',
				where: [{ field: 'isWon', equals: true }],
				display: 'bar',
				limit: 5,
			}),
			meta(3),
		)
		const block = s.pages.pages[0]?.blocks[1]
		expect(block?.type).toBe('aggregate')
		expect(block?.aggregate).toEqual({
			groupField: 'stage',
			fn: 'sum',
			measureField: 'amount',
			where: [{ field: 'isWon', equals: true }],
			display: 'bar',
			limit: 5,
		})
		expect(validateSpecSystem(s)).toBe(s)
		const last = s.opLog.at(-1)
		expect(last?.diff.change).toBe('add')
		expect(last?.diff.parentId).toBe('pg-deals')
		expect(last?.diff.summary).toContain('sum(amount) grouped by stage')
	})

	it('accepts the three shapes a dashboard is actually made of', () => {
		const s = grounded()
		expect(validateOp(s, agg())).toEqual([])
		expect(validateOp(s, agg({ groupField: 'isWon' }))).toEqual([])
		expect(
			validateOp(s, agg({ groupField: 'closedOn', bucket: 'month' })),
		).toEqual([])
		expect(validateOp(s, agg({ fn: 'avg', measureField: 'amount' }))).toEqual(
			[],
		)
	})

	// The vocabulary decision this op turns on: a GROUP BY over free text has
	// unbounded cardinality, so the block's cost becomes a property of the data
	// rather than of the declaration. Refused rather than capped.
	it('refuses a grouping column that is not a dimension', () => {
		const s = grounded()
		expect(validateOp(s, agg({ groupField: 'name' }))[0]).toMatch(
			/is type "string" — an aggregate groups by a dimension/,
		)
		expect(validateOp(s, agg({ groupField: 'amount' }))[0]).toMatch(
			/an aggregate groups by a dimension/,
		)
		expect(validateOp(s, agg({ groupField: 'nope' }))).toContain(
			'page.addAggregate: groupField "nope" is not a field of "e-deal"',
		)
	})

	it('requires a bucket on a date and refuses one anywhere else', () => {
		const s = grounded()
		expect(validateOp(s, agg({ groupField: 'closedOn' }))[0]).toMatch(
			/is a date, so it needs a "bucket"/,
		)
		expect(
			validateOp(
				s,
				agg({ groupField: 'closedOn', bucket: 'century' as never }),
			)[0],
		).toMatch(/unknown bucket "century"/)
		expect(validateOp(s, agg({ bucket: 'month' }))[0]).toMatch(
			/not a date — only a date column has periods to truncate/,
		)
	})

	it('pairs the aggregate function with the column it needs, or refuses', () => {
		const s = grounded()
		expect(validateOp(s, agg({ fn: 'sum' }))[0]).toMatch(
			/needs a "measureField"/,
		)
		// A measureField under `count` would be silently ignored at read time,
		// which is the same failure a variant on a non-list block is refused for.
		expect(validateOp(s, agg({ measureField: 'amount' }))[0]).toMatch(
			/counts rows and has no column/,
		)
		expect(validateOp(s, agg({ fn: 'sum', measureField: 'name' }))[0]).toMatch(
			/needs a numeric column, but measureField "name" is type "string"/,
		)
		expect(validateOp(s, agg({ fn: 'max', measureField: 'notes' }))[0]).toMatch(
			/has no order and no total to aggregate/,
		)
		expect(validateOp(s, agg({ fn: 'median' as never }))[0]).toMatch(
			/unknown fn "median"/,
		)
	})

	it('resolves every where clause against the entity', () => {
		const s = grounded()
		expect(
			validateOp(s, agg({ where: [{ field: 'nope', equals: 1 }] })),
		).toContain(
			'page.addAggregate: where[0].field "nope" is not a field of "e-deal"',
		)
		expect(
			validateOp(
				s,
				agg({ where: [{ field: 'stage', equals: {} as never }] }),
			)[0],
		).toMatch(/must be a string, number, boolean or null/)
		// `null` is a legitimate comparand — it tests IS NULL.
		expect(
			validateOp(s, agg({ where: [{ field: 'stage', equals: null }] })),
		).toEqual([])
	})

	it('refuses a display and a bucket count it cannot honestly draw', () => {
		const s = grounded()
		expect(validateOp(s, agg({ display: 'pie' as never }))[0]).toMatch(
			/unknown display "pie"/,
		)
		expect(validateOp(s, agg({ limit: 0 }))[0]).toMatch(
			/must be a positive whole number of buckets/,
		)
		expect(validateOp(s, agg({ limit: 999 }))[0]).toMatch(
			/exceeds the cap of 50 buckets/,
		)
	})

	it('refuses a duplicate block id and a page with nothing to aggregate', () => {
		const s = grounded()
		expect(validateOp(s, agg({}, 'blk-table'))).toContain(
			'page.addAggregate: duplicate block id "blk-table"',
		)
		expect(validateOp(s, agg({}, 'blk-agg', 'pg-nope'))).toContain(
			'page.addAggregate: unknown page "pg-nope"',
		)
	})

	it('rides through the codec, where clauses and all', () => {
		const s = applyOp(
			grounded(),
			agg({
				fn: 'avg',
				measureField: 'amount',
				where: [{ field: 'isWon', equals: true }],
			}),
			meta(3),
		)
		const decoded = decodeSpecSystem(encodeSpecSystem(s))
		expect(decoded.pages.pages[0]?.blocks[1]?.aggregate).toEqual(
			s.pages.pages[0]?.blocks[1]?.aggregate,
		)
	})

	it("does not alias the op's own where array into spec state", () => {
		const where = [{ field: 'isWon' as const, equals: true }]
		const s = applyOp(grounded(), agg({ where }), meta(3))
		where[0] = { field: 'stage', equals: false } as never
		expect(s.pages.pages[0]?.blocks[1]?.aggregate?.where).toEqual([
			{ field: 'isWon', equals: true },
		])
	})
})

describe('theme.set — visual design as spec-as-data', () => {
	it('sets the theme, last-wins, both applications logged', () => {
		const s0 = base()
		expect(s0.theme).toBeUndefined()
		const s1 = applyOp(
			s0,
			{
				op: 'theme.set',
				args: { theme: { preset: 'ocean', accent: '#0ea5e9', radius: 'lg' } },
			},
			meta(1),
		)
		expect(s1.theme).toEqual({
			preset: 'ocean',
			accent: '#0ea5e9',
			radius: 'lg',
		})
		// last-wins full replace: the second set drops the first's overrides
		const s2 = applyOp(
			s1,
			{ op: 'theme.set', args: { theme: { preset: 'mono' } } },
			meta(2),
		)
		expect(s2.theme).toEqual({ preset: 'mono' })
		expect(s2.opLog.filter((o) => o.op.op === 'theme.set')).toHaveLength(2)
		const last = s2.opLog.at(-1)
		expect(last?.diff).toMatchObject({
			change: 'set',
			layer: 'theme',
			targetId: 'theme',
		})
		expect(last?.diff.summary).toContain('mono')
		expect(validateSpecSystem(s2)).toBe(s2)
	})

	it('rejects a bad preset, a bad accent, bad enums, and unknown keys', () => {
		const themeOp = (theme: object): SpecOp =>
			({ op: 'theme.set', args: { theme } }) as SpecOp
		expect(validateOp(base(), themeOp({ preset: 'neon' }))[0]).toMatch(
			/unknown preset "neon"/,
		)
		expect(
			validateOp(base(), themeOp({ preset: 'ocean', accent: 'blue' }))[0],
		).toMatch(/not a #rgb\/#rrggbb hex color/)
		expect(
			validateOp(base(), themeOp({ preset: 'ocean', radius: 'xl' }))[0],
		).toMatch(/unknown radius "xl"/)
		expect(
			validateOp(base(), themeOp({ preset: 'ocean', typescale: 'compact' }))[0],
		).toMatch(/unknown theme key "typescale"/)
		expect(validateOp(base(), themeOp({}))[0]).toMatch(
			/theme\.preset is required/,
		)
	})

	it('resolveTheme defaults to zinc until a theme.set lands', () => {
		expect(resolveTheme(base())).toEqual({ preset: 'zinc' })
		const s = applyOp(
			base(),
			{ op: 'theme.set', args: { theme: { preset: 'forest' } } },
			meta(1),
		)
		expect(resolveTheme(s)).toEqual({ preset: 'forest' })
	})
})

describe('product layer ops', () => {
	it('addRequirement rejects an unknown served metric', () => {
		const op: SpecOp = {
			op: 'prd.addRequirement',
			args: {
				requirement: {
					id: 'r-brandnew',
					userStory: 'as a user...',
					acceptanceCriteria: ['works'],
					priority: 'P1',
					edgeCasesAndErrorStates: [],
					servesMetricIds: ['m-not-real'],
				},
			},
		}
		expect(validateOp(base(), op)).toContain(
			'prd.addRequirement: servesMetricIds -> unknown metric "m-not-real"',
		)
	})

	it('addRequirement into a phase wires it into featureRequirementIds', () => {
		const op: SpecOp = {
			op: 'prd.addRequirement',
			args: {
				intoPhaseId: 'p-mvp',
				requirement: {
					id: 'r-brandnew',
					userStory: 'as a user...',
					acceptanceCriteria: ['works'],
					priority: 'P1',
					edgeCasesAndErrorStates: [],
					servesMetricIds: ['m-activation'],
				},
			},
		}
		const s = applyOp(base(), op, meta(1))
		const phase = s.product.roadmap.phases.find((p) => p.id === 'p-mvp')
		expect(phase?.featureRequirementIds).toContain('r-brandnew')
	})

	it('recordDecision appends to the append-only ledger and the op log', () => {
		const entry: LedgerEntry = {
			id: 'd-store',
			question: 'pglite or postgres for the demo store?',
			options: [
				{
					id: 'pglite',
					description: 'in-process',
					pros: ['zero setup'],
					cons: [],
				},
				{
					id: 'pg',
					description: 'real postgres',
					pros: ['prod-parity'],
					cons: ['setup'],
				},
			],
			recommendedOptionId: 'pglite',
			chosenOptionId: 'pglite',
			rationale: 'zero-setup wins for a demo',
			status: 'resolved',
			decidedAt: '2026-07-09',
			origin: 'human',
			recordedAt: '2026-07-09',
		}
		const s = applyOp(
			base(),
			{ op: 'prd.recordDecision', args: { entry } },
			meta(1),
		)
		expect(s.ledger).toHaveLength(1)
		expect(s.opLog).toHaveLength(1)
	})

	it('recordDecision works on a non-empty ledger (clone must not trip the guard)', () => {
		const entryFor = (id: `d-${string}`): LedgerEntry => ({
			id,
			question: 'q?',
			options: [{ id: 'a', description: 'a', pros: [], cons: [] }],
			chosenOptionId: 'a',
			rationale: 'r',
			status: 'resolved',
			decidedAt: '2026-07-09',
			origin: 'human',
			recordedAt: '2026-07-09',
		})
		const s1 = applyOp(
			base(),
			{ op: 'prd.recordDecision', args: { entry: entryFor('d-one') } },
			meta(1),
		)
		const s2 = applyOp(
			s1,
			{ op: 'prd.recordDecision', args: { entry: entryFor('d-two') } },
			meta(2),
		)
		expect(s2.ledger.map((e) => e.id)).toEqual(['d-one', 'd-two'])
	})
})

describe('diffs', () => {
	it('describe the change with a stable shape', () => {
		expect(diffOp(entity)).toMatchObject({
			op: 'data.addEntity',
			layer: 'data',
			change: 'add',
			targetId: 'e-invoice',
		})
		expect(
			diffOp({
				op: 'pricing.addTier',
				args: {
					tier: {
						id: 'tr-pro',
						name: 'Pro',
						priceMonthly: 20,
						features: [],
						provenance: suggested(),
					},
				},
			}),
		).toMatchObject({
			targetId: 'tr-pro',
			layer: 'pricing',
		})
	})
})

describe('provenance.review — accept/reject as an op-log audit entry', () => {
	it('accept transitions the row and appends an audit entry, immutably', () => {
		const s0 = applyOp(base(), entity, meta(1))
		const s1 = applyOp(
			s0,
			{
				op: 'provenance.review',
				args: { target: { kind: 'entity', id: 'e-invoice' }, action: 'accept' },
			},
			meta(2),
		)
		// the input system is untouched (still undecided)
		expect(s0.data.entities[0]?.provenance.isAccepted).toBeNull()
		expect(s1.data.entities[0]?.provenance.isAccepted).toBe(true)
		// the review is a logged, diffable audit entry
		const logged = s1.opLog[1]
		expect(logged?.diff).toMatchObject({
			op: 'provenance.review',
			layer: 'data',
			change: 'review',
			targetId: 'e-invoice',
			summary: 'Accept entity "e-invoice"',
		})
	})

	it('reject on a nested field is a soft-reject located via parentId', () => {
		const s0 = applyOp(base(), entity, meta(1))
		const s1 = applyOp(
			s0,
			{
				op: 'provenance.review',
				args: {
					target: { kind: 'field', id: 'fld-total', parentId: 'e-invoice' },
					action: 'reject',
				},
			},
			meta(2),
		)
		const field = s1.data.entities[0]?.fields[0]
		// soft-reject: still present, flagged not-accepted
		expect(field).toBeDefined()
		expect(field?.provenance.isAccepted).toBe(false)
		expect(s1.opLog[1]?.diff.parentId).toBe('e-invoice')
	})

	it('rejects a stale target loudly (never a silent no-op)', () => {
		const s0 = applyOp(base(), entity, meta(1))
		expect(
			validateOp(s0, {
				op: 'provenance.review',
				args: { target: { kind: 'page', id: 'pg-ghost' }, action: 'accept' },
			}),
		).toContain('provenance.review: no page "pg-ghost"')
		expect(() =>
			applyOp(
				s0,
				{
					op: 'provenance.review',
					args: { target: { kind: 'page', id: 'pg-ghost' }, action: 'accept' },
				},
				meta(2),
			),
		).toThrow(/no page "pg-ghost"/)
	})

	it('the reviewed system still validates end-to-end', () => {
		let s = applyOp(base(), entity, meta(1))
		s = applyOp(
			s,
			{
				op: 'provenance.review',
				args: { target: { kind: 'entity', id: 'e-invoice' }, action: 'accept' },
			},
			meta(2),
		)
		expect(() => validateSpecSystem(s)).not.toThrow()
	})

	it('cascade accepts the entity AND its still-suggested fields in one op', () => {
		const withManual: SpecOp = {
			op: 'data.addEntity',
			args: {
				entity: {
					id: 'e-invoice',
					name: 'Invoice',
					fields: [
						{
							id: 'fld-total',
							name: 'total',
							type: 'number',
							required: true,
							provenance: suggested(),
						},
						{
							id: 'fld-memo',
							name: 'memo',
							type: 'string',
							required: false,
							provenance: manual(),
						},
					],
					provenance: suggested(),
				},
			},
		}
		const s0 = applyOp(base(), withManual, meta(1))
		const s1 = applyOp(
			s0,
			{
				op: 'provenance.review',
				args: {
					target: { kind: 'entity', id: 'e-invoice' },
					action: 'accept',
					cascade: true,
				},
			},
			meta(2),
		)
		const inv = s1.data.entities[0]
		expect(inv?.provenance.isAccepted).toBe(true)
		expect(inv?.fields[0]?.provenance.isAccepted).toBe(true) // cascaded
		// the manual field is untouched (still manual, still accepted-by-manual)
		expect(inv?.fields[1]?.provenance.isAddedManually).toBe(true)
		// one op, one audit entry — not one per field
		expect(s1.opLog).toHaveLength(2)
		expect(s1.opLog[1]?.diff.summary).toBe(
			'Accept entity "e-invoice" and its undecided nested rows',
		)
	})

	it('cascade never flips settled rows — reject on an accepted entity only rejects its suggested fields', () => {
		let s = applyOp(base(), entity, meta(1))
		// settle the entity itself, leaving fld-total suggested
		s = applyOp(
			s,
			{
				op: 'provenance.review',
				args: { target: { kind: 'entity', id: 'e-invoice' }, action: 'accept' },
			},
			meta(2),
		)
		s = applyOp(
			s,
			{
				op: 'provenance.review',
				args: {
					target: { kind: 'entity', id: 'e-invoice' },
					action: 'reject',
					cascade: true,
				},
			},
			meta(3),
		)
		// the accepted entity stayed accepted; only the undecided field rejected
		expect(s.data.entities[0]?.provenance.isAccepted).toBe(true)
		expect(s.data.entities[0]?.fields[0]?.provenance.isAccepted).toBe(false)
	})
})

describe('the whole system stays valid across a sequence of ops', () => {
	it('builds data + pages + pricing + a decision and validates', () => {
		let s = base()
		s = applyOp(s, entity, meta(1))
		s = applyOp(
			s,
			{
				op: 'page.addPage',
				args: {
					page: {
						id: 'pg-invoices',
						name: 'Invoices',
						route: '/invoices',
						entityId: 'e-invoice',
						blocks: [],
						provenance: suggested(),
					},
				},
			},
			meta(2),
		)
		s = applyOp(
			s,
			{
				op: 'pricing.addTier',
				args: {
					tier: {
						id: 'tr-free',
						name: 'Free',
						priceMonthly: 0,
						features: ['1 project'],
						provenance: suggested(),
					},
				},
			},
			meta(3),
		)
		expect(() => validateSpecSystem(s)).not.toThrow()
		expect(s.opLog).toHaveLength(3)
	})

	it('validateSpecSystem catches a dangling page->entity reference', () => {
		const s = base()
		s.pages.pages.push({
			id: 'pg-orphan',
			name: 'Orphan',
			route: '/x',
			entityId: 'e-ghost',
			blocks: [],
			provenance: suggested(),
		})
		expect(() => validateSpecSystem(s)).toThrow(/unknown entity "e-ghost"/)
	})
})

describe('malformed provenance is rejected at propose time', () => {
	// The shape an agent invents when the docs don't spell out the real one.
	const bogus = { origin: 'agent' } as unknown as ReturnType<typeof manual>

	const fieldWithBogus: SpecOp = {
		op: 'data.addField',
		args: {
			entityId: 'e-invoice',
			field: {
				id: 'fld-cover',
				name: 'coverUrl',
				type: 'string',
				required: false,
				provenance: bogus,
			},
		},
	}

	it('validateOp flags a supplied non-Provenance object on every add op', () => {
		const s = applyOp(base(), entity, meta(1))
		expect(validateOp(s, fieldWithBogus).join()).toContain(
			'field "fld-cover": malformed provenance',
		)
		expect(
			validateOp(base(), {
				op: 'data.addEntity',
				args: {
					entity: {
						id: 'e-book',
						name: 'Book',
						fields: [],
						provenance: bogus,
					},
				},
			}).join(),
		).toContain('entity "e-book": malformed provenance')
		expect(
			validateOp(base(), {
				op: 'pricing.addTier',
				args: {
					tier: {
						id: 'tr-x',
						name: 'X',
						priceMonthly: 1,
						features: [],
						provenance: bogus,
					},
				},
			}).join(),
		).toContain('tier "tr-x": malformed provenance')
	})

	it('an omitted provenance stays valid (the server stamps a default)', () => {
		const s = applyOp(base(), entity, meta(1))
		const op: SpecOp = {
			op: 'data.addField',
			args: {
				entityId: 'e-invoice',
				field: {
					id: 'fld-cover',
					name: 'coverUrl',
					type: 'string',
					required: false,
				},
			},
		}
		expect(validateOp(s, op)).toEqual([])
		expect(validateOpDryRun(s, op, 'ai')).toEqual([])
	})

	it('validateOpDryRun agrees with the save-time system validator', () => {
		const s = applyOp(base(), entity, meta(1))
		const errors = validateOpDryRun(s, fieldWithBogus, 'ai')
		expect(errors.join()).toContain('malformed provenance')
		// and the op it rejects is exactly the one save would reject
		expect(() =>
			validateSpecSystem(applyOp(s, fieldWithBogus, meta(2))),
		).toThrow(/malformed provenance/)
	})

	it('validateOpDryRun never blames an op for pre-existing system errors', () => {
		const s = applyOp(base(), entity, meta(1))
		// corrupt an existing row directly (bypassing the validators)
		const field = s.data.entities[0]?.fields[0]
		if (field) field.provenance = bogus
		const goodOp: SpecOp = {
			op: 'data.addField',
			args: {
				entityId: 'e-invoice',
				field: {
					id: 'fld-due',
					name: 'dueDate',
					type: 'date',
					required: false,
				},
			},
		}
		expect(validateOpDryRun(s, goodOp, 'ai')).toEqual([])
	})
})

describe('page.addBlock slot mode', () => {
	const withPage: SpecSystem = {
		...base(),
		pages: {
			pages: [
				{
					id: 'pg-reading',
					name: 'Reading',
					route: '/reading',
					provenance: manual(),
					blocks: [],
				},
			],
		},
	}
	const addBlock = (type: string, mode?: unknown): SpecOp =>
		({
			op: 'page.addBlock',
			args: {
				pageId: 'pg-reading',
				block: { id: 'blk-x', type, mode, provenance: manual() },
			},
		}) as SpecOp

	it('accepts replace on a slot block', () => {
		expect(validateOp(withPage, addBlock('slot:shelf', 'replace'))).toEqual([])
	})

	it('accepts an omitted mode (append is the default)', () => {
		expect(validateOp(withPage, addBlock('slot:shelf'))).toEqual([])
	})

	it('rejects replace on a non-slot block', () => {
		// `replace` on a table would be silently ignored by the runtime, and a
		// silently-dropped layout instruction is worse than a rejected one.
		const errors = validateOp(withPage, addBlock('table', 'replace'))
		expect(errors).toHaveLength(1)
		expect(errors[0]).toContain('only a slot can replace')
	})

	it('rejects an unknown mode value', () => {
		const errors = validateOp(withPage, addBlock('slot:shelf', 'hide'))
		expect(errors).toHaveLength(1)
		expect(errors[0]).toContain('bad mode "hide"')
	})
})

describe('enum options coercion', () => {
	const meta1 = meta(1)
	const entityWithEnum = (options: unknown): SpecOp =>
		({
			op: 'data.addEntity',
			args: {
				entity: {
					id: 'e-book',
					name: 'Book',
					provenance: manual(),
					fields: [
						{
							id: 'fld-book-kind',
							name: 'kind',
							type: 'enum',
							required: false,
							options,
							provenance: manual(),
						},
					],
				},
			},
		}) as unknown as SpecOp

	it('accepts a bare string[] and stores it as {label, value}', () => {
		// The shape agents actually reach for — two independent trial runs wrote
		// it. It used to pass validation and then ground to a column that rejected
		// every write, failing at form submit instead of at the op.
		const op = entityWithEnum(['book', 'article'])
		expect(validateOp(base(), op)).toEqual([])
		const next = applyOp(base(), op, meta1)
		expect(next.data.entities[0]?.fields[0]?.options).toEqual([
			{ label: 'book', value: 'book' },
			{ label: 'article', value: 'article' },
		])
	})

	it('leaves canonical {label, value} options untouched', () => {
		const options = [{ label: 'Book', value: 'book' }]
		const next = applyOp(base(), entityWithEnum(options), meta1)
		expect(next.data.entities[0]?.fields[0]?.options).toEqual(options)
	})

	it('accepts a mixed array', () => {
		const next = applyOp(
			base(),
			entityWithEnum(['book', { label: 'Long read', value: 'essay' }]),
			meta1,
		)
		expect(next.data.entities[0]?.fields[0]?.options).toEqual([
			{ label: 'book', value: 'book' },
			{ label: 'Long read', value: 'essay' },
		])
	})

	it('rejects options that cannot be coerced, rather than guessing', () => {
		// Repairing these would put an unusable column in the spec with no
		// rollback — the exact failure mode #130 is about.
		expect(
			validateOp(base(), entityWithEnum([{ label: 'no value' }]))[0],
		).toContain('must be a string or {label, value}')
		expect(validateOp(base(), entityWithEnum([42]))[0]).toContain('option 0')
		expect(validateOp(base(), entityWithEnum([]))[0]).toContain(
			'needs at least one option',
		)
		expect(validateOp(base(), entityWithEnum('book'))[0]).toContain(
			'must be an array',
		)
	})

	it('coerces on data.addField too', () => {
		const withEntity = applyOp(base(), entityWithEnum(['book']), meta1)
		const next = applyOp(
			withEntity,
			{
				op: 'data.addField',
				args: {
					entityId: 'e-book',
					field: {
						id: 'fld-book-status',
						name: 'status',
						type: 'enum',
						required: false,
						options: ['reading', 'finished'],
						provenance: manual(),
					},
				},
			} as unknown as SpecOp,
			meta(2),
		)
		expect(next.data.entities[0]?.fields[1]?.options).toEqual([
			{ label: 'reading', value: 'reading' },
			{ label: 'finished', value: 'finished' },
		])
	})
})

describe('unknown op names', () => {
	it('rejects an unrecognized op name instead of passing validation', () => {
		// The switch had no `default`, so an unknown name matched nothing,
		// accumulated no errors, and sailed through validateOp — then died in
		// diffOp on `SPEC_OP_VOCABULARY[op.op].layer`.
		const errors = validateOp(base(), { op: 'data.deleteEverything' } as never)
		expect(errors).toHaveLength(1)
		expect(errors[0]).toContain('unknown op "data.deleteEverything"')
		// The message must list the vocabulary — it is the only thing that makes
		// the error actionable.
		expect(errors[0]).toContain('data.addEntity')
	})

	it('rejects the nested-op shape slip with a message naming the right shape', () => {
		// `{op: {op, args}}` instead of the flat `{op, args}` the tool schema
		// specifies — the mistake that produced the original null-deref.
		const errors = validateOp(base(), {
			op: { op: 'data.addEntity', args: {} },
		} as never)
		expect(errors[0]).toContain('"op" must be the op name as a string')
		expect(errors[0]).toContain('not object')
		// Not "[object Object]" — stringifying the payload tells the author nothing.
		expect(errors[0]).not.toContain('[object Object]')
	})

	it('never reaches diffOp for an unknown op', () => {
		// applyOp gates on validateOp, so the crash path is now unreachable:
		// a structured rejection, not a null-deref.
		expect(() => applyOp(base(), { op: 'nope' } as never, meta(1))).toThrow(
			/unknown op "nope"/,
		)
	})

	it('still reports a real op with bad args as before', () => {
		// The default must not shadow the per-op validation.
		const errors = validateOp(base(), {
			op: 'data.addField',
			args: { entityId: 'e-nope', field: entityField() },
		} as never)
		expect(errors.some((e) => e.includes('unknown entity'))).toBe(true)
		expect(errors.some((e) => e.includes('unknown op'))).toBe(false)
	})
})

/** A minimal valid field payload for the args-validation check above. */
function entityField() {
	return {
		id: 'fld-x-y',
		name: 'y',
		type: 'string',
		required: false,
		provenance: manual(),
	}
}

// ===========================================================================
// Derived values — computed fields and rollups
// ===========================================================================

/**
 * A two-entity graph with a real relation: `e-order` has a `sub-total` number
 * and a `placedAt` date, and belongs to `e-client`. This is the minimum shape a
 * rollup needs, and the shape the benchmark corpus was missing entirely.
 */
function withRelation(): SpecSystem {
	let s = applyOp(
		base(),
		{
			op: 'data.addEntity',
			args: {
				entity: {
					id: 'e-client',
					name: 'Client',
					fields: [
						{
							id: 'fld-client-name',
							name: 'name',
							type: 'string',
							required: true,
							provenance: manual(),
						},
					],
					provenance: manual(),
				},
			},
		},
		meta(1),
	)
	s = applyOp(
		s,
		{
			op: 'data.addEntity',
			args: {
				entity: {
					id: 'e-order',
					name: 'Order',
					fields: [
						{
							id: 'fld-order-amount',
							name: 'amount',
							type: 'number',
							required: true,
							provenance: manual(),
						},
						{
							id: 'fld-order-qty',
							name: 'qty',
							type: 'number',
							required: false,
							provenance: manual(),
						},
						{
							id: 'fld-order-status',
							name: 'status',
							type: 'string',
							required: false,
							provenance: manual(),
						},
						{
							id: 'fld-order-placed',
							name: 'placedAt',
							type: 'date',
							required: false,
							provenance: manual(),
						},
						{
							id: 'fld-order-client',
							name: 'clientId',
							type: 'string',
							required: false,
							reference: 'e-client',
							provenance: manual(),
						},
					],
					provenance: manual(),
				},
			},
		},
		meta(2),
	)
	return s
}

const rollup = (over: Partial<Record<string, unknown>> = {}): SpecOp => ({
	op: 'data.addRollup',
	args: {
		entityId: 'e-client',
		rollup: {
			id: 'drv-client-total',
			name: 'lifetimeSpend',
			over: 'e-order',
			via: 'fld-order-client',
			fn: 'sum',
			field: 'fld-order-amount',
			...over,
		} as never,
	},
})

describe('data.setFieldReference', () => {
	const declare = (over: Partial<Record<string, unknown>> = {}): SpecOp =>
		({
			op: 'data.setFieldReference',
			args: {
				entityId: 'e-order',
				fieldId: 'fld-order-status',
				reference: 'e-client',
				...over,
			},
		}) as SpecOp

	it('declares an existing string field a foreign key', () => {
		const s = applyOp(withRelation(), declare(), meta(3))
		const field = s.data.entities
			.find((e) => e.id === 'e-order')
			?.fields.find((f) => f.id === 'fld-order-status')
		expect(field?.reference).toBe('e-client')
		// It declares something already true of the data, so the field keeps its
		// declared type — the *column* type is reconciled by the migration.
		expect(field?.type).toBe('string')
		expect(s.opLog.at(-1)?.diff.targetId).toBe('fld-order-status')
	})

	it('makes the field usable as a rollup path — the point of the op', () => {
		// Before: `via` a bare string is rejected. After: the same rollup lands.
		const before = withRelation()
		expect(
			validateOp(before, {
				op: 'data.addRollup',
				args: {
					entityId: 'e-client',
					rollup: {
						id: 'drv-client-open',
						name: 'openOrders',
						over: 'e-order',
						via: 'fld-order-status',
						fn: 'count',
					} as never,
				},
			}),
		).not.toEqual([])
		const after = applyOp(before, declare(), meta(3))
		expect(
			validateOp(after, {
				op: 'data.addRollup',
				args: {
					entityId: 'e-client',
					rollup: {
						id: 'drv-client-open',
						name: 'openOrders',
						over: 'e-order',
						via: 'fld-order-status',
						fn: 'count',
					} as never,
				},
			}),
		).toEqual([])
	})

	it('refuses to re-point a field that already references something', () => {
		// Re-pointing changes what every stored value means — a data migration,
		// not a declaration.
		expect(
			validateOp(withRelation(), declare({ fieldId: 'fld-order-client' })),
		).toEqual([
			'data.setFieldReference: field "fld-order-client" already references "e-client"; a reference is declared once and re-pointing it is a data migration this op cannot perform',
		])
	})

	it('refuses a field that cannot hold an id', () => {
		expect(
			validateOp(withRelation(), declare({ fieldId: 'fld-order-amount' })),
		).toEqual([
			'data.setFieldReference: field "fld-order-amount" is number, which cannot hold an id (declare a string field)',
		])
	})

	it('refuses an unknown entity, field, or target', () => {
		expect(
			validateOp(withRelation(), declare({ entityId: 'e-ghost' })),
		).toContain('data.setFieldReference: unknown entity "e-ghost"')
		expect(
			validateOp(withRelation(), declare({ fieldId: 'fld-ghost' })),
		).toContain('data.setFieldReference: unknown field "fld-ghost" on e-order')
		expect(
			validateOp(withRelation(), declare({ reference: 'e-ghost' })),
		).toContain(
			'data.setFieldReference: field "fld-order-status" -> unknown reference entity "e-ghost"',
		)
	})
})

/**
 * Issue #216 — the reference a *project* declares, not the catalog.
 *
 * Billing's `subject` is "whatever this app bills": a user in a per-seat
 * product, an organization in a per-workspace one. `data.setFieldReference`
 * names one entity, so there was no honest op to write and the column shipped
 * as a bare string with the loss recorded as a "cannot". This op declares the
 * *ambiguity*; `setFieldReference` resolves it.
 */
describe('data.setFieldOpenReference', () => {
	const open = (over: Partial<Record<string, unknown>> = {}): SpecOp =>
		({
			op: 'data.setFieldOpenReference',
			args: {
				entityId: 'e-order',
				fieldId: 'fld-order-status',
				candidates: ['e-client', 'e-user'],
				...over,
			},
		}) as SpecOp

	it('declares the candidates without resolving one', () => {
		const s = applyOp(withRelation(), open(), meta(3))
		const field = s.data.entities
			.find((e) => e.id === 'e-order')
			?.fields.find((f) => f.id === 'fld-order-status')
		expect(field?.openReference).toEqual(['e-client', 'e-user'])
		// NOT a reference yet: nothing resolves it, and the emitted column is the
		// same text a bare string emits — which is what makes this additive on a
		// bundle somebody has already installed.
		expect(field?.reference).toBeUndefined()
		expect(field?.type).toBe('string')
	})

	it('stores the candidates sorted and deduplicated', () => {
		// The upgrade gate compares an upgraded project against a fresh install
		// byte for byte, so a spec whose content depends on argument order is one
		// that gate cannot compare.
		const s = applyOp(
			withRelation(),
			open({ candidates: ['e-user', 'e-client', 'e-user'] }),
			meta(3),
		)
		expect(
			s.data.entities
				.find((e) => e.id === 'e-order')
				?.fields.find((f) => f.id === 'fld-order-status')?.openReference,
		).toEqual(['e-client', 'e-user'])
	})

	it('refuses one candidate — that is a reference, not an ambiguity', () => {
		expect(
			validateOp(withRelation(), open({ candidates: ['e-client'] })),
		).toContain(
			'data.setFieldOpenReference: field "fld-order-status" declares one open-reference candidate, which is not an ambiguity — declare it as a plain reference instead',
		)
	})

	it('refuses to open a field that already references something', () => {
		// The mirror of `setFieldReference`'s re-pointing refusal: re-opening a
		// resolved reference un-declares a relation the rows already depend on.
		expect(
			validateOp(withRelation(), open({ fieldId: 'fld-order-client' })),
		).toEqual([
			'data.setFieldOpenReference: field "fld-order-client" already references "e-client"; opening a declared reference would un-declare a relation the rows already depend on',
		])
	})

	it('refuses a field that cannot hold an id', () => {
		expect(
			validateOp(withRelation(), open({ fieldId: 'fld-order-amount' })),
		).toContain(
			'data.setFieldOpenReference: field "fld-order-amount" is number, which cannot hold an id (declare a string field)',
		)
	})

	it('narrows to a candidate, and refuses anything else', () => {
		const opened = applyOp(withRelation(), open(), meta(3))
		const narrow = (reference: string): SpecOp =>
			({
				op: 'data.setFieldReference',
				args: {
					entityId: 'e-order',
					fieldId: 'fld-order-status',
					reference,
				},
			}) as SpecOp

		// The candidate list is the point of declaring one: without this refusal,
		// `openReference` would be documentation and a project could point a
		// billing subject at any table in the app.
		expect(validateOp(opened, narrow('e-order'))).toContain(
			'data.setFieldReference: field "fld-order-status" is open over e-client, e-user, and "e-order" is not one of them — a project narrows an open reference to one of its declared candidates',
		)

		expect(validateOp(opened, narrow('e-client'))).toEqual([])
		const narrowed = applyOp(opened, narrow('e-client'), meta(4))
		const field = narrowed.data.entities
			.find((e) => e.id === 'e-order')
			?.fields.find((f) => f.id === 'fld-order-status')
		expect(field?.reference).toBe('e-client')
		// Narrowing consumes the ambiguity. Two live records of what a column
		// points at is how they come to disagree.
		expect(field?.openReference).toBeUndefined()
	})

	it('refuses a rollup through an un-narrowed field, naming the fix', () => {
		// Narrowing is a PRECONDITION for traversal, not an alternative to it.
		// Aggregating across whatever ids happen to be in the column is a number
		// nobody can audit and everybody believes — which for the billing ledger
		// this exists for is the worst possible shape.
		const opened = applyOp(withRelation(), open(), meta(3))
		const rollupOp: SpecOp = {
			op: 'data.addRollup',
			args: {
				entityId: 'e-client',
				rollup: {
					id: 'drv-client-open',
					name: 'openOrders',
					over: 'e-order',
					via: 'fld-order-status',
					fn: 'count',
				} as never,
			},
		}
		expect(validateOp(opened, rollupOp)).toContain(
			'data.addRollup: rollup "drv-client-open" -> via[0] -> field "fld-order-status" is an OPEN reference over e-client, e-user and has not been narrowed; declare which one this app means with data.setFieldReference before rolling up through it',
		)
		// Narrowed, the identical rollup lands.
		const narrowed = applyOp(
			opened,
			{
				op: 'data.setFieldReference',
				args: {
					entityId: 'e-order',
					fieldId: 'fld-order-status',
					reference: 'e-client',
				},
			} as SpecOp,
			meta(4),
		)
		expect(validateOp(narrowed, rollupOp)).toEqual([])
	})
})

describe('data.addRollup', () => {
	it('lands a per-row aggregate over a real relation', () => {
		const s = applyOp(withRelation(), rollup(), meta(3))
		const client = s.data.entities.find((e) => e.id === 'e-client')
		expect(client?.rollups?.map((r) => r.name)).toEqual(['lifetimeSpend'])
		// A rollup is not a stored field — it must never appear in `fields`, or the
		// spec→SQL bridge would try to add a column for it.
		expect(client?.fields.map((f) => f.id)).toEqual(['fld-client-name'])
		expect(s.opLog.at(-1)?.diff.targetId).toBe('drv-client-total')
	})

	it('stamps provenance like every other add op', () => {
		const s = applyOp(withRelation(), rollup(), meta(3))
		expect(
			s.data.entities.find((e) => e.id === 'e-client')?.rollups?.[0]
				?.provenance,
		).toBeDefined()
	})

	// #170's headline gating requirement: "a rollup over a relation that does not
	// exist fails at `maxstack validate`, not at render time with an empty card."
	describe('fails loudly at validate, never silently at render', () => {
		it('rejects an unknown entity to roll up', () => {
			expect(validateOp(withRelation(), rollup({ over: 'e-ghost' }))).toContain(
				'data.addRollup: rollup "drv-client-total" -> unknown entity "e-ghost" to roll up',
			)
		})

		it('rejects a `via` that is not a field on the rolled-up entity', () => {
			expect(validateOp(withRelation(), rollup({ via: 'fld-nope' }))).toContain(
				'data.addRollup: rollup "drv-client-total" -> via[0] -> unknown field "fld-nope" on e-order',
			)
		})

		it('rejects a `via` that is not a reference at all', () => {
			expect(
				validateOp(withRelation(), rollup({ via: 'fld-order-status' })),
			).toContain(
				'data.addRollup: rollup "drv-client-total" -> via[0] -> field "fld-order-status" is not a reference, so it cannot relate e-order to the next hop',
			)
		})

		// The subtle one. A rollup wired through an FK pointing somewhere else
		// would aggregate the wrong rows and look completely fine.
		it('rejects a `via` whose reference points at a different entity', () => {
			let s = withRelation()
			s = applyOp(
				s,
				{
					op: 'data.addField',
					args: {
						entityId: 'e-order',
						field: {
							id: 'fld-order-parent',
							name: 'parentId',
							type: 'string',
							required: false,
							reference: 'e-order',
							provenance: manual(),
						},
					},
				},
				meta(3),
			)
			expect(validateOp(s, rollup({ via: 'fld-order-parent' }))).toContain(
				'data.addRollup: rollup "drv-client-total" -> via[0] -> field "fld-order-parent" references "e-order", not "e-client"; the last hop must land on the entity the rollup is exposed on',
			)
		})

		it('rejects an unknown field to aggregate', () => {
			expect(
				validateOp(withRelation(), rollup({ field: 'fld-ghost' })),
			).toContain(
				'data.addRollup: rollup "drv-client-total" -> unknown field "fld-ghost" on e-order',
			)
		})

		it('rejects summing a non-numeric column', () => {
			expect(
				validateOp(withRelation(), rollup({ field: 'fld-order-status' })),
			).toContain(
				'data.addRollup: rollup "drv-client-total" -> fn "sum" needs a number field, but "fld-order-status" is string',
			)
		})

		it('rejects an unknown aggregate function', () => {
			expect(validateOp(withRelation(), rollup({ fn: 'median' }))).toContain(
				'data.addRollup: rollup "drv-client-total" -> unknown fn "median" (expected one of count, countDistinct, sum, avg, min, max)',
			)
		})

		it('requires a field for every fn but count, and forbids one for count', () => {
			expect(
				validateOp(withRelation(), rollup({ fn: 'avg', field: undefined })),
			).toContain(
				'data.addRollup: rollup "drv-client-total" -> fn "avg" needs a field to aggregate',
			)
			expect(validateOp(withRelation(), rollup({ fn: 'count' }))).toContain(
				'data.addRollup: rollup "drv-client-total" -> fn "count" counts rows and takes no field (use countDistinct)',
			)
			// count with no field is the correct spelling
			expect(
				validateOp(withRelation(), rollup({ fn: 'count', field: undefined })),
			).toEqual([])
		})

		it('rejects a filter on an unknown field', () => {
			expect(
				validateOp(
					withRelation(),
					rollup({ where: [{ field: 'fld-ghost', equals: 'x' }] }),
				),
			).toContain(
				'data.addRollup: rollup "drv-client-total" -> where -> unknown field "fld-ghost" on e-order',
			)
		})

		it('rejects a name colliding with a stored field or another derived value', () => {
			expect(validateOp(withRelation(), rollup({ name: 'name' }))).toContain(
				'data.addRollup: rollup "drv-client-total" -> name "name" collides with an existing field or derived value on e-client',
			)
			const s = applyOp(withRelation(), rollup(), meta(3))
			expect(validateOp(s, rollup({ id: 'drv-other' }))).toContain(
				'data.addRollup: rollup "drv-other" -> name "lifetimeSpend" collides with an existing field or derived value on e-client',
			)
		})

		it('rejects a duplicate derived id', () => {
			const s = applyOp(withRelation(), rollup(), meta(3))
			expect(validateOp(s, rollup({ name: 'other' }))).toContain(
				'data.addRollup: derived id "drv-client-total" already exists',
			)
		})
	})

	// #170's cost-visibility gate: "the op must express its bounds, and the
	// runtime should refuse... rather than silently timing out."
	describe('cost bounds', () => {
		it('refuses a grouped rollup with no limit', () => {
			expect(
				validateOp(
					withRelation(),
					rollup({ groupBy: { field: 'fld-order-status' } }),
				),
			).toContain(
				'data.addRollup: rollup "drv-client-total" -> a grouped rollup must declare a limit (the cost bound); max 1000',
			)
		})

		it('accepts a grouped rollup that states its bound', () => {
			expect(
				validateOp(
					withRelation(),
					rollup({ groupBy: { field: 'fld-order-status' }, limit: 20 }),
				),
			).toEqual([])
		})

		it('rejects a limit past the cap, or a nonsensical one', () => {
			expect(validateOp(withRelation(), rollup({ limit: 5000 }))).toContain(
				'data.addRollup: rollup "drv-client-total" -> limit 5000 exceeds the 1000 cap',
			)
			expect(validateOp(withRelation(), rollup({ limit: 0 }))).toContain(
				'data.addRollup: rollup "drv-client-total" -> limit must be a positive integer',
			)
			expect(validateOp(withRelation(), rollup({ limit: 1.5 }))).toContain(
				'data.addRollup: rollup "drv-client-total" -> limit must be a positive integer',
			)
		})

		// A scalar rollup is bounded by construction — one row out — so requiring a
		// limit there would be noise.
		it('does not require a limit on an ungrouped (scalar) rollup', () => {
			expect(validateOp(withRelation(), rollup())).toEqual([])
		})
	})

	describe('time-series grouping (a bucketed rollup IS the chart)', () => {
		it('accepts a date bucket over a date column', () => {
			expect(
				validateOp(
					withRelation(),
					rollup({
						groupBy: { field: 'fld-order-placed', bucket: 'month' },
						limit: 24,
					}),
				),
			).toEqual([])
		})

		it('rejects bucketing a non-date column', () => {
			expect(
				validateOp(
					withRelation(),
					rollup({
						groupBy: { field: 'fld-order-status', bucket: 'month' },
						limit: 24,
					}),
				),
			).toContain(
				'data.addRollup: rollup "drv-client-total" -> groupBy -> bucket "month" needs a date field, but "fld-order-status" is string',
			)
		})

		it('rejects an unknown bucket', () => {
			expect(
				validateOp(
					withRelation(),
					rollup({
						groupBy: { field: 'fld-order-placed', bucket: 'fortnight' },
						limit: 24,
					}),
				),
			).toContain(
				'data.addRollup: rollup "drv-client-total" -> groupBy -> unknown bucket "fortnight" (expected one of day, week, month, quarter, year)',
			)
		})
	})

	it('a table-wide rollup needs no via', () => {
		expect(validateOp(withRelation(), rollup({ via: undefined }))).toEqual([])
	})

	it('refuses to land an invalid rollup at all (applyOp throws)', () => {
		expect(() =>
			applyOp(withRelation(), rollup({ over: 'e-ghost' }), meta(3)),
		).toThrow(/unknown entity "e-ghost" to roll up/)
	})

	it('requires the entity the rollup is exposed on to exist', () => {
		const orphan: SpecOp = {
			...rollup(),
			args: { ...rollup().args, entityId: 'e-nobody' } as never,
		}
		expect(validateOp(withRelation(), orphan)).toContain(
			'data.addRollup: unknown entity "e-nobody"',
		)
	})
})

const computed = (patch: Partial<Record<string, unknown>> = {}): SpecOp => ({
	op: 'data.addComputed',
	args: {
		entityId: 'e-order',
		computed: {
			id: 'drv-order-line',
			name: 'lineTotal',
			expr: {
				kind: 'binary',
				op: '*',
				left: { kind: 'field', field: 'fld-order-amount' },
				right: { kind: 'field', field: 'fld-order-qty' },
			},
			...patch,
		} as never,
	},
})

describe('data.addComputed', () => {
	it('lands an arithmetic expression over the row’s own fields', () => {
		const s = applyOp(withRelation(), computed(), meta(3))
		const order = s.data.entities.find((e) => e.id === 'e-order')
		expect(order?.computed?.map((c) => c.name)).toEqual(['lineTotal'])
		// Like a rollup, never a stored column — the derived name does not become a
		// field, so the spec→SQL bridge never emits DDL for it. (That a *DerivedId*
		// can't even be compared to a `FieldId` is the branded-id types making the
		// same point at compile time.)
		expect(order?.fields.some((f) => f.name === 'lineTotal')).toBe(false)
		expect(order?.fields).toHaveLength(5)
	})

	it('expresses the Epley one-rep-max formula — the gymlog corpus ask', () => {
		// weight * (1 + reps / 30). This is the shape that fixed the AST design:
		// it needs multiplication, addition, division, a literal, and two fields.
		const epley = computed({
			id: 'drv-est-1rm',
			name: 'estimated1rm',
			expr: {
				kind: 'binary',
				op: '*',
				left: { kind: 'field', field: 'fld-order-amount' },
				right: {
					kind: 'binary',
					op: '+',
					left: { kind: 'literal', value: 1 },
					right: {
						kind: 'binary',
						op: '/',
						left: { kind: 'field', field: 'fld-order-qty' },
						right: { kind: 'literal', value: 30 },
					},
				},
			},
		})
		expect(validateOp(withRelation(), epley)).toEqual([])
		expect(() => applyOp(withRelation(), epley, meta(3))).not.toThrow()
	})

	describe('fails loudly at validate', () => {
		it('rejects a leaf field that does not exist', () => {
			expect(
				validateOp(
					withRelation(),
					computed({ expr: { kind: 'field', field: 'fld-ghost' } }),
				),
			).toContain(
				'data.addComputed: computed "drv-order-line" -> unknown field "fld-ghost" on e-order',
			)
		})

		// Arithmetic over a string has no meaning the runtime could honor; coercing
		// would render NaN on every row instead of failing here.
		it('rejects arithmetic over a non-numeric field', () => {
			expect(
				validateOp(
					withRelation(),
					computed({ expr: { kind: 'field', field: 'fld-order-status' } }),
				),
			).toContain(
				'data.addComputed: computed "drv-order-line" -> field "fld-order-status" is string, but arithmetic needs number',
			)
		})

		it('rejects an unknown operator and an unknown node kind', () => {
			expect(
				validateOp(
					withRelation(),
					computed({
						expr: {
							kind: 'binary',
							op: '%',
							left: { kind: 'literal', value: 1 },
							right: { kind: 'literal', value: 2 },
						},
					}),
				),
			).toContain(
				'data.addComputed: computed "drv-order-line" -> unknown operator "%" (expected one of + - * /)',
			)
			expect(
				validateOp(withRelation(), computed({ expr: { kind: 'sqrt' } })),
			).toContain(
				'data.addComputed: computed "drv-order-line" -> unknown expression kind "sqrt" (expected field, literal, or binary)',
			)
		})

		it('rejects a non-finite literal', () => {
			for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 'five']) {
				expect(
					validateOp(
						withRelation(),
						computed({ expr: { kind: 'literal', value } }),
					),
				).toContain(
					'data.addComputed: computed "drv-order-line" -> literal must be a finite number',
				)
			}
		})

		// The one arithmetic error catchable statically, and worth catching: it
		// turns every row's card into an error.
		it('rejects division by a literal zero', () => {
			expect(
				validateOp(
					withRelation(),
					computed({
						expr: {
							kind: 'binary',
							op: '/',
							left: { kind: 'field', field: 'fld-order-amount' },
							right: { kind: 'literal', value: 0 },
						},
					}),
				),
			).toContain(
				'data.addComputed: computed "drv-order-line" -> division by the literal 0',
			)
		})

		it('bounds expression depth so a generated op cannot hand over a huge tree', () => {
			let expr: unknown = { kind: 'field', field: 'fld-order-amount' }
			for (let i = 0; i < 20; i++) {
				expr = {
					kind: 'binary',
					op: '+',
					left: expr,
					right: { kind: 'literal', value: 1 },
				}
			}
			expect(validateOp(withRelation(), computed({ expr }))).toContain(
				'data.addComputed: computed "drv-order-line" -> expression nests deeper than 16',
			)
		})

		it('rejects a name colliding with a stored field', () => {
			expect(
				validateOp(withRelation(), computed({ name: 'amount' })),
			).toContain(
				'data.addComputed: computed "drv-order-line" -> name "amount" collides with an existing field or derived value on e-order',
			)
		})

		// A computed field may not reference another derived value: that would allow
		// cycles, and a cycle detector is a lot of machinery for a feature nobody
		// asked for.
		//
		// The branded ids make this a COMPILE-time error too — `DerivedId` is not
		// assignable to the `field: FieldId` leaf — so the cast below is what an
		// agent posting raw JSON over MCP effectively does, and the runtime check is
		// what catches it. The leaf lookup only searches stored fields, so it reads
		// as "unknown field".
		it('cannot reference another derived value', () => {
			const s = applyOp(withRelation(), computed(), meta(3))
			expect(
				validateOp(
					s,
					computed({
						id: 'drv-order-two',
						name: 'doubled',
						expr: {
							kind: 'binary',
							op: '*',
							left: {
								kind: 'field',
								field: 'drv-order-line' as never,
							},
							right: { kind: 'literal', value: 2 },
						},
					}),
				),
			).toContain(
				'data.addComputed: computed "drv-order-two" -> unknown field "drv-order-line" on e-order',
			)
		})
	})
})

describe('derived values keep the generator deterministic', () => {
	// The design rule that makes this safe: the spec DECLARES the computation and
	// the runtime EVALUATES it. Nothing here is an input to code generation, so a
	// rollup cannot make regeneration non-deterministic — the §L4A hard gate holds
	// by construction rather than by testing every generator.
	it('adds no stored fields, so the spec→SQL bridge sees no new columns', () => {
		const before = withRelation()
		let after = applyOp(before, rollup(), meta(3))
		after = applyOp(after, computed(), meta(4))
		for (const entity of after.data.entities) {
			const original = before.data.entities.find((e) => e.id === entity.id)
			expect(entity.fields.map((f) => f.id)).toEqual(
				original?.fields.map((f) => f.id),
			)
		}
	})

	it('round-trips through spec validation', () => {
		let s = applyOp(withRelation(), rollup(), meta(3))
		s = applyOp(s, computed(), meta(4))
		expect(() => validateSpecSystem(s)).not.toThrow()
	})
})

describe('rollups over computed fields — the gymlog composition', () => {
	/** `e-order` with a computed `lineTotal`, ready to be aggregated. */
	function withComputed(): SpecSystem {
		return applyOp(withRelation(), computed(), meta(3))
	}

	// This is what makes gymlog's ask land: a value computed per child row, then
	// aggregated into a series over the parent. Without it, "1RM over time" needs
	// two primitives that can't compose and the ask stays off-surface.
	it('aggregates a computed field into a bucketed series', () => {
		const s = withComputed()
		const op = rollup({
			id: 'drv-client-peak',
			name: 'peakLineTotal',
			field: 'drv-order-line',
			fn: 'max',
			groupBy: { field: 'fld-order-placed', bucket: 'week' },
			limit: 52,
		})
		expect(validateOp(s, op)).toEqual([])
		const next = applyOp(s, op, meta(4))
		expect(
			next.data.entities.find((e) => e.id === 'e-client')?.rollups?.[0]?.field,
		).toBe('drv-order-line')
	})

	it('sums a computed field without a redundant numeric check', () => {
		// A computed field is arithmetic over number fields, so it is numeric by
		// construction — `sum` over one needs no type lookup and must not fail.
		expect(
			validateOp(
				withComputed(),
				rollup({ fn: 'sum', field: 'drv-order-line' }),
			),
		).toEqual([])
	})

	// The single edge that would break the acyclicity argument in
	// `RollupSpec.field`: rollup -> computed -> stored is a DAG of depth 2, but
	// rollup -> rollup could close a loop. It is rejected by name.
	it('refuses to aggregate another rollup, by name', () => {
		let s = withComputed()
		s = applyOp(s, rollup(), meta(4)) // e-client.lifetimeSpend
		const nested = rollup({
			id: 'drv-client-nested',
			name: 'spendOfSpend',
			over: 'e-client',
			via: undefined,
			field: 'drv-client-total',
			fn: 'sum',
		})
		expect(validateOp(s, nested)).toContain(
			'data.addRollup: rollup "drv-client-nested" -> cannot aggregate rollup "drv-client-total"; a rollup may aggregate a stored or computed field, never another rollup',
		)
	})

	it('still rejects a derived id that exists on no entity', () => {
		expect(
			validateOp(withComputed(), rollup({ field: 'drv-nowhere' })),
		).toContain(
			'data.addRollup: rollup "drv-client-total" -> unknown field "drv-nowhere" on e-order',
		)
	})

	// The acyclicity invariant, stated as a test rather than only as a comment.
	it('keeps derived references a DAG of depth at most 2', () => {
		let s = withComputed()
		s = applyOp(s, rollup({ field: 'drv-order-line', fn: 'sum' }), meta(4))
		for (const entity of s.data.entities) {
			// Every computed leaf is a STORED field on its own entity — depth 1.
			for (const c of entity.computed ?? []) {
				const leaves: string[] = []
				const walk = (node: unknown): void => {
					if (typeof node !== 'object' || node === null) return
					const n = node as Record<string, unknown>
					if (n.kind === 'field') leaves.push(String(n.field))
					walk(n.left)
					walk(n.right)
				}
				walk(c.expr)
				for (const leaf of leaves) {
					expect(entity.fields.some((f) => f.id === leaf)).toBe(true)
				}
			}
			// Every rollup target is a stored or computed field — never a rollup.
			for (const r of entity.rollups ?? []) {
				if (r.field === undefined) continue
				const over = s.data.entities.find((e) => e.id === r.over)
				expect((over?.rollups ?? []).some((x) => x.id === r.field)).toBe(false)
			}
		}
	})
})

describe('multi-hop rollup paths — the recipebox shopping list', () => {
	/**
	 * The recipebox shape, minimally: ingredients belong to recipes, recipes belong
	 * to meal plans. A meal plan's shopping list is therefore TWO hops away from
	 * its ingredients — which is exactly why one-hop-only `via` would have left the
	 * corpus ask off-surface while appearing to absorb it.
	 */
	function threeLevels(): SpecSystem {
		let s = base()
		const ent = (
			id: string,
			name: string,
			fields: Record<string, unknown>[],
		): SpecOp => ({
			op: 'data.addEntity',
			args: {
				entity: { id, name, fields, provenance: manual() } as never,
			},
		})
		s = applyOp(
			s,
			ent('e-mealplan', 'MealPlan', [
				{
					id: 'fld-mealplan-week',
					name: 'week',
					type: 'date',
					required: true,
					provenance: manual(),
				},
			]),
			meta(1),
		)
		s = applyOp(
			s,
			ent('e-recipe', 'Recipe', [
				{
					id: 'fld-recipe-name',
					name: 'name',
					type: 'string',
					required: true,
					provenance: manual(),
				},
				{
					id: 'fld-recipe-mealplan',
					name: 'mealplanId',
					type: 'string',
					required: false,
					reference: 'e-mealplan',
					provenance: manual(),
				},
			]),
			meta(2),
		)
		s = applyOp(
			s,
			ent('e-ingredient', 'Ingredient', [
				{
					id: 'fld-ingredient-name',
					name: 'name',
					type: 'string',
					required: true,
					provenance: manual(),
				},
				{
					id: 'fld-ingredient-qty',
					name: 'quantity',
					type: 'number',
					required: false,
					provenance: manual(),
				},
				{
					id: 'fld-ingredient-recipe',
					name: 'recipeId',
					type: 'string',
					required: false,
					reference: 'e-recipe',
					provenance: manual(),
				},
			]),
			meta(3),
		)
		return s
	}

	const shoppingList = (patch: Record<string, unknown> = {}): SpecOp => ({
		op: 'data.addRollup',
		args: {
			entityId: 'e-mealplan',
			rollup: {
				id: 'drv-mealplan-shopping',
				name: 'shoppingList',
				over: 'e-ingredient',
				via: ['fld-ingredient-recipe', 'fld-recipe-mealplan'],
				fn: 'sum',
				field: 'fld-ingredient-qty',
				groupBy: { field: 'fld-ingredient-name' },
				limit: 200,
				...patch,
			} as never,
		},
	})

	it('walks a two-hop path from ingredient up to meal plan', () => {
		const s = threeLevels()
		expect(validateOp(s, shoppingList())).toEqual([])
		const next = applyOp(s, shoppingList(), meta(4))
		expect(
			next.data.entities.find((e) => e.id === 'e-mealplan')?.rollups?.[0]?.via,
		).toEqual(['fld-ingredient-recipe', 'fld-recipe-mealplan'])
	})

	it('accepts a one-hop path written as a bare field id', () => {
		// The common case must stay ergonomic — no array ceremony for one hop.
		// A recipe's own ingredient count is one hop: ingredient → recipe.
		const oneHop: SpecOp = {
			op: 'data.addRollup',
			args: {
				entityId: 'e-recipe',
				rollup: {
					id: 'drv-recipe-ingredients',
					name: 'ingredientCount',
					over: 'e-ingredient',
					via: 'fld-ingredient-recipe',
					fn: 'count',
					provenance: manual(),
				} as never,
			},
		}
		expect(validateOp(threeLevels(), oneHop)).toEqual([])
	})

	it('rejects a path whose last hop lands on the wrong entity', () => {
		// One hop short: ingredient → recipe stops at recipe, not mealplan.
		expect(
			validateOp(
				threeLevels(),
				shoppingList({ via: ['fld-ingredient-recipe'] }),
			),
		).toContain(
			'data.addRollup: rollup "drv-mealplan-shopping" -> via[0] -> field "fld-ingredient-recipe" references "e-recipe", not "e-mealplan"; the last hop must land on the entity the rollup is exposed on',
		)
	})

	it('rejects a broken middle hop, naming its index', () => {
		expect(
			validateOp(
				threeLevels(),
				shoppingList({ via: ['fld-ingredient-name', 'fld-recipe-mealplan'] }),
			),
		).toContain(
			'data.addRollup: rollup "drv-mealplan-shopping" -> via[0] -> field "fld-ingredient-name" is not a reference, so it cannot relate e-ingredient to the next hop',
		)
	})

	it('rejects a hop that is not a field on the PREVIOUS hop’s target', () => {
		// `fld-ingredient-qty` lives on e-ingredient, not on e-recipe, so it is not
		// a valid second hop. The error names the entity it actually looked in.
		expect(
			validateOp(
				threeLevels(),
				shoppingList({ via: ['fld-ingredient-recipe', 'fld-ingredient-qty'] }),
			),
		).toContain(
			'data.addRollup: rollup "drv-mealplan-shopping" -> via[1] -> unknown field "fld-ingredient-qty" on e-recipe',
		)
	})

	it('bounds the path length — every hop is a join', () => {
		expect(
			validateOp(
				threeLevels(),
				shoppingList({
					via: [
						'fld-ingredient-recipe',
						'fld-recipe-mealplan',
						'fld-recipe-mealplan',
						'fld-recipe-mealplan',
					],
				}),
			),
		).toContain(
			'data.addRollup: rollup "drv-mealplan-shopping" -> via -> 4 hops exceeds the 3-hop cap (each hop is a join)',
		)
	})

	it('rejects an empty path rather than treating it as table-wide', () => {
		// Silently reinterpreting `via: []` as "table-wide" would turn a per-row
		// aggregate into the same number on every row — a wrong answer, not an error.
		expect(validateOp(threeLevels(), shoppingList({ via: [] }))).toContain(
			'data.addRollup: rollup "drv-mealplan-shopping" -> via -> empty path; omit "via" for a table-wide rollup',
		)
	})
})

// ===========================================================================
// The schedule ops — declared recurrence as spec-as-data
// ===========================================================================

const declareSchedule = (overrides: Record<string, unknown> = {}): SpecOp =>
	({
		op: 'schedules.declare',
		args: {
			schedule: {
				id: 'sch-invoice-run',
				key: 'invoice.recurring',
				description: 'Issue and send recurring invoices',
				timezone: 'America/New_York',
				recurrence: { kind: 'monthly', onDayOfMonth: 31, atTime: '09:00' },
				runAs: { kind: 'service', role: 'billing' },
				...overrides,
			},
		},
	}) as SpecOp

describe('schedules.declare', () => {
	it('declares a schedule and stamps declaredAt from the op', () => {
		const spec = applyOp(base(), declareSchedule(), meta(1))
		const declared = spec.schedules?.schedules ?? []
		expect(declared).toHaveLength(1)
		expect(declared[0]?.key).toBe('invoice.recurring')
		// Stamped, not authored: it is the anchor an interval counts from.
		expect(declared[0]?.declaredAt).toBe('2026-07-09')
		expect(() => validateSpecSystem(spec)).not.toThrow()
	})

	it('refuses a declaration with no runAs — the whole point of the field', () => {
		const errors = validateOp(base(), declareSchedule({ runAs: undefined }))
		expect(errors.join('\n')).toMatch(/runAs is required/)
	})

	it('refuses a service runAs with no role, and a user runAs with no userId', () => {
		expect(
			validateOp(
				base(),
				declareSchedule({ runAs: { kind: 'service' } }),
			).join(),
		).toMatch(/needs a non-empty role/)
		expect(
			validateOp(base(), declareSchedule({ runAs: { kind: 'user' } })).join(),
		).toMatch(/needs a non-empty userId/)
	})

	it('accepts a declared org, and a fan-out over every org', () => {
		expect(
			validateOp(
				base(),
				declareSchedule({
					runAs: { kind: 'service', role: 'billing', orgId: 'org-acme' },
				}),
			),
		).toEqual([])
		const fanned = applyOp(
			base(),
			declareSchedule({
				runAs: { kind: 'service', role: 'billing', eachOrg: true, maxOrgs: 25 },
			}),
			meta(1),
		)
		expect(fanned.schedules?.schedules[0]?.runAs).toMatchObject({
			eachOrg: true,
			maxOrgs: 25,
		})
	})

	it('refuses a runAs that declares both one org and every org', () => {
		// Two answers to "which tenant" and nothing that says which one wins. A
		// precedence rule here would be a rule nobody reads before declaring.
		expect(
			validateOp(
				base(),
				declareSchedule({
					runAs: {
						kind: 'service',
						role: 'billing',
						orgId: 'org-acme',
						eachOrg: true,
					},
				}),
			).join(),
		).toMatch(/both orgId and eachOrg/)
	})

	it('bounds the fan-out, and refuses a bound with no fan-out to bound', () => {
		expect(
			validateOp(
				base(),
				declareSchedule({
					runAs: {
						kind: 'service',
						role: 'billing',
						eachOrg: true,
						maxOrgs: 0,
					},
				}),
			).join(),
		).toMatch(/maxOrgs must be an integer/)
		expect(
			validateOp(
				base(),
				declareSchedule({
					runAs: {
						kind: 'service',
						role: 'billing',
						eachOrg: true,
						maxOrgs: 5000,
					},
				}),
			).join(),
		).toMatch(/maxOrgs must be an integer/)
		expect(
			validateOp(
				base(),
				declareSchedule({
					runAs: { kind: 'service', role: 'billing', maxOrgs: 10 },
				}),
			).join(),
		).toMatch(/bounds the eachOrg fan-out and there is none/)
	})

	it('refuses an unknown timezone rather than silently using the server’s', () => {
		expect(
			validateOp(base(), declareSchedule({ timezone: 'Mars/Olympus' })).join(),
		).toMatch(/unknown timezone/)
	})

	it('refuses a recurrence key that does not belong to its kind', () => {
		// The `theme.set` lesson: a declaration that says `everyMinute: 5` and
		// fires monthly is worse than one that fails to load.
		const errors = validateOp(
			base(),
			declareSchedule({
				recurrence: {
					kind: 'monthly',
					onDayOfMonth: 1,
					atTime: '09:00',
					everyMinutes: 5,
				},
			}),
		)
		expect(errors.join()).toMatch(/recurrence key "everyMinutes" is not valid/)
	})

	it('bounds an interval so it cannot be used to fake a calendar rule', () => {
		expect(
			validateOp(
				base(),
				declareSchedule({
					recurrence: { kind: 'interval', everyMinutes: 60 * 24 * 30 },
				}),
			).join(),
		).toMatch(/everyMinutes must be an integer/)
	})

	it('refuses a duplicate key and a duplicate id', () => {
		const spec = applyOp(base(), declareSchedule(), meta(1))
		expect(validateOp(spec, declareSchedule()).join()).toMatch(/already exists/)
		expect(
			validateOp(spec, declareSchedule({ id: 'sch-other' })).join(),
		).toMatch(/schedule key "invoice.recurring" already exists/)
	})

	it('refuses an entityId that does not resolve', () => {
		expect(
			validateOp(base(), declareSchedule({ entityId: 'e-nope' })).join(),
		).toMatch(/unknown entity "e-nope"/)
	})

	it('accepts an entityId that does resolve, so the declaration is about something', () => {
		const withEntity = applyOp(base(), entity, meta(1))
		const spec = applyOp(
			withEntity,
			declareSchedule({ entityId: 'e-invoice' }),
			meta(2),
		)
		expect(spec.schedules?.schedules[0]?.entityId).toBe('e-invoice')
		expect(() => validateSpecSystem(spec)).not.toThrow()
	})

	it('renders a diff a reviewer can read without decoding a cron string', () => {
		expect(diffOp(declareSchedule()).summary).toBe(
			'Declare schedule "invoice.recurring" (monthly on day 31 (clamped to month end) at 09:00 America/New_York)',
		)
	})
})

describe('schedules.setRecurrence / pause / remove', () => {
	const declared = (): SpecSystem => applyOp(base(), declareSchedule(), meta(1))

	it('replaces the recurrence wholesale, optionally moving the zone with it', () => {
		const spec = applyOp(
			declared(),
			{
				op: 'schedules.setRecurrence',
				args: {
					scheduleId: 'sch-invoice-run',
					recurrence: { kind: 'weekly', onWeekday: 1, atTime: '07:00' },
					timezone: 'UTC',
				},
			},
			meta(2),
		)
		expect(spec.schedules?.schedules[0]?.recurrence).toEqual({
			kind: 'weekly',
			onWeekday: 1,
			atTime: '07:00',
		})
		expect(spec.schedules?.schedules[0]?.timezone).toBe('UTC')
	})

	it('pauses and resumes, and a resumed schedule round-trips as if never paused', () => {
		const paused = applyOp(
			declared(),
			{
				op: 'schedules.pause',
				args: { scheduleId: 'sch-invoice-run', paused: true },
			},
			meta(2),
		)
		expect(paused.schedules?.schedules[0]?.paused).toBe(true)
		const resumed = applyOp(
			paused,
			{
				op: 'schedules.pause',
				args: { scheduleId: 'sch-invoice-run', paused: false },
			},
			meta(3),
		)
		expect(resumed.schedules?.schedules[0]).not.toHaveProperty('paused')
	})

	it('refuses to remove a schedule that is still active', () => {
		const errors = validateOp(declared(), {
			op: 'schedules.remove',
			args: { scheduleId: 'sch-invoice-run' },
		})
		expect(errors.join()).toMatch(/still active — pause it/)
	})

	it('removes a paused schedule', () => {
		const paused = applyOp(
			declared(),
			{
				op: 'schedules.pause',
				args: { scheduleId: 'sch-invoice-run', paused: true },
			},
			meta(2),
		)
		const removed = applyOp(
			paused,
			{ op: 'schedules.remove', args: { scheduleId: 'sch-invoice-run' } },
			meta(3),
		)
		expect(removed.schedules?.schedules).toEqual([])
		// The removal is still auditable — the op log keeps the diff.
		expect(removed.opLog.at(-1)?.diff.change).toBe('remove')
	})

	it('names an unknown schedule rather than failing silently', () => {
		for (const op of [
			{
				op: 'schedules.setRecurrence',
				args: {
					scheduleId: 'sch-nope',
					recurrence: { kind: 'daily', atTime: '09:00' },
				},
			},
			{ op: 'schedules.pause', args: { scheduleId: 'sch-nope', paused: true } },
			{ op: 'schedules.remove', args: { scheduleId: 'sch-nope' } },
		] as SpecOp[]) {
			expect(validateOp(base(), op).join()).toMatch(
				/unknown schedule "sch-nope"/,
			)
		}
	})
})

// ===========================================================================
// External data sources
// ===========================================================================
//
// The two gates get the most tests here, and deliberately so. Everything else
// in this op family is a shape check; those two are the ones where being wrong
// is not a bad error message but a credential in a git history and a request
// issued at the cloud metadata endpoint.

/** A spec with a Book entity to hang a source off. */
const bookSpec = (): SpecSystem =>
	applyOp(
		base(),
		{
			op: 'data.addEntity',
			args: {
				entity: {
					id: 'e-book',
					name: 'Book',
					fields: [
						{
							id: 'fld-book-isbn',
							name: 'isbn',
							type: 'string',
							required: true,
						},
						{
							id: 'fld-book-title',
							name: 'title',
							type: 'string',
							required: true,
						},
						{
							id: 'fld-book-pages',
							name: 'pages',
							type: 'number',
							required: false,
						},
						{
							id: 'fld-book-cover',
							name: 'coverUrl',
							type: 'string',
							required: false,
						},
					],
				},
			},
		} as SpecOp,
		meta(1),
	)

const LIMITS = {
	requestsPerMinute: 60,
	timeoutMs: 5000,
	maxAttempts: 3,
	backoffMs: 1000,
}

const declareSource = (overrides: Record<string, unknown> = {}): SpecOp =>
	({
		op: 'sources.declare',
		args: {
			source: {
				id: 'src-isbn',
				key: 'isbn.lookup',
				description: 'Fetch cover art and metadata for a book by ISBN.',
				mode: 'enrich',
				entityId: 'e-book',
				request: { url: 'https://openlibrary.org/isbn/{isbn}.json' },
				auth: { kind: 'none' },
				mapping: [
					{ from: 'title', to: 'fld-book-title' },
					{ from: 'number_of_pages', to: 'fld-book-pages' },
					{ from: 'covers[0]', to: 'fld-book-cover' },
				],
				limits: LIMITS,
				triggers: [{ kind: 'create' }, { kind: 'manual' }],
				inputField: 'fld-book-isbn',
				...overrides,
			},
		},
	}) as SpecOp

describe('sources.declare', () => {
	it('declares an enrichment source and stamps declaredAt from the op', () => {
		const spec = applyOp(bookSpec(), declareSource(), meta(2))
		const declared = spec.sources?.sources ?? []
		expect(declared).toHaveLength(1)
		expect(declared[0]?.key).toBe('isbn.lookup')
		expect(declared[0]?.declaredAt).toBe('2026-07-09')
		expect(() => validateSpecSystem(spec)).not.toThrow()
	})

	it('a project that never declared one grows no sources layer at all', () => {
		expect(bookSpec().sources).toBeUndefined()
	})

	// ---- gate 1: the spec must never contain a secret ------------------------

	it('refuses a credential header even when its value is innocuous', () => {
		// The name is refused, not just the value. A scan clever enough to
		// recognize every credential format is a scan that will one day meet a
		// format it does not know.
		const errors = validateOp(
			bookSpec(),
			declareSource({
				request: {
					url: 'https://api.example.com/books/{isbn}',
					headers: { Authorization: 'see the deployment secret' },
				},
			}),
		)
		expect(errors.join('\n')).toMatch(
			/header "Authorization" is a credential header/,
		)
	})

	it('refuses a credential query parameter by name', () => {
		expect(
			validateOp(
				bookSpec(),
				declareSource({
					request: {
						url: 'https://api.example.com/books/{isbn}',
						query: { api_key: 'set-me-later' },
					},
				}),
			).join('\n'),
		).toMatch(/query parameter "api_key" is a credential parameter/)
	})

	it.each([
		['a Bearer token', { 'X-Trace': 'Bearer abc123def456' }],
		['a GitHub token', { 'X-Trace': 'ghp_abcdefghijklmnopqrstuvwxyz0123' }],
		['an AWS key id', { 'X-Trace': 'AKIAIOSFODNN7EXAMPLE' }],
		[
			'a JWT',
			{
				'X-Trace':
					'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij',
			},
		],
		[
			'an opaque high-entropy blob',
			{ 'X-Trace': 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z' },
		],
	])('refuses %s smuggled into a header value', (_what, headers) => {
		expect(
			validateOp(
				bookSpec(),
				declareSource({
					request: { url: 'https://api.example.com/books/{isbn}', headers },
				}),
			).join('\n'),
		).toMatch(/contains .* — name the credential with `auth`/)
	})

	it('refuses credentials embedded in the URL', () => {
		expect(
			validateOp(
				bookSpec(),
				declareSource({
					request: { url: 'https://user:hunter2@api.example.com/books' },
				}),
			).join('\n'),
		).toMatch(/embeds credentials/)
	})

	it('refuses a secretName that is obviously a secret VALUE', () => {
		expect(
			validateOp(
				bookSpec(),
				declareSource({
					auth: {
						kind: 'bearer',
						secretName: 'ghp_abcdefghijklmnopqrstuvwxyz0123',
					},
				}),
			).join('\n'),
		).toMatch(/must match .* it is the NAME of a secret/)
	})

	it('does not echo the rejected string back in full', () => {
		// A validation error is written to a log, and a log is not a secret store.
		const leaked = 'ghp_abcdefghijklmnopqrstuvwxyz0123'
		const errors = validateOp(
			bookSpec(),
			declareSource({ auth: { kind: 'bearer', secretName: leaked } }),
		)
		expect(errors.join('\n')).not.toContain(leaked)
	})

	it('accepts a credential referenced by NAME', () => {
		const spec = applyOp(
			bookSpec(),
			declareSource({
				auth: { kind: 'bearer', secretName: 'OPENLIBRARY_TOKEN' },
			}),
			meta(2),
		)
		expect(spec.sources?.sources[0]?.auth).toEqual({
			kind: 'bearer',
			secretName: 'OPENLIBRARY_TOKEN',
		})
	})

	it('does not mistake an ordinary long path segment for a secret', () => {
		// A check people learn to work around is worse than no check. A 32+
		// character lowercase run is a slug, not a credential.
		expect(
			looksLikeSecret('this-is-a-long-but-perfectly-ordinary-slug-name'),
		).toBeNull()
	})

	// ---- gate 2: the endpoint is an SSRF surface ------------------------------

	it.each([
		'http://api.example.com/books',
		'https://127.0.0.1/books',
		'https://localhost/books',
		'https://169.254.169.254/latest/meta-data/',
		'https://2130706433/books',
		'https://[::1]/books',
		'https://10.0.0.5/books',
		'https://api.internal/books',
		'https://api.example.com:5432/books',
	])('refuses the endpoint %s', (url) => {
		expect(
			validateOp(bookSpec(), declareSource({ request: { url } })).length,
		).toBeGreaterThan(0)
	})

	it('names the metadata endpoint specifically rather than generically', () => {
		expect(
			validateOp(
				bookSpec(),
				declareSource({ request: { url: 'https://169.254.169.254/latest/' } }),
			).join('\n'),
		).toMatch(/is an internal address/)
	})

	// ---- the typed mapping ----------------------------------------------------

	it('refuses a mapping onto a field the entity does not have', () => {
		expect(
			validateOp(
				bookSpec(),
				declareSource({ mapping: [{ from: 'title', to: 'fld-nope' }] }),
			).join('\n'),
		).toMatch(/mapping to unknown field "fld-nope"/)
	})

	it('refuses a path that is a query language rather than a path', () => {
		for (const from of ['$..title', 'a.*.b', 'authors[*]', '']) {
			expect(
				validateOp(
					bookSpec(),
					declareSource({ mapping: [{ from, to: 'fld-book-title' }] }),
				).join('\n'),
			).toMatch(/is not a response path/)
		}
	})

	it('refuses two mappings writing the same field — the later one would win silently', () => {
		expect(
			validateOp(
				bookSpec(),
				declareSource({
					mapping: [
						{ from: 'title', to: 'fld-book-title' },
						{ from: 'full_title', to: 'fld-book-title' },
					],
				}),
			).join('\n'),
		).toMatch(/two mappings write field/)
	})

	it('refuses a source that maps nothing', () => {
		expect(
			validateOp(bookSpec(), declareSource({ mapping: [] })).join('\n'),
		).toMatch(/at least one mapping/)
	})

	// ---- limits are declared, not inherited ----------------------------------

	it('refuses a declaration with no limits', () => {
		expect(
			validateOp(bookSpec(), declareSource({ limits: undefined })).join('\n'),
		).toMatch(/limits are required/)
	})

	it.each([
		['requestsPerMinute', 100_000],
		['timeoutMs', 600_000],
		['maxAttempts', 99],
		['backoffMs', 1],
	])('bounds limits.%s', (key, value) => {
		expect(
			validateOp(
				bookSpec(),
				declareSource({ limits: { ...LIMITS, [key]: value } }),
			).join('\n'),
		).toMatch(new RegExp(`limits\\.${key} must be an integer`))
	})

	// ---- mode / trigger agreement --------------------------------------------

	it('refuses a sync trigger on an enrichment source and vice versa', () => {
		expect(
			validateOp(
				bookSpec(),
				declareSource({
					triggers: [{ kind: 'schedule', scheduleKey: 'nightly' }],
				}),
			).join('\n'),
		).toMatch(/is not legal in enrich mode/)
	})

	it('refuses a schedule trigger naming a schedule nobody declared', () => {
		const spec = bookSpec()
		expect(
			validateOp(
				spec,
				declareSource({
					mode: 'sync',
					inputField: undefined,
					collection: {
						idPath: 'id',
						idField: 'fld-book-isbn',
						maxRecords: 100,
					},
					request: { url: 'https://api.example.com/books' },
					triggers: [{ kind: 'schedule', scheduleKey: 'nightly.books' }],
				}),
			).join('\n'),
		).toMatch(/undeclared schedule "nightly.books"/)
	})

	it('refuses an enrichment with no inputField', () => {
		expect(
			validateOp(bookSpec(), declareSource({ inputField: undefined })).join(
				'\n',
			),
		).toMatch(/enrich mode needs an inputField/)
	})

	it('refuses a sync with no collection — that is the duplicate-rows bug', () => {
		expect(
			validateOp(
				bookSpec(),
				declareSource({
					mode: 'sync',
					inputField: undefined,
					request: { url: 'https://api.example.com/books' },
					triggers: [{ kind: 'webhook' }],
				}),
			).join('\n'),
		).toMatch(/sync mode needs a collection/)
	})

	it('refuses a non-string remote id column', () => {
		expect(
			validateOp(
				bookSpec(),
				declareSource({
					mode: 'sync',
					inputField: undefined,
					request: { url: 'https://api.example.com/books' },
					triggers: [{ kind: 'webhook' }],
					collection: {
						idPath: 'id',
						idField: 'fld-book-pages',
						maxRecords: 10,
					},
				}),
			).join('\n'),
		).toMatch(/a remote id is an opaque string/)
	})

	it('refuses a placeholder a sync has no row to resolve', () => {
		expect(
			validateOp(
				bookSpec(),
				declareSource({
					mode: 'sync',
					inputField: undefined,
					request: { url: 'https://api.example.com/books/{isbn}' },
					triggers: [{ kind: 'webhook' }],
					collection: {
						idPath: 'id',
						idField: 'fld-book-isbn',
						maxRecords: 10,
					},
				}),
			).join('\n'),
		).toMatch(/no triggering row to resolve them from/)
	})

	it('refuses a placeholder naming a field the entity does not have', () => {
		expect(
			validateOp(
				bookSpec(),
				declareSource({
					request: { url: 'https://openlibrary.org/isbn/{barcode}.json' },
				}),
			).join('\n'),
		).toMatch(/placeholder "\{barcode\}" is not a field name/)
	})

	it('refuses a duplicate id or key', () => {
		const declared = applyOp(bookSpec(), declareSource(), meta(2))
		expect(validateOp(declared, declareSource()).join('\n')).toMatch(
			/duplicate source id|already exists/,
		)
		expect(
			validateOp(declared, declareSource({ id: 'src-other' })).join('\n'),
		).toMatch(/source key "isbn.lookup" already exists/)
	})
})

describe('sources.setMapping / setLimits / pause / remove', () => {
	const declared = (): SpecSystem =>
		applyOp(bookSpec(), declareSource(), meta(2))

	it('replaces the mapping wholesale', () => {
		const spec = applyOp(
			declared(),
			{
				op: 'sources.setMapping',
				args: {
					sourceId: 'src-isbn',
					mapping: [{ from: 'full_title', to: 'fld-book-title' }],
				},
			},
			meta(3),
		)
		expect(spec.sources?.sources[0]?.mapping).toEqual([
			{ from: 'full_title', to: 'fld-book-title' },
		])
	})

	it('re-validates the whole declaration, not the mapping in isolation', () => {
		// A mapping is only correct relative to the entity it writes.
		expect(
			validateOp(declared(), {
				op: 'sources.setMapping',
				args: {
					sourceId: 'src-isbn',
					mapping: [{ from: 'title', to: 'fld-nope' }],
				},
			}).join('\n'),
		).toMatch(/mapping to unknown field/)
	})

	it('replaces the limits wholesale and bounds the replacement', () => {
		const spec = applyOp(
			declared(),
			{
				op: 'sources.setLimits',
				args: {
					sourceId: 'src-isbn',
					limits: { ...LIMITS, requestsPerMinute: 6 },
				},
			},
			meta(3),
		)
		expect(spec.sources?.sources[0]?.limits.requestsPerMinute).toBe(6)
		expect(
			validateOp(declared(), {
				op: 'sources.setLimits',
				args: {
					sourceId: 'src-isbn',
					limits: { ...LIMITS, requestsPerMinute: 100_000 },
				},
			}).join('\n'),
		).toMatch(/limits.requestsPerMinute must be an integer/)
	})

	it('pausing keeps the declaration; resuming round-trips byte-identical', () => {
		const paused = applyOp(
			declared(),
			{ op: 'sources.pause', args: { sourceId: 'src-isbn', paused: true } },
			meta(3),
		)
		expect(paused.sources?.sources[0]?.paused).toBe(true)
		expect(activeSources(paused)).toHaveLength(0)
		const resumed = applyOp(
			paused,
			{ op: 'sources.pause', args: { sourceId: 'src-isbn', paused: false } },
			meta(4),
		)
		expect(resumed.sources?.sources[0]).toEqual(declared().sources?.sources[0])
	})

	it('refuses to remove an active source — pause first, then confirm, then remove', () => {
		expect(
			validateOp(declared(), {
				op: 'sources.remove',
				args: { sourceId: 'src-isbn' },
			}).join('\n'),
		).toMatch(/is still active — pause it/)
		const paused = applyOp(
			declared(),
			{ op: 'sources.pause', args: { sourceId: 'src-isbn', paused: true } },
			meta(3),
		)
		const removed = applyOp(
			paused,
			{ op: 'sources.remove', args: { sourceId: 'src-isbn' } },
			meta(4),
		)
		expect(removed.sources?.sources).toEqual([])
	})

	it('names an unknown source rather than failing silently', () => {
		for (const op of [
			{ op: 'sources.setMapping', args: { sourceId: 'src-nope', mapping: [] } },
			{
				op: 'sources.setLimits',
				args: { sourceId: 'src-nope', limits: LIMITS },
			},
			{ op: 'sources.pause', args: { sourceId: 'src-nope', paused: true } },
			{ op: 'sources.remove', args: { sourceId: 'src-nope' } },
		] as SpecOp[]) {
			expect(validateOp(bookSpec(), op).join()).toMatch(
				/unknown source "src-nope"/,
			)
		}
	})
})

/**
 * Issue #345 — a number field's *name* used to pick its widget, unopposably,
 * and the scale that widget drew on was unreachable from the spec: `meta.max`
 * existed in the runtime and no op wrote field metadata, so an app rating books
 * out of 10 got a 5-star widget and no sentence that could say otherwise.
 */
describe('number field presentation — data.setFieldDisplay', () => {
	const book: SpecOp = {
		op: 'data.addEntity',
		args: {
			entity: {
				id: 'e-book',
				name: 'Book',
				description: 'A book on the shelf',
				fields: [
					{
						id: 'fld-book-title',
						name: 'title',
						type: 'string',
						required: true,
						provenance: suggested(),
					},
					{
						id: 'fld-book-rating',
						name: 'rating',
						type: 'number',
						required: false,
						provenance: suggested(),
					},
				],
				provenance: suggested(),
			},
		},
	}
	const withBook = () => applyOp(base(), book, meta(1))
	const setDisplay = (
		display: Record<string, unknown>,
		fieldId = 'fld-book-rating',
	): SpecOp =>
		({
			op: 'data.setFieldDisplay',
			args: { entityId: 'e-book', fieldId, display },
		}) as SpecOp

	it('declares a scale the field library can read', () => {
		const s = applyOp(
			withBook(),
			setDisplay({ format: 'rating', max: 10 }),
			meta(2),
		)
		const field = s.data.entities
			.find((e) => e.id === 'e-book')
			?.fields.find((f) => f.id === 'fld-book-rating')
		expect(field?.display).toEqual({ format: 'rating', max: 10 })
		expect(validateSpecSystem(s)).toBe(s)
	})

	it('is the escape hatch from the name heuristic', () => {
		const s = applyOp(withBook(), setDisplay({ format: 'number' }), meta(2))
		expect(
			s.data.entities
				.find((e) => e.id === 'e-book')
				?.fields.find((f) => f.id === 'fld-book-rating')?.display,
		).toEqual({ format: 'number' })
	})

	it('is last-wins, and {} returns the field to inference', () => {
		const declared = applyOp(
			withBook(),
			setDisplay({ format: 'rating', max: 10 }),
			meta(2),
		)
		// An omitted `max` on a second call means "no declared max" — merging
		// would make removing a bound impossible without knowing what it was.
		const narrowed = applyOp(
			declared,
			setDisplay({ format: 'slider' }),
			meta(3),
		)
		const find = (spec: SpecSystem) =>
			spec.data.entities
				.find((e) => e.id === 'e-book')
				?.fields.find((f) => f.id === 'fld-book-rating')
		expect(find(narrowed)?.display).toEqual({ format: 'slider' })
		const cleared = applyOp(narrowed, setDisplay({}), meta(4))
		// The key is deleted rather than set to `{}`, so a field returned to
		// inference encodes exactly as it did before it was ever declared.
		const back = find(cleared)
		expect(back && 'display' in back).toBe(false)
	})

	it('refuses display on a field that is not a number', () => {
		expect(
			validateOp(
				withBook(),
				setDisplay({ format: 'rating' }, 'fld-book-title'),
			),
		).toContain(
			'data.setFieldDisplay: field "fld-book-title" -> only a "number" field may declare display (got "string") — every declarable format is a way of drawing a number',
		)
	})

	it('refuses an unknown format and a range that is not one', () => {
		expect(
			validateOp(withBook(), setDisplay({ format: 'stars' })).join(),
		).toMatch(/display.format "stars" is not one of number, grouped/)
		expect(
			validateOp(withBook(), setDisplay({ min: 10, max: 1 })).join(),
		).toMatch(/display.min \(10\) must be below display.max \(1\)/)
		expect(validateOp(withBook(), setDisplay({ step: 0 })).join()).toMatch(
			/display.step must be positive/,
		)
		expect(
			validateOp(withBook(), setDisplay({ format: 'rating', max: 0 })).join(),
		).toMatch(/a rating's display.max must be positive/)
	})

	it('names an unknown entity or field rather than failing silently', () => {
		expect(
			validateOp(withBook(), setDisplay({ format: 'number' }, 'fld-nope')),
		).toContain('data.setFieldDisplay: unknown field "fld-nope" on e-book')
	})

	it('validates a display declared inline on data.addField', () => {
		expect(
			validateOp(withBook(), {
				op: 'data.addField',
				args: {
					entityId: 'e-book',
					field: {
						id: 'fld-book-pages',
						name: 'pages',
						type: 'number',
						required: false,
						display: { format: 'grouped' },
					},
				},
			}),
		).toEqual([])
	})

	it('round-trips through the spec directory codec', () => {
		const s = applyOp(
			withBook(),
			setDisplay({ format: 'rating', max: 10, step: 0.5 }),
			meta(2),
		)
		const back = decodeSpecSystem(encodeSpecSystem(s))
		expect(
			back.data.entities
				.find((e) => e.id === 'e-book')
				?.fields.find((f) => f.id === 'fld-book-rating')?.display,
		).toEqual({ format: 'rating', max: 10, step: 0.5 })
	})

	it('summarizes the declaration in the diff', () => {
		expect(diffOp(setDisplay({ format: 'rating', max: 10 })).summary).toBe(
			'Display field "fld-book-rating" as a rating max 10',
		)
		expect(diffOp(setDisplay({})).summary).toMatch(/falls back to inference/)
	})
})
