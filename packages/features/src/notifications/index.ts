/**
 * Notifications feature (task 56, promoted in issue #184) — declared
 * notification types, per-user preferences derived from them, an in-app inbox,
 * and idempotent delivery over `@maxstack/features/email`.
 */

export type {
	DigestJobOptions,
	DigestJobPayload,
	DigestRecipient,
} from './digest.ts'
export {
	DIGEST_JOB_TYPE,
	DIGEST_SWEEP_JOB_TYPE,
	registerDigestJobs,
} from './digest.ts'
export {
	NOTIFICATIONS_DDL,
	NOTIFICATIONS_DDL_PRE_184,
	NOTIFICATIONS_DDL_STATEMENTS,
	notification,
	notificationDigest,
} from './schema.ts'
export type {
	DigestResult,
	Notification,
	NotificationSubject,
	NotificationVisibility,
	NotifyInput,
	NotifyResult,
} from './service.ts'
export {
	digestWindowKey,
	MissingUnsubscribeConfigError,
	NotificationService,
	UnknownNotificationTypeError,
} from './service.ts'
export type {
	DigestCadence,
	EmailDelivery,
	NotificationChannel,
	NotificationClass,
	NotificationTypeDefinition,
} from './types.ts'
export {
	BUILT_IN_NOTIFICATION_TYPES,
	DIGEST_CADENCE_PREFERENCE,
	emailPreferenceKey,
	inAppPreferenceKey,
	isOptOutable,
	NOTIFICATION_PREFERENCE_GROUP,
	notificationPreferenceDefinitions,
	notificationTypeErrors,
} from './types.ts'
export type {
	UnsubscribeConfig,
	UnsubscribePayload,
	UnsubscribeScope,
} from './unsubscribe.ts'
export {
	mintUnsubscribeToken,
	unsubscribeUrl,
	verifyUnsubscribeToken,
} from './unsubscribe.ts'
