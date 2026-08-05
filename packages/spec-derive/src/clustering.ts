/**
 * Feedback → Issue → candidate change — the Cluster + Propose stages of the
 * review-&-feedback loop.
 *
 * The chain, and what each stage reuses:
 *
 *   Feedback[]  ──cluster──►  Issue[]  ──propose──►  ExampleChange[]  ──►  computePriority
 * (AI, gated) (ledger- (typed
 *                              shaped)    candidates)
 *
 * - **Cluster** folds raw {@link Feedback} into `Issue`s (themes). Clustering is
 *   AI-proposed and *never auto-applied* — an `Issue` enters the world as a
 *   provenance *suggestion* (`isAccepted: null`) and goes through the existing
 *   `suggested → accepted` gate before it is trusted, exactly like every other
 *   AI output. In the UI it renders as just another suggested row.
 * - **Propose** hands each `Issue` one or more candidate changes typed as the
 *   existing {@link ExampleChange} union, so every candidate carries a
 *   `costWeight` for free (feeds #10).
 * - **Land** (not here) accepts a candidate and routes it to `apply_spec_change`.
 *
 * The AI is injected as a {@link ClusterFn} seam (the same dependency-injection
 * discipline as the harness's clock and `AiClient`), so this whole module is
 * pure and unit-testable: a deterministic {@link groupByTarget} baseline stands
 * in for the model in tests and as an offline fallback. Crucially the *facts*
 * that drive prioritization — which targets an issue touches, its severity — are
 * derived here from the real folded feedback, never taken on the model's word.
 */

import {
	accept,
	deriveProvenanceState,
	type Feedback,
	type Provenance,
	type ProvenanceState,
	type Requirement,
	type ReviewTarget,
	reject,
	suggested,
	targetKey,
} from '@maxstack/spec'
// Type-only: keeps this subpath's runtime free of the anthropic/openai SDKs
// pulled in by `./ai.ts` (see the `@maxstack/spec-derive/clustering` export in
// package.json) — only the shape is needed here, never a constructed client.
import type { AiClient } from './ai.ts'
import type { ExampleChange } from './index.ts'
import {
	type PriorityCandidate,
	SEVERITY_WEIGHTS,
	type SeverityKind,
} from './priority.ts'

/**
 * An issue — a decision-ledger-shaped theme (question / rationale) folded from
 * feedback, anchored to the surface coordinates it touches and carrying its
 * candidate resolutions. Gated by provenance: `suggested` until a human accepts.
 */
export interface Issue {
	id: string
	/** The decision the issue poses (decision-ledger `question` shape). */
	question: string
	/** Short human label for the theme. */
	title: string
	/** Why this is one issue — the rationale that folds the feedback together. */
	rationale: string
	/** Every surface coordinate the folded feedback pointed at (deduped). */
	targets: ReviewTarget[]
	/** The feedback ids folded in — traceability back to the raw signal. */
	feedbackIds: string[]
	/** The review gate: `suggested` until a human accepts (never auto-applied). */
	provenance: Provenance
	/** The most severe folded feedback kind — drives priority, derived not trusted. */
	severity: SeverityKind
	/** Clustering's confidence this is a real, coherent theme (0..1). */
	confidence: number
	/** Candidate resolutions, typed as the existing change union (each → a costWeight). */
	candidates: ExampleChange[]
}

/**
 * What the AI (or a baseline) proposes for one cluster — the model's job is the
 * *theming and the candidate changes*; the loop overrides `targets`/`severity`
 * from the real feedback, so a model can't inflate reach or urgency.
 */
export interface ProposedCluster {
	title: string
	question: string
	rationale: string
	/** The feedback folded into this cluster, by id. */
	feedbackIds: string[]
	/** Optional model confidence; defaults to a neutral 0.5 when absent. */
	confidence?: number
	/** Candidate changes that would resolve the theme. */
	candidates: ExampleChange[]
}

