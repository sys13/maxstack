/**
 * @vitest-environment node
 *
 * No DOM in this file. The package default is `jsdom`, which costs
 * ~400ms of environment construction per file — the dominant term in this suite's
 * CPU, and the contention that starved a synchronous render past its timeout on a
 * 2-core runner. A test that never renders should not pay for a document.
 */
import { describe, expect, it, vi } from 'vitest'
import { memoryBackend, PreferenceStore } from './store.ts'

describe('PreferenceStore', () => {
	it('returns the fallback for an unset key without persisting it', () => {
		const backend = memoryBackend()
		const store = new PreferenceStore({ backend })
		expect(store.get('missing', 42)).toBe(42)
		expect(backend.getItem('maxstack.prefs.missing')).toBeNull()
	})

	it('persists and reads back a value across store instances', () => {
		const backend = memoryBackend()
		new PreferenceStore({ backend }).set('rows', 25)
		const fresh = new PreferenceStore({ backend })
		expect(fresh.get('rows', 10)).toBe(25)
	})

	it('namespaces storage keys', () => {
		const backend = memoryBackend()
		new PreferenceStore({ backend, namespace: 'app' }).set('k', 'v')
		expect(backend.getItem('app.k')).toBe('"v"')
	})

	it('supports an updater function against the current value', () => {
		const store = new PreferenceStore({ backend: memoryBackend() })
		store.set('n', 1)
		store.set<number>('n', (prev) => prev + 1)
		expect(store.get('n', 0)).toBe(2)
	})

	it('notifies subscribers on set and remove, then stops after unsubscribe', () => {
		const store = new PreferenceStore({ backend: memoryBackend() })
		const listener = vi.fn()
		const unsub = store.subscribe('x', listener)
		store.set('x', 1)
		store.remove('x')
		expect(listener).toHaveBeenCalledTimes(2)
		unsub()
		store.set('x', 2)
		expect(listener).toHaveBeenCalledTimes(2)
	})

	it('does not cross-notify unrelated keys', () => {
		const store = new PreferenceStore({ backend: memoryBackend() })
		const a = vi.fn()
		store.subscribe('a', a)
		store.set('b', 1)
		expect(a).not.toHaveBeenCalled()
	})

	it('falls back on corrupt JSON', () => {
		const backend = memoryBackend()
		backend.setItem('maxstack.prefs.bad', '{not json')
		const store = new PreferenceStore({ backend })
		expect(store.get('bad', 'default')).toBe('default')
	})

	it('remove reverts future reads to the fallback', () => {
		const store = new PreferenceStore({ backend: memoryBackend() })
		store.set('k', 'stored')
		store.remove('k')
		expect(store.get('k', 'fb')).toBe('fb')
	})

	it('survives a backend that throws on write (keeps in-memory value)', () => {
		const throwing = {
			getItem: () => null,
			setItem: () => {
				throw new Error('quota')
			},
			removeItem: () => {},
		}
		const store = new PreferenceStore({ backend: throwing })
		expect(() => store.set('k', 'v')).not.toThrow()
		expect(store.get('k', 'fb')).toBe('v')
	})
})
