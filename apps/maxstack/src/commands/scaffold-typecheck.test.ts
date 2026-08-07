/**
 * The scaffold's `typecheck` script has to be able to run — and has to be
 * looking at something (#347).
 *
 * A project scaffolded before this test existed failed `tsc --noEmit` with two
 * dozen unresolved-module errors the moment its spec had one entity, and the
 * worst of them was on `*.slots.tsx`: with `react/jsx-runtime` unresolvable,
 * every JSX element in the one file a user actually writes was `any`. The gate
 * ran, and it checked nothing.
 *
 * So this test builds the file tree `maxstack gen` produces — through the real
 * emitters, not through copies of their output — drops the real scaffolded
 * `tsconfig.json` next to it, and runs the compiler for real. Twice:
 *
 *   1. clean, which is the claim `pnpm typecheck` makes to a user; and
 *   2. with a slot deliberately mis-typed, because a gate that passes because
 *      it resolved nothing looks exactly like a gate that passes.
 *
 * `node_modules/maxstack-runtime/workspace` is symlinked to this checkout, which
 * is what the published package's source snapshot is a copy of (`cloneWorkspace`
 * in `build.ts` clones it structurally, so every path below holds verbatim).
 */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import * as ownership from '@maxstack/core/ownership'
import {
	addRouteToManifest,
	blockSlotPropsImport,
	blockSlotsForResource,
	EMPTY_ROUTES_MANIFEST,
	emitBlockSlotStub,
	emitImportParserStub,
	emitImportRegistry,
	emitLiveComponentStub,
	emitLiveRegistry,
	emitResourcePage,
	emitScheduleHandlerStub,
	emitScheduleRegistry,
	emitSourceRefinerStub,
	emitSourceRegistry,
	emitUserSlotStub,
	importerFilePaths,
	liveFilePaths,
	type PageDescriptor,
	pageFilePaths,
	scheduleFilePaths,
	sourceFilePaths,
} from '@maxstack/core/ownership'
import { e2eTestsGenerator, type GeneratorResult } from '@maxstack/mcp'
import { minimalPRD, newSpecSystem, suggested } from '@maxstack/spec'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RUNTIME_TYPE_PATHS, scaffoldPackageJson, TSCONFIG } from './init.ts'

const execFileAsync = promisify(execFile)

/** This checkout — `apps/maxstack/src/commands/` up four. */
const REPO_ROOT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'../../../..',
)
const TSC = join(REPO_ROOT, 'node_modules/.bin/tsc')

const PAGE: PageDescriptor = {
	resource: 'deck',
	title: 'Decks',
	routePath: '/decks',
	slots: ['afterList'],
}

/** Every seam that puts a file into a project's app dir, with the descriptors
 * the generators would hand it. Kept in one place so the roster assertion below
 * has something concrete to be a roster of. */
