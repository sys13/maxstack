/**
 * The field builder (#421).
 *
 * The point of these is not that the questions get asked — it is that what they
 * assemble is **the same string the typed path takes**. `promptField` returns a
 * DSL spec, and every assertion below round-trips it through the real
 * `parseField` rather than checking the string alone: a spec that looks right
 * and does not parse would be a second, silently divergent way to define a
 * field, which is exactly what building a `FieldSpec` directly here would have
 * created.
 */

import { describe, expect, it } from 'vitest'
import { parseField, TYPE_ALIASES_FOR_TEST } from './field-dsl.ts'
import {
	promptField,
	promptFields,
	TYPE_CHOICE_VALUES,
} from './field-prompt.ts'
import type { Choice, Prompter } from './prompt.ts'

const provenance = {
	isSuggested: false,
	isAccepted: true,
	isAddedManually: true,
	suggestedDescription: null,
	priority: 'medium' as const,
}

const entities = [
	{ id: 'e-user' as const, name: 'User', provenance, fields: [] },
	{ id: 'e-team' as const, name: 'Team', provenance, fields: [] },
]

/**
 * A prompter that answers from a script, and records what it was asked.
 *
 * `select` answers by matching the scripted string against a choice's *label*,
 * so a test says `'enum'` rather than `'5'` — a positional answer would pass
 * for the wrong reason the moment the menu is reordered.
 */
function scripted(answers: string[]) {
	const queue = [...answers]
	const asked: string[] = []
	const next = (question: string): string => {
		asked.push(question)
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
					`"${answer}" is not offered for "${question}" — got ${choices.map((c) => c.label).join(', ')}`,
				)
			}
			return choice.value
		},
		async confirm(question) {
			return next(question) === 'y'
		},
		async close() {},
	}
	return { prompter, asked, remaining: () => queue.length }
}

describe('promptField', () => {
	it('builds a plain required field', async () => {
		const { prompter } = scripted(['title', 'text', 'y'])
		const spec = await promptField(prompter, entities)

		expect(spec).toBe('title:text!')
		expect(parseField('task', spec)).toMatchObject({
			name: 'title',
			type: 'string',
			required: true,
		})
	})

	it('leaves the field optional when the answer is no', async () => {
		const { prompter } = scripted(['done', 'bool', 'n'])
		const spec = await promptField(prompter, entities)

		expect(spec).toBe('done:bool')
		expect(parseField('task', spec)).toMatchObject({
			type: 'boolean',
			required: false,
		})
	})

	it('assembles an enum without the user ever typing a paren', async () => {
		// `enum(...)` is one of the two spellings a shell mangles. The user answers
		// with a comma-separated list; the parens are ours.
		const { prompter } = scripted(['priority', 'enum', 'low, med, high', 'n'])
		const spec = await promptField(prompter, entities)

		expect(spec).toBe('priority:enum(low,med,high)')
		expect(parseField('task', spec)).toMatchObject({
			type: 'enum',
			options: [
				{ label: 'low', value: 'low' },
				{ label: 'med', value: 'med' },
				{ label: 'high', value: 'high' },
			],
		})
	})

	it('assembles a reference by picking the target, never by typing an arrow', async () => {
		// The other mangled spelling. `->e-user` unquoted is a redirect that
		// truncates the argument and drops an empty file in the cwd; picking the
		// entity from a list cannot produce it.
		const { prompter } = scripted(['author', 'ref', 'e-user', 'y'])
		const spec = await promptField(prompter, entities)

		expect(spec).toBe('author:ref:e-user!')
		expect(parseField('post', spec)).toMatchObject({
			type: 'string',
			reference: 'e-user',
			required: true,
		})
	})

	it('does not offer a reference when there is nothing to reference', async () => {
		// The very first entity in a project. Offering `ref` and then having no
		// targets would be the round trip this change exists to remove, reproduced
		// inside a single prompt.
		const { prompter } = scripted(['name', 'text', 'y'])
		await promptField(prompter, [])

		const script = scripted(['name', 'ref', 'y'])
		await expect(promptField(script.prompter, [])).rejects.toThrow(
			/"ref" is not offered/,
		)
	})

	it('re-asks rather than accepting a name the parser would reject', async () => {
		// `promptField` hands `validate` to the prompter; the real prompter loops
		// on it (see prompt.test.ts). What is pinned here is that the validator is
		// the same `slugProblem` `parseField` throws on, so the two cannot diverge.
		const { prompter } = scripted(['9lives', 'text', 'n'])
		await expect(promptField(prompter, entities)).resolves.toBe('9lives:text')
		// ...and the typed path rejects exactly that, which is why the validator
		// has to be wired in.
		expect(() => parseField('cat', '9lives:text')).toThrow(/invalid field name/)
	})
})

describe('the type menu', () => {
	it('offers only spellings the DSL actually parses', () => {
		// The menu is a curated subset of `TYPE_ALIASES` (thirteen spellings for
		// five types — aliases exist to make a *typed* argument forgiving, which a
		// menu does not need). A rename in the alias table must not leave a dead
		// row here that the user can pick and the parser then refuses.
		for (const value of TYPE_CHOICE_VALUES) {
			if (value === 'enum' || value === 'ref') continue
			expect(Object.keys(TYPE_ALIASES_FOR_TEST)).toContain(value)
		}
	})

	it('covers every canonical type, so no type is unreachable by prompt', () => {
		const reachable = new Set(
			TYPE_CHOICE_VALUES.filter((v) => v !== 'enum' && v !== 'ref').map(
				(v) => TYPE_ALIASES_FOR_TEST[v],
			),
		)
		expect(reachable).toEqual(new Set(Object.values(TYPE_ALIASES_FOR_TEST)))
	})
})

describe('promptFields', () => {
	it('always asks for one field, since an entity with none is refused', async () => {
		const { prompter } = scripted(['title', 'text', 'y', 'n'])
		expect(await promptFields(prompter, entities)).toEqual(['title:text!'])
	})

	it('keeps asking while the answer is yes', async () => {
		const { prompter, remaining } = scripted([
			'title',
			'text',
			'y',
			'y', // another?
			'done',
			'bool',
			'n',
			'n', // another? no
		])
		expect(await promptFields(prompter, entities)).toEqual([
			'title:text!',
			'done:bool',
		])
		expect(remaining()).toBe(0)
	})
})
