import { describe, expect, it } from 'vitest'
import {
	createConsoleMailer,
	createMemoryMailer,
	renderEmail,
} from './mailer.ts'
import { EmailRegistry } from './registry.ts'

describe('renderEmail', () => {
	it('renders a registered template to a subject + HTML body', () => {
		const registry = new EmailRegistry()
		const { subject, html } = renderEmail(registry, 'welcome', {
			name: 'Ada',
			email: 'ada@example.com',
		})
		expect(subject).toContain('Welcome')
		expect(html).toContain('Ada')
	})

	it('throws on an unknown template', () => {
		expect(() => renderEmail(new EmailRegistry(), 'nope', {})).toThrow(
			/unknown email template/,
		)
	})
})

describe('mailer transports', () => {
	it('memory mailer collects every message', async () => {
		const mailer = createMemoryMailer()
		const sent = await mailer.send({
			to: 'ada@example.com',
			subject: 'Hi',
			html: '<p>hi</p>',
		})
		expect(sent.id).toBe('mem-1')
		expect(mailer.sent).toHaveLength(1)
		expect(mailer.sent[0]?.to).toBe('ada@example.com')
	})

	it('console mailer logs and returns a stable id', async () => {
		const logs: string[] = []
		const mailer = createConsoleMailer((m) => logs.push(m))
		const sent = await mailer.send({
			to: 'ada@example.com',
			subject: 'Hi',
			html: '<p>hi</p>',
		})
		expect(sent.id).toBe('console-1')
		expect(logs[0]).toContain('ada@example.com')
	})
})
