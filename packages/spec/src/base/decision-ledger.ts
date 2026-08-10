/**
 * Decision ledger — append-only record of what was decided and why.
 *
 * Sources: corespec's `decisions` table (question / options / selected /
 * reasoning / status) + aiwf's "locked decisions". Per the **minimum-mechanism
 * rule** (§3-L1) v1 ships the *append-only log only* — a durable record. The
 * locked-decision → merge-request machinery (a signed-off decision forcing
 * dependent changes through a review instead of a silent overwrite) is deferred
 * to v2, entered only if dogfooding shows silent-overwrite is a real, recurring
 * pain. Provenance flags + typed spec-ops + eject already carry ~90% of the
 * safety story.
 *
 * "Append-only" is enforced structurally: every mutation returns a NEW ledger
 * that is a superset-suffix of the old one (see {@link assertAppendOnly}); an
 * entry is never edited in place. Resolving a pending decision appends a second
 * entry with the same {@link DecisionId}; reads take the latest per id.
 */

import type { DecisionId, ISODate } from './ids.ts'

export interface DecisionOption {
	id: string
	description: string
	pros: string[]
	cons: string[]
}

export type DecisionStatus = 'pending' | 'resolved'

/** Who recorded the entry — the decision's own provenance. */
export type DecisionOrigin = 'ai' | 'human'

export interface LedgerEntry {
	id: DecisionId
	question: string
	options: DecisionOption[]
	/** The option the platform recommended, if any. */
	recommendedOptionId?: string
	/** The option chosen; `null` while the decision is still pending. */
	chosenOptionId: string | null
	/** Why — the rationale that makes the log durable rather than a bare choice. */
	rationale: string
	status: DecisionStatus
	/** When it was resolved; `null` while pending. */
	decidedAt: ISODate | null
	origin: DecisionOrigin
	recordedAt: ISODate
}

/** The ledger is an ordered, append-only list. */
export type DecisionLedger = readonly LedgerEntry[]

export const emptyLedger: DecisionLedger = []

// ===========================================================================
// Append-only mutations (all return a new ledger)
// ===========================================================================

/** Append an entry. The one primitive; everything else composes from it. */
export function recordDecision(
	ledger: DecisionLedger,
	entry: LedgerEntry,
): DecisionLedger {
	return [...ledger, entry]
}

/**
 * Resolve a previously-pending decision by appending a `resolved` entry with the
 * same id (append-only: the pending entry is left untouched, preserving the
 * "we hadn't decided yet" history).
 */
export function resolveDecision(
	ledger: DecisionLedger,
	args: {
		id: DecisionId
		chosenOptionId: string
		rationale: string
		decidedAt: ISODate
		recordedAt: ISODate
		origin?: DecisionOrigin
	},
): DecisionLedger {
	const prior = latestEntry(ledger, args.id)
	if (!prior)
		throw new Error(`resolveDecision: no decision "${args.id}" in ledger`)
	if (!prior.options.some((o) => o.id === args.chosenOptionId))
		throw new Error(
			`resolveDecision: "${args.chosenOptionId}" is not an option of "${args.id}"`,
		)
	return recordDecision(ledger, {
		...prior,
		chosenOptionId: args.chosenOptionId,
		rationale: args.rationale,
		status: 'resolved',
		decidedAt: args.decidedAt,
		origin: args.origin ?? prior.origin,
		recordedAt: args.recordedAt,
	})
}

// ===========================================================================
// Reads — latest-wins over the append-only log
// ===========================================================================

/** The most recent entry for a decision id (handles the resolve-append chain). */
export function latestEntry(
	ledger: DecisionLedger,
	id: DecisionId,
): LedgerEntry | undefined {
	for (let i = ledger.length - 1; i >= 0; i--) {
		const entry = ledger[i]
		if (entry?.id === id) return entry
	}
	return undefined
}

/** The effective (latest) entry per distinct decision id, in first-seen order. */
export function effectiveDecisions(ledger: DecisionLedger): LedgerEntry[] {
	const order: DecisionId[] = []
	const seen = new Set<DecisionId>()
	for (const entry of ledger)
		if (!seen.has(entry.id)) {
			seen.add(entry.id)
			order.push(entry.id)
		}
	return order
		.map((id) => latestEntry(ledger, id))
		.filter((e): e is LedgerEntry => !!e)
}

// ===========================================================================
// Invariant guard + validation
// ===========================================================================

/**
 * Assert `next` is an append-only extension of `prev`: identical length-`prev`
 * prefix, only growth at the tail. The spec-ops layer runs this so a bug can
 * never silently rewrite a recorded decision.
 *
 * Entries are compared structurally, not by reference: the guard exists to
 * catch value rewrites, and callers routinely hold clones of the ledger
 * (e.g. `applyOp`'s `structuredClone`), which are never reference-equal.
 *
 * The ledger is the reason it exists, but append-only is not a ledger property:
 * the ownership model rests on the same invariant over the *exports of a user's
 * slot file* (`maxstack slots fill` may only add, never rewrite what someone
 * already wrote — #390). Rather than restate the check there as a bespoke
 * string comparison, the guard is generic over any ordered list and takes a
 * `label` so its message names whichever thing was violated.
 */
export function assertAppendOnly<T>(
	prev: readonly T[],
	next: readonly T[],
	label = 'ledger',
): void {
	if (next.length < prev.length)
		throw new Error(
			`${label} append-only violation: length shrank ${prev.length} -> ${next.length}`,
		)
	for (let i = 0; i < prev.length; i++)
		if (!deepEqual(next[i], prev[i]))
			throw new Error(
				`${label} append-only violation: entry ${i} was rewritten`,
			)
}

/** Structural equality over the JSON-shaped values ledger entries are made of. */
function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true
	if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
	if (Array.isArray(a) !== Array.isArray(b)) return false
	const keys = Object.keys(a)
	if (keys.length !== Object.keys(b).length) return false
	return keys.every((k) =>
		deepEqual(
			(a as Record<string, unknown>)[k],
			(b as Record<string, unknown>)[k],
		),
	)
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Validate a single entry's internal referential integrity. Returns problems. */
export function validateLedgerEntry(entry: LedgerEntry): string[] {
	const errors: string[] = []
	const optionIds = new Set(entry.options.map((o) => o.id))
	if (entry.recommendedOptionId && !optionIds.has(entry.recommendedOptionId))
		errors.push(
			`decision ${entry.id}: recommendedOptionId "${entry.recommendedOptionId}" is not an option`,
		)
	if (entry.chosenOptionId !== null && !optionIds.has(entry.chosenOptionId))
		errors.push(
			`decision ${entry.id}: chosenOptionId "${entry.chosenOptionId}" is not an option`,
		)
	if (entry.status === 'resolved') {
		if (entry.chosenOptionId === null)
			errors.push(`decision ${entry.id}: resolved but no chosenOptionId`)
		if (entry.decidedAt === null)
			errors.push(`decision ${entry.id}: resolved but no decidedAt`)
	}
	if (entry.decidedAt !== null && !ISO_DATE.test(entry.decidedAt))
		errors.push(
			`decision ${entry.id}: decidedAt "${entry.decidedAt}" not YYYY-MM-DD`,
		)
	if (!ISO_DATE.test(entry.recordedAt))
		errors.push(
			`decision ${entry.id}: recordedAt "${entry.recordedAt}" not YYYY-MM-DD`,
		)
	return errors
}

/** Validate every entry in a ledger. Returns the flattened problem list. */
export function validateLedger(ledger: DecisionLedger): string[] {
	return ledger.flatMap(validateLedgerEntry)
}
