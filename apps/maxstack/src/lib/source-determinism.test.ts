/**
 * Determinism with declared external sources (gating requirement:
 * *"Zero network access in the generation path, asserted."*).
 *
 * The requirement is easy to state and easy to satisfy accidentally — nothing
 * in the generator calls `fetch` **today**. It is also easy to lose silently:
 * the day somebody threads "probe the endpoint so the stub can show a sample
 * response" into the generator, every other test stays green and the eval stops
 * being reproducible, because a run's output now depends on whether a third
 * party was up.
 *
 * So this file asserts it in the only way that stays true: it **removes the
 * network** and generates anyway. `globalThis.fetch` is replaced with a
 * function that throws, and a corpus app with two declared sources (one
 * enriching, one syncing, one of them opening a refiner slot) generates its
 * whole tree. If any code on that path ever reaches for the network, this test
 * fails with the reason in the message rather than with a timeout.
 *
 * It then pins the same property from the other side, the way
 * `schedule-determinism.test.ts` does: specs whose *runtime* behavior genuinely
 * differs must emit identical trees. A source that has fetched a thousand times
 * and one that has never run produce the same files, because the generator
 * cannot reach a response or a job row at all.
 *
 * The corpus apps are cloned and extended here rather than in `examples/src/`
 * for the reason `flag-determinism.test.ts` gives: the frozen backlog is a
 * measuring instrument, and this test needs a realistic spec, not a scored one.
 */

import { bookclubExample, crmliteExample } from '@maxstack/examples'
import { createMemFs, generateSources } from '@maxstack/core/ownership'
import { createMemoryJobStore, JobQueue } from '@maxstack/features/jobs'
import {
	applyMapping,
	enqueueSync,
	registerSourceHandlers,
	sourceHealth,
} from '@maxstack/features/sources'
import { specToSourceDescriptors } from '@maxstack/spec-derive'
import {
	type ApplyMeta,
	applyOp,
	activeSources,
	listSources,
	type SpecSystem,
} from '@maxstack/spec'
import { afterEach, describe, expect, it } from 'vitest'

const meta = (n: number): ApplyMeta => ({
	actor: { surface: 'harness' },
	id: `op-src-${n}`,
	origin: 'human',
	appliedAt: '2026-07-28',
})

/** bookclub with its ISBN enrichment declared (the corpus app's own source). */
function enrichedCorpusApp(opts: { paused?: boolean } = {}): SpecSystem {
	const declared = bookclubExample.changes.find(
		(c) => c.id === 'ch-isbn-lookup',
	)
	if (declared?.kind !== 'spec-op' || declared.via !== 'apply-op')
		throw new Error('bookclub no longer declares its ISBN source as a spec op')
	let spec = applyOp(
		structuredClone(bookclubExample.spec),
		declared.op,
		meta(1),
	)
	if (opts.paused)
		spec = applyOp(
			spec,
			{ op: 'sources.pause', args: { sourceId: 'src-isbn-lookup', paused: true } },
			meta(2),
		)
	return spec
}

