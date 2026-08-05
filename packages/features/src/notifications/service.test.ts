import type { drizzle } from 'drizzle-orm/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMemoryMailer } from '../email/mailer.ts'
import { EmailRegistry } from '../email/registry.ts'
import { BUILT_IN_PREFERENCES } from '../preferences/definitions.ts'
import { PREFERENCES_DDL } from '../preferences/schema.ts'
import { PreferencesService } from '../preferences/service.ts'
import { usePglite } from '../testing/pglite-fixture.ts'
import { NOTIFICATIONS_DDL } from './schema.ts'
import {
	digestWindowKey,
	MissingUnsubscribeConfigError,
	NotificationService,
	type NotificationSubject,
	UnknownNotificationTypeError,
} from './service.ts'
import {
	BUILT_IN_NOTIFICATION_TYPES,
	DIGEST_CADENCE_PREFERENCE,
	emailPreferenceKey,
	inAppPreferenceKey,
	notificationPreferenceDefinitions,
} from './types.ts'
import { mintUnsubscribeToken } from './unsubscribe.ts'

type Db = ReturnType<typeof drizzle>
type Mailer = ReturnType<typeof createMemoryMailer>

const SECRET = 'test-unsubscribe-secret'
const UNSUBSCRIBE = {
	secret: SECRET,
	baseUrl: 'https://app.example/unsubscribe',
}

let db: Db
let mailer: Mailer
let preferences: PreferencesService
let service: NotificationService
/** Subjects the fixture user may read. Tests revoke access by deleting from it. */
let readable: Set<string>

const subjectKey = (s: NotificationSubject) => `${s.resource}:${s.id}`

const pg = usePglite(NOTIFICATIONS_DDL, PREFERENCES_DDL)

beforeEach(() => {
	db = pg.db
	mailer = createMemoryMailer()
	preferences = new PreferencesService({
		db,
		definitions: [
			...BUILT_IN_PREFERENCES,
			...notificationPreferenceDefinitions(),
		],
	})
	readable = new Set()
	service = new NotificationService({
		db,
		mailer,
		registry: new EmailRegistry(),
		preferences,
		types: BUILT_IN_NOTIFICATION_TYPES,
		visibility: ({ subject }) => readable.has(subjectKey(subject)),
		unsubscribe: UNSUBSCRIBE,
	})
})

/** An activity event — defaults to the digest. */
const activityEvent = (overrides: Record<string, unknown> = {}) => ({
	userId: 'u1',
	type: 'invitation-accepted',
	title: 'New team member',
	body: 'alice@example.com joined your organization.',
	email: 'u1@example.com',
	...overrides,
})

/** A transactional event — always immediate. */
const alertEvent = (overrides: Record<string, unknown> = {}) => ({
	userId: 'u1',
	type: 'security-alert',
	title: 'New sign-in',
	body: 'A new device signed in to your account.',
	email: 'u1@example.com',
	...overrides,
})

describe('declared types', () => {
	it('refuses an undeclared type rather than inventing one', async () => {
		await expect(
			service.notify(activityEvent({ type: 'made-up' })),
		).rejects.toThrow(UnknownNotificationTypeError)
	})

	it('refuses a set of declarations that would email everyone immediately', () => {
		expect(
			() =>
				new NotificationService({
					db,
					mailer,
					registry: new EmailRegistry(),
					preferences,
					types: [
						{
							key: 'loud',
							label: 'Loud',
							description: 'Every change, immediately.',
							class: 'activity',
							defaultEmail: 'immediate',
							defaultInApp: true,
						},
					],
				}),
		).toThrow(/may not default to immediate email/)
	})

	it('resolves delivery from the declaration and the recipient’s preference', async () => {
		expect(await service.deliveryFor('u1', 'invitation-accepted')).toEqual({
			email: 'digest',
			inApp: true,
		})
		// Transactional: immediate, and not opt-out-able per type.
		expect(await service.deliveryFor('u1', 'security-alert')).toEqual({
			email: 'immediate',
			inApp: true,
		})
		// Marketing: opt-in, so off and out of the inbox until asked for.
		expect(await service.deliveryFor('u1', 'product-update')).toEqual({
			email: 'off',
			inApp: false,
		})
	})

	it('lets a user opt up to immediate delivery for one type', async () => {
		await preferences.setUserPreferences({ id: 'u1' }, 'u1', {
			[emailPreferenceKey('invitation-accepted')]: 'immediate',
		})
		const result = await service.notify(activityEvent())
		expect(result).toMatchObject({ emailed: true, queuedForDigest: false })
		expect(mailer.sent).toHaveLength(1)
	})
})

