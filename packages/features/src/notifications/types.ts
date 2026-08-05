/**
 * **Declared notification types** — the vocabulary a notification
 * can be, and the thing every per-user preference is derived from.
 *
 * Before this, `notify()` took a free-form `type` string and a `category` the
 * caller chose per call site. Two things were wrong with that. A string nobody
 * declares cannot be offered as an opt-out — you cannot render a checkbox for a
 * value you only discover when it is already being sent — and a category chosen
 * per call site means the *sender* decides how loud a notification is, which is
 * exactly the decision that gets a sending domain blocked.
 *
 * So a type is declared once: what it is, who it is for, and how loud it is
 * allowed to default to. Everything else falls out of the declaration —
 * {@link notificationPreferenceDefinitions} turns each type into the preference
 * rows the derived settings form renders, so a new notification
 * type ships with its own opt-out on the day it ships, not in a v2.
 *
 * **Why the defaults are enforced rather than documented.** #184's gating says
 * conservative defaults and digests preferred. A comment saying that is a
 * comment; {@link notificationTypeErrors} refuses a non-transactional type that
 * defaults to immediate email, and refuses a marketing type that defaults to
 * email at all. The cheapest way to ship a notification that emails everyone on
 * every change is for it to be one word in a declaration, so that one word is
 * the one the checker reads.
 */

import type { PreferenceDefinition } from '../preferences/definitions.ts'

/** Where a notification can be delivered. */
export type NotificationChannel = 'in-app' | 'email'

/**
 * What kind of message this is — the distinction that decides whether it can be
 * unsubscribed from, and how loud it may default to.
 *
 * - `transactional` — a direct consequence of the recipient's own action, or
 *   account security: a password reset, a receipt, an export that finished.
 *   Always emailed immediately, and has no per-type opt-out (the account-wide
 *   `email-notifications` switch still applies).
 * - `activity` — someone else did something the recipient cares about. Opt-out
 *   per type; defaults to the digest, never to immediate mail.
 * - `marketing` — product news. Opt-*in*: defaults to no email at all.
 */
export type NotificationClass = 'transactional' | 'activity' | 'marketing'

/** How a type's email is delivered for one recipient. */
export type EmailDelivery = 'off' | 'digest' | 'immediate'

export interface NotificationTypeDefinition {
	/** Stable slug, unique in the registry: `invitation-accepted`. */
	key: string
	/** Label in the derived preferences UI. */
	label: string
	/** One-line help text, rendered under the label. */
	description: string
	class: NotificationClass
	/**
	 * Email delivery when the recipient has not chosen. Constrained by `class`
	 * (see {@link notificationTypeErrors}): transactional is `immediate`,
	 * marketing is `off`, and activity is `off` or `digest`.
	 */
	defaultEmail: EmailDelivery
	/** Whether the inbox row is shown by default. */
	defaultInApp: boolean
	/**
	 * The registered email template a *single* event of this type renders with.
	 * Digests always render `notification-digest`, whatever this says.
	 */
	emailTemplate?: string
}

/** The group the derived preference fields render under. */
export const NOTIFICATION_PREFERENCE_GROUP = 'Notifications'

/** The preference key holding a user's email delivery for one type. */
export function emailPreferenceKey(typeKey: string): string {
	return `notify-${typeKey}-email`
}

/** The preference key holding whether a type appears in the inbox. */
export function inAppPreferenceKey(typeKey: string): string {
	return `notify-${typeKey}-in-app`
}

/** The preference key holding how often digests go out. */
export const DIGEST_CADENCE_PREFERENCE = 'digest-cadence'

export type DigestCadence = 'daily' | 'weekly'

/**
 * The types every app gets. `invitation-accepted` is the one the app template
 * actually sends (accepting an invite notifies the inviter); the other two exist
 * because the classes they demonstrate need a live example — a transactional
 * message that cannot be opted out of, and a marketing one that is off until
 * someone asks for it.
 */
export const BUILT_IN_NOTIFICATION_TYPES: readonly NotificationTypeDefinition[] =
	[
		{
			key: 'invitation-accepted',
			label: 'Invitations accepted',
			description: 'Someone you invited joined the organization.',
			class: 'activity',
			defaultEmail: 'digest',
			defaultInApp: true,
			emailTemplate: 'notification',
		},
		{
			key: 'security-alert',
			label: 'Security alerts',
			description:
				'Sign-ins from a new device, password changes, and API-key rotations.',
			class: 'transactional',
			defaultEmail: 'immediate',
			defaultInApp: true,
			emailTemplate: 'notification',
		},
		{
			key: 'product-update',
			label: 'Product updates',
			description: 'Occasional news about new features. Off unless you ask.',
			class: 'marketing',
			defaultEmail: 'off',
			defaultInApp: false,
			emailTemplate: 'notification',
		},
	] as const

