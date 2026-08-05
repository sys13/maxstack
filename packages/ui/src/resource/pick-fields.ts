/**
 * Shared column heuristics for the zero-config list presentations. `<SimpleList>`
 * grew the first of these (the title pick); `<CardGrid>`/`<FeedList>` need the
 * same plus description/date picks, so they live here rather than being
 * re-derived per component. All are overridable at the call site; these are only
 * the defaults.
 */

import { detectFieldKind } from '../fields/field-semantics.ts'
import type { IntrospectedResource } from './resource-types.ts'

/** Pick the title column: an explicit choice, else the first visible non-PK
 * text/enum/reference column, else the first visible column. */
export function pickPrimary(
	resource: IntrospectedResource,
	visibleNames: string[],
	explicit?: string,
): string | undefined {
	if (explicit) return explicit
	const preferred = visibleNames.find((name) => {
		const col = resource.columns.find((c) => c.name === name)
		if (!col) return false
		const kind = detectFieldKind(col)
		return kind === 'text' || kind === 'enum' || kind === 'reference'
	})
	return preferred ?? visibleNames[0]
}

/**
 * Column names that almost always hold prose rather than a label — a feed's
 * description should be the *review*, not the author. Consulted
 * after the markdown/richtext check and before the positional text fallback,
 * because a plain `z.string()` carries no "this is long text" signal and the
 * first text column after the title is usually a name-ish one.
 */
const PROSE_WORDS = new Set([
	'about',
	'bio',
	'body',
	'comment',
	'comments',
	'content',
	'description',
	'excerpt',
	'notes',
	'review',
	'summary',
	'text',
])

const isProseName = (name: string): boolean =>
	PROSE_WORDS.has(name.toLowerCase()) ||
	// camelCase/snake_case compounds: `reviewText`, `short_description`.
	[...PROSE_WORDS].some((w) =>
		new RegExp(`(^|[^a-z])${w}([^a-z]|$)`, 'i').test(
			name.replace(/([a-z0-9])([A-Z])/g, '$1 $2'),
		),
	)

/** Pick the body/description column: the first markdown/richtext column, else
 * the first prose-named plain-text column, else the first plain-text column
 * that isn't the title. `undefined` when the entity has no prose-ish column —
 * a feed entry then renders title-only. */
export function pickDescription(
	resource: IntrospectedResource,
	visibleNames: string[],
	primary: string | undefined,
	explicit?: string,
): string | undefined {
	if (explicit) return explicit
	const candidates = visibleNames.filter((name) => name !== primary)
	const kindOf = (name: string) => {
		const col = resource.columns.find((c) => c.name === name)
		return col ? detectFieldKind(col) : undefined
	}
	return (
		candidates.find((n) => {
			const k = kindOf(n)
			return k === 'markdown' || k === 'richtext'
		}) ??
		candidates.find((n) => kindOf(n) === 'text' && isProseName(n)) ??
		candidates.find((n) => kindOf(n) === 'text')
	)
}

/**
 * Pick the at-a-glance columns a feed entry shows beside its title/description
 * /date — the enum, number, rating and boolean columns whose values ARE the
 * content of the row (a status, a rating, a count). Without this a reviews feed
 * renders title/author/date and hides the stars. Returns names in
 * the resource's column order, capped by `limit`.
 */
export function pickSecondary(
	resource: IntrospectedResource,
	visibleNames: string[],
	used: (string | undefined)[],
	limit: number,
): string[] {
	if (limit <= 0) return []
	return visibleNames
		.filter((name) => {
			if (used.includes(name)) return false
			const col = resource.columns.find((c) => c.name === name)
			if (!col) return false
			const kind = detectFieldKind(col)
			return (
				kind === 'enum' ||
				kind === 'number' ||
				kind === 'rating' ||
				kind === 'boolean' ||
				kind === 'duration'
			)
		})
		.slice(0, limit)
}

/** Pick the timestamp column: the first date-kind visible column. */
export function pickDate(
	resource: IntrospectedResource,
	visibleNames: string[],
	explicit?: string,
): string | undefined {
	if (explicit) return explicit
	return visibleNames.find((name) => {
		const col = resource.columns.find((c) => c.name === name)
		return col !== undefined && detectFieldKind(col) === 'date'
	})
}
