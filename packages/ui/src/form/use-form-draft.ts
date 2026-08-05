/**
 * `useFormDraft` — optional autosave of an in-progress form to a key/value store
 * (localStorage by default), so a reload or accidental close doesn't lose edits.
 *
 * The hook is storage-shaped, not localStorage-bound: pass any `DraftStorage`
 * (a test fake, sessionStorage, an in-memory map) and it works. It reads the
 * stored draft *once* on mount (returned as `initial`, ready to seed
 * `defaultValues`), exposes `save(values)` to persist the current snapshot, and
 * `clear()` to drop it after a successful submit.
 */

import { useCallback, useRef } from 'react'

/** The `Storage`-compatible subset the draft needs — `localStorage` satisfies it. */
export interface DraftStorage {
	getItem(key: string): string | null
	setItem(key: string, value: string): void
	removeItem(key: string): void
}

function defaultStorage(): DraftStorage | null {
	try {
		if (typeof window !== 'undefined' && window.localStorage)
			return window.localStorage
	} catch {
		/* access can throw in sandboxed/denied contexts */
	}
	return null
}

export interface FormDraft {
	/** The persisted draft read at mount, or `undefined` if none / disabled. */
	initial: Record<string, unknown> | undefined
	/** Persist the current values snapshot. No-op when disabled. */
	save: (values: Record<string, unknown>) => void
	/** Delete the stored draft (call after a successful submit). */
	clear: () => void
}

export interface UseFormDraftOptions {
	/** Storage key; when absent the hook is fully disabled (returns no-ops). */
	key?: string
	storage?: DraftStorage
}

export function useFormDraft(options: UseFormDraftOptions): FormDraft {
	const { key, storage } = options
	const store = storage ?? defaultStorage()
	const enabled = Boolean(key && store)

	// Read the persisted draft exactly once (mount), so re-renders don't clobber
	// the value the user is actively editing.
	const initialRef = useRef<Record<string, unknown> | undefined>(undefined)
	const readRef = useRef(false)
	if (enabled && !readRef.current) {
		readRef.current = true
		try {
			const raw = store?.getItem(key as string)
			if (raw) initialRef.current = JSON.parse(raw) as Record<string, unknown>
		} catch {
			/* corrupt draft — ignore, start fresh */
		}
	}

	const save = useCallback(
		(values: Record<string, unknown>) => {
			if (!enabled) return
			try {
				store?.setItem(key as string, JSON.stringify(values))
			} catch {
				/* quota / serialization failure — dropping a draft is non-fatal */
			}
		},
		[enabled, key, store],
	)

	const clear = useCallback(() => {
		if (!enabled) return
		try {
			store?.removeItem(key as string)
		} catch {
			/* ignore */
		}
	}, [enabled, key, store])

	return { initial: initialRef.current, save, clear }
}
