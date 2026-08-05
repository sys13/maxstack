import { specSchemaDdl } from '@maxstack/core'
import { bundle } from '@maxstack/features'
import {
	accept,
	type DocumentSection,
	type EntitySpec,
	type FieldSpec,
	type ImporterSpec,
	manual,
	newSpecSystem,
	type SpecSystem,
	suggested,
} from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import { describe, expect, it } from 'vitest'
import {
	groundedEntityShapes,
	missingReferenceBundles,
	schemaFingerprint,
} from './spec-sprout'

function specWith(entities: EntitySpec[]): SpecSystem {
	const spec = newSpecSystem(tasklyPRD)
	return { ...spec, data: { entities } }
}

const titleField: FieldSpec = {
	id: 'fld-title',
	name: 'title',
	type: 'string',
	required: true,
	provenance: suggested(),
}

const urlField: FieldSpec = {
	id: 'fld-url',
	name: 'url',
	type: 'string',
	required: false,
	provenance: suggested(),
}

const readingItem: EntitySpec = {
	id: 'e-reading-item',
	name: 'ReadingItem',
	provenance: suggested(),
	fields: [titleField, urlField],
}

describe('groundedEntityShapes', () => {
	it('grounds on all rows while nothing is decided, with pageDescriptor-aligned names', () => {
		const shapes = groundedEntityShapes(specWith([readingItem]))
		expect(shapes).toEqual([
			{
				name: 'reading-item',
				description: undefined,
				fields: [
					{ name: 'title', type: 'string', required: true },
					{ name: 'url', type: 'string', required: false },
				],
			},
		])
	})

	it('narrows to accepted + manual fields once any field is decided', () => {
		const decided: EntitySpec = {
			...readingItem,
			fields: [
				{ ...titleField, provenance: accept(suggested()) },
				{ ...urlField }, // still undecided → drops out
				{
					id: 'fld-notes',
					name: 'notes',
					type: 'string',
					required: false,
					provenance: manual(), // manual counts as accepted
				},
			],
		}
		const [shape] = groundedEntityShapes(specWith([decided]))
		expect(shape?.fields.map((f) => f.name)).toEqual(['title', 'notes'])
	})

	it('grounds an entity↔entity reference to the target table + title field', () => {
		const note: EntitySpec = {
			id: 'e-note',
			name: 'Note',
			provenance: suggested(),
			fields: [
				titleField,
				{
					id: 'fld-item',
					name: 'itemId',
					type: 'string',
					required: false,
					reference: 'e-reading-item',
					provenance: suggested(),
				},
			],
		}
		const shapes = groundedEntityShapes(specWith([readingItem, note]))
		const itemId = shapes[1]?.fields.find((f) => f.name === 'itemId')
		expect(itemId?.reference).toEqual({
			table: 'reading-item',
			column: 'id',
			displayField: 'title',
		})
	})

	it('fingerprint is stable across re-grounds and moves when the schema grows', () => {
		const a = schemaFingerprint(groundedEntityShapes(specWith([readingItem])))
		const b = schemaFingerprint(groundedEntityShapes(specWith([readingItem])))
		expect(a).toBe(b)
		const grown: EntitySpec = {
			...readingItem,
			fields: [
				...readingItem.fields,
				{
					id: 'fld-status',
					name: 'status',
					type: 'string',
					required: false,
					provenance: suggested(),
				},
			],
		}
		expect(schemaFingerprint(groundedEntityShapes(specWith([grown])))).not.toBe(
			a,
		)
	})
})

