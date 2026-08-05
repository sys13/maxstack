/**
 * `<EmptyState>` (Plan v5 task 63 / issue #60) — the "teach the app" empty-state
 * block that fills `<ResourceList>`'s `emptyState` slot (task 40) with more than
 * a bare "no results" message: a short explanation plus an optional action
 * (add the first row, load demo data, …). Presentational only — callers decide
 * the copy and the action, this just gives every empty state the same shape.
 */

import type { ReactNode } from 'react'
import { cn } from '../lib/cn.ts'

export interface EmptyStateProps {
	/** The headline — what's missing. */
	title: string
	/** A sentence of guidance on what to do next. */
	description?: ReactNode
	/** CTA(s) — a link/button (or a small group of them). */
	action?: ReactNode
	className?: string
}

/**
 * The noun to call one row of this resource in user-facing copy.
 *
 * The root cause of "+ Add the first Shelf" is that a resource had no *label* —
 * only `name`, which is an identifier (it is matched against `references.table`
 * and used as a preference-store key namespace), so every screen that needed a
 * word for the thing reached for whichever name was nearest: the page's. So the
 * label is a declared fact carried from the entity, and this is the one place
 * that decides what to say when it is missing:
 *
 *   1. the resource's declared `label` — the entity's display name, e.g. `Book`
 *   2. else its identifier, humanized — `reading-item` → `reading item`, since
 *      an id read aloud is still the right noun, just badly spelled
 *   3. else `record` — generic, but never wrong
 */
export function resourceNoun(
	resource: { name?: string | null; label?: string | null } | null | undefined,
): string {
	const label = resource?.label?.trim()
	if (label) return label
	const name = resource?.name?.trim()
	if (name) return name.replace(/[-_]+/g, ' ')
	return 'record'
}

/**
 * "Add the first book to get started." — the empty-state sentence, naming the
 * thing being added.
 *
 * `row` is a database word standing in a place where the entity's own name is
 * already on the props, and an empty state is the one screen whose whole job is
 * to say what this list is for.
 */
export function addTheFirst(
	resource: { name?: string | null; label?: string | null } | null | undefined,
): string {
	return `Add the first ${resourceNoun(resource)} to get started.`
}

export function EmptyState({
	title,
	description,
	action,
	className,
}: EmptyStateProps) {
	return (
		<div
			className={cn(
				'rounded-lg border border-dashed border-border px-6 py-10 text-center',
				className,
			)}
		>
			<p className="font-medium">{title}</p>
			{description ? (
				<p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
					{description}
				</p>
			) : null}
			{action ? (
				<div className="mt-4 flex flex-wrap items-center justify-center gap-2">
					{action}
				</div>
			) : null}
		</div>
	)
}
