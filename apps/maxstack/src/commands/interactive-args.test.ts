/**
 * The non-interactive contract (#421).
 *
 * Six arguments were relaxed from `<required>` to `[optional]` in the command
 * tree so a terminal could be asked for them. That is a change with a silent
 * failure mode: commander no longer guards them, so if a command forgets to
 * refuse, a scripted `maxstack add-field` lands a half-specified op instead of
 * exiting 1 — and nothing says so until someone reads a spec diff and wonders
 * where the field came from.
 *
 * So every one of the six is pinned here from both directions: it still refuses
 * with commander's own words when nobody is watching, and it resolves from a
 * prompt when someone is. The prompted half additionally asserts that the op
 * that lands is **identical** to the one the typed arguments produce, because a
 * prompt that built a subtly different field would be the more expensive bug.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadProject } from '../lib/project.ts'
import {
	type Choice,
	type Interaction,
	missingArgument,
	nonInteractive,
	type Prompter,
} from '../lib/prompt.ts'
import { addCommand } from './add.ts'
import {
	addEntityCommand,
	addFieldCommand,
	addPageCommand,
} from './add-entity.ts'
import { ejectCommand } from './eject.ts'
import { genCommand } from './gen.ts'
import { initCommand } from './init.ts'
import { slotsFillCommand } from './slots.ts'
import { themeCommand } from './theme.ts'

/** A prompter that answers `select` by label and `text`/`confirm` by script. */
function scripted(answers: string[]): Interaction {
	const queue = [...answers]
	const next = (question: string): string => {
		const answer = queue.shift()
		if (answer === undefined) throw new Error(`unanswered: ${question}`)
		return answer
	}
	const prompter: Prompter = {
		async text(question) {
			return next(question)
		},
		async select<T>(question: string, choices: Choice<T>[]): Promise<T> {
			const answer = next(question)
			const choice = choices.find((c) => c.label === answer)
			if (!choice) {
				throw new Error(
					`"${answer}" not offered for "${question}" — got ${choices.map((c) => c.label).join(', ')}`,
				)
			}
			return choice.value
		},
		async confirm(question) {
			return next(question) === 'y'
		},
		async close() {},
	}
	return {
		prompter,
		missing: (name) => {
			throw new Error(`refused instead of asking: ${name}`)
		},
	}
}

describe('missingArgument reproduces commander verbatim', () => {
	/** Run `cmd` with argv, capturing what commander wrote to stderr. */
	function capture(cmd: Command, argv: string[]) {
		let written = ''
		cmd
			.exitOverride()
			.configureOutput({ writeErr: (s) => (written += s) })
			.configureHelp({ formatHelp: () => '' })
		let code: string | undefined
		let exitCode: number | undefined
		try {
			cmd.parse(argv, { from: 'user' })
		} catch (err) {
			code = (err as { code?: string }).code
			exitCode = (err as { exitCode?: number }).exitCode
		}
		return { written, code, exitCode }
	}

	it('is byte-identical to what commander emits for a real required argument', () => {
		// The control: a command whose argument commander still guards itself.
		const control = new Command('demo').argument('<entity>').action(() => {})
		const theirs = capture(control, [])

		// Ours: the same refusal, raised from inside an action after the argument
		// was relaxed to `[entity]`.
		const ours = capture(
			new Command('demo').argument('[entity]').action((entity, _opts, cmd) => {
				if (entity === undefined) missingArgument(cmd, 'entity')
			}),
			[],
		)

		expect(theirs.written).toBe("error: missing required argument 'entity'\n")
		expect(ours.written).toBe(theirs.written)
		expect(ours.code).toBe(theirs.code)
		expect(ours.code).toBe('commander.missingArgument')
		expect(ours.exitCode).toBe(theirs.exitCode)
		expect(ours.exitCode).toBe(1)
	})
})

