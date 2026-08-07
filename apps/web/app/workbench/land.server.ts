/**
 * The Land step — an accepted Issue's candidate change
 * routed through the existing `apply_spec_change` MCP write-back, exactly the
 * path `apps/web/app/mcp.server.ts` drives for every other agent-facing spec
 * mutation. Nothing new is written to the spec here: `executePlatformTool`
 * validates the op, appends it to `opLog` with provenance, and persists —
 * this module only decides *which* candidate is eligible and records why.
 *
 * Reusing the tool is *not* the same as arriving over MCP, and conflating the
 * two is what issue #358 fixed — see {@link LAND_ATTRIBUTION} below.
 *
 * Only `kind: 'spec-op', via: 'apply-op'` candidates are landable this way —
 * the only `BenchmarkChange` kind that carries an actual typed `SpecOp`.
 * `regen-diff`/`slot-fill`/`eject`/`off-surface` candidates don't have one (by
 * design — see `issues.server.ts`'s `heuristicPropose`), so landing is a no-op
 * for those today; a maintainer resolves them outside the spec for now.
 */

import { executePlatformTool, type PlatformContext } from '@maxstack/mcp'
import type { Issue } from '@maxstack/spec-derive/clustering'
import {
	issueKey as computeIssueKey,
	issueState,
	landableCandidates,
} from '@maxstack/spec-derive/clustering'
import { resolveDataDir } from '~/data-dir.server'
import { type PlatformAttribution, platformFor } from '~/sprout.server'
import { deriveIssues } from './issues.server'

/**
 * Who lands an Issue — a maintainer, in a browser, having read the Issue and
 * clicked Land.
 *
 * This is issue #358's fix, and the reason it needed one is worth keeping: the
 * call below reuses `apply_spec_change`, an *MCP tool*, as an in-process
 * library. Before, it took the web host's process-wide `PlatformContext`, which
 * had been built once at boot with `origin: 'ai'` for the `/mcp` endpoint — so
 * a human clicking a button in a form post recorded
 * `{origin: 'ai', actor: {surface: 'mcp', path: 'mcp-apply-spec-change'}}`.
 * Every field of that is false, and the falsehood is in the one record the
 * review layer exists to be trusted about.
 *
 * `surface: 'web'` is not arguable: this is an HTTP form post from a browser,
 * whatever the op says.
 *
 * `origin: 'human'` is the arguable half and is still right. The op's *content*
 * was AI-derived — it came out of clustering the feedback — so `ai` has a
 * reading. But `origin` answers who *landed* it (see `actor.ts`: "the author
 * kind"), and the whole design of this step is that nothing lands until a
 * maintainer accepts the Issue and then separately chooses to land it. Stamping
 * `ai` would say an agent wrote to the spec unattended, which is exactly the
 * event a reviewer scans this log for, and it would be a false positive every
 * time. The AI lineage is not lost: it is in the decision-ledger entry this
 * function writes (the Issue's own question and rationale) and in the feedback
 * the Issue was clustered from. The consequence to know about is that
 * `applyOp` maps `human` to `manual()` rather than `accept(suggested())` — and
 * that consequence turned out to be a bug in its own right (issue #359), fixed
 * by {@link candidateAuthorship} below rather than by taking any of the above
 * back.
 *
 * `writePath` is its own declared entry in `scripts/write-paths.config.json`
 * rather than a borrowed `mcp-apply-spec-change`. Reusing that id was how this
 * path passed `check-write-paths.mjs` while being undeclared: the checker
 * accounts for call *sites*, and this one is inside a file another path already
 * claims.
 */
export const LAND_ATTRIBUTION: PlatformAttribution = {
	origin: 'human',
	surface: 'web',
	writePath: 'web-land-issue',
}

/**
 * Who *wrote* the op being landed — the other half of the sentence
 * {@link LAND_ATTRIBUTION} starts, and issue #359.
 *
 * #358 made `origin` truthfully answer "a maintainer, in a browser, clicked
 * this". `defaultProvenance` then read that same field as "a maintainer wrote
 * this", and stamped the landed row `manual()`. Two things went wrong at once:
 * the AI lineage was erased (an `accept(suggested())` row stays visibly
 * AI-derived after it goes live — that is the point of keeping `isSuggested`
 * true through an accept), and the row silently picked up the regeneration
 * protection `isAddedManually` confers, so a regenerate would preserve a row
 * nobody hand-authored.
 *
 * The fix is not to un-fix `origin`: requester and author are two axes, and Land
 * is the write path where they genuinely differ. So Land states both. This one
 * is read off the proposal's own record rather than hardcoded `'ai'`, because
 * the record is what actually knows: an Issue enters the world `suggested()`
 * from the clustering layer, and `accept` preserves `isSuggested` — so a human
 * accepting an Issue does not make its candidate op hand-authored, and the flag
 * still says who wrote it at the moment it lands. A hypothetical hand-authored
 * Issue would answer `'human'` here and get `manual()`, correctly.
 */
export function candidateAuthorship(issue: Issue): 'ai' | 'human' {
	return issue.provenance.isSuggested ? 'ai' : 'human'
}

