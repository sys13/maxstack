/**
 * The AI port + client selection.
 *
 * Every generator that would call an LLM (right now: filling e2e-test bodies;
 * later: specializing templates under bet A) goes through {@link AiClient}.
 * Selection order: `MOCK_AI` → deterministic mock (the keyless CI path);
 * `ANTHROPIC_API_KEY` → the Anthropic Messages API via the official SDK;
 * `OPENAI_API_KEY` → OpenAI chat completions over fetch. With no key and no
 * mock flag the client refuses loudly on first use rather than hanging on a
 * network call — a keyed nightly that loses its secret fails fast.
 *
 * Both live transports take an injectable `fetch` so the tests exercise the
 * full request/response shape hermetically (no network, no key).
 */

import Anthropic from '@anthropic-ai/sdk'
import { mockAiClient } from './mocks/openai.ts'

/** One structured completion request, keyed by the calling generator. */
export interface AiRequest {
	/** The generator asking — the mock's canned outputs are keyed by this. */
	generator: string
	/** A stable per-item key (e.g. `<pageId>:<index>`) for deterministic mocks. */
	key: string
	/** The natural-language instruction (e.g. an `e2eTests` string). */
	prompt: string
}

/**
 * Token accounting for a set of completions. Every transport reports what the
 * provider actually billed; the mock reports a deterministic character-based
 * estimate so the plumbing is exercised in CI and marks itself `estimated` —
 * a number that came from `MOCK_AI` must never be quotable as a measured cost.
 */
export interface TokenUsage {
	/** Completion requests issued. */
	requests: number
	/** Prompt tokens (including cache reads/writes where the provider splits them). */
	inputTokens: number
	/** Completion tokens, including reasoning tokens the provider bills. */
	outputTokens: number
	/** `inputTokens + outputTokens`. */
	totalTokens: number
	/**
	 * True when the counts are local estimates rather than provider-reported —
	 * i.e. a `MOCK_AI` run. Any published figure must come from an unestimated
	 * run.
	 */
	estimated: boolean
}

export interface AiClient {
	/** Return the model's text completion for a request. */
	complete(req: AiRequest): Promise<string>
	/**
	 * Cumulative token usage since this client was constructed. Optional so a
	 * third-party client stays valid; callers use {@link usageOf}, which reports
	 * a zeroed, estimated total when a client can't account for itself.
	 */
	usage?(): TokenUsage
}

/** A zeroed usage total. `estimated` is false — nothing was estimated yet. */
export function emptyUsage(): TokenUsage {
	return {
		requests: 0,
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		estimated: false,
	}
}

/**
 * Read a client's cumulative usage. A client with no `usage()` cannot account
 * for itself, so it reports zeros marked `estimated` — indistinguishable in the
 * artifact from a mock run, which is the honest reading: not a measured cost.
 */
export function usageOf(ai: AiClient): TokenUsage {
	return ai.usage?.() ?? { ...emptyUsage(), estimated: true }
}

/**
 * Usage accrued between two cumulative snapshots — how the eval attributes
 * tokens to one phase of one benchmark while reusing a single client across
 * the whole run.
 */
export function usageDelta(before: TokenUsage, after: TokenUsage): TokenUsage {
	return {
		requests: Math.max(0, after.requests - before.requests),
		inputTokens: Math.max(0, after.inputTokens - before.inputTokens),
		outputTokens: Math.max(0, after.outputTokens - before.outputTokens),
		totalTokens: Math.max(0, after.totalTokens - before.totalTokens),
		estimated: before.estimated || after.estimated,
	}
}

/** Sum a set of usage totals; `estimated` is sticky (one estimate taints the sum). */
export function sumUsage(parts: readonly TokenUsage[]): TokenUsage {
	return parts.reduce<TokenUsage>(
		(acc, u) => ({
			requests: acc.requests + u.requests,
			inputTokens: acc.inputTokens + u.inputTokens,
			outputTokens: acc.outputTokens + u.outputTokens,
			totalTokens: acc.totalTokens + u.totalTokens,
			estimated: acc.estimated || u.estimated,
		}),
		emptyUsage(),
	)
}

/**
 * A mutable accumulator the transports fold provider-reported counts into.
 * Kept module-local rather than exported: a client's usage is read through
 * {@link AiClient.usage}, never written from outside.
 */
function createUsageMeter(estimated: boolean): {
	add(input: number, output: number): void
	read(): TokenUsage
} {
	const total = { ...emptyUsage(), estimated }
	return {
		add(input, output) {
			total.requests++
			total.inputTokens += input
			total.outputTokens += output
			total.totalTokens += input + output
		},
		read: () => ({ ...total }),
	}
}

/**
 * The estimator the mock bills with: ~4 characters per token, the standard
 * rough conversion. Deterministic in the prompt, so a `MOCK_AI` eval stays
 * byte-reproducible — and always flagged `estimated`.
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4)
}

/**
 * Per-generator system framing. The port returns raw text that gets spliced
 * into generated files verbatim, so every generator's instruction ends the
 * same way: code only, no fences, no commentary.
 */
function systemFor(generator: string): string {
	if (generator === 'e2e-tests') {
		return [
			'You fill the body of one Playwright test inside a generated suite.',
			'The user message is the natural-language acceptance test from the app spec.',
			'Return only the TypeScript statements for the test body — no wrapping',
			'test() call, no imports, no markdown fences, no commentary. In scope:',
			'`page` (a Playwright Page), `expect`, and `baseURL` (the suite route).',
		].join('\n')
	}
	return [
		`You are the "${generator}" generator inside the maxstack maxstack harness.`,
		'Return only the raw output to splice into a generated file — no markdown',
		'fences, no commentary.',
	].join('\n')
}