describe('bundle organization references', () => {
	/** The members bundle folded into an empty spec, the way `maxstack add` does. */
	function membersSpec(): SpecSystem {
		let spec = newSpecSystem(tasklyPRD, { autoAccept: true })
		for (const slug of ['auth', 'members'] as const) {
			spec = bundle.applyBundle(spec, bundle.BUNDLES[slug] as never, {
				appliedAt: '2026-07-28',
			})
		}
		return spec
	}

	const refOf = (
		shapes: ReturnType<typeof groundedEntityShapes>,
		table: string,
		field: string,
	) =>
		shapes.find((s) => s.name === table)?.fields.find((f) => f.name === field)
			?.reference

	it('grounds member.organizationId to the organization table with a display field', () => {
		// The mechanical form of "<ReferenceField> renders the org's name instead
		// of a raw id": the read side resolves `displayField` off this shape.
		const shapes = groundedEntityShapes(membersSpec(), {
			installedBundles: ['auth', 'members'],
		})
		expect(refOf(shapes, 'member', 'organizationId')).toEqual({
			table: 'organization',
			column: 'id',
			displayField: 'name',
		})
		expect(refOf(shapes, 'invitation', 'organizationId')?.table).toBe(
			'organization',
		)
	})

	it('grounds member.userId to the auth user, which stays a text id', () => {
		const shapes = groundedEntityShapes(membersSpec(), {
			installedBundles: ['auth', 'members'],
		})
		expect(refOf(shapes, 'member', 'userId')).toMatchObject({
			table: 'user',
			idType: 'text',
		})
	})

	it('emits a uuid column for the org FK and a text one for the user FK', () => {
		// The two halves of #208: one reference changes the column type and needs
		// the guarded reconciliation, the other was always free.
		const ddl = specSchemaDdl(
			groundedEntityShapes(membersSpec(), {
				installedBundles: ['auth', 'members'],
			}),
		)
		expect(ddl).toContain('ADD COLUMN IF NOT EXISTS "organizationId" uuid')
		expect(ddl).toContain('ADD COLUMN IF NOT EXISTS "userId" text')
		expect(ddl).toContain('USING "organizationId"::uuid')
	})
})

describe('virtual user references', () => {
	const post: EntitySpec = {
		id: 'e-post',
		name: 'Post',
		provenance: suggested(),
		fields: [
			titleField,
			{
				id: 'fld-owner',
				name: 'ownerId',
				type: 'string',
				required: false,
				reference: 'e-user',
				provenance: suggested(),
			},
		],
	}
	const ownerRef = (shapes: ReturnType<typeof groundedEntityShapes>) =>
		shapes[0]?.fields.find((f) => f.name === 'ownerId')?.reference

	it('grounds e-user to the auth bundle user table when auth is installed', () => {
		const shapes = groundedEntityShapes(specWith([post]), {
			installedBundles: ['auth'],
		})
		expect(ownerRef(shapes)).toEqual({
			table: 'user',
			column: 'id',
			displayField: 'name',
			idType: 'text',
		})
	})

	it('treats virtual entities as available when no bundle list is given', () => {
		const shapes = groundedEntityShapes(specWith([post]))
		expect(ownerRef(shapes)?.table).toBe('user')
	})

	it('falls back to a plain column when the auth bundle is not installed', () => {
		const shapes = groundedEntityShapes(specWith([post]), {
			installedBundles: [],
		})
		expect(ownerRef(shapes)).toBeUndefined()
		expect(shapes[0]?.fields.find((f) => f.name === 'ownerId')?.type).toBe(
			'string',
		)
	})

	it('a spec-declared e-user entity shadows the virtual one', () => {
		const ownUser: EntitySpec = {
			id: 'e-user',
			name: 'User',
			provenance: suggested(),
			fields: [
				{
					id: 'fld-handle',
					name: 'handle',
					type: 'string',
					required: true,
					provenance: suggested(),
				},
			],
		}
		const shapes = groundedEntityShapes(specWith([post, ownUser]), {
			installedBundles: [],
		})
		expect(ownerRef(shapes)).toEqual({
			table: 'user',
			column: 'id',
			displayField: 'handle',
		})
	})

	it('missingReferenceBundles names auth when referenced but not installed', () => {
		const spec = specWith([post])
		expect(missingReferenceBundles(spec, [])).toEqual(['auth'])
		expect(missingReferenceBundles(spec, ['auth'])).toEqual([])
		expect(missingReferenceBundles(specWith([readingItem]), [])).toEqual([])
	})
})

