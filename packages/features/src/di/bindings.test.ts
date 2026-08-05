import { describe, expect, it } from 'vitest'
import { createBindings, MissingBindingError } from './bindings.ts'

interface AppBindings {
	user: { id: string } | null
	navigate: (to: string) => void
	hasFlag: (key: string) => boolean
}

describe('createBindings', () => {
	it('reads provided bindings', () => {
		const nav = () => {}
		const b = createBindings<AppBindings>({ user: { id: 'u1' }, navigate: nav })
		expect(b.get('user')).toEqual({ id: 'u1' })
		expect(b.get('navigate')).toBe(nav)
	})

	it('has() reflects presence', () => {
		const b = createBindings<AppBindings>({ navigate: () => {} })
		expect(b.has('navigate')).toBe(true)
		expect(b.has('hasFlag')).toBe(false)
	})

	it('require() returns the value when present', () => {
		const b = createBindings<AppBindings>({ hasFlag: () => true })
		expect(b.require('hasFlag')('x')).toBe(true)
	})

	it('require() throws MissingBindingError when absent', () => {
		const b = createBindings<AppBindings>({})
		expect(() => b.require('navigate')).toThrow(MissingBindingError)
		expect(() => b.require('navigate')).toThrow('Missing binding "navigate"')
	})

	it('with() layers overrides immutably', () => {
		const base = createBindings<AppBindings>({ user: null })
		const scoped = base.with({ user: { id: 'u2' } })
		expect(scoped.get('user')).toEqual({ id: 'u2' })
		// base is unchanged
		expect(base.get('user')).toBeNull()
	})
})