function projectFiles(): Record<string, string> {
	const page = pageFilePaths(PAGE.resource)
	const blocks = blockSlotsForResource(PAGE.resource, ['name'])
	const schedule = { key: 'invoice.recurring', description: 'Bill monthly.' }
	const schedulePaths = scheduleFilePaths(schedule.key)
	const source = { key: 'isbn.lookup', description: 'Look an ISBN up.' }
	const sourcePaths = sourceFilePaths(source.key)
	const importer = { key: 'anki.apkg', description: 'Read an Anki deck.' }
	const importerPaths = importerFilePaths(importer.key)
	const live = { key: 'deck.board', description: 'A live board.' }
	const livePaths = liveFilePaths(live.key)

	const specForE2e = newSpecSystem(
		minimalPRD({
			title: 'Decks',
			tldr: 'a flashcard app',
			problem: 'cards are on paper',
			northStar: 'Cards reviewed',
			persona: 'A student',
			differentiation: 'it is derived from a spec',
		}),
	)
	specForE2e.pages.pages.push({
		id: 'pg-decks',
		name: 'Decks',
		route: '/decks',
		entityId: 'e-deck',
		provenance: suggested(),
		blocks: [],
		e2eTests: ['I can add a deck'],
	})

	const files: Record<string, string> = {
		// Pages: the generated route module and the user-owned slot file beside
		// it, the slot file carrying both the page-level stub and every block-slot
		// fill `maxstack slots fill` can write into it.
		[page.routeFile]: emitResourcePage(PAGE),
		[page.slotFile]: [
			blockSlotPropsImport(blocks),
			'',
			emitUserSlotStub(PAGE),
			blocks.map((b) => emitBlockSlotStub(b)).join('\n\n'),
			'',
		].join('\n'),
		[page.routesManifest]: addRouteToManifest(EMPTY_ROUTES_MANIFEST, {
			path: PAGE.routePath,
			file: `./${page.routeFile}`,
		}),
		// The non-page seams: an owned stub plus the framework-owned registry
		// that imports it.
		[schedulePaths.handlerFile]: emitScheduleHandlerStub({
			...schedule,
			runAs: 'system',
			recurrence: 'monthly on the 1st',
		}),
		[schedulePaths.registryFile]: emitScheduleRegistry([
			{
				...schedule,
				runAs: 'system',
				recurrence: 'monthly on the 1st',
			},
		]),
		[sourcePaths.refinerFile]: emitSourceRefinerStub({
			...source,
			mode: 'enrich',
			endpoint: 'https://example.test',
			refine: true,
		}),
		[sourcePaths.registryFile]: emitSourceRegistry([
			{
				...source,
				mode: 'enrich',
				endpoint: 'https://example.test',
				refine: true,
			},
		]),
		[importerPaths.parserFile]: emitImportParserStub({
			...importer,
			format: 'custom',
			resource: 'card',
			parserSlot: 'anki-apkg',
		}),
		[importerPaths.registryFile]: emitImportRegistry([
			{
				...importer,
				format: 'custom',
				resource: 'card',
				parserSlot: 'anki-apkg',
			},
		]),
		[livePaths.componentFile]: emitLiveComponentStub({
			...live,
			kind: 'query',
			resource: 'deck',
			bound: 'the viewer’s own rows',
			fields: ['name'],
			slot: true,
		}),
		[livePaths.registryFile]: emitLiveRegistry([
			{
				...live,
				kind: 'query',
				resource: 'deck',
				bound: 'the viewer’s own rows',
				fields: ['name'],
				slot: true,
			},
		]),
	}
	// The Playwright stubs, which are the author's from the moment they land.
	// `run` is sync for this generator; the declared type allows a promise.
	const e2e = e2eTestsGenerator.run(specForE2e, {}) as GeneratorResult
	for (const a of e2e.artifacts) files[a.path] = a.content
	return files
}

async function writeTree(
	root: string,
	files: Record<string, string>,
): Promise<void> {
	for (const [rel, content] of Object.entries(files)) {
		const dest = join(root, 'app', rel)
		await mkdir(dirname(dest), { recursive: true })
		await writeFile(dest, content)
	}
}

