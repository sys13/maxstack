import { describe, expect, it } from 'vitest'
import { definitionErrors } from '../preferences/definitions.ts'
import {
	BUILT_IN_NOTIFICATION_TYPES,
	DIGEST_CADENCE_PREFERENCE,
	emailPreferenceKey,
	inAppPreferenceKey,
	type NotificationTypeDefinition,
	notificationPreferenceDefinitions,
	notificationTypeErrors,
} from './types.ts'

const activity = (
	overrides: Partial<NotificationTypeDefinition> = {},
): NotificationTypeDefinition => ({
	key: 'thing-happened',
	label: 'Thing happened',
	description: 'A thing happened that concerns you.',
	class: 'activity',
	defaultEmail: 'digest',
	defaultInApp: true,
	...overrides,
})

describe('notificationTypeErrors', () => {
	it('accepts the built-in vocabulary', () => {
		expect(notificationTypeErrors(BUILT_IN_NOTIFICATION_TYPES)).toEqual([])
	})

	it('refuses an activity type that defaults to immediate email', () => {
		const errors = notificationTypeErrors([
			activity({ defaultEmail: 'immediate' }),
		])
		expect(errors).toHaveLength(1)
		expect(errors[0]).toContain('may not default to immediate email')
	})

	it('refuses a marketing type that defaults to any email at all', () => {
		expect(
			notificationTypeErrors([
				activity({ class: 'marketing', defaultEmail: 'digest' }),
			]),
		).toEqual([
			expect.stringContaining('must default to "off"'),
			// Defaulting into the inbox is the same mistake in the other channel.
			expect.stringContaining('must default out of the inbox'),
		])
	})

	it('requires a transactional type to be immediate', () => {
		const errors = notificationTypeErrors([
			activity({ class: 'transactional', defaultEmail: 'digest' }),
		])
		expect(errors[0]).toContain('delivered immediately by definition')
	})

	it('refuses a duplicate key, a bad slug, and a missing description', () => {
		const errors = notificationTypeErrors([
			activity(),
			activity(),
			activity({ key: 'Not A Slug' }),
			activity({ key: 'no-help', description: '  ' }),
		])
		expect(errors).toEqual([
			expect.stringContaining('declared twice'),
			expect.stringContaining('lowercase slug'),
			expect.stringContaining('needs a description'),
		])
	})
})

describe('notificationPreferenceDefinitions', () => {
	const derived = notificationPreferenceDefinitions()

	it('produces preference declarations the preferences layer accepts', () => {
		expect(definitionErrors(derived)).toEqual([])
	})

	it('gives every opt-out-able type an email choice and an inbox toggle', () => {
		const keys = derived.map((d) => d.key)
		expect(keys).toContain(emailPreferenceKey('invitation-accepted'))
		expect(keys).toContain(inAppPreferenceKey('invitation-accepted'))
		expect(keys).toContain(DIGEST_CADENCE_PREFERENCE)
	})

	it('offers no email opt-out for a transactional type', () => {
		const keys = derived.map((d) => d.key)
		expect(keys).not.toContain(emailPreferenceKey('security-alert'))
		// …but its inbox row is still the user's to turn off.
		expect(keys).toContain(inAppPreferenceKey('security-alert'))
	})

	it('carries each declaration’s default through to the preference default', () => {
		const byKey = new Map(derived.map((d) => [d.key, d]))
		expect(byKey.get(emailPreferenceKey('invitation-accepted'))?.default).toBe(
			'digest',
		)
		expect(byKey.get(emailPreferenceKey('product-update'))?.default).toBe('off')
		expect(byKey.get(inAppPreferenceKey('product-update'))?.default).toBe(false)
	})

	it('drops the digest option for a marketing type — it has no digest to ride', () => {
		const marketing = notificationPreferenceDefinitions().find(
			(d) => d.key === emailPreferenceKey('product-update'),
		)
		expect(marketing?.options?.map((o) => o.value)).toEqual([
			'off',
			'immediate',
		])
	})
})
