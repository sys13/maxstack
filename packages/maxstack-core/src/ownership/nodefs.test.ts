import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateResourcePage } from './generate.ts'
import { createNodeFs } from './nodefs.ts'

let dir: string
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'maxstack-nodefs-'))
})
afterEach(async () => {
	await rm(dir, { recursive: true, force: true })
})

const descriptor = {
	resource: 'story',
	title: 'Stories',
	routePath: '/stories',
	slots: ['actions'],
}

describe('createNodeFs', () => {
	it('drives the full page generator against real disk', async () => {
		const fs = createNodeFs(dir)
		await generateResourcePage(fs, descriptor)
		const route = await readFile(join(dir, 'routes/story.tsx'), 'utf8')
		expect(route).toContain('<h1>Stories</h1>')
		expect(route).toContain('AUTO-GENERATED')
		const routes = await readFile(join(dir, 'routes.ts'), 'utf8')
		expect(routes).toContain(`path: '/stories'`)
	})

	it('never-clobber holds on disk: a user-edited slot file survives regen', async () => {
		const fs = createNodeFs(dir)
		await generateResourcePage(fs, descriptor)
		const slotPath = join(dir, 'routes/story.slots.tsx')
		const edited = `export function actions() {\n\treturn 'MINE'\n}\n`
		await writeFile(slotPath, edited)
		await generateResourcePage(fs, { ...descriptor, title: 'All Stories' })
		expect(await readFile(slotPath, 'utf8')).toBe(edited)
		expect(await readFile(join(dir, 'routes/story.tsx'), 'utf8')).toContain(
			'<h1>All Stories</h1>',
		)
	})

	it('jails every path under the project root', async () => {
		const fs = createNodeFs(dir)
		await expect(fs.write('../escape.txt', 'x')).rejects.toThrow(
			/escapes project root/,
		)
		await expect(fs.read('/etc/passwd')).rejects.toThrow(/escapes project root/)
	})
})
