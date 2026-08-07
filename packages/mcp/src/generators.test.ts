import {
	createMemFs,
	generateResourcePage,
	MANIFEST_FILENAME,
	parseManifest,
	type RouteManifest,
} from '@maxstack/core/ownership'
import type { EntitySpec, PageSpec, SpecSystem } from '@maxstack/spec'
import { manual, newSpecSystem, suggested } from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import { describe, expect, it } from 'vitest'
import {
	counted,
	docsGenerator,
	e2eTestsGenerator,
	pageDescriptor,
	pageDescriptors,
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

/**
 * Issue #337 — two pages over one entity used to emit into ONE route module.
 *
 * Every page folded to its entity's resource, so `pg-books` and `pg-shelf` both
 * wrote `routes/book.tsx`: each run overwrote the other's file, `validate`
 * reported `unsafe regen overwritten` forever (which also hid a *genuine*
 * clobber), and `.generated.routes.json` kept only the last writer while
 * `routes.ts` listed both routes pointing at the same module.
 *
 * The fix disambiguates **only on collision**, so the one-page-per-entity
 * project — nearly every project — keeps the file name it already has on disk
 * and nothing is orphaned. Both halves are pinned here.
 */
describe('pageDescriptors (issue #337 — one route module per page)', () => {
	const page = (
		id: `pg-${string}`,
		route: string,
		entityId: `e-${string}`,
		blocks: PageSpec['blocks'] = [],
	): PageSpec => ({
		id,
		name: id.replace(/^pg-/, ''),
		route,
		entityId,
		provenance: suggested(),
		blocks,
	})

	const books = page('pg-books', '/', 'e-book')
	const shelf = page('pg-shelf', '/shelf', 'e-book')
	const projects = page('pg-projects', '/projects', 'e-project')

	/** Generate every descriptor into one FS, in order — what `maxstack gen` does. */
	async function generateAll(
		fs: ReturnType<typeof createMemFs>,
		pages: PageSpec[],
	) {
		const results = []
		for (const descriptor of pageDescriptors(pages)) {
			const run = await generateResourcePage(fs, descriptor)
			results.push(...run.results)
		}
		return results
	}

	it('leaves a lone page over an entity on routes/<resource>.tsx', async () => {
		const descriptors = pageDescriptors([books, projects])
		expect(descriptors.map((d) => d.module)).toEqual([undefined, undefined])

		const fs = createMemFs()
		await generateAll(fs, [books, projects])
		expect([...fs.snapshot().keys()]).toContain('routes/book.tsx')
		expect([...fs.snapshot().keys()]).toContain('routes/project.tsx')
	})

	it('gives a second page over the same entity its own module', async () => {
		expect(
			pageDescriptors([books, shelf, projects]).map((d) => d.module),
		).toEqual([undefined, 'shelf', undefined])
	})

	it('emits two distinct route modules and regenerates stably', async () => {
		const fs = createMemFs()
		const first = await generateAll(fs, [books, shelf, projects])
		expect(first.every((r) => r.action === 'created')).toBe(true)

		const files = [...fs.snapshot().keys()]
		expect(files).toContain('routes/book.tsx')
		expect(files).toContain('routes/shelf.tsx')

		// The whole point of the bug report: a second run must clobber nothing.
		const second = await generateAll(fs, [books, shelf, projects])
		expect(second.map((r) => r.action)).toEqual(second.map(() => 'unchanged'))

		const manifest = parseManifest(
			await fs.read(MANIFEST_FILENAME),
		) as RouteManifest
		// One entry per page — the collision used to leave two pages sharing one,
		// last-write-wins. (Entries are held in canonical id order.)
		expect(manifest.entries.map((e) => [e.id, e.routePath, e.file])).toEqual([
			['book', '/', 'routes/book.tsx'],
			['project', '/projects', 'routes/project.tsx'],
			['shelf', '/shelf', 'routes/shelf.tsx'],
		])

		// …and the manifest and routes.ts describe the same tree.
		const routes = await fs.read('routes.ts')
		expect(routes).toContain(`{ path: '/', file: './routes/book.tsx' }`)
		expect(routes).toContain(`{ path: '/shelf', file: './routes/shelf.tsx' }`)
	})

	it('keeps the slot file keyed by resource, so a fill is not stranded', async () => {
		const slotted = page('pg-shelf', '/shelf', 'e-book', [
			{ id: 'blk-hero', type: 'slot:hero', provenance: suggested() },
		])
		const fs = createMemFs()
		await generateAll(fs, [books, slotted])
		expect([...fs.snapshot().keys()]).toContain('routes/book.slots.tsx')
		expect([...fs.snapshot().keys()]).not.toContain('routes/shelf.slots.tsx')
	})

	it('falls back to <resource>-<page> when the page id names another resource', () => {
		const authorPage = page('pg-author', '/authors/all', 'e-book')
		const authors = page('pg-authors', '/authors', 'e-author')
		expect(
			pageDescriptors([books, authorPage, authors]).map((d) => d.module),
		).toEqual([undefined, 'book-author', undefined])
	})

	it('names modules from the page id, not a counter, so they survive a deletion', () => {
		const modules = (pages: PageSpec[]) =>
			pageDescriptors(pages).map((d) => d.module)
		const third = page('pg-archive', '/archive', 'e-book')
		expect(modules([books, shelf, third])).toEqual([
			undefined,
			'shelf',
			'archive',
		])
		// Drop the middle page: the survivor keeps the module it already wrote.
		expect(modules([books, third])).toEqual([undefined, 'archive'])
	})
})
