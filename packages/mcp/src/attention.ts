/**
 * What needs the maintainer, in order.
 *
 * The workbench is "a set of panels rather than a place". Eleven panes stacked
 * down a page is not a working surface — it is eleven things to check, in
 * declaration order, with no answer to the only question a maintainer actually
 * arrives with: **what should I look at first?**
 *
 * This is that answer, as data. One ordered list, worst first, each item naming
 * what it is, why it is above the next one, and where to go. The browser renders
 * it at the top of the page; `maxstack review` prints it; the `workbench` MCP
 * tool returns it. Three renderers, one ordering — because a "most important
 * thing" that differs by surface is not a most important thing.
 *
 * ## The ordering is the product
 *
 * Panes can be reordered by taste. This ranking cannot: it encodes which
 * mistakes are unrecoverable.
 *
 *   1. **Public exposure that changed** — the only category where the damage is
 *      done the instant it lands and cannot be taken back. Data that reached the
 *      internet has reached it.
 *   2. **Removals** — a dropped column is dropped data.
 * 3. **Proposals that cannot be batched** — the ones a reviewer would
 *      otherwise clear without reading.
 *   4. **Latent exposure** — declared-but-not-live public surfaces. One op from
 * category 1, with no review standing between.
 * 5. **Drift on owned files** — the platform has moved underneath code
 *      it is not allowed to touch.
 *   6. **Everything else** — routine proposals, upgrades, stale flags.
 *
 * Nothing here is a *count*. "17 pending" is not attention, it is a number; the
 * report names the specific rows, because a maintainer cannot act on a badge.
 *
 * ## Host-supplied facts
 *
 * Drift and module upgrades are disk facts, so they arrive as inputs rather than
 * being computed here — the same pattern as `PlatformContext.ownership`, and for
 * the same reason: this layer has a spec and nothing else. A host that cannot
 * supply one gets a report without that category rather than a wrong one, and
 * says so in `unavailable` so the absence is visible instead of looking like
 * "nothing to worry about".
 */

import {
	applyOp,
	classifyReviewRisk,
	type OpId,
	type PendingProposal,
	pendingProposals,
	type RiskContext,
	type SpecSystem,
} from '@maxstack/spec'
import {
	type BlastRadius,
	blastRadius,
	latentExposure,
} from './blast-radius.ts'

// ===========================================================================
// Types
// ===========================================================================

/**
 * Why an item is where it is. The order of this list IS the priority order —
 * `RANK` is derived from it, so adding a category means deciding its severity.
 */
export const ATTENTION_KINDS = [
	'public-change',
	'removal',
	'unbatchable',
	'latent-exposure',
	'drift',
	'routine',
] as const

export type AttentionKind = (typeof ATTENTION_KINDS)[number]

export interface AttentionItem {
	kind: AttentionKind
	/** Stable key, so a host can link to it and a test can name it. */
	id: string
	/** What it is, in one line a maintainer can act on. */
	title: string
	/** Why it outranks what follows — shown, not implied. */
	because: string
	/** Where to go: a review target, a file, a portal key. */
	where: string | null
}

export interface AttentionReport {
	items: AttentionItem[]
	/**
	 * Categories this host could not evaluate, named. An empty report from a host
	 * that cannot see drift must not read as "no drift".
	 */
	unavailable: string[]
	/**
	 * One sentence *about* the list — never a copy of a line inside it.
	 *
	 * This used to be `items[0].title` verbatim, which meant all three renderers
	 * printed the same sentence twice in a row: once as the headline, once as the
	 * first item under it. It read as a bug because it was one. The headline's job
	 * is the shape of the queue — how bad the worst thing is and how much is behind
	 * it — and the list's job is the specifics. {@link headlineFor} is derived from
	 * `kind` and counts only; it never reads a `title`, so the duplication cannot
	 * come back by someone rewording a category.
	 */
	headline: string
	/** Total pending proposals, for context under the named items — never instead of them. */
	pending: number
}