// ===========================================================================
// The landed-issue store — which issue keys have already been landed, so the
// UI can badge them and never offer a double-land. Same host split as
// `issue-review.server`/`feedback.server`: append-only JSONL under a data
// dir, in-memory `globalThis` fallback under tests.
// ===========================================================================

export interface LandedRecord {
	issueKey: string
	opId: string
	at: string
}

const scope = globalThis as typeof globalThis & {
	__maxstackLanded?: LandedRecord[]
}

function memoryLog(): LandedRecord[] {
	scope.__maxstackLanded ??= []
	return scope.__maxstackLanded
}

async function landedPath(): Promise<string | null> {
	const dir = resolveDataDir()
	if (!dir) return null
	const { join } = await import('node:path')
	return join(dir, 'landed-issues.jsonl')
}

async function recordLanded(issueKey: string, opId: string): Promise<void> {
	const record: LandedRecord = { issueKey, opId, at: new Date().toISOString() }
	const path = await landedPath()
	if (!path) {
		memoryLog().push(record)
		return
	}
	const { appendFile, mkdir } = await import('node:fs/promises')
	const { dirname } = await import('node:path')
	await mkdir(dirname(path), { recursive: true })
	await appendFile(path, `${JSON.stringify(record)}\n`)
}

async function allLanded(): Promise<LandedRecord[]> {
	const path = await landedPath()
	if (!path) return memoryLog()
	const { readFile } = await import('node:fs/promises')
	try {
		return (await readFile(path, 'utf8'))
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l.length > 0)
			.map((l) => JSON.parse(l) as LandedRecord)
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
		throw err
	}
}

/** The set of issue keys already landed — for the queue's "Landed" badge and
 *  to keep `landIssueCandidate` idempotent. */
export async function allLandedKeys(): Promise<Set<string>> {
	return new Set((await allLanded()).map((r) => r.issueKey))
}

// ===========================================================================
// Land — accepted candidate → apply_spec_change → opLog + decision ledger
// ===========================================================================

export interface LandResult {
	landed: boolean
	reason?: string
	opId?: string
}

/** A short, safe decision-ledger id suffix derived from the issue's stable
 *  coordinate key (which can contain `:`/`/`/`|`). */
function slug(key: string): string {
	return key.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'issue'
}

function firstText(result: { content: { text: string }[] }): string {
	return result.content.map((c) => c.text).join(' ')
}

/**
 * Land the first landable spec-op candidate of an accepted Issue (identified
 * by its stable {@link computeIssueKey}, not the positional id — the same
 * identity `issue-review.server`'s triage decisions are keyed by). Re-derives
 * Issues fresh (via `issues.server`'s `deriveIssues`, the same fold the queue
 * itself renders) rather than trusting a client-submitted candidate, so a
 * stale or tampered post can't land something a maintainer never actually saw
 * accepted.
 */
export async function landIssueCandidate(
	issueKeyToLand: string,
	platform: PlatformContext = platformFor(LAND_ATTRIBUTION),
): Promise<LandResult> {
	if ((await allLandedKeys()).has(issueKeyToLand)) {
		return { landed: false, reason: 'already landed' }
	}

	const issues = await deriveIssues()
	const issue = issues.find((i: Issue) => computeIssueKey(i) === issueKeyToLand)
	if (!issue) return { landed: false, reason: 'issue not found' }
	if (issueState(issue) !== 'accepted') {
		return { landed: false, reason: 'issue is not accepted' }
	}

	const landable = landableCandidates([issue]).find(
		(c) => c.change.kind === 'spec-op' && c.change.via === 'apply-op',
	)
	if (
		landable?.change.kind !== 'spec-op' ||
		landable.change.via !== 'apply-op'
	) {
		return {
			landed: false,
			reason:
				'no landable spec-op candidate yet (only spec-op/apply-op changes can land directly)',
		}
	}
	const { op } = landable.change

	// The apply carries the proposal's authorship beside the clicker's identity —
	// see `candidateAuthorship`. Only this call: the decision-ledger entry below
	// records a *maintainer's* rationale for landing, which is authored by
	// whoever clicked and takes no provenance row of its own.
	const applied = await executePlatformTool(
		{ ...platform, authorship: candidateAuthorship(issue) },
		'apply_spec_change',
		{ op: op.op, args: op.args },
	)
	if (applied.isError) {
		return {
			landed: false,
			reason: firstText(applied) || 'apply_spec_change failed',
		}
	}
	const parsed = JSON.parse(firstText(applied)) as {
		applied?: { id?: string }
	}
	const opId = parsed.applied?.id ?? 'unknown'

	// Record the rationale in the decision ledger via the existing
	// `record_decision` convenience (wraps `prd.recordDecision`) — the same
	// path `mcp.server.ts` exposes to any agent, reused rather than writing
	// the ledger entry by hand.
	await executePlatformTool(platform, 'record_decision', {
		id: `d-land-${slug(issueKeyToLand)}`,
		question: issue.question,
		options: [{ id: 'land', description: issue.title, pros: [], cons: [] }],
		chosenOptionId: 'land',
		rationale: issue.rationale,
	})

	await recordLanded(issueKeyToLand, opId)
	return { landed: true, opId }
}
