/**
 * The PATH-resolution warning. The scaffolded `.mcp.json` and
 * `.claude/settings.json` invoke a bare `maxstack`; if that resolves to an older
 * global, the MCP server and the edit guard both fail *silently*. These pin the
 * conditions under which we shout about it.
 */

import { describe, expect, it } from 'vitest'
import { buildProgram } from '../program.ts'
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

describe('the verb probe', () => {
	// The probe reads `maxstack <verb> --help` and matches the *usage line*.
	// Two earlier probes were wrong in opposite directions and neither was
	// caught, because the only real-binary test asserted `typeof usable`:
	//
	//   - exit status: commander answers an unknown verb with the top-level help
	//     and exits 0, so a stale global looked fine and nothing ever warned.
	//   - the `--help` command list: `mcp` and `guard-edit` are registered
	//     `{ hidden: true }` and so never appear in it, which made the probe
	//     always-false — every install was told it "predates the `mcp` verb",
	//     and the fix line told you to install the version you already had.
	//
	// These pin the commander behaviour the current probe rests on, against
	// this workspace's own program rather than whatever is on PATH.
	/** What `maxstack <verb> --help` prints, or the top-level help commander
	 * falls back to when it has no such verb. */
	const helpFor = (verb?: string): string => {
		const program = buildProgram()
		if (verb === undefined) return program.helpInformation()
		const sub = program.commands.find((c) => c.name() === verb)
		return (sub ?? program).helpInformation()
	}

	it.each(['mcp', 'guard-edit'])(
		'names `%s` in its usage line even though the verb is hidden',
		(verb) => {
			expect(helpFor()).not.toMatch(new RegExp(`^\\s+${verb}(\\s|$)`, 'm'))
			expect(helpFor(verb)).toMatch(
				new RegExp(`^Usage: \\S+ ${verb}(\\s|$)`, 'm'),
			)
		},
	)

	it('does not name an absent verb in the usage line it falls back to', () => {
		expect(helpFor('definitely-not-a-verb')).not.toMatch(
			/^Usage: \S+ definitely-not-a-verb(\s|$)/m,
		)
	})
})

describe('probePathCli (against whatever maxstack is really on PATH)', () => {
	it('reports usability from the real binary without side effects', async () => {
		const status = await probePathCli()
		if (status.found === null) return // no global install here; nothing to assert
		expect(typeof status.usable).toBe('boolean')
	}, 30_000)
})
