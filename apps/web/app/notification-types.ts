/**
 * The notification vocabulary this app can send.
 *
 * Its own module rather than a const inside `notifications.server.ts` because
 * two modules need it and they need each other: the service reads the types,
 * and `settings.server.ts` derives the preference rows from the same list so the
 * opt-outs on the settings page can never drift from what is sendable. Keeping
 * the declarations here is the cheapest way to say that once.
 */

import {
	BUILT_IN_NOTIFICATION_TYPES,
	type NotificationTypeDefinition,
} from '@maxstack/features/notifications'

/**
 * The app's own type, on top of the built-ins — the extension point a product
 * uses, and what the demo digest button sends. Declared `activity`, so the
 * declaration checker holds it to the same conservative default as the rest.
 */
const DEMO_DIGEST_TYPE: NotificationTypeDefinition = {
	key: 'demo-digest-item',
	label: 'Demo digest items',
	description: 'The "queue a digest item" button on the notifications page.',
	class: 'activity',
	defaultEmail: 'digest',
	defaultInApp: true,
	emailTemplate: 'notification',
}

export const APP_NOTIFICATION_TYPES: readonly NotificationTypeDefinition[] = [
	...BUILT_IN_NOTIFICATION_TYPES,
	DEMO_DIGEST_TYPE,
]