describe('conservative defaults', () => {
	it('an activity event queues for the digest instead of emailing', async () => {
		const result = await service.notify(activityEvent())
		expect(result).toMatchObject({
			inApp: true,
			emailed: false,
			queuedForDigest: true,
		})
		expect(mailer.sent).toHaveLength(0)
	})

	it('a transactional event emails immediately', async () => {
		const result = await service.notify(alertEvent())
		expect(result).toMatchObject({ inApp: true, emailed: true })
		expect(mailer.sent).toHaveLength(1)
		expect(mailer.sent[0]?.to).toBe('u1@example.com')
	})

	it('a marketing event records nothing visible and mails nothing', async () => {
		const result = await service.notify(
			activityEvent({ type: 'product-update', title: 'New feature' }),
		)
		expect(result).toMatchObject({ inApp: false, emailed: false })
		expect(mailer.sent).toHaveLength(0)
		expect(await service.listNotifications('u1')).toHaveLength(0)
	})

	it('the account-wide email switch overrides every per-type choice', async () => {
		await preferences.setUserPreferences({ id: 'u1' }, 'u1', {
			'email-notifications': false,
		})
		const result = await service.notify(alertEvent())
		expect(result).toMatchObject({ inApp: true, emailed: false })
		expect(mailer.sent).toHaveLength(0)
	})

	it('a per-type inbox opt-out hides the row but still records the delivery', async () => {
		await preferences.setUserPreferences({ id: 'u1' }, 'u1', {
			[inAppPreferenceKey('security-alert')]: false,
		})
		const result = await service.notify(alertEvent())
		expect(result).toMatchObject({ inApp: false, emailed: true })
		expect(await service.listNotifications('u1')).toHaveLength(0)
	})
})

describe('idempotent delivery', () => {
	it('a redelivery with the same dedupe key never produces a second email', async () => {
		const event = alertEvent({ dedupeKey: 'signin:session-9' })
		const first = await service.notify(event)
		const second = await service.notify(event)

		expect(first).toMatchObject({ emailed: true, duplicate: false })
		expect(second).toMatchObject({ emailed: true, duplicate: true })
		expect(mailer.sent).toHaveLength(1)
		expect(await service.listNotifications('u1')).toHaveLength(1)
	})

	it('two events without a dedupe key are two deliveries', async () => {
		await service.notify(alertEvent())
		await service.notify(alertEvent())
		expect(mailer.sent).toHaveLength(2)
		expect(await service.listNotifications('u1')).toHaveLength(2)
	})

	it('dedupe keys are scoped per user — the same key for two users is two deliveries', async () => {
		await service.notify(alertEvent({ dedupeKey: 'k' }))
		await service.notify(alertEvent({ userId: 'u2', dedupeKey: 'k' }))
		expect(await service.listNotifications('u1')).toHaveLength(1)
		expect(await service.listNotifications('u2')).toHaveLength(1)
	})

	it('a retry of a claim that was never mailed still sends — at-least-once is preserved', async () => {
		const failing = new NotificationService({
			db,
			mailer: {
				async send() {
					throw new Error('transport down')
				},
			},
			registry: new EmailRegistry(),
			preferences,
			types: BUILT_IN_NOTIFICATION_TYPES,
			unsubscribe: UNSUBSCRIBE,
		})
		const event = alertEvent({ dedupeKey: 'signin:session-9' })
		await expect(failing.notify(event)).rejects.toThrow('transport down')
		expect(mailer.sent).toHaveLength(0)

		// The claim exists but was never mailed, so the retry is allowed to send.
		const retry = await service.notify(event)
		expect(retry).toMatchObject({ emailed: true, duplicate: true })
		expect(mailer.sent).toHaveLength(1)

		// And a *third* attempt, now that it has been mailed, is suppressed.
		await service.notify(event)
		expect(mailer.sent).toHaveLength(1)
	})
})