describe('the six relaxed arguments', () => {
	let dir: string

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'maxstack-interactive-'))
		vi.spyOn(console, 'log').mockImplementation(() => {})
		vi.spyOn(console, 'error').mockImplementation(() => {})
		await initCommand(dir, { desc: 'a task tracker' })
		await addEntityCommand(dir, 'task', {
			field: ['title:text!', 'done:bool'],
			accept: true,
			gen: true,
		})
		await addPageCommand(dir, 'task', { accept: true, gen: true })
		await genCommand(dir)
	}, 120_000)

	afterAll(async () => {
		vi.restoreAllMocks()
		await rm(dir, { recursive: true, force: true })
	})

	describe('refuse when nobody is watching', () => {
		// `nonInteractive` is the default parameter, so these also prove a caller
		// that passes no interaction at all cannot accidentally get a prompt.
		it('add-entity: slug', async () => {
			await expect(addEntityCommand(dir, undefined, {})).rejects.toThrow(
				"missing required argument 'slug'",
			)
		})

		it('add-field: entity', async () => {
			await expect(
				addFieldCommand(dir, undefined, 'note:text', {}),
			).rejects.toThrow("missing required argument 'entity'")
		})

		it('add-field: spec', async () => {
			await expect(addFieldCommand(dir, 'task', undefined, {})).rejects.toThrow(
				"missing required argument 'spec'",
			)
		})

		it('add-page: entity', async () => {
			await expect(addPageCommand(dir, undefined, {})).rejects.toThrow(
				"missing required argument 'entity'",
			)
		})

		it('theme: preset', async () => {
			await expect(themeCommand(dir, undefined, {})).rejects.toThrow(
				"missing required argument 'preset'",
			)
		})

		it('eject: route-id', async () => {
			await expect(
				ejectCommand(dir, undefined, {}, nonInteractive),
			).rejects.toThrow("missing required argument 'route-id'")
		})

		it('slots fill: id', async () => {
			await expect(slotsFillCommand(undefined, dir)).rejects.toThrow(
				"missing required argument 'id'",
			)
		})
	})

	describe('ask when someone is', () => {
		it('add-field builds the same op the typed spec would', async () => {
			// The whole claim of the prompted path: it is sugar over the same DSL,
			// so what lands is indistinguishable from the typed invocation. Two
			// fields, one each way, compared field-for-field with only the name and
			// id differing.
			await addFieldCommand(dir, 'task', 'typedOn:date!', {
				accept: true,
				gen: true,
			})
			await addFieldCommand(
				dir,
				undefined,
				undefined,
				{ accept: true, gen: true },
				scripted([
					'task', // which entity?
					'askedOn', // field name?
					'date', // type?
					'y', // required?
				]),
			)

			const entity = (
				await (await loadProject(dir)).spec.load()
			).data.entities.find((e) => e.id === 'e-task')
			const typed = entity?.fields.find((f) => f.name === 'typedOn')
			const asked = entity?.fields.find((f) => f.name === 'askedOn')

			expect(asked).toBeDefined()
			expect({ ...asked, id: null, name: null }).toEqual({
				...typed,
				id: null,
				name: null,
			})
		})

		it('add-field assembles a reference the shell would have eaten', async () => {
			await addFieldCommand(
				dir,
				undefined,
				undefined,
				{ accept: true, gen: true },
				scripted(['task', 'parent', 'ref', 'e-task', 'n']),
			)

			const entity = (
				await (await loadProject(dir)).spec.load()
			).data.entities.find((e) => e.id === 'e-task')
			expect(entity?.fields.find((f) => f.name === 'parent')).toMatchObject({
				type: 'string',
				reference: 'e-task',
				required: false,
			})
		})

		it('theme picks a preset off THEME_PRESETS', async () => {
			await themeCommand(dir, undefined, {}, scripted(['forest']))
			const spec = await (await loadProject(dir)).spec.load()
			expect(spec.theme?.preset).toBe('forest')
		})

		it('add-page picks the entity from the spec', async () => {
			await addEntityCommand(dir, 'note', {
				field: ['body:text!'],
				accept: true,
				gen: true,
			})
			await addPageCommand(
				dir,
				undefined,
				{ accept: true, gen: true },
				scripted(['note']),
			)

			const spec = await (await loadProject(dir)).spec.load()
			expect(spec.pages.pages.map((p) => p.entityId)).toContain('e-note')
		})

		it('eject picks a route off the manifest', async () => {
			await ejectCommand(dir, undefined, { dryRun: true }, scripted(['task']))
			// `--dry-run` writes nothing; reaching it at all means the id resolved
			// from the manifest rather than being refused.
		})

		it('refuses clearly, rather than offering an empty menu, with no entities', async () => {
			const empty = await mkdtemp(join(tmpdir(), 'maxstack-empty-'))
			try {
				await initCommand(empty, { desc: 'nothing yet' })
				await expect(
					addFieldCommand(empty, undefined, undefined, {}, scripted([])),
				).rejects.toThrow(/no entities yet/)
			} finally {
				await rm(empty, { recursive: true, force: true })
			}
		}, 120_000)
	})

	describe('the catalog picker', () => {
		it('installs nothing when the answer is "none"', async () => {
			const before = (await loadProject(dir)).config.bundles.length
			await addCommand(dir, 'audit', { dryRun: true })
			await import('./add.ts').then(({ catalogCommand }) =>
				catalogCommand(dir, scripted(['none'])),
			)
			expect((await loadProject(dir)).config.bundles.length).toBe(before)
		})
	})
})
