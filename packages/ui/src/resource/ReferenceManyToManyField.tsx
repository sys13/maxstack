/**
 * `<ReferenceManyToManyField>` — a many-to-many relation (post ⇄ tag through a
 * `post_tag` join) rendered as chips (Plan v5 task 38). The reverse of
 * `<ReferenceManyField>`'s inline list: where that shows a parent's children as
 * rows, this shows the *far side* of a join as compact chips.
 *
 * Presentation only, loader-driven — the loader walks the join (`store.list(join,
 * { filter: { [near]: id } })` → far ids → one batched `getMany(far, ids)`) and
 * hands the resolved far-side records in as `records`. No fetching here, so the
 * component stays framework-agnostic and testable (the same discipline as the
 * rest of the resource library).
 */

import type { ReactNode } from 'react'
import { cn } from '../lib/cn.ts'

/** A resolved far-side record — only its id and display field are read. */
export type ManyToManyRecord = Record<string, unknown>

export interface ReferenceManyToManyFieldProps {
	/** The far-side records the loader resolved through the join table. */
	records: readonly ManyToManyRecord[]
	/** The field on each record to show in its chip (default `name`). */
	displayField?: string
	/** The record's id field, for keys and links (default `id`). */
	idField?: string
	/** The far-side table, used with `hrefFor` to link each chip. */
	table?: string
	/** Section heading (e.g. "Tags"). */
	label?: ReactNode
	/** Shown when there are no related records. */
	empty?: ReactNode
	className?: string
	/** Optional link wrapper — chips link to each far-side record's detail page. */
	linkComponent?: (props: {
		to: string
		children: ReactNode
		className?: string
	}) => ReactNode
	hrefFor?: (ctx: { table: string; id: string }) => string
}

export function ReferenceManyToManyField({
	records,
	displayField = 'name',
	idField = 'id',
	table,
	label,
	empty,
	className,
	linkComponent: Link,
	hrefFor,
}: ReferenceManyToManyFieldProps) {
	const chip =
		'inline-flex items-center rounded-full border border-input bg-secondary px-2 py-0.5 text-xs text-secondary-foreground'
	return (
		<section className={cn('space-y-2', className)}>
			{label ? (
				<h3 className="text-sm font-medium text-muted-foreground">{label}</h3>
			) : null}
			{records.length === 0 ? (
				<p className="text-sm text-muted-foreground">{empty ?? 'None'}</p>
			) : (
				<div className="flex flex-wrap gap-1">
					{records.map((record, i) => {
						const id = record[idField]
						const key = id === undefined ? i : String(id)
						const text = String(record[displayField] ?? id ?? '—')
						if (Link && hrefFor && table && id !== undefined) {
							return (
								<Link
									key={key}
									to={hrefFor({ table, id: String(id) })}
									className={cn(chip, 'hover:bg-accent')}
								>
									{text}
								</Link>
							)
						}
						return (
							<span key={key} className={chip}>
								{text}
							</span>
						)
					})}
				</div>
			)}
		</section>
	)
}
