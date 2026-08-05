/**
 * The exposure report and the runtime must agree.
 *
 * `portalExposureReport` is what `maxstack validate` prints, what the workbench
 * pane renders, and what a human approves before a table faces the internet. It
 * is computed from the **declarations alone**, which is what makes it incapable
 * of drifting from the enforcement — but "incapable of drifting" is a claim, and
 * a claim about a security boundary is worth exactly as much as the test that
 * pins it.
 *
 * So this file goes the whole way round: declare a portal with `portals.declare`,
 * ground it (`groundedEntityShapes`), register it (`registerSpecEntities`),
 * create a real pglite database from the same spec, run the ordinary read op,
 * and assert that **the keys of the row that comes back equal exactly the fields
 * the report lists as readable**. Not a subset, not a spot check — `toEqual` on
 * the sorted key set, so a column nobody wrote down fails the build.
 *
 * The report on its own is a document. This is the deliverable.
 *
 * It lives in `apps/web` rather than in `@maxstack/features` — where the other
 * agreement tests live — because the grounding step is here: `spec-sprout.ts` is
 * the one place field *ids* become column *names*, and an agreement test that
 * skipped it would be agreeing about the wrong thing.
 */

import {
	createSpecDb,
	opCreate,
	opGet,
	opList,
	portalIdentity,
	ResourceRegistry,
	registerSpecEntities,
} from '@maxstack/core'
import {
	applyOp,
	type ExposedField,
	newSpecSystem,
	type PortalSpec,
	portalExposureReport,
	type SpecOp,
	type SpecSystem,
	summarizeExposure,
	validateSpecSystem,
} from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import { describe, expect, it } from 'vitest'
import { groundedEntityShapes } from './spec-sprout'

const meta = (n: number) => ({
	id: `op-${n}` as const,
	origin: 'human' as const,
	appliedAt: '2026-07-29' as const,
	actor: { surface: 'harness' as const },
})

/** A post entity with two exposed columns and two that must never leave. */
function baseSpec(): SpecSystem {
	return applyOp(
		newSpecSystem(tasklyPRD),
		{
			op: 'data.addEntity',
			args: {
				entity: {
					id: 'e-post',
					name: 'Post',
					description: 'A piece of writing.',
					fields: [
						{ id: 'fld-title', name: 'title', type: 'string', required: true },
						{ id: 'fld-body', name: 'body', type: 'string', required: false },
						{
							id: 'fld-published',
							name: 'published',
							type: 'boolean',
							required: false,
						},
						{
							id: 'fld-notes',
							name: 'internalNotes',
							type: 'string',
							required: false,
						},
						{
							id: 'fld-rate',
							name: 'authorRate',
							type: 'number',
							required: false,
						},
					],
				},
			},
		} as SpecOp,
		meta(1),
	)
}

const ARCHIVE: PortalSpec = {
	id: 'ptl-archive',
	key: 'archive',
	description: 'The public archive of published posts.',
	entityId: 'e-post',
	audience: 'public',
	scope: 'collection',
	readFields: ['fld-title', 'fld-body'],
	filter: { fieldId: 'fld-published', equals: true },
	writes: [],
	layout: 'feed',
	paused: false,
	declaredAt: '2026-07-29',
	provenance: {
		isSuggested: false,
		isAccepted: true,
		isAddedManually: true,
		suggestedDescription: null,
		priority: 'medium',
	},
}

function specWithPortal(over: Partial<PortalSpec> = {}): SpecSystem {
	return applyOp(
		baseSpec(),
		{
			op: 'portals.declare',
			args: { portal: { ...ARCHIVE, ...over } },
		} as SpecOp,
		meta(2),
	)
}

/** Everything the report says a portal exposes for reading, as column names. */
function reportedReadColumns(
	report: readonly ExposedField[],
	portalKey: string,
	spec: SpecSystem,
): string[] {
	const fields = spec.data.entities.flatMap((e) => e.fields)
	return report
		.filter((r) => r.portalKey === portalKey && r.access === 'read')
		.map((r) => fields.find((f) => f.id === r.fieldId)?.name ?? r.fieldId)
		.sort()
}

/** Ground, register and materialize a spec, returning a live op context. */
async function runtimeFor(spec: SpecSystem) {
	const shapes = groundedEntityShapes(spec)
	const registry = new ResourceRegistry()
	registerSpecEntities(registry, shapes)
	const { store } = await createSpecDb(registry, shapes)
	return { registry, store, shapes }
}

