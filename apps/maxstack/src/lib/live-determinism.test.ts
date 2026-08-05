/**
 * Determinism with declared live channels (gating requirement:
 * generation must not read a clock, a socket or a random source).
 *
 * The requirement is easy to state and easy to satisfy accidentally — nothing in
 * the generator opens a connection **today**. It is also easy to lose silently:
 * the day somebody threads "show the current subscriber count in the stub
 * header" into the generator, every other test stays green and the eval stops
 * being reproducible, because a run's output now depends on who happened to have
 * the page open.
 *
 * So this file asserts it the only way that stays true: it **removes the
 * network** and generates anyway, then pins the property from the other side the
 * way `source-determinism.test.ts` does — specs whose *runtime* behaviour
 * genuinely differs must emit identical trees. A channel with a thousand
 * subscribers, one that has been paused, and one that has never been opened all
 * produce the same files, because the generator cannot reach a subscriber table
 * at all.
 *
 * The last block is the one a live feature specifically needs: **no timestamp
 * and no connection id anywhere in the emitted tree.** Either would turn every
 * regeneration into a diff to review, which is the failure that makes
 * regeneration-as-diff useless rather than merely noisy.
 *
 * The corpus apps are cloned and extended here rather than in `examples/src/`
 * for the reason `flag-determinism.test.ts` gives: the frozen backlog is a
 * measuring instrument, and this test needs a realistic spec, not a scored one.
 */

import { tasklyExample } from '@maxstack/examples'
import { createMemFs, generateLive } from '@maxstack/core/ownership'
import { LiveChannel } from '@maxstack/core'
import { specToLiveDescriptors } from '@maxstack/spec-derive'
import {
	activeLiveSubscriptions,
	type ApplyMeta,
	applyOp,
	listLiveSubscriptions,
	type SpecSystem,
} from '@maxstack/spec'
import { afterEach, describe, expect, it } from 'vitest'

const meta = (n: number): ApplyMeta => ({
	actor: { surface: 'harness' },
	id: `op-live-${n}`,
	origin: 'human',
	appliedAt: '2026-07-29',
})

/** taskly with its board and presence channels declared (the corpus app's own). */
function liveCorpusApp(opts: { paused?: boolean } = {}): SpecSystem {
	const spec = structuredClone(tasklyExample.spec)
	if (!opts.paused) return spec
	const board = listLiveSubscriptions(spec).find((l) => l.kind === 'query')
	if (!board) throw new Error('taskly no longer declares a live query channel')
	return applyOp(
		spec,
		{ op: 'live.pause', args: { subscriptionId: board.id, paused: true } },
		meta(1),
	)
}

/** The generated tree for a spec's live seam, as a file map. */
async function generateSeam(spec: SpecSystem): Promise<Map<string, string>> {
	const fs = createMemFs()
	await generateLive(fs, specToLiveDescriptors(spec))
	return fs.snapshot()
}

const realFetch = globalThis.fetch

afterEach(() => {
	globalThis.fetch = realFetch
})

/** Replace the global fetch with one that fails loudly and identifiably. */
function forbidNetwork(): void {
	globalThis.fetch = (async (input: unknown) => {
		throw new Error(
			`the generation path reached the network (${String(input)}) — ` +
				'generation must be a function of the declaration alone',
		)
	}) as typeof globalThis.fetch
}

describe('generation never opens a connection', () => {
	it('generates a spec with declared live channels while the network is unavailable', async () => {
		forbidNetwork()
		const spec = liveCorpusApp()
		// Not vacuous: taskly genuinely declares channels, and one of them opens a
		// bespoke-surface slot.
		expect(listLiveSubscriptions(spec).length).toBeGreaterThan(0)
		expect(listLiveSubscriptions(spec).some((l) => l.slot)).toBe(true)
		const files = await generateSeam(spec)
		expect(files.has('live/live.generated.ts')).toBe(true)
	})

	it('derives the descriptors from the declaration alone', () => {
		forbidNetwork()
		const descriptors = specToLiveDescriptors(liveCorpusApp())
		// Column NAMES, never field ids — the descriptor feeds a generated props
		// type, and `fld-task-title` is not an identifier.
		for (const d of descriptors)
			for (const field of d.fields) expect(field).not.toMatch(/^fld-/)
		// And nothing about who is connected.
		expect(JSON.stringify(descriptors)).not.toMatch(
			/subscriber|connection|socket/i,
		)
	})
})

describe('the generated tree does not depend on what a channel has done', () => {
	it('emits the same tree whether or not anybody has ever subscribed', async () => {
		const spec = liveCorpusApp()
		const before = await generateSeam(spec)

		// A runtime with a full, noisy subscriber table and a live presence room.
		const plan = specToLiveDescriptors(spec).find((d) => d.slot)
		if (!plan) throw new Error('expected a slotted channel')
		const channel = new LiveChannel(
			{
				key: plan.key,
				description: plan.description,
				resource: plan.resource,
				kind: 'query',
				fields: plan.fields,
				scope: { kind: 'all' },
				maxSubscribers: 50,
				maxMessagesPerMinute: 60,
				slot: true,
				paused: false,
			},
			'id',
		)
		for (let i = 0; i < 20; i += 1)
			channel.subscribe({
				id: `c${i}`,
				ctx: {
					registry: { get: () => undefined } as never,
					store: {} as never,
					user: null,
				},
				send: () => {},
				close: () => {},
			})
		expect(channel.size).toBe(20)

		expect(await generateSeam(spec)).toEqual(before)
	})

	it('a paused channel emits the same tree as a running one', async () => {
		// Pausing is a *runtime* fact. If it moved the generated tree, every 3am
		// pause would produce a regeneration diff to review, and resuming another —
		// at exactly the moment nobody has attention to spare for one.
		const running = liveCorpusApp()
		const paused = liveCorpusApp({ paused: true })
		// Not vacuous: the two specs genuinely disagree about what answers.
		expect(activeLiveSubscriptions(running).length).toBeGreaterThan(
			activeLiveSubscriptions(paused).length,
		)
		expect(await generateSeam(paused)).toEqual(await generateSeam(running))
	})

	it('regenerating the same spec twice is byte-identical', async () => {
		const spec = liveCorpusApp()
		expect(await generateSeam(spec)).toEqual(await generateSeam(spec))
	})

	it('emits no timestamp and no connection id anywhere in the tree', async () => {
		// The specific hazard of a live feature: either one turns every
		// regeneration into a diff to review.
		for (const content of (await generateSeam(liveCorpusApp())).values()) {
			expect(content).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
			expect(content).not.toMatch(
				/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
			)
		}
	})
})
