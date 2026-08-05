import { act, render, renderHook, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LockStore } from './locks.ts'
import { LockBanner, useRecordLock } from './use-record-lock.tsx'

describe('useRecordLock', () => {
	it('acquires for me and reports heldByMe', () => {
		const store = new LockStore({ now: () => 1000 })
		const { result } = renderHook(() =>
			useRecordLock(store, 'post', '1', 'alice'),
		)
		expect(result.current.lock).toBeNull()
		act(() => {
			result.current.acquire()
		})
		expect(result.current.heldByMe).toBe(true)
		expect(result.current.lockedByOther).toBe(false)
	})

	it('reflects another session holding the lock (read-only for me)', () => {
		const store = new LockStore({ now: () => 1000 })
		// Someone else acquires first.
		store.acquire('post', '1', 'bob', 'Bob')
		const { result } = renderHook(() =>
			useRecordLock(store, 'post', '1', 'alice'),
		)
		expect(result.current.lockedByOther).toBe(true)
		expect(result.current.heldBy).toBe('Bob')
		// Alice can't acquire it.
		let ok = true
		act(() => {
			ok = result.current.acquire()
		})
		expect(ok).toBe(false)
	})

	it('live-updates when another session acquires after mount', () => {
		const store = new LockStore({ now: () => 1000 })
		const { result } = renderHook(() =>
			useRecordLock(store, 'post', '1', 'alice'),
		)
		expect(result.current.lockedByOther).toBe(false)
		act(() => {
			store.acquire('post', '1', 'bob', 'Bob')
		})
		expect(result.current.lockedByOther).toBe(true)
	})
})

describe('LockBanner', () => {
	it("shows the holder's name for another session, nothing for my own", () => {
		const lock = {
			resource: 'post',
			recordId: '1',
			userId: 'bob',
			userName: 'Bob',
			expiresAt: 9999,
		}
		const { rerender, container } = render(
			<LockBanner lock={lock} currentUserId="alice" />,
		)
		expect(screen.getByRole('status')).toHaveTextContent('Being edited by Bob')
		rerender(<LockBanner lock={lock} currentUserId="bob" />)
		expect(container).toBeEmptyDOMElement()
	})
})
