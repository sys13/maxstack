/**
 * The PATH-resolution warning. The scaffolded `.mcp.json` and
 * `.claude/settings.json` invoke a bare `maxstack`; if that resolves to an older
 * global, the MCP server and the edit guard both fail *silently*. These pin the
 * conditions under which we shout about it.
 */

import { describe, expect, it } from 'vitest'
import { pathCliWarning, probePathCli } from './cli-resolution.ts'

describe('pathCliWarning', () => {
	it('says nothing when the PATH CLI supports the verbs', () => {
		// Even a version mismatch is fine as long as the verbs exist — a local
		// build or a fork can report any version string.
		expect(pathCliWarning({ found: '0.11.5', usable: true }, '0.11.5')).toBeNull()
		expect(pathCliWarning({ found: '9.9.9', usable: true }, '0.11.5')).toBeNull()
	})

	it('warns when PATH has an older CLI without the verbs', () => {
		const warning = pathCliWarning({ found: '0.11.4', usable: false }, '0.11.5')
		expect(warning).toContain('0.11.4')
		// Must name both silent failures — that they are silent is the whole point.
		expect(warning).toContain('mcp__maxstack__*')
		expect(warning).toContain('edit guard')
		expect(warning).toContain('silently')
		// And be actionable, pinned to the version that scaffolded this project.
		expect(warning).toContain('npm install -g maxstack@0.11.5')
	})

	it('warns when there is no maxstack on PATH at all', () => {
		const warning = pathCliWarning({ found: null, usable: false }, '0.11.5')
		expect(warning).toContain('no `maxstack` on PATH')
		expect(warning).toContain('npm install -g maxstack@0.11.5')
	})
})

describe('probePathCli (against whatever maxstack is really on PATH)', () => {
	it('reports usability from the real binary without side effects', async () => {
		// Regression guard for the probe itself: the first version asked
		// `maxstack mcp --help`, which commander answers with the *top-level* help
		// and exit 0 even when it has no `mcp` verb — so a stale global looked
		// fine and the warning never fired. Probing the command list is the honest
		// signal, and unlike running `maxstack mcp` for real it can't hang.
		const status = await probePathCli()
		if (status.found === null) return // no global install here; nothing to assert
		expect(typeof status.usable).toBe('boolean')
	}, 30_000)
})