/** The disk facts a host can supply. Every field optional; absence is reported. */
export interface AttentionInputs {
	risk?: RiskContext
	/** Owned files that have drifted from their derivation. */
	drift?: readonly { id: string; file: string; drifted: boolean }[]
	/** Installed bundles with an upgrade available. */
	upgrades?: readonly { slug: string; from: string; to: string }[]
	/**
	 * The spec as it would be if every pending proposal were accepted.
	 *
	 * When present, public-boundary and removal effects are reported *before* the
	 * reviewer decides — the whole point of putting them at rank 1.
	 *
	 * An input rather than always computed, so a host can pass a narrower
	 * projection (one proposal, one group) and get the same ranking over it.
	 * {@link specIfAllAccepted} builds the everything-pending case, and a host that
	 * passes nothing is told the category went unevaluated rather than being shown a
	 * clean public-exposure result it did not earn.
	 */
	ifAccepted?: SpecSystem
}

const RANK = new Map<AttentionKind, number>(
	ATTENTION_KINDS.map((kind, i) => [kind, i]),
)

/**
 * The spec as it would be if every pending proposal were accepted.
 *
 * Computed here rather than asked of the host because it is pure spec work: apply
 * `provenance.review accept` for each pending row, in memory, and never save. The
 * result is only ever *read* — it is the `after` side of a blast radius, which is
 * the whole reason the reviewer can see consequences before consenting to them.
 *
 * A row whose accept the op validator refuses is skipped rather than throwing:
 * `portal` is not a reviewable target kind today, so a pending portal is
 * absent from this projection. That is honest — accepting it genuinely is not
 * possible — but it does mean the public-exposure category cannot yet warn about a
 * *proposed* portal, only about un-pausing an accepted one. #248 closes that.
 */
export function specIfAllAccepted(
	spec: SpecSystem,
	context: RiskContext = {},
): SpecSystem {
	let next = spec
	let n = 0
	for (const proposal of pendingProposals(spec, context)) {
		try {
			next = applyOp(
				next,
				{
					op: 'provenance.review',
					args: { target: proposal.target, action: 'accept' },
				},
				{
					id: `op-hypothetical-${++n}` as OpId,
					origin: 'human',
					appliedAt: '1970-01-01',
					// Named as a projection so that if one of these ever reached a real op
					// log, the trail would say what it was rather than looking like a
					// review somebody performed.
					actor: { surface: 'mcp', path: 'attention-hypothetical' },
				},
			)
		} catch {
			// Unreviewable kind. Skipped, not fatal — see the docblock.
		}
	}
	return next
}

// ===========================================================================
// The fold
// ===========================================================================

/** The blast radius of accepting everything pending, when the host can say. */
function pendingEffect(
	spec: SpecSystem,
	inputs: AttentionInputs,
): BlastRadius | null {
	return inputs.ifAccepted ? blastRadius(spec, inputs.ifAccepted) : null
}

function exposureItems(effect: BlastRadius | null): AttentionItem[] {
	if (!effect) return []
	const crossing = [
		...effect.added,
		...effect.changed.map((c) => c.surface),
	].filter((s) => s.kind === 'public-field' || s.kind === 'public-write')
	return crossing.map((surface) => ({
		kind: 'public-change' as const,
		id: `attention:${surface.id}`,
		title: `${surface.label} if you accept what is pending`,
		because:
			'this is the only category that cannot be undone — data that reaches the internet has reached it',
		where: surface.detail,
	}))
}

function removalItems(effect: BlastRadius | null): AttentionItem[] {
	if (!effect) return []
	return effect.removed.map((surface) => ({
		kind: 'removal' as const,
		id: `attention:removed:${surface.id}`,
		title: `${surface.label} STOPS EXISTING if you accept what is pending`,
		because:
			'a dropped column is dropped data, and no amount of "it was only a spec edit" changes that',
		where: surface.id,
	}))
}

