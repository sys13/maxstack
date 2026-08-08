/**
 * The disk-backed `e2e-tests` generator.
 *
 * The chain the platform wants an agent to take — declare `e2eTests`, scaffold
 * the specs, run them — is only cheaper than driving a browser by hand if every
 * link actually exists. The built-in generator returns the spec files as data,
 * which on stdio means an agent is told "scaffolded 3 files" while `e2e/` stays
 * empty. That is the link this closes.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpecSystem } from '@maxstack/spec'
import { afterEach, describe, expect, it } from 'vitest'
import type { Project } from '../lib/project.ts'
import { diskE2eGenerator, diskTypesGenerator } from './mcp.ts'

const dirs: string[] = []

async function tempProject(): Promise<Project> {
	const root = await mkdtemp(join(tmpdir(), 'maxstack-e2e-'))
	dirs.push(root)
	return { root, appPath: root } as Project
}

afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const spec = {
	data: { entities: [] },
	pages: {
		pages: [
			{
				id: 'pg-decks',
				name: 'Decks',
				route: '/decks',
				blocks: [],
				e2eTests: ['a signed-in user can archive a deck'],
			},
		],
	},
} as unknown as SpecSystem

describe('diskE2eGenerator', () => {
	it('lands the spec file on disk, not just in the reply', async () => {
		const project = await tempProject()
		const result = await diskE2eGenerator(project).run(spec, {})
		expect(result.notes).toContain('wrote: e2e/decks.spec.ts')
		const written = await readFile(
			join(project.root, 'e2e/decks.spec.ts'),
			'utf8',
		)
		expect(written).toContain('a signed-in user can archive a deck')
		expect(written).toContain('await page.goto("/decks")')
	})

	it('never clobbers a spec whose bodies somebody filled in', async () => {
		// The filled body is the one thing in this chain that is not derivable.
		const project = await tempProject()
		await mkdir(join(project.root, 'e2e'), { recursive: true })
		const mine = '// mine\ntest("x", async () => {})\n'
		await writeFile(join(project.root, 'e2e/decks.spec.ts'), mine)

		const result = await diskE2eGenerator(project).run(spec, {})
		expect(result.notes).toContain('skipped-user-owned: e2e/decks.spec.ts')
		expect(
			await readFile(join(project.root, 'e2e/decks.spec.ts'), 'utf8'),
		).toBe(mine)
	})

	it('says at write time that nothing here can run them (#377)', async () => {
		// A project entered through the global CLI has no `node_modules`, and
		// nothing in the quickstart path asks for one — so "scaffolded 1 e2e spec
		// file" is a report of coverage that does not exist. The remedy belongs
		// with the file, not in a gate the caller may never reach.
		const project = await tempProject()
		await writeFile(
			join(project.root, 'package.json'),
			JSON.stringify({ scripts: { e2e: 'playwright test' } }),
		)
		const notes = (await diskE2eGenerator(project).run(spec, {})).notes ?? []
		expect(notes.join('\n')).toMatch(
			/NOT RUNNABLE YET: .*dependencies are not installed/,
		)
		expect(notes.join('\n')).toMatch(/To run them: .*npm install/)
	})

	it('stays quiet when the suite it just wrote can actually run', async () => {
		const project = await tempProject()
		await writeFile(
			join(project.root, 'package.json'),
			JSON.stringify({ scripts: { e2e: 'playwright test' } }),
		)
		await mkdir(join(project.root, 'node_modules'), { recursive: true })
		process.env.PLAYWRIGHT_BROWSERS_PATH = '0'
		try {
			const notes = (await diskE2eGenerator(project).run(spec, {})).notes ?? []
			expect(notes.join('\n')).not.toMatch(/NOT RUNNABLE YET/)
		} finally {
			delete process.env.PLAYWRIGHT_BROWSERS_PATH
		}
	})

	it('does not warn about a suite it did not write', async () => {
		// Every file was already there. Nothing new is unrunnable, and repeating
		// the remedy on a no-op turns it into noise.
		const project = await tempProject()
		await mkdir(join(project.root, 'e2e'), { recursive: true })
		await writeFile(join(project.root, 'e2e/decks.spec.ts'), '// mine\n')
		const notes = (await diskE2eGenerator(project).run(spec, {})).notes ?? []
		expect(notes.join('\n')).not.toMatch(/NOT RUNNABLE YET/)
	})

	it('says so plainly when no page declares any test', async () => {
		const project = await tempProject()
		const empty = { pages: { pages: [] } } as unknown as SpecSystem
		const result = await diskE2eGenerator(project).run(empty, {})
		expect(result.notes.join(' ')).toMatch(/No pages declare e2eTests/)
	})
})

describe('diskTypesGenerator', () => {
	it('lands the generated types where the project typechecks them', async () => {
		// Types the project cannot compile are decoration — #260 and #261 are one
		// piece of work, and this is the seam between them.
		const project = await tempProject()
		const result = await diskTypesGenerator(project).run(spec, {})
		expect(result.notes).toContain('wrote: generated/types.ts')
		const written = await readFile(
			join(project.root, 'generated/types.ts'),
			'utf8',
		)
		expect(written).toMatch(/^\/\/ GENERATED/)
	})
})
