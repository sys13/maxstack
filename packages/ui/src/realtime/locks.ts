/**
 * Collaborative record locks (Plan v5 task 45). When a session starts editing a
 * record it acquires a lock; other sessions see who holds it and that it's
 * read-only for them. `LockStore` is a pure, transport-agnostic registry
 * (backed by whatever broadcasts locks — the audit/session infra, a WS channel,
 * or an in-memory store for a single tab / tests); `useRecordLock` binds a
 * component to one record's lock with acquire/release and a live holder view.
 * Locks auto-expire (a TTL) so a crashed editor never wedges a record forever.
 */

export interface Lock {
	resource: string
	recordId: string
	/** Who holds it. */
	userId: string
	/** Display label for the holder (optional). */
	userName?: string
	/** ms-epoch expiry; a lock past this is treated as free. */
	expiresAt: number
}

type Listener = () => void

/** Time source — injected so tests are deterministic (no `Date.now()`). */
export interface LockStoreOptions {
	now?: () => number
	/** Default lock lifetime in ms (default 30_000). */
	ttl?: number
}

const lockKey = (resource: string, recordId: string) =>
	`${resource}:${recordId}`

export class LockStore {
	private readonly locks = new Map<string, Lock>()
	private readonly listeners = new Map<string, Set<Listener>>()
	private readonly now: () => number
	private readonly ttl: number

	constructor(options: LockStoreOptions = {}) {
		this.now = options.now ?? (() => Date.now())
		this.ttl = options.ttl ?? 30_000
	}

	/** The live lock for a record, or `null` if free/expired. */
	get(resource: string, recordId: string): Lock | null {
		const lock = this.locks.get(lockKey(resource, recordId))
		if (!lock) return null
		if (lock.expiresAt <= this.now()) {
			this.locks.delete(lockKey(resource, recordId))
			return null
		}
		return lock
	}

	/** Acquire (or refresh) a lock for `userId`. Returns the lock, or `null` if
	 * another live holder owns it (can't steal). Re-acquiring your own refreshes. */
	acquire(
		resource: string,
		recordId: string,
		userId: string,
		userName?: string,
	): Lock | null {
		const existing = this.get(resource, recordId)
		if (existing && existing.userId !== userId) return null
		const lock: Lock = {
			resource,
			recordId,
			userId,
			userName,
			expiresAt: this.now() + this.ttl,
		}
		this.locks.set(lockKey(resource, recordId), lock)
		this.notify(resource, recordId)
		return lock
	}

	/** Release a lock you hold (a no-op if you don't). */
	release(resource: string, recordId: string, userId: string): void {
		const existing = this.locks.get(lockKey(resource, recordId))
		if (existing && existing.userId === userId) {
			this.locks.delete(lockKey(resource, recordId))
			this.notify(resource, recordId)
		}
	}

	/** Merge an externally-broadcast lock (from the WS/session channel). Passing a
	 * lock whose `expiresAt` is in the past clears it. */
	set(lock: Lock): void {
		if (lock.expiresAt <= this.now()) {
			this.locks.delete(lockKey(lock.resource, lock.recordId))
		} else {
			this.locks.set(lockKey(lock.resource, lock.recordId), lock)
		}
		this.notify(lock.resource, lock.recordId)
	}

	subscribe(
		resource: string,
		recordId: string,
		listener: Listener,
	): () => void {
		const key = lockKey(resource, recordId)
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

	private notify(resource: string, recordId: string): void {
		const set = this.listeners.get(lockKey(resource, recordId))
		if (set) for (const l of set) l()
	}
}
