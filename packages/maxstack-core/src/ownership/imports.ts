/**
 * **The import parser extension point** — the generated half.
 *
 * A declared importer (`imports.declare`) says which entity a file lands in,
 * which column maps to which field, whether an existing row may be overwritten,
 * and how many rows one run may take. For a CSV, an NDJSON dump or a JSON array
 * that is the *whole thing*, and this module emits **nothing at all**: the
 * declaration is the implementation, and a project whose importers are all
 * ordinary tabular files grows no code. That is the honest half of the win, and
 * it is worth stating plainly rather than quietly, because the temptation in a
 * feature like this is to emit a stub per importer so the generator looks busy.
 *
 * What a declaration cannot say is how to read a `.apkg`: a zip containing a
 * SQLite database, a media manifest, and note types whose fields are positional.
 * The two ways to handle that are both bad if taken alone — teach the vocabulary
 * about archive formats (and then about `.xlsx`, and then about the next
 * vendor's dump, forever, which is the framework-as-cage failure), or leave the
 * maintainer to eject the whole import surface and re-implement validation,
 * upsert and audit attribution along with the parser.
 *
 * So the platform generates the seam and the user fills it, exactly as it does
 * for a schedule handler and a source refiner:
 *
 *   - `imports/imports.generated.ts` — **framework-owned**. A registry mapping
 *     every `format: 'custom'` importer to its parser. Re-emitted on every
 *     regeneration; nobody edits it.
 *   - `imports/<key>.parse.ts` — **user-owned, written once**. Called with the
 *     chunk stream and returning records. Regeneration never touches it again.
 *
 * **The slot stops at parsing, and that is what keeps it from being a bypass.**
 * A parser returns `Record<string, string>` records — the same shape the CSV
 * reader returns — which then go through the identical mapping, the identical
 * `validateData`, the identical gated upsert lookup and the identical
 * `opCreate`/`opUpdate`. It has no access to the store, the registry, the user or
 * the plan, so there is nothing it could write and no row it could see. That is
 * the same argument #173 makes about re-typing a refiner's return value, made
 * one step earlier: the bespoke code never reaches the write path at all.
 *
 * That is what moves an ask like cardstack's Anki import from *off-surface*
 * (weight 8: no op, no slot, no guidance) to *slot fill* (weight 3). The honesty
 * of the win is in what did **not** happen: the op vocabulary did not learn about
 * zip archives, and the platform still cannot read a `.apkg` — it just knows
 * where the code that can goes, and promises never to overwrite it.
 *
 * **Nothing here reads a file, a clock or a network.** The emitted tree is a
 * function of the declaration alone — see
 * `apps/maxstack/src/lib/import-determinism.test.ts`.
 */

import {
	MANIFEST_FILENAME,
	parseManifest,
	type RouteManifest,
	serializeManifest,
} from './manifest.ts'
import type { Fs, WriteResult } from './write.ts'
import { writeGenerated, writeUserFileOnce } from './write.ts'

/** What the generator needs to know about one declared importer. */
export interface ImporterDescriptor {
	/** The declared key, e.g. `anki.apkg`. */
	key: string
	/** One line, rendered into the stub so the file explains itself. */
	description: string
	/** `csv` | `ndjson` | `json` | `custom`. Only `custom` emits anything. */
	format: string
	/** The resource rows land in, for the stub's header. */
	resource: string
	/** The declared parser module name. Present iff `format` is `custom`. */
	parserSlot?: string
}

/** An importer key as a filesystem-safe module name (`anki.apkg` → `anki-apkg`). */
export function importerModuleName(key: string): string {
	return key.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')
}

/** Where an importer's files live, relative to the project root. */
export function importerFilePaths(key: string): {
	parserFile: string
	registryFile: string
} {
	return {
		parserFile: `imports/${importerModuleName(key)}.parse.ts`,
		registryFile: 'imports/imports.generated.ts',
	}
}

/** Whether a descriptor opens a slot at all. Only `custom` importers do. */
function isCustom(descriptor: ImporterDescriptor): boolean {
	return descriptor.format === 'custom'
}

/**
 * The user-owned parser stub. Written once and never again.
 *
 * The header states the three things a maintainer would otherwise learn the hard
 * way: what the return shape is and why it is deliberately narrow, that the
 * function must stream rather than buffer, and — the important one — that
 * nothing this file returns skips a check. A parser author who believes they are
 * writing an *importer* will eventually try to do a lookup or a write in here;
 * saying up front that there is nothing to write with is cheaper than the code
 * review that catches it.
 */
