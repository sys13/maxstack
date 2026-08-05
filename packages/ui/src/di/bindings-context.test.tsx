import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import {
	type BindingsLike,
	createBindingsContext,
} from './bindings-context.tsx'

interface Deps {
	greeting: string
}

/** A minimal structurally-compatible container (a `createBindings()` result also
 * satisfies this — proving the provider needs no `@maxstack/features` import). */
function container(values: Partial<Deps>): BindingsLike<Deps> {
	return {
		get: (k) => values[k],
		require: (k) => {
			const v = values[k]
			if (v === undefined) throw new Error(`Missing binding "${String(k)}"`)
			return v as Deps[typeof k]
		},
		has: (k) => values[k] !== undefined,
	}
}

describe('createBindingsContext', () => {
	it('provides the container to consumers via useBindings()', () => {
		const { BindingsProvider, useBindings } = createBindingsContext<Deps>()
		const wrapper = ({ children }: { children: ReactNode }) => (
			<BindingsProvider value={container({ greeting: 'hello' })}>
				{children}
			</BindingsProvider>
		)
		const { result } = renderHook(() => useBindings(), { wrapper })
		expect(result.current.require('greeting')).toBe('hello')
		expect(result.current.has('greeting')).toBe(true)
	})

	it('throws when used outside a provider', () => {
		const { useBindings } = createBindingsContext<Deps>()
		expect(() => renderHook(() => useBindings())).toThrow(
			/within a <BindingsProvider>/,
		)
	})
})
