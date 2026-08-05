/**
 * **The external-source extension point** — the generated half.
 *
 * A declared source (`sources.declare`) says *where* the data comes from, *how*
 * the response maps onto columns, and *what budget* the request may spend. For
 * most integrations that is the whole thing, and this module emits **nothing**:
 * the declaration is the implementation, and a project whose sources all map
 * cleanly grows no code at all. That is the honest win — bookclub's ISBN lookup
 * is a spec op with no file behind it.
 *
 * What a declaration cannot say is the part that is genuinely code. crmlite's
 * synced inbox has to attach each message to the contact whose address it came
 * from, which is a lookup against local rows, not a path into a response. The
 * two ways to handle that are both bad if taken alone: teach the mapping
 * language about foreign-key resolution (and then about the next product's
 * variation on it, forever — the framework-as-cage failure), or leave the
 * maintainer to eject.
 *
 * So the platform generates the seam and the user fills it, exactly as it does
 * for a schedule handler:
 *
 *   - `sources/sources.generated.ts` — **framework-owned**. A registry mapping
 *     every source that declared `refine: true` to its refiner. Re-emitted on
 *     every regeneration; nobody edits it.
 *   - `sources/<key>.refine.ts` — **user-owned, written once**. Called with the
 *     raw remote record *and* the values the declared mapping already produced,
 *     returning the final values. Regeneration never touches it again.
 *
 * That is what moves an ask like crmlite's inbox sync from *off-surface*
 * (weight 8: no op, no slot, no guidance) to *slot fill* (weight 3). The
 * honesty of the win is in what did **not** happen: the op vocabulary did not
 * learn about email threading.
 *
 * **Nothing here reads a response, a job row, or a clock.** The emitted tree is
 * a function of the declaration alone, which is why declaring a source cannot
 * make generation reach the network — see
 * `apps/maxstack/src/lib/source-determinism.test.ts`.
 */

import {
	MANIFEST_FILENAME,
	parseManifest,
	type RouteManifest,
	serializeManifest,
} from './manifest.ts'
import type { Fs, WriteResult } from './write.ts'
import { writeGenerated, writeUserFileOnce } from './write.ts'

/** What the generator needs to know about one declared source. */
export interface SourceDescriptor {
	/** The declared key, e.g. `inbox.sync`. */
	key: string
	/** One line, rendered into the stub so the file explains itself. */
	description: string
	/** `enrich` or `sync` — rendered into the stub's header. */
	mode: string
	/** The origin the source reaches, for the stub's header. Never a credential. */
	endpoint: string
	/** Whether this source asked for a refiner slot. Only these emit files. */
	refine: boolean
}

/** A source key as a filesystem-safe module name (`a.b` → `a-b`). */
export function sourceModuleName(key: string): string {
	return key.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')
}

/** Where a source's files live, relative to the project root. */
export function sourceFilePaths(key: string): {
	refinerFile: string
	registryFile: string
} {
	return {
		refinerFile: `sources/${sourceModuleName(key)}.refine.ts`,
		registryFile: 'sources/sources.generated.ts',
	}
}

/**
 * The user-owned refiner stub. Written once and never again.
 *
 * The header states the two properties a maintainer would otherwise learn the
 * hard way: the return value is re-typed against the entity (so this is an
 * extension point and not a way around the column's own validation), and the
 * function may be called with the same record twice, because delivery through
 * the job queue is at-least-once exactly as it is for a schedule.
 */
