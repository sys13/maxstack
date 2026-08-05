/**
 * A tiny, framework-agnostic key/value preference store (Plan v5 task 42) — the
 * UI-state dual of the `QueryClient`. Where the query cache holds *server* data,
 * this holds *user* UI state: saved filters, column visibility/order, list
 * density, rows-per-page, theme choice. It is the substrate several tasks lean
 * on (column config in task 40, saved queries, theming here).
 *
 * Design mirrors `QueryClient`: no React import (React binds via
 * `useSyncExternalStore` in `prefs-context.tsx`), subscribe/notify per key, and
 * a pluggable persistence backend so it works in tests (memory), the browser
 * (localStorage), and SSR (a no-op backend, values live only in memory for the
 * request). Keys are namespaced strings (`"post.columns"`); values are anything
 * JSON-serializable.
 */

/** The persistence seam. `localStorage` satisfies it structurally; tests and SSR
 * pass an in-memory or no-op implementation. Only the three methods the store
 * needs, so the surface stays swappable. */
export interface PersistenceBackend {
	getItem(key: string): string | null
	setItem(key: string, value: string): void
	removeItem(key: string): void
}

/** An in-memory backend — the default when no `localStorage` exists (SSR, tests,
 * Node). Values survive for the life of the store but not across reloads. */
export function memoryBackend(): PersistenceBackend {
	const map = new Map<string, string>()
	return {
		getItem: (k) => map.get(k) ?? null,
		setItem: (k, v) => {
			map.set(k, v)
		},
		removeItem: (k) => {
			map.delete(k)
		},
	}
}

/** `window.localStorage` if present and usable, else a memory backend. Guarded
 * against the private-mode / disabled-storage `SecurityError` some browsers
 * throw on access, and against SSR where `localStorage` is undefined. */
export function defaultBackend(): PersistenceBackend {
	try {
		const ls = (globalThis as { localStorage?: PersistenceBackend })
			.localStorage
		if (ls) {
			// Probe: some environments expose the object but throw on use.
			const probe = '__maxstack_prefs_probe__'
			ls.setItem(probe, '1')
			ls.removeItem(probe)
			return ls
		}
	} catch {
		// fall through to memory
	}
	return memoryBackend()
}

export interface PreferenceStoreOptions {
	backend?: PersistenceBackend
	/** Key prefix so several independent stores can share one backend without
	 * colliding (default `"maxstack.prefs"`). */
	namespace?: string
}

type Listener = () => void

export class PreferenceStore {
	private readonly backend: PersistenceBackend
	private readonly namespace: string
	private readonly listeners = new Map<string, Set<Listener>>()
	/** A read-through memo so `get` is cheap and `useSyncExternalStore`'s snapshot
	 * is referentially stable between writes (returning a fresh parse each call
	 * would loop the store). */
	private readonly cache = new Map<string, unknown>()

	constructor(options: PreferenceStoreOptions = {}) {
		this.backend = options.backend ?? defaultBackend()
		this.namespace = options.namespace ?? 'maxstack.prefs'
	}

	private storageKey(key: string): string {
		return `${this.namespace}.${key}`
	}

	/** Read a preference, parsing the persisted JSON on first access and memoizing.
	 * `fallback` is returned (not persisted) when the key is unset or corrupt. */
	get<T>(key: string, fallback: T): T {
		if (this.cache.has(key)) return this.cache.get(key) as T
		const raw = this.backend.getItem(this.storageKey(key))
		if (raw === null) {
			this.cache.set(key, fallback)
			return fallback
		}
		try {
			const parsed = JSON.parse(raw) as T
			this.cache.set(key, parsed)
			return parsed
		} catch {
			this.cache.set(key, fallback)
			return fallback
		}
	}

	/** Write a preference and notify subscribers. Accepts a value or an updater
	 * (given the current value, resolved against `fallback`). */
	set<T>(key: string, value: T | ((prev: T) => T), fallback?: T): void {
		const next =
			typeof value === 'function'
				? (value as (prev: T) => T)(this.get(key, fallback as T))
				: value
		this.cache.set(key, next)
		try {
			this.backend.setItem(this.storageKey(key), JSON.stringify(next))
		} catch {
			// Quota / disabled storage — keep the in-memory value so the session
			// still behaves; it just won't survive a reload.
		}
		this.notify(key)
	}

	/** Remove a preference (reverting future reads to their fallback). */
	remove(key: string): void {
		this.cache.delete(key)
		this.backend.removeItem(this.storageKey(key))
		this.notify(key)
	}

	subscribe(key: string, listener: Listener): () => void {
		let set = this.listeners.get(key)
		if (!set) {
			set = new Set()
			this.listeners.set(key, set)
		}
		set.add(listener)
		return () => {
			set?.delete(listener)
			if (set && set.size === 0) this.listeners.delete(key)
		}
	}

	private notify(key: string): void {
		const set = this.listeners.get(key)
		if (set) for (const l of set) l()
	}
}