/** The clustering seam — an `AiClient`-backed fold in prod, a pure fn in tests. */
export type ClusterFn = (
	feedback: readonly Feedback[],
) => Promise<ProposedCluster[]> | ProposedCluster[]

// ===========================================================================
// Deterministic baseline — cluster by shared target coordinate
// ===========================================================================

/**
 * The baseline clusterer: feedback pointing at the *same* {@link ReviewTarget}
 * is the same issue. Deterministic and offline — the honest floor the AI has to
 * beat, and the fallback when no model is wired. Groups appear in first-seen
 * order; it proposes no candidates (only a human/AI can say *how* to fix it).
 */
export function groupByTarget(
	feedback: readonly Feedback[],
): ProposedCluster[] {
	const groups = new Map<string, Feedback[]>()
	for (const f of feedback) {
		const key = targetKey(f.target)
		const hit = groups.get(key)
		if (hit) hit.push(f)
		else groups.set(key, [f])
	}
	return [...groups.values()].map((group) => {
		const first = group[0] as Feedback
		return {
			title: `Feedback on ${targetKey(first.target)}`,
			question: `What should we do about ${targetKey(first.target)}?`,
			rationale: `${group.length} piece(s) of feedback point at this coordinate.`,
			feedbackIds: group.map((f) => f.id),
			candidates: [],
		}
	})
}

// ===========================================================================
// AI clusterer — the real Cluster step, gated behind explicit invocation
// ===========================================================================
//
// `aiClusterFn` is the {@link ClusterFn} a caller wires up for an *explicit*
// "cluster feedback" action (a CLI command, an MCP tool, a workbench button —
// never a per-feedback-event trigger; see the module note). It asks the model
// for themes + candidate changes as JSON and parses the response defensively:
// malformed JSON, an unparseable shape, or a candidate this parser doesn't
// recognize never throws — it degrades to fewer/no candidates rather than
// corrupting the queue. `clusterFeedback`'s own anti-inflation fold (real
// `targets`/`severity` from the folded feedback, hallucinated ids dropped)
// still runs on top of this, so a bad completion can't lie about reach either.
//
// Candidate vocabulary the model may propose is deliberately narrow — the same
// restraint `heuristicPropose` (the workbench's Propose fallback) already
// documents: no fabricated spec ops. Two kinds parse:
//   - `off-surface` (any resource/resolution) — always safe, never mutates.
//   - `spec-op` via `prd.addRequirement` — turns a demand signal into a new
//     backlog requirement suggestion. It is the one additive op that can
//     honestly represent *any* product ask without guessing at entity/page
//     shape, and `validateOp` (run again at Land time) rejects a bad one
//     before it ever reaches the spec, so this is safe to let the model author
//     directly. The requirement id/`acceptanceCriteria`/`priority` are
//     sanitized here rather than trusted verbatim.

const REQUIREMENT_ID_RE = /^r-[a-z0-9-]+$/
const PRIORITIES: ReadonlySet<Requirement['priority']> = new Set([
	'P0',
	'P1',
	'P2',
	'P3',
])

/** A loosely-typed JSON candidate as the model might emit it. */
interface RawCandidate {
	id?: unknown
	description?: unknown
	kind?: unknown
	resource?: unknown
	resolution?: unknown
	requirement?: {
		id?: unknown
		userStory?: unknown
		acceptanceCriteria?: unknown
		priority?: unknown
	}
}

interface RawCluster {
	title?: unknown
	question?: unknown
	rationale?: unknown
	feedbackIds?: unknown
	confidence?: unknown
	candidates?: unknown
}

/** Sanitize one candidate into a {@link ExampleChange}, or drop it (`null`)
 *  when it doesn't match the narrow vocabulary above. `slot` is deterministic
 *  (cluster index + candidate index) so re-parsing the same completion is
 *  idempotent regardless of what (if anything) the model put in `id`. */
