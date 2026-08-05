/**
 * `<SavedQueries>` — the chip bar over `useSavedQueries` (Plan v5 task 40).
 * Sits next to a `<FilterForm>`: one chip per preset (click to apply, × to
 * delete), the active preset highlighted, and a "Save query…" affordance that
 * appears once the current filters/sort differ from every preset. Controlled
 * like the filter form itself — `value`/`sort` in, `onApply` out — so the
 * owning route keeps its single source of list state (and its URL sync).
 */

import { useState } from 'react'
import { cn } from '../lib/cn.ts'
import { Input } from '../ui/primitives.tsx'
import { activeFilterCount, type FilterValues } from './filterable.ts'
import type { SortState } from './ResourceList.tsx'
import { type AppliedQuery, useSavedQueries } from './saved-queries.ts'

export interface SavedQueriesProps {
	/** The resource name — the preference-store key namespace. */
	resource: string
	/** The list's current filters (the same value the `<FilterForm>` holds). */
	value: FilterValues
	/** The list's current sort, captured into presets alongside the filters. */
	sort?: SortState
	onApply: (applied: AppliedQuery) => void
	/** Override the preference-store key (default `savedQueries.<resource>`). */
	storeKey?: string
	className?: string
}

const CHIP_CLASS =
	'inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-sm'

export function SavedQueries({
	resource,
	value,
	sort,
	onApply,
	storeKey,
	className,
}: SavedQueriesProps) {
	const { queries, save, remove, apply, matching } = useSavedQueries(resource, {
		storeKey,
	})
	const [naming, setNaming] = useState(false)
	const [name, setName] = useState('')

	const active = matching(value, sort)
	// Something worth saving: any filter constraint or an explicit sort, and not
	// already saved verbatim.
	const savable = !active && (activeFilterCount(value) > 0 || sort != null)

	if (queries.length === 0 && !savable) return null

	function saveCurrent() {
		save(name, value, sort)
		setName('')
		setNaming(false)
	}

	return (
		<fieldset
			className={cn(
				'flex flex-wrap items-center gap-2 border-0 p-0',
				className,
			)}
			aria-label="Saved queries"
		>
			{queries.map((q) => {
				const isActive = q.name === active?.name
				return (
					<span
						key={q.name}
						className={cn(
							CHIP_CLASS,
							isActive
								? 'border-transparent bg-primary text-primary-foreground'
								: 'bg-background',
						)}
					>
						<button
							type="button"
							onClick={() => {
								const applied = apply(q.name)
								if (applied) onApply(applied)
							}}
							aria-pressed={isActive}
							className="font-medium"
						>
							{q.name}
						</button>
						<button
							type="button"
							onClick={() => remove(q.name)}
							aria-label={`Delete saved query ${q.name}`}
							className="opacity-60 hover:opacity-100"
						>
							×
						</button>
					</span>
				)
			})}

			{savable ? (
				naming ? (
					<form
						onSubmit={(e) => {
							e.preventDefault()
							saveCurrent()
						}}
						className="flex items-center gap-1"
					>
						<Input
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="Query name"
							aria-label="Query name"
							className="h-7 w-36"
						/>
						<button
							type="submit"
							disabled={name.trim() === ''}
							className={cn(CHIP_CLASS, 'hover:bg-muted/60')}
						>
							Save
						</button>
						<button
							type="button"
							onClick={() => {
								setNaming(false)
								setName('')
							}}
							className="px-1 text-sm text-muted-foreground hover:text-foreground"
						>
							Cancel
						</button>
					</form>
				) : (
					<button
						type="button"
						onClick={() => setNaming(true)}
						className={cn(
							CHIP_CLASS,
							'border-dashed text-muted-foreground hover:bg-muted/60 hover:text-foreground',
						)}
					>
						Save query…
					</button>
				)
			) : null}
		</fieldset>
	)
}
