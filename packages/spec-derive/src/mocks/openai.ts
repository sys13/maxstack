/**
 * `MOCK_AI` canned outputs, keyed by generator name (lineage: bbai_prd +
 * supermax `mocks/openai.ts`). Each entry is a deterministic function of the
 * request, so the pipeline produces byte-identical results on every CI run with
 * no API key and no network — the property that lets `maxstack eval` gate a PR.
 *
 * A missing generator throws rather than returning a plausible blank: a silent
 * mock gap would let a new generator "pass" CI without ever being exercised.
 */

import {
	type AiClient,
	type AiRequest,
	emptyUsage,
	estimateTokens,
} from '../ai.ts'
import { blueprintFromDescription } from '../describe-app.ts'

/** A canned generator: deterministic text for a request. */
type CannedGenerator = (req: AiRequest) => string

/**
 * The e2e-test body filler. Turns a natural-language `e2eTests` string into a
 * deterministic Playwright step body — enough to scaffold and typecheck the
 * suite; the real agent produces meaningful assertions when a key is present.
 */
const e2eTests: CannedGenerator = (req) => {
	const step = req.prompt.replace(/\n/g, ' ').trim()
	return [
		`// mock body for: ${step}`,
		'await page.goto(baseURL)',
		`await expect(page.locator('body')).toContainText('')`,
		'// TODO(agent): replace with real assertions when MOCK_AI is off',
	].join('\n')
}

/** One line of the `feedback-cluster` prompt (see `clustering.ts`'s
 *  `buildClusterPrompt`): `- id=fb-1 kind=bug target=field:task/title body="..."`. */
const FEEDBACK_LINE_RE = /^- id=(\S+) kind=(\S+) target=(\S+) body=/

/**
 * The feedback-clusterer mock: parses the prompt's own labeled lines (it has
 * no access to the structured `Feedback[]`, only the rendered prompt text) and
 * regroups by target coordinate — the same theming `groupByTarget` does, kept
 * separate so a real model's output is what CI actually exercises when keyed.
 * A group containing a `request` proposes a `prd.addRequirement` spec-op
 * candidate (the only op-authoring path an AI cluster is allowed); anything
 * else proposes an honest `off-surface` candidate. Deterministic per prompt.
 */
const feedbackCluster: CannedGenerator = (req) => {
	const groups = new Map<string, { ids: string[]; kinds: string[] }>()
	for (const line of req.prompt.split('\n')) {
		const m = FEEDBACK_LINE_RE.exec(line)
		const id = m?.[1]
		const kind = m?.[2]
		const target = m?.[3]
		if (!id || !kind || !target) continue
		const hit = groups.get(target)
		if (hit) {
			hit.ids.push(id)
			hit.kinds.push(kind)
		} else groups.set(target, { ids: [id], kinds: [kind] })
	}
	const clusters = [...groups.entries()].map(([target, group], i) => {
		const hasRequest = group.kinds.includes('request')
		const candidate = hasRequest
			? {
					kind: 'spec-op',
					description: `Add a backlog requirement for ${target}`,
					requirement: {
						id: `r-issue-${i + 1}-1`,
						userStory: `As a user, feedback on ${target} should be addressed.`,
						acceptanceCriteria: [`${target} reflects the requested change.`],
						priority: 'P2',
					},
				}
			: {
					kind: 'off-surface',
					description: `No typed op for ${target} yet`,
					resource: target,
					resolution: 'unexpressible',
				}
		return {
			title: `Feedback on ${target} (mock cluster)`,
			question: `What should we do about ${target}?`,
			rationale: `${group.ids.length} piece(s) of feedback point at this coordinate (MOCK_AI).`,
			feedbackIds: group.ids,
			confidence: 0.75,
			candidates: [candidate],
		}
	})
	return JSON.stringify(clusters)
}

/**
 * The entity-parse mock (`POST /:page/parse`): a fixed, clearly-labeled
 * person, enough for guided "describe it, we'll fill the form" flows to
 * exercise parse → prefill → review keylessly. The endpoint drops any key the
 * target entity doesn't have, so non-person resources just get less prefill.
 */
const parseEntity: CannedGenerator = () =>
	JSON.stringify({
		name: 'Sam Mocksworth',
		relationship: 'friend',
		interests: 'canned MOCK_AI output',
	})

/**
 * The starting-blueprint mock (`maxstack start`): recovers the
 * description from the prompt's own `"""` fence — the mock sees only rendered
 * text, like every other generator here — and returns the deterministic
 * heuristic's JSON.
 *
 * Deliberately *not* a fixed canned object: `start` has to produce the same app
 * from the same sentence for CI to gate it at all, and routing the mock through
 * `blueprintFromDescription` means the keyless path still exercises the real
 * parse → normalize → validate chain the keyed path depends on. A hardcoded
 * blob would let a parser regression ship green.
 */
const FENCED_DESCRIPTION = /"""\n([\s\S]*?)\n"""/

const appBlueprint: CannedGenerator = (req) => {
	const description = FENCED_DESCRIPTION.exec(req.prompt)?.[1] ?? req.prompt
	return JSON.stringify(blueprintFromDescription(description.trim()))
}

/** The canned map — one entry per generator that calls the AI port. */
export const MOCK_GENERATORS: Record<string, CannedGenerator> = {
	'app-blueprint': appBlueprint,
	'e2e-tests': e2eTests,
	'feedback-cluster': feedbackCluster,
	'parse-entity': parseEntity,
}

/** A deterministic {@link AiClient} backed by {@link MOCK_GENERATORS}. */
export function mockAiClient(
	generators: Record<string, CannedGenerator> = MOCK_GENERATORS,
): AiClient {
	// Estimated, never billed: the mock reports char/4 token counts so the
	// accounting path is exercised in CI, and marks every total `estimated` so a
	// keyless run's numbers can never be mistaken for a measured cost.
	const total = { ...emptyUsage(), estimated: true }
	return {
		usage: () => ({ ...total }),
		async complete(req) {
			const gen = generators[req.generator]
			if (!gen) {
				throw new Error(
					`MOCK_AI: no canned output for generator "${req.generator}". Add one to mocks/openai.ts.`,
				)
			}
			const text = gen(req)
			const input = estimateTokens(req.prompt)
			const output = estimateTokens(text)
			total.requests++
			total.inputTokens += input
			total.outputTokens += output
			total.totalTokens += input + output
			return text
		},
	}
}
