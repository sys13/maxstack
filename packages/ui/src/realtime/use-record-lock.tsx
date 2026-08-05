/**
 * React binding for record locks (Plan v5 task 45). `useRecordLock` binds a
 * component to one record's lock in a `LockStore`, exposing whether the current
 * session holds it, who else does, and acquire/release. `<LockBanner>` renders
 * the "being edited by X" banner other sessions see. Together with the
 * subscription seam this delivers the exit: two sessions on one record — one
 * edits and holds the lock, the other sees the live update + a lock indicator.
 */

import {
	type ReactNode,
	useCallback,
	useEffect,
	useSyncExternalStore,
} from 'react'
import { cn } from '../lib/cn.ts'
import type { Lock, LockStore } from './locks.ts'

export interface UseRecordLockResult {
	/** The live lock, or null when free. */
	lock: Lock | null
	/** True when the current session holds it. */
	heldByMe: boolean
	/** True when someone *else* holds it (→ read-only for me). */
	lockedByOther: boolean
	/** The other holder's display name/id when `lockedByOther`. */
	heldBy: string | null
	acquire: () => boolean
	release: () => void
}

export interface UseRecordLockOptions {
	/** Acquire the lock automatically on mount (default false — call `acquire`
	 * when the user actually starts editing). */
	acquireOnMount?: boolean
	/** Refresh the held lock on this interval so it doesn't TTL-expire mid-edit
	 * (ms; default 10_000). Set 0 to disable. */
	refreshInterval?: number
	userName?: string
}

export function useRecordLock(
	store: LockStore,
	resource: string,
	recordId: string,
	userId: string,
	options: UseRecordLockOptions = {},
): UseRecordLockResult {
	const subscribe = useCallback(
		(cb: () => void) => store.subscribe(resource, recordId, cb),
		[store, resource, recordId],
	)
	const getSnapshot = useCallback(
		() => store.get(resource, recordId),
		[store, resource, recordId],
	)
	const lock = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

	const acquire = useCallback(
		() => store.acquire(resource, recordId, userId, options.userName) !== null,
		[store, resource, recordId, userId, options.userName],
	)
	const release = useCallback(
		() => store.release(resource, recordId, userId),
		[store, resource, recordId, userId],
	)

	const acquireOnMount = options.acquireOnMount ?? false
	const refreshInterval = options.refreshInterval ?? 10_000

	// biome-ignore lint/correctness/useExhaustiveDependencies: acquire/release are stable; run once per record.
	useEffect(() => {
		if (!acquireOnMount) return
		acquire()
		return () => release()
	}, [resource, recordId, userId, acquireOnMount])

	// Keep a held lock warm.
	// biome-ignore lint/correctness/useExhaustiveDependencies: refresh only while we hold it.
	useEffect(() => {
		if (refreshInterval <= 0 || lock?.userId !== userId) return
		const t = setInterval(() => acquire(), refreshInterval)
		return () => clearInterval(t)
	}, [lock?.userId, userId, refreshInterval])

	const heldByMe = lock?.userId === userId
	const lockedByOther = lock != null && lock.userId !== userId
	return {
		lock,
		heldByMe,
		lockedByOther,
		heldBy: lockedByOther ? (lock?.userName ?? lock?.userId ?? null) : null,
		acquire,
		release,
	}
}

export interface LockBannerProps {
	lock: Lock | null
	/** The current session's user id (so we don't banner our own lock). */
	currentUserId: string
	/** Custom message; default "Being edited by <name>". */
	message?: (holder: string) => ReactNode
	className?: string
}

export function LockBanner({
	lock,
	currentUserId,
	message,
	className,
}: LockBannerProps) {
	if (!lock || lock.userId === currentUserId) return null
	const holder = lock.userName ?? lock.userId
	return (
		<output
			className={cn(
				'flex items-center gap-2 rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-warning text-sm',
				className,
			)}
		>
			<span aria-hidden>🔒</span>
			<span>
				{message ? message(holder) : `Being edited by ${holder}. Read-only.`}
			</span>
		</output>
	)
}
