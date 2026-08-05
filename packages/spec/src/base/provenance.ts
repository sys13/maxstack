/**
 * Provenance base columns + the two invariants.
 *
 * Source: reference spec `docs/reference-specs/provenance.md` (from bbai_prd,
 * gen 6). The universal grammar of the platform (§4): everything AI produces
 * lands as a *suggestion* with visible provenance; humans accept, reject, or
 * edit. These flags + the two invariants are settled decisions (§0 rule 2) and
 * live in the base spec types from day one (§3-L1) — mixed into every entity of
 * every layer, not bolted onto each layer later.
 *
 * The original duplicated the invariants across nine generators with no test
 * coverage; per the decision-#13 lift-vs-reimplement call we reimplement them as
 * ONE `getAcceptedOrAll` helper + ONE regen-partition helper here.
 *
 * Two deliberate cleanups over the original (documented in the reference spec's
 * "edge cases", where it explicitly leaves these to the reimplementation):
 *   - An undecided suggestion carries `isAccepted: null` (the column's stated
 *     meaning) rather than the original's `false`; `false` is reserved for an
 *     explicit soft-reject. This keeps "undecided" and "rejected" distinct for
 *     the UI while preserving grounding behaviour (neither grounds).
 *   - `autoAccept` is NOT a per-item column. It is a per-project policy
 *     (`AutoAcceptPolicy`), matching the original where it lives on the PRD row.
 */

import { z } from 'zod'

// ===========================================================================
// The base columns
// ===========================================================================

export type ProvenancePriority = 'medium' | 'high'

/**
 * The provenance base columns, mixed into every spec entity via
 * {@link Provenanced}. Mirrors bbai_prd `standardFields`.
 */
export interface Provenance {
	/** Came from AI or a template. `true` for suggestions, `false` for manual. */
	isSuggested: boolean
	/** `null` = undecided; `true` = accepted; `false` = soft-rejected (not deleted). */
	isAccepted: boolean | null
	/** `true` marks a human-created row — the never-delete signal for regen. */
	isAddedManually: boolean | null
	/** The AI draft, held separately from the accepted text. */
	suggestedDescription: string | null
	/** Used by the "prioritize" action. */
	priority: ProvenancePriority
}

/** Anything carrying provenance — the mixin every layer's entities satisfy. */
export interface Provenanced {
	provenance: Provenance
}

/**
 * The single display state derived from the flags — never stored, so a label
 * can't drift from the columns (same discipline as PRD `deriveSeverity`).
 */
export type ProvenanceState = 'suggested' | 'accepted' | 'rejected' | 'manual'

export function deriveProvenanceState(p: Provenance): ProvenanceState {
	if (p.isAddedManually === true) return 'manual'
	if (p.isAccepted === true) return 'accepted'
	if (p.isAccepted === false) return 'rejected'
	return 'suggested'
}

// ===========================================================================
// Per-project policy (NOT per-item)
// ===========================================================================

export interface AutoAcceptPolicy {
	/** When true, generated suggestions land already accepted and immediately count as grounding. */
	autoAccept: boolean
}

export const DEFAULT_AUTO_ACCEPT = false

// ===========================================================================
// Factories — how a row enters the world
// ===========================================================================

/**
 * Provenance for a generator insert (a suggestion). With `autoAccept` on it
 * lands already accepted; otherwise it is undecided (`isAccepted: null`).
 * Mirrors the original's generator insert (`isAddedManually: false`).
 */
export function suggested(
	opts: {
		autoAccept?: boolean
		suggestedDescription?: string
		priority?: ProvenancePriority
	} = {},
): Provenance {
	return {
		isSuggested: true,
		isAccepted: opts.autoAccept === true ? true : null,
		isAddedManually: false,
		suggestedDescription: opts.suggestedDescription ?? null,
		priority: opts.priority ?? 'medium',
	}
}

