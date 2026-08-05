/**
 * @vitest-environment node
 *
 * No DOM in this file. The package default is `jsdom`, which costs
 * ~400ms of environment construction per file — the dominant term in this suite's
 * CPU, and the contention that starved a synchronous render past its timeout on a
 * 2-core runner. A test that never renders should not pay for a document.
 */
import { describe, expect, it, vi } from 'vitest'
import { LockStore } from './locks.ts'

describe('LockStore', () => {
	it('acquires, reports the holder, and prevents stealing', () => {
		const store = new LockStore({ now: () => 1000, ttl: 5000 })
		expect(store.get('post', '1')).toBeNull()
		const lock = store.acquire('post', '1', 'alice', 'Alice')
		expect(lock?.userId).toBe('alice')
		// A different user can't steal a live lock.
		expect(store.acquire('post', '1', 'bob')).toBeNull()
		// The holder re-acquiring refreshes it.
		expect(store.acquire('post', '1', 'alice')).not.toBeNull()
	})

	it('treats an expired lock as free', () => {
		let now = 1000
		const store = new LockStore({ now: () => now, ttl: 5000 })
		store.acquire('post', '1', 'alice')
		now = 7000 // past 1000 + 5000
		expect(store.get('post', '1')).toBeNull()
		// Now bob can take it.
		expect(store.acquire('post', '1', 'bob')).not.toBeNull()
	})

	it('releases only for the holder', () => {
		const store = new LockStore({ now: () => 1000 })
		store.acquire('post', '1', 'alice')
		store.release('post', '1', 'bob') // not the holder → no-op
		expect(store.get('post', '1')?.userId).toBe('alice')
		store.release('post', '1', 'alice')
		expect(store.get('post', '1')).toBeNull()
	})

	it('notifies subscribers on acquire and release', () => {
		const store = new LockStore({ now: () => 1000 })
		const listener = vi.fn()
		const unsub = store.subscribe('post', '1', listener)
		store.acquire('post', '1', 'alice')
		store.release('post', '1', 'alice')
		expect(listener).toHaveBeenCalledTimes(2)
		unsub()
		store.acquire('post', '1', 'bob')
		expect(listener).toHaveBeenCalledTimes(2)
	})

	it('merges an externally-broadcast lock and clears an expired one', () => {
		const store = new LockStore({ now: () => 1000 })
		store.set({
			resource: 'post',
			recordId: '1',
			userId: 'carol',
			expiresAt: 9999,
		})
		expect(store.get('post', '1')?.userId).toBe('carol')
		store.set({
			resource: 'post',
			recordId: '1',
			userId: 'carol',
			expiresAt: 0,
		})
		expect(store.get('post', '1')).toBeNull()
	})
})
