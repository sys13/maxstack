/**
 * `init` — the orienting call and the batch write path.
 *
 * Two properties carry the whole design, and both are the kind that pass by
 * accident until something regresses them:
 *
 *   - a batch is **all-or-nothing**, including the case where op 3 of 4 refuses
 *     after ops 1–2 validated cleanly against the running projection;
 *   - a host that cannot answer part of the picture says so, because an omitted
 *     catalog and an empty catalog are the same JSON to an agent, and "there is
 *     nothing to install" is the one wrong conclusion this tool exists to
 *     prevent.
 */

import type { McpToolResult } from '@maxstack/core'
import {
	type EntitySpec,
	manual,
	newSpecSystem,
	type OpId,
	type SpecSystem,
} from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import { beforeEach, describe, expect, it } from 'vitest'
import { defaultCheckRunner } from './checks.ts'
import type { PlatformContext } from './context.ts'
import { defaultGeneratorRunner } from './generators.ts'
import { createInMemorySpecStore } from './spec-store.ts'
import { executePlatformTool, platformTools } from './tools.ts'

function ctxFor(spec: SpecSystem): PlatformContext {
	let n = 0
	return {
		spec: createInMemorySpecStore(spec),
		generators: defaultGeneratorRunner(),
		checks: defaultCheckRunner(),
		origin: 'ai',
		now: () => '2026-08-02',
		nextOpId: () => `op-${++n}` as OpId,
	}
}

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

/** The tool's answer with the uniform steering pair peeled off. */
function data(res: McpToolResult): Record<string, unknown> {
	expect(res.isError, res.content[0]?.text).toBeFalsy()
	const parsed = JSON.parse(res.content[0]?.text ?? 'null') as Record<
		string,
		unknown
	>
	const { warnings: _w, next: _n, ...rest } = parsed
	return rest
}

function steering(res: McpToolResult): { warnings: string[]; next: string[] } {
	return JSON.parse(res.content[0]?.text ?? 'null')
}

const call = (ctx: PlatformContext, args: Record<string, unknown> = {}) =>
	executePlatformTool(ctx, 'init', args)

let ctx: PlatformContext

beforeEach(() => {
	ctx = ctxFor(newSpecSystem(tasklyPRD))
})

