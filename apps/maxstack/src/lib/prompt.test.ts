/**
 * The prompt layer (#421).
 *
 * Two halves, and the second matters more than the first:
 *
 *   1. that the asking works — the re-ask loops especially, since those are the
 *      paths a hand-run demo never reaches;
 *   2. that **not** asking works. Six arguments were relaxed from `<required>`
 *      to `[optional]` in the command tree so they could be prompted for, and
 *      the failure mode of that change is silent: an argument stops being
 *      required in CI and nothing complains until a scripted invocation lands a
 *      half-specified op. `resolveArg` and `isInteractive` are the whole of the
 *      guard, so they are pinned here from every direction.
 *
 * The prompter is driven over a pair of pipes rather than mocked, which is what
 * the numbered-list design bought: no pty, no keypress encoding, and the real
 * readline round trip under test.
 */

import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
	type Interaction,
	isInteractive,
	nonInteractive,
	openPrompter,
	type Prompter,
	resolveArg,
	shellQuote,
} from './prompt.ts'

/**
 * Drive a real prompter through a scripted set of answers.
 *
 * Answers are written one per turn, driven by the output stream: writing them
 * all up front would work for the happy path but would let a test "pass" while
 * the prompter asked entirely different questions than expected. Feeding the
 * next line only once the previous question has been printed means the
 * transcript below is the transcript that actually happened.
 */
async function withAnswers<T>(
	answers: string[],
	use: (prompter: Prompter) => Promise<T>,
): Promise<{ result: T; transcript: string }> {
	const input = new PassThrough()
	const output = new PassThrough()
	let transcript = ''
	const queue = [...answers]
	output.on('data', (chunk: Buffer) => {
		transcript += chunk.toString()
		// A prompt has been written; answer it. `setImmediate` so readline has
		// finished installing its line listener before the data arrives.
		if (queue.length > 0) setImmediate(() => input.write(`${queue.shift()}\n`))
	})
	const prompter = openPrompter({ input, output })
	try {
		return { result: await use(prompter), transcript }
	} finally {
		await prompter.close()
	}
}

describe('isInteractive', () => {
	const tty = (stdin: boolean, stdout: boolean) => ({
		stdin: { isTTY: stdin },
		stdout: { isTTY: stdout },
	})

	it('is false whenever stdin is not a terminal — the agent and CI case', () => {
		expect(isInteractive({}, tty(false, true))).toBe(false)
	})

	it('is false when stdout is redirected, even from a terminal', () => {
		// `maxstack drift --json > out.json` typed by hand: stdin is a TTY, but the
		// question would be written into the file the caller is parsing.
		expect(isInteractive({}, tty(true, false))).toBe(false)
	})

	it('is true only when both streams are a terminal', () => {
		expect(isInteractive({}, tty(true, true))).toBe(true)
	})

	it('honours MAXSTACK_NO_PROMPT even at a full terminal', () => {
		// The case the stream test cannot see: a real terminal driven by a script.
		expect(isInteractive({ MAXSTACK_NO_PROMPT: '1' }, tty(true, true))).toBe(
			false,
		)
	})
})

describe('resolveArg', () => {
	const asking: Interaction = {
		prompter: { text: vi.fn(), select: vi.fn(), confirm: vi.fn() } as never,
		missing: () => {
			throw new Error('should not have refused')
		},
	}

	it('returns what was typed without asking anything', async () => {
		const ask = vi.fn()
		expect(await resolveArg('e-task', 'entity', asking, ask)).toBe('e-task')
		expect(ask).not.toHaveBeenCalled()
	})

	it('refuses rather than asking when nobody is watching', async () => {
		// The invariant. If this ever resolves instead of throwing, a required
		// argument has quietly become optional for every script in existence.
		await expect(
			resolveArg(undefined, 'entity', nonInteractive, async () => 'asked'),
		).rejects.toThrow("missing required argument 'entity'")
	})

	it('does not treat an empty string as absent', async () => {
		// `--field ''` is a wrong value, not a missing one, and must reach the
		// command's own validation rather than silently opening a prompt.
		const ask = vi.fn()
		expect(await resolveArg('', 'spec', asking, ask)).toBe('')
		expect(ask).not.toHaveBeenCalled()
	})

	it('asks when there is someone to ask', async () => {
		expect(
			await resolveArg(undefined, 'entity', asking, async () => 'e-order'),
		).toBe('e-order')
	})
})

