/**
 * The sanctioned local-override path: a project can record a link
 * to a maxstack checkout, and every runtime consumer resolves through it. The
 * cases that matter are the ones the old folk procedure got wrong silently —
 * a link to something that isn't a checkout, and a link whose target moved.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
	isForgeRoot,
	linkedRuntimeBanner,
	readRuntimeLink,
	removeRuntimeLink,
	resolveRuntime,
	runtimeLinkPath,
	writeRuntimeLink,
} from './runtime.ts'

const dirs: string[] = []

async function tmp(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'maxstack-runtime-'))
	dirs.push(dir)
	return dir
}

/** A directory that passes `isForgeRoot`: a pnpm workspace whose `apps/web` is
 * the `@maxstack/web` package. */
async function fakeCheckout(): Promise<string> {
	const root = await tmp()
	await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n')
	await mkdir(join(root, 'apps/web'), { recursive: true })
	await writeFile(
		join(root, 'apps/web/package.json'),
		JSON.stringify({ name: '@maxstack/web' }),
	)
	return root
}

/** A project dir with a `maxstack.json` (so the link lands in its data dir). */
async function fakeProject(dataDir = '.maxstack'): Promise<string> {
	const root = await tmp()
	await writeFile(
		join(root, 'maxstack.json'),
		JSON.stringify({ name: 'demo', dataDir }),
	)
	return root
}

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('runtime link', () => {
	it('records the link inside the project data dir', async () => {
		const project = await fakeProject()
		const checkout = await fakeCheckout()
		const link = await writeRuntimeLink(project, checkout)

		expect(link.path).toBe(checkout)
		// The data dir is gitignored, so a link never travels in a commit.
		expect(await runtimeLinkPath(project)).toBe(
			join(project, '.maxstack', 'runtime-link.json'),
		)
		expect((await readRuntimeLink(project))?.path).toBe(checkout)
	})

	it('honors a non-default dataDir', async () => {
		const project = await fakeProject('state')
		const checkout = await fakeCheckout()
		await writeRuntimeLink(project, checkout)
		expect(await runtimeLinkPath(project)).toBe(
			join(project, 'state', 'runtime-link.json'),
		)
	})

	it('refuses a path that is not a maxstack checkout', async () => {
		const project = await fakeProject()
		const notACheckout = await tmp()
		await expect(writeRuntimeLink(project, notACheckout)).rejects.toThrow(
			/not a maxstack checkout/,
		)
		// Nothing recorded — a typo must not half-link the project.
		expect(await readRuntimeLink(project)).toBeNull()
	})

	it('resolves to the linked checkout, flagged as linked', async () => {
		const project = await fakeProject()
		const checkout = await fakeCheckout()
		await writeRuntimeLink(project, checkout)

		const runtime = await resolveRuntime(project)
		expect(runtime.mode).toBe('checkout')
		expect(runtime.root).toBe(checkout)
		// `linkedFrom` is what makes every consumer print the unpublished-code
		// banner; without it a linked runtime is indistinguishable from a release.
		expect(runtime.mode === 'checkout' && runtime.linkedFrom).toBe(checkout)
	})

	it('fails loudly when the linked checkout has gone away', async () => {
		const project = await fakeProject()
		const checkout = await fakeCheckout()
		await writeRuntimeLink(project, checkout)
		await rm(checkout, { recursive: true, force: true })

		await expect(resolveRuntime(project)).rejects.toThrow(
			/no longer a maxstack checkout/,
		)
	})

	it('unlink removes the record and reports whether there was one', async () => {
		const project = await fakeProject()
		const checkout = await fakeCheckout()
		await writeRuntimeLink(project, checkout)

		expect(await removeRuntimeLink(project)).toBe(true)
		expect(await readRuntimeLink(project)).toBeNull()
		expect(await removeRuntimeLink(project)).toBe(false)
	})

	it('names the linked path in the banner', () => {
		expect(linkedRuntimeBanner('/src/maxstack')).toContain('/src/maxstack')
		expect(linkedRuntimeBanner('/src/maxstack')).toMatch(/unpublished/i)
	})
})

describe('isForgeRoot', () => {
	it('rejects a bare pnpm workspace that is not maxstack', async () => {
		const dir = await tmp()
		await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n')
		await mkdir(join(dir, 'apps/web'), { recursive: true })
		await writeFile(
			join(dir, 'apps/web/package.json'),
			JSON.stringify({ name: '@someone-else/web' }),
		)
		expect(await isForgeRoot(dir)).toBe(false)
	})

	it('accepts a real checkout layout', async () => {
		expect(await isForgeRoot(await fakeCheckout())).toBe(true)
	})
})
