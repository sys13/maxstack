/**
 * Asking, instead of refusing (#421).
 *
 * Six verbs used to fail on a missing required argument — `add-field`'s
 * `entity`, `eject`'s `route-id`, `theme`'s `preset` — for values the CLI could
 * enumerate from the project it was already standing in. Four of them proved it
 * by printing the list **in the error**, after you guessed wrong. The working
 * loop was: run a command, read an error, run a second command to list the
 * values, copy a string out of its output, re-run the first.
 *
 * This module is the layer that closes that loop, and the contract it keeps is
 * as much about *not* prompting as about prompting.
 *
 * ## The non-interactive contract
 *
 * The agent is a primary interface here: `mcp` is spawned over stdio,
 * `guard-edit` is fed a hook event on stdin, and half the verbs have a `--json`
 * mode whose whole purpose is to be read by something that is not a person. A
 * prompt reached by any of those is not a worse UX, it is a **hang** — a
 * process waiting forever on an answer nobody is there to give.
 *
 * So {@link isInteractive} demands that *both* stdin and stdout be a TTY, and
 * honours an explicit `MAXSTACK_NO_PROMPT` opt-out for the case the TTY test
 * cannot see: a real terminal being driven by a script. When it says no, the
 * caller must fall back to {@link missingArgument}, which reproduces
 * commander's own refusal byte for byte — same text, same exit code, same
 * `commander.missingArgument` code — so no existing scripted invocation can
 * tell that the argument became optional in the command tree.
 *
 * That last point is the whole risk of this change and the reason it is
 * concentrated in one function: making a required argument optional so it *can*
 * be prompted for is exactly how a required argument stops being required in
 * CI. The prompting is a convenience; this is the invariant.
 *
 * ## Why no dependency
 *
 * The CLI has no prompt library, and the alternative to adding one is about
 * eighty lines over `node:readline/promises`. Selection is a numbered list read
 * as a line, not a raw-mode cursor: it needs no keypress decoding, it survives
 * a terminal that does not do what an arrow key implies, and — the reason that
 * matters most here — it is testable against a plain string stream, so none of
 * the tests below need a pty.
 */

import type { Command } from 'commander'
import { bold, cyan, dim, glyphs, red } from './tty.ts'

/** One option in a {@link Prompter.select} list. */
export interface Choice<T> {
	/** What the caller gets back when this row is picked. */
	value: T
	/** The row's primary text — usually the literal argument value. */
	label: string
	/** Trailing context, dimmed: an ownership state, a route, a description. */
	hint?: string
}

/** The question-asking surface. Injectable so command tests never open a TTY. */
export interface Prompter {
	/** Free text, with an optional default and an optional re-ask validator. */
	text(
		question: string,
		opts?: {
			default?: string
			/** Return a message to reject the answer and ask again. */
			validate?: (answer: string) => string | undefined
		},
	): Promise<string>
	/** Pick one of `choices` by number. */
	select<T>(question: string, choices: Choice<T>[]): Promise<T>
	/** A yes/no question. */
	confirm(question: string, opts?: { default?: boolean }): Promise<boolean>
	/** Release the terminal. Safe to call more than once. */
	close(): Promise<void>
}

/**
 * Thrown when the user abandons a prompt (Ctrl-D at a question). Distinct from
 * a validation failure because it means *stop*, not *ask again* — and distinct
 * from an ordinary error because the caller has nothing to report: the user
 * already knows what they did.
 */
export class PromptAbort extends Error {
	constructor() {
		super('cancelled')
		this.name = 'PromptAbort'
	}
}

/**
 * Whether it is safe to block on a human.
 *
 * Both streams, not just stdin: a command whose stdout is piped is being read
 * by something, and a question printed into that pipe is both invisible to the
 * user and corruption in the consumer's input.
 *
 * `MAXSTACK_NO_PROMPT` (any non-empty value) forces this false. `CI` is
 * deliberately *not* consulted — CI does not allocate a TTY, so the stream test
 * already covers it, and honouring the variable would break the one case where
 * someone sets `CI=1` in an interactive shell to reproduce a build.
 */
export function isInteractive(
	env = process.env,
	// Taken as an argument rather than read off `process`, because `isTTY` is an
	// ordinary property that is simply *absent* on a pipe — not a getter — so it
	// cannot be spied on, and a test that assigned it would be mutating global
	// state the rest of the suite shares.
	streams: {
		stdin: { isTTY?: boolean }
		stdout: { isTTY?: boolean }
	} = process,
): boolean {
	if (env.MAXSTACK_NO_PROMPT) return false
	return Boolean(streams.stdin.isTTY) && Boolean(streams.stdout.isTTY)
}