describe('content-leak: read access is re-checked at delivery', () => {
	const subject = { resource: 'project', id: 'p1' }

	it('records nothing at all for a row the recipient cannot read', async () => {
		const result = await service.notify(alertEvent({ subject }))
		expect(result).toMatchObject({
			id: null,
			suppressed: 'visibility',
			emailed: false,
		})
		expect(mailer.sent).toHaveLength(0)
		expect(await service.listNotifications('u1')).toHaveLength(0)
	})

	it('drops an inbox row whose access was revoked after it was created', async () => {
		readable.add('project:p1')
		await service.notify(
			alertEvent({ subject, title: 'Budget raised to $2.4M' }),
		)
		expect(await service.listNotifications('u1')).toHaveLength(1)
		expect(await service.unreadCount('u1')).toBe(1)

		readable.delete('project:p1')
		expect(await service.listNotifications('u1')).toHaveLength(0)
		expect(await service.unreadCount('u1')).toBe(0)
	})

	it('withholds revoked rows from the digest, and their content with them', async () => {
		readable.add('project:p1')
		readable.add('project:p2')
		await service.notify(
			activityEvent({ subject, title: 'Budget raised to $2.4M' }),
		)
		await service.notify(
			activityEvent({
				subject: { resource: 'project', id: 'p2' },
				title: 'Still visible',
			}),
		)

		readable.delete('project:p1')
		const result = await service.sendDigest('u1', 'u1@example.com')
		expect(result).toMatchObject({ sent: true, count: 1, withheld: 1 })
		const html = mailer.sent[0]?.html ?? ''
		expect(html).toContain('Still visible')
		expect(html).not.toContain('2.4M')
	})

	it('sends no digest at all when every pending row was revoked', async () => {
		readable.add('project:p1')
		await service.notify(activityEvent({ subject }))
		readable.delete('project:p1')
		expect(await service.sendDigest('u1', 'u1@example.com')).toMatchObject({
			sent: false,
			withheld: 1,
		})
		expect(mailer.sent).toHaveLength(0)
	})

	it('fails closed when the visibility check throws', async () => {
		const throwing = new NotificationService({
			db,
			mailer,
			registry: new EmailRegistry(),
			preferences,
			visibility: () => {
				throw new Error('authz backend down')
			},
			unsubscribe: UNSUBSCRIBE,
		})
		const result = await throwing.notify(alertEvent({ subject }))
		expect(result.suppressed).toBe('visibility')
	})

	it('never filters a notification that claims no row', async () => {
		await service.notify(alertEvent())
		expect(await service.listNotifications('u1')).toHaveLength(1)
	})
})

describe('read state', () => {
	it('unreadCount / markRead / markAllRead', async () => {
		await service.notify(alertEvent({ title: 'One' }))
		await service.notify(alertEvent({ title: 'Two' }))
		expect(await service.unreadCount('u1')).toBe(2)

		const [first] = await service.listNotifications('u1', { unreadOnly: true })
		await service.markRead(first?.id ?? '', 'u1')
		expect(await service.unreadCount('u1')).toBe(1)

		await service.markAllRead('u1')
		expect(await service.unreadCount('u1')).toBe(0)
	})

	it('markRead is scoped to the given user — another user’s id is a no-op', async () => {
		await service.notify(alertEvent())
		const [item] = await service.listNotifications('u1')
		await service.markRead(item?.id ?? '', 'someone-else')
		expect(await service.unreadCount('u1')).toBe(1)
	})
})