function coerceCandidate(raw: unknown, slot: string): ExampleChange | null {
	if (typeof raw !== 'object' || raw === null) return null
	const c = raw as RawCandidate
	const description =
		typeof c.description === 'string' && c.description.trim()
			? c.description
			: `Candidate ${slot}`

	if (c.kind === 'off-surface') {
		const resolution =
			c.resolution === 'eject' ? 'eject' : ('unexpressible' as const)
		return {
			id: `cand-${slot}`,
			description,
			kind: 'off-surface',
			resource:
				typeof c.resource === 'string' && c.resource ? c.resource : slot,
			resolution,
		}
	}

	if (c.kind === 'spec-op') {
		const req = c.requirement
		if (!req) return null
		const rawId = typeof req.id === 'string' ? req.id : ''
		const id = REQUIREMENT_ID_RE.test(rawId) ? rawId : `r-issue-${slot}`
		const userStory =
			typeof req.userStory === 'string' && req.userStory.trim()
				? req.userStory
				: description
		const acceptanceCriteria = Array.isArray(req.acceptanceCriteria)
			? req.acceptanceCriteria.filter((x): x is string => typeof x === 'string')
			: []
		const priority = PRIORITIES.has(req.priority as Requirement['priority'])
			? (req.priority as Requirement['priority'])
			: 'P2'
		const requirement: Requirement = {
			id: id as Requirement['id'],
			userStory,
			acceptanceCriteria:
				acceptanceCriteria.length > 0 ? acceptanceCriteria : [userStory],
			priority,
			edgeCasesAndErrorStates: [],
		}
		return {
			id: `cand-${slot}`,
			description,
			kind: 'spec-op',
			via: 'apply-op',
			op: { op: 'prd.addRequirement', args: { requirement } },
		}
	}

	return null
}

/** Parse one raw cluster entry, or `null` if it's too malformed to use
 *  (missing the fields `clusterFeedback` needs to fold it). */
function coerceCluster(raw: unknown, index: number): ProposedCluster | null {
	if (typeof raw !== 'object' || raw === null) return null
	const c = raw as RawCluster
	if (typeof c.title !== 'string' || typeof c.question !== 'string') return null
	const feedbackIds = Array.isArray(c.feedbackIds)
		? c.feedbackIds.filter((x): x is string => typeof x === 'string')
		: []
	if (feedbackIds.length === 0) return null
	const candidatesRaw = Array.isArray(c.candidates) ? c.candidates : []
	const candidates = candidatesRaw
		.map((raw, i) => coerceCandidate(raw, `${index + 1}-${i + 1}`))
		.filter((x): x is ExampleChange => x !== null)
	const confidence =
		typeof c.confidence === 'number' && Number.isFinite(c.confidence)
			? c.confidence
			: undefined
	return {
		title: c.title,
		question: c.question,
		rationale: typeof c.rationale === 'string' ? c.rationale : '',
		feedbackIds,
		confidence,
		candidates,
	}
}

/**
 * Parse a model completion into {@link ProposedCluster}s. Exported standalone
 * so the parsing/sanitizing logic is unit-testable without an `AiClient`.
 * Never throws: an unparseable or non-array response yields `[]`, which
 * `clusterFeedback` treats as "no themes found" rather than an error — a
 * flaky completion degrades the suggestion, it never breaks the queue.
 */
export function parseAiClusters(text: string): ProposedCluster[] {
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		// Models sometimes wrap JSON in prose despite instructions; try to pull
		// out the first top-level array as a last resort.
		const match = /\[[\s\S]*\]/.exec(text)
		if (!match) return []
		try {
			parsed = JSON.parse(match[0])
		} catch {
			return []
		}
	}
	if (!Array.isArray(parsed)) return []
	return parsed
		.map((raw, i) => coerceCluster(raw, i))
		.filter((x): x is ProposedCluster => x !== null)
}

