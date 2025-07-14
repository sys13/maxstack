import { describe, expect, it } from 'vitest'
import {
	type MAXConfig,
	type StandardFeature,
	generateConfigTemplate,
	generateTypesContent,
	toKebabCase,
} from '../lib/index.js'

describe('Runtime API', () => {
	it('exports types correctly', () => {
		// Test that types are available
		const config: MAXConfig = {
			name: 'Test Project',
			description: 'A test project',
			standardFeatures: ['blog', 'user-authentication'] as StandardFeature[],
		}

		expect(config.name).toBe('Test Project')
		expect(config.description).toBe('A test project')
		expect(config.standardFeatures).toEqual(['blog', 'user-authentication'])
	})

	it('exports utility functions', () => {
		expect(typeof generateConfigTemplate).toBe('function')
		expect(typeof generateTypesContent).toBe('function')
		expect(typeof toKebabCase).toBe('function')
	})

	it('generateConfigTemplate works correctly', () => {
		const template = generateConfigTemplate(
			'default',
			'My App',
			'A sample app',
			['blog', 'user-authentication'],
		)

		expect(template).toContain('name: "My App"')
		expect(template).toContain('description: "A sample app"')
		expect(template).toContain(
			'standardFeatures: ["blog", "user-authentication"]',
		)
	})

	it('toKebabCase works correctly', () => {
		expect(toKebabCase('My Project Name')).toBe('my-project-name')
		expect(toKebabCase('test_project')).toBe('test-project')
		expect(toKebabCase('Already-Kebab')).toBe('already-kebab')
	})

	it('generateTypesContent generates valid TypeScript', () => {
		const types = generateTypesContent()

		expect(types).toContain('export interface MAXConfig')
		expect(types).toContain('export type StandardFeature')
		expect(types).toContain('export interface Feature')
	})
})
