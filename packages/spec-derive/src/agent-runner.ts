/**
 * The agent runner behind the AI-driven paths.
 *
 * The rest of this package has never needed an agent. `ai.ts` is a **single-shot
 * completion port** — one prompt in, one string out — because the only thing the
 * eval asks a model to do is fill a test body. A full agent session asks
 * something categorically different: work through a backlog against a real
 * repository, with tools, over many turns, until a shell command exits 0. That
 * is a tool-use loop, and it does not exist anywhere in the harness, so it is
 * here.
 *
 * The protocol's requirement that shapes every decision below: **all three arms
 * are driven by the same runner**. Not equivalent runners — the same one. The
 * arms differ in their workspace and in one paragraph of orientation
 * (`comparison-config.ts`); everything about how the model is called, which
 * tools it has, how many turns it gets and how its tokens are counted is shared
 * code, so "same agent, same effort" is structural rather than a claim about how
 * carefully the run was configured.
 *
 * Three things worth knowing before reading the code:
 *
 * - **The session is long-lived.** One {@link AgentSession} per (arm, benchmark,
 *   repeat) cell, carrying conversation history across the whole change set,
 *   because that is what maintaining an application is. A fresh session per
 *   change would hand every arm amnesia and measure re-orientation cost eleven
 *   times.
 * - **Tokens are provider-reported, never estimated.** {@link AgentAttempt.usage}
 *   folds `message.usage` from every turn, including cache reads and writes,
 *   including the turns of a failed attempt. `estimated` is false, and the
 *   ledger rejects a run where it is true — a `MOCK_AI`-shaped number cannot
 *   support a wall-clock claim.
 * - **The workspace is a port.** {@link Workspace} is four methods, so the whole
 *   loop is testable without a filesystem, a shell or a network, and
 *   {@link nodeWorkspace} is the only part that touches the machine.
 */

import type { TokenUsage } from './ai.ts'
import { emptyUsage } from './ai.ts'

/**
 * What the agent can do. Deliberately four primitives rather than a curated
 * toolkit: a curated toolkit is a place to accidentally help one arm — a
 * `apply_spec_op` tool would be handing arm M the surface the comparison is
 * supposed to measure it discovering. The maxstack MCP server *is* available to
 * arm M, but the way a real agent has it: as a server the model finds and calls
 * through the shell, not as a privileged tool the harness wired in for it.
 */
export interface Workspace {
	/** Read a file, relative to the workspace root. */
	read(path: string): Promise<string>
	/** Write a file, creating parent directories. */
	write(path: string, content: string): Promise<void>
	/** List entries under a directory, relative to the root. */
	list(path: string): Promise<string[]>
	/** Run a shell command in the workspace root. */
	exec(
		command: string,
	): Promise<{ code: number; stdout: string; stderr: string }>
}

/**
 * Cap on a single tool result fed back to the model. A `pnpm install` or a
 * failing build can emit megabytes, and an uncapped result costs the arm that
 * happened to hit it a large number of input tokens for no information — which
 * would show up as a token *difference between arms* caused by the harness. The
 * tail is kept rather than the head: the error is at the end.
 */
export const TOOL_RESULT_LIMIT = 8_000

function tail(text: string, limit = TOOL_RESULT_LIMIT): string {
	return text.length <= limit
		? text
		: `…[${text.length - limit} characters truncated]…\n${text.slice(-limit)}`
}

/** The tool definitions, identical for every arm. */
export const AGENT_TOOLS = [
	{
		name: 'read_file',
		description: 'Read a UTF-8 file, relative to the repository root.',
		input_schema: {
			type: 'object' as const,
			properties: { path: { type: 'string' } },
			required: ['path'],
		},
	},
	{
		name: 'write_file',
		description:
			'Write a UTF-8 file, relative to the repository root, creating parent directories. Overwrites.',
		input_schema: {
			type: 'object' as const,
			properties: { path: { type: 'string' }, content: { type: 'string' } },
			required: ['path', 'content'],
		},
	},
	{
		name: 'list_files',
		description:
			'List entries under a directory, relative to the repository root.',
		input_schema: {
			type: 'object' as const,
			properties: { path: { type: 'string' } },
			required: ['path'],
		},
	},
	{
		name: 'run_command',
		description:
			'Run a shell command in the repository root and return its exit code, stdout and stderr.',
		input_schema: {
			type: 'object' as const,
			properties: { command: { type: 'string' } },
			required: ['command'],
		},
	},
] as const

/** Why an attempt stopped. Recorded per change — see `comparison-arm.ts`. */
export type AgentStopReason =
	/** The model ended its turn without asking for another tool. */
	| 'completed'
	/** {@link AgentRunOptions.maxTurns} was reached — a cost control, tripped. */
	| 'turn-cap'
	/** The provider refused. Billed, recorded, and not retried as if it were a gate failure. */
	| 'refusal'
	/** The transport threw after its retries. The cell is void, not a loss. */
	| 'error'

