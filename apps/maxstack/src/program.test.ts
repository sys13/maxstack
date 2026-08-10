/**
 * The `upgrade` verb (#425).
 *
 * `gen --upgrade` and `upgrade` are deliberately **one action**: the merge
 * argument in `program.ts` is about mechanical identity and still holds, so the
 * alias must dispatch into the same `upgradeCommand` rather than growing a
 * second code path that can drift from it. These pin both halves — that the two
 * spellings land in the same function with the same argument, and that the verb
 * is actually listed in `--help`, which is the entire reason it exists.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const upgradeCommand = vi.fn(async () => {})
const genCommand = vi.fn(async () => {})

vi.mock('./commands/upgrade.ts', () => ({ upgradeCommand }))
vi.mock('./commands/gen.ts', () => ({ genCommand }))

const { buildProgram } = await import('./program.ts')

/** Parse an argv the way a user typed it, against a fresh command tree. */
async function run(...argv: string[]): Promise<void> {
	await buildProgram().parseAsync(argv, { from: 'user' })
}

describe('maxstack upgrade', () => {
	beforeEach(() => {
		upgradeCommand.mockClear()
		genCommand.mockClear()
	})

	it('dispatches to the same command `gen --upgrade` does', async () => {
		await run('upgrade', '/tmp/project')
		await run('gen', '--upgrade', '/tmp/project')

		expect(upgradeCommand.mock.calls).toEqual([
			['/tmp/project'],
			['/tmp/project'],
		])
		// The alias is an alias: it never falls through to a plain regeneration.
		expect(genCommand).not.toHaveBeenCalled()
	})

	it('defaults its directory to the cwd, like every other platform verb', async () => {
		await run('upgrade')
		expect(upgradeCommand).toHaveBeenCalledWith('.')
	})

	it('is listed in `--help` — the whole point of having the verb', async () => {
		// `gen --upgrade` was undiscoverable precisely because it was not a line in
		// this list. A hidden alias would reintroduce that.
		expect(buildProgram().helpInformation()).toMatch(/^\s+upgrade\s/m)
	})

	it('still regenerates without the flag', async () => {
		await run('gen', '/tmp/project')
		expect(genCommand).toHaveBeenCalledWith('/tmp/project')
		expect(upgradeCommand).not.toHaveBeenCalled()
	})
})