describe('init as the orienting call', () => {
	it('is listed, and listed first', () => {
		// Position is load-bearing: an agent reads tools/list top-down at session
		// start, and this is the call that tells it what the rest are for.
		expect(platformTools(ctx)[0]?.name).toBe('init')
	})

	it('answers in ONE call what would otherwise be eight', async () => {
		const d = await call(ctx).then(data)
		// Each of these is a separate query_spec section, browse_catalog or
		// review_queue call today. The value of the tool IS that they arrive
		// together, so the test asserts the whole set rather than a sample.
		for (const key of [
			'project',
			'requirements',
			'data',
			'pages',
			'slots',
			'api',
			'theme',
			'vocabulary',
			'generators',
			'checks',
			'pending',
		])
			expect(d, `init omitted "${key}"`).toHaveProperty(key)
	})

	it('names every op the agent could reach for', async () => {
		// The original complaint this tool answers: an agent does not know what it
		// could use. You cannot reach for an op you have never heard of, so every
		// one of them is named — including the layers a session never touches.
		const vocab = (await call(ctx).then(data)).vocabulary as {
			count: number
			ops: Array<Record<string, unknown>>
			argSchemas: string
		}
		expect(vocab.count).toBeGreaterThan(50)
		expect(vocab.ops).toHaveLength(vocab.count)
		expect(vocab.ops.map((o) => o.name)).toContain('portals.declare')
		expect(vocab.ops[0]).toHaveProperty('summary')
	})

	it('omits the arg schemas by default, and says where they are', async () => {
		// Measured: the schemas are 96% of the full payload. A call that costs a
		// quarter of a small context window is a call an agent stops making, which
		// would defeat the point of making the whole picture the cheapest fetch.
		// Omission is only honest because the payload names the way to get them.
		const res = await call(ctx)
		const bytes = res.content[0]?.text?.length ?? 0
		expect(bytes).toBeLessThan(40_000)

		const vocab = (await call(ctx).then(data)).vocabulary as {
			ops: Array<Record<string, unknown>>
			argSchemas: string
		}
		expect(vocab.ops[0]).not.toHaveProperty('args')
		expect(vocab.argSchemas).toMatch(/query_spec \{section:"ops", ops:\[/)
		// #313: the full form is named as the thing hosts REFUSE, never offered
		// as the fallback. Pointing an agent at a call that cannot return is how
		// the "you never have to guess an arg shape" promise became false.
		expect(vocab.argSchemas).toMatch(/vocabulary:"full"/)
		expect(vocab.argSchemas).toMatch(/do NOT reach for/)
		expect(vocab.argSchemas).toMatch(/hosts refuse/)
	})

	it('returns the arg schemas in full on request', async () => {
		const vocab = (await call(ctx, { vocabulary: 'full' }).then(data))
			.vocabulary as Array<Record<string, unknown>>
		const addField = vocab.find((v) => v.name === 'data.addField')
		expect(addField).toBeDefined()
		expect(JSON.stringify(addField)).toMatch(/entityId/)
	})

	it('NAMES the catalog as unanswerable rather than omitting it', async () => {
		const d = await call(ctx).then(data)
		expect(d.catalog).toBeNull()
		const unavailable = d.unavailable as Array<{ name: string; reason: string }>
		expect(unavailable.map((u) => u.name)).toContain('catalog')
		// Unknown, explicitly — never "empty". A thin host's silence would read to
		// an agent as "nothing is installable here", which is the exact wrong
		// conclusion.
		expect(unavailable[0]?.reason).toMatch(/UNKNOWN — not empty/)
		expect(d.headline).toMatch(/unknown, not empty/)
	})

	it('returns the catalog, and previews an install, once a host wires one', async () => {
		const wired = {
			...ctx,
			catalog: {
				list: () => [{ slug: 'billing' }],
				preview: (slugs: string[]) => ({ previewed: slugs }),
			},
		}
		const d = await call(wired, { with: ['billing'] }).then(data)
		expect(d.catalog).toEqual({ modules: [{ slug: 'billing' }] })
		expect(d.install).toEqual({ previewed: ['billing'] })
		expect(d.unavailable).toEqual([])
	})

	it('writes nothing when called bare', async () => {
		const before = await ctx.spec.load()
		await call(ctx)
		expect((await ctx.spec.load()).opLog).toEqual(before.opLog)
	})
})

describe('init as a batch', () => {
	const orderBatch = [
		{ op: 'data.addEntity', args: { entity } },
		{
			op: 'data.addField',
			args: {
				entityId: 'e-order',
				field: { id: 'fld-status', name: 'status', type: 'string' },
			},
		},
	]

	it('validates a later op against what the earlier ones would produce', async () => {
		// The whole reason a batch is worth having: addField names an entity that
		// does not exist until addEntity lands. Validated against the live spec
		// rather than the running projection, op 2 here is invalid.
		const d = await call(ctx, { ops: orderBatch }).then(data)
		const batch = d.batch as Record<string, unknown>
		expect(batch.failedAt).toBeNull()
		expect(batch.errors).toEqual([])
		expect(batch.requested).toBe(2)
	})

	it('does not write without apply, and says so', async () => {
		const d = await call(ctx, { ops: orderBatch }).then(data)
		const batch = d.batch as Record<string, unknown>
		expect(batch.applied).toBe(false)
		expect(batch.headline).toMatch(/NOTHING WAS WRITTEN/)
		expect((await ctx.spec.load()).opLog).toHaveLength(0)
		// Orientation still describes the un-batched spec, because nothing landed.
		expect((d.project as { entities: number }).entities).toBe(0)
	})

	it('reports ONE merged effect for the chain, not one per op', async () => {
		const batch = (await call(ctx, { ops: orderBatch }).then(data))
			.batch as Record<string, unknown>
		// Per-op rows carry the spec-shaped diff; the app-shaped answer is single,
		// because the caller is deciding about the batch, not about op 4 of 9.
		expect((batch.ops as unknown[]).length).toBe(2)
		expect(batch.effect).not.toBeNull()
		expect(batch.effect).toHaveProperty('added')
		expect(batch.effect).toHaveProperty('summary')
		expect(batch.effect).toHaveProperty('touchesPublic')
	})

	it('commits the whole chain as one save when apply is set', async () => {
		const d = await call(ctx, { ops: orderBatch, apply: true }).then(data)
		const batch = d.batch as Record<string, unknown>
		expect(batch.applied).toBe(true)
		const saved = await ctx.spec.load()
		expect(saved.opLog).toHaveLength(2)
		expect(saved.data.entities.map((e) => e.id)).toEqual(['e-order'])
		expect(saved.data.entities[0]?.fields.map((f) => f.name)).toEqual([
			'total',
			'status',
		])
		// And orientation reflects the post-batch spec — an agent reasoning about
		// the pre-batch inventory is reasoning about a project that no longer is.
		expect((d.project as { entities: number }).entities).toBe(1)
	})

	it('says out loud that applied rows land accepted, not queued', async () => {
		// The one thing a caller must not discover later: this is not a proposal
		// queue, and forty auto-accepted rows is the volume review exists to slow.
		const batch = (await call(ctx, { ops: orderBatch, apply: true }).then(data))
			.batch as { headline: string }
		expect(batch.headline).toMatch(/ACCEPTED with AI provenance/)
	})

	it('refuses the WHOLE batch when one op is invalid, writing nothing', async () => {
		const d = await call(ctx, {
			ops: [
				...orderBatch,
				{ op: 'data.addField', args: { entityId: 'e-nope', field: {} } },
			],
			apply: true,
		}).then(data)
		const batch = d.batch as Record<string, unknown>
		expect(batch.applied).toBe(false)
		expect(batch.failedAt).toBe(2)
		expect(batch.errors).not.toEqual([])
		// The two ops that DID validate must not have landed. A half-applied batch
		// leaves the spec in a state nobody designed.
		expect((await ctx.spec.load()).opLog).toHaveLength(0)
		expect((await ctx.spec.load()).data.entities).toHaveLength(0)
		expect(batch.headline).toMatch(/REFUSED — nothing was written/)
		expect(batch.headline).toMatch(/resend the whole list/i)
	})

	// Issue #314 — the batch that named the wrong op. A page declared with an
	// ordered table block and no entityId was accepted, and the refusal landed one
	// op later on the board that ran the same backing-entity check. "Fix this one"
	// then pointed at the op whose args were correct.
	const shelfBatch = [
		{
			op: 'page.addPage',
			args: {
				page: {
					id: 'pg-shelf',
					name: 'Shelf',
					route: '/',
					blocks: [
						{
							id: 'blk-shelf-table',
							type: 'table',
							variant: 'cards',
							order: { field: 'finishedOn', direction: 'desc' },
						},
					],
				},
			},
		},
		{
			op: 'page.addBoard',
			args: {
				pageId: 'pg-shelf',
				blockId: 'blk-shelf-board',
				board: { groupField: 'status' },
			},
		},
	]

	it('refuses the page whose own block names fields it has no entity for', async () => {
		const batch = (await call(ctx, { ops: shelfBatch }).then(data))
			.batch as Record<string, unknown>
		// Index 0, not 1: the unsatisfiable declaration is the page's own.
		expect(batch.failedAt).toBe(0)
		expect((batch.errors as string[]).join(' ')).toMatch(/finishedOn/)
		expect((batch.errors as string[]).join(' ')).toMatch(/entityId/)
		expect(batch.headline).toMatch(/Op 0 \(page\.addPage\)/)
	})

	it('names the earlier op that declared what a refusal is about', async () => {
		// Even when the failing index is right, an all-or-nothing batch often
		// refuses where a declaration is READ, not where it was written.
		const d = await call(ctx, {
			ops: [
				{
					op: 'page.addPage',
					args: {
						page: { id: 'pg-shelf', name: 'Shelf', route: '/', blocks: [] },
					},
				},
				{
					op: 'page.addBoard',
					args: {
						pageId: 'pg-shelf',
						blockId: 'blk-board',
						board: { groupField: 'status' },
					},
				},
			],
		}).then(data)
		const batch = d.batch as Record<string, unknown>
		expect(batch.failedAt).toBe(1)
		expect(batch.headline).toMatch(
			/"pg-shelf" was declared by op 0 \(page\.addPage\) in this same batch/,
		)
	})

	it('spends no real op ids on a batch it only previewed', async () => {
		// A dry run that burned ids would make the counter jump for batches that
		// were never committed, and op ids are how the audit trail is read.
		await call(ctx, { ops: orderBatch })
		await call(ctx, { ops: orderBatch, apply: true })
		expect((await ctx.spec.load()).opLog.map((e) => e.id)).toEqual([
			'op-1',
			'op-2',
		])
	})
})

describe('init steering', () => {
	it('points at batching, not at the singular tool', async () => {
		const { next } = steering(await call(ctx))
		expect(next.join(' ')).toMatch(/init \{ops:/)
	})

	it('tells a refused caller that nothing was written', async () => {
		const { next } = steering(
			await call(ctx, {
				ops: [{ op: 'data.addField', args: { entityId: 'e-nope', field: {} } }],
			}),
		)
		expect(next.join(' ')).toMatch(/nothing was written/i)
	})

	it('warns that the app is behind the spec a batch just moved', async () => {
		// The staleness rule is worth more here than after a single op: a batch is
		// the largest single step an agent can take, and the code on disk does not
		// move with it. A bare init on a spec with no ops has nothing to be behind
		// on, so this asserts the case that actually exists.
		const withDisk = {
			...ctx,
			generation: { watermark: async () => null },
		} as PlatformContext
		const { warnings } = steering(
			await call(withDisk, {
				ops: [{ op: 'data.addEntity', args: { entity } }],
				apply: true,
			}),
		)
		expect(warnings.join(' ')).toMatch(/never been generated/)
	})
})
