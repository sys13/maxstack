import type { EntitySpec, PageSpec, SpecSystem } from '@maxstack/spec'
import { manual, newSpecSystem, suggested } from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import { describe, expect, it } from 'vitest'
import {
	counted,
	docsGenerator,
	e2eTestsGenerator,
	pageDescriptor,
	typesGenerator,
} from './generators.ts'

/**
 * Regression coverage for issue #42: `pageDescriptor` (route generation) and
 * `getRoutes` (`apps/web/app/project-routes.ts`, the live runtime) must derive
 * the exact same slot names from the exact same blocks, or a filled slot
 * silently never renders. `apps/web/app/project-routes.test.ts` pins the
 * runtime side of this contract with an equivalent fixture.
 */
describe('pageDescriptor (issue #42 — agrees with the runtime slot derivation)', () => {
	const page: PageSpec = {
		id: 'pg-subscriptions',
		name: 'Subscriptions',
		route: '/subscriptions',
		entityId: 'e-subscription',
		provenance: suggested(),
		blocks: [
			{ id: 'blk-table', type: 'table', provenance: suggested() },
			{ id: 'blk-renewals', type: 'slot:renewals', provenance: suggested() },
		],
	}

	it('names a slot from its block type suffix, not its block id', () => {
		expect(pageDescriptor(page).slots).toEqual(['renewals'])
	})

	it('drops non-slot blocks entirely — no dead-code stub for `table`/`form`', () => {
		const formOnly: PageSpec = {
			...page,
			blocks: [{ id: 'blk-form', type: 'form', provenance: suggested() }],
		}
		expect(pageDescriptor(formOnly).slots).toEqual([])
	})

	it("agrees with the runtime even when a slot's id doesn't stem-match its type", () => {
		const mismatched: PageSpec = {
			...page,
			blocks: [
				{
					id: 'blk-gear-table',
					type: 'slot:pack_loadout',
					provenance: suggested(),
				},
			],
		}
		expect(pageDescriptor(mismatched).slots).toEqual(['pack_loadout'])
	})
})

/**
 * Issue #344: the generated `docs/OVERVIEW.md` read "## Data model (1 entities)".
 * One entity is the state every project is in right after `maxstack init` plus
 * one op, so the first generated docs most people ever see were ungrammatical
 * — and the other counted nouns in the same generator had the same bug, or the
 * `file(s)` dodge that hides it.
 */
describe('counted (#344 — a count agrees with its noun)', () => {
	it('uses the singular for exactly one', () => {
		expect(counted(1, 'entity', 'entities')).toBe('1 entity')
		expect(counted(1, 'block')).toBe('1 block')
	})

	it('uses the plural for zero and for many', () => {
		expect(counted(0, 'block')).toBe('0 blocks')
		expect(counted(2, 'entity', 'entities')).toBe('2 entities')
	})
})

describe('generator counts (#344)', () => {
	const entity: EntitySpec = {
		id: 'e-order',
		name: 'Order',
		fields: [
			{
				id: 'fld-total',
				name: 'total',
				type: 'number',
				required: true,
				provenance: manual(),
			},
		],
		provenance: manual(),
	}

	const onePage: PageSpec = {
		id: 'pg-orders',
		name: 'Orders',
		route: '/orders',
		entityId: 'e-order',
		blocks: [{ id: 'blk-table', type: 'table', provenance: manual() }],
		e2eTests: ['lists orders'],
		provenance: manual(),
	}

	function specWith(
		entities: EntitySpec[],
		pages: PageSpec[] = [],
	): SpecSystem {
		const base = newSpecSystem(tasklyPRD)
		return {
			...base,
			product: {
				...base.product,
				requirements: tasklyPRD.requirements.slice(0, 1),
			},
			data: { entities },
			pages: { pages },
		}
	}

	async function docs(spec: SpecSystem) {
		const res = await docsGenerator.run(spec, {})
		return { content: res.artifacts[0]?.content ?? '', notes: res.notes ?? [] }
	}

	it('says "1 entity" and "1 block" for a one-of-each spec', async () => {
		const { content } = await docs(specWith([entity], [onePage]))
		expect(content).toContain('## Data model (1 entity)')
		expect(content).toContain('`/orders` (1 block)')
		expect(content).not.toContain('1 entities')
		expect(content).not.toContain('1 blocks')
	})

	it('still pluralizes for zero and for many', async () => {
		const { content } = await docs(
			specWith(
				[entity, { ...entity, id: 'e-line', name: 'Line' }],
				[{ ...onePage, blocks: [] }],
			),
		)
		expect(content).toContain('## Data model (2 entities)')
		expect(content).toContain('`/orders` (0 blocks)')
	})

	it('counts requirements in the docs note without the plural-s bug', async () => {
		const { notes } = await docs(specWith([entity]))
		expect(notes[0]).toBe('Generated docs/OVERVIEW.md from 1 requirement.')
	})

	it('drops the "file(s)" dodge in the e2e note', async () => {
		const res = await e2eTestsGenerator.run(specWith([entity], [onePage]), {})
		expect(res.notes?.[0]).toBe('Scaffolded 1 e2e spec file.')
	})

	it('drops the "resource(s)" dodge in the types note', async () => {
		const res = await typesGenerator.run(specWith([entity]), {})
		expect(res.notes?.[0]).toContain('Generated types for 1 resource:')
	})
})
