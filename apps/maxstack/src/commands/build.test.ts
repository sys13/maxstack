import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	imageTag,
	RUNTIME_STAMP_FILENAME,
	readRuntimeStamp,
	renderFlyToml,
	stampVersion,
} from './build.ts'

// `renderOwnedManifest` moved to `@maxstack/core` (so `maxstack dev`'s
// vite plugin can reuse it) — its tests moved with it, see
// `maxstack/packages/maxstack-core/src/ownership/owned-codegen.test.ts`.

describe('imageTag', () => {
	it('slugifies the project name into a docker-safe tag', () => {
		expect(imageTag('tech news')).toBe('maxstack-tech-news')
		expect(imageTag('My App!')).toBe('maxstack-my-app')
		expect(imageTag('  --Weird--  ')).toBe('maxstack-weird')
		expect(imageTag('')).toBe('maxstack-app')
	})
})

describe('stampVersion', () => {
	it('uses the installed runtime version in package mode', () => {
		expect(
			stampVersion({
				mode: 'package',
				pkgDir: '/x',
				root: '/x/workspace',
				serverIndex: '/x/build/server/index.js',
				seedScript: '/x/seed-demo.mjs',
				version: '0.10.1',
			}),
		).toBe('0.10.1')
	})

	it('marks checkout-vendored trees as "checkout" (no release version)', () => {
		expect(stampVersion({ mode: 'checkout', root: '/repo' })).toBe('checkout')
	})
})

describe('readRuntimeStamp', () => {
	let dir: string
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'maxstack-stamp-'))
	})
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it('returns null when the tree has never been stamped', async () => {
		expect(await readRuntimeStamp(dir)).toBeNull()
	})

	it('reads back the stamped version, trimming the trailing newline', async () => {
		// Matches what `vendorRuntime` writes (`${version}\n`).
		await writeFile(join(dir, RUNTIME_STAMP_FILENAME), '0.10.1\n')
		expect(await readRuntimeStamp(dir)).toBe('0.10.1')
	})
})

describe('renderFlyToml', () => {
	it('emits a config whose context is the vendored tree (spec/ dir baked)', () => {
		const toml = renderFlyToml('tech news')
		expect(toml).toContain('app = "maxstack-tech-news"')
		// Context is the runtime dir itself: relative Dockerfile + spec.
		expect(toml).toContain('dockerfile = "Dockerfile"')
		expect(toml).toContain('SPEC_DIR = "spec"')
		expect(toml).toContain('internal_port = 3000')
	})
})