function unbatchableItems(
	proposals: readonly PendingProposal[],
): AttentionItem[] {
	return proposals
		.filter((p) => !p.risk.batchable)
		.map((p) => ({
			kind: 'unbatchable' as const,
			id: `attention:proposal:${p.target.kind}:${p.target.id}`,
			title: `${p.label} (${p.target.kind}) needs an individual decision`,
			because:
				p.risk.findings[0]?.reason ??
				'the risk model will not clear this in a batch at any size',
			where: p.target.id,
		}))
}

function latentItems(spec: SpecSystem): AttentionItem[] {
	return latentExposure(spec).map((latent) => ({
		kind: 'latent-exposure' as const,
		id: `attention:latent:${latent.key}`,
		title: `the \`${latent.key}\` portal publishes ${latent.fields} field${latent.fields === 1 ? '' : 's'} the moment it goes live`,
		because: latent.reason,
		where: latent.key,
	}))
}

function driftItems(inputs: AttentionInputs): AttentionItem[] {
	return (inputs.drift ?? [])
		.filter((d) => d.drifted)
		.map((d) => ({
			kind: 'drift' as const,
			id: `attention:drift:${d.id}`,
			title: `${d.file} has drifted from what the platform would generate`,
			because:
				'you own this file, so the platform will not update it for you — the divergence is silent until you look',
			where: d.file,
		}))
}

function routineItems(
	proposals: readonly PendingProposal[],
	inputs: AttentionInputs,
): AttentionItem[] {
	const out: AttentionItem[] = []
	const batchable = proposals.filter((p) => p.risk.batchable)
	if (batchable.length > 0) {
		// One item for the whole batchable set, deliberately: these are the rows the
		// surface exists to make cheap, and listing them individually here would put
		// the routine majority back in the reviewer's way.
		out.push({
			kind: 'routine',
			id: 'attention:batchable',
			title: `${batchable.length} routine proposal${batchable.length === 1 ? '' : 's'} can be cleared in a batch`,
			because:
				'nothing in this set touches access control, exposure, or code you own',
			where: null,
		})
	}
	for (const upgrade of inputs.upgrades ?? []) {
		out.push({
			kind: 'routine',
			id: `attention:upgrade:${upgrade.slug}`,
			title: `${upgrade.slug} can upgrade ${upgrade.from} → ${upgrade.to}`,
			because:
				'an upgrade you have not taken is a decision deferred, not avoided',
			where: upgrade.slug,
		})
	}
	return out
}

/**
 * Assemble the ordered report.
 *
 * `spec` is the project as it stands. Everything a host cannot answer is named in
 * `unavailable` rather than silently omitted, because on this surface an absent
 * category and an empty category look identical and mean opposite things.
 */
export function attentionReport(
	spec: SpecSystem,
	inputs: AttentionInputs = {},
): AttentionReport {
	// No risk context means unknown ownership, which #199's model reads as "assume
	// everything is owned" — so proposals come back unbatchable and land in the
	// unbatchable category. That is the conservative direction, and it is why the
	// absence is also reported.
	const proposals = pendingProposals(spec, inputs.risk ?? {})
	const effect = pendingEffect(spec, inputs)

	const items = [
		...exposureItems(effect),
		...removalItems(effect),
		...unbatchableItems(proposals),
		...latentItems(spec),
		...driftItems(inputs),
		...routineItems(proposals, inputs),
	].sort((a, b) => {
		const rank = (RANK.get(a.kind) ?? 99) - (RANK.get(b.kind) ?? 99)
		return rank !== 0 ? rank : a.id.localeCompare(b.id)
	})

	const unavailable: string[] = []
	if (!inputs.risk?.ownershipKnown) {
		unavailable.push(
			'ownership — nobody could tell us which files you own, so every proposal is treated as needing individual review',
		)
	}
	if (!inputs.drift) {
		unavailable.push('drift — this host cannot read the filesystem')
	}
	if (!inputs.ifAccepted) {
		unavailable.push(
			'the effect of accepting what is pending — this host did not supply the hypothetical spec, so public-exposure and removal effects are not evaluated',
		)
	}
	if (!inputs.upgrades) {
		unavailable.push('module upgrades — this host has no catalog wired')
	}

	return {
		items,
		unavailable,
		headline: headlineFor(items, unavailable),
		pending: proposals.length,
	}
}

