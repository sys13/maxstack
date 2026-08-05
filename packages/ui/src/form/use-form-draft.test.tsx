import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { type DraftStorage, useFormDraft } from './use-form-draft.ts'

function memoryStorage(seed: Record<string, string> = {}): DraftStorage {
	const map = new Map(Object.entries(seed))
	return {
		getItem: (k) => map.get(k) ?? null,
		setItem: (k, v) => void map.set(k, v),
		removeItem: (k) => void map.delete(k),
	}
}

describe('useFormDraft', () => {
	it('is disabled without a key (no initial, no-op save/clear)', () => {
		const storage = memoryStorage()
		const { result } = renderHook(() => useFormDraft({ storage }))
		expect(result.current.initial).toBeUndefined()
		act(() => result.current.save({ a: 1 }))
		// nothing persisted
		expect(storage.getItem('anything')).toBeNull()
	})

	it('reads a persisted draft once at mount', () => {
		const storage = memoryStorage({
			'draft:post': JSON.stringify({ title: 'Hi' }),
		})
		const { result } = renderHook(() =>
			useFormDraft({ key: 'draft:post', storage }),
		)
		expect(result.current.initial).toEqual({ title: 'Hi' })
	})

	it('persists and clears under the key', () => {
		const storage = memoryStorage()
		const { result } = renderHook(() =>
			useFormDraft({ key: 'draft:post', storage }),
		)
		act(() => result.current.save({ title: 'Draft' }))
		expect(JSON.parse(storage.getItem('draft:post') as string)).toEqual({
			title: 'Draft',
		})
		act(() => result.current.clear())
		expect(storage.getItem('draft:post')).toBeNull()
	})

	it('tolerates a corrupt stored draft', () => {
		const storage = memoryStorage({ 'draft:post': '{not json' })
		const { result } = renderHook(() =>
			useFormDraft({ key: 'draft:post', storage }),
		)
		expect(result.current.initial).toBeUndefined()
	})
})