/** One instruction, run to a stop. */
export interface AgentAttempt {
	stopReason: AgentStopReason
	/** Assistant turns taken. */
	turns: number
	/** Provider-reported usage for this attempt only. */
	usage: TokenUsage
	/** The model's last text, for the transcript. */
	finalText: string
	/** Set when `stopReason` is `error`. */
	error?: string
}

/**
 * A conversation with one agent in one workspace. `send` runs the tool loop
 * until the model stops asking for tools, and returns what that instruction
 * cost. History accumulates across calls.
 */
export interface AgentSession {
	send(instruction: string): Promise<AgentAttempt>
	/** Cumulative usage across every `send` on this session. */
	usage(): TokenUsage
}

export interface AgentRunOptions {
	system: string
	workspace: Workspace
	model: string
	maxTurns: number
	maxTokens: number
	thinkingTokens: number
}

/** Constructs sessions. One implementation per transport; one used per run. */
export interface AgentRunner {
	start(options: AgentRunOptions): AgentSession
}

/* -------------------------------------------------------------------------- */
/* transport                                                                  */
/* -------------------------------------------------------------------------- */

/** The subset of a Messages API response the loop reads. */
export interface AgentMessage {
	stop_reason?: string | null
	content: {
		type: string
		text?: string
		id?: string
		name?: string
		input?: unknown
	}[]
	usage?: {
		input_tokens?: number
		output_tokens?: number
		cache_read_input_tokens?: number
		cache_creation_input_tokens?: number
	}
}

/** The request the loop issues. Structural, so a fake needs no SDK types. */
export interface AgentRequest {
	model: string
	max_tokens: number
	thinking: { type: 'enabled'; budget_tokens: number }
	system: string
	tools: typeof AGENT_TOOLS
	messages: { role: 'user' | 'assistant'; content: unknown }[]
}

/**
 * The one seam a test replaces. Injecting here rather than at the SDK keeps the
 * whole loop — tool dispatch, truncation, turn cap, token folding — under test
 * with no network and no key.
 */
export type AgentTransport = (req: AgentRequest) => Promise<AgentMessage>

function foldUsage(into: TokenUsage, u: AgentMessage['usage']): void {
	into.requests += 1
	const input =
		(u?.input_tokens ?? 0) +
		(u?.cache_read_input_tokens ?? 0) +
		(u?.cache_creation_input_tokens ?? 0)
	const output = u?.output_tokens ?? 0
	into.inputTokens += input
	into.outputTokens += output
	into.totalTokens += input + output
}

/** Execute one tool call against the workspace. Never throws — an error is a result. */
export async function runTool(
	workspace: Workspace,
	name: string,
	input: unknown,
): Promise<{ content: string; isError: boolean }> {
	const arg = (input ?? {}) as Record<string, unknown>
	try {
		if (name === 'read_file') {
			return {
				content: tail(await workspace.read(String(arg.path))),
				isError: false,
			}
		}
		if (name === 'write_file') {
			await workspace.write(String(arg.path), String(arg.content ?? ''))
			return { content: `wrote ${String(arg.path)}`, isError: false }
		}
		if (name === 'list_files') {
			const entries = await workspace.list(String(arg.path ?? '.'))
			return { content: tail(entries.join('\n')), isError: false }
		}
		if (name === 'run_command') {
			const res = await workspace.exec(String(arg.command))
			return {
				content: tail(
					`exit ${res.code}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`,
				),
				// A non-zero exit is information, not a tool failure: the agent asked
				// what the command does and got a true answer. Flagging it as an error
				// would train the model to avoid running its own gate.
				isError: false,
			}
		}
		return { content: `unknown tool: ${name}`, isError: true }
	} catch (err) {
		return { content: `tool error: ${(err as Error).message}`, isError: true }
	}
}

/**
 * The runner. `transport` defaults to the Anthropic Messages API through the
 * SDK already in this package's dependencies.
 */