// ===========================================================================
// Derived-value grounding
// ===========================================================================

const qtyField: FieldSpec = {
	id: 'fld-ingredient-qty',
	name: 'quantity',
	type: 'number',
	required: false,
	provenance: suggested(),
}

const recipeFk: FieldSpec = {
	id: 'fld-ingredient-recipe',
	name: 'recipeId',
	type: 'string',
	required: false,
	reference: 'e-recipe',
	provenance: suggested(),
}

const mealplanFk: FieldSpec = {
	id: 'fld-recipe-mealplan',
	name: 'mealplanId',
	type: 'string',
	required: false,
	reference: 'e-mealplan',
	provenance: suggested(),
}

/** The recipebox three-level graph, with a two-hop shopping-list rollup. */
function recipeboxSpec(
	overrides: {
		rollup?: Partial<NonNullable<EntitySpec['rollups']>[number]>
		ingredientFields?: FieldSpec[]
	} = {},
): SpecSystem {
	const mealplan: EntitySpec = {
		id: 'e-mealplan',
		name: 'MealPlan',
		provenance: suggested(),
		fields: [titleField],
		rollups: [
			{
				id: 'drv-shopping',
				name: 'shoppingList',
				over: 'e-ingredient',
				via: ['fld-ingredient-recipe', 'fld-recipe-mealplan'],
				fn: 'sum',
				field: 'fld-ingredient-qty',
				groupBy: { field: 'fld-ingredient-name' },
				limit: 200,
				provenance: suggested(),
				...overrides.rollup,
			},
		],
	}
	const recipe: EntitySpec = {
		id: 'e-recipe',
		name: 'Recipe',
		provenance: suggested(),
		fields: [titleField, mealplanFk],
	}
	const ingredient: EntitySpec = {
		id: 'e-ingredient',
		name: 'Ingredient',
		provenance: suggested(),
		fields: overrides.ingredientFields ?? [
			{ ...titleField, id: 'fld-ingredient-name', name: 'name' },
			qtyField,
			recipeFk,
		],
	}
	return specWith([mealplan, recipe, ingredient])
}

