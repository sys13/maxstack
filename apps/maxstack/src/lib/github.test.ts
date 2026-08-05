import { describe, expect, it } from 'vitest'
import { repoSlug } from './github.ts'

describe('repoSlug', () => {
	it('derives owner/name from a bare gitRemote', () => {
		expect(repoSlug('github.com/my-org', 'proj')).toBe('my-org/proj')
	})

	it('strips an https:// prefix', () => {
		expect(repoSlug('https://github.com/my-org', 'proj')).toBe('my-org/proj')
	})

	it('returns null for the shipped placeholder org', () => {
		expect(repoSlug('github.com/your-org', 'proj')).toBeNull()
	})

	it('returns null for an empty org', () => {
		expect(repoSlug('github.com/', 'proj')).toBeNull()
	})
})