describe('digests', () => {
	it('batches pending rows into one email and marks them emailed', async () => {
		await service.notify(activityEvent({ title: 'A' }))
		await service.notify(activityEvent({ title: 'B' }))
		await service.notify(alertEvent({ title: 'C' }))

		const result = await service.sendDigest('u1', 'u1@example.com')
		expect(result).toMatchObject({ sent: true, count: 2, duplicate: false })
		// 1 immediate (the security alert) + 1 digest.
		expect(mailer.sent).toHaveLength(2)
		const digestMail = mailer.sent.find((m) => m.subject.includes('update'))
		expect(digestMail?.html).toContain('A')
		expect(digestMail?.html).toContain('B')
	})

	it('a second run in the same window sends nothing', async () => {
		await service.notify(activityEvent({ title: 'A' }))
		await service.sendDigest('u1', 'u1@example.com')
		await service.notify(activityEvent({ title: 'B' }))

		const second = await service.sendDigest('u1', 'u1@example.com')
		expect(second).toMatchObject({ sent: false, duplicate: true })
		expect(mailer.sent).toHaveLength(1)
	})

	it('the next window sends again', async () => {
		await service.notify(activityEvent({ title: 'A' }))
		await service.sendDigest('u1', 'u1@example.com', { windowKey: 'w1' })
		await service.notify(activityEvent({ title: 'B' }))
		const next = await service.sendDigest('u1', 'u1@example.com', {
			windowKey: 'w2',
		})
		expect(next).toMatchObject({ sent: true, count: 1 })
	})

	it('is a no-op with nothing pending, and does not burn the window', async () => {
		expect(await service.sendDigest('u1', 'u1@example.com')).toMatchObject({
			sent: false,
			count: 0,
			duplicate: false,
		})
		await service.notify(activityEvent({ title: 'A' }))
		expect(await service.sendDigest('u1', 'u1@example.com')).toMatchObject({
			sent: true,
			count: 1,
		})
	})

	it('does not send when the account-wide email switch is off', async () => {
		await preferences.setUserPreferences({ id: 'u1' }, 'u1', {
			'email-notifications': false,
		})
		await service.notify(activityEvent())
		expect(await service.sendDigest('u1', 'u1@example.com')).toMatchObject({
			sent: false,
			count: 0,
		})
	})

	it('leaves out a type the recipient turned off after it was queued', async () => {
		await service.notify(activityEvent({ title: 'A' }))
		await preferences.setUserPreferences({ id: 'u1' }, 'u1', {
			[emailPreferenceKey('invitation-accepted')]: 'off',
		})
		expect(await service.sendDigest('u1', 'u1@example.com')).toMatchObject({
			sent: false,
			count: 0,
		})
	})

	it('carries an unsubscribe link', async () => {
		await service.notify(activityEvent({ title: 'A' }))
		await service.sendDigest('u1', 'u1@example.com')
		expect(mailer.sent[0]?.html).toContain('unsubscribe?token=')
	})

	it('keys the window off the recipient’s cadence preference', async () => {
		const now = new Date('2026-07-27T12:00:00Z')
		expect(digestWindowKey('daily', now)).toBe('2026-07-27')
		expect(digestWindowKey('weekly', now)).toBe('2026-W31')

		await preferences.setUserPreferences({ id: 'u1' }, 'u1', {
			[DIGEST_CADENCE_PREFERENCE]: 'weekly',
		})
		const weekly = new NotificationService({
			db,
			mailer,
			registry: new EmailRegistry(),
			preferences,
			unsubscribe: UNSUBSCRIBE,
			now: () => now,
		})
		await weekly.notify(activityEvent({ title: 'A' }))
		expect(await weekly.sendDigest('u1', 'u1@example.com')).toMatchObject({
			sent: true,
		})
		// A second run inside the same weekly window is a duplicate, not a second
		// digest — even though the daily key would have rolled over.
		await weekly.notify(activityEvent({ title: 'B' }))
		expect(await weekly.sendDigest('u1', 'u1@example.com')).toMatchObject({
			duplicate: true,
		})
	})
})