describe('groundedEntityShapes — rollups', () => {
	it('resolves ids to column names and each hop to its target table', () => {
		const shapes = groundedEntityShapes(recipeboxSpec())
		const plan = shapes.find((s) => s.name === 'mealplan')
		expect(plan?.rollups).toEqual([
			{
				name: 'shoppingList',
				over: 'ingredient',
				via: [
					{ column: 'recipeId', table: 'recipe' },
					{ column: 'mealplanId', table: 'mealplan' },
				],
				fn: 'sum',
				column: 'quantity',
				groupBy: { column: 'name', bucket: undefined },
				limit: 200,
			},
		])
	})

	// A derived value is never a stored column, so it must not reach the DDL.
	it('adds no fields, so the additive DDL is unchanged', () => {
		const shapes = groundedEntityShapes(recipeboxSpec())
		const plan = shapes.find((s) => s.name === 'mealplan')
		expect(plan?.fields.map((f) => f.name)).toEqual(['title'])
	})

	it('omits the keys entirely for an entity with no derived values', () => {
		const [shape] = groundedEntityShapes(specWith([readingItem]))
		expect(shape).not.toHaveProperty('rollups')
		expect(shape).not.toHaveProperty('computed')
	})

	// The op validator proved every reference at apply time, so an unresolvable
	// target means something was soft-rejected afterwards. Showing an aggregate
	// over a relation that no longer exists is worse than showing nothing.
	describe('drops rather than degrades when a target stops resolving', () => {
		it('drops a rollup whose aggregated entity is gone', () => {
			const spec = recipeboxSpec()
			spec.data.entities = spec.data.entities.filter(
				(e) => e.id !== 'e-ingredient',
			)
			const plan = groundedEntityShapes(spec).find((s) => s.name === 'mealplan')
			expect(plan?.rollups).toEqual([])
		})

		it('drops a rollup whose aggregated column was soft-rejected', () => {
			// The siblings must be ACCEPTED for this to bite: `getAcceptedOrAll` falls
			// back to every row while nothing is decided, so a rejected field in an
			// all-undecided entity still grounds. That is the established
			// grounding semantics, not something rollups should special-case.
			const spec = recipeboxSpec({
				ingredientFields: [
					{
						...titleField,
						id: 'fld-ingredient-name',
						name: 'name',
						provenance: accept(suggested()),
					},
					{ ...qtyField, provenance: { ...suggested(), isAccepted: false } },
					{ ...recipeFk, provenance: accept(suggested()) },
				],
			})
			const plan = groundedEntityShapes(spec).find((s) => s.name === 'mealplan')
			expect(plan?.rollups).toEqual([])
		})

		it('drops a rollup whose via hop is no longer a reference', () => {
			const spec = recipeboxSpec({
				ingredientFields: [
					{ ...titleField, id: 'fld-ingredient-name', name: 'name' },
					qtyField,
					{ ...recipeFk, reference: undefined },
				],
			})
			const plan = groundedEntityShapes(spec).find((s) => s.name === 'mealplan')
			expect(plan?.rollups).toEqual([])
		})

		it('drops a rollup whose group-by key is gone', () => {
			const spec = recipeboxSpec({
				rollup: { groupBy: { field: 'fld-ghost' }, limit: 10 },
			})
			const plan = groundedEntityShapes(spec).find((s) => s.name === 'mealplan')
			expect(plan?.rollups).toEqual([])
		})

		it('drops a rollup whose filter field is gone', () => {
			const spec = recipeboxSpec({
				rollup: { where: [{ field: 'fld-ghost', equals: 'x' }] },
			})
			const plan = groundedEntityShapes(spec).find((s) => s.name === 'mealplan')
			expect(plan?.rollups).toEqual([])
		})
	})

	it('grounds a one-hop `via` written as a bare id', () => {
		const spec = recipeboxSpec({
			rollup: {
				over: 'e-ingredient',
				via: 'fld-ingredient-recipe',
				groupBy: undefined,
				limit: undefined,
				field: undefined,
				fn: 'count',
			},
		})
		// Exposed on mealplan in this fixture, but the hop shape is what matters.
		const plan = groundedEntityShapes(spec).find((s) => s.name === 'mealplan')
		expect(plan?.rollups?.[0]?.via).toEqual([
			{ column: 'recipeId', table: 'recipe' },
		])
		expect(plan?.rollups?.[0]?.fn).toBe('count')
	})

	it('grounds a table-wide rollup with no via at all', () => {
		const spec = recipeboxSpec({
			rollup: {
				via: undefined,
				fn: 'count',
				field: undefined,
				groupBy: undefined,
				limit: undefined,
			},
		})
		const plan = groundedEntityShapes(spec).find((s) => s.name === 'mealplan')
		expect(plan?.rollups?.[0]).not.toHaveProperty('via')
	})
})

