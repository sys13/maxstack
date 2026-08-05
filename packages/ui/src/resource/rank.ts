/**
 * Rank keys — the manual ordering a board persists.
 *
 * A rank key is a **decimal fraction written without its `0.`**: the key
 * `"375"` means 0.375, and keys are compared as plain strings. That one choice
 * buys the two properties a drag-to-reorder surface needs and cannot get from an
 * integer `position` column:
 *
 *  1. **A new key always fits between two others.** Between `"3"` and `"4"` sits
 *     `"35"`; between `"35"` and `"4"` sits `"37"`, and so on, forever. Moving a
 *     card is therefore *one row's write*, never a renumbering of the column —
 *     which is what makes it safe to do from a shared, validated update path.
 *  2. **Concurrent moves cannot corrupt the order.** Two people dropping a card
 *     in the same gap at the same moment compute the *same* key and both store
 *     it; the result is a tie, and a tie is broken by primary key
 *     ({@link compareRanked}). Two people dropping into *different* gaps never
 *     interact at all. There is no renumbering pass to interleave with, so there
 *     is no state in which the column is half-renumbered.
 *
 * ## Why digits and not base-62
 *
 * These keys are sorted by **Postgres**, under whatever collation the deployment
 * happens to have. Restricting the alphabet to `0-9` makes lexicographic order
 * identical under every collation in existence; a base-62 key would be betting
 * that `'a'` sorts after `'9'` and that case folding never reorders anything.
 * Keys get a little longer. Nothing else changes.
 *
 * ## The one invariant
 *
 * **A key never ends in `'0'`.** A trailing zero is a second spelling of a
 * shorter key (`"30"` and `"3"` are both 0.3), and two spellings of one position
 * is exactly the ambiguity that makes midpoint arithmetic go wrong. Every key
 * this module produces satisfies it, as does the database default that stamps
 * new rows (`RANK_DEFAULT_SQL` in `@maxstack/core`).
 *
 * The midpoint algorithm is the well-known fractional-indexing one, ported to a
 * base-10 alphabet.
 */

/** The rank alphabet. See the module note on why it is digits only. */
const DIGITS = '0123456789'

/** Whether `key` is a well-formed rank key: non-empty digits, no trailing zero. */
export function isRankKey(key: unknown): key is string {
	return typeof key === 'string' && /^[0-9]*[1-9]$/.test(key)
}

/**
 * A key strictly between `before` and `after`, both of which may be `null` for
 * "nothing that side" (the start or the end of the column).
 *
 * Throws when the bounds are not in order or are not valid keys — a caller that
 * has its neighbours backwards has a bug, and inventing a key anyway would
 * persist the bug as data.
 */
export function rankBetween(
	before: string | null | undefined,
	after: string | null | undefined,
): string {
	const a = before ?? ''
	const b = after ?? null
	if (a !== '' && !isRankKey(a))
		throw new Error(`rankBetween: "${a}" is not a rank key`)
	if (b !== null && !isRankKey(b))
		throw new Error(`rankBetween: "${b}" is not a rank key`)
	if (b !== null && a >= b)
		throw new Error(`rankBetween: bounds out of order ("${a}" >= "${b}")`)
	return midpoint(a, b)
}

/**
 * The key half way between fractions `a` and `b`, where `a` may be `''` (zero)
 * and `b` may be `null` (one). Assumes `a < b` and that neither ends in `'0'` —
 * both guaranteed by {@link rankBetween}, which is the only caller.
 */
function midpoint(a: string, b: string | null): string {
	if (b !== null) {
		// Strip the longest common prefix, padding `a` with zeros as we go: `a` may
		// be the shorter string, and `''` is 0.000…, so a missing digit is a `0`.
		// (`b` cannot run out first — it is the larger of the two.)
		let n = 0
		while ((a[n] ?? '0') === b[n]) n++
		if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n))
	}
	const digitA = a === '' ? 0 : DIGITS.indexOf(a[0] as string)
	const digitB = b !== null ? DIGITS.indexOf(b[0] as string) : DIGITS.length
	if (digitB - digitA > 1) {
		// There is room for a digit strictly between them: take it and stop.
		return DIGITS[Math.round(0.5 * (digitA + digitB))] as string
	}
	// The leading digits are adjacent, so the answer starts with the lower one and
	// the search continues one place to the right.
	if (b !== null && b.length > 1) return b.slice(0, 1)
	return (DIGITS[digitA] as string) + midpoint(a.slice(1), null)
}

/** A row as far as ordering is concerned: a rank key and a tie-break id. */
export interface Ranked {
	rank: string | null | undefined
	id: string
}

/**
 * Total order over ranked rows: by key, ties broken by id.
 *
 * The tie-break is not decoration — it is what makes concurrent drops into the
 * same gap merely *ambiguous* rather than unstable. Without it two rows sharing
 * a key would swap places between renders depending on the order the store
 * happened to return them.
 *
 * A missing key sorts last. Every row gets one from the column's database
 * default, so this only happens if something wrote an explicit `null`; putting
 * those at the end keeps the order total instead of throwing.
 */
export function compareRanked(a: Ranked, b: Ranked): number {
	const ra = a.rank ?? null
	const rb = b.rank ?? null
	if (ra !== rb) {
		if (ra === null) return 1
		if (rb === null) return -1
		return ra < rb ? -1 : 1
	}
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * The key for a card dropped at `index` among `siblings` (the target column's
 * rows, already in display order and *excluding* the card being moved).
 *
 * `index` is the position the card lands in: `0` is the top of the column,
 * `siblings.length` is the bottom.
 */
export function rankForDrop(
	siblings: readonly Ranked[],
	index: number,
): string {
	const at = Math.max(0, Math.min(index, siblings.length))

	// The nearest key above the drop, skipping rows that carry none. A row with
	// no key says nothing about where the gap is, so it is passed over rather
	// than treated as a bound.
	let before: string | null = null
	for (let i = at - 1; i >= 0; i--) {
		const key = siblings[i]?.rank
		if (isRankKey(key)) {
			before = key
			break
		}
	}
	// The nearest key strictly *greater* than `before`. Skipping equal keys is
	// what makes a tie land somewhere rather than throw: two cards can share a key
	// (concurrent drops into one gap resolve that way by design), and there is no
	// key between a key and itself. The card goes after the whole tied run, which
	// is a decision a person can see and correct — unlike a failed drop.
	let after: string | null = null
	for (let i = at; i < siblings.length; i++) {
		const key = siblings[i]?.rank
		if (isRankKey(key) && (before === null || key > before)) {
			after = key
			break
		}
	}
	return rankBetween(before, after)
}