/**
 * What the worst category *is*, in one clause, with its own count.
 *
 * Written per kind rather than lifted from the item, because the headline and the
 * item answer different questions: the item says which row, the headline says what
 * kind of trouble this is. Sharing a string between them is what produced the
 * duplicate line.
 */
const BAND: Record<AttentionKind, (n: number) => string> = {
	'public-change': (n) =>
		`${n} change${n === 1 ? '' : 's'} would put data on the public internet, and that is the one category you cannot take back`,
	removal: (n) =>
		`${n} thing${n === 1 ? '' : 's'} STOP EXISTING if you accept what is pending`,
	unbatchable: (n) =>
		`${n} proposal${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} an individual decision — they will not clear in a batch at any size`,
	'latent-exposure': (n) =>
		`${n} portal${n === 1 ? '' : 's'} ${n === 1 ? 'is' : 'are'} one op from publishing data`,
	drift: (n) =>
		`${n} file${n === 1 ? '' : 's'} you own ${n === 1 ? 'has' : 'have'} drifted from what the platform would generate`,
	// The only band with no count. Routine is the last rank, so it is the top item
	// only when everything is routine — and the routine *item* is itself a
	// collapsed batch ("5 proposals can be cleared"), so counting items here would
	// print "1 routine item" directly above a line that says five. The list below
	// carries the number; this carries the fact that none of it is urgent.
	routine: () => 'nothing urgent — only routine items, listed below',
}

/**
 * One sentence for the top of the surface, *about* the report rather than in it.
 *
 * Three properties, each of which has been wrong at some point:
 *
 *   - **It is not the first item.** It names the worst category and how much sits
 *     behind it; the list underneath names the rows. A headline that restates its
 *     own first line teaches the reader to skip one of them, and they will pick
 *     the wrong one.
 *   - **It is not a bare count.** "17 pending" is a number, not attention — the
 *     count only ever appears qualified by which category it is counting.
 *   - **An all-clear is only stated when the report is actually complete.** A host
 *     that could not evaluate half the categories says so instead, because
 *     "nothing needs you" from a surface that could not look is the most
 *     misleading sentence this code could produce — and that applies to a
 *     *non-empty* report too, so the unchecked count rides along there as well.
 */
function headlineFor(
	items: readonly AttentionItem[],
	unavailable: readonly string[],
): string {
	const gap =
		unavailable.length > 0
			? ` (${unavailable.length} categor${unavailable.length === 1 ? 'y' : 'ies'} could not be checked)`
			: ''
	const first = items[0]
	if (!first) {
		if (unavailable.length > 0)
			return `Nothing found in the categories this host can evaluate — ${unavailable.length} could not be checked.`
		return 'Nothing needs you: no pending proposals, no drift, no latent exposure.'
	}
	const top = items.filter((i) => i.kind === first.kind).length
	const rest = items.length - top
	const behind = rest > 0 ? `, then ${rest} more below` : ''
	// Capitalised here rather than in each band, so the bands stay composable
	// clauses instead of sentences that only work in first position.
	const band = BAND[first.kind](top)
	return `${band.charAt(0).toUpperCase()}${band.slice(1)}${behind}${gap}.`
}

/**
 * Re-exported so a host rendering one item can explain a single proposal without
 * reaching past this module for the risk model.
 */
export { classifyReviewRisk }