/**
 * Refuse an absent required argument exactly the way commander does.
 *
 * Reached whenever an argument this module could have prompted for is missing
 * and {@link isInteractive} is false. The message, the exit code and the error
 * code are copied from commander's own `missingArgument` (`lib/command.js`), so
 * that relaxing `<entity>` to `[entity]` in the command tree is invisible to
 * every non-interactive caller. `program.test.ts` asserts the two agree.
 *
 * Returns `never`: commander's `error()` exits the process.
 */
export function missingArgument(cmd: Command, name: string): never {
	cmd.error(`error: missing required argument '${name}'`, {
		code: 'commander.missingArgument',
	})
	// `Command#error` exits, but its declared return type is void, so the
	// compiler still needs this to believe the `never`.
	throw new Error(`missing required argument '${name}'`)
}

/**
 * What a command needs to resolve an absent argument: someone to ask, or the
 * refusal to fall back on. Built once per invocation by
 * {@link interactionFor} and threaded in, rather than reached for as a global,
 * so a test supplies its own without touching `process`.
 */
export interface Interaction {
	/** The prompter, or `null` when nobody is watching. */
	prompter: Prompter | null
	/** Refuse, as commander would, naming the argument. */
	missing: (name: string) => never
}

/**
 * The default for callers that are not commander: other commands calling a
 * command function directly, and the tests.
 *
 * It throws rather than exiting, because `process.exit` inside a library call
 * is a test that takes the runner down with it. The message still matches
 * commander's, so the string a caller sees is the same either way — only the
 * mechanism differs, and the mechanism is only ever commander's when commander
 * is the one that dispatched.
 */
export const nonInteractive: Interaction = {
	prompter: null,
	missing: (name) => {
		throw new Error(`missing required argument '${name}'`)
	},
}

/** Build the {@link Interaction} for a running command. */
export function interactionFor(cmd: Command): Interaction {
	return {
		prompter: isInteractive() ? openPrompter() : null,
		missing: (name) => missingArgument(cmd, name),
	}
}

/**
 * Resolve one argument: use what was typed, else ask, else refuse.
 *
 * The shape every prompting command follows, in one place so that "absent and
 * non-interactive" cannot be spelled six slightly different ways.
 */
export async function resolveArg<T>(
	// `NoInfer` so `T` is fixed by what `ask` produces, never widened by the
	// argument being resolved. Without it, passing the usual `string | undefined`
	// argument infers `T = string | undefined` and the *result* comes back
	// possibly-undefined — which is the one thing this function exists to rule
	// out, and it would be ruled out silently.
	given: NoInfer<T> | undefined,
	name: string,
	io: Interaction,
	ask: (prompter: Prompter) => Promise<T>,
): Promise<T> {
	if (given !== undefined) return given
	if (!io.prompter) return io.missing(name)
	return await ask(io.prompter)
}

/**
 * Every prompter this process opened, so {@link closePrompters} can release the
 * terminal once at the end of the run.
 *
 * A readline interface holds a `data` listener on stdin, and an open listener
 * on stdin keeps the event loop alive: a command that asked a question and then
 * finished its work would print its result and **hang**. Closing centrally in
 * `cli.ts` rather than in each command is the same reasoning as the update
 * check living there — it has to happen after every command without any of them
 * having to remember.
 */
const opened = new Set<Prompter>()

/** Release any terminal this run took. Idempotent; safe when none was opened. */
export async function closePrompters(): Promise<void> {
	for (const prompter of opened) await prompter.close()
	opened.clear()
}

/**
 * The streams a prompter talks over. Injectable purely so the tests can drive
 * the real `openPrompter` — the numbered-list design was chosen partly because
 * it needs nothing more than a pair of pipes to exercise, and a prompt layer
 * that can only be tested through mocks of itself is a prompt layer whose
 * re-ask loops are never actually run.
 */
export interface PromptStreams {
	input: NodeJS.ReadableStream
	output: NodeJS.WritableStream
}