/** Models still fence code sometimes; the splice target wants bare text. */
function stripFences(text: string): string {
	const trimmed = text.trim()
	const fenced = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(trimmed)
	return fenced?.[1] ?? trimmed
}

/**
 * The Anthropic transport — the primary keyed path. Non-streaming Messages
 * API call per request (completions here are short test bodies), adaptive
 * thinking, `refusal` handled before content is read.
 */
export function anthropicAiClient(
	env: Record<string, string | undefined> = process.env,
	fetchImpl?: typeof globalThis.fetch,
): AiClient {
	let client: Anthropic | undefined
	const meter = createUsageMeter(false)
	return {
		usage: () => meter.read(),
		async complete(req) {
			const apiKey = env.ANTHROPIC_API_KEY
			if (!apiKey) {
				throw new Error(
					'anthropicAiClient: ANTHROPIC_API_KEY is not set. Set MOCK_AI=1 to run the pipeline without an API key.',
				)
			}
			client ??= new Anthropic({
				apiKey,
				...(fetchImpl ? { fetch: fetchImpl } : {}),
			})
			const message = await client.messages.create({
				model: env.ANTHROPIC_MODEL ?? 'claude-opus-4-8',
				max_tokens: 16000,
				thinking: { type: 'adaptive' },
				system: systemFor(req.generator),
				messages: [{ role: 'user', content: req.prompt }],
			})
			// Bill before inspecting the result: a refusal or an empty completion
			// still cost tokens, and a cost the artifact hides is a cost we'd
			// under-report in exactly the runs that went wrong.
			meter.add(
				message.usage.input_tokens +
					(message.usage.cache_read_input_tokens ?? 0) +
					(message.usage.cache_creation_input_tokens ?? 0),
				message.usage.output_tokens,
			)
			if (message.stop_reason === 'refusal') {
				throw new Error(
					`anthropicAiClient: request refused (${req.generator}:${req.key})`,
				)
			}
			const text = message.content
				.flatMap((block) => (block.type === 'text' ? [block.text] : []))
				.join('')
			if (!text.trim()) {
				throw new Error(
					`anthropicAiClient: empty completion (${req.generator}:${req.key})`,
				)
			}
			return stripFences(text)
		},
	}
}

/**
 * The OpenAI transport — the secondary keyed path (chat completions over
 * fetch). Kept SDK-free: one endpoint, one shape, nothing else is used.
 */
export function openAiClient(
	env: Record<string, string | undefined> = process.env,
	fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): AiClient {
	const meter = createUsageMeter(false)
	return {
		usage: () => meter.read(),
		async complete(req) {
			const apiKey = env.OPENAI_API_KEY
			if (!apiKey) {
				throw new Error(
					'openAiClient: OPENAI_API_KEY is not set. Set ANTHROPIC_API_KEY or OPENAI_API_KEY for a keyed run, or MOCK_AI=1 to run the pipeline without an API key.',
				)
			}
			const res = await fetchImpl(
				'https://api.openai.com/v1/chat/completions',
				{
					method: 'POST',
					headers: {
						authorization: `Bearer ${apiKey}`,
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						model: env.OPENAI_MODEL ?? 'gpt-4o-mini',
						messages: [
							{ role: 'system', content: systemFor(req.generator) },
							{ role: 'user', content: req.prompt },
						],
					}),
				},
			)
			if (!res.ok) {
				const body = (await res.text()).slice(0, 300)
				throw new Error(`openAiClient: HTTP ${res.status} — ${body}`)
			}
			const data = (await res.json()) as {
				choices?: { message?: { content?: string } }[]
				usage?: { prompt_tokens?: number; completion_tokens?: number }
			}
			meter.add(
				data.usage?.prompt_tokens ?? 0,
				data.usage?.completion_tokens ?? 0,
			)
			const text = data.choices?.[0]?.message?.content
			if (!text?.trim()) {
				throw new Error(
					`openAiClient: empty completion (${req.generator}:${req.key})`,
				)
			}
			return stripFences(text)
		},
	}
}

/** True when the environment asks for the no-API-key mock mode. */
export function isMockAi(
	env: Record<string, string | undefined> = process.env,
): boolean {
	const v = env.MOCK_AI
	return v !== undefined && v !== '' && v !== '0' && v !== 'false'
}

/**
 * True when {@link selectAiClient} would return a client that can actually
 * complete — i.e. the mock, a keyed Anthropic, or a keyed OpenAI.
 *
 * The keyless path is not a client that *might* fail; it is one that throws on
 * its first call, on configuration alone. That makes availability a pure
 * function of the environment, knowable before anything renders — which is the
 * point of exporting it. UI that offers an AI affordance can ask
 * this in a loader instead of discovering the answer from a failed round-trip
 * the user paid for in typing.
 *
 * This is deliberately *not* a health check: a key that is present but revoked
 * still reads as configured here, and that failure is still reported after the
 * request. Only the case that is decidable up front is decided up front.
 */
export function isAiConfigured(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return isMockAi(env) || !!env.ANTHROPIC_API_KEY || !!env.OPENAI_API_KEY
}

/**
 * Pick the client the pipeline should use. `MOCK_AI` (set, non-empty, not
 * `0`/`false`) → the deterministic mock; `ANTHROPIC_API_KEY` → Anthropic;
 * otherwise OpenAI, whose keyless path fails fast with guidance. This single
 * switch is what makes the eval pipeline runnable in CI without secrets and
 * meaningful in the keyed nightly.
 */
export function selectAiClient(
	env: Record<string, string | undefined> = process.env,
	fetchImpl?: typeof globalThis.fetch,
): AiClient {
	if (isMockAi(env)) return mockAiClient()
	if (env.ANTHROPIC_API_KEY) return anthropicAiClient(env, fetchImpl)
	return openAiClient(env, fetchImpl)
}
