/**
 * The resolved-file-URL context — the file-field twin of
 * `reference-context.tsx`, and for the same reason.
 *
 * A `file` column stores a **storage key**, not a URL. That is deliberate: a
 * signed URL persisted into a row is a value that silently stops working when
 * it expires, and the row has no way to know. The consequence is that a read
 * surface holding a key cannot render it — signing needs a secret, so only the
 * server can turn a key into a fetchable, viewer-bound URL.
 *
 * So the loader resolves a page of keys in one pass and hands the map down,
 * exactly as it does for foreign keys: no per-cell fetch, no N+1, and no signing
 * secret anywhere near the browser. A key with no entry renders as its filename
 * rather than as a broken image — the honest degradation, since a URL we cannot
 * sign is a URL that would 403.
 */

import { createContext, type ReactNode, useContext } from 'react'

/** A resolved file: a signed URL for the original, plus one per declared
 * derivative, keyed by the derivative's name. */
export interface ResolvedFile {
	url: string
	/** Display name, when the registry knows one. */
	name?: string
	/** `thumb → signed URL`, for declared image derivatives. */
	derivatives?: Record<string, string>
}

/** `storage key → resolved file`. Serializable, so it crosses a loader
 * boundary unchanged. */
export type FileResolution = Record<string, ResolvedFile>

const FileContext = createContext<FileResolution>({})

export interface FileProviderProps {
	value: FileResolution
	children: ReactNode
}

/** Provide resolved file URLs to descendant file/image fields. Merges over any
 * parent provider, like `<ReferenceProvider>`. */
export function FileProvider({ value, children }: FileProviderProps) {
	const parent = useContext(FileContext)
	const merged = parent === value ? value : { ...parent, ...value }
	return <FileContext.Provider value={merged}>{children}</FileContext.Provider>
}

/**
 * The resolved file for a stored key, or `undefined` when the loader did not
 * resolve it (the field then shows the filename rather than a dead link).
 *
 * A value that is already a URL — a legacy row written before keys were stored —
 * is returned as-is, so old data keeps rendering.
 */
export function useResolvedFile(value: unknown): ResolvedFile | undefined {
	const resolution = useContext(FileContext)
	if (typeof value !== 'string' || value === '') return undefined
	const resolved = resolution[value]
	if (resolved) return resolved
	return isUrlValue(value) ? { url: value } : undefined
}

/** A stored key is a uuid plus a known extension; anything rooted at `/`, or
 * carrying a scheme, is a legacy URL value written before issue #183. */
export function isUrlValue(value: string): boolean {
	return (
		value.startsWith('/') || value.startsWith('data:') || value.includes('://')
	)
}
