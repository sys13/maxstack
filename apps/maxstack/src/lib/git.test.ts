/**
 * The scaffold's own precondition.
 *
 * Never-clobber is the safety story for owned code, and it assumed version
 * control that the scaffold never created — `init` wrote a `.gitignore` for a
 * repository that did not exist. These pin the three outcomes and, as much as
 * anything, that none of them is silent.
 */

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapRepo, gitBootstrapNotice } from './git.ts'

const dirs: string[] = []

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'maxstack-git-'))
	dirs.push(dir)
	return dir
}

afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const git = (dir: string, ...args: string[]) =>
	execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()

describe('bootstrapRepo', () => {
	it('creates a repo AND a first commit to diff against', async () => {
		// The commit is the load-bearing half: a repo with no commits gives you
		// nothing to revert to, which is most of what the repo was for.
		const dir = await tempDir()
		await writeFile(join(dir, 'maxstack.json'), '{}')

		expect(await bootstrapRepo(dir)).toEqual({ status: 'initialized' })
		expect(git(dir, 'rev-parse', '--is-inside-work-tree')).toBe('true')
		expect(git(dir, 'log', '--oneline')).toContain('Initial scaffold')
		// Nothing left uncommitted — the scaffold is the baseline.
		expect(git(dir, 'status', '--porcelain')).toBe('')
	})

	it('refuses to nest inside an existing work tree', async () => {
		// A nested repo is a trap, not a service: the outer repo stops seeing
		// these files and nobody finds out until a push.
		const outer = await tempDir()
		await writeFile(join(outer, 'README.md'), '#')
		execFileSync('git', ['init', '-q'], { cwd: outer })
		const inner = join(outer, 'app')
		await mkdir(inner, { recursive: true })

		const result = await bootstrapRepo(inner)
		expect(result.status).toBe('already')
		expect(result.reason).toMatch(/already inside a git work tree/)
	})

	it('says nothing when the precondition already holds', () => {
		expect(gitBootstrapNotice({ status: 'initialized' })).toBeNull()
		expect(gitBootstrapNotice({ status: 'already', reason: 'x' })).toBeNull()
	})

	it('names the missing undo when there is no version control', () => {
		const notice = gitBootstrapNotice({
			status: 'unavailable',
			reason: 'git is not on PATH',
		})
		expect(notice).toMatch(/git is not on PATH/)
		expect(notice).toMatch(/never overwrites code you own/)
		expect(notice).toMatch(/the first mistake has no undo/)
		// Actionable: the exact commands, not just alarm.
		expect(notice).toMatch(/git init && git add -A && git commit/)
	})
})
