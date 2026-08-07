/**
 * The generation pipeline behind `maxstack gen` / `upgrade` / `validate`:
 * drive the real Phase-2 ownership generators (ts-morph emission + never-clobber
 * writer + slot machinery) over a project's spec, landing files on disk through
 * the `node:fs` adapter. Pure w.r.t. policy — the caller decides what to do with
 * the per-file results (print them, or fail a regen-safety check).
 */

import {
	createNodeFs,
	emptyManifest,
	type Fs,
	generateImports,
	generateLive,
	generateResourcePage,
	generateSchedules,
	generateSources,
	generationWatermark,
	MANIFEST_FILENAME,
	type OwnershipDriftReport,
	ownershipDrift,
	parseManifest,
	recordGeneration,
	serializeManifest,
	type WriteResult,
} from '@maxstack/core/ownership'
import {
	defaultGeneratorRunner,
	importerDescriptors,
	liveDescriptors,
	pageDescriptors,
	regenTargets,
	scheduleDescriptors,
	sourceDescriptors,
} from '@maxstack/mcp'
import { resolve } from 'node:path'
import type { SpecSystem } from '@maxstack/spec'
import type { Project } from './project.ts'
import { appendRegenEntry, regenEntry } from './regen-log.ts'

export interface GenerateSummary {
	/** Route/slot/manifest writes, per page. */
	writes: WriteResult[]
	/** Doc + e2e artifacts (always overwritten — framework-owned). */
	artifacts: string[]
}

/** Generate the whole app tree for a project's current spec. */
export async function generateProject(project: Project): Promise<GenerateSummary> {
	const spec = await project.spec.load()
	const fs = createNodeFs(project.appPath)
	const writes: WriteResult[] = []

	// Descriptors for the whole page list at once — a page's route module is a
	// fact about its siblings (two pages over one entity are two modules, #337),
	// which a per-page fold cannot see.
	for (const descriptor of pageDescriptors(spec.pages.pages)) {
		const { results } = await generateResourcePage(fs, descriptor)
		writes.push(...results)
	}

	writes.push(...(await generateSeams(fs, spec)))

	const artifacts = await generateArtifacts(spec, project)
	await stampGeneration(fs, spec.opLog.length)
	// The ledger: what this run cost, recorded at the one moment it is
	// known. A day, not an instant — see `RegenEntry.at`.
	await appendRegenEntry(
		resolve(project.root, project.config.dataDir),
		regenEntry(
			writes,
			artifacts,
			spec.opLog.length,
			new Date().toISOString().slice(0, 10),
		),
	)
	return { writes, artifacts }
}

/**
 * Record how much of the op log this run generated from.
 *
 * Last, and only after the seams and artifacts have landed, so the watermark is
 * a statement about work that finished. A run that throws half way leaves the
 * old watermark in place, which keeps an undo offered — the safe direction,
 * since a failed generate wrote nothing to be inconsistent with.
 *
 * The manifest is re-read here rather than threaded through: every generator
 * above loads, mutates and persists it independently, so anything this function
 * held from before would be stale by now.
 */
async function stampGeneration(fs: Fs, opCount: number): Promise<void> {
	const manifest = (await fs.exists(MANIFEST_FILENAME))
		? parseManifest(await fs.read(MANIFEST_FILENAME))
		: emptyManifest()
	await fs.write(
		MANIFEST_FILENAME,
		serializeManifest(recordGeneration(manifest, opCount)),
	)
}

/**
 * The four non-page seams — schedules, sources, imports and
 * live channels — for a project's current spec.
 *
 * These used to be emitted by the harness and nothing else: the
 * generators existed, were tested and were *measured*, and a human or an agent
 * who ran `maxstack gen` got none of them. A declared schedule dead-lettered at
 * runtime pointing at a handler file the platform had never written and nothing
 * was going to write.
 *
 * Driven from the **same descriptor projections the drift report derives from**
 * (`@maxstack/mcp`'s `scheduleDescriptors` &co), so the CLI, `maxstack drift`
 * and the harness cannot disagree about what the seam is — one derivation,
 * three surfaces, exactly as `regenTargets` argues for the page layer.
 *
 * Each generator's absence rule makes this free for a project that declares none
 * of them: no declaration, no directory. A project with no schedules does not
 * grow a `jobs/` folder to prove it.
 */
async function generateSeams(
	fs: Fs,
	spec: SpecSystem,
): Promise<WriteResult[]> {
	// Sequential, not concurrent: every generator reads, mutates and persists the
	// one ownership manifest, so interleaving them would lose entries.
	const schedules = await generateSchedules(fs, scheduleDescriptors(spec))
	const sources = await generateSources(fs, sourceDescriptors(spec))
	const imports = await generateImports(fs, importerDescriptors(spec))
	const live = await generateLive(fs, liveDescriptors(spec))
	return [
		...schedules.results,
		...sources.results,
		...imports.results,
		...live.results,
	]
}

async function generateArtifacts(
	spec: SpecSystem,
	project: Project,
): Promise<string[]> {
	const generators = defaultGeneratorRunner()
	const fs = createNodeFs(project.appPath)
	const written: string[] = []
	for (const name of ['docs', 'e2e-tests', 'types'] as const) {
		const result = await generators.run(name, spec, {})
		for (const artifact of result.artifacts) {
			// `e2e-tests` scaffolds ONCE and is then the author's.
			// Every other artifact here is fully derived and refreshed. Overwriting
			// an e2e spec deletes the filled-in bodies — the only part of the
			// declare -> generate -> run chain that is not derivable, and the whole
			// reason the chain is worth taking.
			if (name === 'e2e-tests' && (await fs.exists(artifact.path))) continue
			await fs.write(artifact.path, artifact.content)
			written.push(artifact.path)
		}
	}
	return written
}

/**
 * How much of the op log this project was last generated from, or null if it
 * never has been.
 *
 * Read from the manifest rather than from a file mtime: `gen` rewrites the tree,
 * so mtimes move for reasons that have nothing to do with what was derived, and
 * a project that was copied or checked out has none that mean anything at all.
 */
export async function projectGenerationWatermark(
	project: Project,
): Promise<number | null> {
	const fs = createNodeFs(project.appPath)
	if (!(await fs.exists(MANIFEST_FILENAME))) return null
	return generationWatermark(parseManifest(await fs.read(MANIFEST_FILENAME)))
}

/**
 * The ownership drift report for a project on disk: what you own, what it was
 * derived from, and how far behind the current derivation it has drifted.
 *
 * Read-only, always — this is information, not a demand. See
 * `@maxstack/core/ownership`'s `drift.ts` for why that distinction is load-
 * bearing rather than a style preference.
 */
export async function projectDrift(
	project: Project,
	spec: SpecSystem,
): Promise<OwnershipDriftReport> {
	const fs = createNodeFs(project.appPath)
	if (!(await fs.exists(MANIFEST_FILENAME))) {
		return {
			owned: [],
			ownedCount: 0,
			driftedCount: 0,
			inSyncCount: 0,
			authoredCount: 0,
			underivedCount: 0,
			missingCount: 0,
			rolesDriftCount: 0,
		}
	}
	const manifest = parseManifest(await fs.read(MANIFEST_FILENAME))
	return ownershipDrift(fs, manifest, regenTargets(spec))
}

/** True when a regeneration pass changed nothing the user owns — the
 * never-clobber invariant (§6 regen-safety) held. */
export function isRegenStable(writes: WriteResult[]): boolean {
	return writes.every(
		(w) => w.action === 'unchanged' || w.action === 'skipped-user-owned',
	)
}
