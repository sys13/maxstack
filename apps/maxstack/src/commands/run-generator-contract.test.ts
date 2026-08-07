/**
 * The `run_generator` contract — its tool description against the host that
 * actually answers it (#334).
 *
 * The description is the only thing a client has. It says the disk-backed host
 * (the CLI over stdio, which is what every `.mcp.json` registration uses) lands
 * the files and reports them one line per file in `notes`, with `artifacts`
 * deliberately EMPTY; and that a host which cannot write returns the files as
 * data in `artifacts` ({path, content}) instead. Both halves were once true of
 * the code and false of the description: an agent read "returns the generated
 * artifacts ({path, content})", got `[]`, concluded nothing had been generated,
 * and went back to driving a browser by hand while the files sat in `app/`.
 *
 * These are AGREEMENT tests, not two independent assertions. The note prefixes
 * are PARSED OUT OF THE DESCRIPTION and compared against the writer's own
 * vocabulary, so neither side can move without the other: rewording the
 * description drops a prefix the writer still emits, and widening
 * `WriteResult['action']` breaks {@link WRITE_ACTIONS} at typecheck, which
 * breaks this comparison. Two hand-kept lists that merely happen to match today
 * is the exact failure mode being closed.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WriteResult } from '@maxstack/core/ownership'
import {
	createInMemorySpecStore,
	defaultCheckRunner,
	defaultGeneratorRunner,
	e2eTestsGenerator,
	type PlatformContext,
	pageGenerator,
	platformTools,
	typesGenerator,
} from '@maxstack/mcp'
import {
	type EntitySpec,
	manual,
	newSpecSystem,
	type OpId,
	type PageSpec,
	type SpecSystem,
} from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type Project } from '../lib/project.ts'
import {
	diskE2eGenerator,
	diskPageGenerator,
	diskTypesGenerator,
} from './mcp.ts'

/**
 * Every action the never-clobber writer can decide on, as a runtime value.
 *
 * A `Record<WriteResult['action'], true>` and not a string array: adding a case
 * to the union leaves this object missing a key, and removing one leaves it with
 * an excess key. Either way `pnpm typecheck` fails here — which is what makes
 * the comparison below a pin rather than a coincidence.
 */
const WRITE_ACTIONS: Record<WriteResult['action'], true> = {
	appended: true,
	created: true,
	overwritten: true,
	'skipped-user-owned': true,
	unchanged: true,
}

/**
 * `wrote:` is not a `WriteResult.action` — the e2e/types wrappers and the
 * non-route artifacts emit it directly — so it is named here and nowhere else.
 */
const EXTRA_NOTE_PREFIXES = ['wrote'] as const

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

const page: PageSpec = {
	id: 'pg-orders',
	name: 'Orders',
	route: '/orders',
	entityId: 'e-order',
	blocks: [],
	e2eTests: ['lists all orders'],
	provenance: manual(),
}

function specWithAPage(): SpecSystem {
	const spec = newSpecSystem(tasklyPRD)
	return {
		...spec,
		data: { entities: [entity] },
		pages: { pages: [page] },
	}
}

function contextFor(spec: SpecSystem): PlatformContext {
	let n = 0
	return {
		spec: createInMemorySpecStore(spec),
		generators: defaultGeneratorRunner(),
		checks: defaultCheckRunner(),
		origin: 'ai',
		now: () => '2026-08-06',
		nextOpId: () => `op-${++n}` as OpId,
	}
}

/** The `run_generator` description exactly as a client receives it. */
function runGeneratorDescription(): string {
	const tool = platformTools(contextFor(specWithAPage())).find(
		(t) => t.name === 'run_generator',
	)
	if (!tool) throw new Error('run_generator missing from the tool listing')
	return tool.description
}

/**
 * The note prefixes the description names, read out of the description itself.
 *
 * It quotes them as `"created:"`, so that is what is matched — a restatement
 * here would be a third copy and could agree with neither side.
 */
function describedNotePrefixes(description: string): string[] {
	return [...description.matchAll(/"([a-z][a-z-]*):"/g)]
		.map((m) => m[1] as string)
		.sort()
}