/** The generated tree for a spec's source seam, as a file map. */
async function generateSeam(spec: SpecSystem): Promise<Map<string, string>> {
	const fs = createMemFs()
	await generateSources(fs, specToSourceDescriptors(spec))
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

describe('zero network access in the generation path', () => {
	it('generates a spec with declared sources while the network is unavailable', async () => {
		// The literal requirement, asserted by removing the thing it forbids.
		forbidNetwork()
		const spec = enrichedCorpusApp()
		expect(activeSources(spec)).toHaveLength(1)
		// Not vacuous: this is a real endpoint that would resolve if anything asked.
		expect(listSources(spec)[0]?.request.url).toContain('openlibrary.org')
		await expect(generateSeam(spec)).resolves.toBeInstanceOf(Map)
	})

	it('generates the syncing corpus app — refiner slot and all — with no network', async () => {
		forbidNetwork()
		const spec = structuredClone(crmliteExample.spec)
		const files = await generateSeam(spec)
		// crmlite's inbox source declares `refine: true`, so this is the case where
		// the generator *does* emit something and still must not fetch.
		expect(files.has('sources/sources.generated.ts')).toBe(true)
		expect(files.has('sources/inbox-sync.refine.ts')).toBe(true)
	})

	it('derives the descriptors from the declaration alone', async () => {
		forbidNetwork()
		const descriptors = specToSourceDescriptors(crmliteExample.spec)
		expect(descriptors).toEqual([
			{
				key: 'inbox.sync',
				description: 'Sync the connected mailbox into the message log.',
				mode: 'sync',
				// The origin, never a credential — the declaration does not hold one.
				endpoint: 'https://api.mailprovider.example',
				refine: true,
			},
		])
		expect(JSON.stringify(descriptors)).not.toMatch(/MAILBOX_TOKEN|secret/i)
	})

	it('maps a saved response with no network at all', () => {
		// The mapping is pure, which is what lets a maintainer test an integration
		// against a recorded response instead of against a live third party.
		forbidNetwork()
		const spec = enrichedCorpusApp()
		const source = listSources(spec)[0]
		const entity = spec.data.entities.find((e) => e.id === 'e-book')
		if (!source || !entity) throw new Error('expected the bookclub source')
		expect(
			applyMapping(source, entity, { title: 'Dune', number_of_pages: 412 })
				.values,
		).toEqual({ 'fld-book-title': 'Dune', 'fld-book-pages': 412 })
	})
})

describe('the generated tree does not depend on what a source has done', () => {
	it('emits the same tree whether or not the source has ever run', async () => {
		const spec = structuredClone(crmliteExample.spec)
		const before = await generateSeam(spec)

		// A runtime with a full, noisy run history: a sync that dead-lettered.
		const queue = new JobQueue({ store: createMemoryJobStore() })
		const source = activeSources(spec)[0]
		if (!source) throw new Error('expected an active source')
		registerSourceHandlers({
			queue,
			sources: () => [source],
			entity: (id) => spec.data.entities.find((e) => e.id === id),
			apply: async () => {},
			fetch: (async () => {
				throw new Error('the provider is down')
			}) as never,
		})
		// The authority the run borrows. Required, and there is no
		// default to fall into — the worker refuses a job that arrives without one.
		await enqueueSync(queue, source, 'occ-1', {
			kind: 'service',
			role: 'admin',
		})
		await queue.tick()
		expect((await sourceHealth(queue, source)).state).toBe('failing')

		expect(await generateSeam(spec)).toEqual(before)
	})

	it('a paused source emits the same tree as a running one', async () => {
		// Pausing is a *runtime* fact. If it moved the generated tree, every 3am
		// pause would produce a regeneration diff to review, and resuming another.
		const running = enrichedCorpusApp()
		const paused = enrichedCorpusApp({ paused: true })
		// Not vacuous: the two specs genuinely disagree about what fetches.
		expect(activeSources(running)).toHaveLength(1)
		expect(activeSources(paused)).toHaveLength(0)
		expect(await generateSeam(paused)).toEqual(await generateSeam(running))
	})

	it('regenerating the same spec twice is byte-identical', async () => {
		const spec = structuredClone(crmliteExample.spec)
		expect(await generateSeam(spec)).toEqual(await generateSeam(spec))
	})

	it('a project with no declared source grows no source files at all', async () => {
		expect([...(await generateSeam(bookclubExample.spec)).keys()]).toEqual([])
	})

	it('a source whose declaration was enough grows no files either', async () => {
		// The honest headline: bookclub's ISBN lookup is a spec op with no code
		// behind it, so declaring it leaves the tree empty.
		expect([...(await generateSeam(enrichedCorpusApp())).keys()]).toEqual([])
	})
})