describe('groundedEntityShapes — computed fields', () => {
	/** gymlog's Epley estimate over a log entry's own columns. */
	function gymlogSpec(expr?: unknown): SpecSystem {
		const logentry: EntitySpec = {
			id: 'e-logentry',
			name: 'LogEntry',
			provenance: suggested(),
			fields: [
				{
					id: 'fld-logentry-reps',
					name: 'reps',
					type: 'number',
					required: true,
					provenance: suggested(),
				},
				{
					id: 'fld-logentry-weight',
					name: 'weight',
					type: 'number',
					required: false,
					provenance: suggested(),
				},
			],
			computed: [
				{
					id: 'drv-est-1rm',
					name: 'estimated1rm',
					provenance: suggested(),
					expr: (expr ?? {
						kind: 'binary',
						op: '*',
						left: { kind: 'field', field: 'fld-logentry-weight' },
						right: {
							kind: 'binary',
							op: '+',
							left: { kind: 'literal', value: 1 },
							right: {
								kind: 'binary',
								op: '/',
								left: { kind: 'field', field: 'fld-logentry-reps' },
								right: { kind: 'literal', value: 30 },
							},
						},
					}) as never,
				},
			],
		}
		return specWith([logentry])
	}

	it('rewrites every leaf from a field id to a column name', () => {
		const [shape] = groundedEntityShapes(gymlogSpec())
		expect(shape?.computed).toEqual([
			{
				name: 'estimated1rm',
				expr: {
					kind: 'binary',
					op: '*',
					left: { kind: 'field', field: 'weight' },
					right: {
						kind: 'binary',
						op: '+',
						left: { kind: 'literal', value: 1 },
						right: {
							kind: 'binary',
							op: '/',
							left: { kind: 'field', field: 'reps' },
							right: { kind: 'literal', value: 30 },
						},
					},
				},
			},
		])
	})

	// Substituting 0 for a missing operand would quietly report a wrong number;
	// dropping the whole formula is the only defensible degradation.
	it('drops the whole expression when one leaf no longer resolves', () => {
		const [shape] = groundedEntityShapes(
			gymlogSpec({
				kind: 'binary',
				op: '*',
				left: { kind: 'field', field: 'fld-ghost' },
				right: { kind: 'literal', value: 2 },
			}),
		)
		expect(shape?.computed).toEqual([])
	})
})

describe('board columns reach the live schema', () => {
	const status: FieldSpec = {
		id: 'fld-status',
		name: 'status',
		type: 'enum',
		required: true,
		options: [
			{ label: 'Open', value: 'open' },
			{ label: 'Doing', value: 'doing' },
		],
		limits: { doing: 3 },
		provenance: suggested(),
	}
	const rank: FieldSpec = {
		id: 'fld-rank',
		name: 'boardRank',
		type: 'string',
		required: false,
		rank: true,
		provenance: suggested(),
	}
	const issue: EntitySpec = {
		id: 'e-issue',
		name: 'Issue',
		provenance: suggested(),
		fields: [titleField, status, rank],
	}

	// This is a regression test with a scar: both declarations were dropped here
	// on the first pass, and every unit test still passed because they built the
	// entity shapes directly. The running app served a board that drew a WIP limit
	// nothing enforced and a rank column that was null on every row.
	it('carries the WIP limit and the rank key through grounding', () => {
		const [shape] = groundedEntityShapes(specWith([issue]))
		expect(shape?.fields[1]).toMatchObject({
			name: 'status',
			limits: { doing: 3 },
		})
		expect(shape?.fields[2]).toMatchObject({ name: 'boardRank', rank: true })
	})

	it('gives the rank column its database default in the emitted DDL', () => {
		// Without this the column is nullable with no value, which is exactly the
		// unordered region the rank design exists to prevent.
		const ddl = specSchemaDdl(groundedEntityShapes(specWith([issue])))
		expect(ddl).toContain('ADD COLUMN IF NOT EXISTS "boardRank" text DEFAULT (')
	})
})