describe('unsubscribe', () => {
	it('an opt-out-able email cannot be sent without unsubscribe support', async () => {
		const unconfigured = new NotificationService({
			db,
			mailer,
			registry: new EmailRegistry(),
			preferences,
		})
		await preferences.setUserPreferences({ id: 'u1' }, 'u1', {
			[emailPreferenceKey('invitation-accepted')]: 'immediate',
		})
		await expect(unconfigured.notify(activityEvent())).rejects.toThrow(
			MissingUnsubscribeConfigError,
		)
		expect(mailer.sent).toHaveLength(0)
	})

	it('a transactional email needs none, and carries no footer', async () => {
		const unconfigured = new NotificationService({
			db,
			mailer,
			registry: new EmailRegistry(),
			preferences,
		})
		await unconfigured.notify(alertEvent())
		expect(mailer.sent).toHaveLength(1)
		expect(mailer.sent[0]?.html).not.toContain('Unsubscribe')
	})

	it('a type-scoped link turns that type’s email off and nothing else', async () => {
		const token = mintUnsubscribeToken(SECRET, {
			userId: 'u1',
			scope: { kind: 'type', type: 'invitation-accepted' },
		})
		const result = await service.unsubscribe(token)
		expect(result).toMatchObject({ ok: true, scope: 'invitation-accepted' })

		expect(
			await service.deliveryFor('u1', 'invitation-accepted'),
		).toMatchObject({ email: 'off' })
		// The security alert is untouched — one click did not silence the account.
		expect(await service.deliveryFor('u1', 'security-alert')).toMatchObject({
			email: 'immediate',
		})
	})

	it('an all-scoped link turns off every email', async () => {
		const token = mintUnsubscribeToken(SECRET, {
			userId: 'u1',
			scope: { kind: 'all' },
		})
		expect(await service.unsubscribe(token)).toMatchObject({ ok: true })
		expect(await service.deliveryFor('u1', 'security-alert')).toMatchObject({
			email: 'off',
		})
	})

	it('refuses a forged token and an undeclared type', async () => {
		expect(await service.unsubscribe('nonsense')).toEqual({
			ok: false,
			reason: 'invalid-token',
		})
		const unknown = mintUnsubscribeToken(SECRET, {
			userId: 'u1',
			scope: { kind: 'type', type: 'no-such-type' },
		})
		expect(await service.unsubscribe(unknown)).toEqual({
			ok: false,
			reason: 'unknown-type',
		})
	})

	it('refuses to unsubscribe from a transactional type', async () => {
		const token = mintUnsubscribeToken(SECRET, {
			userId: 'u1',
			scope: { kind: 'type', type: 'security-alert' },
		})
		expect(await service.unsubscribe(token)).toEqual({
			ok: false,
			reason: 'not-optional',
		})
	})

	it('the link in a delivered email is the one that works', async () => {
		await preferences.setUserPreferences({ id: 'u1' }, 'u1', {
			[emailPreferenceKey('invitation-accepted')]: 'immediate',
		})
		await service.notify(activityEvent())
		const html = mailer.sent[0]?.html ?? ''
		const token = decodeURIComponent(html.match(/token=([^"&]+)/)?.[1] ?? '')
		expect(await service.unsubscribe(token)).toMatchObject({
			ok: true,
			scope: 'invitation-accepted',
		})
	})
})
