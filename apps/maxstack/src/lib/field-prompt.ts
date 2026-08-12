/**
 * Asking for a field instead of making the user quote one (#421).
 *
 * `add-entity --field` and `add-field <spec>` take the DSL in `field-dsl.ts`:
 * `name:type[!]`, with `enum(a,b,c)` and `ref:e-user` / `->e-user`. Two of
 * those spellings are shell syntax, and the DSL's own doc comment documents the
 * consequence rather than avoiding it:
 *
 * > Quote anything carrying `(` or `->`: both are shell syntax, and unquoted
 * > `->e-user` is a redirect that **silently mangles the argument**.
 *
 * `parseField` even carries a dedicated branch for the wreckage — it recognises
 * a bare `-` as "the shell ate your reference, and left an empty file named
 * after the target in your cwd". That branch is a good error, and the best
 * thing to do with a good error is to make it unreachable: there is no shell
 * between a question and its answer.
 *
 * **This builds a spec string, not a `FieldSpec`.** Composing the answers into
 * `dueOn:date!` and handing that to `parseField` keeps one parser: the prompted
 * path and the typed path produce the identical op, and the line the command
 * echoes back is one the user can paste. A second construction path that
 * skipped the DSL would be a second thing to keep in agreement with it.
 */

import type { EntitySpec } from '@maxstack/spec'
import { slugProblem } from './field-dsl.ts'
import type { Choice, Prompter } from './prompt.ts'

/**
 * The types offered, in the order a person reaches for them.
 *
 * A curated subset of `TYPE_ALIASES`, which carries thirteen spellings for five
 * types (`str`/`string`/`text`, `int`/`integer`/`number`…) — aliases exist so a
 * typed argument is forgiving, which is the opposite of what a menu wants. Every
 * value here is still a key of that table, so `parseField` accepts all of them;
 * `field-prompt.test.ts` asserts that, so a rename there cannot leave a dead
 * entry here.
 */
const TYPE_CHOICES: Choice<string>[] = [
	{ value: 'text', label: 'text', hint: 'a string' },
	{ value: 'number', label: 'number', hint: 'an integer or decimal' },
	{ value: 'bool', label: 'bool', hint: 'true / false' },
	{ value: 'date', label: 'date', hint: 'a timestamp' },
	{ value: 'enum', label: 'enum', hint: 'one of a fixed set of options' },
	{ value: 'ref', label: 'ref', hint: 'a reference to another entity' },
	{ value: 'json', label: 'json', hint: 'an arbitrary object' },
]

/** The spelling of the types menu, exported so the test can check it parses. */
export const TYPE_CHOICE_VALUES: readonly string[] = TYPE_CHOICES.map(
	(c) => c.value,
)

/**
 * Ask for one field and return its DSL spec (`dueOn:date!`).
 *
 * `entities` is the reference-target list. It may legitimately be empty — the
 * very first entity in a project has nothing to point at — in which case `ref`
 * is dropped from the menu rather than offered and then refused.
 */
export async function promptField(
	prompter: Prompter,
	entities: readonly EntitySpec[],
): Promise<string> {
	const name = await prompter.text('Field name?', {
		validate: (answer) => slugProblem('field name', answer),
	})

	const offered = entities.length
		? TYPE_CHOICES
		: TYPE_CHOICES.filter((c) => c.value !== 'ref')
	const type = await prompter.select(`Type of "${name}"?`, offered)

	const expr = await typeExpression(prompter, type, name, entities)
	// Required is asked last because it is the only answer that reads as a
	// property of the finished field rather than a step in defining one.
	const required = await prompter.confirm(`Is "${name}" required?`, {
		default: false,
	})
	return `${name}:${expr}${required ? '!' : ''}`
}

/** The `type` half of the spec, which two of the seven types have to build. */
async function typeExpression(
	prompter: Prompter,
	type: string,
	name: string,
	entities: readonly EntitySpec[],
): Promise<string> {
	if (type === 'enum') {
		const options = await prompter.text(
			`Options for "${name}"? (comma-separated)`,
			{
				validate: (answer) => {
					const values = splitOptions(answer)
					if (values.length === 0) return 'give at least one option'
					// `parseField` splits on `,` and trims, so an option containing a
					// comma cannot survive the round trip in either direction. Better
					// refused at the question than silently split into two options.
					if (values.some((v) => v.includes(')')))
						return 'options cannot contain ")"'
					return undefined
				},
			},
		)
		return `enum(${splitOptions(options).join(',')})`
	}

	if (type === 'ref') {
		const target = await prompter.select(
			`"${name}" references which entity?`,
			entities.map((entity) => ({
				value: entity.id,
				label: entity.id,
				hint: entity.name,
			})),
		)
		// `ref:` rather than the `->` spelling: both parse identically, and this
		// one is the half that survives being pasted into a shell.
		return `ref:${target}`
	}

	return type
}

function splitOptions(answer: string): string[] {
	return answer
		.split(',')
		.map((v) => v.trim())
		.filter(Boolean)
}

/**
 * Ask for fields until the user is done, requiring at least one.
 *
 * `add-entity` refuses an entity with no fields (`add-entity needs at least one
 * --field`), so the first question is unconditional and only the ones after it
 * are opt-in. An entity with no fields is not a partial success to be cleaned
 * up later — it generates a table with nothing in it.
 */
export async function promptFields(
	prompter: Prompter,
	entities: readonly EntitySpec[],
): Promise<string[]> {
	const specs: string[] = [await promptField(prompter, entities)]
	while (await prompter.confirm('Add another field?', { default: false })) {
		specs.push(await promptField(prompter, entities))
	}
	return specs
}
