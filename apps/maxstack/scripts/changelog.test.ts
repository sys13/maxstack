/**
 * Changelog generation over a throwaway git repo: proves the `chore(release):`
 * pairwise sectioning, conventional-commit bucketing, and the staged-but-
 * uncommitted top section.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildChangelog, classify, webRepo } from './changelog.ts'

function git(args: string[], cwd: string, n: number): Promise<void> {
	return new Promise((res, reject) => {
		// Fixed dates keep section dates deterministic; each commit a day apart.
		const date = `2026-01-${String(10 + n).padStart(2, '0')}T12:00:00`
		const child = spawn('git', args, {
			cwd,
			env: {
				...process.env,
				GIT_AUTHOR_DATE: date,
				GIT_COMMITTER_DATE: date,
				GIT_AUTHOR_NAME: 'Test',
				GIT_AUTHOR_EMAIL: 't@e.st',
				GIT_COMMITTER_NAME: 'Test',
				GIT_COMMITTER_EMAIL: 't@e.st',
			},
		})
		child.on('error', reject)
		child.on('close', (code) =>
			code === 0 ? res() : reject(new Error(`git ${args[0]} exited ${code}`)),
		)
	})
}

describe('classify', () => {
	it('parses conventional commits with scope and breaking marker', () => {
		expect(classify('feat(cli): add flag', 'a')).toMatchObject({
			type: 'feat',
			scope: 'cli',
			breaking: false,
			desc: 'add flag',
		})
		expect(classify('fix!: drop legacy path', 'b')).toMatchObject({
			type: 'fix',
			scope: null,
			breaking: true,
		})
	})

	it('buckets non-conventional subjects by leading verb, else other', () => {
		expect(classify('Fix 9 findings', 'c').type).toBe('fix')
		expect(classify('Add a thing', 'd').type).toBe('feat')
		expect(classify('revamp spec format', 'e').type).toBe('other')
	})
})

describe('webRepo', () => {
	it('normalizes a git url to its https web form', () => {
		expect(webRepo({ url: 'git+https://github.com/x/y.git' })).toBe(
			'https://github.com/x/y',
		)
		expect(webRepo('git://github.com/x/y.git')).toBe('https://github.com/x/y')
		expect(webRepo(undefined)).toBe('')
	})
})

describe('buildChangelog', () => {
	let dir: string
	const repo = { url: 'git+https://github.com/x/y.git' }

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'maxstack-changelog-'))
		await git(['init', '-b', 'main'], dir, 0)
		let n = 0
		const commit = async (msg: string) => {
			await writeFile(join(dir, 'f.txt'), `${msg}\n`)
			await git(['add', '.'], dir, n)
			await git(['commit', '-m', msg], dir, n++)
		}
		await commit('feat: initial engine')
		await commit('chore(release): maxstack@0.1.0')
		await commit('feat(cli): add upgrade command')
		await commit('fix(web): correct date column')
		await commit('chore: bump deps') // hidden bucket
		await commit('docs: tweak readme') // hidden bucket
		await commit('chore(release): maxstack@0.2.0')
		await commit('feat(api): new endpoint') // unreleased, after 0.2.0
	})

	afterAll(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it('sections releases pairwise, newest first, with commit links', async () => {
		const out = await buildChangelog('0.2.0', repo, dir)

		// Newest release first, oldest is the initial-release marker.
		expect(out.indexOf('## 0.2.0')).toBeLessThan(out.indexOf('## 0.1.0'))
		expect(out).toContain('## 0.1.0 — 2026-01-11\n\n- Initial release.')

		// 0.2.0 lists the feat + fix under their headings, with scopes bolded.
		expect(out).toContain('### Features')
		expect(out).toContain('**cli:** add upgrade command')
		expect(out).toContain('### Fixes')
		expect(out).toContain('**web:** correct date column')

		// chore/docs are hidden, but counted.
		expect(out).not.toContain('bump deps')
		expect(out).not.toContain('tweak readme')
		expect(out).toContain('_2 internal changes._')

		// Release commits themselves never appear as entries.
		expect(out).not.toContain('- **release')
		expect(out).not.toMatch(/maxstack@0\.2\.0.*commit/)

		// Links point at the normalized web repo.
		expect(out).toMatch(
			/\(\[`[0-9a-f]+`\]\(https:\/\/github\.com\/x\/y\/commit\//,
		)
	})

	it('prepends a top section for a staged-but-uncommitted version', async () => {
		const out = await buildChangelog('0.3.0', repo, dir)
		// 0.3.0 has no release commit yet — it captures commits since 0.2.0.
		expect(out.indexOf('## 0.3.0')).toBeLessThan(out.indexOf('## 0.2.0'))
		expect(out).toContain('**api:** new endpoint')
	})
})