describe('the exposure report and the runtime agree, field for field', () => {
	it('a row leaving a read op has EXACTLY the keys the report calls readable', async () => {
		const spec = specWithPortal()
		expect(() => validateSpecSystem(spec)).not.toThrow()
		const { registry, store } = await runtimeFor(spec)

		// Two rows: one the portal's bound admits, one it does not. Both carry the
		// undeclared columns, so the assertions below are non-vacuous.
		await opCreate({ registry, store, user: null }, 'post', {
			title: 'Cooking rice',
			body: 'Rinse it.',
			published: true,
			internalNotes: 'PAY THE AUTHOR 400',
			authorRate: 250,
		})
		await opCreate({ registry, store, user: null }, 'post', {
			title: 'Unfinished',
			body: 'wip',
			published: false,
			internalNotes: 'do not ship',
			authorRate: 100,
		})

		// Non-vacuity: an ordinary caller genuinely sees both rows and every column.
		const ungated = await opList({ registry, store, user: null }, 'post')
		expect(ungated).toHaveLength(2)
		expect(ungated.some((r) => r.internalNotes === 'PAY THE AUTHOR 400')).toBe(
			true,
		)

		const plan = registry.findPortal('archive')?.plan
		expect(plan).toBeDefined()
		if (!plan) return
		const user = portalIdentity(plan, { clientId: 'x' })
		const rows = await opList({ registry, store, user }, 'post')

		// The bound the report does not describe, and the projection it does.
		expect(rows).toHaveLength(1)
		const report = portalExposureReport(spec)
		const declared = reportedReadColumns(report, 'archive', spec)
		expect(declared).toEqual(['body', 'title'])
		// THE assertion. `toEqual` on the sorted key set, minus the primary key,
		// which the projection always keeps and the report deliberately never
		// lists — a uuid says nothing the row's own presence did not already say.
		expect(
			Object.keys(rows[0] ?? {})
				.filter((k) => k !== 'id')
				.sort(),
		).toEqual(declared)
	})

	it('holds for a single-row read too, not only for the list', async () => {
		const spec = specWithPortal()
		const { registry, store } = await runtimeFor(spec)
		const created = await opCreate({ registry, store, user: null }, 'post', {
			title: 'One',
			body: 'b',
			published: true,
			internalNotes: 'secret',
			authorRate: 1,
		})
		const plan = registry.findPortal('archive')?.plan
		if (!plan) throw new Error('portal did not ground')
		const user = portalIdentity(plan, { clientId: 'x' })
		const row = await opGet(
			{ registry, store, user },
			'post',
			String(created.id),
		)
		expect(
			Object.keys(row)
				.filter((k) => k !== 'id')
				.sort(),
		).toEqual(reportedReadColumns(portalExposureReport(spec), 'archive', spec))
	})

	it('tracks a widened projection through BOTH halves at once', async () => {
		// The drift this file exists to catch would look like: the report gains a
		// field and the runtime does not, or the reverse. Widening the declaration
		// and re-deriving both from it is the only way either can move.
		const spec = applyOp(
			specWithPortal(),
			{
				op: 'portals.setFields',
				args: {
					portalId: 'ptl-archive',
					readFields: ['fld-title', 'fld-body', 'fld-rate'],
				},
			} as SpecOp,
			meta(3),
		)
		const { registry, store } = await runtimeFor(spec)
		await opCreate({ registry, store, user: null }, 'post', {
			title: 'One',
			body: 'b',
			published: true,
			internalNotes: 'secret',
			authorRate: 42,
		})
		const plan = registry.findPortal('archive')?.plan
		if (!plan) throw new Error('portal did not ground')
		const rows = await opList(
			{ registry, store, user: portalIdentity(plan, { clientId: 'x' }) },
			'post',
		)
		const declared = reportedReadColumns(
			portalExposureReport(spec),
			'archive',
			spec,
		)
		expect(declared).toEqual(['authorRate', 'body', 'title'])
		expect(
			Object.keys(rows[0] ?? {})
				.filter((k) => k !== 'id')
				.sort(),
		).toEqual(declared)
		// And the field that was never declared is still absent from both.
		expect(declared).not.toContain('internalNotes')
		expect(rows[0]).not.toHaveProperty('internalNotes')
	})

	it('grounds nothing at all when the report would list a field that no longer exists', async () => {
		// A field soft-rejected AFTER the portal was declared. A partially-grounded
		// portal would be a public surface missing a declared column, which reads
		// as a bug and gets "fixed" by widening something.
		const spec = specWithPortal()
		const stripped: SpecSystem = {
			...spec,
			data: {
				entities: spec.data.entities.map((e) => ({
					...e,
					fields: e.fields.filter((f) => f.id !== 'fld-body'),
				})),
			},
		}
		const { registry } = await runtimeFor(stripped)
		expect(registry.findPortal('archive')).toBeUndefined()
	})

	it('does not ground a portal nobody accepted', async () => {
		const suggestedPortal = specWithPortal({
			provenance: {
				isSuggested: true,
				isAccepted: null,
				isAddedManually: false,
				suggestedDescription: null,
				priority: 'medium',
			},
		})
		const { registry } = await runtimeFor(suggestedPortal)
		expect(registry.findPortal('archive')).toBeUndefined()
		// …and the report still shows it, because a review queue you cannot see is
		// not a review queue.
		expect(portalExposureReport(suggestedPortal)).toHaveLength(2)
	})

	it('summarizes the exposure in the words the report prints', () => {
		expect(summarizeExposure(portalExposureReport(specWithPortal()))).toMatch(
			/2 field\(s\) readable with no credential at all/,
		)
		expect(summarizeExposure(portalExposureReport(baseSpec()))).toMatch(
			/No portals declared/,
		)
	})
})

describe('the portal routes are not a second access path', () => {
	it('never import the store, the registry or the permission layer directly', async () => {
		// The #186 lesson, made structural rather than promised. A route that
		// cannot reach the store cannot become a second, weaker read path — and the
		// day somebody adds `store.list` here to "just filter the columns", this
		// fails.
		const { readFile } = await import('node:fs/promises')
		// `routes/api.live.$key.tsx` carries the identical property for the same
		// reason, and the stakes are higher there: a live route holds
		// the connection open, so a check it performed once would keep being right
		// long after it stopped being true.
		for (const file of [
			'routes/p.$key.tsx',
			'routes/p.$key.$id.tsx',
			'routes/api.live.$key.tsx',
		]) {
			const src = await readFile(new URL(`./${file}`, import.meta.url), 'utf8')
			expect(src).not.toContain('createDrizzleStore')
			expect(src).not.toContain('getSprout')
			expect(src).not.toContain('ResourceRegistry')
			expect(src).not.toContain('authorize(')
			expect(src).not.toContain('canPerformAction')
			// And the only ops it may reach are the ordinary read ones.
			expect(src).not.toContain('opDelete')
			expect(src).not.toContain('projectForPortal')
			expect(src).not.toContain('projectForLive')
		}
	})
})
