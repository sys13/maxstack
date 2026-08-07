/**
 * The release gate's shape, pinned (#348).
 *
 * `release.yml`'s `smoke` job is the only thing between a staged tarball and the
 * registry that runs the CLI as a *user* gets it. It went green on 0.11.11 and
 * 0.11.11 was broken for every user: `@better-auth/drizzle-adapter` peers on a
 * `drizzle-orm` the tree could not satisfy, npm placed a copy no dependency edge
 * pointed at, and the CLI imported it happily — once. The next `npm install`
 * pruned the orphan (pruning walks edges) and `maxstack init` died at import.
 *
 * A single install structurally cannot observe that class. Only a second pass
 * over a re-resolved tree can, so the job reinstalls and runs the CLI again.
 * Confirmed against the real tarballs before this landed: with `maxstack@0.11.11`
 * the first `init` succeeds and the post-reinstall one throws
 * `ERR_MODULE_NOT_FOUND`; with `0.11.12` both pass.
 *
 * This test cannot rerun that experiment — it needs the registry, a pack and two
 * npm installs. What it can do is stop the reinstall pass from quietly
 * disappearing from the workflow, which is the only way this gate regresses.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(
	fileURLToPath(
		new URL('../../../.github/workflows/release.yml', import.meta.url),
	),
	'utf8',
)

/** The `smoke:` job's block, up to the next top-level job key. */
function smokeJob(): string {
	const start = workflow.indexOf('\n  smoke:\n')
	expect(start, 'release.yml has no `smoke` job').toBeGreaterThan(-1)
	const rest = workflow.slice(start + 1)
	const next = rest.search(/\n {2}[a-z][a-z-]*:\n/)
	return next === -1 ? rest : rest.slice(0, next)
}

describe('release.yml smoke job', () => {
	it('installs the staged tarballs and runs the CLI', () => {
		const job = smokeJob()
		expect(job).toContain('npm install "$GITHUB_WORKSPACE/tarballs')
		expect(job).toMatch(/maxstack --version/)
		expect(job).toMatch(/maxstack init demo\b/)
		expect(job).toContain('build --vendor-only')
	})

	it('runs the CLI again after re-resolving the tree (#348)', () => {
		const job = smokeJob()
		// A bare `npm install` after the tarball install: this is the prune, and
		// without it an orphaned unsatisfiable peer ships green. See the header.
		expect(job).toMatch(/^\s*npm install >\/dev\/null$/m)
		expect(job).toContain('maxstack init demo-after-reinstall')
		// …and the reinstall must come before the second run, or it proves nothing.
		expect(job.indexOf('npm install >/dev/null')).toBeLessThan(
			job.indexOf('init demo-after-reinstall'),
		)
	})
})