/** Open a readline-backed prompter, over the real terminal unless told otherwise. */
export function openPrompter(streams?: PromptStreams): Prompter {
	const input = streams?.input ?? process.stdin
	const output = streams?.output ?? process.stdout
	let rl: import('node:readline/promises').Interface | null = null
	let closed = false

	const iface = async () => {
		if (!rl) {
			const { createInterface } = await import('node:readline/promises')
			rl = createInterface({ input, output })
			// Without this, Ctrl-C at a prompt leaves the terminal in readline's
			// raw-ish state on some shells. 130 is the conventional
			// terminated-by-SIGINT status, which a calling script can recognise.
			rl.on('SIGINT', () => {
				rl?.close()
				output.write('\n')
				process.exit(130)
			})
		}
		return rl
	}

	/**
	 * One line of input. `readline/promises` resolves `question` with `undefined`
	 * when the stream ends (Ctrl-D) rather than rejecting, which would otherwise
	 * surface as the string "undefined" being validated as an answer.
	 */
	const line = async (q: string): Promise<string> => {
		const answer = (await (await iface()).question(q)) as string | undefined
		if (answer === undefined) throw new PromptAbort()
		return answer.trim()
	}

	const prompter: Prompter = {
		async text(question, opts = {}) {
			const suffix = opts.default ? dim(` [${opts.default}]`) : ''
			for (;;) {
				const raw = await line(`${cyan('?')} ${question}${suffix} `)
				const answer = raw || opts.default || ''
				if (!answer) {
					output.write(`  ${red('an answer is required')}\n`)
					continue
				}
				const problem = opts.validate?.(answer)
				if (problem) {
					output.write(`  ${red(problem)}\n`)
					continue
				}
				return answer
			}
		},

		async select(question, choices) {
			if (choices.length === 0) {
				throw new Error(`nothing to choose from for "${question}"`)
			}
			// Not silently auto-picked: a sole option is still a decision the user
			// should see made, and skipping it makes the command's behaviour depend
			// on how many entities happen to exist.
			const numWidth = String(choices.length).length
			// Hints line up in a column. Padding is applied to the *label*, before
			// any color is wrapped around it, because an ANSI escape counts toward
			// `padEnd`'s length and would leave the column ragged by exactly the
			// width of the escape sequence.
			const labelWidth = Math.max(
				...choices.filter((c) => c.hint).map((c) => c.label.length),
				0,
			)
			output.write(`${cyan('?')} ${question}\n`)
			for (const [i, choice] of choices.entries()) {
				const n = String(i + 1).padStart(numWidth)
				const label = choice.hint
					? choice.label.padEnd(labelWidth)
					: choice.label
				const hint = choice.hint ? `  ${dim(choice.hint)}` : ''
				output.write(`  ${dim(`${n})`)} ${label}${hint}\n`)
			}
			for (;;) {
				const raw = await line(`  ${cyan(glyphs.pointer)} `)
				// Accept the number, or the label itself — the label is the argument
				// the user would otherwise have typed, so pasting it must work.
				const byLabel = choices.find((c) => c.label === raw)
				if (byLabel) return byLabel.value
				const n = Number(raw)
				const picked = Number.isInteger(n) ? choices[n - 1] : undefined
				if (picked) return picked.value
				output.write(
					`  ${red(`enter 1${choices.length > 1 ? `-${choices.length}` : ''}`)}\n`,
				)
			}
		},

		async confirm(question, opts = {}) {
			const hint = opts.default === false ? 'y/N' : 'Y/n'
			for (;;) {
				const raw = (await line(`${cyan('?')} ${question} ${dim(`[${hint}]`)} `))
					.toLowerCase()
				if (!raw) return opts.default !== false
				if (raw === 'y' || raw === 'yes') return true
				if (raw === 'n' || raw === 'no') return false
				output.write(`  ${red('answer y or n')}\n`)
			}
		},

		async close() {
			if (closed) return
			closed = true
			rl?.close()
			rl = null
		},
	}
	opened.add(prompter)
	return prompter
}

/**
 * Echo the command the answers add up to, before it runs.
 *
 * The prompts are a convenience, not a replacement for the flags: a user who
 * answered four questions should leave knowing the single line that would have
 * done it, so the second time they type it and the tenth time they script it.
 * Printing it is also the honest disclosure of what is about to be applied.
 */
export function echoInvocation(argv: string[]): void {
	console.log(`\n  ${dim('running')} ${bold(argv.join(' '))}\n`)
}

/**
 * Quote an argument for the echo above if a shell would mangle it.
 *
 * `enum(a,b)` and `->e-user` are the field DSL's own spellings and both are
 * shell syntax — the unquoted arrow is a redirect that silently truncates the
 * argument, which `field-dsl.ts` documents as a known trap. Prompting sidesteps
 * it (there is no shell between the question and the answer), but the line we
 * print is meant to be pasted, so it has to survive one.
 */
export function shellQuote(arg: string): string {
	// `!` is in the safe set: it is the DSL's required marker, it appears
	// unquoted throughout the docs, and it only expands in an *interactive* bash
	// when followed by a word. `(`, `)` and `>` are not, which is the pair the
	// field DSL actually gets bitten by.
	return /^[\w./:@=!-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`
}