export function emitImportParserStub(descriptor: ImporterDescriptor): string {
	return [
		`/**`,
		` * Parser slot for the "${descriptor.key}" importer — YOURS.`,
		` *`,
		` * ${descriptor.description}`,
		` *`,
		` * Rows land in "${descriptor.resource}".`,
		` *`,
		` * This file is written once and never regenerated: edit it freely.`,
		` *`,
		` * You are given the uploaded bytes as a stream of chunks and you yield`,
		` * records — one object per row, keyed by column name, with string values.`,
		` * That is the SAME shape the built-in CSV reader yields, and it is the`,
		` * whole of your job: the declared column mapping, the per-row validation,`,
		` * the upsert lookup and the write all happen downstream, identically to a`,
		` * CSV's. Nothing you return skips a check, and there is nothing here to`,
		` * write with — no store, no registry, no user. That is deliberate: it is`,
		` * what keeps this slot an extension point rather than a way around the`,
		` * rules.`,
		` *`,
		` * **Stream, do not buffer.** Yield each record as you read it. The plan is`,
		` * bounded by the importer's declared maxRows; the file is not, and reading`,
		` * it whole is how a large upload takes the server down.`,
		` */`,
		``,
		`import type { ImportRecord } from '@maxstack/core'`,
		``,
		`export default async function* parse(`,
		`\tchunks: AsyncIterable<Uint8Array>,`,
		`): AsyncGenerator<ImportRecord> {`,
		`\t// TODO: read \`chunks\` and yield one record per row, e.g.`,
		`\t//   yield { GUID: '...', Front: '...', Back: '...' }`,
		`\tfor await (const _chunk of chunks) {`,
		`\t\tvoid _chunk`,
		`\t}`,
		`}`,
		``,
	].join('\n')
}

/** The framework-owned registry: declared key → parser module. */
export function emitImportRegistry(
	descriptors: readonly ImporterDescriptor[],
): string {
	const sorted = [...descriptors]
		.filter(isCustom)
		.sort((a, b) => a.key.localeCompare(b.key))
	const imports = sorted.map(
		(d, i) => `import parse${i} from './${importerModuleName(d.key)}.parse.ts'`,
	)
	const entries = sorted.map((d, i) => `\t'${d.key}': parse${i},`)
	return [
		'// GENERATED by maxstack — do not edit.',
		'//',
		'// The declared importers whose format the platform cannot read, and the',
		'// parser each one calls. Regenerated from `imports.json` on every build;',
		'// the parser modules it imports are yours and are never rewritten.',
		'//',
		'// Importers reading csv, ndjson or json are absent here on purpose: their',
		'// declaration IS the implementation, and they need no code at all.',
		'',
		"import type { ImportParser } from '@maxstack/core'",
		...imports,
		'',
		'export const importParsers: Record<string, ImportParser> = {',
		...entries,
		'}',
		'',
	].join('\n')
}

export interface ImportGenerateResult {
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
 * Generate the parser seam for every importer that needs one. Idempotent: the
 * registry is rewritten only when its content changed, and each stub is written
 * once and never again.
 *
 * A project with no *custom* importers emits **nothing** — not an empty
 * registry, and not an `imports/` directory. The same absence rule the spec layer
 * uses, and here it carries the same second meaning it does for sources: an empty
 * tree is the platform saying the declarations were enough.
 */
export async function generateImports(
	fs: Fs,
	descriptors: readonly ImporterDescriptor[],
): Promise<ImportGenerateResult> {
	let manifest = await loadManifest(fs)
	const results: WriteResult[] = []
	const custom = descriptors.filter(isCustom)
	if (custom.length === 0) return { manifest, results }

	const registryFile = importerFilePaths('_').registryFile
	const registry = await writeGenerated(
		fs,
		manifest,
		{ id: 'imports:registry', routePath: '', file: registryFile },
		emitImportRegistry(custom),
	)
	manifest = registry.manifest
	results.push(registry.result)

	for (const descriptor of custom) {
		const { parserFile } = importerFilePaths(descriptor.key)
		const written = await writeUserFileOnce(
			fs,
			manifest,
			`import:${descriptor.key}`,
			parserFile,
			emitImportParserStub(descriptor),
		)
		manifest = written.manifest
		results.push(written.result)
	}

	await fs.write(MANIFEST_FILENAME, serializeManifest(manifest))
	return { manifest, results }
}