/** Whether a type may be unsubscribed from per type. */
export function isOptOutable(definition: NotificationTypeDefinition): boolean {
	return definition.class !== 'transactional'
}

/**
 * Problems with a set of declarations — checked once when a service is built, so
 * a type that would email everyone immediately fails at composition rather than
 * at the moment it mails everyone immediately.
 */
export function notificationTypeErrors(
	definitions: readonly NotificationTypeDefinition[],
): string[] {
	const errors: string[] = []
	const seen = new Set<string>()
	for (const def of definitions) {
		const at = `notification type "${def.key}"`
		if (!/^[a-z][a-z0-9-]*$/.test(def.key))
			errors.push(`${at}: key must be a lowercase slug`)
		if (seen.has(def.key)) errors.push(`${at}: declared twice`)
		seen.add(def.key)
		if (!def.label.trim()) errors.push(`${at}: needs a label`)
		if (!def.description.trim())
			errors.push(
				`${at}: needs a description — it is the help text on the opt-out, and ` +
					'an opt-out nobody understands is not an opt-out',
			)
		switch (def.class) {
			case 'transactional':
				if (def.defaultEmail !== 'immediate')
					errors.push(
						`${at}: a transactional type is delivered immediately by ` +
							`definition, not "${def.defaultEmail}"`,
					)
				break
			case 'activity':
				if (def.defaultEmail === 'immediate')
					errors.push(
						`${at}: an activity type may not default to immediate email — ` +
							'default to "digest" and let people opt up',
					)
				break
			case 'marketing':
				if (def.defaultEmail !== 'off')
					errors.push(
						`${at}: a marketing type must default to "off" — product news is ` +
							'opt-in, not opt-out',
					)
				if (def.defaultInApp)
					errors.push(
						`${at}: a marketing type must default out of the inbox too, for ` +
							'the same reason it defaults out of email',
					)
				break
		}
	}
	return errors
}

/** The delivery options a type's email preference offers. */
function deliveryOptions(definition: NotificationTypeDefinition) {
	const options = [
		{ label: 'Off', value: 'off' },
		{ label: 'In my digest', value: 'digest' },
		{ label: 'As it happens', value: 'immediate' },
	]
	// A marketing type has no digest of its own to ride along in — it is either
	// wanted or not.
	return definition.class === 'marketing'
		? options.filter((o) => o.value !== 'digest')
		: options
}

/**
 * The preference declarations a set of notification types implies — the
 * mechanism that makes "per-type opt-out from day one" structural rather than a
 * promise. Feed the result to `PreferencesService` alongside the built-ins:
 *
 * ```ts
 * new PreferencesService({
 *   db,
 *   definitions: [...BUILT_IN_PREFERENCES, ...notificationPreferenceDefinitions(types)],
 * })
 * ```
 *
 * A transactional type contributes no email preference: there is nothing to
 * choose (it is immediate) and offering an opt-out for a password reset is a
 * support ticket waiting to happen. The account-wide `email-notifications`
 * switch still covers it — that one is the user's, not the sender's.
 */
export function notificationPreferenceDefinitions(
	definitions: readonly NotificationTypeDefinition[] = BUILT_IN_NOTIFICATION_TYPES,
): PreferenceDefinition[] {
	const out: PreferenceDefinition[] = [
		{
			key: DIGEST_CADENCE_PREFERENCE,
			label: 'Digest frequency',
			description: 'How often batched notifications are emailed.',
			type: 'enum',
			scopes: ['user', 'organization'],
			default: 'daily',
			options: [
				{ label: 'Daily', value: 'daily' },
				{ label: 'Weekly', value: 'weekly' },
			],
			group: NOTIFICATION_PREFERENCE_GROUP,
		},
	]
	for (const def of definitions) {
		out.push({
			key: inAppPreferenceKey(def.key),
			label: `${def.label} — in the inbox`,
			description: def.description,
			type: 'boolean',
			// An organization may steer the default; a member always wins over it,
			// which is what `PreferencesService`'s user → organization → default
			// resolution already means.
			scopes: ['user', 'organization'],
			default: def.defaultInApp,
			group: NOTIFICATION_PREFERENCE_GROUP,
		})
		if (!isOptOutable(def)) continue
		out.push({
			key: emailPreferenceKey(def.key),
			label: `${def.label} — by email`,
			description: def.description,
			type: 'enum',
			scopes: ['user', 'organization'],
			default: def.defaultEmail,
			options: deliveryOptions(def),
			group: NOTIFICATION_PREFERENCE_GROUP,
		})
	}
	return out
}