/** The prompt: every feedback item as a short labeled line, plus the exact
 *  output contract the parser above accepts. Deliberately terse — the model
 *  doesn't need prose, it needs the raw signal and a strict schema. */
function buildClusterPrompt(feedback: readonly Feedback[]): string {
	const lines = feedback.map(
		(f) =>
			`- id=${f.id} kind=${f.kind} target=${targetKey(f.target)} body=${JSON.stringify(f.body)}`,
	)
	return [
		'Group the following feedback items into themes ("issues"). Each item',
		'may belong to at most one theme; drop items that are too singular to',
		'theme (a theme needs at least one feedbackId).',
		'',
		...lines,
		'',
		'Return a JSON array (no markdown fences, no commentary) of:',
		'{ title, question, rationale, feedbackIds: string[], confidence?: number,',
		'  candidates: Array<',
		'    { kind: "off-surface", description, resource, resolution: "eject"|"unexpressible" } |',
		'    { kind: "spec-op", description, requirement: { id: "r-...", userStory, acceptanceCriteria: string[], priority: "P0"|"P1"|"P2"|"P3" } }',
		'  > }',
		'`requirement` proposes a new backlog requirement addressing the theme —',
		'use it for actionable asks; use off-surface when there is no reasonable',
		'spec-level resolution.',
	].join('\n')
}

/**
 * The real Cluster step: an {@link AiClient}-backed `ClusterFn`. Callers must
 * gate invocation explicitly (never wire this to run on every captured
 * `Feedback` — see the module note); `groupByTarget` remains the always-on
 * baseline used everywhere this isn't wired in.
 */
export function aiClusterFn(ai: AiClient): ClusterFn {
	return async (feedback) => {
		if (feedback.length === 0) return []
		const text = await ai.complete({
			generator: 'feedback-cluster',
			key: 'cluster',
			prompt: buildClusterPrompt(feedback),
		})
		return parseAiClusters(text)
	}
}

// ===========================================================================
// Fold — proposals + real feedback → gated Issues
// ===========================================================================

/** Severity rank of a feedback kind, via the shared {@link SEVERITY_WEIGHTS}. */
function severityRank(kind: Feedback['kind']): number {
	return SEVERITY_WEIGHTS[kind]
}

/** The most severe kind across a set of feedback (bug > confusion > request >
 *  praise). Empty defaults to `request` — the lowest actionable rung. */
function peakSeverity(feedback: readonly Feedback[]): SeverityKind {
	let best: SeverityKind = 'request'
	let bestRank = -1
	for (const f of feedback) {
		const r = severityRank(f.kind)
		if (r > bestRank) {
			bestRank = r
			best = f.kind
		}
	}
	return best
}

/** Dedupe targets by their stable key, preserving first-seen order. */
function dedupeTargets(feedback: readonly Feedback[]): ReviewTarget[] {
	const seen = new Set<string>()
	const out: ReviewTarget[] = []
	for (const f of feedback) {
		const key = targetKey(f.target)
		if (seen.has(key)) continue
		seen.add(key)
		out.push(f.target)
	}
	return out
}

/**
 * The Propose seam — turn one cluster's folded feedback into candidate changes.
 * Only consulted when the clusterer itself proposed none (the AI usually does;
 * the deterministic baseline does not), so AI candidates always win.
 */
export type ProposeFn = (folded: readonly Feedback[]) => ExampleChange[]

export interface ClusterOptions {
	/** The clustering fold — defaults to the {@link groupByTarget} baseline. */
	cluster?: ClusterFn
	/** Fallback Propose step for clusters that carry no candidates of their own. */
	propose?: ProposeFn
	/** Deterministic id prefix; the loop appends a 1-based index. */
	idPrefix?: string
}

