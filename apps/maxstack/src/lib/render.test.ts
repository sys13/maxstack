import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureDir } from '../fsx.ts'
import { renderTemplate, substitute } from './render.ts'

const tmps: string[] = []
async function tmp(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'maxstack-render-'))
	tmps.push(dir)
	return dir
}

afterEach(async () => {
	// pglite-free cleanup; best-effort so a failed test never hides its cause.
	const { rm } = await import('node:fs/promises')
	await Promise.all(tmps.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('substitute', () => {
	it('replaces known {{TOKEN}} placeholders', () => {
		expect(substitute('hi {{NAME}}!', { NAME: 'max' })).toBe('hi max!')
	})

	it('leaves unknown tokens intact', () => {
		expect(substitute('{{A}} {{B}}', { A: 'x' })).toBe('x {{B}}')
	})

	it('replaces every occurrence', () => {
		expect(substitute('{{X}}-{{X}}', { X: '1' })).toBe('1-1')
	})
})

describe('renderTemplate', () => {
	it('substitutes tokens, drops .template, renames gitignore, recurses', async () => {
		const src = await tmp()
		const dest = await tmp()
		await writeFile(join(src, 'prd.ts.template'), 'const name = "{{PROJECT_NAME}}"')
		await writeFile(join(src, 'gitignore'), 'node_modules\n')
		await ensureDir(join(src, 'nested'))
		await writeFile(join(src, 'nested', 'readme.md'), '# {{PROJECT_NAME}}')

		await renderTemplate(src, dest, { PROJECT_NAME: 'demo' })

		const top = (await readdir(dest)).sort()
		expect(top).toEqual(['.gitignore', 'nested', 'prd.ts'])
		expect(await readFile(join(dest, 'prd.ts'), 'utf8')).toBe(
			'const name = "demo"',
		)
		expect(await readFile(join(dest, 'nested', 'readme.md'), 'utf8')).toBe(
			'# demo',
		)
	})

	it('throws when the template directory is missing', async () => {
		await expect(
			renderTemplate(join(await tmp(), 'nope'), await tmp(), {}),
		).rejects.toThrow(/Template directory not found/)
	})
})