/**
 * Provenance for a manual add: accepted and protected from regeneration.
 * Mirrors `add-item.ts` (`isAccepted: true, isAddedManually: true`).
 */
export function manual(
	opts: { priority?: ProvenancePriority } = {},
): Provenance {
	return {
		isSuggested: false,
		isAccepted: true,
		isAddedManually: true,
		suggestedDescription: null,
		priority: opts.priority ?? 'medium',
	}
}

// ===========================================================================
// Transitions — all immutable (return a new Provenance)
// ===========================================================================

/** Accept a suggestion. `isSuggested` is left unchanged (matches the original). */
export function accept(p: Provenance): Provenance {
	return { ...p, isAccepted: true }
}

/** Soft-reject: flag `isAccepted = false`, never a delete. `isSuggested` unchanged. */
export function reject(p: Provenance): Provenance {
	return { ...p, isAccepted: false }
}

/**
 * Take a decision back: return a settled row to *undecided* (`isAccepted: null`),
 * which is the state a suggestion arrives in. The undo half of accept/reject
 * (an accepted batch has to be reversible before it is generated).
 *
 * This is why `isAccepted: null` and `false` were kept distinct rather than
 * collapsed the way the original generation did (see the module note): with one
 * boolean there would be no state to return *to*, and "undo an accept" would be
 * indistinguishable from "reject".
 *
 * `isSuggested` and `isAddedManually` are untouched, so a reset row is exactly
 * the suggestion it was before anybody looked at it. Callers must not apply this
 * to a manual row — `applyOp` refuses, because un-deciding a hand-authored row is
 * not an undo and would strip its regen protection.
 */
export function unreview(p: Provenance): Provenance {
	return { ...p, isAccepted: null }
}

/** The "prioritize" action. */
export function prioritize(
	p: Provenance,
	priority: ProvenancePriority,
): Provenance {
	return { ...p, priority }
}

// ===========================================================================
// The two invariants (non-negotiable, §6) — one helper each
// ===========================================================================

/** Is this row currently accepted? Anything not `=== true` counts as not-accepted. */
export function isAccepted(item: Provenanced): boolean {
	return item.provenance.isAccepted === true
}

/** Does this row survive a regeneration? Only manual rows do. */
export function survivesRegen(item: Provenanced): boolean {
	return item.provenance.isAddedManually === true
}

/**
 * Invariant (a): **regeneration never deletes manual items.** Partitions a set
 * into the rows a regenerate would drop (`isAddedManually !== true`) and the
 * rows it must keep. The original duplicated this across nine generators; here
 * it is the one shared helper.
 */
export function partitionForRegen<T extends Provenanced>(
	items: readonly T[],
): { kept: T[]; deleted: T[] } {
	const kept: T[] = []
	const deleted: T[] = []
	for (const item of items) (survivesRegen(item) ? kept : deleted).push(item)
	return { kept, deleted }
}

/**
 * Invariant (b): **generation grounds only on accepted upstream entities** —
 * but the real rule the original implemented (`getAcceptedOrAll`,
 * `modelUtils.ts:299-315`) is *accepted-only, else all*: return accepted rows,
 * falling back to every row only when zero rows are accepted.
 */
export function getAcceptedOrAll<T extends Provenanced>(
	items: readonly T[],
): T[] {
	const accepted = items.filter(isAccepted)
	return accepted.length > 0 ? accepted : [...items]
}

// ===========================================================================
// Runtime validation
// ===========================================================================

export const provenanceSchema = z.object({
	isSuggested: z.boolean(),
	isAccepted: z.boolean().nullable(),
	isAddedManually: z.boolean().nullable(),
	suggestedDescription: z.string().nullable(),
	priority: z.enum(['medium', 'high']),
}) satisfies z.ZodType<Provenance>

