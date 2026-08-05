/**
 * `<SearchPalette>` (Plan v5 task 44) — the command-palette UI over
 * `useGlobalSearch`. A single input searches every registered resource; results
 * are grouped by resource and keyboard-navigable (↑/↓ to move, Enter to open,
 * Esc to close). Presentation-only over the hook, router-agnostic via
 * `linkComponent`/`onNavigate`. The `useSearchHotkey` helper wires the
 * conventional ⌘K / Ctrl-K open shortcut so a shell mounts one palette and gets
 * the whole behavior.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '../lib/cn.ts'
import {
	type GlobalSearchOptions,
	type SearchHit,
	useGlobalSearch,
} from './global-search.ts'

/** Wire the ⌘K / Ctrl-K open shortcut; returns `[open, setOpen]`. Mount once. */
export function useSearchHotkey(): readonly [boolean, (open: boolean) => void] {
	const [open, setOpen] = useState(false)
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
				e.preventDefault()
				setOpen(true)
			}
		}
		const target = globalThis as {
			addEventListener?: (t: string, l: (e: KeyboardEvent) => void) => void
			removeEventListener?: (t: string, l: (e: KeyboardEvent) => void) => void
		}
		target.addEventListener?.('keydown', onKey)
		return () => target.removeEventListener?.('keydown', onKey)
	}, [])
	return [open, setOpen] as const
}

export interface SearchPaletteProps extends GlobalSearchOptions {
	open: boolean
	onClose: () => void
	/** Called with a hit when the user opens it (navigate there). */
	onNavigate?: (hit: SearchHit) => void
	/** Placeholder for the input. */
	placeholder?: string
	className?: string
}

export function SearchPalette({
	open,
	onClose,
	onNavigate,
	placeholder = 'Search everything…',
	className,
	...searchOptions
}: SearchPaletteProps) {
	const { query, setQuery, groups, isSearching, flat, clear } =
		useGlobalSearch(searchOptions)
	const [active, setActive] = useState(0)
	const inputRef = useRef<HTMLInputElement>(null)

	// Reset selection when results change; keep it in range.
	useEffect(() => {
		setActive(0)
	}, [])

	// Focus the input when the palette opens; clear on close.
	useEffect(() => {
		if (open) inputRef.current?.focus()
		else clear()
	}, [open, clear])

	const choose = useCallback(
		(hit: SearchHit | undefined) => {
			if (!hit) return
			onNavigate?.(hit)
			onClose()
		},
		[onNavigate, onClose],
	)

	const onKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === 'Escape') {
				onClose()
			} else if (e.key === 'ArrowDown') {
				e.preventDefault()
				setActive((i) => Math.min(i + 1, Math.max(flat.length - 1, 0)))
			} else if (e.key === 'ArrowUp') {
				e.preventDefault()
				setActive((i) => Math.max(i - 1, 0))
			} else if (e.key === 'Enter') {
				e.preventDefault()
				choose(flat[active])
			}
		},
		[flat, active, choose, onClose],
	)

	if (!open) return null

	let flatIndex = -1
	return (
		<div className="fixed inset-0 z-50 flex items-start justify-center pt-24">
			{/* Backdrop: a real button so click-to-close is keyboard-accessible. */}
			<button
				type="button"
				aria-label="Close search"
				tabIndex={-1}
				className="absolute inset-0 h-full w-full cursor-default bg-black/40"
				onClick={onClose}
			/>
			<div
				className={cn(
					'relative w-full max-w-lg overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg',
					className,
				)}
				role="dialog"
				aria-modal="true"
				aria-label="Global search"
			>
				<input
					ref={inputRef}
					type="search"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={onKeyDown}
					placeholder={placeholder}
					aria-label="Search"
					className="w-full border-border border-b bg-transparent px-4 py-3 text-sm outline-none"
				/>
				<div className="max-h-80 overflow-y-auto py-1" role="listbox">
					{query.trim() === '' ? (
						<p className="px-4 py-6 text-center text-muted-foreground text-sm">
							Type to search.
						</p>
					) : isSearching && groups.length === 0 ? (
						<p className="px-4 py-6 text-center text-muted-foreground text-sm">
							Searching…
						</p>
					) : groups.length === 0 ? (
						<p className="px-4 py-6 text-center text-muted-foreground text-sm">
							No results for “{query}”.
						</p>
					) : (
						groups.map((group) => (
							<div key={group.resource}>
								<div className="px-4 pt-2 pb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
									{group.label}
								</div>
								{group.hits.map((hit) => {
									flatIndex++
									const isActive = flatIndex === active
									return (
										<button
											type="button"
											key={`${hit.resource}-${hit.id}`}
											role="option"
											aria-selected={isActive}
											onClick={() => choose(hit)}
											className={cn(
												'block w-full truncate px-4 py-2 text-left text-sm',
												isActive ? 'bg-muted' : 'hover:bg-muted/60',
											)}
										>
											{hit.title}
										</button>
									)
								})}
							</div>
						))
					)}
				</div>
			</div>
		</div>
	)
}
