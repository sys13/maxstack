/**
 * `maxstack init` writes an env scaffold so nobody ships a blank/default signing
 * key: a committed `.env.example` (secret slots blank) plus a gitignored `.env`
 * with cryptographically-random values generated in.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderEnvExample, renderEnvLocal } from '../lib/env-scaffold.ts'
import { initCommand } from './init.ts'

describe('env scaffold render', () => {
	it('example leaves secret slots blank but keeps defaults', () => {
		const text = renderEnvExample()
		expect(text).toMatch(/^BETTER_AUTH_SECRET=$/m)
		expect(text).toMatch(/^BETTER_AUTH_URL=http:\/\/localhost:3000$/m)
	})

	it('local fills secrets with 64 hex chars', () => {
		const text = renderEnvLocal()
		const match = text.match(/^BETTER_AUTH_SECRET=([a-f0-9]+)$/m)
		expect(match).not.toBeNull()
		expect(match?.[1]).toHaveLength(64)
	})

	// #284: the AI prefill box is the first thing on every create form and
	// nothing in the product named the variable that turns it on.
	it('names ANTHROPIC_API_KEY, blank and documented, in both files', () => {
		for (const text of [renderEnvExample(), renderEnvLocal()]) {
			expect(text).toMatch(/^ANTHROPIC_API_KEY=$/m)
			expect(text).toContain('console.anthropic.com')
		}
	})

	it('each render generates a fresh, unique secret', () => {
		const a = renderEnvLocal().match(/BETTER_AUTH_SECRET=([a-f0-9]+)/)?.[1]
		const b = renderEnvLocal().match(/BETTER_AUTH_SECRET=([a-f0-9]+)/)?.[1]
		expect(a).not.toBe(b)
	})
})

describe('maxstack init env files', () => {
	let dir: string

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'maxstack-env-'))
		vi.spyOn(console, 'log').mockImplementation(() => {})
		vi.spyOn(console, 'error').mockImplementation(() => {})
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		await initCommand(dir, { desc: 'an env test app' })
	})

	afterAll(async () => {
		vi.restoreAllMocks()
		await rm(dir, { recursive: true, force: true })
	})

	it('writes a .env with a real generated secret', async () => {
		const env = await readFile(join(dir, '.env'), 'utf8')
		const secret = env.match(/^BETTER_AUTH_SECRET=([a-f0-9]{64})$/m)?.[1]
		expect(secret).toBeDefined()
		// Never the runtime's hardcoded dev fallback.
		expect(env).not.toContain('maxstack-dev-secret')
	})

	it('writes a committed .env.example with the secret slot blank', async () => {
		const example = await readFile(join(dir, '.env.example'), 'utf8')
		expect(example).toMatch(/^BETTER_AUTH_SECRET=$/m)
	})

	it('gitignores .env but keeps .env.example tracked', async () => {
		const gitignore = await readFile(join(dir, '.gitignore'), 'utf8')
		expect(gitignore).toContain('.env')
		expect(gitignore).toContain('!.env.example')
	})
})