// ===========================================================================
// On-disk codec — collapse the five columns into one short field
// ===========================================================================
//
// Every stored row carried the full 5-key {@link Provenance} object, and every
// `add` op re-inlined it a second time in the op log — the single biggest source
// of bloat in a real `spec.json` (the manual-add default alone is ~180 bytes of
// identical JSON per field/entity/page/block). The vast majority of rows are one
// of four canonical shapes, so on disk we encode the `(isSuggested, isAccepted,
// isAddedManually)` triple as a one-letter *code* and only fall back to the full
// object for a genuinely unusual combination (lossless escape hatch):
//
//   'm'  manual         — hand-authored, accepted, regen-protected ({@link manual})
//   's'  suggested      — AI draft, undecided ({@link suggested})
//   'a'  accepted       — a suggestion a human accepted
//   'r'  rejected       — a suggestion a human soft-rejected
//
// A row equal to the `manual()` default is *omitted entirely* (decode fills it
// back in). `priority: 'high'` and a non-null `suggestedDescription` ride along
// as the compact object's `pr`/`d` keys. The in-memory {@link Provenance} is
// never touched — this is purely a serialization boundary (see `spec-codec.ts`).

/** The one-letter code for a canonical provenance shape. */
export type ProvenanceCode = 'm' | 's' | 'a' | 'r'

/**
 * The on-disk form of a provenance value: omitted (`undefined`, = `manual()`),
 * a bare code, a code plus non-default extras, or — for a non-canonical triple —
 * the verbatim full object.
 */
export type EncodedProvenance =
	| undefined
	| ProvenanceCode
	| { p: ProvenanceCode; pr?: ProvenancePriority; d?: string }
	| Provenance

/** The `(isSuggested, isAccepted, isAddedManually)` triple → code, or `null`
 * when the combination isn't one of the four canonical shapes. */
function codeForTriple(p: Provenance): ProvenanceCode | null {
	const { isSuggested, isAccepted, isAddedManually } = p
	if (!isSuggested && isAccepted === true && isAddedManually === true)
		return 'm'
	if (isSuggested && isAddedManually === false) {
		if (isAccepted === null) return 's'
		if (isAccepted === true) return 'a'
		if (isAccepted === false) return 'r'
	}
	return null
}

/** The canonical {@link Provenance} a code expands to (priority medium, no draft). */
function provenanceForCode(code: ProvenanceCode): Provenance {
	switch (code) {
		case 'm':
			return manual()
		case 's':
			return suggested()
		case 'a':
			return { ...suggested(), isAccepted: true }
		case 'r':
			return { ...suggested(), isAccepted: false }
	}
}

/**
 * Compact a provenance value for disk. Returns `undefined` when it equals the
 * `manual()` default (the caller omits the key entirely), a bare code for a
 * canonical shape with default extras, a `{ p, pr?, d? }` object when it carries
 * a non-default priority/draft, or the full object for a non-canonical triple.
 */
export function encodeProvenance(p: Provenance): EncodedProvenance {
	const code = codeForTriple(p)
	if (code === null) return { ...p }
	const hasExtras = p.priority !== 'medium' || p.suggestedDescription !== null
	if (!hasExtras) return code === 'm' ? undefined : code
	const out: { p: ProvenanceCode; pr?: ProvenancePriority; d?: string } = {
		p: code,
	}
	if (p.priority !== 'medium') out.pr = p.priority
	if (p.suggestedDescription !== null) out.d = p.suggestedDescription
	return out
}

/** Expand an on-disk provenance value back to the full {@link Provenance}. An
 * absent value is a `manual()` row. */
export function decodeProvenance(e: EncodedProvenance): Provenance {
	if (e === undefined) return manual()
	if (typeof e === 'string') return provenanceForCode(e)
	if ('p' in e && typeof e.p === 'string') {
		return {
			...provenanceForCode(e.p),
			priority: e.pr ?? 'medium',
			suggestedDescription: e.d ?? null,
		}
	}
	// Full-object escape hatch — validated downstream by `provenanceSchema`.
	return e as Provenance
}