export function agentRunner(deps?: {
	transport?: AgentTransport
	env?: Record<string, string | undefined>
}): AgentRunner {
	const env = deps?.env ?? process.env
	const transport = deps?.transport ?? anthropicTransport(env)
	return {
		start(options) {
			const history: AgentRequest['messages'] = []
			const total = { ...emptyUsage() }
			return {
				usage: () => ({ ...total }),
				async send(instruction) {
					const attemptUsage = { ...emptyUsage() }
					history.push({ role: 'user', content: instruction })
					let turns = 0
					let finalText = ''
					while (turns < options.maxTurns) {
						turns++
						let message: AgentMessage
						try {
							message = await transport({
								model: options.model,
								max_tokens: options.maxTokens,
								thinking: {
									type: 'enabled',
									budget_tokens: options.thinkingTokens,
								},
								system: options.system,
								tools: AGENT_TOOLS,
								messages: history,
							})
						} catch (err) {
							foldInto(total, attemptUsage)
							return {
								stopReason: 'error',
								turns,
								usage: attemptUsage,
								finalText,
								error: (err as Error).message,
							}
						}
						// Bill first, always. A refusal, an empty completion and a
						// truncated turn all cost tokens, and the costs an artifact hides
						// are exactly the ones from the runs that went wrong.
						foldUsage(attemptUsage, message.usage)
						history.push({ role: 'assistant', content: message.content })
						finalText =
							message.content
								.filter((b) => b.type === 'text')
								.map((b) => b.text ?? '')
								.join('') || finalText
						if (message.stop_reason === 'refusal') {
							foldInto(total, attemptUsage)
							return {
								stopReason: 'refusal',
								turns,
								usage: attemptUsage,
								finalText,
							}
						}
						const calls = message.content.filter((b) => b.type === 'tool_use')
						if (calls.length === 0) {
							foldInto(total, attemptUsage)
							return {
								stopReason: 'completed',
								turns,
								usage: attemptUsage,
								finalText,
							}
						}
						const results = []
						for (const call of calls) {
							const out = await runTool(
								options.workspace,
								call.name ?? '',
								call.input,
							)
							results.push({
								type: 'tool_result',
								tool_use_id: call.id,
								content: out.content,
								...(out.isError ? { is_error: true } : {}),
							})
						}
						history.push({ role: 'user', content: results })
					}
					foldInto(total, attemptUsage)
					return {
						stopReason: 'turn-cap',
						turns,
						usage: attemptUsage,
						finalText,
					}
				},
			}
		},
	}
}

function foldInto(total: TokenUsage, part: TokenUsage): void {
	total.requests += part.requests
	total.inputTokens += part.inputTokens
	total.outputTokens += part.outputTokens
	total.totalTokens += part.totalTokens
	total.estimated = total.estimated || part.estimated
}

/**
 * The keyed transport. Lazily imports the SDK so the pure loop stays importable
 * without it, and refuses loudly with no key rather than hanging — a keyed run
 * that lost its secret must fail in the first second, not four hours in.
 */
export function anthropicTransport(
	env: Record<string, string | undefined> = process.env,
): AgentTransport {
	return async (req) => {
		const apiKey = env.ANTHROPIC_API_KEY
		if (!apiKey) {
			throw new Error(
				'comparison: ANTHROPIC_API_KEY is not set. The comparison is keyed-runs-only by protocol — MOCK_AI cannot support a wall-clock claim.',
			)
		}
		const { default: Anthropic } = await import('@anthropic-ai/sdk')
		const client = new Anthropic({ apiKey })
		return (await client.messages.create({
			model: req.model,
			max_tokens: req.max_tokens,
			thinking: req.thinking,
			system: req.system,
			// The SDK's tool and message types are narrower than the structural
			// shapes this module is written against, deliberately: the loop is under
			// test through a fake transport, and coupling it to SDK types would put
			// the fake out of reach.
			tools: req.tools as never,
			messages: req.messages as never,
		})) as unknown as AgentMessage
	}
}

/* -------------------------------------------------------------------------- */
/* the node workspace                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A real workspace rooted at `root`. Every path is resolved and checked to be
 * inside the root: an arm that wrote outside its own directory could reach the
 * other arm's tree, the harness, or the acceptance specs it is being judged by,
 * and a comparison whose arms can edit each other is not a comparison.
 *
 * Commands run through the shell with the same containment applied to `cwd`
 * only — a determined command can still escape, and that is a limitation worth
 * stating rather than pretending away: the containment here is a guardrail
 * against a confused agent, not a sandbox against a hostile one. Runs happen on
 * a machine dedicated to the run (protocol: *"on one machine, with no other
 * benchmark work running"*).
 */
export function nodeWorkspace(
	root: string,
	opts?: { commandTimeoutMs?: number },
): Workspace {
	const timeout = opts?.commandTimeoutMs ?? 15 * 60_000
	const resolve = async (path: string): Promise<string> => {
		const { resolve: r, relative, isAbsolute } = await import('node:path')
		const full = r(root, path)
		const rel = relative(root, full)
		if (rel.startsWith('..') || isAbsolute(rel)) {
			throw new Error(`path escapes the workspace root: ${path}`)
		}
		return full
	}
	return {
		async read(path) {
			const { readFile } = await import('node:fs/promises')
			return readFile(await resolve(path), 'utf8')
		},
		async write(path, content) {
			const { mkdir, writeFile } = await import('node:fs/promises')
			const { dirname } = await import('node:path')
			const full = await resolve(path)
			await mkdir(dirname(full), { recursive: true })
			await writeFile(full, content)
		},
		async list(path) {
			const { readdir } = await import('node:fs/promises')
			const entries = await readdir(await resolve(path), {
				withFileTypes: true,
			})
			return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
		},
		async exec(command) {
			const { exec } = await import('node:child_process')
			return new Promise((resolveExec) => {
				exec(
					command,
					{ cwd: root, timeout, maxBuffer: 32 * 1024 * 1024 },
					(error, stdout, stderr) => {
						resolveExec({
							code: error ? ((error as { code?: number }).code ?? 1) : 0,
							stdout: String(stdout),
							stderr: String(stderr),
						})
					},
				)
			})
		},
	}
}
