/**
 * **Refuse rather than default** — declared-required argument
 * enforcement at the dispatch boundary.
 *
 * `record_decision` used to fill in what a caller left out: `String(args.question
 * ?? '')`, `(args.options ?? [])`. A no-arg call therefore produced a permanent,
 * id-less entry in an append-only ledger — a valid-looking record of nothing,
 * which is strictly worse than an error, because an error is recoverable and a
 * ledger entry is not.
 *
 * The rule this module enforces: **never manufacture a valid-looking value from
 * a missing required input.** Every place the framework quietly fills a gap is a
 * place the agent learns nothing and the damage is silent.
 *
 * It runs generically, off the tool's own published `inputSchema`, rather than
 * per-tool. The schemas already state what is required — enforcing them at one
 * boundary means a tool cannot forget to check, and a new tool is covered the
 * day its schema is written rather than the day someone remembers.
 *
 * ## The messages are the documentation
 *
 * An agent that reads "Invalid input" runs a probe matrix and still guesses. An
 * agent that reads what was expected, what arrived, and what to send instead
 * writes correct code on the next call. So every refusal here names the
 * argument, its declared type, its description from the schema, the full
 * required set, and what was actually received — and says plainly that nothing
 * was written.
 */

import type { JsonSchema } from '@maxstack/core'

/** JSON-shaped type names, as the schemas declare them. */
function jsonTypeOf(value: unknown): string {
	if (value === null) return 'null'
	if (Array.isArray(value)) return 'array'
	return typeof value
}

/** A short, safe rendering of what actually arrived. */
function describe(value: unknown): string {
	if (value === undefined) return 'nothing (the key was absent)'
	const json = JSON.stringify(value) ?? String(value)
	return json.length > 120 ? `${json.slice(0, 117)}…` : json
}

/**
 * Every way `args` fails the tool's declared schema, as repair instructions.
 *
 * Deliberately shallow: only the top-level `required` list and the top-level
 * declared types. Deep validation of an op's payload is `validateOpDryRun`'s
 * job and it does it better, with the spec in hand. This is the boundary check
 * that stops a *structurally* absent argument from being defaulted into
 * existence before anything with real judgement ever sees it.
 */
export function argErrors(
	schema: JsonSchema,
	args: Record<string, unknown>,
): string[] {
	const errors: string[] = []
	const required = schema.required ?? []

	for (const name of required) {
		const declared = schema.properties[name] ?? {}
		const type = typeof declared.type === 'string' ? declared.type : 'value'
		const hint =
			typeof declared.description === 'string'
				? ` — ${declared.description}`
				: ''
		if (!(name in args) || args[name] === undefined) {
			errors.push(
				`missing required argument "${name}" (${type})${hint}. Send it; it will NOT be defaulted.`,
			)
			continue
		}
		if (args[name] === null) {
			errors.push(
				`required argument "${name}" (${type}) was null${hint}. null is not a value here — send a real ${type}, or omit the whole call.`,
			)
		}
	}

	for (const [name, value] of Object.entries(args)) {
		if (value === undefined || value === null) continue
		const declared = schema.properties[name]
		const expected = typeof declared?.type === 'string' ? declared.type : null
		if (!expected) continue
		const actual = jsonTypeOf(value)
		// `number` covers integers too, and an array IS an object in JS — the
		// schema's `array` and `object` are distinct, so compare against the
		// JSON-shaped name rather than `typeof`.
		const matches =
			expected === actual ||
			(expected === 'number' && actual === 'number') ||
			(expected === 'object' && actual === 'object')
		if (!matches)
			errors.push(
				`argument "${name}" must be ${expected}; received ${actual} — ${describe(value)}.`,
			)
	}

	if (errors.length > 0 && required.length > 0)
		errors.push(
			`Required arguments for this tool: ${required.join(', ')}. Received keys: ${
				Object.keys(args).length > 0 ? Object.keys(args).join(', ') : '(none)'
			}. Nothing was written.`,
		)
	return errors
}