describe('groundedEntityShapes — document templates', () => {
	const invoiceNumber: FieldSpec = {
		id: 'fld-invoice-number',
		name: 'number',
		type: 'string',
		required: true,
		provenance: manual(),
	}
	const invoiceNotes: FieldSpec = {
		id: 'fld-invoice-notes',
		name: 'notes',
		type: 'json',
		required: false,
		provenance: manual(),
	}
	const lineLabel: FieldSpec = {
		id: 'fld-line-label',
		name: 'label',
		type: 'string',
		required: true,
		provenance: manual(),
	}
	const lineInvoice: FieldSpec = {
		id: 'fld-line-invoice',
		name: 'invoiceId',
		type: 'string',
		required: false,
		reference: 'e-invoice',
		provenance: manual(),
	}

	function invoicerSpec(sections: DocumentSection[]): SpecSystem {
		const spec = specWith([
			{
				id: 'e-invoice',
				name: 'Invoice',
				description: 'A bill.',
				fields: [invoiceNumber, invoiceNotes],
				rollups: [
					{
						id: 'drv-invoice-total',
						name: 'total',
						over: 'e-lineitem',
						via: 'fld-line-invoice',
						fn: 'sum',
						field: 'fld-line-amount',
						provenance: manual(),
					},
				],
				provenance: manual(),
			},
			{
				id: 'e-lineitem',
				name: 'LineItem',
				description: 'A billable line.',
				fields: [lineLabel, lineInvoice],
				provenance: manual(),
			},
		])
		return {
			...spec,
			theme: { preset: 'ocean', accent: '#1d4ed8', font: 'serif' },
			documents: {
				templates: [
					{
						id: 'doc-invoice',
						key: 'invoice',
						description: 'A branded invoice.',
						entityId: 'e-invoice',
						pageSize: 'a4',
						sections,
						delivery: { download: true },
						declaredAt: '2026-07-28',
						provenance: manual(),
					},
				],
			},
		}
	}

	const sections: DocumentSection[] = [
		{ kind: 'heading', level: 1, text: 'Invoice {number}' },
		{ kind: 'fields', columns: 2, fieldIds: ['fld-invoice-number'] },
		{
			kind: 'table',
			over: 'e-lineitem',
			via: 'fld-line-invoice',
			fieldIds: ['fld-line-label'],
			orderBy: 'fld-line-label',
		},
		{ kind: 'fields', columns: 1, fieldIds: ['drv-invoice-total'] },
	]

	it('resolves field ids to column names and the relation to a resource', () => {
		const [invoice] = groundedEntityShapes(invoicerSpec(sections))
		const plan = invoice?.documents?.[0]
		expect(plan?.key).toBe('invoice')
		expect(plan?.resource).toBe('invoice')
		const table = plan?.sections.find((s) => s.kind === 'table')
		expect(table?.kind === 'table' && table.resource).toBe('lineitem')
		expect(table?.kind === 'table' && table.via).toBe('invoiceId')
		expect(table?.kind === 'table' && table.orderBy).toBe('label')
	})

	/**
	 * Issue #222. `delivery.download` used to be dropped at grounding, so the
	 * runtime plan had no way to know a template was retired and the document
	 * route served every declared one. Turning `download` off removed a template
	 * from the exposure report and from nothing else.
	 */
	it('carries delivery.download onto the grounded plan', () => {
		const [on] = groundedEntityShapes(invoicerSpec(sections))
		expect(on?.documents?.[0]?.download).toBe(true)

		const retired = invoicerSpec(sections)
		const template = retired.documents?.templates[0]
		if (template) template.delivery = { download: false }
		const [off] = groundedEntityShapes(retired)
		expect(off?.documents?.[0]?.download).toBe(false)
	})

	it('grounds a rollup as a printable value, so a total needs no arithmetic here', () => {
		const [invoice] = groundedEntityShapes(invoicerSpec(sections))
		const plan = invoice?.documents?.[0]
		const totals = plan?.sections.at(-1)
		expect(totals?.kind === 'fields' && totals.fields[0]?.column).toBe('total')
		expect(totals?.kind === 'fields' && totals.fields[0]?.type).toBe('number')
		expect(plan?.values.total?.column).toBe('total')
	})

	it('takes its style from theme.set rather than from the template', () => {
		const [invoice] = groundedEntityShapes(invoicerSpec(sections))
		expect(invoice?.documents?.[0]?.style).toEqual({
			font: 'serif',
			accent: '#1d4ed8',
			density: 'comfortable',
			typeScale: 'default',
		})
	})

	it('adds no column and no DDL — a document renders rows that already exist', () => {
		const shapes = groundedEntityShapes(invoicerSpec(sections))
		const plain = groundedEntityShapes({
			...invoicerSpec(sections),
			documents: undefined,
		})
		expect(shapes[0]?.fields).toEqual(plain[0]?.fields)
		expect(specSchemaDdl(shapes)).toBe(specSchemaDdl(plain))
	})

	it('omits the key entirely when nothing is declared, so an untouched spec grounds unchanged', () => {
		expect(
			groundedEntityShapes({
				...invoicerSpec(sections),
				documents: undefined,
			})[0],
		).not.toHaveProperty('documents')
	})

	it('drops the whole template when a field it names stops resolving', () => {
		// A partially-grounded template renders a document with a blank where a
		// value should be — and that is a document somebody sends to a customer.
		const spec = invoicerSpec(sections)
		const invoice = spec.data.entities[0]
		if (invoice) {
			invoice.fields = [
				{ ...invoiceNumber, provenance: accept(manual()) },
				{ ...invoiceNotes, provenance: { ...suggested(), isAccepted: false } },
			]
			invoice.rollups = []
		}
		expect(groundedEntityShapes(spec)[0]).not.toHaveProperty('documents')
	})
})

