/**
 * `<ReferenceManyCount>` — a child count without loading the children (Plan v5
 * task 38). On a story page it shows "12 comments" from `store.count('comment',
 * { filter: { storyId } })` (the count endpoint task 38 added), never fetching
 * the comment rows. Pure presentation: the loader supplies `count`.
 *
 * `label` is the singular noun; the plural is `label + 's'` unless `pluralLabel`
 * overrides it (so "1 comment" / "3 comments", "1 person" / "2 people").
 */

import type { ReactNode } from 'react'
import { cn } from '../lib/cn.ts'

export interface ReferenceManyCountProps {
	count: number
	/** Singular noun for the counted records (e.g. "comment"). Omit to show the
	 * bare number. */
	label?: string
	/** Plural override when it isn't just `label + 's'`. */
	pluralLabel?: string
	className?: string
	/** Optional link wrapper — the count links to the filtered child list. */
	linkComponent?: (props: {
		to: string
		children: ReactNode
		className?: string
	}) => ReactNode
	/** Where the count links (the child list filtered to this parent). */
	to?: string
}

export function ReferenceManyCount({
	count,
	label,
	pluralLabel,
	className,
	linkComponent: Link,
	to,
}: ReferenceManyCountProps) {
	const noun = label
		? count === 1
			? label
			: (pluralLabel ?? `${label}s`)
		: null
	const text = noun ? `${count} ${noun}` : String(count)
	if (Link && to) {
		return (
			<Link
				to={to}
				className={cn('underline-offset-4 hover:underline', className)}
			>
				{text}
			</Link>
		)
	}
	return <span className={className}>{text}</span>
}
