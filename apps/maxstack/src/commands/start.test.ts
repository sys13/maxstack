/**
 * `maxstack start` — the deterministic half, gated in CI.
 *
 * `--no-dev` stops after everything that touches disk: the scaffold, the landed
 * ops and the generated app tree. That is exactly the part a CI runner can
 * assert byte-for-byte, and under `MOCK_AI=1` it is a pure function of the
 * description — which is the whole reason the description compiler has a
 * deterministic path at all.
 *
 * The seed + serve half is covered end-to-end by the cold-start harness
 * the cold-start measurement, which runs a real server.
 */

import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSpecDir } from '@maxstack/mcp'
import {
	BLUEPRINT_TYPE_ALIASES,
	blueprintFromDescription,
} from '@maxstack/spec-derive'
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'
import { TYPE_ALIASES_FOR_TEST } from '../lib/field-dsl.ts'
import { startCommand } from './start.ts'

const DESC = 'a bug tracker for small teams'

async function exists(path: string): Promise<boolean> {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

describe('maxstack start', () => {
	let root: string

	beforeAll(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {})
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		vi.stubEnv('MOCK_AI', '1')
	})

	afterAll(async () => {
		vi.unstubAllEnvs()
		vi.restoreAllMocks()
		await rm(root, { recursive: true, force: true })
	})

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'maxstack-start-'))
	})

	it('goes from a description to a generated, browsable app tree', async () => {
		const dir = join(root, 'app')
		await startCommand(DESC, dir, { dev: false })

		expect(await exists(join(dir, 'maxstack.json'))).toBe(true)
		expect(await exists(join(dir, '.mcp.json'))).toBe(true)
		expect(await exists(join(dir, 'CLAUDE.md'))).toBe(true)

		const spec = await readSpecDir(join(dir, 'spec'))
		// Every entity the blueprint named, and a page for each — an entity with
		// no page is data the user cannot click on.
		const expected = blueprintFromDescription(DESC)
		expect(spec.data.entities.map((e) => e.id)).toEqual(
			expected.entities.map((e) => `e-${e.slug}`),
		)
		for (const entity of expected.entities) {
			const page = spec.pages.pages.find(
				(p) => p.entityId === `e-${entity.slug}`,
			)
			expect(page, `page for ${entity.slug}`).toBeDefined()
			expect(page?.route).toBe(`/${entity.slug}`)
		}
		// The app tree exists, so the project validates and `dev` serves something.
		expect(await exists(join(dir, 'app'))).toBe(true)
	})

	it('lands the starting spec as reviewable ops with honest provenance', async () => {
		const dir = join(root, 'app')
		await startCommand(DESC, dir, { dev: false })
		const spec = await readSpecDir(join(dir, 'spec'))

		const authored = spec.opLog.filter((entry) =>
			entry.id.startsWith('op-cli-'),
		)
		expect(authored.length).toBeGreaterThan(0)
		// Nothing here is passed off as hand-authored: `start` writes the spec, so
		// the op log has to say so.
		for (const entry of authored) expect(entry.origin).toBe('ai')
		// And the rows themselves stay marked machine-authored in the review
		// surfaces, rather than looking like the user typed them.
		for (const entity of spec.data.entities) {
			expect(entity.provenance.isSuggested).toBe(true)
		}
	})

	it('is deterministic: the same description twice yields the same spec', async () => {
		const a = join(root, 'a')
		const b = join(root, 'b')
		await startCommand(DESC, a, { dev: false })
		await startCommand(DESC, b, { dev: false })

		const specA = await readSpecDir(join(a, 'spec'))
		const specB = await readSpecDir(join(b, 'spec'))
		expect(JSON.stringify(specA.data)).toBe(JSON.stringify(specB.data))
		expect(JSON.stringify(specA.pages)).toBe(JSON.stringify(specB.pages))
	})

	it('derives the directory from the description when none is given', async () => {
		const cwd = process.cwd()
		process.chdir(root)
		try {
			await startCommand('a recipe box for weeknight dinners', undefined, {
				dev: false,
			})
			// `projectSlug` of the derived title — the user typed no path at all.
			expect(await exists(join(root, 'recipe-box-weeknight-dinners'))).toBe(
				true,
			)
		} finally {
			process.chdir(cwd)
		}
	})

	it('refuses an empty description instead of scaffolding something arbitrary', async () => {
		await expect(
			startCommand('   ', join(root, 'x'), { dev: false }),
		).rejects.toThrow(/needs a description/)
		expect(await exists(join(root, 'x'))).toBe(false)
	})

	it('refuses to scaffold over an existing project, before writing anything', async () => {
		const dir = join(root, 'app')
		await startCommand(DESC, dir, { dev: false })
		const before = await readFile(join(dir, 'maxstack.json'), 'utf8')
		await expect(
			startCommand('a recipe box', dir, { dev: false }),
		).rejects.toThrow()
		// The refusal is not allowed to have half-rewritten the project it refused.
		expect(await readFile(join(dir, 'maxstack.json'), 'utf8')).toBe(before)
	})
})

describe('the blueprint grammar tracks the field DSL', () => {
	it('accepts exactly the type aliases the DSL does', () => {
		// The compiler validates a model's answer before `parseField` ever sees it
		//. If the two lists drift, a valid blueprint starts getting
		// rejected — or worse, an invalid one throws mid-scaffold.
		expect([...BLUEPRINT_TYPE_ALIASES].sort()).toEqual(
			Object.keys(TYPE_ALIASES_FOR_TEST).sort(),
		)
	})
})