const dirs: string[] = []

afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function tempProject(): Promise<Project> {
	const root = await mkdtemp(join(tmpdir(), 'maxstack-rungen-'))
	dirs.push(root)
	const spec = specWithAPage()
	return {
		root,
		appPath: root,
		specDir: join(root, 'spec'),
		config: { ...DEFAULT_CONFIG, appDir: '.', name: 'contract' },
		spec: createInMemorySpecStore(spec),
	}
}

describe('run_generator description ↔ the note vocabulary it names', () => {
	it('names exactly the prefixes the writer can emit, and no others', () => {
		// The pin. A prefix in the description that the writer never emits sends a
		// client looking for a line that will not come; a prefix the writer emits
		// that the description omits is a line the client cannot interpret.
		expect(describedNotePrefixes(runGeneratorDescription())).toEqual(
			[...Object.keys(WRITE_ACTIONS), ...EXTRA_NOTE_PREFIXES].sort(),
		)
	})

	it('says outright that an empty `artifacts` is a success on the disk host', () => {
		// The sentence this whole issue is about: without it, `artifacts: []` reads
		// as "nothing was generated" and the generator chain gets abandoned.
		const description = runGeneratorDescription()
		expect(description).toMatch(/artifacts.{0,40}EMPTY/i)
		expect(description).toMatch(/does NOT mean nothing was generated/)
		expect(description).toMatch(/`notes`/)
	})
})

describe('run_generator description ↔ what the disk host returns', () => {
	it('lands the page tree and reports it only in described note prefixes', async () => {
		const project = await tempProject()
		const result = await diskPageGenerator(project).run(
			await project.spec.load(),
			{},
		)

		expect(result.artifacts).toEqual([])
		expect(result.notes.length).toBeGreaterThan(0)
		expectNotesDescribed(result.notes)
	})

	it('reports the e2e scaffold only in described note prefixes', async () => {
		const project = await tempProject()
		const result = await diskE2eGenerator(project).run(
			await project.spec.load(),
			{},
		)

		expect(result.artifacts).toEqual([])
		expect(result.notes).toContain('wrote: e2e/orders.spec.ts')
		expectNotesDescribed(result.notes)
	})

	it('reports the generated types only in described note prefixes', async () => {
		const project = await tempProject()
		const result = await diskTypesGenerator(project).run(
			await project.spec.load(),
			{},
		)

		expect(result.artifacts).toEqual([])
		expect(result.notes).toContain('wrote: generated/types.ts')
		expectNotesDescribed(result.notes)
	})
})

describe('run_generator description ↔ what a host that cannot write returns', () => {
	it('returns the files as {path, content} from the built-ins', async () => {
		// The other half of the promise. The workbench has no disk, so `artifacts`
		// is the only channel it has — if these ever went empty too, the
		// description's "returns the files as data in `artifacts`" would be a
		// promise nobody keeps on any host.
		const spec = specWithAPage()
		for (const generator of [
			pageGenerator,
			e2eTestsGenerator,
			typesGenerator,
		]) {
			const result = await generator.run(spec, {})
			expect(result.artifacts.length, generator.name).toBeGreaterThan(0)
			for (const artifact of result.artifacts) {
				expect(artifact.path, generator.name).toBeTruthy()
				expect(artifact.content, generator.name).toBeTruthy()
			}
		}
	})
})

/**
 * Every `prefix: value` note uses a prefix the description names.
 *
 * Prose notes (a generator with nothing to do says so in a sentence) are left
 * alone deliberately — the description promises a vocabulary for the per-file
 * lines, not that every note is one.
 */
function expectNotesDescribed(notes: string[]): void {
	const described = new Set(describedNotePrefixes(runGeneratorDescription()))
	for (const note of notes) {
		const prefix = /^([a-z][a-z-]*): /.exec(note)?.[1]
		if (prefix === undefined) continue
		expect(described, `undescribed note prefix in: ${note}`).toContain(prefix)
	}
}