/** Run the scaffolded `typecheck` script's compiler over the project. */
async function typecheck(root: string): Promise<{ code: number; out: string }> {
	try {
		const { stdout } = await execFileAsync(TSC, ['--noEmit', '-p', root])
		return { code: 0, out: stdout }
	} catch (err) {
		const e = err as { code?: number; stdout?: string; stderr?: string }
		return { code: e.code ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
	}
}

describe('a scaffolded project can typecheck what maxstack gen writes (#347)', () => {
	let root = ''

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), 'maxstack-scaffold-tsc-'))
		await writeFile(join(root, 'tsconfig.json'), TSCONFIG)
		await writeTree(root, projectFiles())

		// The dependency surface an `install` would provide: the runtime's source
		// snapshot (this checkout), and the three third-party packages the scaffold
		// declares for the code in `app/`.
		const nm = join(root, 'node_modules')
		await mkdir(join(nm, 'maxstack-runtime'), { recursive: true })
		await symlink(REPO_ROOT, join(nm, 'maxstack-runtime/workspace'), 'dir')
		const web = join(REPO_ROOT, 'apps/web/node_modules')
		await mkdir(join(nm, '@types'), { recursive: true })
		await mkdir(join(nm, '@playwright'), { recursive: true })
		await symlink(join(web, 'react'), join(nm, 'react'), 'dir')
		await symlink(join(web, '@types/react'), join(nm, '@types/react'), 'dir')
		await symlink(
			join(REPO_ROOT, 'node_modules/@types/node'),
			join(nm, '@types/node'),
			'dir',
		)
		await symlink(
			join(web, '@playwright/test'),
			join(nm, '@playwright/test'),
			'dir',
		)
	}, 60_000)

	afterAll(async () => {
		if (root) await rm(root, { recursive: true, force: true })
	})

	it('compiles the generated tree clean', async () => {
		const { code, out } = await typecheck(root)
		expect(out).toBe('')
		expect(code).toBe(0)
	}, 120_000)

	it('still fails on a slot filled with the wrong prop type', async () => {
		// The proof that the clean run above means something. If the type surface
		// were unresolved, `RowSlotProps` would be `any` and this would pass.
		const slot = join(root, 'app', pageFilePaths(PAGE.resource).slotFile)
		const good = await import('node:fs/promises').then((fs) =>
			fs.readFile(slot, 'utf8'),
		)
		await writeFile(
			slot,
			[
				"import type { RowSlotProps } from '@maxstack/ui'",
				'',
				'export function deck__row({ row, notAProp }: RowSlotProps) {',
				'\treturn <p>{row.id}{notAProp}</p>',
				'}',
				'',
			].join('\n'),
		)
		try {
			const { code, out } = await typecheck(root)
			expect(code).not.toBe(0)
			expect(out).toContain("Property 'notAProp' does not exist")
		} finally {
			await writeFile(slot, good)
		}
	}, 120_000)

	it('declares every specifier the generated tree imports', async () => {
		const declared = new Set([
			...Object.keys(RUNTIME_TYPE_PATHS),
			...Object.keys(
				JSON.parse(await scaffoldPackageJson('probe')).devDependencies,
			),
		])
		const matches = (spec: string): boolean => {
			if (declared.has(spec)) return true
			// `react/jsx-runtime`, `@maxstack/features/jobs` — a subpath is covered
			// by its package (or by a `*` mapping, which is keyed with the slash).
			const pkg = spec.startsWith('@')
				? spec.split('/').slice(0, 2).join('/')
				: (spec.split('/')[0] ?? spec)
			return (
				declared.has(pkg) ||
				[...declared].some(
					(d) => d.endsWith('/*') && spec.startsWith(d.slice(0, -1)),
				)
			)
		}
		const bare = new Set<string>()
		for (const content of Object.values(projectFiles())) {
			for (const m of content.matchAll(/from '([^'.][^']*)'/g)) {
				if (m[1]) bare.add(m[1])
			}
		}
		expect(bare.size).toBeGreaterThan(0)
		expect([...bare].filter((s) => !matches(s))).toEqual([])
	})

	it('pins the emitter roster, so a new seam cannot skip this test', () => {
		// Every `emit*` in the ownership layer writes a file into somebody's
		// project. A new one that imports a package the scaffold does not declare
		// breaks that project's `typecheck` and nothing else would notice — so
		// adding one has to mean coming back here and generating it above.
		expect(
			Object.keys(ownership)
				.filter((k) => k.startsWith('emit'))
				.sort(),
		).toEqual([
			'emitBlockSlotStub',
			'emitImportParserStub',
			'emitImportRegistry',
			'emitLiveComponentStub',
			'emitLiveRegistry',
			'emitMissingSlotStubs',
			'emitResourcePage',
			'emitScheduleHandlerStub',
			'emitScheduleRegistry',
			'emitSourceRefinerStub',
			'emitSourceRegistry',
			'emitUserSlotStub',
		])
	})
})