export function emitSourceRefinerStub(descriptor: SourceDescriptor): string {
	return [
		`/**`,
		` * Refiner slot for the "${descriptor.key}" source — YOURS.`,
		` *`,
		` * ${descriptor.description}`,
		` *`,
		` * ${descriptor.mode} from ${descriptor.endpoint}.`,
		` *`,
		` * This file is written once and never regenerated: edit it freely.`,
		` *`,
		` * You are called with the raw remote record AND the values the declared`,
		` * mapping already produced, and you return the final values. Do here only`,
		` * what a path into a response cannot say — resolving a remote record to a`,
		` * local row, reconciling two providers, applying a merge policy.`,
		` *`,
		` * **Your return value is re-typed against the entity's declared columns.**`,
		` * This is an extension point, not a bypass: a value this returns goes`,
		` * through the same coercion a mapped one does, and one the column cannot`,
		` * hold is refused with a reason rather than written.`,
		` *`,
		` * **Delivery is at-least-once.** The same record can arrive twice. Keep`,
		` * this function pure with respect to the record it is given and a repeat`,
		` * is harmless.`,
		` */`,
		``,
		`import type { SourceRefineContext } from '@maxstack/features/sources'`,
		``,
		`export default function refine(`,
		`\tctx: SourceRefineContext,`,
		`): Record<string, unknown> {`,
		`\t// TODO: return the final values. \`ctx.values\` is what the declared`,
		`\t// mapping produced; spread it and override only what you need to.`,
		`\treturn ctx.values`,
		`}`,
		``,
	].join('\n')
}

/** The framework-owned registry: declared key → refiner module. */
export function emitSourceRegistry(
	descriptors: readonly SourceDescriptor[],
): string {
	const sorted = [...descriptors]
		.filter((d) => d.refine)
		.sort((a, b) => a.key.localeCompare(b.key))
	const imports = sorted.map(
		(d, i) => `import refine${i} from './${sourceModuleName(d.key)}.refine.ts'`,
	)
	const entries = sorted.map((d, i) => `\t'${d.key}': refine${i},`)
	return [
		'// GENERATED by maxstack — do not edit.',
		'//',
		'// The declared sources that asked for a refiner, and the slot each one',
		'// calls. Regenerated from `sources.json` on every build; the refiner',
		'// modules it imports are yours and are never rewritten.',
		'//',
		'// Sources that map cleanly are absent here on purpose: their declaration',
		'// IS the implementation, and they need no code at all.',
		'',
		"import type { SourceRefiner } from '@maxstack/features/sources'",
		...imports,
		'',
		'export const sourceRefiners: Record<string, SourceRefiner> = {',
		...entries,
		'}',
		'',
	].join('\n')
}

export interface SourceGenerateResult {
	manifest: RouteManifest
	results: WriteResult[]
}

async function loadManifest(fs: Fs): Promise<RouteManifest> {
	if (await fs.exists(MANIFEST_FILENAME)) {
		return parseManifest(await fs.read(MANIFEST_FILENAME))
	}
	return { version: 1, entries: [] }
}

/**
 * Generate the refiner seam for every source that asked for one. Idempotent:
 * the registry is rewritten only when its content changed, and each stub is
 * written once and never again.
 *
 * A project with no *refining* sources emits **nothing** — not an empty
 * registry, and not a `sources/` directory. The same absence rule the spec
 * layer uses, and here it carries a second meaning: an empty tree is the
 * platform saying the declarations were enough.
 */
export async function generateSources(
	fs: Fs,
	descriptors: readonly SourceDescriptor[],
): Promise<SourceGenerateResult> {
	let manifest = await loadManifest(fs)
	const results: WriteResult[] = []
	const refining = descriptors.filter((d) => d.refine)
	if (refining.length === 0) return { manifest, results }

	const registryFile = sourceFilePaths('_').registryFile
	const registry = await writeGenerated(
		fs,
		manifest,
		{ id: 'sources:registry', routePath: '', file: registryFile },
		emitSourceRegistry(refining),
	)
	manifest = registry.manifest
	results.push(registry.result)

	for (const descriptor of refining) {
		const { refinerFile } = sourceFilePaths(descriptor.key)
		const written = await writeUserFileOnce(
			fs,
			manifest,
			`source:${descriptor.key}`,
			refinerFile,
			emitSourceRefinerStub(descriptor),
		)
		manifest = written.manifest
		results.push(written.result)
	}

	await fs.write(MANIFEST_FILENAME, serializeManifest(manifest))
	return { manifest, results }
}
