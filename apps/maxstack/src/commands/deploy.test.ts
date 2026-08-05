import type { InstalledBundle } from '@maxstack/features/bundle'
import { describe, expect, it } from 'vitest'
import { authPostureWarning } from './deploy.ts'

describe('authPostureWarning', () => {
	it('warns loudly that the REST API ships open when no auth bundle is installed', () => {
		const warning = authPostureWarning([])
		expect(warning).toContain('SECURITY')
		expect(warning).toContain('OPEN REST API')
		expect(warning).toContain('maxstack add auth')
	})

	it('ignores unrelated bundles when deciding the posture', () => {
		const bundles: InstalledBundle[] = [{ slug: 'audit', version: '0.1.0' }]
		expect(authPostureWarning(bundles)).toContain('OPEN REST API')
	})

	it('reminds about MAXSTACK_AUTH_STRICT when auth is installed', () => {
		const bundles: InstalledBundle[] = [{ slug: 'auth', version: '0.1.0' }]
		const note = authPostureWarning(bundles)
		expect(note).not.toContain('OPEN REST API')
		expect(note).toContain('MAXSTACK_AUTH_STRICT=1')
	})
})
