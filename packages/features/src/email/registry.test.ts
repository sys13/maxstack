/**
 * Repointed from mxscratchpad's `emails/registry.test.ts`. The original tested
 * a *mock* `MockEmailRegistry` (a copy of the class inlined into the test) to
 * dodge React rendering — so it never exercised the shipped code. This version
 * points every assertion at the real `EmailRegistry`, using a fresh instance
 * per test for isolation instead of the original's global-state `beforeEach`
 * reset.
 */

import { describe, expect, it } from 'vitest'
import { EmailRegistry } from './registry.ts'

describe('EmailRegistry', () => {
	it('should return all default templates', () => {
		const registry = new EmailRegistry()
		const templates = registry.getAll()
		expect(Object.keys(templates)).toContain('verify-email')
		expect(Object.keys(templates)).toContain('password-reset')
		expect(Object.keys(templates)).toContain('welcome')
		expect(Object.keys(templates)).toContain('newsletter-confirmation')
	})

	it('should get a specific template', () => {
		const registry = new EmailRegistry()
		const template = registry.get('verify-email')
		expect(template).toBeDefined()
		expect(template?.name).toBe('verify-email')
		expect(template?.subject).toBeDefined()
		expect(template?.render).toBeDefined()
	})

	it('should check if template exists', () => {
		const registry = new EmailRegistry()
		expect(registry.has('verify-email')).toBe(true)
		expect(registry.has('non-existent')).toBe(false)
	})

	it('should allow registering custom templates', () => {
		const registry = new EmailRegistry()
		const customTemplate = {
			name: 'custom-test',
			subject: () => 'Test Subject',
			render: () => '<p>Test</p>',
			description: 'Test template',
		}

		registry.register(customTemplate)
		expect(registry.has('custom-test')).toBe(true)
		expect(registry.get('custom-test')).toBe(customTemplate)
	})

	it('custom templates override defaults of the same name', () => {
		const registry = new EmailRegistry()
		const override = {
			name: 'verify-email',
			subject: () => 'Overridden',
			render: () => '<p>Overridden</p>',
		}
		registry.register(override)
		expect(registry.get('verify-email')).toBe(override)
		expect(registry.get('verify-email')?.subject({})).toBe('Overridden')
	})

	it('should allow removing custom templates', () => {
		const registry = new EmailRegistry()
		const customTemplate = {
			name: 'custom-test-2',
			subject: () => 'Test Subject',
			render: () => '<p>Test</p>',
		}

		registry.register(customTemplate)
		expect(registry.has('custom-test-2')).toBe(true)

		const removed = registry.remove('custom-test-2')
		expect(removed).toBe(true)
		expect(registry.has('custom-test-2')).toBe(false)
	})

	it('removing a custom override reverts to the default', () => {
		const registry = new EmailRegistry()
		const override = {
			name: 'welcome',
			subject: () => 'Overridden',
			render: () => '<p>Overridden</p>',
		}
		registry.register(override)
		expect(registry.get('welcome')).toBe(override)
		registry.remove('welcome')
		expect(registry.get('welcome')?.subject({ name: 'X', email: 'x' })).toBe(
			'Welcome to Max! Your account is ready.',
		)
	})

	it('remove returns false for a default (nothing custom to remove)', () => {
		const registry = new EmailRegistry()
		expect(registry.remove('verify-email')).toBe(false)
		expect(registry.has('verify-email')).toBe(true)
	})

	it('should return template names', () => {
		const registry = new EmailRegistry()
		const names = registry.getTemplateNames()
		expect(names).toContain('verify-email')
		expect(names).toContain('password-reset')
		expect(names).toContain('welcome')
		expect(names).toContain('newsletter-confirmation')
	})

	it('should generate correct subjects', () => {
		const registry = new EmailRegistry()
		const template = registry.get('verify-email')
		const subject = template?.subject({
			companyName: 'Test Company',
			email: 'test@example.com',
			verificationUrl: 'https://example.com/verify',
		})
		expect(subject).toBe('Verify your email address for Test Company')
	})

	it('renders an HTML body and escapes untrusted props', () => {
		const registry = new EmailRegistry()
		const html = registry.get('verify-email')?.render({
			email: 'a@b.com',
			verificationUrl: 'https://example.com/verify?x="><script>',
		})
		expect(html).toContain('<!doctype html>')
		expect(html).not.toContain('"><script>')
		expect(html).toContain('&quot;&gt;&lt;script&gt;')
	})

	it('isolates state between instances', () => {
		const a = new EmailRegistry()
		const b = new EmailRegistry()
		a.register({ name: 'only-a', subject: () => '', render: () => '' })
		expect(a.has('only-a')).toBe(true)
		expect(b.has('only-a')).toBe(false)
	})
})