/**
 * Cluster feedback into gated {@link Issue}s. AI-proposed clusters are trusted
 * for *theming and candidates* only; `targets` and `severity` are recomputed
 * here from the real folded feedback. Each issue enters `suggested` — the human
 * gate is a hard precondition of landing, never bypassed. Async because a real
 * {@link ClusterFn} calls a model; pure given a pure `cluster`.
 */
export async function clusterFeedback(
	feedback: readonly Feedback[],
	options: ClusterOptions = {},
): Promise<Issue[]> {
	const cluster = options.cluster ?? groupByTarget
	const prefix = options.idPrefix ?? 'issue'
	const byId = new Map(feedback.map((f) => [f.id, f]))
	const proposals = await cluster(feedback)

	return proposals.map((p, i) => {
		// Resolve the folded feedback from ids — silently drop ids the model
		// hallucinated (they can't inflate reach if they don't resolve).
		const folded = p.feedbackIds
			.map((id) => byId.get(id))
			.filter((f): f is Feedback => f !== undefined)
		// AI candidates win; the Propose fallback only fills an empty proposal.
		const candidates =
			p.candidates.length > 0 ? p.candidates : (options.propose?.(folded) ?? [])
		return {
			id: `${prefix}-${i + 1}`,
			question: p.question,
			title: p.title,
			rationale: p.rationale,
			targets: dedupeTargets(folded),
			feedbackIds: folded.map((f) => f.id),
			provenance: suggested({ suggestedDescription: p.title }),
			severity: peakSeverity(folded),
			confidence: p.confidence ?? 0.5,
			candidates,
		}
	})
}

// ===========================================================================
// Gate — reuse the provenance suggested → accepted machine
// ===========================================================================

/**
 * A *stable* identity for an issue — the sorted set of coordinates it covers,
 * NOT its positional `id`. Re-clustering the same feedback yields the same key,
 * so a persisted triage decision (accept/reject) survives a reload even though
 * `issue-1` might be a different theme next time. The empty-target degenerate
 * case (an issue that folded only unresolvable feedback) falls back to the id.
 */
export function issueKey(issue: Issue): string {
	if (issue.targets.length === 0) return `id:${issue.id}`
	return issue.targets
		.map((t) => targetKey(t))
		.sort()
		.join('|')
}

/** The issue's review state, derived from its provenance (never stored twice). */
export function issueState(issue: Issue): ProvenanceState {
	return deriveProvenanceState(issue.provenance)
}

/** Accept an issue — its candidates become landable. Immutable. */
export function acceptIssue(issue: Issue): Issue {
	return { ...issue, provenance: accept(issue.provenance) }
}

/** Soft-reject an issue (never a delete — matches provenance discipline). */
export function rejectIssue(issue: Issue): Issue {
	return { ...issue, provenance: reject(issue.provenance) }
}

// ===========================================================================
// Bridge — Issue candidates → priority queue (feeds computePriority, #10)
// ===========================================================================

/**
 * Explode an issue's candidate changes into {@link PriorityCandidate}s for the
 * queue: `reach` is the folded feedback count (the demand proxy), `severity`
 * and `confidence` inherit from the issue. One candidate change → one row, so a
 * cheap resolution and an expensive one for the *same* demand compete honestly
 * (the moat weight decides).
 */
export function issueToCandidates(issue: Issue): PriorityCandidate[] {
	return issue.candidates.map((change) => ({
		id: `${issue.id}:${change.id}`,
		change,
		reach: issue.feedbackIds.length,
		severity: issue.severity,
		confidence: issue.confidence,
	}))
}

/**
 * The candidates eligible to *land*: only those from **accepted** issues — the
 * human gate, enforced structurally. Suggested/rejected issues never reach
 * `apply_spec_change`, no matter how they rank.
 */
export function landableCandidates(
	issues: readonly Issue[],
): PriorityCandidate[] {
	return issues
		.filter((issue) => issueState(issue) === 'accepted')
		.flatMap(issueToCandidates)
}
