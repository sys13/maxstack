/**
 * **The full undeclare cycle, per seam kind** — issue #355.
 *
 * `packages/maxstack-core`'s `prune-seams.test.ts` pins the decision table on a
 * hand-built schedule. What is pinned here is that the table is reached at all
 * for every family, from a **real corpus declaration**, through the same
 * `seamFamilies` projection `maxstack gen` and `maxstack drift` read — because
 * the per-family part of this fix is not the pruning, it is which declarations
 * open a slot (`refine`, `format: 'custom'`, `slot`). Get that filter wrong for
 * one family and pruning deletes a registry the emitter writes back on the very
 * next line, which is a worse bug than the one being fixed.
 *
 * Driven off `@maxstack/examples` for `seam-derivation.test.ts`'s reason: the
 * declarations that matter are the ones a real app produces, and a hand-built
 * spec pins the shape the test happened to imagine.
 *
 * Undeclaring is a spec **edit** rather than an op, exactly as it is for a page
 * (#338): there is no `schedules.undeclare`, and the way this reaches a real
 * project is somebody deleting the entry.
 */

import {
	createMemFs,
	generateImports,
	generateLive,
	generateSchedules,
	generateSources,
	MANIFEST_FILENAME,
	type MemFs,
	parseManifest,
	pruneSeams,
	type RouteManifest,
} from '@maxstack/core/ownership'
import { examples } from '@maxstack/examples'
import {
	importerDescriptors,
	liveDescriptors,
	scheduleDescriptors,
	seamFamilies,
	type SeamFamilyTarget,
	sourceDescriptors,
} from '@maxstack/mcp'
import type { SpecSystem } from '@maxstack/spec'
import { describe, expect, it } from 'vitest'

interface Family {
	registryId: string
	registryFile: string
	generate: (fs: MemFs, spec: SpecSystem) => Promise<unknown>
	undeclare: (spec: SpecSystem) => SpecSystem
}

const FAMILIES: Family[] = [
	{
		registryId: 'schedules:registry',
		registryFile: 'jobs/schedules.generated.ts',
		generate: (fs, spec) => generateSchedules(fs, scheduleDescriptors(spec)),
		undeclare: (spec) => ({ ...spec, schedules: undefined }),
	},
	{
		registryId: 'sources:registry',
		registryFile: 'sources/sources.generated.ts',
		generate: (fs, spec) => generateSources(fs, sourceDescriptors(spec)),
		undeclare: (spec) => ({ ...spec, sources: undefined }),
	},
	{
		registryId: 'imports:registry',
		registryFile: 'imports/imports.generated.ts',
		generate: (fs, spec) => generateImports(fs, importerDescriptors(spec)),
		undeclare: (spec) => ({ ...spec, imports: undefined }),
	},
	{
		registryId: 'live:registry',
		registryFile: 'live/live.generated.ts',
		generate: (fs, spec) => generateLive(fs, liveDescriptors(spec)),
		undeclare: (spec) => ({ ...spec, live: undefined }),
	},
]

describe.each(FAMILIES)(
	'undeclaring a seam family ($registryId)',
	({ registryId, registryFile, generate, undeclare }) => {
		it('unregisters the seam, keeps every stub, and settles', async () => {
			// The first corpus app whose declarations actually open this slot. A
			// family nobody in the corpus opens would make this test vacuous.
			const found = examples.find(
				(benchmark) =>
					familyOf(benchmark.spec, registryId).liveKeys.length > 0,
			)
			expect(found, `no corpus app opens ${registryId}`).toBeDefined()
			const spec = found?.spec as SpecSystem

			const fs = createMemFs()
			await generate(fs, spec)

			// Declared: the registry is on disk and tracked — and its manifest entry
			// is what `owned.generated.tsx` keys the runtime's import off.
			expect(await fs.exists(registryFile)).toBe(true)
			const stubs = (await manifestOf(fs)).entries
				.filter((e) => e.ownership === 'user')
				.map((e) => e.file)
			expect(stubs.length).toBeGreaterThan(0)
			// Somebody's domain logic, which is the whole reason the seam exists.
			for (const stub of stubs) await fs.write(stub, '// mine, by hand\n')

			const after = undeclare(spec)
			const { results } = await pruneSeams(fs, seamFamilies(after))

			// 1. Unregistered. Gone from disk, and — the safety-critical half — gone
			//    from the manifest, so the runtime stops importing it. A surviving
			//    registry is not inert the way a stale route is: a schedule handler
			//    it names stays resolvable to the job queue, and the work behind one
			//    reaches external systems and writes rows.
			expect(results).toContainEqual(
				expect.objectContaining({ file: registryFile, action: 'deleted' }),
			)
			expect(await fs.exists(registryFile)).toBe(false)
			expect((await manifestOf(fs)).entries.map((e) => e.id)).not.toContain(
				registryId,
			)

			// 2. The work survived, byte for byte, and is reported rather than
			//    silently orphaned.
			for (const stub of stubs) {
				expect(await fs.read(stub), stub).toContain('// mine, by hand')
			}
			expect(
				results.filter((r) => stubs.includes(r.file)).map((r) => r.action),
			).toEqual(stubs.map(() => 'kept-owned'))

			// 3. Stable: a second pass over the same tree changes nothing.
			const before = fs.snapshot()
			const second = await pruneSeams(fs, seamFamilies(after))
			expect(fs.snapshot()).toEqual(before)
			expect(second.results.every((r) => r.action === 'kept-owned')).toBe(true)

			// 4. Re-declaring brings the registry back and reuses the filled stubs
			//    rather than reseeding them — never-clobber survives the round trip.
			await generate(fs, spec)
			expect(await fs.exists(registryFile)).toBe(true)
			for (const stub of stubs) {
				expect(await fs.read(stub), stub).toContain('// mine, by hand')
			}
		})
	},
)

/**
 * The other half of the set difference, and the one a wrong `liveKeys` filter
 * breaks: a project regenerated against its own spec must lose nothing. This is
 * what stops `pruneSeams` deleting a registry `generateSources` writes back a
 * line later, which would make every run report a deletion and a creation of the
 * same file forever.
 */
describe('a declared seam is untouched', () => {
	it('prunes nothing from any corpus app regenerated against its own spec', async () => {
		for (const benchmark of examples) {
			const fs = createMemFs()
			for (const family of FAMILIES) {
				await family.generate(fs, benchmark.spec)
			}
			const before = fs.snapshot()

			const { results } = await pruneSeams(fs, seamFamilies(benchmark.spec))

			expect(results, benchmark.id).toEqual([])
			expect(fs.snapshot(), benchmark.id).toEqual(before)
		}
	})
})

function familyOf(spec: SpecSystem, registryId: string): SeamFamilyTarget {
	const family = seamFamilies(spec).find((f) => f.registryId === registryId)
	if (!family) throw new Error(`unknown seam family ${registryId}`)
	return family
}

async function manifestOf(fs: MemFs): Promise<RouteManifest> {
	return parseManifest(await fs.read(MANIFEST_FILENAME))
}
