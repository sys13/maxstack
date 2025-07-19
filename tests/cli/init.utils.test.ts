import { describe, expect, it } from 'vitest'

import { generateConfigTemplate } from '../../src/bin/commands/init.utils.js'

describe('generateConfigTemplate', () => {
	it('generates config without features', () => {
		const config = generateConfigTemplate(
			'default',
			'Test Project',
			'A test description',
			[],
		)

		expect(config).toContain('name: "Test Project"')
		expect(config).toContain('description: "A test description"')
		expect(config).toContain('standardFeatures: []')
	})

	it('generates config with selected features', () => {
		const config = generateConfigTemplate(
			'default',
			'Test Project',
			'A test description',
			['user-authentication', 'blog', 'saas-marketing'],
		)

		expect(config).toContain('name: "Test Project"')
		expect(config).toContain('description: "A test description"')
		expect(config).toContain(
			'standardFeatures: ["user-authentication", "blog", "saas-marketing"]',
		)
	})

	it('generates config with some features', () => {
		const config = generateConfigTemplate(
			'default',
			'Test Project',
			'A test description',
			['user-authentication'],
		)

		expect(config).toContain('standardFeatures: ["user-authentication"]')
	})

	it('handles undefined features array', () => {
		const config = generateConfigTemplate(
			'default',
			'Test Project',
			'A test description',
		)

		expect(config).toContain('standardFeatures: []')
	})
})
