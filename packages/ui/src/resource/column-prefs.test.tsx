import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { PreferenceProvider } from '../prefs/prefs-context.tsx'
import { memoryBackend, PreferenceStore } from '../prefs/store.ts'
import {
	applyColumnConfig,
	configurableColumns,
	EMPTY_COLUMN_CONFIG,
	useColumnPrefs,
} from './column-prefs.ts'
import type { IntrospectedResource } from './resource-types.ts'

const resource: IntrospectedResource = {
	name: 'post',
	primaryKey: 'id',
	columns: [
		{ name: 'id', type: 'uuid', meta: {} },
		{ name: 'title', type: 'string', meta: {} },
		{ name: 'points', type: 'number', meta: {} },
		{ name: 'secret', type: 'string', meta: { hidden: true } },
	],
}

function wrapper(store: PreferenceStore) {
	return ({ children }: { children: ReactNode }) => (
		<PreferenceProvider store={store}>{children}</PreferenceProvider>
	)
}

describe('column config (pure)', () => {
	it('lists configurable columns, excluding structurally hidden', () => {
		expect(configurableColumns(resource)).toEqual(['id', 'title', 'points'])
	})

	it('drops hidden columns and applies explicit order', () => {
		expect(
			applyColumnConfig(resource, {
				hidden: ['id'],
				order: ['points', 'title'],
			}),
		).toEqual(['points', 'title'])
	})

	it('trails unordered columns in schema order', () => {
		expect(
			applyColumnConfig(resource, { hidden: [], order: ['points'] }),
		).toEqual(['points', 'id', 'title'])
	})

	it('empty config keeps schema order', () => {
		expect(applyColumnConfig(resource, EMPTY_COLUMN_CONFIG)).toEqual([
			'id',
			'title',
			'points',
		])
	})
})

describe('useColumnPrefs', () => {
	it('hides a column, persists it, and survives a fresh store from the same backend', () => {
		const backend = memoryBackend()
		const store = new PreferenceStore({ backend })
		const { result } = renderHook(() => useColumnPrefs(resource), {
			wrapper: wrapper(store),
		})
		expect(result.current.visible).toEqual(['id', 'title', 'points'])
		act(() => result.current.toggle('points'))
		expect(result.current.visible).toEqual(['id', 'title'])
		expect(result.current.isVisible('points')).toBe(false)

		// A brand-new store reading the same backend sees the persisted choice.
		const reloaded = new PreferenceStore({ backend })
		expect(
			applyColumnConfig(
				resource,
				reloaded.get('columns.post', EMPTY_COLUMN_CONFIG),
			),
		).toEqual(['id', 'title'])
	})

	it('moves a column and resets', () => {
		const store = new PreferenceStore({ backend: memoryBackend() })
		const { result } = renderHook(() => useColumnPrefs(resource), {
			wrapper: wrapper(store),
		})
		act(() => result.current.move('points', -1))
		expect(result.current.visible).toEqual(['id', 'points', 'title'])
		act(() => result.current.reset())
		expect(result.current.visible).toEqual(['id', 'title', 'points'])
	})
})
