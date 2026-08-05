import { describe, expect, it } from 'vitest'
import { CORE_PACKAGE } from './index.ts'

describe('@maxstack/core scaffold', () => {
	it('exposes its package identity', () => {
		expect(CORE_PACKAGE).toBe('@maxstack/core')
	})
})