describe('the prompter', () => {
	it('takes a typed answer', async () => {
		const { result } = await withAnswers(['orders'], (p) =>
			p.text('Entity name?'),
		)
		expect(result).toBe('orders')
	})

	it('falls back to the default on an empty line', async () => {
		const { result, transcript } = await withAnswers([''], (p) =>
			p.text('Name?', { default: 'my-app' }),
		)
		expect(result).toBe('my-app')
		expect(transcript).toContain('[my-app]')
	})

	it('re-asks until the answer validates, and says why', async () => {
		const { result, transcript } = await withAnswers(['9lives', 'nineLives'], (p) =>
			p.text('Field name?', {
				validate: (a) => (/^[a-z]/.test(a) ? undefined : 'must start lowercase'),
			}),
		)
		expect(result).toBe('nineLives')
		expect(transcript).toContain('must start lowercase')
	})

	it('selects by number, and lists the choices with their hints', async () => {
		const { result, transcript } = await withAnswers(['2'], (p) =>
			p.select('Which entity?', [
				{ value: 'e-task', label: 'task', hint: 'Task · 3 fields' },
				{ value: 'e-order', label: 'order', hint: 'Order · 5 fields' },
			]),
		)
		expect(result).toBe('e-order')
		expect(transcript).toContain('1) task')
		expect(transcript).toContain('Order · 5 fields')
	})

	it('also accepts the label itself, so a pasted value works', async () => {
		// The labels are the arguments the command would otherwise have taken.
		// Someone who already knows the value should not have to find its number.
		const { result } = await withAnswers(['order'], (p) =>
			p.select('Which entity?', [
				{ value: 'e-task', label: 'task' },
				{ value: 'e-order', label: 'order' },
			]),
		)
		expect(result).toBe('e-order')
	})

	it('re-asks on a number outside the list rather than picking something', async () => {
		const { result, transcript } = await withAnswers(['7', '1'], (p) =>
			p.select('Pick', [
				{ value: 'a', label: 'a' },
				{ value: 'b', label: 'b' },
			]),
		)
		expect(result).toBe('a')
		expect(transcript).toContain('enter 1-2')
	})

	it('reads yes/no, and defaults on an empty line', async () => {
		expect((await withAnswers(['y'], (p) => p.confirm('Sure?'))).result).toBe(
			true,
		)
		expect((await withAnswers(['n'], (p) => p.confirm('Sure?'))).result).toBe(
			false,
		)
		expect(
			(await withAnswers([''], (p) => p.confirm('Sure?', { default: false })))
				.result,
		).toBe(false)
	})
})

describe('shellQuote', () => {
	it('leaves an ordinary spec alone', () => {
		expect(shellQuote('title:text!')).toBe('title:text!')
		expect(shellQuote('dueOn:date')).toBe('dueOn:date')
	})

	it('quotes the two spellings a shell would eat', () => {
		// The echoed line is meant to be pasted, and `field-dsl.ts` documents what
		// an unquoted `->` does: the shell reads it as a redirect and silently
		// truncates the argument (leaving an empty file named after the target).
		expect(shellQuote('priority:enum(low,high)')).toBe(
			"'priority:enum(low,high)'",
		)
		expect(shellQuote('author:->e-user')).toBe("'author:->e-user'")
	})

	it('survives an embedded quote', () => {
		expect(shellQuote("it's")).toBe("'it'\\''s'")
	})
})