describe('groundedEntityShapes — importers', () => {
	const guid: FieldSpec = {
		id: 'fld-card-guid',
		name: 'guid',
		type: 'string',
		required: false,
		provenance: manual(),
	}
	const front: FieldSpec = {
		id: 'fld-card-front',
		name: 'front',
		type: 'string',
		required: true,
		provenance: manual(),
	}

	function cardSpec(over: Partial<ImporterSpec> = {}): SpecSystem {
		const spec = specWith([
			{
				id: 'e-card',
				name: 'Card',
				fields: [guid, front],
				provenance: manual(),
			},
		])
		return {
			...spec,
			imports: {
				importers: [
					{
						id: 'imp-anki',
						key: 'anki-deck',
						description: 'Import a shared Anki deck.',
						entityId: 'e-card',
						format: 'custom',
						parserSlot: 'anki-deck',
						columns: [
							{ column: 'guid', fieldId: 'fld-card-guid' },
							{ column: 'front', fieldId: 'fld-card-front' },
						],
						upsertFieldId: 'fld-card-guid',
						maxRows: 20_000,
						paused: false,
						declaredAt: '2026-07-28',
						provenance: manual(),
						...over,
					} as ImporterSpec,
				],
			},
		}
	}

	it('resolves field ids to column names and carries the write posture through', () => {
		const [card] = groundedEntityShapes(cardSpec())
		expect(card?.importers?.[0]).toEqual({
			key: 'anki-deck',
			description: 'Import a shared Anki deck.',
			format: 'custom',
			resource: 'card',
			parserSlot: 'anki-deck',
			columns: [
				{ column: 'guid', field: 'guid', type: 'string' },
				{ column: 'front', field: 'front', type: 'string' },
			],
			upsertColumn: 'guid',
			maxRows: 20_000,
			paused: false,
		})
	})

	it('grounds an insert-only importer as upsertColumn: null, not as absent', () => {
		const [card] = groundedEntityShapes(cardSpec({ upsertFieldId: null }))
		expect(card?.importers?.[0]?.upsertColumn).toBeNull()
	})

	it('adds no column and no DDL — an importer is a way in, not a shape', () => {
		const shapes = groundedEntityShapes(cardSpec())
		const plain = groundedEntityShapes({ ...cardSpec(), imports: undefined })
		expect(shapes[0]?.fields).toEqual(plain[0]?.fields)
		expect(specSchemaDdl(shapes)).toBe(specSchemaDdl(plain))
	})

	it('omits the key entirely when nothing is declared', () => {
		expect(
			groundedEntityShapes({ ...cardSpec(), imports: undefined })[0],
		).not.toHaveProperty('importers')
	})

	it('drops the whole importer when a mapped field stops resolving', () => {
		// A partially-grounded importer silently drops a column, and a dropped
		// column on an upserting run overwrites existing values with nothing.
		const spec = cardSpec()
		const card = spec.data.entities[0]
		if (card)
			card.fields = [
				{ ...front, provenance: accept(manual()) },
				{ ...guid, provenance: { ...suggested(), isAccepted: false } },
			]
		expect(groundedEntityShapes(spec)[0]).not.toHaveProperty('importers')
	})
})
