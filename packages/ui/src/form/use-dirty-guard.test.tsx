import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDirtyGuard } from './use-dirty-guard.ts'

describe('useDirtyGuard', () => {
	afterEach(() => vi.restoreAllMocks())

	it('attaches a beforeunload listener while dirty', () => {
		const add = vi.spyOn(window, 'addEventListener')
		renderHook(() => useDirtyGuard(true, true))
		expect(add).toHaveBeenCalledWith('beforeunload', expect.any(Function))
	})

	it('does not attach when pristine', () => {
		const add = vi.spyOn(window, 'addEventListener')
		renderHook(() => useDirtyGuard(false, true))
		expect(
			add.mock.calls.filter(([type]) => type === 'beforeunload'),
		).toHaveLength(0)
	})

	it('does not attach when disabled', () => {
		const add = vi.spyOn(window, 'addEventListener')
		renderHook(() => useDirtyGuard(true, false))
		expect(
			add.mock.calls.filter(([type]) => type === 'beforeunload'),
		).toHaveLength(0)
	})

	it('removes the listener on cleanup', () => {
		const remove = vi.spyOn(window, 'removeEventListener')
		const { unmount } = renderHook(() => useDirtyGuard(true, true))
		unmount()
		expect(remove).toHaveBeenCalledWith('beforeunload', expect.any(Function))
	})

	it('the handler cancels the unload event', () => {
		renderHook(() => useDirtyGuard(true, true))
		const event = new Event('beforeunload', { cancelable: true })
		window.dispatchEvent(event)
		expect(event.defaultPrevented).toBe(true)
	})
})
